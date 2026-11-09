package app.nanoflow.host

import android.content.Context
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.robolectric.RuntimeEnvironment
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class NanoflowWidgetDurableReplayTest {
  @Test
  fun `processing event is taken over after process interruption with identity intact`() = runBlocking {
    val replayStore = NanoflowWidgetReplayStore(RuntimeEnvironment.getApplication())
    val event = event("event-restart", "operation-restart", "gate-action", 21, "device-restart", 8)
    replayStore.persist(event)
    val firstClaim = replayStore.claim(event, "runtime-before-restart")
    assertNotNull(firstClaim)
    assertTrue(replayStore.takeover(event.ownerDeviceId, event.bindingGeneration, "runtime-before-restart").isEmpty())

    val recovered = replayStore.takeover(event.ownerDeviceId, event.bindingGeneration, "runtime-after-restart").single()
    assertEquals("pending", recovered.status)
    assertEquals(event.operationId, recovered.operationId)
    assertEquals(event.entryId, recovered.entryId)
    assertEquals(1, recovered.attemptCount)
    assertEquals("runtime-after-restart", replayStore.claim(recovered, "runtime-after-restart")?.processingRuntimeId)
  }

  @Test
  fun `navigation page and finished receipt commit together and retry is a no-op`() = runBlocking {
    val context: Context = RuntimeEnvironment.getApplication()
    val store = NanoflowWidgetStore(context)
    val replayStore = NanoflowWidgetReplayStore(context)
    val appWidgetId = 21
    val event = event("event-nav-atomic", "operation-nav-atomic", "gate-navigation", appWidgetId, "device-nav", 3, delta = 1)
    store.persistGatePageIndex(appWidgetId, 1)
    store.persistGateSelectedEntryId(appWidgetId, "entry-b")
    replayStore.persist(event)
    val claimed = replayStore.claim(event, "runtime-nav")!!

    val committed = replayStore.applyGateNavigation(claimed, listOf("entry-a", "entry-b", "entry-c"), "runtime-nav")

    assertEquals(2, committed?.pageIndex)
    assertEquals("entry-c", store.readGateSelectedEntryId(appWidgetId))
    assertEquals(2, store.readGatePageIndex(appWidgetId))
    assertEquals("finished", replayStore.read().first { it.eventId == event.eventId }.status)
    assertNull(replayStore.applyGateNavigation(claimed, listOf("entry-a", "entry-b", "entry-c"), "runtime-nav"))
    assertEquals(2, store.readGatePageIndex(appWidgetId))
  }

  @Test
  fun `retry preserves prior failure evidence until a new terminal result`() = runBlocking {
    val replayStore = NanoflowWidgetReplayStore(RuntimeEnvironment.getApplication())
    val event = event("event-retry-evidence", "operation-retry-evidence", "gate-action", 23, "device-retry", 9)
    replayStore.persist(event)
    val claimed = replayStore.claim(event, "runtime-first")!!
    replayStore.update(claimed.eventId, "failed", "transport outcome unknown", "runtime-first")

    val retry = replayStore.takeover(event.ownerDeviceId, event.bindingGeneration, "runtime-retry").single()
    val retryClaim = replayStore.claim(retry, "runtime-retry")

    assertEquals("transport outcome unknown", retryClaim?.lastError)
    assertEquals(2, retryClaim?.attemptCount)
  }

  @Test
  fun `takeover preserves append order when device clock timestamps go backwards`() = runBlocking {
    val replayStore = NanoflowWidgetReplayStore(RuntimeEnvironment.getApplication())
    val first = event("event-order-first", "operation-order-first", "gate-action", 24, "device-order", 10)
      .copy(createdAtMs = 200L)
    val second = event("event-order-second", "operation-order-second", "gate-navigation", 24, "device-order", 10)
      .copy(createdAtMs = 100L)
    replayStore.persist(first)
    replayStore.persist(second)

    val recovered = replayStore.takeover("device-order", 10, "runtime-order")

    assertEquals(listOf(first.eventId, second.eventId), recovered.map { it.eventId })
  }

  @Test
  fun `foreign device and binding generation cannot take over pending replay`() = runBlocking {
    val context: Context = RuntimeEnvironment.getApplication()
    val replayStore = NanoflowWidgetReplayStore(context)
    val event = event("event-foreign", "operation-foreign", "gate-action", 22, "device-a", 4)
    replayStore.persist(event)

    assertTrue(replayStore.takeover("device-b", 4, "runtime-b").isEmpty())
    assertTrue(replayStore.takeover("device-a", 5, "runtime-a").isEmpty())
    assertEquals("pending", replayStore.read().first { it.eventId == event.eventId }.status)
  }

  private fun event(
    eventId: String,
    operationId: String,
    kind: String,
    appWidgetId: Int,
    ownerDeviceId: String,
    bindingGeneration: Int,
    delta: Int = 0,
  ) = NanoflowWidgetReplayEvent(
    eventId = eventId,
    operationId = operationId,
    kind = kind,
    appWidgetId = appWidgetId,
    delta = delta,
    gateAction = if (kind == "gate-action") NanoflowWidgetActionFactory.GATE_ACTION_READ else null,
    entryId = if (kind == "gate-action") "entry-$appWidgetId" else null,
    ownerDeviceId = ownerDeviceId,
    bindingGeneration = bindingGeneration,
    createdAtMs = System.currentTimeMillis(),
    updatedAtMs = System.currentTimeMillis(),
  )
}
