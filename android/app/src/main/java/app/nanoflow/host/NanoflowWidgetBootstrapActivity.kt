package app.nanoflow.host

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import kotlinx.coroutines.runBlocking

class NanoflowWidgetBootstrapActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)

    val accepted = runBlocking {
      NanoflowWidgetRepository(applicationContext).consumeBootstrapUri(intent?.data)
    }
    if (accepted) {
      NanoflowWidgetRefreshWorker.syncPeriodicRefresh(
        applicationContext,
        enabled = NanoflowWidgetReceiver.hasInstalledWidgets(applicationContext),
      )
      NanoflowWidgetRefreshWorker.enqueue(applicationContext, reason = "bootstrap-callback")
      returnToWidgetHostSurface()
    }
    finish()
  }

  private fun returnToWidgetHostSurface() {
    val homeIntent = Intent(Intent.ACTION_MAIN).apply {
      addCategory(Intent.CATEGORY_HOME)
      flags = Intent.FLAG_ACTIVITY_NEW_TASK
    }

    try {
      startActivity(homeIntent)
      NanoflowWidgetTelemetry.info("widget_bootstrap_return_home_started")
    } catch (error: RuntimeException) {
      NanoflowWidgetTelemetry.warn(
        "widget_bootstrap_return_home_failed",
        mapOf("errorClass" to error.javaClass.simpleName),
        error,
      )
    }
  }
}
