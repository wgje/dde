package app.nanoflow.host

import android.appwidget.AppWidgetManager
import android.content.Context
import java.util.ArrayDeque
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.coroutines.CoroutineContext

/**
 * Process-local per-widget FIFO. Each dequeued delta receives an independent persistence attempt;
 * only stale rendering is skipped. Process-local queued work and persistence failure remain open.
 */
internal class NanoflowWidgetGateNavigationCoordinator<Result>(
  private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
  private val processingContext: CoroutineContext = Dispatchers.IO,
  private val reportFailure: (Throwable) -> Unit = {},
) {
  private val statesLock = Any()
  private val states = mutableMapOf<Int, WidgetState<Result>>()

  fun submit(
    appWidgetId: Int,
    delta: Int,
    persist: suspend (Int) -> Result,
    telemetry: (Result) -> Unit,
    render: suspend (Result) -> Unit,
    finish: () -> Unit,
  ): Long {
    val state = stateFor(appWidgetId)
    var startWorker = false
    val generation: Long

    synchronized(state.lock) {
      generation = ++state.nextGeneration
      state.latestGeneration = generation
      state.pending.addLast(
        PendingNavigation(
          generation = generation,
          delta = delta,
          persist = persist,
          telemetry = telemetry,
          render = render,
          completion = Completion(finish),
        ),
      )
      if (!state.workerRunning) {
        state.workerRunning = true
        startWorker = true
      }
    }

    if (startWorker) {
      scope.launch { drain(state) }
    }
    return generation
  }

  private fun stateFor(appWidgetId: Int): WidgetState<Result> {
    return synchronized(statesLock) {
      states.getOrPut(appWidgetId) { WidgetState() }
    }
  }

  private suspend fun drain(state: WidgetState<Result>) {
    while (true) {
      val current = synchronized(state.lock) {
        val next = state.pending.pollFirst()
        if (next == null) state.workerRunning = false
        next
      } ?: return

      try {
        process(state, current)
      } finally {
        current.completion.finish(::reportSafely)
      }
    }
  }

  private suspend fun process(
    state: WidgetState<Result>,
    current: PendingNavigation<Result>,
  ) {
    val persisted = try {
      ProcessingResult.Success(
        withContext(processingContext) { current.persist(current.delta) },
      )
    } catch (error: Throwable) {
      reportSafely(error)
      ProcessingResult.Failed
    }
    if (persisted !is ProcessingResult.Success) return

    try {
      current.telemetry(persisted.value)
    } catch (error: Throwable) {
      reportSafely(error)
    }

    val claimedCurrentGeneration = synchronized(state.lock) {
      current.generation == state.latestGeneration
    }
    if (!claimedCurrentGeneration) return

    try {
      withContext(processingContext) { current.render(persisted.value) }
    } catch (error: Throwable) {
      reportSafely(error)
    }
  }

  private fun reportSafely(error: Throwable) {
    runCatching { reportFailure(error) }
  }

  private class WidgetState<Result> {
    val lock = Any()
    val pending = ArrayDeque<PendingNavigation<Result>>()
    var workerRunning = false
    var nextGeneration = 0L
    var latestGeneration = 0L
  }

  private data class PendingNavigation<Result>(
    val generation: Long,
    val delta: Int,
    val persist: suspend (Int) -> Result,
    val telemetry: (Result) -> Unit,
    val render: suspend (Result) -> Unit,
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

  private sealed interface ProcessingResult<out Result> {
    data class Success<Result>(val value: Result) : ProcessingResult<Result>
    data object Failed : ProcessingResult<Nothing>
  }
}

internal object NanoflowWidgetGateNavigationProcessCoordinator {
  private val coordinator = NanoflowWidgetGateNavigationCoordinator<NavigationResult>(
    reportFailure = ::reportFailure,
  )

  fun submit(
    context: Context,
    appWidgetId: Int,
    delta: Int,
    finish: () -> Unit,
  ) {
    val appContext = context.applicationContext
    val eventName = if (delta < 0) {
      "widget_click_previous_blackbox_entry"
    } else {
      "widget_click_next_blackbox_entry"
    }
    coordinator.submit(
      appWidgetId = appWidgetId,
      delta = delta,
      persist = { currentDelta ->
        val repository = NanoflowWidgetRepository(appContext)
        NavigationResult(
          repository = repository,
          pageIndex = repository.shiftGatePage(appWidgetId, currentDelta),
        )
      },
      telemetry = { result ->
        NanoflowWidgetTelemetry.info(
          eventName,
          mapOf("appWidgetId" to appWidgetId, "pageIndex" to result.pageIndex),
        )
      },
      render = { result ->
        val appWidgetManager = AppWidgetManager.getInstance(appContext)
        NanoflowWidgetReceiver.renderAndApplyWidget(
          context = appContext,
          appWidgetManager = appWidgetManager,
          repository = result.repository,
          appWidgetId = appWidgetId,
          partialUpdate = true,
          afterApply = {
            NanoflowWidgetReceiver.notifyActionListsDataChanged(appWidgetManager, appWidgetId)
          },
        )
      },
      finish = finish,
    )
  }

  private fun reportFailure(error: Throwable) {
    NanoflowWidgetTelemetry.warn(
      event = "widget_gate_navigation_failed",
      fields = mapOf("errorType" to error.javaClass.simpleName),
      error = error,
    )
  }

  private data class NavigationResult(
    val repository: NanoflowWidgetRepository,
    val pageIndex: Int?,
  )
}
