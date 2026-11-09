package app.nanoflow.host

import android.appwidget.AppWidgetManager
import android.content.Context
import java.util.ArrayDeque
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CompletableDeferred
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
  private val durableScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private val coordinator = NanoflowWidgetGateNavigationCoordinator<NavigationResult>(
    reportFailure = ::reportFailure,
  )

  fun submit(
    context: Context,
    appWidgetId: Int,
    delta: Int,
    finish: () -> Unit,
  ) {
    durableScope.launch { NanoflowWidgetDurableReplayCoordinator.submitGateNavigation(context, appWidgetId, delta, finish) }
  }

  internal suspend fun replayEvent(
    context: Context,
    event: NanoflowWidgetReplayEvent,
    store: NanoflowWidgetStore,
    finish: () -> Unit = {},
  ) {
    val completed = CompletableDeferred<Unit>()
    val finished = AtomicBoolean(false)
    val finishOnce = {
      if (finished.compareAndSet(false, true)) {
        runCatching(finish)
        completed.complete(Unit)
      }
    }
    val appContext = context.applicationContext
    val eventName = if (event.delta < 0) {
      "widget_click_previous_blackbox_entry"
    } else {
      "widget_click_next_blackbox_entry"
    }
    try {
      coordinator.submit(
        appWidgetId = event.appWidgetId,
        delta = event.delta,
        persist = {
          val claimed = store.claimDurableReplayEvent(event)
            ?: throw IllegalStateException("Widget navigation replay owner or claim changed")
          try {
            val repository = NanoflowWidgetRepository(appContext)
            val pageIndex = repository.shiftGatePage(claimed)
              ?: throw IllegalStateException("Widget navigation summary is unavailable")
            NavigationResult(repository, pageIndex)
          } catch (error: Throwable) {
            store.updateDurableReplayEvent(event.eventId, "failed", error.message ?: error.javaClass.simpleName)
            throw error
          }
        },
        telemetry = { result ->
          NanoflowWidgetTelemetry.info(
            eventName,
            mapOf("appWidgetId" to event.appWidgetId, "pageIndex" to result.pageIndex, "operationId" to event.operationId),
          )
        },
        render = { result ->
          val appWidgetManager = AppWidgetManager.getInstance(appContext)
          NanoflowWidgetReceiver.renderAndApplyWidget(
            context = appContext,
            appWidgetManager = appWidgetManager,
            repository = result.repository,
            appWidgetId = event.appWidgetId,
            partialUpdate = true,
            afterApply = {
              NanoflowWidgetReceiver.notifyActionListsDataChanged(appWidgetManager, event.appWidgetId)
            },
          )
        },
        finish = finishOnce,
      )
      completed.await()
    } catch (error: Throwable) {
      finishOnce()
      throw error
    }
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
    val pageIndex: Int,
  )
}
