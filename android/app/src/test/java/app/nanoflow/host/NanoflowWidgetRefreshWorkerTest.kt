package app.nanoflow.host

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.work.Configuration
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.testing.SynchronousExecutor
import androidx.work.testing.WorkManagerTestInitHelper
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executor
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertIs
import kotlin.test.assertTrue

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class NanoflowWidgetRefreshWorkerTest {
  private val context: Context = ApplicationProvider.getApplicationContext()
  private var workManagerInitialized = false

  @After
  fun closeWorkManager() {
    if (workManagerInitialized) WorkManagerTestInitHelper.closeWorkDatabase()
  }

  @Test
  fun `latest same-widget attempt rejects the older commit`() {
    val registry = NanoflowWidgetAuthoritativeRefreshAttemptRegistry()
    val owner = NanoflowWidgetBindingIdentity("device-a", 7)
    val first = registry.issue(owner, bindingEpoch = 11, appWidgetId = 42)
    val second = registry.issue(owner, bindingEpoch = 11, appWidgetId = 42)
    var applies = 0

    assertFalse(registry.commitIfCurrent(first) { applies += 1 })
    assertTrue(registry.commitIfCurrent(second) { applies += 1 })
    assertEquals(1, applies)
  }

  @Test
  fun `different widgets commit while another widget apply is blocked`() = runBlocking {
    val registry = NanoflowWidgetAuthoritativeRefreshAttemptRegistry()
    val owner = NanoflowWidgetBindingIdentity("device-a", 7)
    val first = registry.issue(owner, bindingEpoch = 11, appWidgetId = 1)
    val second = registry.issue(owner, bindingEpoch = 11, appWidgetId = 2)
    val firstEntered = CountDownLatch(1)
    val releaseFirst = CountDownLatch(1)

    val blocked = async(Dispatchers.Default) {
      registry.commitIfCurrent(first) {
        firstEntered.countDown()
        assertTrue(releaseFirst.await(5, TimeUnit.SECONDS))
      }
    }
    assertTrue(firstEntered.await(5, TimeUnit.SECONDS))
    val secondCommitted = withTimeout(2_000) {
      async(Dispatchers.Default) { registry.commitIfCurrent(second) {} }.await()
    }

    assertTrue(secondCommitted)
    releaseFirst.countDown()
    assertTrue(blocked.await())
  }

  @Test
  fun `binding invalidation and process recreation reject prior tickets`() {
    val registry = NanoflowWidgetAuthoritativeRefreshAttemptRegistry()
    val ticket = registry.issue(
      NanoflowWidgetBindingIdentity("device-a", 7),
      bindingEpoch = 11,
      appWidgetId = 42,
    )

    registry.invalidateBinding()
    assertFalse(registry.commitIfCurrent(ticket) { error("stale apply") })
    assertFalse(
      NanoflowWidgetAuthoritativeRefreshAttemptRegistry()
        .commitIfCurrent(ticket) { error("cross-process apply") },
    )
  }

  @Test
  fun `widget deletion invalidates only that widget attempt`() {
    val registry = NanoflowWidgetAuthoritativeRefreshAttemptRegistry()
    val owner = NanoflowWidgetBindingIdentity("device-a", 7)
    val deleted = registry.issue(owner, bindingEpoch = 11, appWidgetId = 42)
    val retained = registry.issue(owner, bindingEpoch = 11, appWidgetId = 43)

    registry.invalidateWidget(42)

    assertFalse(registry.commitIfCurrent(deleted) { error("deleted widget applied") })
    assertTrue(registry.commitIfCurrent(retained) {})
  }

  @Test
  fun `real store rebind clears A state and rejects its in-flight commit`() = runBlocking {
    val store = testStore("rebind")
    store.applyBootstrapPayload(bindingPayload("device-a", 7), acceptedPushToken = null)
    val seeded = store.beginAuthoritativeRefresh(42)
    assertNotNull(
      store.commitAuthoritativeRefresh(
        seeded.ticket,
        NanoflowWidgetAuthoritativeRefreshCommit(summary = WidgetSummaryResponse(code = "OWNER_A")),
      ),
    )
    val stale = store.beginAuthoritativeRefresh(42)

    store.applyBootstrapPayload(bindingPayload("device-b", 8), acceptedPushToken = null)

    assertNull(store.readSummary(42))
    assertNull(
      store.commitAuthoritativeRefresh(
        stale.ticket,
        NanoflowWidgetAuthoritativeRefreshCommit(summary = WidgetSummaryResponse(code = "STALE_A")),
      ),
    )
  }

  @Test
  fun `real store clear rejects in-flight owner and ownerless cache promotion`() = runBlocking {
    val store = testStore("clear")
    store.applyBootstrapPayload(bindingPayload("device-clear", 9), acceptedPushToken = null)
    val stale = store.beginAuthoritativeRefresh(43)

    store.clearBindingState(clearPendingPushToken = false)

    assertNull(
      store.commitAuthoritativeRefresh(
        stale.ticket,
        NanoflowWidgetAuthoritativeRefreshCommit(summary = WidgetSummaryResponse(code = "STALE_OWNER")),
      ),
    )
    val ownerless = store.beginAuthoritativeRefresh(43)
    assertNull(ownerless.binding)
    assertNull(
      store.commitAuthoritativeRefresh(
        ownerless.ticket,
        NanoflowWidgetAuthoritativeRefreshCommit(summary = WidgetSummaryResponse(code = "OWNERLESS")),
      ),
    )
    assertNull(store.readSummary(43))
  }

  @Test
  fun `real store latest same-widget attempt wins`() = runBlocking {
    val store = testStore("latest")
    store.applyBootstrapPayload(bindingPayload("device-latest", 10), acceptedPushToken = null)
    val first = store.beginAuthoritativeRefresh(44)
    val second = store.beginAuthoritativeRefresh(44)

    assertNull(
      store.commitAuthoritativeRefresh(
        first.ticket,
        NanoflowWidgetAuthoritativeRefreshCommit(summary = WidgetSummaryResponse(code = "FIRST")),
      ),
    )
    assertNotNull(
      store.commitAuthoritativeRefresh(
        second.ticket,
        NanoflowWidgetAuthoritativeRefreshCommit(summary = WidgetSummaryResponse(code = "SECOND")),
      ),
    )
    assertEquals("SECOND", store.readSummary(44)?.code)
  }

  @Test
  fun `gate snapshot from A cannot save or rollback after rebind to B`() = runBlocking {
    val store = testStore("optimistic-gate-rebind")
    store.applyBootstrapPayload(bindingPayload("device-gate-a", 20), acceptedPushToken = null)
    seedSummary(store, 50, "OWNER_A")
    val stale = optimisticSnapshot(store.readOptimisticSummary(50))

    store.applyBootstrapPayload(bindingPayload("device-gate-b", 21), acceptedPushToken = null)
    seedSummary(store, 50, "OWNER_B")

    assertEquals(
      WidgetOptimisticResult.RejectedStale,
      store.commitOptimisticSummary(
        50,
        stale,
        stale.summary.copy(code = "STALE_A"),
        Unit,
      ) { this[gateSelectedEntryIdKey(50)] = "entry-a" },
    )
    assertEquals(
      WidgetOptimisticResult.RejectedStale,
      store.commitOptimisticSummary(
        50,
        stale,
        stale.summary,
        Unit,
      ) { this[gateSelectedEntryIdKey(50)] = "entry-a" },
    )
    assertEquals("OWNER_B", store.readSummary(50)?.code)
    assertNull(store.readGateSelectedEntryId(50))
  }

  @Test
  fun `focus snapshot from A cannot create ownerless state after clear`() = runBlocking {
    val store = testStore("optimistic-focus-clear")
    store.applyBootstrapPayload(bindingPayload("device-focus-a", 22), acceptedPushToken = null)
    seedSummary(store, 51, "OWNER_A")
    val stale = optimisticSnapshot(store.readOptimisticSummary(51))

    store.clearBindingState(clearPendingPushToken = false)

    assertEquals(
      WidgetOptimisticResult.RejectedStale,
      store.commitOptimisticSummary(
        51,
        stale,
        stale.summary.copy(code = "STALE_OWNERLESS"),
        Unit,
      ) {
        this[selectedTaskIndexKey(51)] = 0
        this[focusWaitMenuOpenKey(51)] = false
        this[pendingFocusMutationActionKey(51)] = "complete"
      },
    )
    assertNull(store.readSummary(51))
    assertEquals(0, store.readSelectedTaskIndex(51))
    assertNull(store.readPendingFocusMutation(51))
  }

  @Test
  fun `A to B to A rejects the old optimistic binding epoch`() = runBlocking {
    val store = testStore("optimistic-epoch")
    store.applyBootstrapPayload(bindingPayload("device-epoch-a", 23), acceptedPushToken = null)
    seedSummary(store, 52, "OWNER_A_OLD")
    val stale = optimisticSnapshot(store.readOptimisticSummary(52))

    store.applyBootstrapPayload(bindingPayload("device-epoch-b", 24), acceptedPushToken = null)
    store.applyBootstrapPayload(bindingPayload("device-epoch-a", 23), acceptedPushToken = null)
    seedSummary(store, 52, "OWNER_A_CURRENT")

    assertEquals(
      WidgetOptimisticResult.RejectedStale,
      store.commitOptimisticSummary(
        52,
        stale,
        stale.summary.copy(code = "STALE_A_OLD"),
        Unit,
      ) { this[gateSelectedEntryIdKey(52)] = "old-entry" },
    )
    assertEquals("OWNER_A_CURRENT", store.readSummary(52)?.code)
  }

  @Test
  fun `current exact-owner optimistic snapshot commits and remains readable`() = runBlocking {
    val store = testStore("optimistic-current")
    store.applyBootstrapPayload(bindingPayload("device-current", 25), acceptedPushToken = null)
    seedSummary(store, 53, "CURRENT")
    val current = optimisticSnapshot(store.readOptimisticSummary(53))

    assertEquals(
      WidgetOptimisticResult.Committed(Unit),
      store.commitOptimisticSummary(
        53,
        current,
        current.summary.copy(code = "OPTIMISTIC_CURRENT"),
        Unit,
      ) { this[gateSelectedEntryIdKey(53)] = "entry-current" },
    )
    assertEquals("OPTIMISTIC_CURRENT", store.readSummary(53)?.code)
    assertEquals("entry-current", store.readGateSelectedEntryId(53))
  }

  @Test
  fun `authoritative latest attempt rejects an older optimistic snapshot`() = runBlocking {
    val store = testStore("optimistic-authoritative-compose")
    store.applyBootstrapPayload(bindingPayload("device-compose", 26), acceptedPushToken = null)
    seedSummary(store, 54, "CURRENT")
    val optimistic = optimisticSnapshot(store.readOptimisticSummary(54))
    val authoritative = store.beginAuthoritativeRefresh(54)

    assertEquals(
      WidgetOptimisticResult.RejectedStale,
      store.commitOptimisticSummary(
        54,
        optimistic,
        optimistic.summary.copy(code = "STALE_OPTIMISTIC"),
        Unit,
      ) { this[selectedTaskIndexKey(54)] = 0 },
    )
    assertNotNull(
      store.commitAuthoritativeRefresh(
        authoritative.ticket,
        NanoflowWidgetAuthoritativeRefreshCommit(summary = WidgetSummaryResponse(code = "AUTHORITATIVE")),
      ),
    )
    assertEquals("AUTHORITATIVE", store.readSummary(54)?.code)
  }

  @Test
  fun `optimistic read distinguishes current no snapshot from ownerless rejection`() = runBlocking {
    val store = testStore("optimistic-no-snapshot")
    store.applyBootstrapPayload(bindingPayload("device-current-empty", 27), acceptedPushToken = null)

    assertEquals(WidgetOptimisticResult.CurrentNoSnapshot, store.readOptimisticSummary(55))

    store.clearBindingState(clearPendingPushToken = false)
    assertEquals(WidgetOptimisticResult.RejectedStale, store.readOptimisticSummary(55))
  }

  @Test
  fun `real store rebind after model draft rejects normalization signature and binder publication`() = runBlocking {
    val store = testStore("model-rebind")
    store.applyBootstrapPayload(bindingPayload("device-model-a", 11), acceptedPushToken = null)
    val attempt = store.beginAuthoritativeRefresh(45)
    val committed = assertNotNull(
      store.commitAuthoritativeRefresh(
        attempt.ticket,
        NanoflowWidgetAuthoritativeRefreshCommit(summary = WidgetSummaryResponse(code = "OWNER_A")),
      ),
    )
    val preparation = NanoflowWidgetAuthoritativeRenderPreparation().apply {
      sizeBucket = "4x3"
      selectGate(pageIndex = 2, entryId = "entry-a")
    }

    store.applyBootstrapPayload(bindingPayload("device-model-b", 12), acceptedPushToken = null)

    assertFalse(store.commitAuthoritativeRenderPreparation(committed, preparation))
    assertFalse(store.persistSignatureIfCurrent(committed, 45, "focus:large"))
    assertFalse(committed.commitIfCurrent { error("stale binder apply") })
    assertNull(store.readSizeBucket(45))
    assertEquals(0, store.readGatePageIndex(45))
  }

  @Test
  fun `stale render ticket records zero binder or list apply`() {
    val registry = NanoflowWidgetAuthoritativeRefreshAttemptRegistry()
    val owner = NanoflowWidgetBindingIdentity("device-a", 7)
    val stale = registry.issue(owner, bindingEpoch = 11, appWidgetId = 42)
    registry.issue(owner, bindingEpoch = 11, appWidgetId = 42)
    val events = mutableListOf<String>()

    val applied = registry.commitIfCurrent(stale) {
      events += "binder"
      events += "lists"
    }

    assertFalse(applied)
    assertTrue(events.isEmpty())
  }

  @Test
  fun `rebind after response start suppresses stale owner work but preserves token maintenance`() = runBlocking {
    val registry = NanoflowWidgetAuthoritativeRefreshAttemptRegistry()
    val stale = registry.issue(
      NanoflowWidgetBindingIdentity("device-a", 7),
      bindingEpoch = 11,
      appWidgetId = 42,
    )
    val events = mutableListOf<String>()
    var accepted = emptyList<NanoflowWidgetAuthoritativeRefreshTicket>()

    registry.invalidateBinding()
    val outcome = NanoflowWidgetRefreshOrchestrator(
      refresh = {
        accepted = listOf(stale).retainCurrentRefreshSuccessTickets { ticket ->
          events += "widget_refresh_succeeded-${ticket.appWidgetId}"
        }
        accepted
      },
      render = { ticket ->
        events += "mutation-${ticket.appWidgetId}"
        ticket.commitIfCurrent { events += "apply-${ticket.appWidgetId}" }
      },
      ensureToken = { events += "token-maintenance" },
      reportFailure = { stage, _ -> events += "report-$stage" },
    ).run()

    assertFalse(stale.isCurrent())
    assertTrue(accepted.isEmpty())
    assertEquals(NanoflowWidgetRefreshOutcome.SUCCESS, outcome)
    assertEquals(listOf("token-maintenance"), events)
  }

  @Test
  fun `mixed widgets report and continue only the exact current ticket`() {
    val registry = NanoflowWidgetAuthoritativeRefreshAttemptRegistry()
    val stale = registry.issue(
      NanoflowWidgetBindingIdentity("device-a", 7),
      bindingEpoch = 11,
      appWidgetId = 41,
    )
    registry.invalidateBinding()
    val current = registry.issue(
      NanoflowWidgetBindingIdentity("device-b", 8),
      bindingEpoch = 12,
      appWidgetId = 42,
    )
    val events = mutableListOf<String>()

    val accepted = listOf(stale, current).retainCurrentRefreshSuccessTickets { ticket ->
      events += "widget_refresh_succeeded-${ticket.appWidgetId}"
    }
    accepted.forEach { ticket ->
      events += "render-${ticket.appWidgetId}"
      ticket.commitIfCurrent { events += "apply-${ticket.appWidgetId}" }
    }

    assertEquals(listOf(current), accepted)
    assertEquals(
      listOf("widget_refresh_succeeded-42", "render-42", "apply-42"),
      events,
    )
  }

  @Test
  fun `cancellation at refresh stops render token and retry telemetry`() = runBlocking {
    val events = mutableListOf<String>()
    val orchestrator = NanoflowWidgetRefreshOrchestrator(
      refresh = {
        events += "refresh"
        throw CancellationException("replaced")
      },
      render = { events += "render" },
      ensureToken = { events += "token" },
      reportFailure = { stage, _ -> events += "report-$stage" },
    )

    assertFailsWith<CancellationException> { orchestrator.run() }
    assertEquals(listOf("refresh"), events)
  }

  @Test
  fun `cancellation at render or token stops every later stage`() = runBlocking {
    val registry = NanoflowWidgetAuthoritativeRefreshAttemptRegistry()
    val ticket = registry.issue(null, bindingEpoch = 3, appWidgetId = 42)
    val renderEvents = mutableListOf<String>()
    val cancellingRender = NanoflowWidgetRefreshOrchestrator(
      refresh = { renderEvents += "refresh"; listOf(ticket) },
      render = { renderEvents += "render"; throw CancellationException("render") },
      ensureToken = { renderEvents += "token" },
      reportFailure = { stage, _ -> renderEvents += "report-$stage" },
    )
    assertFailsWith<CancellationException> { cancellingRender.run() }
    assertEquals(listOf("refresh", "render"), renderEvents)

    val tokenEvents = mutableListOf<String>()
    val cancellingToken = NanoflowWidgetRefreshOrchestrator(
      refresh = { tokenEvents += "refresh"; listOf(ticket) },
      render = { tokenEvents += "render" },
      ensureToken = { tokenEvents += "token"; throw CancellationException("token") },
      reportFailure = { stage, _ -> tokenEvents += "report-$stage" },
    )
    assertFailsWith<CancellationException> { cancellingToken.run() }
    assertEquals(listOf("refresh", "render", "token"), tokenEvents)
  }

  @Test
  fun `non-cancellation token failures become retry`() = runBlocking {
    val events = mutableListOf<String>()
    val failedToken = NanoflowWidgetRefreshOrchestrator(
      refresh = { events += "refresh"; emptyList() },
      render = { events += "render" },
      ensureToken = { events += "token"; error("fcm token unavailable") },
      reportFailure = { stage, _ -> events += "report-$stage" },
    )

    assertEquals(NanoflowWidgetRefreshOutcome.RETRY, failedToken.run())
    assertEquals(listOf("refresh", "token", "report-token"), events)
  }

  @Test
  fun `token reporter failure stays contained while outcome remains retry`() = runBlocking {
    val events = mutableListOf<String>()
    val failedToken = NanoflowWidgetRefreshOrchestrator(
      refresh = { events += "refresh"; emptyList() },
      render = { events += "render" },
      ensureToken = { events += "token"; error("fcm token unavailable") },
      reportFailure = { stage, _ -> events += "report-$stage"; error("telemetry") },
    )

    assertEquals(NanoflowWidgetRefreshOutcome.RETRY, failedToken.run())
    assertEquals(listOf("refresh", "token", "report-token"), events)
  }

  @Test
  fun `non-cancellation failures retry while reporter failures stay contained`() = runBlocking {
    val events = mutableListOf<String>()
    val failedRefresh = NanoflowWidgetRefreshOrchestrator(
      refresh = { events += "refresh"; error("offline") },
      render = { events += "render" },
      ensureToken = { events += "token" },
      reportFailure = { stage, _ -> events += "report-$stage"; error("telemetry") },
    )

    assertEquals(NanoflowWidgetRefreshOutcome.RETRY, failedRefresh.run())
    assertEquals(listOf("refresh", "report-refresh"), events)
  }

  @Test
  fun `real WorkManager REPLACE cancels the older unique refresh`() {
    val workerExecutor = HoldingExecutor()
    val configuration = Configuration.Builder()
      .setExecutor(workerExecutor)
      .setTaskExecutor(SynchronousExecutor())
      .build()
    WorkManagerTestInitHelper.initializeTestWorkManager(context, configuration)
    workManagerInitialized = true

    val firstId = NanoflowWidgetRefreshWorker.enqueue(context, "first")
    val secondId = NanoflowWidgetRefreshWorker.enqueue(context, "second")

    val workManager = WorkManager.getInstance(context)
    val first = workManager.getWorkInfoById(firstId).get(5, TimeUnit.SECONDS)
    val second = assertNotNull(workManager.getWorkInfoById(secondId).get(5, TimeUnit.SECONDS))
    val unique = workManager.getWorkInfosForUniqueWork("nanoflow-widget-refresh").get(5, TimeUnit.SECONDS)
    assertTrue(first == null || first.state == WorkInfo.State.CANCELLED)
    assertTrue(second.state == WorkInfo.State.ENQUEUED || second.state == WorkInfo.State.RUNNING)
    assertEquals(listOf(secondId), unique.map { it.id })
    assertTrue(workerExecutor.commands.isNotEmpty())
  }

  private class HoldingExecutor : Executor {
    val commands = mutableListOf<Runnable>()
    override fun execute(command: Runnable) {
      commands += command
    }
  }

  private fun bindingPayload(deviceId: String, generation: Int) = WidgetBootstrapPayload(
    widgetToken = "widget-token-$deviceId",
    installationId = "installation-$deviceId",
    deviceId = deviceId,
    supabaseUrl = "https://example.supabase.co",
    bindingGeneration = generation,
    expiresAt = "2035-01-01T00:00:00Z",
    bootstrapNonce = "nonce-$deviceId",
    instanceId = "instance-$deviceId",
    hostInstanceId = "42",
  )

  private suspend fun seedSummary(
    store: NanoflowWidgetStore,
    appWidgetId: Int,
    code: String,
  ): NanoflowWidgetAuthoritativeRefreshTicket {
    val start = store.beginAuthoritativeRefresh(appWidgetId)
    return assertNotNull(
      store.commitAuthoritativeRefresh(
        start.ticket,
        NanoflowWidgetAuthoritativeRefreshCommit(summary = WidgetSummaryResponse(code = code)),
      ),
    )
  }

  private fun optimisticSnapshot(
    result: WidgetOptimisticResult<NanoflowWidgetOptimisticSummarySnapshot>,
  ): NanoflowWidgetOptimisticSummarySnapshot =
    assertIs<WidgetOptimisticResult.Committed<NanoflowWidgetOptimisticSummarySnapshot>>(result).snapshot

  private fun testStore(name: String) = NanoflowWidgetStore(
    context,
    context.getSharedPreferences("nanoflow-authoritative-$name", Context.MODE_PRIVATE),
  )
}
