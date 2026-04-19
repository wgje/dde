package app.nanoflow.host

import android.content.Context
import android.content.Intent
import android.widget.RemoteViews
import android.widget.RemoteViewsService
import app.nanoflow.host.R
import kotlinx.coroutines.runBlocking

/**
 * 集合视图 Factory：把当前 widget 的 Focus tabs / Gate pager / Refresh 翻译成一组 item。
 *
 * 每个 item 都是 [R.layout.nano_widget_action_item]；通过 [setOnClickFillInIntent] 挂载 extras，
 * 由 [NanoflowWidgetReceiver.actionListClickTemplatePendingIntent] 提供的模板 PendingIntent
 * 组合派发到 Receiver 的 [NanoflowWidgetReceiver.ACTION_CLICK_ITEM] 分支。
 */
class NanoflowWidgetActionFactory(
  private val context: Context,
  private val appWidgetId: Int,
  private val listKind: String = LIST_KIND_TABS,
) : RemoteViewsService.RemoteViewsFactory {

  private data class ActionItem(
    val label: String,
    val selected: Boolean,
    val kind: Kind,
    // kind 相关的数据：TAB 用 taskIndex，GATE_NAV 用 gateDelta
    val taskIndex: Int = -1,
    val gateDelta: Int = 0,
    val clickable: Boolean = true,
    val styleTone: ChipTone = ChipTone.SURFACE,
    val primaryAction: WidgetPrimaryAction? = null,
  ) {
    enum class Kind { TAB, OVERFLOW, REFRESH, GATE_PREV, GATE_NEXT, GATE_LABEL, PRIMARY }
    enum class ChipTone { ACCENT, SURFACE, ACCENT_GATE, SURFACE_GATE }
  }

  private var items: List<ActionItem> = emptyList()

  override fun onCreate() {
    // 初次加载：预热数据集。
    refreshItems()
  }

  override fun onDataSetChanged() {
    // AppWidgetManager.notifyAppWidgetViewDataChanged() 触发；重新读模型。
    refreshItems()
  }

  override fun onDestroy() {
    items = emptyList()
  }

  override fun getCount(): Int = items.size

  override fun getViewAt(position: Int): RemoteViews {
    if (position < 0 || position >= items.size) return emptyItemView()
    val item = items[position]

    if (listKind == LIST_KIND_CONTENT) {
      val views = RemoteViews(context.packageName, R.layout.nano_widget_content_item)
      views.setTextViewText(R.id.nano_widget_content_title, item.label)
      if (item.clickable) {
        val fillInIntent = buildFillInIntent(item)
        views.setOnClickFillInIntent(R.id.nano_widget_content_item_root, fillInIntent)
        views.setOnClickFillInIntent(R.id.nano_widget_content_title, fillInIntent)
      }
      return views
    }

    val views = RemoteViews(context.packageName, R.layout.nano_widget_action_item)
    views.setTextViewText(R.id.nano_widget_action_chip, item.label)
    applyChipStyle(views, item.styleTone)
    if (item.clickable) {
      views.setOnClickFillInIntent(
        R.id.nano_widget_action_chip,
        buildFillInIntent(item),
      )
    }
    return views
  }

  override fun getLoadingView(): RemoteViews = emptyItemView()
  override fun getViewTypeCount(): Int = 1
  override fun getItemId(position: Int): Long = position.toLong()
  override fun hasStableIds(): Boolean = true

  private fun emptyItemView(): RemoteViews =
    RemoteViews(
      context.packageName,
      if (listKind == LIST_KIND_CONTENT) R.layout.nano_widget_content_item
      else R.layout.nano_widget_action_item,
    )

  // --- 构建当前 item 列表 ---
  private fun refreshItems() {
    items = runBlocking {
      val model = NanoflowWidgetRepository(context).buildRenderModel(appWidgetId)
      computeItems(model)
    }
  }

  private fun computeItems(model: WidgetRenderModel): List<ActionItem> {
    val isGateTone = model.tone == WidgetVisualTone.GATE

    if (listKind == LIST_KIND_CONTENT) {
      return listOf(
        ActionItem(
          label = resolveContentTitle(model),
          selected = false,
          kind = ActionItem.Kind.PRIMARY,
          clickable = true,
          primaryAction = model.primaryAction,
        )
      )
    }

    if (listKind == LIST_KIND_REFRESH) {
      // 独立 refresh 列表：只包含一个 refresh chip。
      return listOf(
        ActionItem(
          label = context.getString(R.string.nanoflow_widget_refresh),
          selected = false,
          kind = ActionItem.Kind.REFRESH,
          styleTone = if (isGateTone) ActionItem.ChipTone.SURFACE_GATE else ActionItem.ChipTone.SURFACE,
        )
      )
    }

    // LIST_KIND_TABS：只包含 tabs / gate pager。
    val result = mutableListOf<ActionItem>()

    when {
      model.tasks.isNotEmpty() -> {
        // 滑动窗口：始终最多展示 MAX_VISIBLE_TABS 个 chip，selectedIdx 居中。
        // 当任务总数 > 窗口大小时，点击窗口边缘 chip 即可使窗口自动「推进」——
        // 例如选中「副任务3」会令窗口向右滑，让 副3 出现在中间位置；
        // 用户视觉上始终能看到当前选中的 tab + 相邻上下文，模拟可滑动效果。
        val totalCount = model.tasks.size
        val selectedIdx = model.selectedTaskIndex.coerceIn(0, totalCount - 1)
        val maxVisibleTabs = resolveMaxVisibleTabs(model)
        val maxStart = (totalCount - maxVisibleTabs).coerceAtLeast(0)
        val startIdx = (selectedIdx - 1).coerceIn(0, maxStart)
        val endExclusive = (startIdx + maxVisibleTabs).coerceAtMost(totalCount)
        for (globalIdx in startIdx until endExclusive) {
          val card = model.tasks[globalIdx]
          val isSelected = globalIdx == selectedIdx
          val hasHiddenBefore = startIdx > 0 && globalIdx == startIdx
          val hasHiddenAfter = endExclusive < totalCount && globalIdx == endExclusive - 1
          result += ActionItem(
            label = tabLabelFor(card, globalIdx, hasHiddenBefore, hasHiddenAfter),
            selected = isSelected,
            kind = ActionItem.Kind.TAB,
            taskIndex = globalIdx,
            styleTone = if (isSelected) ActionItem.ChipTone.ACCENT else ActionItem.ChipTone.SURFACE,
          )
        }
      }
      model.isGateMode && model.showGatePager -> {
        if (model.canPageBackward) {
          result += ActionItem(
            label = "‹",
            selected = false,
            kind = ActionItem.Kind.GATE_PREV,
            gateDelta = -1,
            styleTone = ActionItem.ChipTone.ACCENT_GATE,
          )
        }
        result += ActionItem(
          label = model.gatePageIndicator ?: "1 / 1",
          selected = false,
          kind = ActionItem.Kind.GATE_LABEL,
          clickable = false,
          styleTone = ActionItem.ChipTone.SURFACE_GATE,
        )
        if (model.canPageForward) {
          result += ActionItem(
            label = "›",
            selected = false,
            kind = ActionItem.Kind.GATE_NEXT,
            gateDelta = 1,
            styleTone = ActionItem.ChipTone.ACCENT_GATE,
          )
        }
      }
    }

    return result
  }

  private fun buildFillInIntent(item: ActionItem): Intent {
    val fill = Intent()
    fill.putExtra(NanoflowWidgetReceiver.EXTRA_APP_WIDGET_ID, appWidgetId)
    val itemType = when (item.kind) {
      ActionItem.Kind.TAB,
      ActionItem.Kind.OVERFLOW -> ITEM_TYPE_TAB
      ActionItem.Kind.REFRESH -> ITEM_TYPE_REFRESH
      ActionItem.Kind.PRIMARY -> ITEM_TYPE_PRIMARY
      ActionItem.Kind.GATE_PREV,
      ActionItem.Kind.GATE_NEXT -> ITEM_TYPE_GATE
      ActionItem.Kind.GATE_LABEL -> ITEM_TYPE_NONE
    }
    fill.putExtra(NanoflowWidgetReceiver.EXTRA_ITEM_TYPE, itemType)
    if (item.taskIndex >= 0) fill.putExtra(NanoflowWidgetReceiver.EXTRA_TASK_INDEX, item.taskIndex)
    if (item.gateDelta != 0) fill.putExtra(NanoflowWidgetReceiver.EXTRA_GATE_DELTA, item.gateDelta)
    item.primaryAction?.let {
      fill.putExtra(EXTRA_PRIMARY_ACTION, it.name)
    }
    return fill
  }

  private fun applyChipStyle(views: RemoteViews, tone: ActionItem.ChipTone) {
    val (bg, fg) = when (tone) {
      ActionItem.ChipTone.ACCENT -> R.drawable.nano_widget_chip_accent to 0xFFFFFFFF.toInt()
      ActionItem.ChipTone.SURFACE -> R.drawable.nano_widget_chip_surface to 0xFF4A7A38.toInt()
      ActionItem.ChipTone.ACCENT_GATE -> R.drawable.nano_widget_chip_accent_gate to 0xFFFFFFFF.toInt()
      ActionItem.ChipTone.SURFACE_GATE -> R.drawable.nano_widget_chip_surface_gate to 0xFF3E5270.toInt()
    }
    views.setInt(R.id.nano_widget_action_chip, "setBackgroundResource", bg)
    views.setTextColor(R.id.nano_widget_action_chip, fg)
  }

  private fun resolveMaxVisibleTabs(model: WidgetRenderModel): Int {
    return when (model.sizeTier) {
      WidgetSizeTier.LARGE -> 4
      WidgetSizeTier.MEDIUM,
      WidgetSizeTier.SMALL -> 3
    }
  }

  private fun tabLabelFor(
    card: WidgetTaskCard,
    index: Int,
    hasHiddenBefore: Boolean,
    hasHiddenAfter: Boolean,
  ): String {
    val base = if (card.isMain) "主任务" else "副任务$index"
    return when {
      hasHiddenBefore && hasHiddenAfter -> "‹ $base ›"
      hasHiddenBefore -> "‹ $base"
      hasHiddenAfter -> "$base ›"
      else -> base
    }
  }

  private fun resolveContentTitle(model: WidgetRenderModel): String {
    if (model.tasks.isNotEmpty()) {
      val index = model.selectedTaskIndex.coerceIn(0, model.tasks.lastIndex)
      return model.tasks[index].title
    }

    return model.title
  }

  companion object {
    const val ITEM_TYPE_TAB = "tab"
    const val ITEM_TYPE_REFRESH = "refresh"
    const val ITEM_TYPE_GATE = "gate"
    const val ITEM_TYPE_PRIMARY = "primary"
    const val ITEM_TYPE_NONE = "none"
    const val EXTRA_PRIMARY_ACTION = "extra.PRIMARY_ACTION"

    /** 集合视图分流：tabs / content / refresh。 */
    const val LIST_KIND_TABS = "tabs"
    const val LIST_KIND_CONTENT = "content"
    const val LIST_KIND_REFRESH = "refresh"
  }
}
