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

    // 2026-04-22 颠覆性压缩：FCM data payload 携带 focusActiveHint 时，先用 hint 在 0ms 内翻转
    // 本地缓存 summary 的 focus.active 并立刻重绘 widget，再异步走 summary fetch 拉权威数据。
    // 这一步把用户可感延迟从「~8s（FCM→widget-summary 回环）」压缩到「~0.5s（FCM 即绘）」。
    val focusHintRaw = message.data["focusActiveHint"]
    val hintActive: Boolean? = when (focusHintRaw) {
      "true" -> true
      "false" -> false
      else -> null
    }
    if (hintActive != null) {
      val context = applicationContext
      val changed = runBlocking {
        NanoflowWidgetRepository(context).applyFocusActiveHint(hintActive)
      }
      if (changed.isNotEmpty()) {
        // 走 Receiver 的统一 partial update 路径：保留既有 folme-friendly 动画策略，避免抖动。
        NanoflowWidgetReceiver.refreshAllWidgets(context)
      }
    }

    NanoflowWidgetRefreshWorker.enqueue(applicationContext, reason = "widget-dirty-push")
  }
}
