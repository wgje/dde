package app.nanoflow.host

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.GlanceTheme
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.LocalContext
import androidx.glance.action.clickable
import androidx.glance.appwidget.appWidgetBackground
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.glance.appwidget.action.actionRunCallback
import androidx.glance.background
import androidx.glance.appwidget.components.FilledButton
import androidx.glance.layout.Box
import androidx.glance.appwidget.provideContent
import androidx.glance.layout.Column
import androidx.glance.layout.Spacer
import androidx.glance.layout.Row
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.width
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider

class NanoflowGlanceWidget : GlanceAppWidget() {
  override suspend fun provideGlance(context: Context, id: GlanceId) {
    val appWidgetId = GlanceAppWidgetManager(context).getAppWidgetId(id)
    val repository = NanoflowWidgetRepository(context)
    val model = repository.buildRenderModel(appWidgetId)

    provideContent {
      GlanceTheme {
        WidgetContent(model)
      }
    }
  }

  @Composable
  private fun WidgetContent(model: WidgetRenderModel) {
    val palette = paletteFor(model.tone)
    val primaryAction = primaryActionFor(model)

    // 外层圆角描边 + 内部表面：所有尺寸共用，整面可点击触发主操作（突出主体）
    val innerPadding = when (model.sizeTier) {
      WidgetSizeTier.SMALL -> 12.dp
      WidgetSizeTier.MEDIUM -> 14.dp
      WidgetSizeTier.LARGE -> 16.dp
    }
    Box(
      modifier = GlanceModifier
        .fillMaxSize()
        .appWidgetBackground()
        .background(ColorProvider(palette.borderColor))
        .cornerRadius(28.dp)
        .padding(1.dp)
        .clickable(primaryAction),
    ) {
      Box(
        modifier = GlanceModifier
          .fillMaxSize()
          .background(ColorProvider(palette.surfaceColor))
          .cornerRadius(27.dp)
          .padding(innerPadding),
      ) {
        when (model.sizeTier) {
          WidgetSizeTier.SMALL -> SmallContent(model, palette)
          WidgetSizeTier.MEDIUM -> MediumContent(model, palette)
          WidgetSizeTier.LARGE -> LargeContent(model, palette)
        }
      }
    }
  }

  // SMALL（约 2x2）：极简——仅模式标签 + 大标题，整面可点开主操作
  @Composable
  private fun SmallContent(model: WidgetRenderModel, palette: WidgetPalette) {
    Column(modifier = GlanceModifier.fillMaxSize()) {
      Text(
        text = model.modeLabel,
        style = TextStyle(
          color = ColorProvider(palette.accentColor),
          fontSize = 10.sp,
        ),
        maxLines = 1,
      )
      Spacer(modifier = GlanceModifier.height(6.dp))
      Text(
        text = model.title,
        style = TextStyle(
          color = ColorProvider(palette.titleColor),
          fontSize = 16.sp,
        ),
        maxLines = 3,
      )
    }
  }

  // MEDIUM（约 4x2）：模式标签 + 大标题（主体）+ 一行辅助；分页存在时显示
  @Composable
  private fun MediumContent(model: WidgetRenderModel, palette: WidgetPalette) {
    val context = LocalContext.current
    val previousGateAction = actionRunCallback<ShowPreviousBlackBoxEntryAction>()
    val nextGateAction = actionRunCallback<ShowNextBlackBoxEntryAction>()
    // 单行辅助：优先 supportingLine，回退到 statusLine，避免冗余
    val supporting = model.supportingLine?.takeIf { it.isNotBlank() } ?: model.statusLine

    Column(modifier = GlanceModifier.fillMaxSize()) {
      Text(
        text = model.modeLabel,
        style = TextStyle(
          color = ColorProvider(palette.accentColor),
          fontSize = 11.sp,
        ),
        maxLines = 1,
      )
      Spacer(modifier = GlanceModifier.height(4.dp))
      Text(
        text = model.title,
        style = TextStyle(
          color = ColorProvider(palette.titleColor),
          fontSize = 18.sp,
        ),
        maxLines = 2,
      )
      if (supporting.isNotBlank()) {
        Spacer(modifier = GlanceModifier.height(4.dp))
        Text(
          text = supporting,
          style = TextStyle(
            color = ColorProvider(palette.supportingColor),
            fontSize = 11.sp,
          ),
          maxLines = 1,
        )
      }
      if (model.showGatePager && !model.gatePageIndicator.isNullOrBlank()) {
        Spacer(modifier = GlanceModifier.height(8.dp))
        GatePagerRow(model, palette, context, previousGateAction, nextGateAction)
      }
    }
  }

  // LARGE（约 4x3+）：模式标签 + 巨大标题 + 辅助 + 状态 + 分页 + 刷新按钮
  @Composable
  private fun LargeContent(model: WidgetRenderModel, palette: WidgetPalette) {
    val context = LocalContext.current
    val previousGateAction = actionRunCallback<ShowPreviousBlackBoxEntryAction>()
    val nextGateAction = actionRunCallback<ShowNextBlackBoxEntryAction>()

    Column(modifier = GlanceModifier.fillMaxSize()) {
      Text(
        text = model.modeLabel,
        style = TextStyle(
          color = ColorProvider(palette.accentColor),
          fontSize = 12.sp,
        ),
        maxLines = 1,
      )
      Spacer(modifier = GlanceModifier.height(6.dp))
      Text(
        text = model.title,
        style = TextStyle(
          color = ColorProvider(palette.titleColor),
          fontSize = 22.sp,
        ),
        maxLines = 3,
      )
      if (!model.supportingLine.isNullOrBlank()) {
        Spacer(modifier = GlanceModifier.height(6.dp))
        Text(
          text = model.supportingLine,
          style = TextStyle(
            color = ColorProvider(palette.supportingColor),
            fontSize = 12.sp,
          ),
          maxLines = 2,
        )
      }
      if (model.statusLine.isNotBlank()) {
        Spacer(modifier = GlanceModifier.height(6.dp))
        Text(
          text = model.statusLine,
          style = TextStyle(
            color = ColorProvider(palette.accentColor),
            fontSize = 11.sp,
          ),
          maxLines = 2,
        )
      }
      if (model.showGatePager && !model.gatePageIndicator.isNullOrBlank()) {
        Spacer(modifier = GlanceModifier.height(10.dp))
        GatePagerRow(model, palette, context, previousGateAction, nextGateAction)
      }
      Spacer(modifier = GlanceModifier.height(10.dp))
      FilledButton(
        text = context.getString(R.string.nanoflow_widget_refresh),
        onClick = actionRunCallback<RefreshWidgetAction>(),
        maxLines = 1,
      )
    }
  }

  @Composable
  private fun GatePagerRow(
    model: WidgetRenderModel,
    palette: WidgetPalette,
    context: Context,
    previousGateAction: androidx.glance.action.Action,
    nextGateAction: androidx.glance.action.Action,
  ) {
    Row(modifier = GlanceModifier.fillMaxWidth()) {
      if (model.canPageBackward) {
        FilledButton(
          text = context.getString(R.string.nanoflow_widget_previous_entry),
          onClick = previousGateAction,
          maxLines = 1,
        )
        Spacer(modifier = GlanceModifier.width(6.dp))
      }
      LabelChip(
        text = model.gatePageIndicator ?: "",
        backgroundColor = palette.metricSurfaceColor,
        textColor = palette.accentColor,
      )
      if (model.canPageForward) {
        Spacer(modifier = GlanceModifier.width(6.dp))
        FilledButton(
          text = context.getString(R.string.nanoflow_widget_next_entry),
          onClick = nextGateAction,
          maxLines = 1,
        )
      }
    }
  }

  @Composable
  private fun primaryActionFor(model: WidgetRenderModel): androidx.glance.action.Action {
    return when (model.primaryAction) {
      WidgetPrimaryAction.OPEN_WORKSPACE -> actionRunCallback<OpenWorkspaceAction>()
      WidgetPrimaryAction.OPEN_FOCUS_TOOLS -> actionRunCallback<OpenFocusToolsAction>()
    }
  }

  @Composable
  private fun MetricPill(
    value: String,
    label: String,
    backgroundColor: Color,
    valueColor: Color,
    labelColor: Color,
  ) {
    Box(
      modifier = GlanceModifier
        .background(ColorProvider(backgroundColor))
        .cornerRadius(16.dp)
        .padding(horizontal = 10.dp, vertical = 8.dp),
    ) {
      Row {
        Text(
          text = value,
          style = TextStyle(
            color = ColorProvider(valueColor),
            fontSize = 14.sp,
          ),
          maxLines = 1,
        )
        Spacer(modifier = GlanceModifier.width(4.dp))
        Text(
          text = label,
          style = TextStyle(
            color = ColorProvider(labelColor),
            fontSize = 10.sp,
          ),
          maxLines = 1,
        )
      }
    }
  }

  @Composable
  private fun LabelChip(
    text: String,
    backgroundColor: Color,
    textColor: Color,
  ) {
    Box(
      modifier = GlanceModifier
        .background(ColorProvider(backgroundColor))
        .cornerRadius(999.dp)
        .padding(horizontal = 10.dp, vertical = 5.dp),
    ) {
      Text(
        text = text,
        style = TextStyle(
          color = ColorProvider(textColor),
          fontSize = 11.sp,
        ),
        maxLines = 1,
      )
    }
  }

  private fun paletteFor(tone: WidgetVisualTone): WidgetPalette {
    return when (tone) {
      WidgetVisualTone.SETUP -> WidgetPalette(
        borderColor = Color(0xFFE5BE95),
        surfaceColor = Color(0xFFFFF8F1),
        accentColor = Color(0xFFA45B1B),
        titleColor = Color(0xFF3D2412),
        supportingColor = Color(0xFF876243),
        statusSurfaceColor = Color(0xFFF7E8D8),
        badgeSurfaceColor = Color(0xFFF3E0CB),
        badgeTextColor = Color(0xFF8A4B15),
        metricSurfaceColor = Color(0xFFF8ECDC),
      )
      WidgetVisualTone.AUTH -> WidgetPalette(
        borderColor = Color(0xFFE5B0B0),
        surfaceColor = Color(0xFFFFF5F5),
        accentColor = Color(0xFFA74242),
        titleColor = Color(0xFF481B1B),
        supportingColor = Color(0xFF8B5F5F),
        statusSurfaceColor = Color(0xFFF7E4E4),
        badgeSurfaceColor = Color(0xFFF4D8D8),
        badgeTextColor = Color(0xFF933737),
        metricSurfaceColor = Color(0xFFF7EAEA),
      )
      WidgetVisualTone.UNTRUSTED -> WidgetPalette(
        borderColor = Color(0xFFCBD8DD),
        surfaceColor = Color(0xFFF5FAFB),
        accentColor = Color(0xFF496775),
        titleColor = Color(0xFF1E3138),
        supportingColor = Color(0xFF6B8088),
        statusSurfaceColor = Color(0xFFE5EEF1),
        badgeSurfaceColor = Color(0xFFDCE9ED),
        badgeTextColor = Color(0xFF3E5D69),
        metricSurfaceColor = Color(0xFFEAF1F3),
      )
      WidgetVisualTone.GATE -> WidgetPalette(
        borderColor = Color(0xFFE3A163),
        surfaceColor = Color(0xFFFFF4E8),
        accentColor = Color(0xFFA65A23),
        titleColor = Color(0xFF422516),
        supportingColor = Color(0xFF8A5C38),
        statusSurfaceColor = Color(0xFFF7E3D1),
        badgeSurfaceColor = Color(0xFFF3D9C1),
        badgeTextColor = Color(0xFF944D18),
        metricSurfaceColor = Color(0xFFF9EBDD),
      )
      WidgetVisualTone.FOCUS -> WidgetPalette(
        borderColor = Color(0xFF85C0AA),
        surfaceColor = Color(0xFFEEF8F3),
        accentColor = Color(0xFF186C58),
        titleColor = Color(0xFF14382F),
        supportingColor = Color(0xFF557268),
        statusSurfaceColor = Color(0xFFDCEEE7),
        badgeSurfaceColor = Color(0xFFD3E7DE),
        badgeTextColor = Color(0xFF135744),
        metricSurfaceColor = Color(0xFFE4F2EC),
      )
    }
  }
}

private data class WidgetPalette(
  val borderColor: Color,
  val surfaceColor: Color,
  val accentColor: Color,
  val titleColor: Color,
  val supportingColor: Color,
  val statusSurfaceColor: Color,
  val badgeSurfaceColor: Color,
  val badgeTextColor: Color,
  val metricSurfaceColor: Color,
)
