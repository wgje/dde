package app.nanoflow.host

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import kotlinx.coroutines.runBlocking

/**
 * 原生 AppWidget 接收器。
 *
 * 交互模型：
 *  - Root 级整卡点击：`setOnClickPendingIntent` 挂载 [ACTION_CLICK_OPEN_APP] / [ACTION_CLICK_OPEN_FOCUS_TOOLS]。
 *  - Focus tabs / Gate pager / Refresh：统一通过 `RemoteViewsService + RemoteViewsFactory + PendingIntentTemplate`
 *    派发，所有子 item 的 click 走 [ACTION_CLICK_ITEM]，fillInIntent 携带 [EXTRA_ITEM_TYPE] 等 extras。
 *    此路径与 MIUI launcher 的 root 吞噬机制不同，属于绕道实现。
 */
class NanoflowWidgetReceiver : AppWidgetProvider() {

  override fun onUpdate(
    context: Context,
    appWidgetManager: AppWidgetManager,
    appWidgetIds: IntArray,
  ) {
    runBlocking {
      val store = NanoflowWidgetStore(context)
      val repository = NanoflowWidgetRepository(context)
      appWidgetIds.forEach { widgetId ->
        val existingInstanceId = store.readInstanceId(widgetId)
        val instanceId = store.ensureInstanceId(widgetId)
        val sizeBucket = resolveSizeBucket(appWidgetManager.getAppWidgetOptions(widgetId))
        store.persistSizeBucket(widgetId, sizeBucket)
        NanoflowWidgetTelemetry.info(
          if (existingInstanceId == null) "widget_instance_install" else "widget_instance_update",
          mapOf(
            "appWidgetId" to widgetId,
            "instanceId" to NanoflowWidgetTelemetry.redactId(instanceId),
            "sizeBucket" to sizeBucket,
          ),
        )
        renderAndApply(context, appWidgetManager, repository, widgetId)
        notifyActionListsDataChanged(appWidgetManager, widgetId)
      }
    }
    NanoflowWidgetRefreshWorker.syncPeriodicRefresh(context, hasInstalledWidgets(context))
    NanoflowWidgetRefreshWorker.enqueue(context, reason = "receiver-update")
  }

  override fun onAppWidgetOptionsChanged(
    context: Context,
    appWidgetManager: AppWidgetManager,
    appWidgetId: Int,
    newOptions: Bundle,
  ) {
    runBlocking {
      val store = NanoflowWidgetStore(context)
      val repository = NanoflowWidgetRepository(context)
      val instanceId = store.readInstanceId(appWidgetId)
      val sizeBucket = resolveSizeBucket(newOptions)
      store.persistSizeBucket(appWidgetId, sizeBucket)
      NanoflowWidgetTelemetry.info(
        "widget_instance_resized",
        mapOf(
          "appWidgetId" to appWidgetId,
          "instanceId" to NanoflowWidgetTelemetry.redactId(instanceId),
          "sizeBucket" to sizeBucket,
        ),
      )
      renderAndApply(context, appWidgetManager, repository, appWidgetId)
      notifyActionListsDataChanged(appWidgetManager, appWidgetId)
    }
    NanoflowWidgetRefreshWorker.syncPeriodicRefresh(context, hasInstalledWidgets(context))
    NanoflowWidgetRefreshWorker.enqueue(context, reason = "receiver-options-changed")
  }

  override fun onDeleted(context: Context, appWidgetIds: IntArray) {
    val hasWidgetsRemaining = hasInstalledWidgets(context)
    runBlocking {
      val store = NanoflowWidgetStore(context)
      appWidgetIds.forEach { widgetId ->
        val instanceId = store.readInstanceId(widgetId)
        store.clearWidgetState(widgetId)
        NanoflowWidgetTelemetry.info(
          "widget_instance_uninstall",
          mapOf(
            "appWidgetId" to widgetId,
            "instanceId" to NanoflowWidgetTelemetry.redactId(instanceId),
            "widgetsRemaining" to hasWidgetsRemaining,
          ),
        )
      }
      if (!hasWidgetsRemaining) {
        store.clearAllWidgetState(clearPendingPushToken = true)
      }
    }
    NanoflowWidgetRefreshWorker.syncPeriodicRefresh(context, hasWidgetsRemaining)
  }

  override fun onDisabled(context: Context) {
    NanoflowWidgetTelemetry.info("widget_instance_uninstall_all")
    runBlocking {
      NanoflowWidgetStore(context).clearAllWidgetState(clearPendingPushToken = true)
    }
    NanoflowWidgetRefreshWorker.syncPeriodicRefresh(context, enabled = false)
  }

  override fun onReceive(context: Context, intent: Intent) {
    super.onReceive(context, intent)
    when (intent.action) {
      ACTION_CLICK_OPEN_APP -> handleClickOpenApp(context, intent)
      ACTION_CLICK_OPEN_FOCUS_TOOLS -> handleClickOpenFocusTools(context, intent)
      ACTION_CLICK_ITEM -> handleClickItem(context, intent)
      ACTION_FORCE_REFRESH -> NanoflowWidgetRefreshWorker.enqueue(context, reason = "force-refresh-broadcast")
    }
  }

  // --- Click handlers ---
  private fun handleClickOpenApp(context: Context, intent: Intent) {
    val appWidgetId = intent.getIntExtra(EXTRA_APP_WIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
    NanoflowWidgetTelemetry.info(
      "widget_click_open_app",
      mapOf(
        "appWidgetId" to appWidgetId,
        "launchIntent" to NanoFlowLaunchIntent.OPEN_WORKSPACE.queryValue,
      ),
    )
    context.startActivity(
      NanoflowTwaLauncherActivity.intentForWidget(
        context = context,
        appWidgetId = appWidgetId,
        launchIntent = NanoFlowLaunchIntent.OPEN_WORKSPACE,
      ),
    )
  }

  private fun handleClickOpenFocusTools(context: Context, intent: Intent) {
    val appWidgetId = intent.getIntExtra(EXTRA_APP_WIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
    NanoflowWidgetTelemetry.info(
      "widget_click_open_focus_tools",
      mapOf(
        "appWidgetId" to appWidgetId,
        "launchIntent" to NanoFlowLaunchIntent.OPEN_FOCUS_TOOLS.queryValue,
      ),
    )
    context.startActivity(
      NanoflowTwaLauncherActivity.intentForWidget(
        context = context,
        appWidgetId = appWidgetId,
        launchIntent = NanoFlowLaunchIntent.OPEN_FOCUS_TOOLS,
      ),
    )
  }

  /** 集合视图 item click：根据 EXTRA_ITEM_TYPE 分派到具体处理函数。 */
  private fun handleClickItem(context: Context, intent: Intent) {
    val appWidgetId = intent.getIntExtra(EXTRA_APP_WIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
    if (appWidgetId == AppWidgetManager.INVALID_APPWIDGET_ID) return
    when (intent.getStringExtra(EXTRA_ITEM_TYPE)) {
      NanoflowWidgetActionFactory.ITEM_TYPE_TAB -> handleSelectTask(context, appWidgetId, intent)
      NanoflowWidgetActionFactory.ITEM_TYPE_REFRESH -> handleRefresh(context, appWidgetId)
      NanoflowWidgetActionFactory.ITEM_TYPE_GATE -> handleGateNav(context, appWidgetId, intent)
      NanoflowWidgetActionFactory.ITEM_TYPE_PRIMARY -> handlePrimaryContentClick(context, appWidgetId, intent)
      else -> Unit
    }
  }

  private fun handlePrimaryContentClick(context: Context, appWidgetId: Int, intent: Intent) {
    when (intent.getStringExtra(EXTRA_PRIMARY_ACTION)) {
      WidgetPrimaryAction.OPEN_FOCUS_TOOLS.name -> handleClickOpenFocusTools(
        context,
        Intent(intent).putExtra(EXTRA_APP_WIDGET_ID, appWidgetId),
      )
      else -> handleClickOpenApp(
        context,
        Intent(intent).putExtra(EXTRA_APP_WIDGET_ID, appWidgetId),
      )
    }
  }

  private fun handleSelectTask(context: Context, appWidgetId: Int, intent: Intent) {
    val targetIndex = intent.getIntExtra(EXTRA_TASK_INDEX, -1)
    if (targetIndex < 0) return
    NanoflowWidgetTelemetry.info(
      "widget_click_select_task_tab",
      mapOf("appWidgetId" to appWidgetId, "taskIndex" to targetIndex),
    )
    runBlocking {
      NanoflowWidgetStore(context).persistSelectedTaskIndex(appWidgetId, targetIndex)
      val appWidgetManager = AppWidgetManager.getInstance(context)
      renderAndApply(
        context,
        appWidgetManager,
        NanoflowWidgetRepository(context),
        appWidgetId,
        partialUpdate = true,
      )
      notifyActionListsDataChanged(appWidgetManager, appWidgetId)
    }
  }

  private fun handleRefresh(context: Context, appWidgetId: Int) {
    NanoflowWidgetTelemetry.info(
      "widget_click_refresh",
      mapOf("appWidgetId" to appWidgetId),
    )
    // 不在点击瞬间执行 partiallyUpdateAppWidget：MIUI / HyperOS launcher 收到任何 RemoteViews
    // apply 都会对 AppWidgetHostView 触发 folme 缩放动画，造成「整卡抖动」感。chip 自带的
    // ripple drawable 已经提供了局部点击反馈；worker 完成 fetch 后会做一次完整 update，由
    // buildCompactSyncBadge 基于本地 wall-clock 时间把 sync_badge 重置为「刚刚」。
    NanoflowWidgetRefreshWorker.enqueue(context, reason = "widget-click-refresh")
  }

  private fun handleGateNav(context: Context, appWidgetId: Int, intent: Intent) {
    val delta = intent.getIntExtra(EXTRA_GATE_DELTA, 0)
    if (delta == 0) return
    val eventName = if (delta < 0) "widget_click_previous_blackbox_entry" else "widget_click_next_blackbox_entry"
    runBlocking {
      val repository = NanoflowWidgetRepository(context)
      val pageIndex = repository.shiftGatePage(appWidgetId, delta)
      NanoflowWidgetTelemetry.info(
        eventName,
        mapOf("appWidgetId" to appWidgetId, "pageIndex" to pageIndex),
      )
      val appWidgetManager = AppWidgetManager.getInstance(context)
      renderAndApply(
        context,
        appWidgetManager,
        repository,
        appWidgetId,
        partialUpdate = true,
      )
      notifyActionListsDataChanged(appWidgetManager, appWidgetId)
    }
  }

  // --- 渲染辅助 ---
  private suspend fun renderAndApply(
    context: Context,
    appWidgetManager: AppWidgetManager,
    repository: NanoflowWidgetRepository,
    appWidgetId: Int,
    partialUpdate: Boolean = false,
  ) {
    val model = repository.buildRenderModel(appWidgetId)
    val views = NanoflowWidgetRenderer.render(context, appWidgetId, model)
    if (partialUpdate) {
      appWidgetManager.partiallyUpdateAppWidget(appWidgetId, views)
    } else {
      appWidgetManager.updateAppWidget(appWidgetId, views)
    }
  }

  private fun resolveSizeBucket(options: Bundle): String {
    val minWidth = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 0)
    val minHeight = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 0)
    return when {
      minHeight >= 200 -> "4x3"
      minWidth >= 220 || minHeight >= 120 -> "4x2"
      else -> "2x2"
    }
  }

  companion object {
    // --- 自定义 click action 常量 ---
    const val ACTION_CLICK_OPEN_APP = "app.nanoflow.twa.widget.CLICK_OPEN_APP"
    const val ACTION_CLICK_OPEN_FOCUS_TOOLS = "app.nanoflow.twa.widget.CLICK_OPEN_FOCUS_TOOLS"

    /** 集合视图 item 点击：具体行为由 fillIn 的 EXTRA_ITEM_TYPE 指定。 */
    const val ACTION_CLICK_ITEM = "app.nanoflow.twa.widget.CLICK_ITEM"

    /** 外部 adb / FCM 触发的强制刷新广播。 */
    const val ACTION_FORCE_REFRESH = "app.nanoflow.twa.widget.ACTION_FORCE_REFRESH"

    const val EXTRA_APP_WIDGET_ID = "extra.APP_WIDGET_ID"
    const val EXTRA_ITEM_TYPE = "extra.ITEM_TYPE"
    const val EXTRA_TASK_INDEX = "extra.TASK_INDEX"
    const val EXTRA_GATE_DELTA = "extra.GATE_DELTA"
    const val EXTRA_LIST_KIND = "extra.LIST_KIND"
    const val EXTRA_PRIMARY_ACTION = "extra.PRIMARY_ACTION"

    // --- PendingIntent builders ---
    /**
     * 整卡主点击：直接挂载 `PendingIntent.getActivity()` 指向 [NanoflowTwaLauncherActivity]。
     *
     * 历史实现走 `PendingIntent.getBroadcast()` 中转到 [NanoflowWidgetReceiver]，再由
     * receiver 调用 `context.startActivity(...)`。但从 Android 14 / targetSdk 34+ 开始，
     * BroadcastReceiver 的运行上下文属于 `RECEIVER` 进程状态，receiver 内发起的
     * `startActivity` 不继承 PendingIntent sender（com.miui.home）的 BAL 授权，
     * 会被系统以 `BAL_BLOCK / result code=102` 拒绝，导致 widget 点击后 LauncherActivity
     * 永远启动不起来，widget bootstrap 永远跑不到 `widget-register`，于是 widget 永远
     * 停留在 `binding-missing` 状态（即用户反馈的「无法进行绑定」）。
     *
     * 改为 `getActivity()` 后，PendingIntent 的目标直接就是 Activity，launcher 侧
     * （sender）作为前台应用本就持有 BAL 授权，Android 会按 sender 的授权放行启动，
     * 绕过 receiver 中转，根治 BAL 阻断问题。
     */
    fun primaryActionPendingIntent(
      context: Context,
      appWidgetId: Int,
      action: WidgetPrimaryAction,
    ): PendingIntent {
      val launchIntent = when (action) {
        WidgetPrimaryAction.OPEN_WORKSPACE -> NanoFlowLaunchIntent.OPEN_WORKSPACE
        WidgetPrimaryAction.OPEN_FOCUS_TOOLS -> NanoFlowLaunchIntent.OPEN_FOCUS_TOOLS
      }
      val activityIntent = NanoflowTwaLauncherActivity.intentForWidget(
        context = context,
        appWidgetId = appWidgetId,
        launchIntent = launchIntent,
      )
      // 保留 `widget.CLICK_OPEN_APP` 语义作为 requestCode 维度，避免跨动作共享同一
      // PendingIntent 实例；widgetId + action 组合生成稳定的唯一 requestCode。
      val requestKey = when (action) {
        WidgetPrimaryAction.OPEN_WORKSPACE -> ACTION_CLICK_OPEN_APP
        WidgetPrimaryAction.OPEN_FOCUS_TOOLS -> ACTION_CLICK_OPEN_FOCUS_TOOLS
      }
      val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      return PendingIntent.getActivity(
        context,
        requestCodeFor(appWidgetId, requestKey),
        activityIntent,
        flags,
      )
    }

    /** 集合视图数据源 adapter intent。data Uri 携带 appWidgetId + listKind，防止不同实例/列表共享 factory。 */
    fun actionListAdapterIntent(context: Context, appWidgetId: Int, listKind: String): Intent {
      return Intent(context, NanoflowWidgetActionService::class.java).apply {
        putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId)
        putExtra(EXTRA_LIST_KIND, listKind)
        // 关键：Uri 必须唯一，否则 RemoteViewsAdapter 会在 widget/list 之间共享 factory 造成状态混乱。
        data = Uri.parse("nanoflow://widget/actions/$appWidgetId/$listKind")
      }
    }

    /**
     * 集合视图 item 点击模板 PendingIntent（广播路径）。
     *
     * 仅用于 tabs / refresh / gate 这类「改本地状态、不启动 activity」的列表 —— 这些
     * 交互只在 receiver 内完成 store 更新和 partial update，不触发 BAL。
     *
     * **禁止** 在 content 列表（主点击打开 App）上复用此模板：content 列表每 item 的
     * 点击都需要启动 LauncherActivity，走 receiver 中转会触发 Android 14+ 的
     * BAL_BLOCK。请改用 [contentListClickTemplatePendingIntent]。
     *
     * 注意：模板必须使用 `FLAG_MUTABLE` 以允许 fillIn 合并 extras。
     */
    fun actionListClickTemplatePendingIntent(context: Context, appWidgetId: Int): PendingIntent {
      val template = Intent(context, NanoflowWidgetReceiver::class.java).apply {
        action = ACTION_CLICK_ITEM
        setPackage(context.packageName)
      }
      val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
      return PendingIntent.getBroadcast(
        context,
        requestCodeFor(appWidgetId, ACTION_CLICK_ITEM),
        template,
        flags,
      )
    }

    /**
     * Content 列表点击模板：直接 `getActivity()` 指向 [NanoflowTwaLauncherActivity]。
     *
     * Content 列表目前只含一个 PRIMARY item（整卡主点击的镜像），点击后必须启动
     * LauncherActivity 以触发 widget bootstrap。若继续沿用广播模板 + receiver
     * 中转，会被 Android 14+ BAL 拦截（`callingUidProcState=RECEIVER` 下
     * `startActivity` 不继承 launcher sender 的 BAL 授权）。
     *
     * 这里 template 直接就是 activity 意图，sender（com.miui.home 等前台 launcher）
     * 的 BAL 授权会自然流转到 activity 启动，绕过 receiver 完全消除 BAL 阻断。
     */
    fun contentListClickTemplatePendingIntent(
      context: Context,
      appWidgetId: Int,
      action: WidgetPrimaryAction,
    ): PendingIntent {
      val launchIntent = when (action) {
        WidgetPrimaryAction.OPEN_WORKSPACE -> NanoFlowLaunchIntent.OPEN_WORKSPACE
        WidgetPrimaryAction.OPEN_FOCUS_TOOLS -> NanoFlowLaunchIntent.OPEN_FOCUS_TOOLS
      }
      val template = NanoflowTwaLauncherActivity.intentForWidget(
        context = context,
        appWidgetId = appWidgetId,
        launchIntent = launchIntent,
      )
      // 模板必须 MUTABLE，fillInIntent 才能合并每个 item 的 extras。
      val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
      // requestCode 维度包含 action，避免 OPEN_WORKSPACE / OPEN_FOCUS_TOOLS 共享同一
      // PendingIntent 实例（系统会按 (requestCode, filterEquals) 去重）。
      val requestKey = "content_template|" + when (action) {
        WidgetPrimaryAction.OPEN_WORKSPACE -> "workspace"
        WidgetPrimaryAction.OPEN_FOCUS_TOOLS -> "focus_tools"
      }
      return PendingIntent.getActivity(
        context,
        requestCodeFor(appWidgetId, requestKey),
        template,
        flags,
      )
    }

    private fun broadcastPendingIntent(
      context: Context,
      intentAction: String,
      requestCode: Int,
      extras: Map<String, Any>,
    ): PendingIntent {
      val intent = Intent(context, NanoflowWidgetReceiver::class.java).apply {
        action = intentAction
        setPackage(context.packageName)
        extras.forEach { (key, value) ->
          when (value) {
            is Int -> putExtra(key, value)
            is String -> putExtra(key, value)
            is Long -> putExtra(key, value)
            is Boolean -> putExtra(key, value)
          }
        }
      }
      val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      return PendingIntent.getBroadcast(context, requestCode, intent, flags)
    }

    private fun requestCodeFor(appWidgetId: Int, key: Any): Int {
      return (appWidgetId.toString() + "|" + key.toString()).hashCode()
    }

    fun hasInstalledWidgets(context: Context): Boolean {
      val appWidgetManager = AppWidgetManager.getInstance(context)
      val componentName = ComponentName(context, NanoflowWidgetReceiver::class.java)
      return appWidgetManager.getAppWidgetIds(componentName).isNotEmpty()
    }

    fun hasInstalledWidgets(context: Context, appWidgetId: Int): Boolean {
      val appWidgetManager = AppWidgetManager.getInstance(context)
      val componentName = ComponentName(context, NanoflowWidgetReceiver::class.java)
      return appWidgetManager.getAppWidgetIds(componentName).contains(appWidgetId)
    }

    /** 从外部（Worker / FCM / bootstrap）触发所有 widget 重新渲染 + 通知集合数据失效。 */
    fun refreshAllWidgets(context: Context) {
      val appWidgetManager = AppWidgetManager.getInstance(context)
      val componentName = ComponentName(context, NanoflowWidgetReceiver::class.java)
      val ids = appWidgetManager.getAppWidgetIds(componentName)
      if (ids.isEmpty()) return
      runBlocking {
        val repository = NanoflowWidgetRepository(context)
        ids.forEach { widgetId ->
          val model = repository.buildRenderModel(widgetId)
          val views = NanoflowWidgetRenderer.render(context, widgetId, model)
          // 关键减抖点：worker 完成 fetch 后只走 partiallyUpdateAppWidget（=RemoteViews.reapply），
          // 这条路径不会让 AppWidgetHostView 重新 inflate / 重新 bind，从而避开 MIUI / HyperOS
          // launcher 在 LauncherAppWidgetHostView.updateAppWidget 里挂载的 folme 缩放动画。
          // 同时不调用 notifyAppWidgetViewDataChanged：refresh 不改变 chip 集合（仅文本/选中态变化），
          // 跳过 adapter rebind 也能消除一次额外的 host view 更新事件。
          appWidgetManager.partiallyUpdateAppWidget(widgetId, views)
          notifyActionListsDataChanged(appWidgetManager, widgetId)
        }
      }
    }

    /** 同时刷新 widget 内两个集合视图（content + refresh）的数据。 */
    fun notifyActionListsDataChanged(appWidgetManager: AppWidgetManager, appWidgetId: Int) {
      appWidgetManager.notifyAppWidgetViewDataChanged(appWidgetId, R.id.nano_widget_content_list)
      appWidgetManager.notifyAppWidgetViewDataChanged(appWidgetId, R.id.nano_widget_refresh_list)
    }
  }
}
