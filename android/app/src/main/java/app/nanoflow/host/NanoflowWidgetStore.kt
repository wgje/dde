package app.nanoflow.host

import android.content.SharedPreferences
import android.content.Context
import androidx.datastore.preferences.core.MutablePreferences
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json
import java.util.UUID

internal val Context.widgetDataStore by preferencesDataStore(name = "nanoflow_widget")
internal fun instanceIdKey(id: Int) = stringPreferencesKey("instance.$id.id")
internal fun sizeBucketKey(id: Int) = stringPreferencesKey("instance.$id.sizeBucket")
internal fun gatePageIndexKey(id: Int) = intPreferencesKey("instance.$id.gatePageIndex")
internal fun lastAppliedLayoutSignatureKey(id: Int) = stringPreferencesKey("instance.$id.lastAppliedLayoutSignature")

internal data class NanoflowWidgetOptimisticSummarySnapshot(
  val summary: WidgetSummaryResponse,
  val ticket: NanoflowWidgetAuthoritativeRefreshTicket,
)

internal data class NanoflowWidgetAuthoritativeRefreshStart(
  val ticket: NanoflowWidgetAuthoritativeRefreshTicket,
  val binding: StoredWidgetBinding?,
  val summary: WidgetSummaryResponse?,
)

internal fun Iterable<NanoflowWidgetAuthoritativeRefreshTicket>.retainCurrentRefreshSuccessTickets(
  reportSuccess: (NanoflowWidgetAuthoritativeRefreshTicket) -> Unit,
): List<NanoflowWidgetAuthoritativeRefreshTicket> = filter { ticket ->
  ticket.commitIfCurrent { reportSuccess(ticket) }
}

class NanoflowWidgetStore internal constructor(
  internal val context: Context,
  private val securePreferencesOverride: SharedPreferences? = null,
) {
  private val summaryCacheFormatVersion = 2
  private val json = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
  }
  private val authoritativeState = NanoflowWidgetAuthoritativeStatePreferences(json, summaryCacheFormatVersion)

  private val installationIdKey = stringPreferencesKey("binding.installationId")
  private val legacyDeviceIdKey = stringPreferencesKey("binding.deviceId")
  private val legacyDeviceSecretKey = stringPreferencesKey("binding.deviceSecret")
  private val legacyWidgetTokenKey = stringPreferencesKey("binding.widgetToken")
  private val legacyBindingGenerationKey = intPreferencesKey("binding.bindingGeneration")
  private val legacyExpiresAtKey = stringPreferencesKey("binding.expiresAt")
  private val legacyPendingPushTokenKey = stringPreferencesKey("binding.pendingPushToken")
  private val bindingMirrorPhaseKey = stringPreferencesKey("binding.mirror.phase")
  private val bindingMirrorEpochKey = longPreferencesKey("binding.mirror.epoch")
  private val bindingMirrorDeviceIdKey = stringPreferencesKey("binding.mirror.deviceId")
  private val bindingMirrorGenerationKey = intPreferencesKey("binding.mirror.generation")
  private val pendingBootstrapNoncePrefix = "instance.bootstrapNonce."
  private val pendingBootstrapIssuedAtPrefix = "instance.bootstrapIssuedAt."
  private val pendingBootstrapPushTokenPrefix = "instance.bootstrapPushToken."
  private val privacyModeKey = booleanPreferencesKey("settings.privacyMode")

  companion object {
    private val bindingMutex = Mutex()
    private val authoritativeRefreshAttempts = NanoflowWidgetAuthoritativeRefreshAttemptRegistry()
    private val processFence = NanoflowWidgetProcessCommitFence()
    private val pushTokenLock = Any()
    private val secureTransitionFence = NanoflowWidgetSecureTransitionFence()
  }

  private val securePreferences: SharedPreferences by lazy {
    securePreferencesOverride ?: run {
    val appContext = context.applicationContext
    val masterKey = MasterKey.Builder(appContext)
      .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
      .build()

    EncryptedSharedPreferences.create(
      appContext,
      "nanoflow_widget_secure",
      masterKey,
      EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
      EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )
    }
  }

  suspend fun ensureDeviceIdentity(): WidgetDeviceIdentity = bindingMutex.withLock {
    val snapshot = context.widgetDataStore.data.first()
    migrateLegacySecureFields(snapshot)
    val installationId = securePreferences.getString("binding.installationId", null)
      ?: snapshot[installationIdKey] ?: UUID.randomUUID().toString()
    val deviceId = securePreferences.getString("binding.deviceId", null) ?: UUID.randomUUID().toString()
    val deviceSecret = securePreferences.getString("binding.deviceSecret", null) ?: UUID.randomUUID().toString()
    check(secureTransitionFence.commit {
      securePreferences.edit().putString("binding.installationId", installationId)
        .putString("binding.deviceId", deviceId).putString("binding.deviceSecret", deviceSecret).commit()
    }) { "Secure widget identity commit failed" }
    context.widgetDataStore.edit { it[installationIdKey] = installationId }
    WidgetDeviceIdentity(installationId, deviceId, deviceSecret)
  }

  suspend fun readBinding(): StoredWidgetBinding? = bindingMutex.withLock { readBindingLocked() }

  private suspend fun readBindingLocked(): StoredWidgetBinding? {
    migrateLegacySecureFields(context.widgetDataStore.data.first())
    return recoverBindingMirrorLocked(context.widgetDataStore.data.first())
  }

  internal suspend fun <T> withReplayOwner(
    ownerDeviceId: String,
    generation: Int,
    operation: suspend () -> T,
  ): T? {
    bindingMutex.lock()
    try {
      if (!matchesReplayOwner(readBindingLocked(), ownerDeviceId, generation)) return null
      return operation()
    } finally {
      bindingMutex.unlock()
    }
  }

  private fun matchesReplayOwner(binding: StoredWidgetBinding?, ownerDeviceId: String, generation: Int): Boolean =
    if (binding == null) ownerDeviceId == "unbound" && generation == 0
    else binding.deviceId == ownerDeviceId && binding.bindingGeneration == generation

  internal suspend fun beginAuthoritativeRefresh(
    appWidgetId: Int,
  ): NanoflowWidgetAuthoritativeRefreshStart = bindingMutex.withLock {
      migrateLegacySecureFields(context.widgetDataStore.data.first())
      val binding = recoverBindingMirrorLocked(context.widgetDataStore.data.first())
      val snapshot = context.widgetDataStore.data.first()
      val mirror = readBindingMirror(snapshot) ?: NanoflowWidgetBindingMirror(
        if (binding == null) NanoflowWidgetBindingMirrorPhase.EMPTY else NanoflowWidgetBindingMirrorPhase.ACTIVE,
        0L,
        binding?.let { NanoflowWidgetBindingIdentity(it.deviceId, it.bindingGeneration) },
      )
      context.widgetDataStore.edit { authoritativeState.clearMismatched(it, mirror.target, mirror.epoch) }
      NanoflowWidgetAuthoritativeRefreshStart(
        authoritativeRefreshAttempts.issue(mirror.target, mirror.epoch, appWidgetId),
        binding,
        authoritativeState.readAuthoritativeSummary(snapshot, appWidgetId, mirror.target, mirror.epoch),
      )
  }

  internal suspend fun commitAuthoritativeRefresh(
    ticket: NanoflowWidgetAuthoritativeRefreshTicket,
    commit: NanoflowWidgetAuthoritativeRefreshCommit,
    localMutation: MutablePreferences.() -> Unit = {},
  ): NanoflowWidgetAuthoritativeRefreshTicket? {
    return bindingMutex.withLock {
      val binding = recoverBindingMirrorLocked(context.widgetDataStore.data.first())
      val snapshot = context.widgetDataStore.data.first()
      val mirror = readBindingMirror(snapshot) ?: return@withLock null
      val owner = binding?.let { NanoflowWidgetBindingIdentity(it.deviceId, it.bindingGeneration) }
      if (ticket.owner == null) return@withLock null
      if (!ticket.isCurrent() || ticket.owner != owner || ticket.bindingEpoch != mirror.epoch) return@withLock null

      var renderTicket = ticket
      if (commit.clearBinding) {
        clearBindingStateLocked(clearPendingPushToken = false)
        val clearedMirror = readBindingMirror(context.widgetDataStore.data.first()) ?: return@withLock null
        renderTicket = authoritativeRefreshAttempts.issue(null, clearedMirror.epoch, ticket.appWidgetId)
      } else if (commit.clearWidgetContext) {
        clearWidgetBindingContextLocked(ticket.appWidgetId, invalidateAuthoritativeAttempt = false)
      }

      if (commit.clearRegisteredPushToken) clearRegisteredPushTokenStateLocked()
      var accepted = false
      context.widgetDataStore.edit { prefs ->
        accepted = renderTicket.commitIfCurrent {
          clearExpectedAuthoritativeFocusState(prefs, ticket.appWidgetId, commit)
          authoritativeState.save(prefs, renderTicket, commit.summary)
          prefs.localMutation()
          when {
            commit.backoffSeconds != null -> authoritativeState.persistBackoff(prefs, renderTicket, commit.backoffSeconds)
            commit.clearBackoff -> authoritativeState.clearBackoff(prefs)
          }
        }
      }
      renderTicket.takeIf { accepted }
    }
  }

  internal suspend fun persistSignatureIfCurrent(
    ticket: NanoflowWidgetAuthoritativeRefreshTicket?,
    appWidgetId: Int,
    signature: String,
  ): Boolean {
    if (ticket == null) {
      persistLastAppliedLayoutSignature(appWidgetId, signature)
      return true
    }
    return bindingMutex.withLock {
      val binding = recoverBindingMirrorLocked(context.widgetDataStore.data.first())
      val mirror = readBindingMirror(context.widgetDataStore.data.first()) ?: return@withLock false
      val owner = binding?.let { NanoflowWidgetBindingIdentity(it.deviceId, it.bindingGeneration) }
      if (!ticket.isCurrent() || ticket.owner != owner || ticket.bindingEpoch != mirror.epoch) return@withLock false
      context.widgetDataStore.edit { it[lastAppliedLayoutSignatureKey(appWidgetId)] = signature }
      true
    }
  }

  internal suspend fun commitAuthoritativeRenderPreparation(
    ticket: NanoflowWidgetAuthoritativeRefreshTicket,
    preparation: NanoflowWidgetAuthoritativeRenderPreparation,
  ): Boolean = bindingMutex.withLock {
    val binding = recoverBindingMirrorLocked(context.widgetDataStore.data.first())
    val mirror = readBindingMirror(context.widgetDataStore.data.first()) ?: return@withLock false
    val owner = binding?.let { NanoflowWidgetBindingIdentity(it.deviceId, it.bindingGeneration) }
    if (!ticket.isCurrent() || ticket.owner != owner || ticket.bindingEpoch != mirror.epoch) return@withLock false
    context.widgetDataStore.edit { prefs ->
      authoritativeState.applyRenderPreparation(prefs, ticket.appWidgetId, preparation, processFence::invalidate)
    }
    true
  }

  suspend fun applyBootstrapPayload(payload: WidgetBootstrapPayload, acceptedPushToken: String?) {
    val normalizedWidgetToken = payload.widgetToken.trim().takeIf { it.isNotBlank() } ?: return
    val normalizedInstallationId = payload.installationId.trim().takeIf { it.isNotBlank() } ?: return
    val normalizedDeviceId = payload.deviceId.trim().takeIf { it.isNotBlank() } ?: return
    val normalizedExpiresAt = payload.expiresAt.trim().takeIf { it.isNotBlank() } ?: return
    val normalizedSupabaseUrl = payload.supabaseUrl
      ?.trim()
      ?.trimEnd('/')
      ?.takeIf { it.isNotBlank() }
    val normalizedAcceptedPushToken = acceptedPushToken
      ?.trim()
      ?.takeIf { it.isNotBlank() }
    val hostWidgetId = payload.hostInstanceId.toIntOrNull()
    val hostInstanceId = payload.instanceId?.trim()?.takeIf { it.isNotBlank() }

    val target = NanoflowWidgetBindingIdentity(normalizedDeviceId, payload.bindingGeneration)
    authoritativeRefreshAttempts.invalidateWidgetBinding()
    bindingMutex.withLock {
      val snapshot = context.widgetDataStore.data.first()
      migrateLegacySecureFields(snapshot)
      authoritativeRefreshAttempts.invalidateWidgetBinding()
      processFence.replaceBinding(null)
      val pending = NanoflowWidgetBindingMirror(
        NanoflowWidgetBindingMirrorPhase.INVALIDATING,
        (snapshot[bindingMirrorEpochKey] ?: 0L) + 1L,
        target,
      )
      context.widgetDataStore.edit { prefs ->
        writeBindingMirror(prefs, pending)
        authoritativeState.clearMismatched(prefs, target, pending.epoch)
        NanoflowWidgetFocusHintPreferences.clearAll(prefs)
      }
      synchronized(pushTokenLock) {
        val pendingPushToken = securePreferences.getString("binding.pendingPushToken", null)?.trim()
        val editor = securePreferences.edit()
          .putString("binding.installationId", normalizedInstallationId)
          .putString("binding.deviceId", normalizedDeviceId)
          .putString("binding.widgetToken", normalizedWidgetToken)
          .putInt("binding.bindingGeneration", payload.bindingGeneration)
          .putString("binding.expiresAt", normalizedExpiresAt)
          .putString("binding.supabaseUrl", normalizedSupabaseUrl)
        if (!normalizedAcceptedPushToken.isNullOrBlank()) {
          editor.putString("binding.registeredPushToken", normalizedAcceptedPushToken)
          editor.putLong("binding.registeredPushTokenAckAtMs", System.currentTimeMillis())
          if (pendingPushToken == normalizedAcceptedPushToken) editor.remove("binding.pendingPushToken")
        }
        check(secureTransitionFence.commit(confirmsExactBinding = true) { editor.commit() }) {
          "Secure widget binding commit failed" }
      }
      retireLegacySecureFields(snapshot)
      context.widgetDataStore.edit { prefs ->
        check(readBindingMirror(prefs) == pending) { "Widget binding transition was superseded" }
        writeBindingMirror(prefs, pending.copy(phase = NanoflowWidgetBindingMirrorPhase.ACTIVE))
        if (hostWidgetId != null && hostInstanceId != null) prefs[instanceIdKey(hostWidgetId)] = hostInstanceId
      }
      processFence.replaceBinding(target)
    }
  }

  fun readRuntimeSupabaseUrl(): String? = secureTransitionFence.readIfTrusted {
    securePreferences.getString("binding.supabaseUrl", null)
      ?.trim()
      ?.trimEnd('/')
      ?.takeIf { it.isNotBlank() }
  }

  suspend fun issueBootstrapNonce(appWidgetId: Int, requestedPushToken: String?): String {
    val nonce = UUID.randomUUID().toString()
    val issuedAtMs = System.currentTimeMillis()
    val normalizedRequestedPushToken = requestedPushToken
      ?.trim()
      ?.takeIf { it.isNotBlank() }

    context.widgetDataStore.edit { prefs ->
      prefs[stringPreferencesKey(pendingBootstrapNonceKey(appWidgetId))] = nonce
      prefs[longPreferencesKey(pendingBootstrapIssuedAtKey(appWidgetId))] = issuedAtMs
      val requestedPushTokenKey = stringPreferencesKey(pendingBootstrapPushTokenKey(appWidgetId))
      if (normalizedRequestedPushToken == null) {
        prefs.remove(requestedPushTokenKey)
      } else {
        prefs[requestedPushTokenKey] = normalizedRequestedPushToken
      }
    }

    return nonce
  }

  suspend fun readPendingBootstrap(appWidgetId: Int): PendingBootstrapState? {
    val snapshot = context.widgetDataStore.data.first()
    val nonce = snapshot[stringPreferencesKey(pendingBootstrapNonceKey(appWidgetId))] ?: return null
    val issuedAtMs = snapshot[longPreferencesKey(pendingBootstrapIssuedAtKey(appWidgetId))] ?: return null
    val requestedPushToken = snapshot[stringPreferencesKey(pendingBootstrapPushTokenKey(appWidgetId))]
    return PendingBootstrapState(nonce = nonce, issuedAtMs = issuedAtMs, requestedPushToken = requestedPushToken)
  }

  suspend fun clearPendingBootstrap(appWidgetId: Int) {
    context.widgetDataStore.edit { prefs ->
      prefs.remove(stringPreferencesKey(pendingBootstrapNonceKey(appWidgetId)))
      prefs.remove(longPreferencesKey(pendingBootstrapIssuedAtKey(appWidgetId)))
      prefs.remove(stringPreferencesKey(pendingBootstrapPushTokenKey(appWidgetId)))
    }
  }

  suspend fun persistInstanceId(appWidgetId: Int, instanceId: String) =
    context.widgetDataStore.edit { it[instanceIdKey(appWidgetId)] = instanceId }

  suspend fun ensureInstanceId(appWidgetId: Int): String {
    val snapshot = context.widgetDataStore.data.first()
    val key = instanceIdKey(appWidgetId)
    val existing = snapshot[key]
    if (!existing.isNullOrBlank()) {
      return existing
    }

    val instanceId = UUID.randomUUID().toString()
    context.widgetDataStore.edit { prefs ->
      prefs[key] = instanceId
    }
    return instanceId
  }

  suspend fun readInstanceId(appWidgetId: Int): String? = context.widgetDataStore.data.first()[instanceIdKey(appWidgetId)]

  suspend fun persistSizeBucket(appWidgetId: Int, sizeBucket: String) =
    context.widgetDataStore.edit { it[sizeBucketKey(appWidgetId)] = sizeBucket }

  suspend fun readSizeBucket(appWidgetId: Int): String? = context.widgetDataStore.data.first()[sizeBucketKey(appWidgetId)]

  suspend fun readSelectedTaskIndex(appWidgetId: Int): Int =
    context.widgetDataStore.data.first()[selectedTaskIndexKey(appWidgetId)] ?: 0

  suspend fun persistFocusWaitMenuOpen(appWidgetId: Int, open: Boolean) =
    context.widgetDataStore.edit { it[focusWaitMenuOpenKey(appWidgetId)] = open }

  suspend fun readFocusWaitMenuOpen(appWidgetId: Int): Boolean =
    context.widgetDataStore.data.first()[focusWaitMenuOpenKey(appWidgetId)] ?: false

  internal suspend fun persistPendingFocusActiveHint(
    appWidgetId: Int,
    hint: NanoflowWidgetFocusHint,
  ): NanoflowWidgetFocusHintDecision = bindingMutex.withLock {
    val binding = recoverBindingMirrorLocked(context.widgetDataStore.data.first())
      ?: return@withLock NanoflowWidgetFocusHintDecision.IGNORED
    val snapshot = context.widgetDataStore.data.first()
    val current = NanoflowWidgetFocusHintPreferences.read(snapshot, appWidgetId)
    val resolution = NanoflowWidgetFocusHintStateMachine.resolve(
      current,
      hint,
      NanoflowWidgetBindingIdentity(binding.deviceId, binding.bindingGeneration),
      System.currentTimeMillis(),
    )
    if (resolution.next != current) {
      processFence.invalidate()
      context.widgetDataStore.edit { prefs -> NanoflowWidgetFocusHintPreferences.write(prefs, appWidgetId, resolution.next) }
    }
    resolution.decision
  }

  suspend fun readPendingFocusActiveHint(appWidgetId: Int): PendingFocusActiveHint? {
    return bindingMutex.withLock { readPendingFocusActiveHintLocked(appWidgetId, removeMismatched = true) }
  }

  internal suspend fun readPendingFocusActiveHintSnapshot(appWidgetId: Int): PendingFocusActiveHint? =
    bindingMutex.withLock { readPendingFocusActiveHintLocked(appWidgetId, removeMismatched = false) }

  private suspend fun readPendingFocusActiveHintLocked(
    appWidgetId: Int,
    removeMismatched: Boolean,
  ): PendingFocusActiveHint? {
    val binding = recoverBindingMirrorLocked(context.widgetDataStore.data.first()) ?: return null
    val current = NanoflowWidgetFocusHintPreferences.read(context.widgetDataStore.data.first(), appWidgetId) ?: return null
    val hint = current.hint
    if (hint.deviceId != binding.deviceId || hint.bindingGeneration != binding.bindingGeneration) {
      if (removeMismatched) {
        processFence.invalidate()
        context.widgetDataStore.edit { NanoflowWidgetFocusHintPreferences.remove(it, appWidgetId) }
      }
      return null
    }
    if (!current.projectable || current.ambiguous) return null
    return PendingFocusActiveHint(
      hint.active, hint.sessionId, hint.revisionMicros, hint.eventId,
      hint.deviceId, hint.bindingGeneration, current.issuedAtMs,
    )
  }

  suspend fun clearPendingFocusActiveHint(appWidgetId: Int) {
    bindingMutex.withLock {
      val current = NanoflowWidgetFocusHintPreferences.read(context.widgetDataStore.data.first(), appWidgetId) ?: return@withLock
      if (!current.projectable) return@withLock
      processFence.invalidate()
      context.widgetDataStore.edit { prefs ->
        NanoflowWidgetFocusHintPreferences.write(prefs, appWidgetId, current.copy(projectable = false))
      }
    }
  }

  internal suspend fun issueFocusHintRenderTicket(appWidgetId: Int): NanoflowWidgetRenderTicket? {
    readBinding() ?: return null
    return processFence.issue(appWidgetId)
  }

  suspend fun readPendingFocusMutation(appWidgetId: Int): PendingFocusMutation? {
    val snapshot = context.widgetDataStore.data.first()
    val action = snapshot[pendingFocusMutationActionKey(appWidgetId)] ?: return null
    val issuedAtMs = snapshot[pendingFocusMutationIssuedAtKey(appWidgetId)] ?: return null
    return PendingFocusMutation(action = action, issuedAtMs = issuedAtMs)
  }

  /**
   * 【2026-04-24 根因修复】记录上次已应用到 launcher hostView 的 layout 签名（由
   * [NanoflowWidgetRenderer.resolveLayoutSignature] 计算）。receiver / worker 在下次刷新前
   * 对比当前 vs 上次签名：不同则必须走 full `updateAppWidget`，而不是 partial。
   */
  suspend fun persistLastAppliedLayoutSignature(appWidgetId: Int, signature: String) {
    context.widgetDataStore.edit { prefs ->
      prefs[lastAppliedLayoutSignatureKey(appWidgetId)] = signature
    }
  }

  suspend fun readLastAppliedLayoutSignature(appWidgetId: Int): String? {
    return context.widgetDataStore.data.first()[lastAppliedLayoutSignatureKey(appWidgetId)]
  }

  suspend fun readPendingPushToken(): String? = bindingMutex.withLock {
    migrateLegacySecureFields(context.widgetDataStore.data.first())
    secureTransitionFence.readIfTrusted { securePreferences.getString("binding.pendingPushToken", null) }
  }
  suspend fun readRegisteredPushToken(): String? = bindingMutex.withLock {
    migrateLegacySecureFields(context.widgetDataStore.data.first())
    secureTransitionFence.readIfTrusted { securePreferences.getString("binding.registeredPushToken", null) }
  }
  suspend fun readRegisteredPushTokenAckAtMs(): Long? = bindingMutex.withLock {
    migrateLegacySecureFields(context.widgetDataStore.data.first())
    secureTransitionFence.readIfTrusted {
      securePreferences.getLong("binding.registeredPushTokenAckAtMs", 0L).takeIf { it > 0L }
    }
  }

  suspend fun persistPendingPushToken(pushToken: String) {
    synchronized(pushTokenLock) {
      check(secureTransitionFence.commit {
        securePreferences.edit().putString("binding.pendingPushToken", pushToken).commit()
      }) {
        "Pending push token commit failed"
      }
    }
  }

  fun rememberPushTokenSynchronously(pushToken: String, nowMs: Long = System.currentTimeMillis()): Boolean {
    val normalized = pushToken.trim()
    if (normalized.isBlank()) return false
    return synchronized(pushTokenLock) {
      if (!secureTransitionFence.canTrustBinding()) return@synchronized false
      val pending = securePreferences.getString("binding.pendingPushToken", null)
      val registered = securePreferences.getString("binding.registeredPushToken", null)?.trim()
      val acknowledgedAt = securePreferences.getLong("binding.registeredPushTokenAckAtMs", 0L)
      if (!NanoflowWidgetPushTokenDedupe.shouldPersist(normalized, pending, registered, acknowledgedAt, nowMs)) return@synchronized false
      check(secureTransitionFence.commit {
        securePreferences.edit().putString("binding.pendingPushToken", normalized).commit()
      }) {
        "Pending push token commit failed"
      }
      true
    }
  }

  suspend fun clearRegisteredPushTokenState() {
    clearRegisteredPushTokenStateLocked()
  }

  private fun clearRegisteredPushTokenStateLocked() = synchronized(pushTokenLock) {
    check(secureTransitionFence.commit { securePreferences.edit().remove("binding.registeredPushToken")
      .remove("binding.registeredPushTokenAckAtMs").commit() }) { "Registered push token clear failed" }
  }

  suspend fun clearBindingState(clearPendingPushToken: Boolean = false) {
    authoritativeRefreshAttempts.invalidateWidgetBinding()
    processFence.replaceBinding(null)
    bindingMutex.withLock { clearBindingStateLocked(clearPendingPushToken) }
  }
  private suspend fun clearBindingStateLocked(clearPendingPushToken: Boolean) {
    authoritativeRefreshAttempts.invalidateWidgetBinding()
    val snapshot = context.widgetDataStore.data.first()
    val pending = NanoflowWidgetBindingMirror(
      NanoflowWidgetBindingMirrorPhase.INVALIDATING,
      (snapshot[bindingMirrorEpochKey] ?: 0L) + 1L,
      null,
    )
    context.widgetDataStore.edit { prefs ->
      writeBindingMirror(prefs, pending)
      authoritativeState.clearMismatched(prefs, null, pending.epoch)
      NanoflowWidgetFocusHintPreferences.clearAll(prefs)
    }
    synchronized(pushTokenLock) {
      val editor = securePreferences.edit().remove("binding.widgetToken")
        .remove("binding.bindingGeneration").remove("binding.expiresAt")
        .remove("binding.registeredPushToken").remove("binding.registeredPushTokenAckAtMs")
      if (clearPendingPushToken) editor.remove("binding.pendingPushToken")
      check(secureTransitionFence.commit(confirmsExactBinding = true) { editor.commit() }) {
        "Secure widget binding clear failed" }
    }
    retireLegacySecureFields(snapshot)
    context.widgetDataStore.edit { prefs ->
      check(readBindingMirror(prefs) == pending) { "Widget binding clear was superseded" }
      writeBindingMirror(prefs, pending.copy(phase = NanoflowWidgetBindingMirrorPhase.EMPTY))
    }
  }

  suspend fun clearWidgetState(appWidgetId: Int) {
    authoritativeRefreshAttempts.invalidateWidget(appWidgetId)
    processFence.invalidate()
    bindingMutex.withLock {
      context.widgetDataStore.edit { prefs ->
        authoritativeState.clearBindingScopedState(prefs, appWidgetId)
        clearLocalWidgetState(prefs, appWidgetId)
      }
    }
  }

  suspend fun clearWidgetBindingContext(appWidgetId: Int) {
    authoritativeRefreshAttempts.invalidateWidget(appWidgetId)
    processFence.invalidate()
    bindingMutex.withLock {
      clearWidgetBindingContextLocked(appWidgetId, invalidateAuthoritativeAttempt = false)
    }
  }

  private suspend fun clearWidgetBindingContextLocked(appWidgetId: Int, invalidateAuthoritativeAttempt: Boolean) {
    if (invalidateAuthoritativeAttempt) authoritativeRefreshAttempts.invalidateWidget(appWidgetId)
    processFence.invalidate()
    context.widgetDataStore.edit { prefs ->
      authoritativeState.clearBindingScopedState(prefs, appWidgetId)
    }
  }

  suspend fun clearAllWidgetState(clearPendingPushToken: Boolean = false) {
    authoritativeRefreshAttempts.invalidateWidgetBinding()
    processFence.replaceBinding(null)
    bindingMutex.withLock {
      clearBindingStateLocked(clearPendingPushToken)
      context.widgetDataStore.edit { prefs ->
        val keysToRemove = prefs.asMap().keys.filter { key ->
          val name = key.name
          name.startsWith("instance.")
            || name.startsWith("summary.")
            || name.startsWith(pendingBootstrapNoncePrefix)
            || name.startsWith(pendingBootstrapIssuedAtPrefix)
            || name.startsWith(pendingBootstrapPushTokenPrefix)
        }
        keysToRemove.forEach { prefs.remove(it) }
      }
    }
  }

  internal suspend fun <Snapshot> commitOptimisticSummary(
    appWidgetId: Int,
    source: NanoflowWidgetOptimisticSummarySnapshot,
    summary: WidgetSummaryResponse,
    committed: Snapshot,
    localMutation: MutablePreferences.() -> Unit,
  ): WidgetOptimisticResult<Snapshot> {
    if (source.ticket.appWidgetId != appWidgetId) return WidgetOptimisticResult.RejectedStale
    return if (commitAuthoritativeRefresh(
      source.ticket, NanoflowWidgetAuthoritativeRefreshCommit(summary), localMutation,
    ) != null) WidgetOptimisticResult.Committed(committed) else WidgetOptimisticResult.RejectedStale
  }

  /** 上次成功 fetch 的本地 wall-clock 时间（millis）；用于 sync_badge 显示「刚刚 / N 分前」。 */
  suspend fun readSummaryUpdatedAt(appWidgetId: Int): Long? =
    context.widgetDataStore.data.first()[authoritativeState.summaryUpdatedKey(appWidgetId)]

  suspend fun readSummary(appWidgetId: Int): WidgetSummaryResponse? {
    val snapshot = context.widgetDataStore.data.first()
    val mirror = readBindingMirror(snapshot) ?: return null
    if (!authoritativeState.ownerMatches(snapshot, appWidgetId, mirror.target, mirror.epoch)) return null
    if (snapshot[authoritativeState.summaryVersionKey(appWidgetId)] != summaryCacheFormatVersion) {
      if (snapshot[authoritativeState.summaryJsonKey(appWidgetId)] != null) {
        migratePrivacyModeDefault(appWidgetId, clearLegacySummary = true)
      } else if (snapshot[privacyModeKey] == null) {
        migratePrivacyModeDefault(appWidgetId, clearLegacySummary = false)
      }
      return null
    }

    val raw = snapshot[authoritativeState.summaryJsonKey(appWidgetId)] ?: return null
    if (snapshot[privacyModeKey] == null) {
      migratePrivacyModeDefault(appWidgetId, clearLegacySummary = false)
    }

    return runCatching {
      json.decodeFromString(WidgetSummaryResponse.serializer(), raw)
    }.getOrNull()
  }

  internal suspend fun readSummaryForAuthoritativeRender(appWidgetId: Int): WidgetSummaryResponse? {
    val snapshot = context.widgetDataStore.data.first()
    val mirror = readBindingMirror(snapshot) ?: return null
    return authoritativeState.readAuthoritativeSummary(snapshot, appWidgetId, mirror.target, mirror.epoch)
}
  internal suspend fun readPrivacyModeForAuthoritativeRender(): Boolean =
    context.widgetDataStore.data.first()[privacyModeKey] ?: false

  /** 直接展示 widget 正文优先，显式开启隐私模式时再收敛到最小摘要 */
  suspend fun isPrivacyModeEnabled(): Boolean {
    val snapshot = context.widgetDataStore.data.first()
    val storedValue = snapshot[privacyModeKey]
    if (storedValue != null) {
      return storedValue
    }

    context.widgetDataStore.edit { prefs ->
      if (prefs[privacyModeKey] == null) {
        prefs[privacyModeKey] = false
      }
    }
    return false
  }

  suspend fun setPrivacyMode(enabled: Boolean) {
    context.widgetDataStore.edit { prefs ->
      prefs[privacyModeKey] = enabled
    }
  }

  private suspend fun migratePrivacyModeDefault(appWidgetId: Int, clearLegacySummary: Boolean) {
    context.widgetDataStore.edit { prefs ->
      if (clearLegacySummary) {
        authoritativeState.clearWidget(prefs, appWidgetId)
      }

      if (prefs[privacyModeKey] == null) {
        prefs[privacyModeKey] = false
      }
    }
  }

  /** 检查当前是否仍在限流退避期内 */
  suspend fun isRateLimitBackoffActive(): Boolean {
    return bindingMutex.withLock {
      val binding = recoverBindingMirrorLocked(context.widgetDataStore.data.first())
      val snapshot = context.widgetDataStore.data.first()
      val mirror = readBindingMirror(snapshot) ?: return@withLock false
      val owner = binding?.let { NanoflowWidgetBindingIdentity(it.deviceId, it.bindingGeneration) }
      val until = authoritativeState.backoffUntil(snapshot, owner, mirror.epoch) ?: return@withLock false
      System.currentTimeMillis() < until
    }
  }

  private fun pendingBootstrapNonceKey(id: Int) = "$pendingBootstrapNoncePrefix$id"
  private fun pendingBootstrapIssuedAtKey(id: Int) = "$pendingBootstrapIssuedAtPrefix$id"
  private fun pendingBootstrapPushTokenKey(id: Int) = "$pendingBootstrapPushTokenPrefix$id"

  private suspend fun migrateLegacySecureFields(snapshot: Preferences) {
    val secureSnapshot = secureTransitionFence.readIfTrusted { securePreferences.all } ?: return
    val secureEditor = securePreferences.edit()
    var secureChanged = false

    fun migrateString(legacyKey: Preferences.Key<String>, secureKey: String) {
      val legacyValue = snapshot[legacyKey]
      if (!legacyValue.isNullOrBlank() && (secureSnapshot[secureKey] as? String).isNullOrBlank()) {
        secureEditor.putString(secureKey, legacyValue)
        secureChanged = true
      }
    }

    migrateString(installationIdKey, "binding.installationId")
    migrateString(legacyDeviceIdKey, "binding.deviceId")
    migrateString(legacyDeviceSecretKey, "binding.deviceSecret")
    migrateString(legacyWidgetTokenKey, "binding.widgetToken")
    migrateString(legacyExpiresAtKey, "binding.expiresAt")
    migrateString(legacyPendingPushTokenKey, "binding.pendingPushToken")

    val legacyBindingGeneration = snapshot[legacyBindingGenerationKey]
    if (legacyBindingGeneration != null && (secureSnapshot["binding.bindingGeneration"] as? Int ?: 0) == 0) {
      secureEditor.putInt("binding.bindingGeneration", legacyBindingGeneration)
      secureChanged = true
    }

    if (secureChanged) {
      check(secureTransitionFence.commit { secureEditor.commit() }) { "Legacy secure widget binding migration failed" }
    }
    retireLegacySecureFields(snapshot)
  }

  private suspend fun retireLegacySecureFields(snapshot: Preferences) {
    val hasLegacy = snapshot[legacyDeviceIdKey] != null || snapshot[legacyDeviceSecretKey] != null ||
      snapshot[legacyWidgetTokenKey] != null || snapshot[legacyBindingGenerationKey] != null ||
      snapshot[legacyExpiresAtKey] != null || snapshot[legacyPendingPushTokenKey] != null
    if (hasLegacy) {
      context.widgetDataStore.edit { prefs ->
        prefs.remove(legacyDeviceIdKey)
        prefs.remove(legacyDeviceSecretKey)
        prefs.remove(legacyWidgetTokenKey)
        prefs.remove(legacyBindingGenerationKey)
        prefs.remove(legacyExpiresAtKey)
        prefs.remove(legacyPendingPushTokenKey)
      }
    }
  }

  private fun readSecureBinding(): StoredWidgetBinding? {
    val token = securePreferences.getString("binding.widgetToken", null)?.trim()?.takeIf(String::isNotEmpty) ?: return null
    val device = securePreferences.getString("binding.deviceId", null)?.trim()?.takeIf(String::isNotEmpty) ?: return null
    val generation = securePreferences.getInt("binding.bindingGeneration", 0).takeIf { it > 0 } ?: return null
    val expiresAt = securePreferences.getString("binding.expiresAt", null)?.trim()?.takeIf(String::isNotEmpty) ?: return null
    return StoredWidgetBinding(token, device, generation, expiresAt)
  }

  private suspend fun recoverBindingMirrorLocked(snapshot: Preferences): StoredWidgetBinding? {
    if (!secureTransitionFence.canTrustBinding()) {
      processFence.replaceBinding(null)
      return null
    }
    val secure = readSecureBinding()
    val identity = secure?.let { NanoflowWidgetBindingIdentity(it.deviceId, it.bindingGeneration) }
    val current = readBindingMirror(snapshot)
    val resolved = NanoflowWidgetBindingMirrorRecovery.resolve(current, identity)
    if (resolved != current) context.widgetDataStore.edit { writeBindingMirror(it, resolved) }
    val active = resolved.phase == NanoflowWidgetBindingMirrorPhase.ACTIVE && resolved.target == identity
    processFence.replaceBinding(if (active) identity else null)
    return secure?.takeIf { active }
  }

  private fun readBindingMirror(prefs: Preferences): NanoflowWidgetBindingMirror? {
    val phaseName = prefs[bindingMirrorPhaseKey] ?: return null
    val phase = runCatching { NanoflowWidgetBindingMirrorPhase.valueOf(phaseName) }.getOrNull() ?: return null
    val target = prefs[bindingMirrorDeviceIdKey]?.let { device ->
      prefs[bindingMirrorGenerationKey]?.takeIf { it > 0 }?.let { NanoflowWidgetBindingIdentity(device, it) }
    }
    return NanoflowWidgetBindingMirror(phase, prefs[bindingMirrorEpochKey] ?: 0L, target)
  }

  private fun writeBindingMirror(prefs: MutablePreferences, mirror: NanoflowWidgetBindingMirror) {
    prefs[bindingMirrorPhaseKey] = mirror.phase.name
    prefs[bindingMirrorEpochKey] = mirror.epoch
    if (mirror.target == null) {
      prefs.remove(bindingMirrorDeviceIdKey)
      prefs.remove(bindingMirrorGenerationKey)
    } else {
      prefs[bindingMirrorDeviceIdKey] = mirror.target.deviceId
      prefs[bindingMirrorGenerationKey] = mirror.target.bindingGeneration
    }
  }

}
