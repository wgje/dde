package app.nanoflow.host

import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class NanoflowWidgetPackageReinflateWorkerTest {
  @Test
  fun `operation completion wins once and suppresses a late watchdog`() {
    val confirmed = AtomicInteger()
    val unconfirmed = AtomicInteger()
    val finishes = AtomicInteger()
    val handoff = handoff(confirmed, unconfirmed, finishes)

    assertTrue(handoff.confirm())
    assertFalse(handoff.timeout())

    assertEquals(1, confirmed.get())
    assertEquals(0, unconfirmed.get())
    assertEquals(1, finishes.get())
  }

  @Test
  fun `watchdog wins once and suppresses late operation state`() {
    val confirmed = AtomicInteger()
    val unconfirmed = AtomicInteger()
    val finishes = AtomicInteger()
    val reasons = mutableListOf<String>()
    val handoff = NanoflowWidgetPackageReinflateHandoff(
      finish = { finishes.incrementAndGet() },
      reportConfirmed = { confirmed.incrementAndGet() },
      reportUnconfirmed = { reason, _ ->
        reasons += reason
        unconfirmed.incrementAndGet()
      },
    )

    assertTrue(handoff.timeout())
    assertFalse(handoff.confirm())
    assertFalse(handoff.fail("operation-failed", IllegalStateException("late")))

    assertEquals(listOf("watchdog-timeout"), reasons)
    assertEquals(0, confirmed.get())
    assertEquals(1, unconfirmed.get())
    assertEquals(1, finishes.get())
  }

  @Test
  fun `operation failure contains reporter and finish failures`() {
    val reports = AtomicInteger()
    val finishes = AtomicInteger()
    val handoff = NanoflowWidgetPackageReinflateHandoff(
      finish = {
        finishes.incrementAndGet()
        error("finish failed")
      },
      reportConfirmed = { error("must not confirm") },
      reportUnconfirmed = { _, _ ->
        reports.incrementAndGet()
        error("reporter failed")
      },
    )

    val result = runCatching {
      handoff.fail("operation-failed", IllegalStateException("enqueue failed"))
    }

    assertTrue(result.isSuccess)
    assertEquals(1, reports.get())
    assertEquals(1, finishes.get())
  }

  @Test
  fun `failed widget does not block later widgets or follow-up and returns retry`() = runBlocking {
    val events = mutableListOf<String>()
    val failures = mutableListOf<String>()
    val orchestrator = orchestrator(
      widgetIds = intArrayOf(11, 22),
      reinflate = { widgetId ->
        events += "apply-$widgetId"
        if (widgetId == 11) error("apply failed")
      },
      invalidate = { widgetId -> events += "invalidate-$widgetId" },
      enqueueRefresh = { events += "refresh" },
      reportFailure = { stage, widgetId, _ -> failures += "$stage-$widgetId" },
    )

    val outcome = orchestrator.run()

    assertEquals(NanoflowWidgetPackageReinflateOutcome.RETRY, outcome)
    assertEquals(listOf("apply-11", "apply-22", "invalidate-22", "refresh"), events)
    assertEquals(listOf("reinflate-11"), failures)
  }

  @Test
  fun `invalidation failure aggregates retry after every widget`() = runBlocking {
    val events = mutableListOf<String>()
    val orchestrator = orchestrator(
      widgetIds = intArrayOf(1, 2),
      reinflate = { widgetId -> events += "apply-$widgetId" },
      invalidate = { widgetId ->
        events += "invalidate-$widgetId"
        if (widgetId == 1) error("invalidate failed")
      },
      enqueueRefresh = { events += "refresh" },
    )

    val outcome = orchestrator.run()

    assertEquals(NanoflowWidgetPackageReinflateOutcome.RETRY, outcome)
    assertEquals(
      listOf("apply-1", "invalidate-1", "apply-2", "invalidate-2", "refresh"),
      events,
    )
  }

  @Test
  fun `cancellation is rethrown immediately`() {
    val events = mutableListOf<String>()
    val orchestrator = orchestrator(
      widgetIds = intArrayOf(1, 2),
      reinflate = { widgetId ->
        events += "apply-$widgetId"
        throw CancellationException("worker stopped")
      },
      invalidate = { widgetId -> events += "invalidate-$widgetId" },
      enqueueRefresh = { events += "refresh" },
    )

    assertFailsWith<CancellationException> {
      runBlocking { orchestrator.run() }
    }
    assertEquals(listOf("apply-1"), events)
  }

  @Test
  fun `best-effort refresh failure does not change reinflate success`() = runBlocking {
    val failures = mutableListOf<String>()
    val orchestrator = orchestrator(
      widgetIds = intArrayOf(7),
      reinflate = {},
      invalidate = {},
      enqueueRefresh = { error("refresh submit failed") },
      reportFailure = { stage, widgetId, _ -> failures += "$stage-$widgetId" },
    )

    val outcome = orchestrator.run()

    assertEquals(NanoflowWidgetPackageReinflateOutcome.SUCCESS, outcome)
    assertEquals(listOf("refresh-follow-up-null"), failures)
  }

  private fun handoff(
    confirmed: AtomicInteger,
    unconfirmed: AtomicInteger,
    finishes: AtomicInteger,
  ): NanoflowWidgetPackageReinflateHandoff {
    return NanoflowWidgetPackageReinflateHandoff(
      finish = { finishes.incrementAndGet() },
      reportConfirmed = { confirmed.incrementAndGet() },
      reportUnconfirmed = { _, _ -> unconfirmed.incrementAndGet() },
    )
  }

  private fun orchestrator(
    widgetIds: IntArray,
    reinflate: suspend (Int) -> Unit,
    invalidate: (Int) -> Unit,
    enqueueRefresh: () -> Unit,
    reportFailure: (String, Int?, Throwable) -> Unit = { _, _, _ -> },
  ): NanoflowWidgetPackageReinflateOrchestrator {
    return NanoflowWidgetPackageReinflateOrchestrator(
      enumerateWidgetIds = { widgetIds },
      reinflateWidget = reinflate,
      invalidateWidget = invalidate,
      enqueueRefresh = enqueueRefresh,
      reportFailure = reportFailure,
    )
  }
}
