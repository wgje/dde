package app.nanoflow.host

import android.content.Context
import android.content.SharedPreferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
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
  fun `focus hint survives worker retry and event id replay is idempotent after store recreation`() = runBlocking {
    withBoundStore("device-durable-replay", 18, 14_014) { context, firstStore, securePreferences, appWidgetId ->
      val event = focusHint(true, "session-durable", 400, "event-durable", "device-durable-replay", 18)
      var renderAttempts = 0
      val firstAttempt = NanoflowWidgetFocusHintOrchestrator(
        enumerateWidgetIds = { intArrayOf(appWidgetId) },
        persist = firstStore::persistPendingFocusActiveHint,
        render = { _, _ ->
          renderAttempts += 1
          error("synthetic process interruption after durable persist")
        },
      ).run(event)
      assertEquals(NanoflowWidgetFocusHintOutcome.RETRY, firstAttempt)

      val afterRestart = NanoflowWidgetStore(context, securePreferences)
      val durable = context.widgetDataStore.data.first()
      assertEquals("event-durable", durable[stringPreferencesKey("instance.$appWidgetId.pendingFocusEventId")])
      assertEquals(400L, durable[longPreferencesKey("instance.$appWidgetId.pendingFocusRevisionMicros")])
      assertEquals("device-durable-replay", durable[stringPreferencesKey("instance.$appWidgetId.pendingFocusDeviceId")])
      assertEquals(18, durable[intPreferencesKey("instance.$appWidgetId.pendingFocusBindingGeneration")])
      assertEquals("session-durable", afterRestart.readPendingFocusActiveHint(appWidgetId)?.sessionId)

      val retry = NanoflowWidgetFocusHintOrchestrator(
        enumerateWidgetIds = { intArrayOf(appWidgetId) },
        persist = afterRestart::persistPendingFocusActiveHint,
        render = { _, _ -> renderAttempts += 1 },
      ).run(event)
      assertEquals(NanoflowWidgetFocusHintOutcome.SUCCESS, retry)
      assertEquals(2, renderAttempts)

      assertEquals(
        NanoflowWidgetFocusHintDecision.REPLAY,
        afterRestart.persistPendingFocusActiveHint(appWidgetId, event),
      )
      val replayed = context.widgetDataStore.data.first()
      assertEquals("event-durable", replayed[stringPreferencesKey("instance.$appWidgetId.pendingFocusEventId")])
      assertEquals("session-durable", replayed[stringPreferencesKey("instance.$appWidgetId.pendingFocusSessionHint")])
      assertEquals(400L, replayed[longPreferencesKey("instance.$appWidgetId.pendingFocusRevisionMicros")])

      val repeatedEventId = event.copy(active = false, sessionId = "session-rewritten", revisionMicros = 401)
      assertEquals(
        NanoflowWidgetFocusHintDecision.CONFLICT,
        afterRestart.persistPendingFocusActiveHint(appWidgetId, repeatedEventId),
      )
      val repeated = context.widgetDataStore.data.first()
      assertEquals("event-durable", repeated[stringPreferencesKey("instance.$appWidgetId.pendingFocusEventId")])
      assertEquals(true, repeated[booleanPreferencesKey("instance.$appWidgetId.pendingFocusActiveHint")])
      assertEquals("session-durable", repeated[stringPreferencesKey("instance.$appWidgetId.pendingFocusSessionHint")])
      assertEquals(400L, repeated[longPreferencesKey("instance.$appWidgetId.pendingFocusRevisionMicros")])
      assertEquals(true, repeated[booleanPreferencesKey("instance.$appWidgetId.pendingFocusAmbiguous")])
      assertEquals(false, repeated[booleanPreferencesKey("instance.$appWidgetId.pendingFocusProjectable")])
      assertNull(NanoflowWidgetStore(context, securePreferences).readPendingFocusActiveHint(appWidgetId))

      val stale = event.copy(revisionMicros = 399, eventId = "event-stale")
      assertEquals(NanoflowWidgetFocusHintDecision.IGNORED, afterRestart.persistPendingFocusActiveHint(appWidgetId, stale))
      assertEquals("event-durable", context.widgetDataStore.data.first()[stringPreferencesKey("instance.$appWidgetId.pendingFocusEventId")])

      val equalRevisionConflict = event.copy(active = false, eventId = "event-conflict")
      assertEquals(
        NanoflowWidgetFocusHintDecision.CONFLICT,
        afterRestart.persistPendingFocusActiveHint(appWidgetId, equalRevisionConflict),
      )
      val quarantined = context.widgetDataStore.data.first()
      assertEquals("event-durable", quarantined[stringPreferencesKey("instance.$appWidgetId.pendingFocusEventId")])
      assertEquals(true, quarantined[booleanPreferencesKey("instance.$appWidgetId.pendingFocusAmbiguous")])
      assertEquals(false, quarantined[booleanPreferencesKey("instance.$appWidgetId.pendingFocusProjectable")])
      assertNull(NanoflowWidgetStore(context, securePreferences).readPendingFocusActiveHint(appWidgetId))

      assertEquals(
        NanoflowWidgetFocusHintDecision.CONFLICT,
        afterRestart.persistPendingFocusActiveHint(appWidgetId, equalRevisionConflict),
      )
      assertEquals(quarantined, context.widgetDataStore.data.first())

      val newerEvent = event.copy(active = false, sessionId = "session-next", revisionMicros = 402, eventId = "event-next")
      assertEquals(
        NanoflowWidgetFocusHintDecision.APPLIED,
        afterRestart.persistPendingFocusActiveHint(appWidgetId, newerEvent),
      )
      assertEquals(
        NanoflowWidgetFocusHintDecision.IGNORED,
        afterRestart.persistPendingFocusActiveHint(appWidgetId, event.copy(revisionMicros = 401, eventId = "event-older")),
      )
      assertEquals("event-next", context.widgetDataStore.data.first()[stringPreferencesKey("instance.$appWidgetId.pendingFocusEventId")])
      assertEquals(402L, afterRestart.readPendingFocusActiveHint(appWidgetId)?.revisionMicros)
    }
  }

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
  fun `invalidating and empty bindings reject durable focus events`() = runBlocking {
    withBoundStore("device-binding-fence", 19, 14_015) { context, store, securePreferences, appWidgetId ->
      val oldEvent = focusHint(true, "session-old", 500, "event-old-binding", "device-binding-fence", 19)
      assertEquals(NanoflowWidgetFocusHintDecision.APPLIED, store.persistPendingFocusActiveHint(appWidgetId, oldEvent))

      context.widgetDataStore.edit { prefs ->
        prefs[stringPreferencesKey("binding.mirror.phase")] = NanoflowWidgetBindingMirrorPhase.INVALIDATING.name
        prefs[longPreferencesKey("binding.mirror.epoch")] = 51L
        prefs[stringPreferencesKey("binding.mirror.deviceId")] = "device-next-binding"
        prefs[intPreferencesKey("binding.mirror.generation")] = 20
      }
      assertEquals(
        NanoflowWidgetFocusHintDecision.IGNORED,
        store.persistPendingFocusActiveHint(appWidgetId, oldEvent.copy(revisionMicros = 501, eventId = "event-invalidating")),
      )
      val invalidatingReadBack = context.widgetDataStore.data.first()
      assertEquals(NanoflowWidgetBindingMirrorPhase.INVALIDATING.name, invalidatingReadBack[stringPreferencesKey("binding.mirror.phase")])
      assertEquals("event-old-binding", invalidatingReadBack[stringPreferencesKey("instance.$appWidgetId.pendingFocusEventId")])
      assertNull(NanoflowWidgetStore(context, securePreferences).readPendingFocusActiveHint(appWidgetId))

      securePreferences.edit()
        .putString("binding.deviceId", "device-next-binding")
        .putInt("binding.bindingGeneration", 20)
        .commit()
      val nextEvent = oldEvent.copy(
        revisionMicros = 502,
        eventId = "event-next-binding",
        deviceId = "device-next-binding",
        bindingGeneration = 20,
      )
      assertEquals(NanoflowWidgetFocusHintDecision.APPLIED, store.persistPendingFocusActiveHint(appWidgetId, nextEvent))
      val currentOwner = NanoflowWidgetStore(context, securePreferences).readPendingFocusActiveHint(appWidgetId)
      assertEquals("device-next-binding", currentOwner?.deviceId)
      assertEquals(20, currentOwner?.bindingGeneration)
      assertEquals("event-next-binding", context.widgetDataStore.data.first()[stringPreferencesKey("instance.$appWidgetId.pendingFocusEventId")])

      securePreferences.edit().clear().commit()
      context.widgetDataStore.edit { prefs ->
        prefs[stringPreferencesKey("binding.mirror.phase")] = NanoflowWidgetBindingMirrorPhase.EMPTY.name
        prefs[longPreferencesKey("binding.mirror.epoch")] = 52L
        prefs.remove(stringPreferencesKey("binding.mirror.deviceId"))
        prefs.remove(intPreferencesKey("binding.mirror.generation"))
      }
      assertEquals(
        NanoflowWidgetFocusHintDecision.IGNORED,
        store.persistPendingFocusActiveHint(appWidgetId, nextEvent.copy(revisionMicros = 503, eventId = "event-empty")),
      )
      val emptyReadBack = context.widgetDataStore.data.first()
      assertEquals(NanoflowWidgetBindingMirrorPhase.EMPTY.name, emptyReadBack[stringPreferencesKey("binding.mirror.phase")])
      assertEquals("event-next-binding", emptyReadBack[stringPreferencesKey("instance.$appWidgetId.pendingFocusEventId")])
      assertNull(store.readPendingFocusActiveHint(appWidgetId))
    }
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

  private suspend fun withBoundStore(
    deviceId: String,
    generation: Int,
    appWidgetId: Int,
    run: suspend (Context, NanoflowWidgetStore, SharedPreferences, Int) -> Unit,
  ) {
    val context: Context = RuntimeEnvironment.getApplication()
    val securePreferences = context.getSharedPreferences("durable-replay-$deviceId", Context.MODE_PRIVATE)
    context.widgetDataStore.edit { it.clear() }
    securePreferences.edit().clear().commit()
    val store = NanoflowWidgetStore(context, securePreferences)
    store.applyBootstrapPayload(
      WidgetBootstrapPayload(
        widgetToken = "widget-token-$deviceId",
        installationId = "installation-$deviceId",
        deviceId = deviceId,
        supabaseUrl = "https://example.supabase.co",
        bindingGeneration = generation,
        expiresAt = "2035-01-01T00:00:00Z",
        bootstrapNonce = "nonce-$deviceId",
        instanceId = "instance-$deviceId",
        hostInstanceId = appWidgetId.toString(),
      ),
      acceptedPushToken = null,
    )
    try {
      run(context, store, securePreferences, appWidgetId)
    } finally {
      store.clearBindingState()
      context.widgetDataStore.edit { it.clear() }
      securePreferences.edit().clear().commit()
    }
  }

  private fun focusHint(
    active: Boolean,
    sessionId: String,
    revisionMicros: Long,
    eventId: String,
    deviceId: String,
    bindingGeneration: Int,
  ) = NanoflowWidgetFocusHint(active, sessionId, revisionMicros, eventId, deviceId, bindingGeneration)

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
