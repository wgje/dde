package app.nanoflow.host

import android.appwidget.AppWidgetManager
import android.content.Context
import android.os.Bundle
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.coroutines.CoroutineContext

internal class NanoflowWidgetLifecycleCallbackAttemptScope(
  private val reportFailure: (Throwable) -> Unit,
) {
  suspend fun attempt(block: suspend () -> Unit) {
    try {
      block()
    } catch (error: Throwable) {
      reportFailure(error)
    }
  }
}

/** Process-local FIFO for short AppWidget lifecycle persistence and rendering work. */
internal class NanoflowWidgetLifecycleCallbackCoordinator(
  private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
  private val processingContext: CoroutineContext = Dispatchers.IO,
  private val reportFailure: (Throwable) -> Unit = {},
) {
  private val lock = Any()
  private val pending = ArrayDeque<PendingCallback>()
  private var workerRunning = false

  fun submit(
    work: suspend NanoflowWidgetLifecycleCallbackAttemptScope.() -> Unit,
    finish: () -> Unit,
  ) {
    val callback = PendingCallback(work, Completion(finish))
    val shouldStart = synchronized(lock) {
      pending.addLast(callback)
      if (workerRunning) {
        false
      } else {
        workerRunning = true
        true
      }
    }
    if (shouldStart) startWorker()
  }

  private fun startWorker() {
    try {
      scope.launch { drain() }
    } catch (error: Throwable) {
      val rejected = synchronized(lock) {
        workerRunning = false
        pending.toList().also { pending.clear() }
      }
      reportSafely(error)
      rejected.forEach { it.completion.finish(::reportSafely) }
    }
  }

  private suspend fun drain() {
    while (true) {
      val current = synchronized(lock) {
        val next = pending.removeFirstOrNull()
        if (next == null) workerRunning = false
        next
      } ?: return

      try {
        withContext(processingContext) {
          val attempts = NanoflowWidgetLifecycleCallbackAttemptScope(::reportSafely)
          try {
            current.work(attempts)
          } catch (error: Throwable) {
            reportSafely(error)
          }
        }
      } catch (error: Throwable) {
        reportSafely(error)
      } finally {
        current.completion.finish(::reportSafely)
      }
    }
  }

  private fun reportSafely(error: Throwable) {
    runCatching { reportFailure(error) }
  }

  private data class PendingCallback(
    val work: suspend NanoflowWidgetLifecycleCallbackAttemptScope.() -> Unit,
    val completion: Completion,
  )

  private class Completion(
    private val callback: () -> Unit,
  ) {
    private val finished = AtomicBoolean(false)

    fun finish(reportFailure: (Throwable) -> Unit) {
      if (!finished.compareAndSet(false, true)) return
      try {
        callback()
      } catch (error: Throwable) {
        reportFailure(error)
      }
    }
  }
}

internal object NanoflowWidgetLifecycleCallbackProcessCoordinator {
  private val coordinator = NanoflowWidgetLifecycleCallbackCoordinator(
    reportFailure = { error ->
      NanoflowWidgetTelemetry.warn(
        event = "widget_lifecycle_callback_failed",
        fields = mapOf("errorType" to error.javaClass.simpleName),
        error = error,
      )
    },
  )

  fun submitUpdate(
    context: Context,
    appWidgetManager: AppWidgetManager,
    appWidgetIds: IntArray,
    finish: () -> Unit,
  ) {
    val appContext = context.applicationContext
    coordinator.submit(
      work = {
        appWidgetIds.forEach { widgetId ->
          processUpdate(appContext, appWidgetManager, widgetId)
        }
        attempt {
          NanoflowWidgetRefreshWorker.syncPeriodicRefresh(
            appContext,
            NanoflowWidgetReceiver.hasInstalledWidgets(appContext),
          )
        }
        attempt { NanoflowWidgetRefreshWorker.enqueue(appContext, reason = "receiver-update") }
      },
      finish = finish,
    )
  }

  fun submitOptionsChanged(
    context: Context,
    appWidgetManager: AppWidgetManager,
    appWidgetId: Int,
    newOptions: Bundle,
    finish: () -> Unit,
  ) {
    val appContext = context.applicationContext
    coordinator.submit(
      work = {
        processOptionsChanged(appContext, appWidgetManager, appWidgetId, newOptions)
        attempt {
          NanoflowWidgetRefreshWorker.syncPeriodicRefresh(
            appContext,
            NanoflowWidgetReceiver.hasInstalledWidgets(appContext),
          )
        }
        attempt {
          NanoflowWidgetRefreshWorker.enqueue(appContext, reason = "receiver-options-changed")
        }
      },
      finish = finish,
    )
  }

  fun submitDeleted(
    context: Context,
    appWidgetIds: IntArray,
    hasWidgetsRemaining: Boolean,
    finish: () -> Unit,
  ) {
    val appContext = context.applicationContext
    coordinator.submit(
      work = {
        appWidgetIds.forEach { widgetId -> processDeleted(appContext, widgetId, hasWidgetsRemaining) }
        if (!hasWidgetsRemaining) {
          attempt {
            NanoflowWidgetStore(appContext).clearAllWidgetState(clearPendingPushToken = true)
          }
        }
        attempt {
          NanoflowWidgetRefreshWorker.syncPeriodicRefresh(appContext, hasWidgetsRemaining)
        }
      },
      finish = finish,
    )
  }

  fun submitDisabled(
    context: Context,
    finish: () -> Unit,
  ) {
    val appContext = context.applicationContext
    coordinator.submit(
      work = {
        attempt { NanoflowWidgetTelemetry.info("widget_instance_uninstall_all") }
        attempt {
          NanoflowWidgetStore(appContext).clearAllWidgetState(clearPendingPushToken = true)
        }
        attempt { NanoflowWidgetRefreshWorker.syncPeriodicRefresh(appContext, enabled = false) }
      },
      finish = finish,
    )
  }

  private suspend fun NanoflowWidgetLifecycleCallbackAttemptScope.processUpdate(
    context: Context,
    appWidgetManager: AppWidgetManager,
    widgetId: Int,
  ) {
    var existingInstanceId: String? = null
    var instanceId: String? = null
    var sizeBucket: String? = null
    var repository: NanoflowWidgetRepository? = null
    attempt {
      val store = NanoflowWidgetStore(context)
      repository = NanoflowWidgetRepository(context)
      existingInstanceId = store.readInstanceId(widgetId)
      instanceId = store.ensureInstanceId(widgetId)
      sizeBucket = resolveSizeBucket(appWidgetManager.getAppWidgetOptions(widgetId))
      store.persistSizeBucket(widgetId, requireNotNull(sizeBucket))
    }
    val readyRepository = repository ?: return
    attempt {
      NanoflowWidgetTelemetry.info(
        if (existingInstanceId == null) "widget_instance_install" else "widget_instance_update",
        mapOf(
          "appWidgetId" to widgetId,
          "instanceId" to NanoflowWidgetTelemetry.redactId(instanceId),
          "sizeBucket" to sizeBucket,
        ),
      )
    }
    attempt {
      NanoflowWidgetReceiver.renderAndApplyWidget(
        context,
        appWidgetManager,
        readyRepository,
        widgetId,
      )
    }
    attempt { NanoflowWidgetReceiver.notifyActionListsDataChanged(appWidgetManager, widgetId) }
  }

  private suspend fun NanoflowWidgetLifecycleCallbackAttemptScope.processOptionsChanged(
    context: Context,
    appWidgetManager: AppWidgetManager,
    appWidgetId: Int,
    newOptions: Bundle,
  ) {
    var instanceId: String? = null
    var sizeBucket: String? = null
    var repository: NanoflowWidgetRepository? = null
    attempt {
      val store = NanoflowWidgetStore(context)
      repository = NanoflowWidgetRepository(context)
      instanceId = store.readInstanceId(appWidgetId)
      sizeBucket = resolveSizeBucket(newOptions)
      store.persistSizeBucket(appWidgetId, requireNotNull(sizeBucket))
    }
    val readyRepository = repository ?: return
    attempt {
      NanoflowWidgetTelemetry.info(
        "widget_instance_resized",
        mapOf(
          "appWidgetId" to appWidgetId,
          "instanceId" to NanoflowWidgetTelemetry.redactId(instanceId),
          "sizeBucket" to sizeBucket,
        ),
      )
    }
    attempt {
      NanoflowWidgetReceiver.renderAndApplyWidget(
        context,
        appWidgetManager,
        readyRepository,
        appWidgetId,
      )
    }
    attempt { NanoflowWidgetReceiver.notifyActionListsDataChanged(appWidgetManager, appWidgetId) }
  }

  private suspend fun NanoflowWidgetLifecycleCallbackAttemptScope.processDeleted(
    context: Context,
    widgetId: Int,
    hasWidgetsRemaining: Boolean,
  ) {
    var instanceId: String? = null
    var cleared = false
    attempt {
      val store = NanoflowWidgetStore(context)
      instanceId = store.readInstanceId(widgetId)
      store.clearWidgetState(widgetId)
      cleared = true
    }
    if (!cleared) return
    attempt {
      NanoflowWidgetTelemetry.info(
        "widget_instance_uninstall",
        mapOf(
          "appWidgetId" to widgetId,
          "instanceId" to NanoflowWidgetTelemetry.redactId(instanceId),
          "widgetsRemaining" to hasWidgetsRemaining,
        ),
      )
    }
  }

  private fun resolveSizeBucket(options: Bundle): String {
    val minWidth = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 0)
    val minHeight = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 0)
    return when {
      minHeight >= 200 -> "4x3"
      minWidth >= 220 || minHeight >= 120 -> "4x2"
      else -> "2x2"
    }
  }
}
