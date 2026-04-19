package app.nanoflow.host

import android.appwidget.AppWidgetManager
import android.content.Intent
import android.widget.RemoteViewsService

/**
 * 集合视图适配器服务：把 Focus tabs / Gate pager / Refresh 统一渲染为一组 RemoteViews。
 *
 * 为什么引入集合视图：MIUI / HyperOS (com.miui.home) 的 launcher 会将所有 widget 子视图的
 * [android.widget.RemoteViews.setOnClickPendingIntent] 合并到根级派发，导致 refresh / tab
 * 切换按钮的 PendingIntent 被静默吞掉。集合视图走的是另一条路径：
 * `setPendingIntentTemplate` + `setOnClickFillInIntent`，派发由系统在 RemoteViewsAdapter 通道
 * 内完成，经验上不受此 launcher 限制影响。
 */
class NanoflowWidgetActionService : RemoteViewsService() {
  override fun onGetViewFactory(intent: Intent): RemoteViewsFactory {
    val appWidgetId = intent.getIntExtra(
      AppWidgetManager.EXTRA_APPWIDGET_ID,
      AppWidgetManager.INVALID_APPWIDGET_ID,
    )
    val listKind = intent.getStringExtra(NanoflowWidgetReceiver.EXTRA_LIST_KIND)
      ?: NanoflowWidgetActionFactory.LIST_KIND_TABS
    return NanoflowWidgetActionFactory(applicationContext, appWidgetId, listKind)
  }
}
