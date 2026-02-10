/**
 * GoJS 边界类型定义（纯接口，无 GoJS 运行时依赖）
 * 
 * 【性能优化 2026-02-07】移除 `import * as go from 'gojs'`，
 * 运行时转换函数已迁移到 src/app/features/flow/types/gojs-runtime.ts
 * 
 * "边境检查站"策略：
 * - 对外严格：业务数据进入 GoJS 之前必须是强类型接口
 * - 对内宽容：GoJS 内部操作允许使用 any 或简单类型断言
 * 
 * 这个文件仅定义业务层与 GoJS 层之间的数据转换接口类型 * @see types/gojs-extended.d.ts GoJS 运行时类型扩展（包含 GoJS 依赖） */

// ============================================
// 业务层 -> GoJS 层的数据转换接口
// ============================================

/**
 * GoJS 节点数据（用于 nodeDataArray）
 * 这是从业务 Task 转换后的 GoJS 可用格式
 */
export interface GojsNodeData {
  /** 节点唯一标识，对应 Task.id */
  key: string;
  /** 显示标题 */
  title: string;
  /** 显示 ID (如 "1,a") */
  displayId: string;
  /** 阶段编号 */
  stage: number | null;
  /** GoJS 位置字符串 "x y" */
  loc: string;
  /** 节点背景色 */
  color: string;
  /** 边框颜色 */
  borderColor: string;
  /** 边框宽度 */
  borderWidth: number;
  /** 标题文字颜色 */
  titleColor: string;
  /** displayId 文字颜色 */
  displayIdColor: string;
  /** 选中时的边框颜色 */
  selectedBorderColor: string;
  /** 是否为未分配任务 */
  isUnassigned: boolean;
  /** 是否匹配当前搜索 */
  isSearchMatch: boolean;
  /** 选中状态（由 GoJS 管理） */
  isSelected: boolean;
}

/**
 * GoJS 连接线数据（用于 linkDataArray）
 */
export interface GojsLinkData {
  /** 连接唯一标识 */
  key: string;
  /** 源节点 ID */
  from: string;
  /** 目标节点 ID */
  to: string;
  /** 是否为跨树连接（虚线显示） */
  isCrossTree: boolean;
  /** 连接描述（仅跨树连接有） */
  description?: string;
}

/**
 * GoJS 图表数据包
 */
export interface GojsDiagramData {
  nodeDataArray: GojsNodeData[];
  linkDataArray: GojsLinkData[];
}

// ============================================
// GoJS 事件数据类型（从 GoJS 出来的数据）
// ============================================

/**
 * GoJS 节点移动事件数据
 * 从 GoJS 事件中提取的位置信息
 */
export interface GojsNodeMoveData {
  taskId: string;
  x: number;
  y: number;
}

/**
 * GoJS 连接创建事件数据
 */
export interface GojsLinkCreateData {
  sourceId: string;
  targetId: string;
  midPoint?: { x: number; y: number };
}

/**
 * GoJS 选择变更数据
 */
export interface GojsSelectionData {
  selectedNodeIds: string[];
  selectedLinkKeys: string[];
}

// ============================================
// 运行时转换函数已迁移
// ============================================
// 【性能优化 2026-02-07】以下函数已迁移到 flow 懒加载区域：
// src/app/features/flow/types/gojs-runtime.ts
// - taskToGojsNode
// - connectionToGojsLink
// - parentChildToGojsLink
// - extractNodeMoveData
// - extractLinkCreateData
// - extractSelectionData
