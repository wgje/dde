package app.nanoflow.host

import android.appwidget.AppWidgetManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import com.google.androidbrowserhelper.trusted.LauncherActivity
import com.google.androidbrowserhelper.trusted.TwaProviderPicker
import kotlinx.coroutines.runBlocking

class NanoflowTwaLauncherActivity : LauncherActivity() {
  private var cachedLaunchRequest: LaunchRequest? = null
  private var cachedLaunchUri: Uri? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    // 让原生启动窗口和 Web 初始 loader 使用同一套启动面，避免 TWA provider 接管前露出白底窗口。
    installSplashScreen()
    super.onCreate(savedInstanceState)
    launchFromCurrentIntent()
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    resetLaunchCache()
    launchFromCurrentIntent()
  }

  override fun shouldLaunchImmediately(): Boolean = false

  override fun getLaunchingUrl(): Uri {
    return cachedLaunchUri ?: resolveLaunchingUrl().also { uri ->
      cachedLaunchUri = uri
    }
  }

  private fun resolveLaunchingUrl(): Uri {
    val request = resolveLaunchRequest()

    if (request.appWidgetId != AppWidgetManager.INVALID_APPWIDGET_ID) {
      return runBlocking {
        NanoflowWidgetRepository(applicationContext).buildLaunchUri(
          appWidgetId = request.appWidgetId,
          preferredEntrySource = request.entrySource,
          launchIntent = request.launchIntent,
        )
      }
    }

    return NanoflowBootstrapContract.buildLaunchUri(
      request.entrySource,
      request.launchIntent,
      bridgeContext = null,
    )
  }

  private fun launchFromCurrentIntent() {
    if (isFinishing) {
      return
    }

    logLaunchStarted()
    launchTwa()
  }

  private fun resetLaunchCache() {
    cachedLaunchRequest = null
    cachedLaunchUri = null
  }

  private fun logLaunchStarted() {
    val launchUrl = getLaunchingUrl()
    val providerAction = TwaProviderPicker.pickProvider(packageManager)
    val providerLaunchMode = providerLaunchMode(providerAction.launchMode)

    NanoflowWidgetTelemetry.info(
      event = "widget_twa_launch_started",
      fields = buildLaunchTelemetryFields(
        launchUrl = launchUrl,
        providerPackage = providerAction.provider,
        providerLaunchMode = providerLaunchMode,
      ),
    )
  }

  private fun buildLaunchTelemetryFields(
    launchUrl: Uri,
    providerPackage: String?,
    providerLaunchMode: String,
  ): Map<String, Any?> {
    val request = resolveLaunchRequest()

    return mapOf(
      "appWidgetId" to request.appWidgetId.takeUnless { it == AppWidgetManager.INVALID_APPWIDGET_ID },
      "entrySource" to request.entrySource,
      "launchIntent" to request.launchIntent,
      "launchPath" to launchUrl.fragment?.substringBefore('?')?.ifBlank { null },
      "providerLaunchMode" to providerLaunchMode,
      "providerPackage" to providerPackage,
      "widgetLaunch" to (request.appWidgetId != AppWidgetManager.INVALID_APPWIDGET_ID),
    )
  }

  private fun resolveLaunchRequest(): LaunchRequest {
    return cachedLaunchRequest ?: LaunchRequest(
      appWidgetId = intent?.getIntExtra(EXTRA_APP_WIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
        ?: AppWidgetManager.INVALID_APPWIDGET_ID,
      launchIntent = intent?.getStringExtra(EXTRA_LAUNCH_INTENT)
        ?.let { value -> NanoFlowLaunchIntent.entries.find { it.name == value } }
        ?: NanoFlowLaunchIntent.OPEN_WORKSPACE,
      entrySource = intent?.getStringExtra(EXTRA_ENTRY_SOURCE)
        ?.let { value -> NanoFlowEntrySource.entries.find { it.name == value } }
        ?: NanoFlowEntrySource.TWA,
    ).also { request ->
      cachedLaunchRequest = request
    }
  }

  private fun providerLaunchMode(launchMode: Int): String {
    return when (launchMode) {
      TwaProviderPicker.LaunchMode.TRUSTED_WEB_ACTIVITY -> "trusted-web-activity"
      TwaProviderPicker.LaunchMode.CUSTOM_TAB -> "custom-tab"
      TwaProviderPicker.LaunchMode.BROWSER -> "browser"
      else -> "unknown"
    }
  }

  private data class LaunchRequest(
    val appWidgetId: Int,
    val launchIntent: NanoFlowLaunchIntent,
    val entrySource: NanoFlowEntrySource,
  )

  companion object {
    private const val EXTRA_APP_WIDGET_ID = "extra.APP_WIDGET_ID"
    private const val EXTRA_LAUNCH_INTENT = "extra.LAUNCH_INTENT"
    private const val EXTRA_ENTRY_SOURCE = "extra.ENTRY_SOURCE"

    fun intentForWidget(
      context: Context,
      appWidgetId: Int,
      launchIntent: NanoFlowLaunchIntent,
    ): Intent {
      return Intent(context, NanoflowTwaLauncherActivity::class.java).apply {
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        putExtra(EXTRA_APP_WIDGET_ID, appWidgetId)
        putExtra(EXTRA_LAUNCH_INTENT, launchIntent.name)
        putExtra(EXTRA_ENTRY_SOURCE, NanoFlowEntrySource.WIDGET.name)
      }
    }
  }
}
