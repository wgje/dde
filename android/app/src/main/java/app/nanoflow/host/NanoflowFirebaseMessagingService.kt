package app.nanoflow.host

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

internal inline fun nanoflowWidgetAttemptSafely(
  action: () -> Unit,
  reportFailure: (Throwable) -> Unit = {},
) {
  try {
    action()
  } catch (error: Throwable) {
    runCatching { reportFailure(error) }
  }
}

internal class NanoflowWidgetSecureTransitionFence {
  private var generation = 0L
  private var quarantinedGeneration: Long? = null

  @Synchronized
  fun commit(confirmsExactBinding: Boolean = false, write: () -> Boolean): Boolean {
    if (quarantinedGeneration != null && !confirmsExactBinding) return false
    val attempt = ++generation
    val committed = try {
      write()
    } catch (error: Throwable) {
      quarantinedGeneration = attempt
      throw error
    }
    if (!committed) quarantinedGeneration = attempt
    else if (confirmsExactBinding) quarantinedGeneration = null
    return committed
  }

  @Synchronized fun canTrustBinding(): Boolean = quarantinedGeneration == null
  @Synchronized fun <T> readIfTrusted(read: () -> T): T? =
    if (quarantinedGeneration == null) read() else null
}

class NanoflowFirebaseMessagingService : FirebaseMessagingService() {
  override fun onNewToken(token: String) {
    super.onNewToken(token)
    val hasInstalledWidgets = NanoflowWidgetReceiver.hasInstalledWidgets(applicationContext)
    nanoflowWidgetAttemptSafely({
      NanoflowWidgetTelemetry.info(
        "widget_push_token_received",
        mapOf("hasInstalledWidgets" to hasInstalledWidgets, "tokenLength" to token.length),
      )
    })
    if (!hasInstalledWidgets) {
      return
    }

    nanoflowWidgetAttemptSafely({
      NanoflowWidgetStore(applicationContext).rememberPushTokenSynchronously(token)
    }, { error ->
      NanoflowWidgetTelemetry.warn(
        "widget_push_token_persist_failed",
        mapOf("errorType" to error.javaClass.simpleName),
        error,
      )
    })
    nanoflowWidgetAttemptSafely({
      NanoflowWidgetRefreshWorker.enqueue(applicationContext, reason = "fcm-token-rotated")
    }, { error ->
      NanoflowWidgetTelemetry.warn(
        "widget_push_token_refresh_enqueue_failed",
        mapOf("errorType" to error.javaClass.simpleName),
        error,
      )
    })
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
      nanoflowWidgetAttemptSafely({
        NanoflowWidgetTelemetry.warn("widget_push_dirty_dropped", mapOf("reason" to "no-installed-widgets"))
      })
      return
    }

    nanoflowWidgetAttemptSafely({
      NanoflowWidgetTelemetry.info(
        "widget_push_dirty_delivered",
        mapOf("hasInstalledWidgets" to true, "messageId" to NanoflowWidgetTelemetry.redactId(message.messageId.orEmpty())),
      )
    })

    nanoflowWidgetAttemptSafely({
      NanoflowWidgetFocusHintWorker.enqueueIfComplete(applicationContext, message.data)
    }, { error ->
      NanoflowWidgetTelemetry.warn(
        "widget_focus_hint_enqueue_failed",
        mapOf("errorType" to error.javaClass.simpleName),
        error,
      )
    })
    nanoflowWidgetAttemptSafely({
      NanoflowWidgetRefreshWorker.enqueue(applicationContext, reason = "widget-dirty-push")
    }, { error ->
      NanoflowWidgetTelemetry.warn(
        "widget_push_refresh_enqueue_failed",
        mapOf("errorType" to error.javaClass.simpleName),
        error,
      )
    })
  }
}
