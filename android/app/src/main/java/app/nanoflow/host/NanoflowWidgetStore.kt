package app.nanoflow.host

import android.content.SharedPreferences
import android.content.Context
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
import kotlinx.serialization.json.Json
import java.util.UUID

private val Context.widgetDataStore by preferencesDataStore(name = "nanoflow_widget")

data class PendingFocusActiveHint(
  val active: Boolean,
  val issuedAtMs: Long,
)

data class PendingFocusMutation(
  val action: String,
  val issuedAtMs: Long,
)

class NanoflowWidgetStore(private val context: Context) {
  private val summaryCacheFormatVersion = 1
  private val json = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
  }

  private val installationIdKey = stringPreferencesKey("binding.installationId")
  private val legacyDeviceIdKey = stringPreferencesKey("binding.deviceId")
  private val legacyDeviceSecretKey = stringPreferencesKey("binding.deviceSecret")
  private val legacyWidgetTokenKey = stringPreferencesKey("binding.widgetToken")
  private val legacyBindingGenerationKey = intPreferencesKey("binding.bindingGeneration")
  private val legacyExpiresAtKey = stringPreferencesKey("binding.expiresAt")
  private val legacyPendingPushTokenKey = stringPreferencesKey("binding.pendingPushToken")
  private val pendingBootstrapNoncePrefix = "instance.bootstrapNonce."
  private val pendingBootstrapIssuedAtPrefix = "instance.bootstrapIssuedAt."
  private val pendingBootstrapPushTokenPrefix = "instance.bootstrapPushToken."
  private val privacyModeKey = booleanPreferencesKey("settings.privacyMode")

  private val securePreferences: SharedPreferences by lazy {
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

  suspend fun ensureDeviceIdentity(): WidgetDeviceIdentity {
    val snapshot = context.widgetDataStore.data.first()
    migrateLegacySecureFields(snapshot)
    val installationId = securePreferences.getString("binding.installationId", null)
      ?: snapshot[installationIdKey]
      ?: UUID.randomUUID().toString()
    val deviceId = securePreferences.getString("binding.deviceId", null)
      ?: UUID.randomUUID().toString()
    val deviceSecret = securePreferences.getString("binding.deviceSecret", null)
      ?: UUID.randomUUID().toString()

    securePreferences.edit()
      .putString("binding.installationId", installationId)
      .putString("binding.deviceId", deviceId)
      .putString("binding.deviceSecret", deviceSecret)
      .apply()

    context.widgetDataStore.edit { prefs ->
      prefs[installationIdKey] = installationId
    }

    return WidgetDeviceIdentity(
      installationId = installationId,
      deviceId = deviceId,
      deviceSecret = deviceSecret,
    )
  }

  suspend fun readBinding(): StoredWidgetBinding? {
    migrateLegacySecureFields(context.widgetDataStore.data.first())
    val widgetToken = securePreferences.getString("binding.widgetToken", null)?.trim()?.takeIf { it.isNotBlank() } ?: return null
    val deviceId = securePreferences.getString("binding.deviceId", null)?.trim()?.takeIf { it.isNotBlank() } ?: return null
    val bindingGeneration = securePreferences.getInt("binding.bindingGeneration", 0).takeIf { it > 0 } ?: return null
    val expiresAt = securePreferences.getString("binding.expiresAt", null)?.trim()?.takeIf { it.isNotBlank() } ?: return null
    return StoredWidgetBinding(
      widgetToken = widgetToken,
      deviceId = deviceId,
      bindingGeneration = bindingGeneration,
      expiresAt = expiresAt,
    )
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
    val currentPendingPushToken = securePreferences.getString("binding.pendingPushToken", null)
      ?.trim()
      ?.takeIf { it.isNotBlank() }
    val normalizedAcceptedPushToken = acceptedPushToken
      ?.trim()
      ?.takeIf { it.isNotBlank() }

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
      if (currentPendingPushToken == normalizedAcceptedPushToken) {
        editor.remove("binding.pendingPushToken")
      }
    }

    editor.apply()

    val hostWidgetId = payload.hostInstanceId.toIntOrNull()
    if (hostWidgetId != null && !payload.instanceId.isNullOrBlank()) {
      persistInstanceId(hostWidgetId, payload.instanceId)
    }
  }

  fun readRuntimeSupabaseUrl(): String? {
    return securePreferences.getString("binding.supabaseUrl", null)
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

  suspend fun persistInstanceId(appWidgetId: Int, instanceId: String) {
    context.widgetDataStore.edit { prefs ->
      prefs[instanceIdKey(appWidgetId)] = instanceId
    }
  }

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

  suspend fun readInstanceId(appWidgetId: Int): String? {
    return context.widgetDataStore.data.first()[instanceIdKey(appWidgetId)]
  }

  suspend fun persistSizeBucket(appWidgetId: Int, sizeBucket: String) {
    context.widgetDataStore.edit { prefs ->
      prefs[sizeBucketKey(appWidgetId)] = sizeBucket
    }
  }

  suspend fun readSizeBucket(appWidgetId: Int): String? {
    return context.widgetDataStore.data.first()[sizeBucketKey(appWidgetId)]
  }

  suspend fun persistGatePageIndex(appWidgetId: Int, pageIndex: Int) {
    context.widgetDataStore.edit { prefs ->
      prefs[gatePageIndexKey(appWidgetId)] = pageIndex.coerceAtLeast(0)
    }
  }

  suspend fun readGatePageIndex(appWidgetId: Int): Int {
    return context.widgetDataStore.data.first()[gatePageIndexKey(appWidgetId)] ?: 0
  }

  /** 历史兼容字段：旧版 widget 的本地 tab 下标缓存。当前实现固定以前台 C 位为 0。 */
  suspend fun persistSelectedTaskIndex(appWidgetId: Int, taskIndex: Int) {
    context.widgetDataStore.edit { prefs ->
      prefs[selectedTaskIndexKey(appWidgetId)] = taskIndex.coerceAtLeast(0)
    }
  }

  suspend fun readSelectedTaskIndex(appWidgetId: Int): Int {
    return context.widgetDataStore.data.first()[selectedTaskIndexKey(appWidgetId)] ?: 0
  }

  suspend fun persistFocusWaitMenuOpen(appWidgetId: Int, open: Boolean) {
    context.widgetDataStore.edit { prefs ->
      prefs[focusWaitMenuOpenKey(appWidgetId)] = open
    }
  }

  suspend fun readFocusWaitMenuOpen(appWidgetId: Int): Boolean {
    return context.widgetDataStore.data.first()[focusWaitMenuOpenKey(appWidgetId)] ?: false
  }

  suspend fun persistPendingFocusActiveHint(appWidgetId: Int, active: Boolean) {
    context.widgetDataStore.edit { prefs ->
      prefs[pendingFocusActiveHintKey(appWidgetId)] = active
      prefs[pendingFocusActiveHintIssuedAtKey(appWidgetId)] = System.currentTimeMillis()
    }
  }

  suspend fun readPendingFocusActiveHint(appWidgetId: Int): PendingFocusActiveHint? {
    val snapshot = context.widgetDataStore.data.first()
    val active = snapshot[pendingFocusActiveHintKey(appWidgetId)] ?: return null
    val issuedAtMs = snapshot[pendingFocusActiveHintIssuedAtKey(appWidgetId)] ?: return null
    return PendingFocusActiveHint(active = active, issuedAtMs = issuedAtMs)
  }

  suspend fun clearPendingFocusActiveHint(appWidgetId: Int) {
    context.widgetDataStore.edit { prefs ->
      prefs.remove(pendingFocusActiveHintKey(appWidgetId))
      prefs.remove(pendingFocusActiveHintIssuedAtKey(appWidgetId))
    }
  }

  suspend fun persistPendingFocusMutation(appWidgetId: Int, action: String) {
    context.widgetDataStore.edit { prefs ->
      prefs[pendingFocusMutationActionKey(appWidgetId)] = action
      prefs[pendingFocusMutationIssuedAtKey(appWidgetId)] = System.currentTimeMillis()
    }
  }

  suspend fun readPendingFocusMutation(appWidgetId: Int): PendingFocusMutation? {
    val snapshot = context.widgetDataStore.data.first()
    val action = snapshot[pendingFocusMutationActionKey(appWidgetId)] ?: return null
    val issuedAtMs = snapshot[pendingFocusMutationIssuedAtKey(appWidgetId)] ?: return null
    return PendingFocusMutation(action = action, issuedAtMs = issuedAtMs)
  }

  suspend fun clearPendingFocusMutation(appWidgetId: Int) {
    context.widgetDataStore.edit { prefs ->
      prefs.remove(pendingFocusMutationActionKey(appWidgetId))
      prefs.remove(pendingFocusMutationIssuedAtKey(appWidgetId))
    }
  }

  suspend fun persistGateSelectedEntryId(appWidgetId: Int, entryId: String?) {
    context.widgetDataStore.edit { prefs ->
      val key = gateSelectedEntryIdKey(appWidgetId)
      if (entryId.isNullOrBlank()) {
        prefs.remove(key)
      } else {
        prefs[key] = entryId
      }
    }
  }

  suspend fun readGateSelectedEntryId(appWidgetId: Int): String? {
    return context.widgetDataStore.data.first()[gateSelectedEntryIdKey(appWidgetId)]
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

  suspend fun readPendingPushToken(): String? {
    migrateLegacySecureFields(context.widgetDataStore.data.first())
    return securePreferences.getString("binding.pendingPushToken", null)
  }

  suspend fun readRegisteredPushToken(): String? {
    migrateLegacySecureFields(context.widgetDataStore.data.first())
    return securePreferences.getString("binding.registeredPushToken", null)
  }

  suspend fun readRegisteredPushTokenAckAtMs(): Long? {
    migrateLegacySecureFields(context.widgetDataStore.data.first())
    return securePreferences.getLong("binding.registeredPushTokenAckAtMs", 0L)
      .takeIf { it > 0L }
  }

  suspend fun persistPendingPushToken(pushToken: String) {
    securePreferences.edit()
      .putString("binding.pendingPushToken", pushToken)
      .apply()
  }

  suspend fun clearRegisteredPushTokenState() {
    securePreferences.edit()
      .remove("binding.registeredPushToken")
      .remove("binding.registeredPushTokenAckAtMs")
      .apply()
  }

  suspend fun clearBindingState(clearPendingPushToken: Boolean = false) {
    val editor = securePreferences.edit()
      .remove("binding.widgetToken")
      .remove("binding.bindingGeneration")
      .remove("binding.expiresAt")
      .remove("binding.registeredPushToken")
      .remove("binding.registeredPushTokenAckAtMs")

    if (clearPendingPushToken) {
      editor.remove("binding.pendingPushToken")
    }

    editor.apply()
  }

  suspend fun clearWidgetState(appWidgetId: Int) {
    context.widgetDataStore.edit { prefs ->
      prefs.remove(instanceIdKey(appWidgetId))
      prefs.remove(sizeBucketKey(appWidgetId))
      prefs.remove(gatePageIndexKey(appWidgetId))
      prefs.remove(gateSelectedEntryIdKey(appWidgetId))
      prefs.remove(selectedTaskIndexKey(appWidgetId))
      prefs.remove(focusWaitMenuOpenKey(appWidgetId))
      prefs.remove(pendingFocusActiveHintKey(appWidgetId))
      prefs.remove(pendingFocusActiveHintIssuedAtKey(appWidgetId))
      prefs.remove(pendingFocusMutationActionKey(appWidgetId))
      prefs.remove(pendingFocusMutationIssuedAtKey(appWidgetId))
      prefs.remove(summaryJsonKey(appWidgetId))
      prefs.remove(summaryCacheFormatVersionKey(appWidgetId))
      prefs.remove(summaryUpdatedAtKey(appWidgetId))
      prefs.remove(stringPreferencesKey(pendingBootstrapNonceKey(appWidgetId)))
      prefs.remove(longPreferencesKey(pendingBootstrapIssuedAtKey(appWidgetId)))
      prefs.remove(stringPreferencesKey(pendingBootstrapPushTokenKey(appWidgetId)))
      prefs.remove(lastAppliedLayoutSignatureKey(appWidgetId))
    }
  }

  suspend fun clearWidgetBindingContext(appWidgetId: Int) {
    context.widgetDataStore.edit { prefs ->
      prefs.remove(instanceIdKey(appWidgetId))
      prefs.remove(summaryJsonKey(appWidgetId))
      prefs.remove(summaryCacheFormatVersionKey(appWidgetId))
      prefs.remove(summaryUpdatedAtKey(appWidgetId))
      prefs.remove(pendingFocusActiveHintKey(appWidgetId))
      prefs.remove(pendingFocusActiveHintIssuedAtKey(appWidgetId))
      prefs.remove(pendingFocusMutationActionKey(appWidgetId))
      prefs.remove(pendingFocusMutationIssuedAtKey(appWidgetId))
      prefs.remove(stringPreferencesKey(pendingBootstrapNonceKey(appWidgetId)))
      prefs.remove(longPreferencesKey(pendingBootstrapIssuedAtKey(appWidgetId)))
      prefs.remove(stringPreferencesKey(pendingBootstrapPushTokenKey(appWidgetId)))
    }
  }

  suspend fun clearAllWidgetState(clearPendingPushToken: Boolean = false) {
    clearBindingState(clearPendingPushToken = clearPendingPushToken)
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

  suspend fun saveSummary(appWidgetId: Int, summary: WidgetSummaryResponse) {
    val sanitized = if (isPrivacyModeEnabled()) stripSensitiveFields(summary) else summary
    context.widgetDataStore.edit { prefs ->
      prefs[summaryJsonKey(appWidgetId)] = json.encodeToString(WidgetSummaryResponse.serializer(), sanitized)
      prefs[summaryCacheFormatVersionKey(appWidgetId)] = summaryCacheFormatVersion
      prefs[summaryUpdatedAtKey(appWidgetId)] = System.currentTimeMillis()
    }
  }

  /** 上次成功 fetch 的本地 wall-clock 时间（millis）；用于 sync_badge 显示「刚刚 / N 分前」。 */
  suspend fun readSummaryUpdatedAt(appWidgetId: Int): Long? {
    val snapshot = context.widgetDataStore.data.first()
    return snapshot[summaryUpdatedAtKey(appWidgetId)]
  }

  suspend fun readSummary(appWidgetId: Int): WidgetSummaryResponse? {
    val snapshot = context.widgetDataStore.data.first()
    if (snapshot[summaryCacheFormatVersionKey(appWidgetId)] != summaryCacheFormatVersion) {
      if (snapshot[summaryJsonKey(appWidgetId)] != null) {
        migratePrivacyModeDefault(appWidgetId, clearLegacySummary = true)
      } else if (snapshot[privacyModeKey] == null) {
        migratePrivacyModeDefault(appWidgetId, clearLegacySummary = false)
      }
      return null
    }

    val raw = snapshot[summaryJsonKey(appWidgetId)] ?: return null
    if (snapshot[privacyModeKey] == null) {
      migratePrivacyModeDefault(appWidgetId, clearLegacySummary = false)
    }

    return runCatching {
      json.decodeFromString(WidgetSummaryResponse.serializer(), raw)
    }.getOrNull()
  }

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

  /**
   * 隐私模式下本地缓存只保存最小摘要字段（P2-05）：
   * 擦除 Black Box 正文、任务正文、项目标题等敏感明文，只保留计数与状态
   */
  private fun stripSensitiveFields(summary: WidgetSummaryResponse): WidgetSummaryResponse {
    return summary.copy(
      focus = summary.focus.copy(
        title = null,
        projectTitle = null,
      ),
      blackBox = summary.blackBox.copy(
        previews = summary.blackBox.previews.map { preview ->
          preview.copy(
            content = null,
            projectTitle = null,
          )
        },
        gatePreview = summary.blackBox.gatePreview.copy(
          content = null,
          projectTitle = null,
        ),
      ),
      dock = summary.dock.copy(
        items = summary.dock.items.map { item ->
          item.copy(title = null, projectTitle = null)
        },
      ),
    )
  }

  private fun instanceIdKey(appWidgetId: Int): Preferences.Key<String> {
    return stringPreferencesKey("instance.$appWidgetId.id")
  }

  private fun sizeBucketKey(appWidgetId: Int): Preferences.Key<String> {
    return stringPreferencesKey("instance.$appWidgetId.sizeBucket")
  }

  private fun gatePageIndexKey(appWidgetId: Int): Preferences.Key<Int> {
    return intPreferencesKey("instance.$appWidgetId.gatePageIndex")
  }

  private fun selectedTaskIndexKey(appWidgetId: Int): Preferences.Key<Int> {
    return intPreferencesKey("instance.$appWidgetId.selectedTaskIndex")
  }

  private fun focusWaitMenuOpenKey(appWidgetId: Int): Preferences.Key<Boolean> {
    return booleanPreferencesKey("instance.$appWidgetId.focusWaitMenuOpen")
  }

  private fun pendingFocusActiveHintKey(appWidgetId: Int): Preferences.Key<Boolean> {
    return booleanPreferencesKey("instance.$appWidgetId.pendingFocusActiveHint")
  }

  private fun pendingFocusActiveHintIssuedAtKey(appWidgetId: Int): Preferences.Key<Long> {
    return longPreferencesKey("instance.$appWidgetId.pendingFocusActiveHintIssuedAtMs")
  }

  private fun pendingFocusMutationActionKey(appWidgetId: Int): Preferences.Key<String> {
    return stringPreferencesKey("instance.$appWidgetId.pendingFocusMutationAction")
  }

  private fun pendingFocusMutationIssuedAtKey(appWidgetId: Int): Preferences.Key<Long> {
    return longPreferencesKey("instance.$appWidgetId.pendingFocusMutationIssuedAtMs")
  }

  private fun gateSelectedEntryIdKey(appWidgetId: Int): Preferences.Key<String> {
    return stringPreferencesKey("instance.$appWidgetId.gateSelectedEntryId")
  }

  private fun lastAppliedLayoutSignatureKey(appWidgetId: Int): Preferences.Key<String> {
    return stringPreferencesKey("instance.$appWidgetId.lastAppliedLayoutSignature")
  }

  private fun summaryJsonKey(appWidgetId: Int): Preferences.Key<String> {
    return stringPreferencesKey("summary.$appWidgetId.json")
  }

  private fun summaryCacheFormatVersionKey(appWidgetId: Int): Preferences.Key<Int> {
    return intPreferencesKey("summary.$appWidgetId.cacheFormatVersion")
  }

  private fun summaryUpdatedAtKey(appWidgetId: Int): Preferences.Key<Long> {
    return longPreferencesKey("summary.$appWidgetId.updatedAt")
  }

  private val rateLimitBackoffUntilKey = longPreferencesKey("rateLimit.backoffUntilMs")

  private suspend fun migratePrivacyModeDefault(appWidgetId: Int, clearLegacySummary: Boolean) {
    context.widgetDataStore.edit { prefs ->
      if (clearLegacySummary) {
        prefs.remove(summaryJsonKey(appWidgetId))
        prefs.remove(summaryCacheFormatVersionKey(appWidgetId))
        prefs.remove(summaryUpdatedAtKey(appWidgetId))
      }

      if (prefs[privacyModeKey] == null) {
        prefs[privacyModeKey] = false
      }
    }
  }

  /** 记录 429 限流退避截止时间 */
  suspend fun persistRateLimitBackoff(retryAfterSeconds: Int) {
    val backoffUntilMs = System.currentTimeMillis() + retryAfterSeconds * 1000L
    context.widgetDataStore.edit { prefs ->
      prefs[rateLimitBackoffUntilKey] = backoffUntilMs
    }
  }

  /** 检查当前是否仍在限流退避期内 */
  suspend fun isRateLimitBackoffActive(): Boolean {
    val backoffUntilMs = context.widgetDataStore.data.first()[rateLimitBackoffUntilKey] ?: return false
    return System.currentTimeMillis() < backoffUntilMs
  }

  /** 清除限流退避状态 */
  suspend fun clearRateLimitBackoff() {
    context.widgetDataStore.edit { prefs ->
      prefs.remove(rateLimitBackoffUntilKey)
    }
  }

  private fun pendingBootstrapNonceKey(appWidgetId: Int): String {
    return "$pendingBootstrapNoncePrefix$appWidgetId"
  }

  private fun pendingBootstrapIssuedAtKey(appWidgetId: Int): String {
    return "$pendingBootstrapIssuedAtPrefix$appWidgetId"
  }

  private fun pendingBootstrapPushTokenKey(appWidgetId: Int): String {
    return "$pendingBootstrapPushTokenPrefix$appWidgetId"
  }

  private suspend fun migrateLegacySecureFields(snapshot: Preferences) {
    val secureEditor = securePreferences.edit()
    var secureChanged = false

    fun migrateString(legacyKey: Preferences.Key<String>, secureKey: String) {
      val legacyValue = snapshot[legacyKey]
      if (!legacyValue.isNullOrBlank() && securePreferences.getString(secureKey, null).isNullOrBlank()) {
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
    if (legacyBindingGeneration != null && securePreferences.getInt("binding.bindingGeneration", 0) == 0) {
      secureEditor.putInt("binding.bindingGeneration", legacyBindingGeneration)
      secureChanged = true
    }

    if (secureChanged) {
      secureEditor.apply()
    }

    if (
      snapshot[legacyDeviceIdKey] != null ||
      snapshot[legacyDeviceSecretKey] != null ||
      snapshot[legacyWidgetTokenKey] != null ||
      snapshot[legacyBindingGenerationKey] != null ||
      snapshot[legacyExpiresAtKey] != null ||
      snapshot[legacyPendingPushTokenKey] != null
    ) {
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
}
