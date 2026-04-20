package app.nanoflow.host

import android.content.Context
import android.os.Build
import android.view.View
import android.widget.RemoteViews
import app.nanoflow.host.R

/**
 * 使用原生 [RemoteViews] 渲染 widget。
 *
 * 交互派发策略：中央内容区与右下角刷新按钮都走集合视图。内容区用纵向 ListView 承载
 * Focus / Gate 卡片，用户可直接上下滑动切换；刷新按钮保留独立 collection-view 路径，
 * 继续绕过 MIUI / HyperOS (com.miui.home) 对普通子视图 PendingIntent 的静默吞噬。
 *
 * Root 容器保留 `setOnClickPendingIntent` 作为整卡点击入口（打开 App / Focus Tools），
 * 确保在任意 launcher / 空白区域都能触发主要动作。
 */
object NanoflowWidgetRenderer {

  fun render(context: Context, appWidgetId: Int, model: WidgetRenderModel): RemoteViews {
    return when (model.sizeTier) {
      WidgetSizeTier.LARGE -> renderLarge(context, appWidgetId, model)
      WidgetSizeTier.MEDIUM -> renderMedium(context, appWidgetId, model)
      else -> renderCompact(context, appWidgetId, model)
    }
  }

  // --- 紧凑布局：SMALL / MEDIUM 共用，单一 click -> 打开 App ---
  private fun renderCompact(context: Context, appWidgetId: Int, model: WidgetRenderModel): RemoteViews {
    val views = RemoteViews(context.packageName, R.layout.nano_widget_compact)
    views.setInt(R.id.nano_widget_root, "setBackgroundResource", rootBackgroundFor(model))
    views.setTextViewText(R.id.nano_widget_mode_label, model.modeLabel)
    views.setTextColor(R.id.nano_widget_mode_label, accentColorFor(model))
    views.setTextViewText(R.id.nano_widget_title, model.title.ifBlank { context.getString(R.string.app_name) })
    val subtitle = model.supportingLine?.takeIf { it.isNotBlank() } ?: model.statusLine
    if (subtitle.isNotBlank()) {
      views.setTextViewText(R.id.nano_widget_subtitle, subtitle)
      views.setViewVisibility(R.id.nano_widget_subtitle, View.VISIBLE)
    } else {
      views.setViewVisibility(R.id.nano_widget_subtitle, View.GONE)
    }
    views.setOnClickPendingIntent(
      R.id.nano_widget_root,
      NanoflowWidgetReceiver.primaryActionPendingIntent(context, appWidgetId, model.primaryAction),
    )
    return views
  }

  // --- 中大尺寸布局：Focus / Gate / 状态页 ---
  private fun renderMedium(context: Context, appWidgetId: Int, model: WidgetRenderModel): RemoteViews {
    val views = RemoteViews(context.packageName, R.layout.nano_widget_medium)
    views.setInt(R.id.nano_widget_root, "setBackgroundResource", rootBackgroundFor(model))
    views.setOnClickPendingIntent(
      R.id.nano_widget_root,
      NanoflowWidgetReceiver.primaryActionPendingIntent(context, appWidgetId, model.primaryAction),
    )

    renderSyncBadge(views, model)
    renderTabList(context, views, appWidgetId)
    renderContentList(context, views, appWidgetId, model)
    renderRefreshList(context, views, appWidgetId)

    return views
  }

  private fun renderLarge(context: Context, appWidgetId: Int, model: WidgetRenderModel): RemoteViews {
    val views = RemoteViews(context.packageName, R.layout.nano_widget_large)
    views.setInt(R.id.nano_widget_root, "setBackgroundResource", rootBackgroundFor(model))

    // 根容器点击 = 打开 App / Focus Tools。集合视图 item 的点击区域会拦截自身事件，
    // 空白处仍回落到 root。
    views.setOnClickPendingIntent(
      R.id.nano_widget_root,
      NanoflowWidgetReceiver.primaryActionPendingIntent(context, appWidgetId, model.primaryAction),
    )

    renderSyncBadge(views, model)
    renderTabList(context, views, appWidgetId)
    renderContentList(context, views, appWidgetId, model)
    renderRefreshList(context, views, appWidgetId)

    return views
  }

  /** 顶部 tab 栏：通过 GridView + RemoteViewsFactory 动态渲染主任务/副任务 chip。 */
  private fun renderTabList(context: Context, views: RemoteViews, appWidgetId: Int) {
    val tabAdapter = NanoflowWidgetReceiver.actionListAdapterIntent(
      context, appWidgetId, NanoflowWidgetActionFactory.LIST_KIND_TABS,
    )
    views.setRemoteAdapter(R.id.nano_widget_tab_list, tabAdapter)
    views.setPendingIntentTemplate(
      R.id.nano_widget_tab_list,
      NanoflowWidgetReceiver.actionListClickTemplatePendingIntent(context, appWidgetId),
    )
  }

  private fun renderContentList(context: Context, views: RemoteViews, appWidgetId: Int, model: WidgetRenderModel) {
    val contentAdapter = NanoflowWidgetReceiver.actionListAdapterIntent(
      context,
      appWidgetId,
      NanoflowWidgetActionFactory.LIST_KIND_CONTENT,
    )
    views.setRemoteAdapter(R.id.nano_widget_content_list, contentAdapter)
    // 内容列表点击必须启动 LauncherActivity，使用 activity-target 模板直通
    // （不走 receiver 广播中转），避免 Android 14+ BAL_BLOCK 拦截。
    views.setPendingIntentTemplate(
      R.id.nano_widget_content_list,
      NanoflowWidgetReceiver.contentListClickTemplatePendingIntent(context, appWidgetId, model.primaryAction),
    )
  }

  private fun renderRefreshList(context: Context, views: RemoteViews, appWidgetId: Int) {
    val refreshAdapter = NanoflowWidgetReceiver.actionListAdapterIntent(
      context, appWidgetId, NanoflowWidgetActionFactory.LIST_KIND_REFRESH,
    )
    views.setRemoteAdapter(R.id.nano_widget_refresh_list, refreshAdapter)
    views.setPendingIntentTemplate(
      R.id.nano_widget_refresh_list,
      NanoflowWidgetReceiver.actionListClickTemplatePendingIntent(context, appWidgetId),
    )
  }

  // --- 背景 / 配色辅助 ---
  private fun rootBackgroundFor(model: WidgetRenderModel): Int {
    return when (model.tone) {
      WidgetVisualTone.FOCUS -> R.drawable.nano_widget_root_focus
      WidgetVisualTone.GATE,
      WidgetVisualTone.SETUP,
      WidgetVisualTone.AUTH,
      WidgetVisualTone.UNTRUSTED -> R.drawable.nano_widget_root_gate
    }
  }

  private fun accentColorFor(model: WidgetRenderModel): Int {
    return when (model.tone) {
      WidgetVisualTone.FOCUS -> 0xFF4A7A38.toInt()
      WidgetVisualTone.GATE -> 0xFF3E5270.toInt()
      WidgetVisualTone.SETUP,
      WidgetVisualTone.AUTH,
      WidgetVisualTone.UNTRUSTED -> 0xFF8A6D1C.toInt()
    }
  }

  // --- 同步徽章 ---
  private fun renderSyncBadge(views: RemoteViews, model: WidgetRenderModel) {
    val label = model.syncBadgeLabel ?: model.statusBadge
    if (label.isNullOrBlank()) {
      views.setViewVisibility(R.id.nano_widget_sync_badge, View.GONE)
      return
    }
    views.setTextViewText(R.id.nano_widget_sync_badge, label)
    // 2026-04-19：根据当前 tone 动态切换左侧状态圆点颜色（绿=Focus、黄=Gate、红=Setup/Auth/Untrusted）。
    // 仅在 API 23+ 上动态切换；低版本继续用 XML 默认的绿点占位。
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      val dotRes = when (model.tone) {
        WidgetVisualTone.FOCUS -> R.drawable.nano_widget_state_dot_green
        WidgetVisualTone.GATE -> R.drawable.nano_widget_state_dot_yellow
        WidgetVisualTone.SETUP,
        WidgetVisualTone.AUTH,
        WidgetVisualTone.UNTRUSTED -> R.drawable.nano_widget_state_dot_red
      }
      views.setTextViewCompoundDrawablesRelative(R.id.nano_widget_sync_badge, 0, 0, dotRes, 0)
    }
    views.setViewVisibility(R.id.nano_widget_sync_badge, View.VISIBLE)
  }

  // --- 标题 + 副标题 ---
  private fun renderMiddleTitle(views: RemoteViews, model: WidgetRenderModel) {
    val (title, subtitle) = resolveTitleAndSubtitle(model)
    views.setTextViewText(R.id.nano_widget_title, title)
    if (subtitle.isNullOrBlank()) {
      views.setViewVisibility(R.id.nano_widget_subtitle, View.GONE)
    } else {
      views.setTextViewText(R.id.nano_widget_subtitle, subtitle)
      views.setViewVisibility(R.id.nano_widget_subtitle, View.VISIBLE)
    }
  }

  private fun resolveTitleAndSubtitle(model: WidgetRenderModel): Pair<String, String?> {
    if (model.tasks.isNotEmpty()) {
      val idx = model.selectedTaskIndex.coerceIn(0, model.tasks.lastIndex)
      val card = model.tasks[idx]
      return card.title to null
    }
    return model.title to model.supportingLine
  }
}
