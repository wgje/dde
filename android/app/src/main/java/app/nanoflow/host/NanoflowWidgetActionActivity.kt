package app.nanoflow.host

import android.appwidget.AppWidgetManager
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch

/**
 * 透明 trampoline Activity：承接小组件大门「已读 / 完成」按钮。
 *
 * 直接用 Activity PendingIntent 让 launcher 以前台用户手势启动本进程，避免部分 ROM
 * 对 widget broadcast 的后台自启动限制导致按钮点击完全无反馈。
 */
class NanoflowWidgetActionActivity : ComponentActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    handleActionIntent(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    handleActionIntent(intent)
  }

  private fun handleActionIntent(actionIntent: Intent?) {
    val currentIntent = actionIntent ?: run {
      finish()
      return
    }
    val appWidgetId = currentIntent.getIntExtra(
      NanoflowWidgetReceiver.EXTRA_APP_WIDGET_ID,
      AppWidgetManager.INVALID_APPWIDGET_ID,
    )
    if (appWidgetId == AppWidgetManager.INVALID_APPWIDGET_ID) {
      NanoflowWidgetTelemetry.warn("widget_gate_action_activity_rejected", mapOf("reason" to "missing-widget-id"))
      finish()
      return
    }

    NanoflowWidgetReceiver.resetReactiveRefreshGate(
      applicationContext,
      "widget-gate-action-activity",
    )

    lifecycleScope.launch {
      try {
        NanoflowWidgetGateActionHandler.handle(applicationContext, appWidgetId, currentIntent)
      } finally {
        finish()
      }
    }
  }
}
