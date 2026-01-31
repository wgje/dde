/**
 * Flow Services barrel export
 * 流程图相关服务导出
 * 
 * 服务职责：
 * - FlowDiagramService: 核心图表管理（含 Overview 小地图）
 * - FlowDiagramConfigService: GoJS 配置（布局、工具、样式）
 * - FlowEventService: 事件处理与分发
 * - FlowSelectionService: 选择管理
 * - FlowZoomService: 缩放与视口控制
 * - FlowLayoutService: 布局算法
 * - FlowTemplateService: GoJS 模板定义
 * - FlowDragDropService: 拖放交互
 * - FlowTouchService: 触摸手势
 * - FlowLinkService: 连接线管理
 * - FlowTaskOperationsService: 任务操作
 * - FlowCommandService: Shell 与 FlowView 的解耦通信
 * - MinimapMathService: 小地图数学计算
 * - ReactiveMinimapService: 响应式小地图
 */

// 核心服务
export { FlowDiagramService } from './flow-diagram.service';
export { FlowDiagramConfigService } from './flow-diagram-config.service';

// 事件与选择
export { FlowEventService } from './flow-event.service';
export { FlowSelectionService } from './flow-selection.service';
export { FlowZoomService } from './flow-zoom.service';
export { FlowLayoutService } from './flow-layout.service';

// 模板与事件总线
export { FlowTemplateService } from './flow-template.service';
export * from './flow-template-events';

// 交互服务
export { FlowDragDropService } from './flow-drag-drop.service';
export type { InsertPositionInfo } from './flow-drag-drop.service';
export { FlowTouchService } from './flow-touch.service';
export { FlowLinkService } from './flow-link.service';
export { FlowTaskOperationsService } from './flow-task-operations.service';

// 命令与通信服务
export { FlowCommandService, FlowCommandType, type FlowCommand, type CenterNodePayload } from './flow-command.service';

// 小地图服务
export { MinimapMathService, type WorldPoint, type MinimapPoint, type WorldBounds, type MinimapState, type DragSession, type RealTimeScaleResult, type VirtualBoundsResult } from './minimap-math.service';
export { ReactiveMinimapService, type MinimapElements, type NodePosition as MinimapNodePosition, type MainCanvasViewport, type ReactiveDragSession, type MinimapTransform } from './reactive-minimap.service';

// 移动端抽屉手势服务
export { MobileDrawerGestureService } from './mobile-drawer-gesture.service';
