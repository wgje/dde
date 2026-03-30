// ============================================
// Dock v3 domain model
// ============================================

/**
 * 停泊坞任务状态（权威领域模型 — snake_case 命名）
 *
 * 这是所有状态的唯一真实来源（Single Source of Truth）。
 * 其他状态类型通过映射函数派生：
 *   - DockUiStatus    ← mapDockStatusToUiStatus()   (snake_case，UI 展示)
 *   - FocusTaskStatus ← mapDockStatusToFocusStatus() (kebab-case，Focus Console API)
 *
 * @see mapDockStatusToUiStatus   — dock-engine.utils.ts
 * @see mapDockStatusToFocusStatus — dock-engine.utils.ts
 */
export type DockTaskStatus =
  | 'pending_start'
  | 'focusing'
  | 'suspended_waiting'
  | 'wait_finished'
  | 'stalled'
  | 'completed';

export type CognitiveLoad = 'high' | 'low';
export type DockLane = 'combo-select' | 'backup';
export type DockSchedulerPhase = 'active' | 'paused';

// ============================================
// v3.0 Focus Console 扩展类型（策划案 §2.5 / §6.1）
// ============================================

/**
 * 专注控制台三区类型（v3.0 改名：原 radar/periphery → combo-select/backup）
 * · command：主控台（卡片叠）
 * · combo-select：组合选择区域（三维推荐阵列）
 * · backup：备选区域（半弧漂浮）
 */
export type FocusZone = 'command' | 'combo-select' | 'backup';

/**
 * 专注任务状态（策划案 §6.1）
 * 与 DockTaskStatus 映射但语义更精确
 *
 * 映射关系：
 *   DockTaskStatus         → FocusTaskStatus
 *   'pending_start'        → 'pending'
 *   'focusing'             → 'focusing'
 *   'suspended_waiting'    → 'suspend-waiting'
 *   'wait_finished'        → 'wait-ended'
 *   'stalled'              → 'stalled'
 *   'completed'            → 'completed' | 'completing'
 *
 * ⚠️ 注意：DockTaskStatus 使用下划线分隔，FocusTaskStatus 使用连字符分隔。
 *   历史原因保留两套命名，映射时需注意。
 */
export type FocusTaskStatus =
  | 'pending'           // 待启动：在组合选择区域或备选区域等待
  | 'focusing'          // 专注中：位于绝对 C 位
  | 'suspend-waiting'   // 挂起等待：计时倒数中
  | 'wait-ended'        // 等待结束：铃声提示，等待用户操作
  | 'stalled'           // 停滞中：已进入上下文但被切回主任务
  | 'completing'        // 完成动画中（过渡状态）
  | 'completed';        // 已完成，已飞出控制台

/**
 * 三维推荐阵列分组类型（策划案 §4.2.4）
 * ① 同源推进：同项目、延续心流
 * ② 认知降低：低负荷、恢复能量
 * ③ 异步并发：有等待时间、并行启动
 */
export type RecommendationGroupType =
  | 'homologous-advancement'
  | 'cognitive-downgrade'
  | 'asynchronous-boot';

/**
 * 三维推荐分组结果（策划案 §4.2.4）
 */
export interface RecommendationGroup {
  type: RecommendationGroupType;
  candidates: FocusTaskSlot[];
  /** 大任务回退标记（空集处理时为 true）*/
  isOversized?: boolean;
}

/**
 * 碎片事件分类（策划案 §7.8 Level 2）
 * 按优先级顺序：身体跨界 > 数字清洁工 > 微进度
 */
export type FragmentEventCategory = 'physical-crossover' | 'digital-janitor' | 'micro-progress';

/**
 * 碎片阶段防御等级（策划案 §7.8 四级防御体系）
 */
export type FragmentDefenseLevel = 1 | 2 | 3 | 4;

/**
 * 高负荷完成计数器（策划案 §2.5 / §7.8 NG-16b）
 * 用于 2h 滑动窗口倦怠检测
 */
export interface HighLoadCounter {
  /** 2h 滑动窗口内完成的 cognitiveLoad='high' 任务数 */
  count: number;
  /** 滑动窗口起始时间戳（首次高负荷完成时设置，距今 > 2h 时重置） */
  windowStartAt: number;
}

/**
 * FocusTaskSlot — 停泊坞专注控制台中的任务槽（策划案 §2.5）
 *
 * 基础任务数据来自原始 Task 实体（通过 taskId 引用）。
 * FocusTaskSlot 仅持有专注模式独有的扩展属性。
 */
export interface FocusTaskSlot {
  slotId: string;           // 槽 ID，crypto.randomUUID()
  taskId: string | null;    // 关联原始任务 ID（null = 就地创建的临时任务）

  // ─── 专注属性 ───
  /** 总预计时间（分钟，含等待时间） */
  estimatedMinutes: number | null;
  /** 等待时间（分钟，≤ estimatedMinutes） */
  waitMinutes: number | null;
  /** 认知负荷（v3.0：默认 'low'，不再允许 null） */
  cognitiveLoad: CognitiveLoad;

  // ─── 专注状态 ───
  focusStatus: FocusTaskStatus;
  /** 所在区域（v3.0：command/combo-select/backup） */
  zone: FocusZone;
  /** 区域内排列位置 */
  zoneIndex: number;

  // ─── 主任务标记（v3.0 新增，补全 G-38）───
  /** 是否为主任务（与 focusStatus='focusing' 完全解耦） */
  isMaster: boolean;

  // ─── 等待计时 ───
  /** 等待开始时间（epoch ms），与 DockEntry.waitStartedAt (ISO string) 格式不同，映射时需转换 */
  waitStartedAt: number | null;
  waitEndAt: number | null;

  // ─── 来源信息 ───
  sourceProjectId: string | null;
  sourceBlockType: 'text' | 'flow' | null;
  draggedInAt: number;
  isFirstBatch: boolean;

  // ─── 就地创建专属 ───
  inlineTitle: string | null;
  inlineDetail: string | null;
}

/**
 * LegacyFocusSessionState — v2 之前的快照格式（仅用于向后兼容）
 */
export interface LegacyFocusSessionState {
  sessionId?: string;
  sessionStartedAt?: number;
  isActive?: boolean;
  isFocusOverlayOn?: boolean;
  commandCenterTasks?: FocusTaskSlot[];
  comboSelectTasks?: FocusTaskSlot[];
  backupTasks?: FocusTaskSlot[];
  hasFirstBatchSelected?: boolean;
  routineSlotsShownToday?: string[];
  highLoadCounter?: HighLoadCounter;
  burnoutTriggeredAt?: number | null;
}

/**
 * FocusSessionStateV2 — 专注控制台全局状态（策划案 §2.5）
 * 生命周期：跨项目、跨路由，绑定到应用层（非项目层）
 * 持久化：IndexedDB（sessionSnapshot 表），应用关闭前自动保存
 */
export interface FocusSessionStateV2 {
  schemaVersion: 2;
  sessionId: string;
  sessionStartedAt: number;
  isActive: boolean;
  /** 背景虚化是否开启（与专注独立） */
  isFocusOverlayOn: boolean;
  commandCenterTasks: FocusTaskSlot[];
  /** 组合选择区域任务列表（v3.0 改名，原 radarTasks） */
  comboSelectTasks: FocusTaskSlot[];
  /** 备选区域任务列表（v3.0 改名，原 peripheryTasks） */
  backupTasks: FocusTaskSlot[];
  /** 是否已完成首次主任务选择（防止系统二次干预） */
  hasFirstBatchSelected: boolean;
  /** 今日已展示的日常任务 ID */
  routineSlotsShownToday: string[];
  /** 高负荷完成计数器（v3.0 补全 G-16 NG-16b） */
  highLoadCounter: HighLoadCounter;
  /** 最近一次倦怠熔断触发时间戳，null=未触发 */
  burnoutTriggeredAt: number | null;
}

export type FocusSessionState = FocusSessionStateV2;

export function fromLegacySessionState(
  source: LegacyFocusSessionState | FocusSessionStateV2,
  defaults: Pick<
    FocusSessionStateV2,
    'sessionId' | 'sessionStartedAt' | 'isFocusOverlayOn' | 'highLoadCounter' | 'burnoutTriggeredAt'
  >,
): FocusSessionStateV2 {
  return {
    schemaVersion: 2,
    sessionId: typeof source.sessionId === 'string' && source.sessionId ? source.sessionId : defaults.sessionId,
    sessionStartedAt:
      Number.isFinite(source.sessionStartedAt)
        ? Number(source.sessionStartedAt)
        : defaults.sessionStartedAt,
    isActive: source.isActive !== false,
    isFocusOverlayOn:
      source.isFocusOverlayOn === undefined
        ? defaults.isFocusOverlayOn
        : Boolean(source.isFocusOverlayOn),
    commandCenterTasks: Array.isArray(source.commandCenterTasks) ? source.commandCenterTasks : [],
    comboSelectTasks: Array.isArray(source.comboSelectTasks) ? source.comboSelectTasks : [],
    backupTasks: Array.isArray(source.backupTasks) ? source.backupTasks : [],
    hasFirstBatchSelected: Boolean(source.hasFirstBatchSelected),
    routineSlotsShownToday: Array.isArray(source.routineSlotsShownToday)
      ? source.routineSlotsShownToday.filter((item): item is string => typeof item === 'string')
      : [],
    highLoadCounter: source.highLoadCounter ?? defaults.highLoadCounter,
    burnoutTriggeredAt:
      source.burnoutTriggeredAt === undefined
        ? defaults.burnoutTriggeredAt
        : source.burnoutTriggeredAt,
  };
}

/**
 * 碎片事件条目（策划案 §7.8 Level 2）
 */
export interface FragmentEventEntry {
  id: string;
  category: FragmentEventCategory;
  title: string;
  /** 建议时长（分钟） */
  suggestedMinutes: number;
  /** 是否为系统预置 */
  isPreset: boolean;
}

/**
 * 区域分配结果（策划案 §2.7 assignZonesOnFocusStart）
 */
export interface ZoneAssignment {
  zone: FocusZone;
  tasks: FocusTaskSlot[];
}

/**
 * StatusHUD 预设位置偏好（策划案 §5.5）
 * 注意：与 dock-hud-position.ts 中的 HudPosition { x, y } 坐标类型不同
 */
type HudPresetPosition = 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left';

/**
 * 日常任务定义（策划案 §10.1）
 */
export interface RoutineTask {
  routineId: string;
  title: string;
  triggerCondition: 'any-blank-period';
  maxTimesPerDay: number;
  isEnabled: boolean;
  /** LWW 同步必需字段 */
  updatedAt?: string;
}

export interface FocusSessionRecord {
  id: string;
  userId: string;
  startedAt: string;
  endedAt: string | null;
  snapshot: DockSnapshot;
  updatedAt: string;
}

export interface RoutineCompletionMutation {
  completionId: string;
  userId: string;
  routineId: string;
  dateKey: string;
}

/** 预置碎片事件列表（策划案 §7.8 Level 2-a） */
export const PRESET_FRAGMENT_EVENTS = [
  { id: 'frag-01', category: 'physical-crossover', title: '站起来倒杯水', suggestedMinutes: 3, isPreset: true },
  { id: 'frag-02', category: 'physical-crossover', title: '做几组伸展运动', suggestedMinutes: 5, isPreset: true },
  { id: 'frag-03', category: 'physical-crossover', title: '去洗手间洗把脸', suggestedMinutes: 3, isPreset: true },
  { id: 'frag-04', category: 'physical-crossover', title: '看窗外远处放松眼睛', suggestedMinutes: 2, isPreset: true },
  { id: 'frag-05', category: 'physical-crossover', title: '在走廊走一圈', suggestedMinutes: 4, isPreset: true },
  { id: 'frag-06', category: 'digital-janitor', title: '清理桌面通知', suggestedMinutes: 3, isPreset: true },
  { id: 'frag-07', category: 'digital-janitor', title: '整理文件夹', suggestedMinutes: 5, isPreset: true },
  { id: 'frag-08', category: 'digital-janitor', title: '归档已读邮件', suggestedMinutes: 5, isPreset: true },
  // micro-progress：微量推进类碎片活动
  { id: 'frag-09', category: 'micro-progress', title: '快速复查上一个任务的笔记', suggestedMinutes: 3, isPreset: true },
  { id: 'frag-10', category: 'micro-progress', title: '为下一步列一个简短的行动清单', suggestedMinutes: 4, isPreset: true },
  { id: 'frag-11', category: 'micro-progress', title: '浏览待办清单标记优先级', suggestedMinutes: 3, isPreset: true },
] as const satisfies readonly FragmentEventEntry[];
export type DockZoneSource = 'auto' | 'manual';
export type DockSourceSection = 'text' | 'flow' | 'dock-create';
/** Status machine display labels — intentionally Chinese strings for the Chinese-locale UI. */
export type StatusMachineLabel = '待启动' | '专注中' | '挂起等待' | '等待结束' | '停滞中';
/**
 * 停泊坞 UI 展示状态（snake_case 命名，与 DockTaskStatus 同约定）
 *
 * 由 mapDockStatusToUiStatus() 从 DockTaskStatus 映射而来：
 *   DockTaskStatus       → DockUiStatus
 *   'pending_start'      → 'queued'        (重命名：UI 更友好)
 *   'focusing'           → 'focusing'
 *   'suspended_waiting'  → 'suspended_waiting'
 *   'wait_finished'      → 'waiting_done'  (重命名：UI 更友好)
 *   'stalled'            → 'stalled'
 *   'completed'          → (无对应 — 已完成任务不展示)
 */
export type DockUiStatus = 'queued' | 'focusing' | 'suspended_waiting' | 'waiting_done' | 'stalled';
export type DockRuleDecisionType =
  | 'first_suspend_recommendation'
  | 'completion_followup'
  | 'pending_decision'
  | 'fragment_phase'
  | 'idle_promote';
export type DockAnimationEventType =
  | 'focus_switch'
  | 'card_fly_out'
  | 'card_push_in'
  | 'card_sink'
  | 'magnet_pull'
  | 'pending_decision_prompt'
  | 'fragment_slot_drop';
export type DockFocusTransitionPhase = 'idle' | 'entering' | 'focused' | 'exiting';
export type DockExitAction = 'save_exit' | 'clear_exit' | 'keep_focus_hide_scrim';

export interface DockRuleDecision {
  type: DockRuleDecisionType;
  reason: string;
  rootTaskId?: string;
  recommendedTaskIds: string[];
  remainingMinutes?: number;
  ratio?: number | null;
  createdAt: string;
}

export interface DockAnimationEvent {
  type: DockAnimationEventType;
  taskId?: string;
  relatedTaskIds?: string[];
  createdAt: string;
}

export interface DockFlipRect {
  left?: number;
  top?: number;
  width?: number;
  height?: number;
}

export interface DockFocusTransitionState {
  phase?: DockFocusTransitionPhase;
  direction?: 'enter' | 'exit';
  fromRect?: DockFlipRect | null;
  toRect?: DockFlipRect | null;
  durationMs?: number;
  startedAt?: string;
}

export interface DockEntry {
  taskId: string;
  title: string;
  sourceProjectId: string | null;
  status: DockTaskStatus;
  load: CognitiveLoad;
  expectedMinutes: number | null;
  waitMinutes: number | null;
  waitStartedAt: string | null;
  lane: DockLane;
  zoneSource: DockZoneSource;
  isMain: boolean;
  dockedOrder: number;
  /** 用户手动排序序号（值越小优先级越高）；为空时回退到 dockedOrder */
  manualOrder?: number;
  detail: string;
  sourceKind: 'project-task' | 'dock-created';
  /** 就地创建对应的黑匣子条目 ID（共享仓） */
  sourceBlackBoxEntryId?: string | null;
  /** 就地创建归档状态（退出专注时写回） */
  inlineArchiveStatus?: 'pending' | 'archiving' | 'archived' | 'failed';
  /** 就地创建归档后关联的真实任务 ID */
  inlineArchivedTaskId?: string | null;
  systemSelected: boolean;
  recommendedScore: number | null;
  sourceSection?: DockSourceSection;
  manualMainSelected?: boolean;
  recommendationLocked?: boolean;
  snoozeRingMuted?: boolean;
  lastAnimationEvent?: DockAnimationEvent;
  relationScore?: number | null;
  relationReason?: string | null;
}

export interface DockOverflowMeta {
  comboSelectOverflow: number;
  backupOverflow: number;
}

export interface WaitPreset {
  label: string;
  /** 等待分钟数。null 表示「自定义」哨兵，UI 层应拦截并弹出输入框。 */
  minutes: number | null;
}

/**
 * 等待时间预设列表（中文 UI）。
 * minutes > 0 为实际等待分钟数；minutes === null 是哨兵值，
 * UI 层应拦截该值并弹出自定义输入，而非直接传入计时逻辑。
 */
export const WAIT_PRESETS: WaitPreset[] = [
  { label: '5 分钟', minutes: 5 },
  { label: '15 分钟', minutes: 15 },
  { label: '30 分钟', minutes: 30 },
  { label: '1 小时', minutes: 60 },
  { label: '2 小时', minutes: 120 },
  { label: '3 小时', minutes: 180 },
  { label: '1 天', minutes: 1440 },
  /** 自定义：minutes = null 表示哨兵值，UI 层拦截后弹出自定义输入 */
  { label: '自定义', minutes: null },
];

export interface StatusMachineEntry {
  taskId: string;
  title: string;
  uiStatus: DockUiStatus;
  label: StatusMachineLabel;
  waitRemainingSeconds: number | null;
  waitTotalSeconds: number | null;
}

/**
 * 状态机中的“等待已结束”在 UI 上需要统一判定：
 * 既包含已显式切到 waiting_done 的条目，也包含倒计时已经归零、
 * 但状态提升尚未在本轮 tick 中完成的 suspended_waiting 条目。
 */
export function isStatusMachineEntryExpired(entry: Pick<StatusMachineEntry, 'uiStatus' | 'waitRemainingSeconds'>): boolean {
  return entry.uiStatus === 'waiting_done'
    || (entry.waitRemainingSeconds !== null && entry.waitRemainingSeconds <= 0);
}

export interface DailySlotEntry {
  id: string;
  title: string;
  maxDailyCount: number;
  todayCompletedCount: number;
  isEnabled: boolean;
  createdAt: string;
}

export interface DockPendingDecision {
  rootTaskId: string;
  rootRemainingMinutes: number;
  candidateGroups: Array<{
    type: RecommendationGroupType;
    taskIds: string[];
  }>;
  reason: string;
  expiresAt?: string;
  autoPromoteAfterMs?: number;
  createdAt: string;
}

export interface DockPendingDecisionEntry {
  taskId: string;
  title: string;
  group: RecommendationGroupType;
  lane: DockLane;
  load: CognitiveLoad;
  expectedMinutes: number | null;
  recommendedScore: number | null;
}

export interface DockSessionState {
  firstDragIntervened: boolean;
  /**
   * @deprecated v3 legacy field. Kept only for backward compatibility in snapshots.
   */
  focusBlurOn: boolean;
  focusScrimOn: boolean;
  mainTaskId: string | null;
  comboSelectIds: string[];
  backupIds: string[];
  /** 高负荷完成计数器（策划案 §2.5 / §7.8 Level 2 NG-16b） */
  highLoadCounter?: HighLoadCounter;
  /** 最近一次倦怠熔断触发时间戳（策划案 §7.8） */
  burnoutTriggeredAt?: number | null;
  /** 当前 focus session UUID（v3.4） */
  focusSessionId?: string;
  /** 当前 focus session 起始时间戳（v3.4） */
  focusSessionStartedAt?: number;
  /** 是否已完成首次主任务选择（v3.0 跨会话持久化 G-37） */
  hasFirstBatchSelected?: boolean;
  /** 调度器阶段（v3.3 N2：碎片期 pause，退出后 active） */
  schedulerPhase?: DockSchedulerPhase;
  /** 三区展示上限下的溢出统计（组合选择区/备选区） */
  overflowMeta?: DockOverflowMeta;
}

/** 当前最新快照版本号，新增版本时递增此常量 */
export const CURRENT_DOCK_SNAPSHOT_VERSION = 7;

export interface DockSnapshot {
  version: number;
  entries: DockEntry[];
  focusMode: boolean;
  isDockExpanded: boolean;
  muteWaitTone: boolean;
  session: DockSessionState;
  dailySlots: DailySlotEntry[];
  suspendChainRootTaskId: string | null;
  suspendRecommendationLocked: boolean;
  pendingDecision: DockPendingDecision | null;
  lastRuleDecision?: DockRuleDecision | null;
  dailyResetDate: string;
  savedAt: string;

  // Backward compatibility for legacy snapshots before session refactor.
  firstDragDone?: boolean;

  /** v3.0 专注会话状态快照（策划案 §2.5） */
  focusSessionState?: FocusSessionState | null;
}

// ---------------------------------------------------------------------------
//  DockEntry 类型守卫（sourceKind 辨识）
// ---------------------------------------------------------------------------
