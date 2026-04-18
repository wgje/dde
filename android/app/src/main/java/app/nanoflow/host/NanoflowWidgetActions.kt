package app.nanoflow.host

import android.content.Context
import androidx.glance.appwidget.updateAll
import androidx.glance.GlanceId
import androidx.glance.action.ActionParameters
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.glance.appwidget.action.ActionCallback

class OpenWorkspaceAction : ActionCallback {
  override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
    val appWidgetId = GlanceAppWidgetManager(context).getAppWidgetId(glanceId)
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
}

class OpenFocusToolsAction : ActionCallback {
  override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
    val appWidgetId = GlanceAppWidgetManager(context).getAppWidgetId(glanceId)
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
}

class ShowPreviousBlackBoxEntryAction : ActionCallback {
  override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
    shiftGatePage(context, glanceId, -1, "widget_click_previous_blackbox_entry")
  }
}

class ShowNextBlackBoxEntryAction : ActionCallback {
  override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
    shiftGatePage(context, glanceId, 1, "widget_click_next_blackbox_entry")
  }
}

class RefreshWidgetAction : ActionCallback {
  override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
    NanoflowWidgetTelemetry.info(
      "widget_click_refresh",
      mapOf("appWidgetId" to GlanceAppWidgetManager(context).getAppWidgetId(glanceId)),
    )
    NanoflowWidgetRefreshWorker.enqueue(context, reason = "glance-action-refresh")
  }
}

private suspend fun shiftGatePage(
  context: Context,
  glanceId: GlanceId,
  delta: Int,
  event: String,
) {
  val appWidgetId = GlanceAppWidgetManager(context).getAppWidgetId(glanceId)
  val pageIndex = NanoflowWidgetRepository(context).shiftGatePage(appWidgetId, delta)
  NanoflowWidgetTelemetry.info(
    event,
    mapOf(
      "appWidgetId" to appWidgetId,
      "pageIndex" to pageIndex,
    ),
  )
  NanoflowGlanceWidget().updateAll(context)
}
