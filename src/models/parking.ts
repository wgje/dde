// ============================================
// State Overlap — 停泊功能类型定义
// 策划案 A4 数据模型规范
// ============================================

/**
 * 停泊元数据
 * 附加在 Task 上，表示任务的停泊状态
 *
 * 不变量：同一用户同一时刻最多 1 个 state:'focused' 的停泊任务
 * 仅 Task.status === 'active' 的任务可持有 parkingMeta
 */
export interface TaskParkingMeta {
  /**
   * 当前/稍后两态
   * ⚠️ 使用 'focused' 而非 'active'——因为 Task.status 已有 'active' 表示"未完成"，
   * 两者含义完全不同，混用会在代码中造成歧义
   */
  state: 'focused' | 'parked';
  /** 进入 parked 的时间（ISO 字符串） */
  parkedAt: string | null;
  /** 最近访问时间（用于衰老清理计时，预览/点击都会刷新） */
  lastVisitedAt: string | null;
  /** 上下文快照 */
  contextSnapshot: ParkingSnapshot | null;
  /** 提醒元数据 */
  reminder: ParkingReminder | null;
  /** 衰老豁免标记——true 时跳过 72h 衰老清理 */
  pinned: boolean;
}

/**
 * 上下文快照（跨设备稳定）
 * 保存切走时的物理上下文，切回时用于恢复
 */
export interface ParkingSnapshot {
  /** 快照保存时间 */
  savedAt: string;
  /** 内容哈希——用于检测内容是否在停泊期间被修改 */
  contentHash: string;
  /** 保存快照时的视图模式，用于跨设备恢复降级判定 */
  viewMode: 'text' | 'flow';
  /** 光标位置（仅 text 视图有值） */
  cursorPosition: { line: number; column: number } | null;
  /** 滚动锚点 */
  scrollAnchor: ParkingScrollAnchor | null;
  /** 结构锚点——用于跨屏幕/跨设备恢复 */
  structuralAnchor: ParkingStructuralAnchor | null;
  /**
   * Flow 视图专用：GoJS 视口和选中节点状态
   * 仅当 viewMode === 'flow' 时有值
   * ⚠️ 不保存绝对 centerX/centerY——跨屏幕尺寸恢复时绝对坐标无意义，
   * 以 selectedNodeId 为锚点可在任意屏幕尺寸上正确定位
   */
  flowViewport: ParkingFlowViewport | null;
}

/** 滚动锚点 */
export interface ParkingScrollAnchor {
  anchorType: 'heading' | 'line';
  anchorIndex: number;
  anchorOffset?: number;
  /** fallback 百分比 0..1 */
  scrollPercent: number;
}

/**
 * 结构锚点
 * 简化为四类：heading（Markdown 标题）、gojs-node（流程图节点）、line（行号定位）、fallback
 */
export interface ParkingStructuralAnchor {
  type: 'heading' | 'gojs-node' | 'line' | 'fallback';
  label: string;
  line?: number;
}

/** Flow 视图视口快照 */
export interface ParkingFlowViewport {
  scale: number;
  selectedNodeId: string | null;
}

/**
 * 提醒元数据
 */
export interface ParkingReminder {
  /** 提醒触发时间（ISO 字符串） */
  reminderAt: string;
  /** 已 snooze 次数 */
  snoozeCount: number;
  /** snooze 软上限（默认 5） */
  maxSnoozeCount: number;
}

/**
 * 通知事件契约
 * 用于提醒和衰老清理通知
 */
export interface ParkingNotice {
  id: string;
  type: 'reminder' | 'eviction';
  /** 任务 ID */
  taskId: string;
  /** 任务标题 */
  taskTitle: string;
  /**
   * 最短可见时长（毫秒）
   * - eviction: 2500ms (NOTICE_MIN_VISIBLE_MS)
   * - reminder: 5000ms (REMINDER_IMMUNE_MS)
   */
  minVisibleMs: number;
  /** 无操作兜底淡出时长（固定 15000ms） */
  fallbackTimeoutMs: number;
  /** 可用操作按钮 */
  actions: ParkingNoticeAction[];
  /** 通知原因说明（用于汇总提示） */
  reason?: string;
  /** 单任务清理撤回 token（eviction notice 使用） */
  evictionTokenId?: string | null;
  /** 批量清理条目（summary + 逐条撤回） */
  evictionItems?: ParkingNoticeEvictionItem[];
}

/** 停泊清理通知中的逐条撤回项 */
export interface ParkingNoticeEvictionItem {
  taskId: string;
  taskTitle: string;
  evictionTokenId: string;
}

/** 通知操作按钮 */
export interface ParkingNoticeAction {
  key: ParkingNoticeActionKey;
  label: string;
}

/** 通知可用操作 key */
export type ParkingNoticeActionKey =
  | 'start-work'
  | 'snooze-5m'
  | 'snooze-30m'
  | 'snooze-2h-later'
  | 'ignore'
  | 'undo-eviction'
  | 'keep-parked';

/**
 * 衰老清理可撤回 token
 * 仅存于内存，不持久化
 */
export interface EvictionToken {
  /** 真正的撤回令牌 ID */
  tokenId: string;
  taskId: string;
  /** 任务标题（用于通知渲染） */
  taskTitle: string;
  /** 清理前的完整 parkingMeta 快照 */
  previousParkingMeta: TaskParkingMeta;
  /** token 创建时间 */
  createdAt: number;
  /** token 过期时间（毫秒时间戳） */
  expiresAt: number;
  /** token 使用时间，null 表示未使用 */
  usedAt: number | null;
}

/**
 * 批量衰老清理 token Map
 * key: tokenId, value: EvictionToken
 */
export type EvictionTokenMap = Map<string, EvictionToken>;
