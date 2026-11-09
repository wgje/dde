package app.nanoflow.host

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import androidx.datastore.preferences.core.MutablePreferences
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import java.util.UUID
import kotlinx.coroutines.CancellationException

internal data class NanoflowWidgetBindingIdentity(val deviceId: String, val bindingGeneration: Int)

internal data class NanoflowWidgetFocusHint(
  val active: Boolean,
  val sessionId: String,
  val revisionMicros: Long,
  val eventId: String,
  val deviceId: String,
  val bindingGeneration: Int,
)

internal data class NanoflowStoredFocusHint(
  val hint: NanoflowWidgetFocusHint,
  val projectable: Boolean,
  val ambiguous: Boolean,
  val issuedAtMs: Long,
)

internal enum class NanoflowWidgetFocusHintDecision { APPLIED, REPLAY, CONFLICT, IGNORED }

internal data class NanoflowWidgetFocusHintResolution(
  val decision: NanoflowWidgetFocusHintDecision,
  val next: NanoflowStoredFocusHint?,
)

internal object NanoflowWidgetFocusHintStateMachine {
  fun resolve(
    current: NanoflowStoredFocusHint?,
    incoming: NanoflowWidgetFocusHint,
    binding: NanoflowWidgetBindingIdentity,
    nowMs: Long,
  ): NanoflowWidgetFocusHintResolution {
    val ownedCurrent = current?.takeIf { it.hint.owner == binding }
    if (incoming.owner != binding) {
      return NanoflowWidgetFocusHintResolution(NanoflowWidgetFocusHintDecision.IGNORED, ownedCurrent)
    }
    if (ownedCurrent == null || incoming.revisionMicros > ownedCurrent.hint.revisionMicros) {
      return NanoflowWidgetFocusHintResolution(
        NanoflowWidgetFocusHintDecision.APPLIED,
        NanoflowStoredFocusHint(incoming, projectable = true, ambiguous = false, issuedAtMs = nowMs),
      )
    }
    if (incoming.revisionMicros < ownedCurrent.hint.revisionMicros) {
      return NanoflowWidgetFocusHintResolution(NanoflowWidgetFocusHintDecision.IGNORED, ownedCurrent)
    }
    val exactReplay = !ownedCurrent.ambiguous && incoming.eventId == ownedCurrent.hint.eventId
    if (exactReplay) {
      return NanoflowWidgetFocusHintResolution(NanoflowWidgetFocusHintDecision.REPLAY, ownedCurrent)
    }
    return NanoflowWidgetFocusHintResolution(
      NanoflowWidgetFocusHintDecision.CONFLICT,
      ownedCurrent.copy(projectable = false, ambiguous = true, issuedAtMs = nowMs),
    )
  }

  private val NanoflowWidgetFocusHint.owner: NanoflowWidgetBindingIdentity
    get() = NanoflowWidgetBindingIdentity(deviceId, bindingGeneration)
}

internal enum class NanoflowWidgetBindingMirrorPhase { ACTIVE, INVALIDATING, EMPTY }

internal data class NanoflowWidgetBindingMirror(
  val phase: NanoflowWidgetBindingMirrorPhase,
  val epoch: Long,
  val target: NanoflowWidgetBindingIdentity?,
)

internal object NanoflowWidgetBindingMirrorRecovery {
  fun resolve(
    mirror: NanoflowWidgetBindingMirror?,
    secure: NanoflowWidgetBindingIdentity?,
  ): NanoflowWidgetBindingMirror {
    if (mirror == null) {
      return NanoflowWidgetBindingMirror(
        if (secure == null) NanoflowWidgetBindingMirrorPhase.EMPTY else NanoflowWidgetBindingMirrorPhase.ACTIVE,
        epoch = 1,
        target = secure,
      )
    }
    if (mirror.phase == NanoflowWidgetBindingMirrorPhase.ACTIVE && mirror.target != secure) {
      return mirror.copy(phase = NanoflowWidgetBindingMirrorPhase.INVALIDATING)
    }
    if (mirror.phase == NanoflowWidgetBindingMirrorPhase.EMPTY && secure != null) {
      return mirror.copy(phase = NanoflowWidgetBindingMirrorPhase.INVALIDATING)
    }
    if (mirror.phase != NanoflowWidgetBindingMirrorPhase.INVALIDATING) return mirror
    return when {
      mirror.target == null && secure == null -> mirror.copy(phase = NanoflowWidgetBindingMirrorPhase.EMPTY)
      mirror.target != null && mirror.target == secure -> mirror.copy(phase = NanoflowWidgetBindingMirrorPhase.ACTIVE)
      else -> mirror
    }
  }
}

internal object NanoflowWidgetPushTokenDedupe {
  fun shouldPersist(
    token: String,
    pending: String?,
    registered: String?,
    acknowledgedAtMs: Long,
    nowMs: Long,
  ): Boolean {
    if (pending?.trim() == token) return false
    return registered?.trim() != token || acknowledgedAtMs <= 0L || nowMs - acknowledgedAtMs >= 24 * 60 * 60 * 1000L
  }
}

internal class NanoflowWidgetRenderTicket internal constructor(
  private val fence: NanoflowWidgetProcessCommitFence,
  private val token: NanoflowWidgetProcessCommitFence.Token,
) {
  fun commitIfCurrent(block: () -> Unit): Boolean = fence.commitIfCurrent(token, block)
}

internal class NanoflowWidgetProcessCommitFence {
  internal data class Token(
    val processEpoch: String,
    val serial: Long,
    val appWidgetId: Int,
    val binding: NanoflowWidgetBindingIdentity,
  )

  private val lock = Any()
  private val processEpoch = UUID.randomUUID().toString()
  private var serial = 0L
  private var binding: NanoflowWidgetBindingIdentity? = null

  fun replaceBinding(next: NanoflowWidgetBindingIdentity?) = synchronized(lock) {
    if (binding != next) {
      binding = next
      serial += 1
    }
  }

  fun invalidate() = synchronized(lock) { serial += 1 }

  fun issue(appWidgetId: Int): NanoflowWidgetRenderTicket? = synchronized(lock) {
    val current = binding ?: return@synchronized null
    NanoflowWidgetRenderTicket(this, Token(processEpoch, serial, appWidgetId, current))
  }

  internal fun commitIfCurrent(token: Token, block: () -> Unit): Boolean = synchronized(lock) {
    if (token.processEpoch != processEpoch || token.serial != serial || token.binding != binding) return@synchronized false
    block()
    true
  }
}

internal object NanoflowWidgetFocusHintPayload {
  private const val ACTIVE = "focusActiveHint"
  private const val SESSION = "focusSessionHint"
  private const val REVISION = "focusRevisionMicrosHint"
  private const val EVENT = "focusEventIdHint"
  private const val DEVICE = "focusDeviceIdHint"
  private const val GENERATION = "focusBindingGenerationHint"

  fun parse(values: Map<String, String>): NanoflowWidgetFocusHint? {
    val active = when (values[ACTIVE]) { "true" -> true; "false" -> false; else -> return null }
    val session = values[SESSION]?.trim()?.takeIf(String::isNotEmpty) ?: return null
    val revision = values[REVISION]?.toLongOrNull()?.takeIf { it > 0 } ?: return null
    val event = values[EVENT]?.trim()?.takeIf(String::isNotEmpty) ?: return null
    val device = values[DEVICE]?.trim()?.takeIf(String::isNotEmpty) ?: return null
    val generation = values[GENERATION]?.toIntOrNull()?.takeIf { it > 0 } ?: return null
    return NanoflowWidgetFocusHint(active, session, revision, event, device, generation)
  }

  fun toData(hint: NanoflowWidgetFocusHint) = workDataOf(
    ACTIVE to hint.active.toString(),
    SESSION to hint.sessionId,
    REVISION to hint.revisionMicros.toString(),
    EVENT to hint.eventId,
    DEVICE to hint.deviceId,
    GENERATION to hint.bindingGeneration.toString(),
  )
}

internal object NanoflowWidgetFocusHintPreferences {
  private fun active(id: Int) = booleanPreferencesKey("instance.$id.pendingFocusActiveHint")
  private fun session(id: Int) = stringPreferencesKey("instance.$id.pendingFocusSessionHint")
  private fun revision(id: Int) = longPreferencesKey("instance.$id.pendingFocusRevisionMicros")
  private fun event(id: Int) = stringPreferencesKey("instance.$id.pendingFocusEventId")
  private fun device(id: Int) = stringPreferencesKey("instance.$id.pendingFocusDeviceId")
  private fun generation(id: Int) = intPreferencesKey("instance.$id.pendingFocusBindingGeneration")
  private fun projectable(id: Int) = booleanPreferencesKey("instance.$id.pendingFocusProjectable")
  private fun ambiguous(id: Int) = booleanPreferencesKey("instance.$id.pendingFocusAmbiguous")
  private fun issued(id: Int) = longPreferencesKey("instance.$id.pendingFocusActiveHintIssuedAtMs")

  fun read(prefs: Preferences, id: Int): NanoflowStoredFocusHint? {
    val hint = NanoflowWidgetFocusHint(
      prefs[active(id)] ?: return null,
      prefs[session(id)] ?: return null,
      prefs[revision(id)] ?: return null,
      prefs[event(id)] ?: return null,
      prefs[device(id)] ?: return null,
      prefs[generation(id)] ?: return null,
    )
    return NanoflowStoredFocusHint(
      hint, prefs[projectable(id)] == true, prefs[ambiguous(id)] == true, prefs[issued(id)] ?: return null,
    )
  }

  fun write(prefs: MutablePreferences, id: Int, state: NanoflowStoredFocusHint?) {
    if (state == null) return remove(prefs, id)
    prefs[active(id)] = state.hint.active
    prefs[session(id)] = state.hint.sessionId
    prefs[revision(id)] = state.hint.revisionMicros
    prefs[event(id)] = state.hint.eventId
    prefs[device(id)] = state.hint.deviceId
    prefs[generation(id)] = state.hint.bindingGeneration
    prefs[projectable(id)] = state.projectable
    prefs[ambiguous(id)] = state.ambiguous
    prefs[issued(id)] = state.issuedAtMs
  }

  fun remove(prefs: MutablePreferences, id: Int) {
    listOf(active(id), session(id), revision(id), event(id), device(id), generation(id), projectable(id), ambiguous(id), issued(id))
      .forEach { prefs.remove(it) }
  }

  fun clearAll(prefs: MutablePreferences) {
    val names = listOf("pendingFocusActiveHint", "pendingFocusSessionHint", "pendingFocusRevisionMicros",
      "pendingFocusEventId", "pendingFocusDeviceId", "pendingFocusBindingGeneration",
      "pendingFocusProjectable", "pendingFocusAmbiguous")
    prefs.asMap().keys.filter { key -> key.name.startsWith("instance.") && names.any(key.name::contains) }
      .forEach { prefs.remove(it) }
  }
}

internal enum class NanoflowWidgetFocusHintOutcome { SUCCESS, RETRY }

internal class NanoflowWidgetFocusHintOrchestrator(
  private val enumerateWidgetIds: () -> IntArray,
  private val persist: suspend (Int, NanoflowWidgetFocusHint) -> NanoflowWidgetFocusHintDecision,
  private val render: suspend (Int, NanoflowWidgetFocusHint) -> Unit,
  private val reportFailure: (String, Int, Throwable) -> Unit = { _, _, _ -> },
) {
  suspend fun run(hint: NanoflowWidgetFocusHint): NanoflowWidgetFocusHintOutcome {
    var retry = false
    for (widgetId in enumerateWidgetIds()) {
      val decision = try {
        persist(widgetId, hint)
      } catch (error: Throwable) {
        error.rethrowCancellation()
        retry = true
        reportSafely("persist", widgetId, error)
        continue
      }
      if (
        decision != NanoflowWidgetFocusHintDecision.APPLIED &&
        decision != NanoflowWidgetFocusHintDecision.REPLAY
      ) continue
      try {
        render(widgetId, hint)
      } catch (error: Throwable) {
        error.rethrowCancellation()
        retry = true
        reportSafely("render", widgetId, error)
      }
    }
    return if (retry) NanoflowWidgetFocusHintOutcome.RETRY else NanoflowWidgetFocusHintOutcome.SUCCESS
  }

  private fun reportSafely(stage: String, widgetId: Int, error: Throwable) {
    runCatching { reportFailure(stage, widgetId, error) }
  }

  private fun Throwable.rethrowCancellation() {
    if (this is CancellationException) throw this
  }
}

class NanoflowWidgetFocusHintWorker(appContext: Context, params: WorkerParameters) :
  CoroutineWorker(appContext, params) {
  override suspend fun doWork(): Result {
    val values = inputData.keyValueMap.mapValues { it.value.toString() }
    val hint = NanoflowWidgetFocusHintPayload.parse(values) ?: return Result.success()
    val context = applicationContext
    val manager = AppWidgetManager.getInstance(context)
    val store = NanoflowWidgetStore(context)
    val repository = NanoflowWidgetRepository(context)
    val orchestrator = NanoflowWidgetFocusHintOrchestrator(
      enumerateWidgetIds = {
        manager.getAppWidgetIds(ComponentName(context, NanoflowWidgetReceiver::class.java))
      },
      persist = store::persistPendingFocusActiveHint,
      render = render@{ widgetId, _ ->
        val ticket = store.issueFocusHintRenderTicket(widgetId) ?: return@render
        NanoflowWidgetReceiver.renderAndApplyWidget(
          context = context,
          appWidgetManager = manager,
          repository = repository,
          appWidgetId = widgetId,
          partialUpdate = true,
          commitIfCurrent = ticket::commitIfCurrent,
          afterApply = { NanoflowWidgetReceiver.notifyActionListsDataChanged(manager, widgetId) },
        )
      },
      reportFailure = { stage, widgetId, error ->
        NanoflowWidgetTelemetry.warn(
          "widget_focus_hint_worker_failed",
          mapOf("stage" to stage, "appWidgetId" to widgetId, "errorType" to error.javaClass.simpleName),
          error,
        )
      },
    )
    return when (orchestrator.run(hint)) {
      NanoflowWidgetFocusHintOutcome.SUCCESS -> Result.success()
      NanoflowWidgetFocusHintOutcome.RETRY -> Result.retry()
    }
  }

  companion object {
    private const val UNIQUE_WORK_NAME = "nanoflow-widget-focus-hints"

    fun enqueueIfComplete(context: Context, values: Map<String, String>): Boolean {
      val hint = NanoflowWidgetFocusHintPayload.parse(values) ?: return false
      val request = OneTimeWorkRequestBuilder<NanoflowWidgetFocusHintWorker>()
        .setInputData(NanoflowWidgetFocusHintPayload.toData(hint))
        .build()
      WorkManager.getInstance(context.applicationContext)
        .beginUniqueWork(UNIQUE_WORK_NAME, ExistingWorkPolicy.APPEND_OR_REPLACE, request)
        .enqueue()
      return true
    }
  }
}
