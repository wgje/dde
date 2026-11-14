package app.nanoflow.host

import android.content.Context
import android.content.SharedPreferences
import androidx.test.core.app.ApplicationProvider
import androidx.work.Configuration
import androidx.work.WorkManager
import androidx.work.testing.SynchronousExecutor
import androidx.work.testing.WorkManagerTestInitHelper
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.Executor
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
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
import kotlin.test.assertTrue

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class NanoflowWidgetFocusHintWorkerTest {
  private val context: Context = ApplicationProvider.getApplicationContext()
  private var workManagerInitialized = false

  @After
  fun closeWorkManager() {
    if (workManagerInitialized) {
      WorkManagerTestInitHelper.closeWorkDatabase()
    }
  }

  @Test
  fun `published six-field payload parses and legacy or partial payloads fail closed`() {
    val exact = payload(revision = "100", eventId = "event-a")

    val parsed = NanoflowWidgetFocusHintPayload.parse(exact)

    assertNotNull(parsed)
    assertEquals(true, parsed.active)
    assertEquals("session-a", parsed.sessionId)
    assertEquals(100L, parsed.revisionMicros)
    assertEquals("event-a", parsed.eventId)
    assertEquals("device-a", parsed.deviceId)
    assertEquals(7, parsed.bindingGeneration)
    assertNull(NanoflowWidgetFocusHintPayload.parse(exact - "focusEventIdHint"))
    assertNull(
      NanoflowWidgetFocusHintPayload.parse(
        (exact - "focusRevisionMicrosHint") + ("focusHintRevisionMicros" to "100"),
      ),
    )
    assertNull(NanoflowWidgetFocusHintPayload.parse(exact + ("focusActiveHint" to "TRUE")))
    assertNull(NanoflowWidgetFocusHintPayload.parse(exact + ("focusBindingGenerationHint" to "0")))
  }

  @Test
  fun `revision state machine applies greater replays exact and fails equal conflict closed`() {
    val binding = NanoflowWidgetBindingIdentity("device-a", 7)
    val first = hint(revision = 100, eventId = "event-a")
    val applied = NanoflowWidgetFocusHintStateMachine.resolve(null, first, binding, 1_000)
    assertEquals(NanoflowWidgetFocusHintDecision.APPLIED, applied.decision)
    assertTrue(assertNotNull(applied.next).projectable)

    val replay = NanoflowWidgetFocusHintStateMachine.resolve(applied.next, first, binding, 1_001)
    assertEquals(NanoflowWidgetFocusHintDecision.REPLAY, replay.decision)
    assertEquals(applied.next, replay.next)

    val ancillaryReplay = NanoflowWidgetFocusHintStateMachine.resolve(
      applied.next,
      first.copy(active = false, sessionId = "session-changed"),
      binding,
      1_002,
    )
    assertEquals(NanoflowWidgetFocusHintDecision.CONFLICT, ancillaryReplay.decision)
    assertFalse(assertNotNull(ancillaryReplay.next).projectable)
    assertTrue(assertNotNull(ancillaryReplay.next).ambiguous)
    assertEquals(applied.next.hint, ancillaryReplay.next.hint)

    val conflict = NanoflowWidgetFocusHintStateMachine.resolve(
      applied.next,
      first.copy(eventId = "event-b", active = false),
      binding,
      1_003,
    )
    assertEquals(NanoflowWidgetFocusHintDecision.CONFLICT, conflict.decision)
    assertFalse(assertNotNull(conflict.next).projectable)
    assertTrue(conflict.next.ambiguous)

    val greater = NanoflowWidgetFocusHintStateMachine.resolve(
      conflict.next,
      first.copy(revisionMicros = 101, eventId = "event-c", active = false),
      binding,
      1_004,
    )
    assertEquals(NanoflowWidgetFocusHintDecision.APPLIED, greater.decision)
    assertTrue(assertNotNull(greater.next).projectable)
  }

  @Test
  fun `old owner and stale revision cannot replace current durable hint`() {
    val binding = NanoflowWidgetBindingIdentity("device-a", 7)
    val current = NanoflowStoredFocusHint(hint(revision = 200), projectable = true, ambiguous = false, issuedAtMs = 1)

    val oldOwner = NanoflowWidgetFocusHintStateMachine.resolve(
      current,
      hint(revision = 300).copy(deviceId = "device-old", bindingGeneration = 6),
      binding,
      2,
    )
    val stale = NanoflowWidgetFocusHintStateMachine.resolve(
      current,
      hint(revision = 199, eventId = "event-old"),
      binding,
      3,
    )

    assertEquals(NanoflowWidgetFocusHintDecision.IGNORED, oldOwner.decision)
    assertEquals(current, oldOwner.next)
    assertEquals(NanoflowWidgetFocusHintDecision.IGNORED, stale.decision)
    assertEquals(current, stale.next)
  }

  @Test
  fun `binding mirror recovers only exact pending target and migrates legacy binding`() {
    val old = NanoflowWidgetBindingIdentity("device-old", 1)
    val next = NanoflowWidgetBindingIdentity("device-next", 2)
    val invalidating = NanoflowWidgetBindingMirror(
      phase = NanoflowWidgetBindingMirrorPhase.INVALIDATING,
      epoch = 9,
      target = next,
    )

    assertEquals(invalidating, NanoflowWidgetBindingMirrorRecovery.resolve(invalidating, old))
    assertEquals(
      invalidating.copy(phase = NanoflowWidgetBindingMirrorPhase.ACTIVE),
      NanoflowWidgetBindingMirrorRecovery.resolve(invalidating, next),
    )
    assertEquals(
      NanoflowWidgetBindingMirror(NanoflowWidgetBindingMirrorPhase.ACTIVE, 1, old),
      NanoflowWidgetBindingMirrorRecovery.resolve(null, old),
    )
    assertEquals(
      NanoflowWidgetBindingMirror(NanoflowWidgetBindingMirrorPhase.EMPTY, 1, null),
      NanoflowWidgetBindingMirrorRecovery.resolve(null, null),
    )
  }

  @Test
  fun `failed secure commit quarantines exposed values until exact retry or process recreation`() {
    val old = NanoflowWidgetBindingIdentity("device-old", 1)
    val next = NanoflowWidgetBindingIdentity("device-next", 2)
    val pending = NanoflowWidgetBindingMirror(NanoflowWidgetBindingMirrorPhase.INVALIDATING, 9, next)
    val preferences = ExposingFailedSharedPreferences(
      mapOf("deviceId" to old.deviceId, "generation" to old.bindingGeneration),
    )
    val fence = NanoflowWidgetSecureTransitionFence()
    var legacyRetained = true

    preferences.nextCommitResult = false
    val failed = fence.commit(confirmsExactBinding = true) {
      preferences.edit().putString("deviceId", next.deviceId)
        .putInt("generation", next.bindingGeneration).commit()
    }
    assertFalse(failed)
    assertEquals(next.deviceId, preferences.getString("deviceId", null))
    assertFalse(fence.canTrustBinding())
    assertNull(fence.readIfTrusted { preferences.getString("deviceId", null) })
    assertTrue(legacyRetained)
    assertEquals(pending, pending.takeUnless { fence.canTrustBinding() })

    var unrelatedCommitRan = false
    assertFalse(fence.commit { unrelatedCommitRan = true; true })
    assertFalse(unrelatedCommitRan)

    val recreatedPreferences = preferences.recreate()
    val recreatedFence = NanoflowWidgetSecureTransitionFence()
    val recreatedIdentity = NanoflowWidgetBindingIdentity(
      assertNotNull(recreatedPreferences.getString("deviceId", null)),
      recreatedPreferences.getInt("generation", 0),
    )
    assertTrue(recreatedFence.canTrustBinding())
    assertEquals(
      NanoflowWidgetBindingMirrorPhase.INVALIDATING,
      NanoflowWidgetBindingMirrorRecovery.resolve(pending, recreatedIdentity).phase,
    )

    preferences.nextCommitResult = true
    val retried = fence.commit(confirmsExactBinding = true) {
      preferences.edit().putString("deviceId", next.deviceId)
        .putInt("generation", next.bindingGeneration).commit()
    }
    if (retried) legacyRetained = false
    assertTrue(retried)
    assertTrue(fence.canTrustBinding())
    assertEquals(next.deviceId, fence.readIfTrusted { preferences.getString("deviceId", null) })
    assertFalse(legacyRetained)
    assertEquals(
      NanoflowWidgetBindingMirrorPhase.ACTIVE,
      NanoflowWidgetBindingMirrorRecovery.resolve(pending, next).phase,
    )
  }

  @Test
  fun `render ticket is process-local and invalidated by hint or binding changes`() {
    val binding = NanoflowWidgetBindingIdentity("device-a", 7)
    val firstProcess = NanoflowWidgetProcessCommitFence()
    firstProcess.replaceBinding(binding)
    val stale = assertNotNull(firstProcess.issue(42))
    firstProcess.invalidate()
    assertFalse(stale.commitIfCurrent { error("stale apply") })

    val beforeRebind = assertNotNull(firstProcess.issue(42))
    firstProcess.replaceBinding(binding.copy(bindingGeneration = 8))
    assertFalse(beforeRebind.commitIfCurrent { error("old owner apply") })

    val recreatedProcess = NanoflowWidgetProcessCommitFence()
    recreatedProcess.replaceBinding(binding)
    val recreatedTicket = assertNotNull(recreatedProcess.issue(42))
    var applied = false
    assertTrue(recreatedTicket.commitIfCurrent { applied = true })
    assertTrue(applied)
  }

  @Test
  fun `acknowledged push token dedupe lasts exactly twenty four hours`() {
    val day = 24 * 60 * 60 * 1000L
    assertFalse(NanoflowWidgetPushTokenDedupe.shouldPersist("token", "token", null, 0, day))
    assertFalse(NanoflowWidgetPushTokenDedupe.shouldPersist("token", null, "token", 1, day))
    assertTrue(NanoflowWidgetPushTokenDedupe.shouldPersist("token", null, "token", 1, day + 1))
    assertTrue(NanoflowWidgetPushTokenDedupe.shouldPersist("token", null, "other", day, day))
  }

  @Test
  fun `real WorkManager APPEND_OR_REPLACE chain retains rapid exact payloads`() {
    val workerExecutor = HoldingExecutor()
    val configuration = Configuration.Builder()
      .setExecutor(workerExecutor)
      .setTaskExecutor(SynchronousExecutor())
      .build()
    WorkManagerTestInitHelper.initializeTestWorkManager(context, configuration)
    workManagerInitialized = true

    assertTrue(NanoflowWidgetFocusHintWorker.enqueueIfComplete(context, payload("100", "event-a")))
    assertTrue(NanoflowWidgetFocusHintWorker.enqueueIfComplete(context, payload("101", "event-b")))

    val infos = WorkManager.getInstance(context)
      .getWorkInfosForUniqueWork("nanoflow-widget-focus-hints")
      .get(5, TimeUnit.SECONDS)
    assertEquals(2, infos.size)
    assertEquals(2, infos.map { it.id }.distinct().size)
    assertTrue(workerExecutor.commands.isNotEmpty())
  }

  @Test
  fun `orchestrator isolates widgets retries failures and rethrows cancellation`() {
    runBlocking {
      val events = mutableListOf<String>()
      val orchestrator = NanoflowWidgetFocusHintOrchestrator(
      enumerateWidgetIds = { intArrayOf(1, 2) },
      persist = { widgetId, _ ->
        events += "persist-$widgetId"
        NanoflowWidgetFocusHintDecision.APPLIED
      },
      render = { widgetId, _ ->
        events += "render-$widgetId"
        if (widgetId == 1) error("render failed")
      },
      reportFailure = { stage, widgetId, _ -> events += "report-$stage-$widgetId" },
    )

      assertEquals(NanoflowWidgetFocusHintOutcome.RETRY, orchestrator.run(hint()))
      assertEquals(
        listOf("persist-1", "render-1", "report-render-1", "persist-2", "render-2"),
        events,
      )

      val cancelling = NanoflowWidgetFocusHintOrchestrator(
        enumerateWidgetIds = { intArrayOf(1, 2) },
        persist = { _, _ -> throw CancellationException("stopped") },
        render = { _, _ -> error("must not render") },
      )
      assertFailsWith<CancellationException> { cancelling.run(hint()) }
    }
  }

  @Test
  fun `retry renders the current durable replay after the first render fails`() = runBlocking {
    var persistenceAttempts = 0
    var renderAttempts = 0
    val orchestrator = NanoflowWidgetFocusHintOrchestrator(
      enumerateWidgetIds = { intArrayOf(42) },
      persist = { _, _ ->
        persistenceAttempts += 1
        if (persistenceAttempts == 1) {
          NanoflowWidgetFocusHintDecision.APPLIED
        } else {
          NanoflowWidgetFocusHintDecision.REPLAY
        }
      },
      render = { _, _ ->
        renderAttempts += 1
        if (renderAttempts == 1) error("launcher apply interrupted")
      },
    )

    assertEquals(NanoflowWidgetFocusHintOutcome.RETRY, orchestrator.run(hint()))
    assertEquals(NanoflowWidgetFocusHintOutcome.SUCCESS, orchestrator.run(hint()))
    assertEquals(2, persistenceAttempts)
    assertEquals(2, renderAttempts)
  }

  @Test
  fun `no installed widgets is a successful no-op`() = runBlocking {
    val orchestrator = NanoflowWidgetFocusHintOrchestrator(
      enumerateWidgetIds = { intArrayOf() },
      persist = { _, _ -> error("must not persist") },
      render = { _, _ -> error("must not render") },
    )
    assertEquals(NanoflowWidgetFocusHintOutcome.SUCCESS, orchestrator.run(hint()))
  }

  @Test
  fun `source contract keeps summary immutable and binding transition ordered`() {
    val repository = readSource("NanoflowWidgetRepository.kt")
    val store = readSource("NanoflowWidgetStore.kt")
    val worker = readSource("NanoflowWidgetFocusHintWorker.kt")

    assertFalse(repository.contains("fun applyFocusActiveHint("))
    assertTrue(repository.contains("effectiveSummaryWithFocusHint("))
    assertTrue(repository.contains("Math.multiplyExact"))
    assertTrue(repository.contains("Math.addExact"))
    assertTrue(store.contains("bindingMutex.withLock"))
    assertTrue(store.contains("secureTransitionFence.commit"))
    assertTrue(store.contains("NanoflowWidgetBindingMirrorRecovery.resolve"))
    val bootstrap = blockAfter(store, "suspend fun applyBootstrapPayload")
    val bootstrapTransition = blockAfter(bootstrap, "bindingMutex.withLock")
    val phaseA = bootstrap.indexOf("writeBindingMirror(prefs, pending)")
    val secureCommit = bootstrap.indexOf("commit(confirmsExactBinding = true)")
    val phaseB = bootstrap.indexOf("pending.copy(phase = NanoflowWidgetBindingMirrorPhase.ACTIVE)")
    assertTrue(phaseA >= 0 && phaseA < secureCommit && secureCommit < phaseB)
    val bootstrapRetire = bootstrap.indexOf("retireLegacySecureFields(snapshot)")
    assertTrue(secureCommit < bootstrapRetire && bootstrapRetire < phaseB)
    assertTrue(bootstrapTransition.contains("prefs[instanceIdKey(hostWidgetId)] = hostInstanceId"))
    val clearBinding = blockAfter(store, "suspend fun clearBindingState")
    val clearAll = blockAfter(store, "suspend fun clearAllWidgetState")
    assertTrue(clearBinding.contains("bindingMutex.withLock"))
    assertTrue(clearBinding.contains("clearBindingStateLocked"))
    assertTrue(clearAll.contains("bindingMutex.withLock"))
    assertTrue(clearAll.contains("clearBindingStateLocked"))
    val clearLocked = blockAfter(store, "private suspend fun clearBindingStateLocked")
    assertTrue(clearLocked.indexOf("commit(confirmsExactBinding = true)") < clearLocked.indexOf("retireLegacySecureFields(snapshot)"))
    val migration = blockAfter(store, "private suspend fun migrateLegacySecureFields")
    assertTrue(migration.indexOf("canTrustBinding()") < migration.indexOf("val secureEditor"))
    assertTrue(migration.indexOf("commit") < migration.indexOf("retireLegacySecureFields(snapshot)"))
    val recovery = blockAfter(store, "private suspend fun recoverBindingMirrorLocked")
    assertTrue(recovery.indexOf("canTrustBinding()") < recovery.indexOf("readSecureBinding()"))
    assertTrue(worker.contains("ExistingWorkPolicy.APPEND_OR_REPLACE"))
    assertTrue(worker.contains("commitIfCurrent = ticket::commitIfCurrent"))
    assertTrue(worker.contains("afterApply ="))
    val inputStart = worker.indexOf("fun toData(")
    val inputEnd = worker.indexOf("\n  }", inputStart)
    assertTrue(inputStart >= 0 && inputEnd > inputStart)
    assertFalse(worker.substring(inputStart, inputEnd).contains("processEpoch"))
  }

  private fun payload(revision: String = "100", eventId: String = "event-a"): Map<String, String> {
    return mapOf(
      "focusActiveHint" to "true",
      "focusSessionHint" to "session-a",
      "focusRevisionMicrosHint" to revision,
      "focusEventIdHint" to eventId,
      "focusDeviceIdHint" to "device-a",
      "focusBindingGenerationHint" to "7",
    )
  }

  private fun hint(revision: Long = 100, eventId: String = "event-a"): NanoflowWidgetFocusHint {
    return NanoflowWidgetFocusHint(true, "session-a", revision, eventId, "device-a", 7)
  }

  private fun readSource(fileName: String): String {
    val candidates = listOf(
      Path.of("src/main/java/app/nanoflow/host/$fileName"),
      Path.of("app/src/main/java/app/nanoflow/host/$fileName"),
      Path.of("android/app/src/main/java/app/nanoflow/host/$fileName"),
    )
    return candidates.firstOrNull(Files::exists)?.toFile()?.readText()
      ?: error("$fileName was not found")
  }

  private fun blockAfter(source: String, marker: String): String {
    val markerIndex = source.indexOf(marker)
    check(markerIndex >= 0) { "Missing marker: $marker" }
    val openBrace = source.indexOf('{', markerIndex)
    check(openBrace >= 0) { "Missing block after: $marker" }
    var depth = 0
    for (index in openBrace until source.length) {
      when (source[index]) {
        '{' -> depth += 1
        '}' -> if (--depth == 0) return source.substring(openBrace + 1, index)
      }
    }
    error("Unterminated block after: $marker")
  }

  private class HoldingExecutor : Executor {
    val commands = mutableListOf<Runnable>()
    override fun execute(command: Runnable) {
      commands += command
    }
  }

  private class ExposingFailedSharedPreferences(initial: Map<String, Any>) : SharedPreferences {
    private val durable = initial.toMutableMap()
    private val visible = initial.toMutableMap()
    var nextCommitResult = true

    fun recreate() = ExposingFailedSharedPreferences(durable)
    override fun getAll(): MutableMap<String, *> = visible.toMutableMap()
    override fun getString(key: String?, defValue: String?): String? = visible[key] as? String ?: defValue
    override fun getStringSet(key: String?, defValues: MutableSet<String>?): MutableSet<String>? = defValues
    override fun getInt(key: String?, defValue: Int): Int = visible[key] as? Int ?: defValue
    override fun getLong(key: String?, defValue: Long): Long = visible[key] as? Long ?: defValue
    override fun getFloat(key: String?, defValue: Float): Float = visible[key] as? Float ?: defValue
    override fun getBoolean(key: String?, defValue: Boolean): Boolean = visible[key] as? Boolean ?: defValue
    override fun contains(key: String?): Boolean = visible.containsKey(key)
    override fun edit(): SharedPreferences.Editor = Editor()
    override fun registerOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener?) = Unit
    override fun unregisterOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener?) = Unit

    private inner class Editor : SharedPreferences.Editor {
      private val writes = mutableMapOf<String, Any?>()
      private val removals = mutableSetOf<String>()
      private var clear = false
      override fun putString(key: String?, value: String?) = write(key, value)
      override fun putStringSet(key: String?, values: MutableSet<String>?) = write(key, values)
      override fun putInt(key: String?, value: Int) = write(key, value)
      override fun putLong(key: String?, value: Long) = write(key, value)
      override fun putFloat(key: String?, value: Float) = write(key, value)
      override fun putBoolean(key: String?, value: Boolean) = write(key, value)
      override fun remove(key: String?): SharedPreferences.Editor = apply { key?.let(removals::add) }
      override fun clear(): SharedPreferences.Editor = apply { clear = true }
      override fun apply() { commit() }
      override fun commit(): Boolean {
        if (clear) visible.clear()
        removals.forEach(visible::remove)
        writes.forEach { (key, value) -> if (value == null) visible.remove(key) else visible[key] = value }
        if (nextCommitResult) {
          durable.clear()
          durable.putAll(visible)
        }
        return nextCommitResult
      }

      private fun write(key: String?, value: Any?): SharedPreferences.Editor = apply {
        if (key != null) writes[key] = value
      }
    }
  }
}
