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
      notifyTabListDataChanged(appWidgetManager, appWidgetId)
      notifyContentListDataChanged(appWidgetManager, appWidgetId)
    }
  }

  private fun handleRefresh(context: Context, appWidgetId: Int) {
    NanoflowWidgetTelemetry.info(
      "widget_click_refresh",
      mapOf("appWidgetId" to appWidgetId),
    )
    // 只刷新 refresh 集合本身，让用户立刻看到“刷新中”而不触发整卡 RemoteViews reapply。
    // 真正的数据渲染仍交给 worker 完成后的 partial update，以避免点击瞬间整卡抖动。
    runBlocking {
      NanoflowWidgetStore(context).persistRefreshPending(appWidgetId, true)
      notifyRefreshListDataChanged(AppWidgetManager.getInstance(context), appWidgetId)
    }
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
      notifyTabListDataChanged(appWidgetManager, appWidgetId)
      notifyContentListDataChanged(appWidgetManager, appWidgetId)
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
    fun primaryActionPendingIntent(
      context: Context,
      appWidgetId: Int,
      action: WidgetPrimaryAction,
    ): PendingIntent {
      val intentAction = when (action) {
        WidgetPrimaryAction.OPEN_WORKSPACE -> ACTION_CLICK_OPEN_APP
        WidgetPrimaryAction.OPEN_FOCUS_TOOLS -> ACTION_CLICK_OPEN_FOCUS_TOOLS
      }
      return broadcastPendingIntent(
        context = context,
        intentAction = intentAction,
        requestCode = requestCodeFor(appWidgetId, intentAction),
        extras = mapOf<String, Any>(EXTRA_APP_WIDGET_ID to appWidgetId),
      )
    }

    /** 集合视图数据源 adapter intent。data Uri 携带 appWidgetId+listKind，防止不同实例/列表共享 factory。 */
    fun actionListAdapterIntent(context: Context, appWidgetId: Int, listKind: String): Intent {
      return Intent(context, NanoflowWidgetActionService::class.java).apply {
        putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId)
        putExtra(EXTRA_LIST_KIND, listKind)
        // 关键：Uri 必须唯一，否则 RemoteViewsAdapter 会在 widget/list 之间共享 factory 造成状态混乱。
        data = Uri.parse("nanoflow://widget/actions/$appWidgetId/$listKind")
      }
    }

    /**
     * 集合视图 item 点击模板 PendingIntent。
     * 构造时 Intent 的 extras 只包含基础字段，item 侧通过 fillInIntent 补齐具体 EXTRA_ITEM_TYPE 等。
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
        val store = NanoflowWidgetStore(context)
        ids.forEach { widgetId ->
          store.persistRefreshPending(widgetId, false)
          val model = repository.buildRenderModel(widgetId)
          val views = NanoflowWidgetRenderer.render(context, widgetId, model)
          // 关键减抖点：worker 完成 fetch 后只走 partiallyUpdateAppWidget（=RemoteViews.reapply），
          // 这条路径不会让 AppWidgetHostView 重新 inflate / 重新 bind，从而避开 MIUI / HyperOS
          // launcher 在 LauncherAppWidgetHostView.updateAppWidget 里挂载的 folme 缩放动画。
          appWidgetManager.partiallyUpdateAppWidget(widgetId, views)
          notifyTabListDataChanged(appWidgetManager, widgetId)
          notifyContentListDataChanged(appWidgetManager, widgetId)
          notifyRefreshListDataChanged(appWidgetManager, widgetId)
        }
      }
    }

    /** 同时刷新 widget 内两个集合视图（tabs + refresh）的数据。 */
    fun notifyActionListsDataChanged(appWidgetManager: AppWidgetManager, appWidgetId: Int) {
      notifyTabListDataChanged(appWidgetManager, appWidgetId)
      notifyContentListDataChanged(appWidgetManager, appWidgetId)
      notifyRefreshListDataChanged(appWidgetManager, appWidgetId)
    }

    fun notifyTabListDataChanged(appWidgetManager: AppWidgetManager, appWidgetId: Int) {
      appWidgetManager.notifyAppWidgetViewDataChanged(appWidgetId, R.id.nano_widget_tab_list)
    }

    fun notifyRefreshListDataChanged(appWidgetManager: AppWidgetManager, appWidgetId: Int) {
      appWidgetManager.notifyAppWidgetViewDataChanged(appWidgetId, R.id.nano_widget_refresh_list)
    }

    fun notifyContentListDataChanged(appWidgetManager: AppWidgetManager, appWidgetId: Int) {
      appWidgetManager.notifyAppWidgetViewDataChanged(appWidgetId, R.id.nano_widget_content_list)
    }
  }
}
