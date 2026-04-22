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
    // 2026-04-22 蓝图 UI：LARGE / MEDIUM 共用 large layout（focus 或 gate 二选一），
    // 仅 SMALL 继续使用 compact 单行样式。这保证 2×4 倒下长方体与海报 1:1 还原。
    return when (model.sizeTier) {
      WidgetSizeTier.LARGE, WidgetSizeTier.MEDIUM -> renderLarge(context, appWidgetId, model)
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

  // --- 中大尺寸布局：Focus / Gate / 状态页（已不再单独走 medium 分支） ---
  @Suppress("unused")
  private fun renderMedium(context: Context, appWidgetId: Int, model: WidgetRenderModel): RemoteViews {
    // 保留函数签名以兼容旧路径；当前所有 MEDIUM/LARGE 都走 renderLarge。
    return renderLarge(context, appWidgetId, model)
  }

  private fun renderLarge(context: Context, appWidgetId: Int, model: WidgetRenderModel): RemoteViews {
    val useGateLayout = model.isGateMode || model.showSetup || model.showAuthRequired || model.showUntrusted
    val layoutRes = if (useGateLayout) R.layout.nano_widget_large_gate else R.layout.nano_widget_large
    val views = RemoteViews(context.packageName, layoutRes)

    // Root 点击 = 打开 App / Focus Tools（空白区 / 整卡回退）
    views.setOnClickPendingIntent(
      R.id.nano_widget_root,
      NanoflowWidgetReceiver.primaryActionPendingIntent(context, appWidgetId, model.primaryAction),
    )

    renderSyncBadge(views, model)
    renderModeHeader(views, model)

    if (useGateLayout) {
      renderGateCountRing(views, model)
      renderContentList(context, views, appWidgetId, model)
      if (model.isGateMode) {
        views.setViewVisibility(R.id.nano_widget_gate_actions_list, View.VISIBLE)
        renderGateActionsList(context, views, appWidgetId)
      } else {
        views.setViewVisibility(R.id.nano_widget_gate_actions_list, View.GONE)
      }
    } else {
      renderTabList(context, views, appWidgetId)
      renderRefreshList(context, views, appWidgetId)
      renderFocusFooter(context, views, model)
    }

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
      WidgetVisualTone.FOCUS,
      WidgetVisualTone.GATE -> 0xFFEAF3FF.toInt()
      WidgetVisualTone.SETUP,
      WidgetVisualTone.AUTH,
      WidgetVisualTone.UNTRUSTED -> 0xFFFFE4D6.toInt()
    }
  }

  // --- 同步徽章（蓝图风：纯文字，不再带彩色圆点） ---
  private fun renderSyncBadge(views: RemoteViews, model: WidgetRenderModel) {
    val statusLabel = model.syncBadgeLabel ?: model.statusBadge
    if (statusLabel.isNullOrBlank()) {
      views.setViewVisibility(R.id.nano_widget_sync_badge, View.GONE)
    } else {
      views.setTextViewText(R.id.nano_widget_sync_badge, statusLabel)
      views.setViewVisibility(R.id.nano_widget_sync_badge, View.VISIBLE)
    }
    // 2026-04-22 蓝图 UI：不再绘制 sync 状态彩色圆点。mode_label 已由 header 图标表达模式；
    // 多余的色点与「白色技术线稿」蓝图语言冲突，统一清除右侧 compoundDrawable。
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      views.setTextViewCompoundDrawablesRelative(R.id.nano_widget_sync_badge, 0, 0, 0, 0)
    }
  }

  // --- 模式头部：mode_label 文字永远显示（布局已带图标），此处只保证文字最新 ---
  private fun renderModeHeader(views: RemoteViews, model: WidgetRenderModel) {
    views.setTextViewText(R.id.nano_widget_mode_label, model.modeLabel)
  }

  // --- 大门计数徽章：(N) 圆环，仅 gate 模式可见 ---
  private fun renderGateCountRing(views: RemoteViews, model: WidgetRenderModel) {
    val count = model.blackBoxCount
    if (count <= 0) {
      views.setViewVisibility(R.id.nano_widget_gate_count_ring, View.GONE)
      return
    }
    views.setTextViewText(R.id.nano_widget_gate_count_text, count.toString())
    views.setViewVisibility(R.id.nano_widget_gate_count_ring, View.VISIBLE)
  }

  // --- 大门双按钮 GridView：已读 / 完成 ---
  private fun renderGateActionsList(context: Context, views: RemoteViews, appWidgetId: Int) {
    val adapter = NanoflowWidgetReceiver.actionListAdapterIntent(
      context,
      appWidgetId,
      NanoflowWidgetActionFactory.LIST_KIND_GATE_ACTIONS,
    )
    views.setRemoteAdapter(R.id.nano_widget_gate_actions_list, adapter)
    views.setPendingIntentTemplate(
      R.id.nano_widget_gate_actions_list,
      NanoflowWidgetReceiver.actionListClickTemplatePendingIntent(context, appWidgetId),
    )
  }

  // --- 专注模式底栏：「备选区：N 个任务  ›」 ---
  private fun renderFocusFooter(context: Context, views: RemoteViews, model: WidgetRenderModel) {
    val visibleSecondarySlots = (model.tasks.size - 1).coerceAtLeast(0)
    val overflow = (model.dockCount - visibleSecondarySlots).coerceAtLeast(0)
    // 即使 overflow=0 也保留文案，改写为 0 个任务，保证海报对齐的底栏视觉
    views.setTextViewText(
      R.id.nano_widget_footer_label,
      context.getString(R.string.nanoflow_widget_focus_backup_zone, overflow),
    )
    views.setViewVisibility(R.id.nano_widget_footer_label, View.VISIBLE)
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
