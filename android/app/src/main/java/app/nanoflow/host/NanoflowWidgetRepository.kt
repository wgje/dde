package app.nanoflow.host

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.net.Uri
import com.google.firebase.messaging.FirebaseMessaging
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

class NanoflowWidgetRepository(private val context: Context) {
  private val clockFormatter = DateTimeFormatter.ofPattern("HH:mm")
  private val bootstrapTtlMs = 15 * 60 * 1000L
  private val registeredPushTokenRepairIntervalMs = 24 * 60 * 60 * 1000L
  private val pushTokenRepairDegradedReason = "push-token-missing"
  private val bootstrapRequiredCodes = setOf(
    "WIDGET_BOOTSTRAP_REQUIRED",
    "INSTANCE_CONTEXT_REQUIRED",
    "INSTANCE_CONTEXT_INVALID",
    "INSTANCE_NOT_ACTIVE",
    "INSTANCE_BINDING_MISMATCH",
  )
  private val transientContextPreservingCodes = setOf(
    "RATE_LIMITED",
    "WIDGET_REFRESH_DISABLED",
  )
  private val widgetContextResetCodes = setOf(
    "INSTANCE_CONTEXT_INVALID",
    "INSTANCE_NOT_ACTIVE",
    "INSTANCE_BINDING_MISMATCH",
  )
  private val bindingResetCodes = setOf(
    "DEVICE_NOT_FOUND",
    "DEVICE_REVOKED",
    "BINDING_MISMATCH",
    "TOKEN_EXPIRED",
    "TOKEN_INVALID",
  )
  private val json = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
  }
  private val store = NanoflowWidgetStore(context)

  suspend fun buildLaunchUri(
    appWidgetId: Int,
    preferredEntrySource: NanoFlowEntrySource,
    launchIntent: NanoFlowLaunchIntent,
  ): Uri {
    val bridgeContext = if (shouldBootstrap(appWidgetId)) {
      buildBridgeContext(appWidgetId)
    } else {
      null
    }
    val entrySource = if (bridgeContext != null) NanoFlowEntrySource.TWA else preferredEntrySource
    val contextualEntryUrl = store.readSummary(appWidgetId)?.entryUrl
    val contextualLaunchUri = resolveSummaryLaunchUri(contextualEntryUrl)

    if (bridgeContext == null && launchIntent == NanoFlowLaunchIntent.OPEN_WORKSPACE && contextualLaunchUri != null) {
      return contextualLaunchUri
    }

    if (bridgeContext != null) {
      NanoflowWidgetTelemetry.info(
        "widget_bootstrap_launch_ready",
        mapOf(
          "appWidgetId" to appWidgetId,
          "entrySource" to entrySource.queryValue,
          "launchIntent" to launchIntent.queryValue,
          "instanceId" to NanoflowWidgetTelemetry.redactId(bridgeContext.instanceId),
          "pendingPushToken" to !bridgeContext.pendingPushToken.isNullOrBlank(),
          "sizeBucket" to bridgeContext.sizeBucket,
        ),
      )
    }

    return NanoflowBootstrapContract.buildLaunchUri(
      entrySource = entrySource,
      launchIntent = launchIntent,
      bridgeContext = bridgeContext,
      routeUrl = contextualEntryUrl.takeIf { contextualLaunchUri != null },
    )
  }

  suspend fun buildBridgeContext(appWidgetId: Int): WidgetBridgeContext {
    val identity = store.ensureDeviceIdentity()
    val instanceId = store.ensureInstanceId(appWidgetId)
    val existingPendingBootstrap = store.readPendingBootstrap(appWidgetId)
    val pendingPushToken = store.readPendingPushToken()
    val bootstrapNonce = if (
      existingPendingBootstrap != null
      && System.currentTimeMillis() - existingPendingBootstrap.issuedAtMs <= bootstrapTtlMs
      && existingPendingBootstrap.requestedPushToken == pendingPushToken
    ) {
      NanoflowWidgetTelemetry.info(
        "widget_bootstrap_nonce_reused",
        mapOf(
          "appWidgetId" to appWidgetId,
          "instanceId" to NanoflowWidgetTelemetry.redactId(instanceId),
        ),
      )
      existingPendingBootstrap.nonce
    } else {
      store.issueBootstrapNonce(appWidgetId, pendingPushToken)
    }
    val sizeBucket = store.readSizeBucket(appWidgetId) ?: resolveSizeBucket(appWidgetId)
    if (existingPendingBootstrap == null || bootstrapNonce != existingPendingBootstrap.nonce) {
      NanoflowWidgetTelemetry.info(
        "widget_bootstrap_nonce_issued",
        mapOf(
          "appWidgetId" to appWidgetId,
          "instanceId" to NanoflowWidgetTelemetry.redactId(instanceId),
          "installationId" to NanoflowWidgetTelemetry.redactId(identity.installationId),
          "pendingPushToken" to !pendingPushToken.isNullOrBlank(),
          "sizeBucket" to sizeBucket,
        ),
      )
    }
    return WidgetBridgeContext(
      installationId = identity.installationId,
      deviceId = identity.deviceId,
      deviceSecret = identity.deviceSecret,
      clientVersion = BuildConfig.NANOFLOW_WIDGET_CLIENT_VERSION,
      instanceId = instanceId,
      hostInstanceId = appWidgetId.toString(),
      bootstrapNonce = bootstrapNonce,
      sizeBucket = sizeBucket,
      pendingPushToken = pendingPushToken,
    )
  }

  suspend fun consumeBootstrapUri(uri: Uri?): Boolean {
    val payload = NanoflowBootstrapContract.parseBootstrapPayload(uri)
    if (payload == null) {
      NanoflowWidgetTelemetry.warn(
        "widget_bootstrap_callback_rejected",
        mapOf("reason" to "invalid-payload"),
      )
      return false
    }

    val hostWidgetId = payload.hostInstanceId.toIntOrNull()
    if (hostWidgetId == null) {
      NanoflowWidgetTelemetry.warn(
        "widget_bootstrap_callback_rejected",
        mapOf(
          "reason" to "invalid-host-instance-id",
          "hostInstanceId" to payload.hostInstanceId,
        ),
      )
      return false
    }

    NanoflowWidgetTelemetry.info(
      "widget_bootstrap_callback_received",
      mapOf(
        "appWidgetId" to hostWidgetId,
        "bindingGeneration" to payload.bindingGeneration,
        "instanceId" to NanoflowWidgetTelemetry.redactId(payload.instanceId),
        "installationId" to NanoflowWidgetTelemetry.redactId(payload.installationId),
      ),
    )

    if (!NanoflowWidgetReceiver.hasInstalledWidgets(context, hostWidgetId)) {
      store.clearPendingBootstrap(hostWidgetId)
      NanoflowWidgetTelemetry.warn(
        "widget_bootstrap_callback_rejected",
        mapOf(
          "appWidgetId" to hostWidgetId,
          "reason" to "widget-not-installed",
        ),
      )
      return false
    }

    val pendingBootstrap = store.readPendingBootstrap(hostWidgetId)
    if (pendingBootstrap == null) {
      NanoflowWidgetTelemetry.warn(
        "widget_bootstrap_callback_rejected",
        mapOf(
          "appWidgetId" to hostWidgetId,
          "reason" to "pending-bootstrap-missing",
        ),
      )
      return false
    }

    if (System.currentTimeMillis() - pendingBootstrap.issuedAtMs > bootstrapTtlMs) {
      store.clearPendingBootstrap(hostWidgetId)
      NanoflowWidgetTelemetry.warn(
        "widget_bootstrap_callback_rejected",
        mapOf(
          "appWidgetId" to hostWidgetId,
          "reason" to "pending-bootstrap-expired",
        ),
      )
      return false
    }

    val identity = store.ensureDeviceIdentity()
    if (payload.installationId != identity.installationId) {
      NanoflowWidgetTelemetry.warn(
        "widget_bootstrap_callback_rejected",
        mapOf(
          "appWidgetId" to hostWidgetId,
          "reason" to "installation-mismatch",
        ),
      )
      return false
    }
    if (payload.deviceId != identity.deviceId) {
      NanoflowWidgetTelemetry.warn(
        "widget_bootstrap_callback_rejected",
        mapOf(
          "appWidgetId" to hostWidgetId,
          "reason" to "device-mismatch",
        ),
      )
      return false
    }
    if (payload.bootstrapNonce != pendingBootstrap.nonce) {
      NanoflowWidgetTelemetry.warn(
        "widget_bootstrap_callback_rejected",
        mapOf(
          "appWidgetId" to hostWidgetId,
          "reason" to "nonce-mismatch",
        ),
      )
      return false
    }

    val localInstanceId = store.readInstanceId(hostWidgetId)
    if (localInstanceId == null) {
      NanoflowWidgetTelemetry.warn(
        "widget_bootstrap_callback_rejected",
        mapOf(
          "appWidgetId" to hostWidgetId,
          "reason" to "instance-missing",
        ),
      )
      return false
    }
    if (payload.instanceId != localInstanceId) {
      NanoflowWidgetTelemetry.warn(
        "widget_bootstrap_callback_rejected",
        mapOf(
          "appWidgetId" to hostWidgetId,
          "reason" to "instance-mismatch",
          "instanceId" to NanoflowWidgetTelemetry.redactId(localInstanceId),
        ),
      )
      return false
    }

    store.applyBootstrapPayload(payload, pendingBootstrap.requestedPushToken)
    store.clearPendingBootstrap(hostWidgetId)
    NanoflowWidgetTelemetry.info(
      "widget_bootstrap_callback_accepted",
      mapOf(
        "appWidgetId" to hostWidgetId,
        "bindingGeneration" to payload.bindingGeneration,
        "expiresAt" to payload.expiresAt,
        "instanceId" to NanoflowWidgetTelemetry.redactId(localInstanceId),
      ),
    )
    return true
  }

  suspend fun rememberPushToken(pushToken: String) {
    val normalizedPushToken = pushToken.trim()
    if (normalizedPushToken.isBlank()) return
    if (store.readPendingPushToken()?.trim() == normalizedPushToken) {
      return
    }
    val registeredPushToken = store.readRegisteredPushToken()?.trim()
    val registeredPushTokenAckAtMs = store.readRegisteredPushTokenAckAtMs()
    val isRecentlyAcknowledged = registeredPushToken == normalizedPushToken
      && registeredPushTokenAckAtMs != null
      && System.currentTimeMillis() - registeredPushTokenAckAtMs < registeredPushTokenRepairIntervalMs
    if (isRecentlyAcknowledged) {
      return
    }

    store.persistPendingPushToken(normalizedPushToken)
  }

  private suspend fun repairMissingPushTokenState(
    appWidgetId: Int,
    summary: WidgetSummaryResponse,
  ) {
    if (!summary.degradedReasons.contains(pushTokenRepairDegradedReason)) {
      return
    }

    store.clearRegisteredPushTokenState()
    if (!BuildConfig.NANOFLOW_FCM_ENABLED) {
      NanoflowWidgetTelemetry.warn(
        "widget_push_token_repair_skipped",
        mapOf(
          "appWidgetId" to appWidgetId,
          "reason" to "fcm-disabled",
        ),
      )
      return
    }

    if (!store.readPendingPushToken().isNullOrBlank()) {
      NanoflowWidgetTelemetry.info(
        "widget_push_token_repair_already_pending",
        mapOf("appWidgetId" to appWidgetId),
      )
      return
    }

    try {
      val token = FirebaseMessaging.getInstance().token.await()
      if (token.isNullOrBlank()) {
        NanoflowWidgetTelemetry.warn(
          "widget_push_token_repair_skipped",
          mapOf(
            "appWidgetId" to appWidgetId,
            "reason" to "empty-token",
          ),
        )
        return
      }

      rememberPushToken(token)
      NanoflowWidgetTelemetry.info(
        "widget_push_token_repair_queued",
        mapOf(
          "appWidgetId" to appWidgetId,
          "tokenLength" to token.length,
        ),
      )
    } catch (error: Throwable) {
      NanoflowWidgetTelemetry.warn(
        "widget_push_token_repair_failed",
        mapOf(
          "appWidgetId" to appWidgetId,
          "errorClass" to (error::class.simpleName ?: "unknown"),
        ),
        error,
      )
    }
  }

  suspend fun refreshInstalledWidgets() {
    val appWidgetManager = AppWidgetManager.getInstance(context)
    val componentName = ComponentName(context, NanoflowWidgetReceiver::class.java)
    val appWidgetIds = appWidgetManager.getAppWidgetIds(componentName)

    for (appWidgetId in appWidgetIds) {
      refreshSummary(appWidgetId)
    }
  }

  suspend fun refreshSummary(appWidgetId: Int): WidgetSummaryResponse {
    val binding = store.readBinding()
    if (binding == null) {
      val fallback = WidgetSummaryResponse(
        trustState = "auth-required",
        error = "Widget 尚未完成 bootstrap",
        code = "WIDGET_BOOTSTRAP_REQUIRED",
        degradedReasons = listOf("bootstrap-required"),
      )
      store.saveSummary(appWidgetId, fallback)
      NanoflowWidgetTelemetry.warn(
        "widget_summary_fetch_failure",
        mapOf(
          "appWidgetId" to appWidgetId,
          "code" to fallback.code,
          "reason" to "binding-missing",
          "trustState" to fallback.trustState,
        ),
      )
      return fallback
    }

    // DRILL-04: 限流退避——若仍在退避期内，直接返回缓存
    if (store.isRateLimitBackoffActive()) {
      val cachedSummary = store.readSummary(appWidgetId)
      if (cachedSummary != null) {
        NanoflowWidgetTelemetry.warn(
          "widget_summary_fetch_failure",
          mapOf(
            "appWidgetId" to appWidgetId,
            "code" to cachedSummary.code,
            "reason" to "rate-limit-backoff-active",
            "sourceState" to cachedSummary.sourceState,
            "trustState" to cachedSummary.trustState,
          ),
        )
        return cachedSummary
      }
    }

    val instanceId = store.ensureInstanceId(appWidgetId)
    val lastKnownVersion = store.readSummary(appWidgetId)?.summaryVersion
    val requestBody = buildSummaryRequestBody(lastKnownVersion, instanceId, appWidgetId.toString())
    val cachedSummary = store.readSummary(appWidgetId)

    NanoflowWidgetTelemetry.info(
      "widget_summary_fetch_started",
      mapOf(
        "appWidgetId" to appWidgetId,
        "hasCachedSummary" to (cachedSummary != null),
        "instanceId" to NanoflowWidgetTelemetry.redactId(instanceId),
        "lastKnownSummaryVersion" to !lastKnownVersion.isNullOrBlank(),
      ),
    )

    val response = runCatching {
      postJson(
        url = "${resolveWidgetSupabaseUrl()}/functions/v1/widget-summary",
        bearerToken = binding.widgetToken,
        body = requestBody,
      )
    }.getOrElse { error ->
      val fallback = buildTransportFallback(cachedSummary, error)
      store.saveSummary(appWidgetId, fallback)
      NanoflowWidgetTelemetry.warn(
        "widget_summary_fetch_failure",
        mapOf(
          "appWidgetId" to appWidgetId,
          "code" to fallback.code,
          "hasCachedSummary" to (cachedSummary != null),
          "instanceId" to NanoflowWidgetTelemetry.redactId(instanceId),
          "reason" to "transport-failed",
          "sourceState" to fallback.sourceState,
          "trustState" to fallback.trustState,
        ),
        error,
      )
      return fallback
    }

    val summary = runCatching {
      json.decodeFromString(WidgetSummaryResponse.serializer(), response.body)
    }.getOrElse { error ->
      NanoflowWidgetTelemetry.warn(
        "widget_summary_fetch_failure",
        mapOf(
          "appWidgetId" to appWidgetId,
          "instanceId" to NanoflowWidgetTelemetry.redactId(instanceId),
          "reason" to "summary-parse-failed",
          "statusCode" to response.statusCode,
        ),
        error,
      )
      WidgetSummaryResponse(
        trustState = "untrusted",
        error = "无法解析 widget-summary 响应",
        code = "WIDGET_SUMMARY_INVALID",
        degradedReasons = listOf("summary-parse-failed"),
      )
    }
    val normalizedSummary = preserveCachedContextForTransientSummary(summary, cachedSummary)
    val shouldResetWidgetContext = normalizedSummary.code in widgetContextResetCodes

    if (shouldResetWidgetContext) {
      store.clearWidgetBindingContext(appWidgetId)
    }

    if (normalizedSummary.code in bindingResetCodes) {
      store.clearBindingState()
      NanoflowWidgetTelemetry.warn(
        "widget_token_revoked",
        mapOf(
          "appWidgetId" to appWidgetId,
          "code" to normalizedSummary.code,
          "instanceId" to NanoflowWidgetTelemetry.redactId(instanceId),
        ),
      )
    }

    // DRILL-04: 收到 RATE_LIMITED 时记录退避时长
    // DRILL-07: WIDGET_REFRESH_DISABLED 也触发退避（30 分钟），避免反复 503
    val retryAfter = normalizedSummary.retryAfterSeconds
    if (normalizedSummary.code == "RATE_LIMITED" && retryAfter != null && retryAfter > 0) {
      store.persistRateLimitBackoff(retryAfter)
      NanoflowWidgetTelemetry.warn(
        "widget_summary_backoff_applied",
        mapOf(
          "appWidgetId" to appWidgetId,
          "code" to normalizedSummary.code,
          "retryAfterSeconds" to retryAfter,
        ),
      )
    } else if (normalizedSummary.code == "WIDGET_REFRESH_DISABLED") {
      store.persistRateLimitBackoff(30 * 60)
      NanoflowWidgetTelemetry.warn(
        "widget_killswitch_applied",
        mapOf(
          "appWidgetId" to appWidgetId,
          "code" to normalizedSummary.code,
          "reason" to "widget-refresh-disabled",
          "instanceId" to NanoflowWidgetTelemetry.redactId(instanceId),
        ),
      )
      NanoflowWidgetTelemetry.warn(
        "widget_summary_backoff_applied",
        mapOf(
          "appWidgetId" to appWidgetId,
          "code" to normalizedSummary.code,
          "retryAfterSeconds" to 30 * 60,
        ),
      )
    } else if (normalizedSummary.code !in transientContextPreservingCodes) {
      store.clearRateLimitBackoff()
    }

    repairMissingPushTokenState(appWidgetId, normalizedSummary)

    store.saveSummary(appWidgetId, normalizedSummary)

    val summaryTelemetryFields = mapOf(
      "appWidgetId" to appWidgetId,
      "code" to normalizedSummary.code,
      "dockCount" to normalizedSummary.dock.count,
      "focusActive" to normalizedSummary.focus.active,
      "freshnessState" to normalizedSummary.freshnessState,
      "instanceId" to NanoflowWidgetTelemetry.redactId(instanceId),
      "pendingBlackBoxCount" to normalizedSummary.blackBox.pendingCount,
      "sourceState" to normalizedSummary.sourceState,
      "statusCode" to response.statusCode,
      "trustState" to normalizedSummary.trustState,
    )

    if (response.statusCode >= 400) {
      NanoflowWidgetTelemetry.warn(
        "widget_summary_fetch_failure",
        summaryTelemetryFields + mapOf("reason" to "server-response"),
      )
    } else {
      NanoflowWidgetTelemetry.info(
        "widget_summary_fetch_success",
        summaryTelemetryFields,
      )
    }

    if (normalizedSummary.freshnessState == "stale") {
      NanoflowWidgetTelemetry.warn(
        "widget_stale_render",
        mapOf(
          "appWidgetId" to appWidgetId,
          "code" to normalizedSummary.code,
          "sourceState" to normalizedSummary.sourceState,
          "trustState" to normalizedSummary.trustState,
        ),
      )
    }

    if (normalizedSummary.trustState == "untrusted") {
      NanoflowWidgetTelemetry.warn(
        "widget_untrusted_render",
        mapOf(
          "appWidgetId" to appWidgetId,
          "code" to normalizedSummary.code,
          "degradedReasons" to normalizedSummary.degradedReasons,
          "sourceState" to normalizedSummary.sourceState,
        ),
      )
    }

    return normalizedSummary
  }

  suspend fun buildRenderModel(appWidgetId: Int): WidgetRenderModel {
    val sizeBucket = store.readSizeBucket(appWidgetId) ?: resolveSizeBucket(appWidgetId)
    val sizeTier = when (sizeBucket) {
      "4x3" -> WidgetSizeTier.LARGE
      "4x2" -> WidgetSizeTier.MEDIUM
      else -> WidgetSizeTier.SMALL
    }
    // 兼容旧字段：仅 SMALL 视为 compact，避免大尺寸误用紧凑布局
    val compact = sizeTier == WidgetSizeTier.SMALL
    val binding = store.readBinding()
    val summary = store.readSummary(appWidgetId)
    if (summary == null) {
      return if (binding != null && !isBindingExpired(binding)) {
        buildStateRenderModel(
          title = context.getString(R.string.nanoflow_widget_sync_ready_title),
          supportingLine = context.getString(R.string.nanoflow_widget_sync_ready_detail),
          statusLine = context.getString(R.string.nanoflow_widget_syncing),
          compact = compact,
          sizeTier = sizeTier,
          tone = WidgetVisualTone.FOCUS,
          statusBadge = context.getString(R.string.nanoflow_widget_badge_syncing),
        )
      } else {
        buildStateRenderModel(
          title = context.getString(R.string.nanoflow_widget_setup_title),
          supportingLine = context.getString(R.string.nanoflow_widget_setup_detail),
          statusLine = context.getString(R.string.nanoflow_widget_setup_required),
          compact = compact,
          sizeTier = sizeTier,
          tone = WidgetVisualTone.SETUP,
          statusBadge = context.getString(R.string.nanoflow_widget_badge_setup),
          showSetup = true,
        )
      }
    }

    val showAuthRequired = summary.trustState == "auth-required"
    val showSetup = summary.code in bootstrapRequiredCodes
    val showUntrusted = summary.trustState == "untrusted"

    if (showSetup) {
      return buildStateRenderModel(
        title = context.getString(R.string.nanoflow_widget_setup_title),
        supportingLine = buildSetupSupportingLine(summary.code),
        statusLine = buildSetupStatusLine(summary),
        compact = compact,
        sizeTier = sizeTier,
        tone = WidgetVisualTone.SETUP,
        statusBadge = context.getString(R.string.nanoflow_widget_badge_setup),
        showSetup = true,
      )
    }

    if (showAuthRequired) {
      return buildStateRenderModel(
        title = context.getString(R.string.nanoflow_widget_auth_required),
        supportingLine = context.getString(R.string.nanoflow_widget_auth_detail),
        statusLine = buildStatusLine(summary),
        compact = compact,
        sizeTier = sizeTier,
        tone = WidgetVisualTone.AUTH,
        statusBadge = context.getString(R.string.nanoflow_widget_badge_auth),
        showAuthRequired = true,
      )
    }

    if (summary.code == "WIDGET_REFRESH_DISABLED") {
      return buildStateRenderModel(
        title = context.getString(R.string.nanoflow_widget_refresh_disabled_title),
        supportingLine = context.getString(R.string.nanoflow_widget_refresh_disabled_detail),
        statusLine = buildStatusLine(summary),
        compact = compact,
        sizeTier = sizeTier,
        tone = WidgetVisualTone.UNTRUSTED,
        statusBadge = context.getString(R.string.nanoflow_widget_badge_paused),
      )
    }

    if (showUntrusted) {
      return buildStateRenderModel(
        title = context.getString(R.string.nanoflow_widget_untrusted_title),
        supportingLine = context.getString(R.string.nanoflow_widget_untrusted_detail),
        statusLine = buildStatusLine(summary),
        compact = compact,
        sizeTier = sizeTier,
        tone = WidgetVisualTone.UNTRUSTED,
        statusBadge = context.getString(R.string.nanoflow_widget_badge_untrusted),
        showUntrusted = true,
      )
    }

    val statusLine = buildStatusLine(summary)
    val statusBadge = buildStatusBadge(summary)
    val privacyMode = store.isPrivacyModeEnabled()
    val gateEntries = resolveRenderableGateEntries(summary, privacyMode)
    val hasFocusState = summary.focus.active == true && summary.focus.valid
    val showCounts = summary.dock.count > 0 || summary.blackBox.pendingCount > 0
    val isGateMode = !hasFocusState && (gateEntries.isNotEmpty() || summary.blackBox.pendingCount > 0)
    val metricsLine = buildMetricsLine(summary)

    if (isGateMode) {
      val gateContentCards = buildGateContentCards(summary, gateEntries, privacyMode)
      val primaryGateCard = gateContentCards.firstOrNull()
      return WidgetRenderModel(
        modeLabel = context.getString(R.string.nanoflow_widget_gate_label),
        statusBadge = statusBadge,
        title = primaryGateCard?.title ?: context.getString(R.string.nanoflow_widget_gate_pending_detail),
        supportingLine = primaryGateCard?.subtitle,
        metricsLine = if (showCounts) metricsLine else null,
        statusLine = statusLine,
        primaryActionLabel = context.getString(R.string.nanoflow_widget_open_gate),
        primaryAction = WidgetPrimaryAction.OPEN_FOCUS_TOOLS,
        tone = WidgetVisualTone.GATE,
        dockCount = summary.dock.count,
        blackBoxCount = summary.blackBox.pendingCount,
        showStatCards = false,
        isGateMode = true,
        showGatePager = false,
        gatePageIndicator = null,
        canPageBackward = false,
        canPageForward = false,
        compact = compact,
        sizeTier = sizeTier,
        showSetup = false,
        showAuthRequired = false,
        showUntrusted = false,
        contentCards = gateContentCards,
        syncBadgeLabel = buildCompactSyncBadge(summary, appWidgetId),
      )
    }

    val focusTitle = summary.focus.title?.takeIf { summary.focus.valid }
    val canOpenFocusTask = hasFocusState && summary.focus.valid

    // 构建主任务 + 副任务卡片列表，主任务始终置顶；privacy 模式下隐藏标题细节。
    val taskCards = buildTaskCards(summary, hasFocusState, privacyMode, focusTitle, canOpenFocusTask)
    val selectedTaskIndex = if (taskCards.isEmpty()) 0
    else store.readSelectedTaskIndex(appWidgetId).coerceIn(0, taskCards.lastIndex)
    val selectedCard = taskCards.getOrNull(selectedTaskIndex)
    val syncBadgeLabel = buildCompactSyncBadge(summary, appWidgetId)
    val contentCards = buildTaskContentCards(taskCards).ifEmpty {
      listOf(
        WidgetContentCard(
          eyebrow = context.getString(
            if (hasFocusState) R.string.nanoflow_widget_focus_label
            else R.string.nanoflow_widget_gate_label,
          ),
          title = when {
            selectedCard != null -> selectedCard.title
            hasFocusState && privacyMode -> context.getString(R.string.nanoflow_widget_privacy_focus_title)
            hasFocusState && !focusTitle.isNullOrBlank() -> focusTitle
            hasFocusState && canOpenFocusTask -> context.getString(R.string.nanoflow_widget_focus_ready_title)
            hasFocusState -> context.getString(R.string.nanoflow_widget_unknown_task)
            else -> context.getString(R.string.nanoflow_widget_gate_empty_title)
          },
          subtitle = when {
            selectedCard != null && !privacyMode -> selectedCard.projectTitle
            hasFocusState && (privacyMode || compact) -> null
            hasFocusState -> buildFocusSupportingLine(summary)
            else -> context.getString(R.string.nanoflow_widget_gate_empty_detail)
          },
        )
      )
    }

    return WidgetRenderModel(
      modeLabel = context.getString(
        if (hasFocusState) R.string.nanoflow_widget_focus_label
        else R.string.nanoflow_widget_gate_label,
      ),
      statusBadge = statusBadge,
      title = when {
        selectedCard != null -> selectedCard.title
        hasFocusState && privacyMode -> context.getString(R.string.nanoflow_widget_privacy_focus_title)
        hasFocusState && !focusTitle.isNullOrBlank() -> focusTitle
        hasFocusState && canOpenFocusTask -> context.getString(R.string.nanoflow_widget_focus_ready_title)
        hasFocusState -> context.getString(R.string.nanoflow_widget_unknown_task)
        else -> context.getString(R.string.nanoflow_widget_gate_empty_title)
      },
      supportingLine = when {
        selectedCard != null && !privacyMode -> selectedCard.projectTitle
        hasFocusState && (privacyMode || compact) -> null
        hasFocusState -> buildFocusSupportingLine(summary)
        else -> context.getString(R.string.nanoflow_widget_gate_empty_detail)
      },
      metricsLine = if (showCounts) metricsLine else null,
      statusLine = statusLine,
      primaryActionLabel = context.getString(
        if (canOpenFocusTask) R.string.nanoflow_widget_open_task else R.string.nanoflow_widget_open_app,
      ),
      primaryAction = WidgetPrimaryAction.OPEN_WORKSPACE,
      tone = WidgetVisualTone.FOCUS,
      dockCount = summary.dock.count,
      blackBoxCount = summary.blackBox.pendingCount,
      showStatCards = false,
      isGateMode = !hasFocusState,
      showGatePager = false,
      gatePageIndicator = null,
      canPageBackward = false,
      canPageForward = false,
      compact = compact,
      sizeTier = sizeTier,
      showSetup = false,
      showAuthRequired = false,
      showUntrusted = false,
      tasks = taskCards,
      selectedTaskIndex = selectedTaskIndex,
      contentCards = contentCards,
      syncBadgeLabel = syncBadgeLabel,
    )
  }

  /**
   * 聚合主任务（来自 focus.*）与副任务（来自 dock.items），主任务始终在索引 0。
   * 隐私模式下标题用占位符避免信息泄露。
   */
  private fun buildTaskCards(
    summary: WidgetSummaryResponse,
    hasFocusState: Boolean,
    privacyMode: Boolean,
    focusTitle: String?,
    canOpenFocusTask: Boolean,
  ): List<WidgetTaskCard> {
    if (!hasFocusState) return emptyList()
    val cards = mutableListOf<WidgetTaskCard>()
    val mainTitle = when {
      privacyMode -> context.getString(R.string.nanoflow_widget_privacy_focus_title)
      !focusTitle.isNullOrBlank() -> focusTitle
      canOpenFocusTask -> context.getString(R.string.nanoflow_widget_focus_ready_title)
      else -> context.getString(R.string.nanoflow_widget_unknown_task)
    }
    cards.add(
      WidgetTaskCard(
        taskId = summary.focus.taskId,
        title = mainTitle,
        projectTitle = if (privacyMode) null else summary.focus.projectTitle,
        isMain = true,
      )
    )
    val mainTaskId = summary.focus.taskId
    summary.dock.items.forEach { item ->
      // 之前用 `if (!item.valid) return@forEach` 强过滤会导致后端因任务行未在 taskMap 命中
      // （RLS/子查询时序）返回 valid=false 的有效 dock 任务被全部隐藏，用户实际上有 6 个备选
      // 任务却只看到「主」一个 chip。这里改为：只要 taskId 非空且有标题就纳入展示，valid=false
      // 仅作为后端可能存在数据漂移的弱信号，不应阻断 UI。
      val itemTaskId = item.taskId
      if (itemTaskId.isNullOrBlank()) return@forEach
      if (mainTaskId != null && itemTaskId == mainTaskId) return@forEach
      cards.add(
        WidgetTaskCard(
          taskId = itemTaskId,
          title = if (privacyMode) context.getString(R.string.nanoflow_widget_privacy_focus_title)
          else item.title?.takeIf { it.isNotBlank() } ?: context.getString(R.string.nanoflow_widget_unknown_task),
          projectTitle = if (privacyMode) null else item.projectTitle,
          isMain = false,
        )
      )
    }
    return cards
  }

  private fun buildTaskContentCards(taskCards: List<WidgetTaskCard>): List<WidgetContentCard> {
    return taskCards.mapIndexed { index, card ->
      WidgetContentCard(
        eyebrow = if (card.isMain) {
          context.getString(R.string.nanoflow_widget_content_main_task)
        } else {
          context.getString(R.string.nanoflow_widget_content_secondary_task, index)
        },
        title = card.title,
        subtitle = card.projectTitle,
      )
    }
  }

  private fun buildGateContentCards(
    summary: WidgetSummaryResponse,
    gateEntries: List<WidgetGatePreview>,
    privacyMode: Boolean,
  ): List<WidgetContentCard> {
    if (gateEntries.isEmpty()) {
      return listOf(
        WidgetContentCard(
          eyebrow = context.getString(R.string.nanoflow_widget_gate_label),
          title = if (summary.blackBox.pendingCount > 0) {
            context.getString(R.string.nanoflow_widget_gate_pending_detail)
          } else {
            context.getString(R.string.nanoflow_widget_gate_empty_title)
          },
          subtitle = if (summary.blackBox.pendingCount > 0) {
            context.getString(R.string.nanoflow_widget_content_pending_count, summary.blackBox.pendingCount)
          } else {
            context.getString(R.string.nanoflow_widget_gate_empty_detail)
          },
        )
      )
    }

    return gateEntries.mapIndexed { index, preview ->
      WidgetContentCard(
        eyebrow = context.getString(
          R.string.nanoflow_widget_content_gate_position,
          index + 1,
          gateEntries.size,
        ),
        title = if (privacyMode) {
          context.getString(R.string.nanoflow_widget_privacy_gate_title, summary.blackBox.pendingCount)
        } else {
          preview.content?.trim()?.takeIf { it.isNotBlank() }
            ?: context.getString(R.string.nanoflow_widget_gate_pending_detail)
        },
        subtitle = if (privacyMode) {
          preview.projectTitle?.takeIf { it.isNotBlank() }
        } else {
          buildGateSupportingLine(preview)
        },
      )
    }
  }

  /** 紧凑版同步徽章：「刚刚」「N 分前」「较旧」。 */
  private suspend fun buildCompactSyncBadge(summary: WidgetSummaryResponse, appWidgetId: Int): String? {
    // 优先使用本地 wall-clock fetch 时间：这样即便服务端数据未变（cloudUpdatedAt 不变），
    // 用户点了刷新仍然能看到时间归零为「刚刚」，符合"刷新生效"的直觉。
    val localFetchedAtMs = runCatching { store.readSummaryUpdatedAt(appWidgetId) }.getOrNull()
    val instant = if (localFetchedAtMs != null && localFetchedAtMs > 0L) {
      Instant.ofEpochMilli(localFetchedAtMs)
    } else {
      val cloudUpdatedAt = summary.cloudUpdatedAt?.takeIf { it.isNotBlank() } ?: return null
      runCatching { Instant.parse(cloudUpdatedAt) }.getOrNull() ?: return null
    }
    val minutes = Duration.between(instant, Instant.now()).toMinutes().coerceAtLeast(0)
    return when {
      minutes <= 1 -> "刚刚"
      minutes < 60 -> "${minutes} 分前"
      minutes < 1440 -> "${minutes / 60} 小时前"
      else -> "较旧"
    }
  }

  private suspend fun resolveSizeBucket(appWidgetId: Int): String {
    val options = AppWidgetManager.getInstance(context).getAppWidgetOptions(appWidgetId)
    val minWidth = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 0)
    val minHeight = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 0)
    // 与 NanoflowWidgetReceiver.resolveSizeBucket 保持一致的三档判定
    val sizeBucket = when {
      minHeight >= 200 -> "4x3"
      minWidth >= 220 || minHeight >= 120 -> "4x2"
      else -> "2x2"
    }
    store.persistSizeBucket(appWidgetId, sizeBucket)
    return sizeBucket
  }

  private fun buildStateRenderModel(
    title: String,
    supportingLine: String?,
    statusLine: String,
    compact: Boolean,
    sizeTier: WidgetSizeTier,
    tone: WidgetVisualTone,
    statusBadge: String,
    showSetup: Boolean = false,
    showAuthRequired: Boolean = false,
    showUntrusted: Boolean = false,
  ): WidgetRenderModel {
    return WidgetRenderModel(
      modeLabel = context.getString(R.string.nanoflow_widget_label),
      statusBadge = statusBadge,
      title = title,
      supportingLine = supportingLine,
      metricsLine = null,
      statusLine = statusLine,
      primaryActionLabel = context.getString(R.string.nanoflow_widget_open_app),
      primaryAction = WidgetPrimaryAction.OPEN_WORKSPACE,
      tone = tone,
      dockCount = 0,
      blackBoxCount = 0,
      showStatCards = false,
      isGateMode = false,
      showGatePager = false,
      gatePageIndicator = null,
      canPageBackward = false,
      canPageForward = false,
      compact = compact,
      sizeTier = sizeTier,
      showSetup = showSetup,
      showAuthRequired = showAuthRequired,
      showUntrusted = showUntrusted,
      contentCards = listOf(
        WidgetContentCard(
          eyebrow = context.getString(R.string.nanoflow_widget_label),
          title = title,
          subtitle = supportingLine ?: statusLine.takeIf { it != title },
        )
      ),
    )
  }

  suspend fun shiftGatePage(appWidgetId: Int, delta: Int): Int? {
    val summary = store.readSummary(appWidgetId) ?: return null
    if (summary.focus.active == true) {
      store.persistGatePageIndex(appWidgetId, 0)
      store.persistGateSelectedEntryId(appWidgetId, null)
      return 0
    }

    val privacyMode = store.isPrivacyModeEnabled()
    val gateEntries = resolveRenderableGateEntries(summary, privacyMode)
    if (gateEntries.size <= 1) {
      store.persistGatePageIndex(appWidgetId, 0)
      store.persistGateSelectedEntryId(appWidgetId, gateEntries.firstOrNull()?.entryId)
      return 0
    }

    val currentIndex = resolveGatePageIndex(appWidgetId, gateEntries)
    val nextIndex = (currentIndex + delta).coerceIn(0, gateEntries.lastIndex)
    if (nextIndex != currentIndex) {
      store.persistGatePageIndex(appWidgetId, nextIndex)
      store.persistGateSelectedEntryId(appWidgetId, gateEntries[nextIndex].entryId)
    }
    return nextIndex
  }

  private fun buildSetupSupportingLine(code: String?): String {
    return when (code) {
      "INSTANCE_CONTEXT_REQUIRED", "INSTANCE_CONTEXT_INVALID" -> context.getString(R.string.nanoflow_widget_setup_context_fixing)
      "INSTANCE_NOT_ACTIVE", "INSTANCE_BINDING_MISMATCH" -> context.getString(R.string.nanoflow_widget_setup_instance_changed)
      else -> context.getString(R.string.nanoflow_widget_setup_detail)
    }
  }

  private fun buildSetupStatusLine(summary: WidgetSummaryResponse): String {
    return when (summary.code) {
      "INSTANCE_CONTEXT_REQUIRED", "INSTANCE_CONTEXT_INVALID" -> context.getString(R.string.nanoflow_widget_syncing)
      "INSTANCE_NOT_ACTIVE", "INSTANCE_BINDING_MISMATCH" -> context.getString(R.string.nanoflow_widget_target_changed)
      else -> context.getString(R.string.nanoflow_widget_setup_required)
    }
  }

  private fun buildStatusBadge(summary: WidgetSummaryResponse): String {
    return when {
      summary.code == "WIDGET_REFRESH_DISABLED" -> context.getString(R.string.nanoflow_widget_badge_paused)
      summary.sourceState == "cloud-pending-local-hint" -> context.getString(R.string.nanoflow_widget_badge_syncing)
      summary.sourceState == "cache-only" -> context.getString(R.string.nanoflow_widget_badge_cached)
      summary.freshnessState == "stale" || summary.freshnessState == "aging" -> context.getString(R.string.nanoflow_widget_badge_stale)
      else -> context.getString(R.string.nanoflow_widget_badge_ready)
    }
  }

  private fun buildFocusSupportingLine(summary: WidgetSummaryResponse): String? {
    val parts = mutableListOf<String>()

    summary.focus.projectTitle
      ?.takeIf { it.isNotBlank() }
      ?.let(parts::add)

    summary.focus.remainingMinutes
      ?.takeIf { summary.focus.valid }
      ?.let { parts.add(context.getString(R.string.nanoflow_widget_minutes_estimate, it)) }

    return parts.takeIf { it.isNotEmpty() }?.joinToString("  ·  ")
  }

  private fun buildGateSupportingLine(preview: WidgetGatePreview): String {
    val parts = mutableListOf<String>()

    preview.projectTitle
      ?.takeIf { it.isNotBlank() }
      ?.let(parts::add)

    buildPreviewTimeLabel(preview.createdAt)?.let(parts::add)

    return parts.takeIf { it.isNotEmpty() }?.joinToString("  ·  ")
      ?: context.getString(R.string.nanoflow_widget_gate_pending_detail)
  }

  private fun buildMetricsLine(summary: WidgetSummaryResponse): String {
    return context.getString(
      R.string.nanoflow_widget_counts,
      summary.dock.count,
      summary.blackBox.pendingCount,
    )
  }

  private fun resolveRenderableGateEntries(
    summary: WidgetSummaryResponse,
    privacyMode: Boolean,
  ): List<WidgetGatePreview> {
    val entries = mutableListOf<WidgetGatePreview>()

    fun appendIfRenderable(preview: WidgetGatePreview) {
      if (!preview.valid) {
        return
      }

      if (!privacyMode && preview.content.isNullOrBlank()) {
        return
      }

      if (entries.none { existing -> isSameGatePreview(existing, preview) }) {
        entries.add(preview)
      }
    }

    summary.blackBox.previews.forEach(::appendIfRenderable)
    appendIfRenderable(summary.blackBox.gatePreview)
    return entries
  }

  private fun isSameGatePreview(left: WidgetGatePreview, right: WidgetGatePreview): Boolean {
    val leftEntryId = left.entryId?.takeIf { it.isNotBlank() }
    val rightEntryId = right.entryId?.takeIf { it.isNotBlank() }
    if (leftEntryId != null && rightEntryId != null) {
      return leftEntryId == rightEntryId
    }

    return left.content == right.content
      && left.createdAt == right.createdAt
      && left.projectId == right.projectId
  }

  private suspend fun resolveGatePageIndex(appWidgetId: Int, entries: List<WidgetGatePreview>): Int {
    if (entries.isEmpty()) {
      store.persistGatePageIndex(appWidgetId, 0)
      store.persistGateSelectedEntryId(appWidgetId, null)
      return 0
    }

    val selectedEntryId = store.readGateSelectedEntryId(appWidgetId)?.takeIf { it.isNotBlank() }
    val storedIndex = store.readGatePageIndex(appWidgetId).coerceAtLeast(0)
    val normalizedIndex = selectedEntryId
      ?.let { entryId -> entries.indexOfFirst { it.entryId == entryId } }
      ?.takeIf { it >= 0 }
      ?: storedIndex.coerceIn(0, entries.lastIndex)
    if (normalizedIndex != storedIndex || entries[normalizedIndex].entryId != selectedEntryId) {
      store.persistGatePageIndex(appWidgetId, normalizedIndex)
      store.persistGateSelectedEntryId(appWidgetId, entries[normalizedIndex].entryId)
    }
    return normalizedIndex
  }

  private fun buildPreviewTimeLabel(value: String?): String? {
    val instant = runCatching { Instant.parse(value) }.getOrNull() ?: return null
    return clockFormatter.format(instant.atZone(ZoneId.systemDefault()))
  }

  private fun buildFreshnessLabel(cloudUpdatedAt: String): String {
    val instant = runCatching { Instant.parse(cloudUpdatedAt) }.getOrNull()
      ?: return context.getString(R.string.nanoflow_widget_stale)
    val minutes = Duration.between(instant, Instant.now()).toMinutes().coerceAtLeast(0)
    return when {
      minutes <= 1 -> "刚刚同步"
      minutes <= 60 -> "$minutes 分钟前同步"
      else -> context.getString(R.string.nanoflow_widget_stale)
    }
  }

  private fun resolveSummaryLaunchUri(entryUrl: String?): Uri? {
    val rawEntryUrl = entryUrl?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    val origin = Uri.parse(BuildConfig.NANOFLOW_WEB_ORIGIN)
    val resolved = when {
      rawEntryUrl.startsWith("./") -> "${BuildConfig.NANOFLOW_WEB_ORIGIN.removeSuffix("/")}/${rawEntryUrl.removePrefix("./")}"
      rawEntryUrl.startsWith("/#") -> "${BuildConfig.NANOFLOW_WEB_ORIGIN.removeSuffix("/")}$rawEntryUrl"
      rawEntryUrl.startsWith("#/") -> "${BuildConfig.NANOFLOW_WEB_ORIGIN.removeSuffix("/")}/$rawEntryUrl"
      else -> rawEntryUrl
    }
    val candidate = runCatching { Uri.parse(resolved) }.getOrNull() ?: return null
    if (candidate.scheme != origin.scheme || candidate.authority != origin.authority) {
      return null
    }

    val fragment = candidate.fragment ?: return null
    if (!fragment.substringBefore('?').startsWith("/projects")) {
      return null
    }

    return candidate
  }

  private fun preserveCachedContextForTransientSummary(
    summary: WidgetSummaryResponse,
    cachedSummary: WidgetSummaryResponse?,
  ): WidgetSummaryResponse {
    if (cachedSummary == null || summary.code !in transientContextPreservingCodes) {
      return summary
    }

    return summary.copy(
      summaryVersion = cachedSummary.summaryVersion,
      cloudUpdatedAt = cachedSummary.cloudUpdatedAt,
      consistencyState = cachedSummary.consistencyState ?: summary.consistencyState,
      entryUrl = cachedSummary.entryUrl.ifBlank { summary.entryUrl },
      focus = cachedSummary.focus,
      dock = cachedSummary.dock,
      blackBox = cachedSummary.blackBox,
    )
  }

  private fun buildStatusLine(summary: WidgetSummaryResponse): String {
    if (summary.degradedReasons.contains("soft-delete-target")) {
      return context.getString(R.string.nanoflow_widget_target_changed)
    }

    if (summary.code == "WIDGET_REFRESH_DISABLED") {
      return context.getString(R.string.nanoflow_widget_refresh_disabled)
    }

    if (summary.sourceState == "cloud-pending-local-hint") {
      return context.getString(R.string.nanoflow_widget_syncing)
    }

    if (summary.sourceState == "cache-only") {
      return context.getString(R.string.nanoflow_widget_cached)
    }

    if (summary.freshnessState == "stale" || summary.cloudUpdatedAt.isNullOrBlank()) {
      return context.getString(R.string.nanoflow_widget_stale)
    }

    return buildFreshnessLabel(summary.cloudUpdatedAt)
  }

  private suspend fun shouldBootstrap(appWidgetId: Int): Boolean {
    val binding = store.readBinding() ?: return true
    if (isBindingExpired(binding)) {
      return true
    }

    if (!store.readPendingPushToken().isNullOrBlank()) {
      return true
    }

    val summary = store.readSummary(appWidgetId) ?: return true
    if (summary.degradedReasons.contains(pushTokenRepairDegradedReason)) {
      return true
    }
    if (summary.code in bootstrapRequiredCodes) {
      return true
    }

    // 2026-04-19 trust elevation：provisional 状态也要重新 bootstrap 以给 RPC
    // 重新签发 nonce、让 server 端校验并升级为 trusted 的机会。之前仅在
    // auth-required 时触发，导致 provisional 永远 stick。上层 WidgetReceiver
    // 的刷新防抖（30s）保证不会 RPC 风暴。
    if (summary.trustState == "provisional") {
      return true
    }

    return summary.trustState == "auth-required"
  }

  private fun resolveWidgetSupabaseUrl(): String {
    return store.readRuntimeSupabaseUrl()
      ?: BuildConfig.NANOFLOW_SUPABASE_URL.trimEnd('/')
  }

  private fun isBindingExpired(binding: StoredWidgetBinding): Boolean {
    val expiresAt = runCatching { Instant.parse(binding.expiresAt) }.getOrNull()
      ?: return true
    return !expiresAt.isAfter(Instant.now())
  }

  private fun buildSummaryRequestBody(lastKnownVersion: String?, instanceId: String, hostInstanceId: String): String {
    val escapedClientVersion = BuildConfig.NANOFLOW_WIDGET_CLIENT_VERSION
      .replace("\\", "\\\\")
      .replace("\"", "\\\"")
    val escapedVersion = lastKnownVersion
      ?.replace("\\", "\\\\")
      ?.replace("\"", "\\\"")
    val escapedInstanceId = instanceId
      .replace("\\", "\\\\")
      .replace("\"", "\\\"")
    val escapedHostInstanceId = hostInstanceId
      .replace("\\", "\\\\")
      .replace("\"", "\\\"")

    return buildString {
      append('{')
      append("\"clientSchemaVersion\":1,")
      append("\"platform\":\"")
      append(BuildConfig.NANOFLOW_WIDGET_PLATFORM)
      append("\",")
      append("\"supportsPush\":")
      append(if (BuildConfig.NANOFLOW_FCM_ENABLED) "true" else "false")
      append(',')
      if (escapedClientVersion.isNotBlank()) {
        append("\"clientVersion\":\"")
        append(escapedClientVersion)
        append("\",")
      }
      if (!escapedVersion.isNullOrBlank()) {
        append("\"lastKnownSummaryVersion\":\"")
        append(escapedVersion)
        append("\",")
      }
      append("\"instanceId\":\"")
      append(escapedInstanceId)
      append("\",")
      append("\"hostInstanceId\":\"")
      append(escapedHostInstanceId)
      append("\"}")
    }
  }

  private fun buildTransportFallback(
    cachedSummary: WidgetSummaryResponse?,
    error: Throwable,
  ): WidgetSummaryResponse {
    return cachedSummary?.copy(
      trustState = when (cachedSummary.trustState) {
        "auth-required" -> "auth-required"
        "untrusted" -> "untrusted"
        else -> "provisional"
      },
      sourceState = "cache-only",
      warnings = (cachedSummary.warnings + listOf("transport-failed")).distinct(),
      degradedReasons = (cachedSummary.degradedReasons + listOf("transport-failed")).distinct(),
      error = error.message ?: "widget-summary 请求失败",
    ) ?: WidgetSummaryResponse(
      trustState = "untrusted",
      sourceState = "cache-only",
      error = error.message ?: "widget-summary 请求失败",
      code = "WIDGET_SUMMARY_TRANSPORT_FAILED",
      degradedReasons = listOf("transport-failed"),
      warnings = listOf("transport-failed"),
    )
  }

  private suspend fun postJson(url: String, bearerToken: String, body: String): HttpResponse {
    return withContext(Dispatchers.IO) {
      val connection = (URL(url).openConnection() as HttpURLConnection).apply {
        requestMethod = "POST"
        connectTimeout = 10_000
        readTimeout = 10_000
        doOutput = true
        useCaches = false
        defaultUseCaches = false
        setRequestProperty("Content-Type", "application/json")
        setRequestProperty("Authorization", "Bearer $bearerToken")
        setRequestProperty("Cache-Control", "no-store")
        setRequestProperty("Pragma", "no-cache")
        setRequestProperty("x-widget-platform", BuildConfig.NANOFLOW_WIDGET_PLATFORM)
        setRequestProperty("x-widget-client-version", BuildConfig.NANOFLOW_WIDGET_CLIENT_VERSION)
      }

      connection.outputStream.bufferedWriter().use { it.write(body) }
      val bodyText = readBody(connection)
      HttpResponse(statusCode = connection.responseCode, body = bodyText)
    }
  }

  private fun readBody(connection: HttpURLConnection): String {
    val stream = if (connection.responseCode >= 400) connection.errorStream else connection.inputStream
    if (stream == null) return ""

    return BufferedReader(InputStreamReader(stream)).use { it.readText() }
  }

  private data class HttpResponse(
    val statusCode: Int,
    val body: String,
  )
}
