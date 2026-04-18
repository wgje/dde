package app.nanoflow.host

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.json.JsonNames

@Serializable
data class WidgetFocusSummary(
  val active: Boolean = false,
  val taskId: String? = null,
  val projectId: String? = null,
  val projectTitle: String? = null,
  val title: String? = null,
  val remainingMinutes: Int? = null,
  val valid: Boolean = false,
)

@Serializable
data class WidgetGatePreview(
  val entryId: String? = null,
  val projectId: String? = null,
  val projectTitle: String? = null,
  val content: String? = null,
  val createdAt: String? = null,
  val valid: Boolean = false,
)

@Serializable
data class WidgetDockItem(
  val taskId: String? = null,
  val projectId: String? = null,
  val title: String? = null,
  val projectTitle: String? = null,
  val estimatedMinutes: Int? = null,
  val valid: Boolean = false,
)

@Serializable
data class WidgetDockSummary(
  val count: Int = 0,
  val countFromTasks: Int = 0,
  val items: List<WidgetDockItem> = emptyList(),
)

@OptIn(ExperimentalSerializationApi::class)
@Serializable
data class WidgetBlackBoxSummary(
  @SerialName("pendingCount")
  val pendingCount: Int = 0,
  @JsonNames("previews", "entries", "items")
  val previews: List<WidgetGatePreview> = emptyList(),
  val gatePreview: WidgetGatePreview = WidgetGatePreview(),
)

@Serializable
data class WidgetSummaryResponse(
  val schemaVersion: Int = 1,
  val summaryVersion: String? = null,
  val cloudUpdatedAt: String? = null,
  val freshnessState: String = "stale",
  val trustState: String = "untrusted",
  val sourceState: String = "cache-only",
  val consistencyState: String? = null,
  val degradedReasons: List<String> = emptyList(),
  val warnings: List<String> = emptyList(),
  val entryUrl: String = "",
  val focus: WidgetFocusSummary = WidgetFocusSummary(),
  val dock: WidgetDockSummary = WidgetDockSummary(),
  val blackBox: WidgetBlackBoxSummary = WidgetBlackBoxSummary(),
  val code: String? = null,
  val error: String? = null,
  val retryAfterSeconds: Int? = null,
)

data class WidgetDeviceIdentity(
  val installationId: String,
  val deviceId: String,
  val deviceSecret: String,
)

data class StoredWidgetBinding(
  val widgetToken: String,
  val deviceId: String,
  val bindingGeneration: Int,
  val expiresAt: String,
)

data class PendingBootstrapState(
  val nonce: String,
  val issuedAtMs: Long,
)

enum class WidgetPrimaryAction {
  OPEN_WORKSPACE,
  OPEN_FOCUS_TOOLS,
}

enum class WidgetVisualTone {
  SETUP,
  AUTH,
  UNTRUSTED,
  GATE,
  FOCUS,
}

/**
 * 小组件尺寸档位（基于 hostsystem 上报的 min size 推断）。
 * - SMALL  : 约 2x2，仅展示模式 + 标题 + 一行状态 + 主操作
 * - MEDIUM : 约 4x2，展示模式/徽章/标题/辅助/计数/主操作（精简）
 * - LARGE  : 约 4x3+，展示完整内容（含状态卡、刷新按钮、分页）
 */
enum class WidgetSizeTier {
  SMALL,
  MEDIUM,
  LARGE,
}

data class WidgetRenderModel(
  val modeLabel: String,
  val statusBadge: String?,
  val title: String,
  val supportingLine: String?,
  val metricsLine: String?,
  val statusLine: String,
  val primaryActionLabel: String,
  val primaryAction: WidgetPrimaryAction,
  val tone: WidgetVisualTone,
  val dockCount: Int,
  val blackBoxCount: Int,
  val showStatCards: Boolean,
  val isGateMode: Boolean,
  val showGatePager: Boolean,
  val gatePageIndicator: String?,
  val canPageBackward: Boolean,
  val canPageForward: Boolean,
  val compact: Boolean,
  val sizeTier: WidgetSizeTier,
  val showSetup: Boolean,
  val showAuthRequired: Boolean,
  val showUntrusted: Boolean,
)
