package app.nanoflow.host

import android.appwidget.AppWidgetManager
import android.content.Context
import android.os.Bundle
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import kotlinx.coroutines.runBlocking

class NanoflowWidgetReceiver : GlanceAppWidgetReceiver() {
  override val glanceAppWidget: GlanceAppWidget = NanoflowGlanceWidget()

  override fun onUpdate(context: Context, appWidgetManager: AppWidgetManager, appWidgetIds: IntArray) {
    super.onUpdate(context, appWidgetManager, appWidgetIds)
    runBlocking {
      val store = NanoflowWidgetStore(context)
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
    super.onAppWidgetOptionsChanged(context, appWidgetManager, appWidgetId, newOptions)
    runBlocking {
      val store = NanoflowWidgetStore(context)
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
    }
    NanoflowWidgetRefreshWorker.syncPeriodicRefresh(context, hasInstalledWidgets(context))
    NanoflowWidgetRefreshWorker.enqueue(context, reason = "receiver-options-changed")
  }

  override fun onDeleted(context: Context, appWidgetIds: IntArray) {
    super.onDeleted(context, appWidgetIds)
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
    NanoflowWidgetRefreshWorker.syncPeriodicRefresh(
      context,
      hasWidgetsRemaining,
    )
  }

  override fun onDisabled(context: Context) {
    super.onDisabled(context)
    NanoflowWidgetTelemetry.info("widget_instance_uninstall_all")
    runBlocking {
      NanoflowWidgetStore(context).clearAllWidgetState(clearPendingPushToken = true)
    }
    NanoflowWidgetRefreshWorker.syncPeriodicRefresh(context, enabled = false)
  }

  private fun resolveSizeBucket(options: Bundle): String {
    val minWidth = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 0)
    val minHeight = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 0)
    // 三档判定：高度 ≥ 200dp 视作 4x3 大尺寸；其余按宽 / 高阈值落入 4x2 或 2x2
    return when {
      minHeight >= 200 -> "4x3"
      minWidth >= 220 || minHeight >= 120 -> "4x2"
      else -> "2x2"
    }
  }

  companion object {
    fun hasInstalledWidgets(context: Context): Boolean {
      val appWidgetManager = AppWidgetManager.getInstance(context)
      val componentName = android.content.ComponentName(context, NanoflowWidgetReceiver::class.java)
      return appWidgetManager.getAppWidgetIds(componentName).isNotEmpty()
    }

    fun hasInstalledWidgets(context: Context, appWidgetId: Int): Boolean {
      val appWidgetManager = AppWidgetManager.getInstance(context)
      val componentName = android.content.ComponentName(context, NanoflowWidgetReceiver::class.java)
      return appWidgetManager.getAppWidgetIds(componentName).contains(appWidgetId)
    }
  }
}
