package app.nanoflow.host

import android.content.Context
import android.os.Handler
import android.os.Looper
import androidx.work.Operation
import java.util.UUID
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executor
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CancellationException

internal data class NanoflowWidgetRefreshTrackedEnqueue(
  val requestId: UUID,
  val operation: Operation,
)

private class NanoflowWidgetRefreshHandoffSettlement(
  finish: () -> Unit,
  reportConfirmed: (UUID) -> Unit,
  reportUnconfirmed: (UUID?, String, Throwable?) -> Unit,
) {
  private data class Callbacks(
    val finish: () -> Unit,
    val reportConfirmed: (UUID) -> Unit,
    val reportUnconfirmed: (UUID?, String, Throwable?) -> Unit,
  )

  private val callbacks = AtomicReference<Callbacks?>(
    Callbacks(finish, reportConfirmed, reportUnconfirmed),
  )

  fun confirm(requestId: UUID): Boolean = settle { it.reportConfirmed(requestId) }

  fun fail(requestId: UUID?, reason: String, error: Throwable?): Boolean =
    settle { it.reportUnconfirmed(requestId, reason, error) }

  fun isSettled(): Boolean = callbacks.get() == null

  private inline fun settle(report: (Callbacks) -> Unit): Boolean {
    val owned = callbacks.getAndSet(null) ?: return false
    runCatching { report(owned) }
    runCatching(owned.finish)
    return true
  }
}

internal class NanoflowWidgetRefreshHandoffCoordinator(
  private val scheduleWatchdog: (Long, () -> Unit) -> (() -> Unit),
  private val observeOperation: (Operation, () -> Unit) -> Unit,
  private val reportConfirmed: (UUID) -> Unit,
  private val reportUnconfirmed: (UUID?, String, Throwable?) -> Unit,
) {
  fun submit(
    enqueue: () -> NanoflowWidgetRefreshTrackedEnqueue,
    finish: () -> Unit,
  ) {
    val settlement = NanoflowWidgetRefreshHandoffSettlement(
      finish = finish,
      reportConfirmed = reportConfirmed,
      reportUnconfirmed = reportUnconfirmed,
    )
    val tracked = try {
      enqueue()
    } catch (error: Throwable) {
      settlement.fail(null, "submit-failed", error)
      return
    }
    val cancelWatchdog = try {
      scheduleWatchdog(HANDOFF_WATCHDOG_MS) {
        settlement.fail(tracked.requestId, "watchdog-timeout", null)
      }
    } catch (error: Throwable) {
      settlement.fail(tracked.requestId, "watchdog-schedule-failed", error)
      return
    }
    if (settlement.isSettled()) {
      runCatching(cancelWatchdog)
      return
    }
    try {
      observeOperation(tracked.operation) {
        val won = try {
          tracked.operation.result.get()
          settlement.confirm(tracked.requestId)
        } catch (error: Throwable) {
          settlement.fail(
            tracked.requestId,
            "operation-result-failed",
            error.unwrapExecutionFailure(),
          )
        }
        if (won) runCatching(cancelWatchdog)
      }
    } catch (error: Throwable) {
      if (settlement.fail(tracked.requestId, "operation-observer-failed", error)) {
        runCatching(cancelWatchdog)
      }
    }
  }

  private fun Throwable.unwrapExecutionFailure(): Throwable =
    if (this is ExecutionException && cause != null) requireNotNull(cause) else this

  private companion object {
    const val HANDOFF_WATCHDOG_MS = 8_000L
  }
}

internal object NanoflowWidgetRefreshHandoffProcessCoordinator {
  private val directExecutor = Executor { command -> command.run() }
  private val coordinator = NanoflowWidgetRefreshHandoffCoordinator(
    scheduleWatchdog = { delayMs, callback ->
      val handler = Handler(Looper.getMainLooper())
      val watchdog = Runnable(callback)
      check(handler.postDelayed(watchdog, delayMs)) { "Refresh handoff watchdog was rejected" }
      val cancelWatchdog: () -> Unit = { handler.removeCallbacks(watchdog) }
      cancelWatchdog
    },
    observeOperation = { operation, callback ->
      operation.result.addListener(callback, directExecutor)
    },
    reportConfirmed = {
      NanoflowWidgetTelemetry.info("widget_refresh_handoff_confirmed")
    },
    reportUnconfirmed = { _, reason, error ->
      val fields = mapOf(
        "reason" to reason,
        "errorType" to (error?.javaClass?.simpleName ?: "none"),
      )
      if (error == null) {
        NanoflowWidgetTelemetry.warn("widget_refresh_handoff_unconfirmed", fields)
      } else {
        NanoflowWidgetTelemetry.warn("widget_refresh_handoff_unconfirmed", fields, error)
      }
    },
  )

  fun submit(context: Context, reason: String, finish: () -> Unit) {
    coordinator.submit(
      enqueue = { NanoflowWidgetRefreshWorker.enqueueTracked(context, reason) },
      finish = finish,
    )
  }
}

internal enum class NanoflowWidgetRefreshOutcome { SUCCESS, RETRY }

internal class NanoflowWidgetRefreshOrchestrator(
  private val refresh: suspend () -> List<NanoflowWidgetAuthoritativeRefreshTicket>,
  private val render: suspend (NanoflowWidgetAuthoritativeRefreshTicket) -> Unit,
  private val ensureToken: suspend () -> Unit,
  private val reportFailure: (String, Throwable) -> Unit,
) {
  suspend fun run(): NanoflowWidgetRefreshOutcome {
    val tickets = try {
      refresh()
    } catch (error: Throwable) {
      error.rethrowCancellation()
      reportSafely("refresh", error)
      return NanoflowWidgetRefreshOutcome.RETRY
    }

    var retry = false
    tickets.forEach { ticket ->
      try {
        render(ticket)
      } catch (error: Throwable) {
        error.rethrowCancellation()
        retry = true
        reportSafely("render", error)
      }
    }
    try {
      ensureToken()
    } catch (error: Throwable) {
      error.rethrowCancellation()
      retry = true
      reportSafely("token", error)
    }
    return if (retry) NanoflowWidgetRefreshOutcome.RETRY else NanoflowWidgetRefreshOutcome.SUCCESS
  }

  private fun reportSafely(stage: String, error: Throwable) {
    try {
      reportFailure(stage, error)
    } catch (_: Throwable) {}
  }

  private fun Throwable.rethrowCancellation() {
    if (this is CancellationException) throw this
  }
}
