package app.nanoflow.host

import android.app.Activity
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
    }
    finish()
  }
}
