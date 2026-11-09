package app.nanoflow.host

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.os.Handler
import android.os.Looper
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executor
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive

internal class NanoflowWidgetPackageReinflateHandoff(
  private val finish: () -> Unit,
  private val reportConfirmed: () -> Unit,
  private val reportUnconfirmed: (String, Throwable?) -> Unit,
) {
  private val settled = AtomicBoolean(false)

  fun confirm(): Boolean = settle { runCatching(reportConfirmed) }

  fun fail(reason: String, error: Throwable?): Boolean = settle {
    runCatching { reportUnconfirmed(reason, error) }
  }

  fun timeout(): Boolean = fail("watchdog-timeout", null)

  private inline fun settle(report: () -> Unit): Boolean {
    if (!settled.compareAndSet(false, true)) return false
    try {
      report()
    } finally {
      runCatching(finish)
    }
    return true
  }
}

internal enum class NanoflowWidgetPackageReinflateOutcome {
  SUCCESS,
  RETRY,
}

internal class NanoflowWidgetPackageReinflateOrchestrator(
  private val enumerateWidgetIds: () -> IntArray,
  private val reinflateWidget: suspend (Int) -> Unit,
  private val invalidateWidget: (Int) -> Unit,
  private val enqueueRefresh: () -> Unit,
  private val reportFailure: (String, Int?, Throwable) -> Unit,
) {
  suspend fun run(): NanoflowWidgetPackageReinflateOutcome {
    currentCoroutineContext().ensureActive()
    var failed = false
    val widgetIds = try {
      enumerateWidgetIds()
    } catch (error: Throwable) {
      error.rethrowCancellation()
      failed = true
      reportSafely("enumerate", null, error)
      intArrayOf()
    }

    widgetIds.forEach { widgetId ->
      currentCoroutineContext().ensureActive()
      val reinflated = try {
        reinflateWidget(widgetId)
        true
      } catch (error: Throwable) {
        error.rethrowCancellation()
        failed = true
        reportSafely("reinflate", widgetId, error)
        false
      }
      if (!reinflated) return@forEach

      currentCoroutineContext().ensureActive()
      try {
        invalidateWidget(widgetId)
      } catch (error: Throwable) {
        error.rethrowCancellation()
        failed = true
        reportSafely("invalidate", widgetId, error)
      }
    }

    currentCoroutineContext().ensureActive()
    try {
      enqueueRefresh()
    } catch (error: Throwable) {
      error.rethrowCancellation()
      reportSafely("refresh-follow-up", null, error)
    }

    return if (failed) {
      NanoflowWidgetPackageReinflateOutcome.RETRY
    } else {
      NanoflowWidgetPackageReinflateOutcome.SUCCESS
    }
  }

  private fun reportSafely(stage: String, widgetId: Int?, error: Throwable) {
    runCatching { reportFailure(stage, widgetId, error) }
  }

  private fun Throwable.rethrowCancellation() {
    if (this is CancellationException) throw this
  }
}

class NanoflowWidgetPackageReinflateWorker(
  appContext: Context,
  workerParams: WorkerParameters,
) : CoroutineWorker(appContext, workerParams) {
  override suspend fun doWork(): Result {
    val context = applicationContext
    val appWidgetManager by lazy(LazyThreadSafetyMode.NONE) {
      AppWidgetManager.getInstance(context)
    }
    val repository by lazy(LazyThreadSafetyMode.NONE) {
      NanoflowWidgetRepository(context)
    }
    val orchestrator = NanoflowWidgetPackageReinflateOrchestrator(
      enumerateWidgetIds = {
        appWidgetManager.getAppWidgetIds(
          ComponentName(context, NanoflowWidgetReceiver::class.java),
        )
      },
      reinflateWidget = { widgetId ->
        NanoflowWidgetReceiver.renderAndApplyWidget(
          context = context,
          appWidgetManager = appWidgetManager,
          repository = repository,
          appWidgetId = widgetId,
          partialUpdate = false,
        )
      },
      invalidateWidget = { widgetId ->
        NanoflowWidgetReceiver.notifyActionListsDataChanged(appWidgetManager, widgetId)
      },
      enqueueRefresh = {
        NanoflowWidgetRefreshWorker.enqueue(context, reason = "package-replaced")
      },
      reportFailure = { stage, widgetId, error ->
        NanoflowWidgetTelemetry.warn(
          event = "widget_package_reinflate_failed",
          fields = mapOf(
            "stage" to stage,
            "appWidgetId" to (widgetId ?: -1),
            "errorType" to error.javaClass.simpleName,
          ),
          error = error,
        )
      },
    )

    // RETRY may full-apply already successful widgets again; the repeated launcher animation is
    // preferable to leaving any upgraded host view structurally stale.
    return when (orchestrator.run()) {
      NanoflowWidgetPackageReinflateOutcome.SUCCESS -> Result.success()
      NanoflowWidgetPackageReinflateOutcome.RETRY -> Result.retry()
    }
  }

  companion object {
    private const val UNIQUE_WORK_NAME = "nanoflow-widget-package-reinflate"
    private const val HANDOFF_WATCHDOG_MS = 8_000L
    private val DIRECT_EXECUTOR = Executor { command -> command.run() }

    fun enqueue(
      context: Context,
      finish: () -> Unit,
    ) {
      val appContext = context.applicationContext
      val handoff = NanoflowWidgetPackageReinflateHandoff(
        finish = finish,
        reportConfirmed = {
          NanoflowWidgetTelemetry.info("widget_package_reinflate_handoff_confirmed")
        },
        reportUnconfirmed = { reason, error ->
          val fields = mapOf(
            "reason" to reason,
            "errorType" to (error?.javaClass?.simpleName ?: "none"),
          )
          if (error == null) {
            NanoflowWidgetTelemetry.warn("widget_package_reinflate_handoff_unconfirmed", fields)
          } else {
            NanoflowWidgetTelemetry.warn(
              "widget_package_reinflate_handoff_unconfirmed",
              fields,
              error,
            )
          }
        },
      )
      val request = OneTimeWorkRequestBuilder<NanoflowWidgetPackageReinflateWorker>().build()
      val operation = WorkManager.getInstance(appContext).enqueueUniqueWork(
        UNIQUE_WORK_NAME,
        ExistingWorkPolicy.KEEP,
        request,
      )
      val handler = Handler(Looper.getMainLooper())
      val watchdog = Runnable { handoff.timeout() }
      check(handler.postDelayed(watchdog, HANDOFF_WATCHDOG_MS)) {
        "Package reinflate handoff watchdog was rejected"
      }
      val operationResult = operation.result
      try {
        operationResult.addListener(
          {
            val won = try {
              operationResult.get()
              handoff.confirm()
            } catch (error: Throwable) {
              handoff.fail("operation-failed", error.unwrapExecutionFailure())
            }
            if (won) handler.removeCallbacks(watchdog)
          },
          DIRECT_EXECUTOR,
        )
      } catch (error: Throwable) {
        if (handoff.fail("operation-observer-failed", error)) {
          handler.removeCallbacks(watchdog)
        }
      }
    }

    private fun Throwable.unwrapExecutionFailure(): Throwable {
      return if (this is ExecutionException && cause != null) requireNotNull(cause) else this
    }
  }
}
