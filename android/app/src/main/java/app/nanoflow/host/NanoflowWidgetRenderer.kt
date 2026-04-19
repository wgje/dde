package app.nanoflow.host

import android.content.Context
import android.os.Build
import android.util.TypedValue
import android.view.View
import android.widget.RemoteViews
import app.nanoflow.host.R

/**
 * 使用原生 [RemoteViews] 渲染 widget。
 *
 * 交互派发策略：Focus tabs / Gate pager / Refresh 按钮全部经由位于布局顶部的
 * [R.id.nano_widget_action_list] 集合视图承担——通过 `RemoteViewsService + RemoteViewsFactory`
 * 提供数据，再用 `setPendingIntentTemplate + setOnClickFillInIntent` 分发点击。这条路径与
 * 普通 `setOnClickPendingIntent` 分离，可绕过 MIUI / HyperOS (com.miui.home) 对子视图
 * PendingIntent 的静默吞噬。
 *
 * Root 容器保留 `setOnClickPendingIntent` 作为整卡点击入口（打开 App / Focus Tools），
 * 确保在任意 launcher / 空白区域都能触发主要动作。
 */
object NanoflowWidgetRenderer {

  private data class ActionLayoutSpec(
    val tabColumnWidthDp: Float,
    val tabSpacingDp: Float,
    val refreshWidthDp: Float,
  )

  private val mediumActionLayoutSpec = ActionLayoutSpec(
    tabColumnWidthDp = 68f,
    tabSpacingDp = 2f,
    refreshWidthDp = 86f,
  )

  private val largeActionLayoutSpec = ActionLayoutSpec(
    tabColumnWidthDp = 82f,
    tabSpacingDp = 4f,
    refreshWidthDp = 82f,
  )

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
    renderContentList(context, views, appWidgetId, model)
    renderActionList(context, views, appWidgetId, model)

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
    renderMiddleTitle(views, model)
    renderActionList(context, views, appWidgetId, model)

    return views
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

  // --- 集合视图挂载 ---
  private fun renderActionList(context: Context, views: RemoteViews, appWidgetId: Int, model: WidgetRenderModel) {
    val layoutSpec = actionLayoutSpecFor(model.sizeTier)
    // 顶部 tab 列表（focus tabs / gate pager）。
    // 根据实际 tab 数动态设置 numColumns，避免 GridView 预留 4 列宽度后
    // 单个 chip 落在最左一格、视觉上偏左贴着 sync_badge 的问题。
    val tabCount = if (model.isGateMode) {
      // Gate 模式：prev / indicator / next 最多 3 个
      val arrows = (if (model.canPageBackward) 1 else 0) + (if (model.canPageForward) 1 else 0)
      val indicator = if (!model.gatePageIndicator.isNullOrBlank()) 1 else 0
      (arrows + indicator).coerceAtLeast(1)
    } else {
      // Focus 模式启用滑动窗口：4x2 保持 3 个可视 tab，4x3 可容纳 4 个。
      model.tasks.size.coerceIn(1, maxVisibleTabsFor(model.sizeTier))
    }
    val effectiveTabCount = tabCount.coerceAtMost(4)
    views.setInt(R.id.nano_widget_tab_list, "setNumColumns", effectiveTabCount)
    // GridView 在 RemoteViews 下若使用 wrap_content + numColumns=N 会预留 N 列宽度（即便 item 更少），
    // 导致 LinearLayout weight spacer 无法把 GridView 推到右边。这里在 API 31+ 用 setViewLayoutWidth
    // 精确把 tab 列表宽度收紧到「列数 × 82dp + 间隔」，让 spacer 真正生效。
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      val tabWidthDp = effectiveTabCount * layoutSpec.tabColumnWidthDp
        + (effectiveTabCount - 1).coerceAtLeast(0) * layoutSpec.tabSpacingDp
      views.setViewLayoutWidth(R.id.nano_widget_tab_list, tabWidthDp, TypedValue.COMPLEX_UNIT_DIP)
      views.setViewLayoutWidth(
        R.id.nano_widget_refresh_list,
        layoutSpec.refreshWidthDp,
        TypedValue.COMPLEX_UNIT_DIP,
      )
    }
    val tabsAdapter = NanoflowWidgetReceiver.actionListAdapterIntent(
      context, appWidgetId, NanoflowWidgetActionFactory.LIST_KIND_TABS,
    )
    views.setRemoteAdapter(R.id.nano_widget_tab_list, tabsAdapter)
    views.setPendingIntentTemplate(
      R.id.nano_widget_tab_list,
      NanoflowWidgetReceiver.actionListClickTemplatePendingIntent(context, appWidgetId),
    )

    // 右下角独立 refresh 列表（始终单 chip）。
    val refreshAdapter = NanoflowWidgetReceiver.actionListAdapterIntent(
      context, appWidgetId, NanoflowWidgetActionFactory.LIST_KIND_REFRESH,
    )
    views.setRemoteAdapter(R.id.nano_widget_refresh_list, refreshAdapter)
    views.setPendingIntentTemplate(
      R.id.nano_widget_refresh_list,
      NanoflowWidgetReceiver.actionListClickTemplatePendingIntent(context, appWidgetId),
    )
  }

  private fun actionLayoutSpecFor(sizeTier: WidgetSizeTier): ActionLayoutSpec {
    return when (sizeTier) {
      WidgetSizeTier.MEDIUM -> mediumActionLayoutSpec
      WidgetSizeTier.LARGE -> largeActionLayoutSpec
      WidgetSizeTier.SMALL -> mediumActionLayoutSpec
    }
  }

  private fun maxVisibleTabsFor(sizeTier: WidgetSizeTier): Int {
    return when (sizeTier) {
      WidgetSizeTier.LARGE -> 3
      WidgetSizeTier.MEDIUM,
      WidgetSizeTier.SMALL -> 3
    }
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
