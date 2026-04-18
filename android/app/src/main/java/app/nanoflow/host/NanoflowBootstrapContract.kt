package app.nanoflow.host

import android.net.Uri

enum class NanoFlowEntrySource(val queryValue: String) {
  TWA("twa"),
  WIDGET("widget"),
}

enum class NanoFlowLaunchIntent(val queryValue: String) {
  OPEN_WORKSPACE("open-workspace"),
  OPEN_FOCUS_TOOLS("open-focus-tools"),
  OPEN_BLACKBOX_RECORDER("open-blackbox-recorder"),
}

data class WidgetBridgeContext(
  val installationId: String,
  val deviceId: String,
  val deviceSecret: String,
  val clientVersion: String,
  val instanceId: String,
  val hostInstanceId: String,
  val bootstrapNonce: String,
  val sizeBucket: String,
  val pendingPushToken: String?,
)

data class WidgetBootstrapPayload(
  val widgetToken: String,
  val installationId: String,
  val deviceId: String,
  val supabaseUrl: String?,
  val bindingGeneration: Int,
  val expiresAt: String,
  val bootstrapNonce: String,
  val instanceId: String?,
  val hostInstanceId: String,
)

object NanoflowBootstrapContract {
  private const val DEFAULT_HASH_ROUTE = "/projects"
  const val CALLBACK_SCHEME = "nanoflow-widget"
  const val CALLBACK_HOST = "bootstrap"
  const val PARAM_WIDGET_BOOTSTRAP = "widgetBootstrap"
  const val PARAM_CALLBACK_URI = "widgetBootstrapReturnUri"
  const val PARAM_INSTALLATION_ID = "widgetInstallationId"
  const val PARAM_DEVICE_ID = "widgetDeviceId"
  const val PARAM_DEVICE_SECRET = "widgetDeviceSecret"
  const val PARAM_CLIENT_VERSION = "widgetClientVersion"
  const val PARAM_INSTANCE_ID = "widgetInstanceId"
  const val PARAM_HOST_INSTANCE_ID = "widgetHostInstanceId"
  const val PARAM_BOOTSTRAP_NONCE = "widgetBootstrapNonce"
  const val PARAM_SIZE_BUCKET = "widgetSizeBucket"
  const val PARAM_PENDING_PUSH_TOKEN = "widgetPendingPushToken"
  const val PARAM_WIDGET_TOKEN = "widgetToken"
  const val PARAM_SUPABASE_URL = "widgetSupabaseUrl"
  const val PARAM_BINDING_GENERATION = "bindingGeneration"
  const val PARAM_EXPIRES_AT = "expiresAt"

  fun buildLaunchUri(
    entrySource: NanoFlowEntrySource,
    launchIntent: NanoFlowLaunchIntent,
    bridgeContext: WidgetBridgeContext?,
    routeUrl: String? = null,
  ): Uri {
    val params = linkedMapOf(
      "entry" to entrySource.queryValue,
      "intent" to launchIntent.queryValue,
    )

    if (bridgeContext != null) {
      params[PARAM_WIDGET_BOOTSTRAP] = "1"
      params[PARAM_CALLBACK_URI] = callbackBaseUri().toString()
      params[PARAM_INSTALLATION_ID] = bridgeContext.installationId
      params[PARAM_DEVICE_ID] = bridgeContext.deviceId
      params[PARAM_DEVICE_SECRET] = bridgeContext.deviceSecret
      params[PARAM_CLIENT_VERSION] = bridgeContext.clientVersion
      params[PARAM_INSTANCE_ID] = bridgeContext.instanceId
      params[PARAM_HOST_INSTANCE_ID] = bridgeContext.hostInstanceId
      params[PARAM_BOOTSTRAP_NONCE] = bridgeContext.bootstrapNonce
      params[PARAM_SIZE_BUCKET] = bridgeContext.sizeBucket
      if (!bridgeContext.pendingPushToken.isNullOrBlank()) {
        params[PARAM_PENDING_PUSH_TOKEN] = bridgeContext.pendingPushToken
      }
    }

    val query = params.entries.joinToString("&") { (key, value) ->
      "$key=${Uri.encode(value)}"
    }

    return Uri.parse("${BuildConfig.NANOFLOW_WEB_ORIGIN}/#${resolveHashRoutePath(routeUrl)}?$query")
  }

  private fun resolveHashRoutePath(routeUrl: String?): String {
    val fragmentRoute = when {
      routeUrl.isNullOrBlank() -> DEFAULT_HASH_ROUTE
      routeUrl.startsWith("./#/") -> routeUrl.removePrefix("./#")
      routeUrl.startsWith("/#/") -> routeUrl.removePrefix("/#")
      routeUrl.startsWith("#/") -> routeUrl.removePrefix("#")
      else -> Uri.parse(routeUrl).fragment ?: DEFAULT_HASH_ROUTE
    }

    val path = fragmentRoute.substringBefore('?')
    return if (path.startsWith("/projects")) path else DEFAULT_HASH_ROUTE
  }

  fun callbackBaseUri(): Uri {
    return Uri.Builder()
      .scheme(CALLBACK_SCHEME)
      .authority(CALLBACK_HOST)
      .build()
  }

  fun parseBootstrapPayload(uri: Uri?): WidgetBootstrapPayload? {
    if (uri == null) return null
    if (uri.scheme != CALLBACK_SCHEME || uri.host != CALLBACK_HOST) return null

    val params = if (!uri.encodedFragment.isNullOrBlank()) {
      Uri.parse("https://bootstrap.invalid/?${uri.encodedFragment}")
    } else {
      uri
    }

    val widgetToken = params.getQueryParameter(PARAM_WIDGET_TOKEN)?.takeIf { it.isNotBlank() } ?: return null
    val installationId = params.getQueryParameter(PARAM_INSTALLATION_ID)?.takeIf { it.isNotBlank() } ?: return null
    val deviceId = params.getQueryParameter(PARAM_DEVICE_ID)?.takeIf { it.isNotBlank() } ?: return null
    val supabaseUrl = params.getQueryParameter(PARAM_SUPABASE_URL)?.takeIf { it.isNotBlank() }
    val bindingGeneration = params.getQueryParameter(PARAM_BINDING_GENERATION)?.toIntOrNull() ?: return null
    val expiresAt = params.getQueryParameter(PARAM_EXPIRES_AT)?.takeIf { it.isNotBlank() } ?: return null
    val bootstrapNonce = params.getQueryParameter(PARAM_BOOTSTRAP_NONCE)?.takeIf { it.isNotBlank() } ?: return null
    val hostInstanceId = params.getQueryParameter(PARAM_HOST_INSTANCE_ID)?.takeIf { it.isNotBlank() } ?: return null

    return WidgetBootstrapPayload(
      widgetToken = widgetToken,
      installationId = installationId,
      deviceId = deviceId,
      supabaseUrl = supabaseUrl,
      bindingGeneration = bindingGeneration,
      expiresAt = expiresAt,
      bootstrapNonce = bootstrapNonce,
      instanceId = params.getQueryParameter(PARAM_INSTANCE_ID)?.takeIf { it.isNotBlank() },
      hostInstanceId = hostInstanceId,
    )
  }
}
