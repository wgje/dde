package app.nanoflow.host

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.runBlocking

class NanoflowFirebaseMessagingService : FirebaseMessagingService() {
  override fun onNewToken(token: String) {
    super.onNewToken(token)
    val hasInstalledWidgets = NanoflowWidgetReceiver.hasInstalledWidgets(applicationContext)
    NanoflowWidgetTelemetry.info(
      "widget_push_token_received",
      mapOf(
        "hasInstalledWidgets" to hasInstalledWidgets,
        "tokenLength" to token.length,
      ),
    )
    if (!hasInstalledWidgets) {
      return
    }

    runBlocking {
      NanoflowWidgetRepository(applicationContext).rememberPushToken(token)
    }
    NanoflowWidgetRefreshWorker.enqueue(applicationContext, reason = "fcm-token-rotated")
  }

  override fun onMessageReceived(message: RemoteMessage) {
    super.onMessageReceived(message)
    val dirtyType = message.data["type"]
    val dirtyAction = message.data["action"]
    if (dirtyType != "widget_dirty" && dirtyAction != "widget-refresh") {
      return
    }

    val hasInstalledWidgets = NanoflowWidgetReceiver.hasInstalledWidgets(applicationContext)
    if (!hasInstalledWidgets) {
      NanoflowWidgetTelemetry.warn(
        "widget_push_dirty_dropped",
        mapOf("reason" to "no-installed-widgets"),
      )
      return
    }

    NanoflowWidgetTelemetry.info(
      "widget_push_dirty_delivered",
      mapOf(
        "hasInstalledWidgets" to true,
        "messageId" to message.messageId,
      ),
    )

    NanoflowWidgetRefreshWorker.enqueue(applicationContext, reason = "widget-dirty-push")
  }
}
