/**
 * dock-engine.utils.ts
 * 从 DockEngineService / DockCompletionFlowService 中提取的纯函数工具集。
 * 所有函数均为无状态、不依赖 Angular 服务的纯函数。
 */
import { PARKING_CONFIG } from '../config/parking.config';
import { DOCK_STATUS_LABELS } from '../config/dock-i18n.config';
import {
  CognitiveLoad,
  DockEntry,
  DockLane,
  DockSourceSection,
  DockTaskStatus,
  DockUiStatus,
  DockZoneSource,
  FocusTaskSlot,
  StatusMachineEntry,
  StatusMachineLabel,
} from '../models/parking-dock';
import { type PlannerFieldSet } from '../utils/planner-fields';
import { normalizeNullableNumber } from './dock-snapshot-persistence.service';
import { rankDockCandidates } from './dock-scheduler.rules';

// ---------------------------------------------------------------------------
//  Entry ordering（纯函数）
// ---------------------------------------------------------------------------

export function entryOrder(entry: DockEntry): number {
  if (Number.isFinite(entry.manualOrder)) {
    return Number(entry.manualOrder);
  }
  return entry.dockedOrder;
}

// ---------------------------------------------------------------------------
//  DockEntry → FocusTaskSlot 映射（纯函数）
// ---------------------------------------------------------------------------

export function toFocusTaskSlot(
  entry: DockEntry,
  zone: 'command' | 'combo-select' | 'backup' = 'command',
  idx = 0,
  now = Date.now(),
): FocusTaskSlot {
  return {
    slotId: entry.taskId,
    taskId: entry.taskId,
    estimatedMinutes: entry.expectedMinutes,
    waitMinutes: entry.waitMinutes,
    cognitiveLoad: entry.load,
    focusStatus: mapDockStatusToFocusStatus(entry.status),
    zone,
    zoneIndex: idx,
    isMaster: entry.isMain,
    waitStartedAt: entry.waitStartedAt ? new Date(entry.waitStartedAt).getTime() : null,
    waitEndAt: entry.waitStartedAt && entry.waitMinutes
      ? new Date(entry.waitStartedAt).getTime() + entry.waitMinutes * 60_000
      : null,
    sourceProjectId: entry.sourceProjectId ?? null,
    sourceBlockType: entry.sourceKind === 'dock-created' ? 'text' : null,
    draggedInAt: now,
    isFirstBatch: entry.dockedOrder === 0,
    inlineTitle: entry.title,
    inlineDetail: entry.detail ?? null,
  };
}

// ---------------------------------------------------------------------------
//  Status helpers（纯函数）
// ---------------------------------------------------------------------------

export function isWaitingLike(status: DockTaskStatus): boolean {
  return status === 'suspended_waiting' || status === 'wait_finished';
}

export function isRunnableStatus(status: DockTaskStatus): boolean {
  return status === 'pending_start' || status === 'wait_finished' || status === 'stalled';
}

export function isAutoPromotableStatus(status: DockTaskStatus): boolean {
  return status === 'pending_start' || status === 'stalled';
}

export function isConsoleBackgroundStatus(status: DockTaskStatus): boolean {
  return isWaitingLike(status) || status === 'stalled';
}

// ---------------------------------------------------------------------------
//  Wait timer helpers
// ---------------------------------------------------------------------------

export function getWaitRemainingSeconds(entry: DockEntry): number | null {
  if (!entry.waitStartedAt || !entry.waitMinutes) return null;
  const startTime = new Date(entry.waitStartedAt).getTime();
  if (Number.isNaN(startTime)) return null;
  const elapsed = Date.now() - startTime;
  const total = entry.waitMinutes * 60_000;
  return Math.max(0, Math.ceil((total - elapsed) / 1000));
}

export function hasActiveWaitTimer(entry: DockEntry): boolean {
  if (!entry.waitStartedAt || !entry.waitMinutes) return false;
  const remaining = getWaitRemainingSeconds(entry);
  return remaining !== null && remaining > 0;
}

export function isWaitExpired(entry: DockEntry): boolean {
  const remaining = getWaitRemainingSeconds(entry);
  return remaining !== null && remaining <= 0;
}

// ---------------------------------------------------------------------------
//  Status mapping helpers
//
//  三套状态类型使用不同命名约定（历史原因）：
//    DockTaskStatus    — snake_case (权威来源)
//    DockUiStatus      — snake_case (UI 展示)
//    FocusTaskStatus   — kebab-case (Focus Console API，v3.0 引入)
//  修改映射时需同步更新 parking-dock.ts 中的 JSDoc 映射表。
// ---------------------------------------------------------------------------

export function mapDockStatusToUiStatus(status: DockTaskStatus): DockUiStatus {
  if (status === 'focusing') return 'focusing';
  if (status === 'suspended_waiting') return 'suspended_waiting';
  if (status === 'wait_finished') return 'waiting_done';
  if (status === 'stalled') return 'stalled';
  return 'queued';
}

export function mapDockStatusToFocusStatus(status: DockTaskStatus): FocusTaskSlot['focusStatus'] {
  switch (status) {
    case 'focusing': return 'focusing';
    case 'suspended_waiting': return 'suspend-waiting';
    case 'wait_finished': return 'wait-ended';
    case 'stalled': return 'stalled';
    case 'completed': return 'completed';
    default: return 'pending';
  }
}

export function toStatusMachineEntry(entry: DockEntry): StatusMachineEntry {
  const remainingSec = getWaitRemainingSeconds(entry);
  const totalSec = entry.waitMinutes ? entry.waitMinutes * 60 : null;
  const uiStatus = mapDockStatusToUiStatus(entry.status);
  let label: StatusMachineLabel;

  switch (uiStatus) {
    case 'focusing':
      label = DOCK_STATUS_LABELS.focusing;
      break;
    case 'waiting_done':
      label = DOCK_STATUS_LABELS.waiting_done;
      break;
    case 'suspended_waiting':
      label = DOCK_STATUS_LABELS.suspended_waiting;
      break;
    case 'stalled':
      label = DOCK_STATUS_LABELS.stalled;
      break;
    default:
      label = DOCK_STATUS_LABELS.queued;
      break;
  }

  return {
    taskId: entry.taskId,
    title: entry.title,
    uiStatus,
    label,
    waitRemainingSeconds: remainingSec,
    waitTotalSeconds: totalSec,
  };
}

// ---------------------------------------------------------------------------
//  Overflow / ordering helpers
// ---------------------------------------------------------------------------

export function buildOverflowMeta(entries: DockEntry[]): { comboSelectOverflow: number; backupOverflow: number } {
  const comboCount = entries.filter(entry => !entry.isMain && entry.lane === 'combo-select').length;
  const backupCount = entries.filter(entry => !entry.isMain && entry.lane === 'backup').length;
  return {
    comboSelectOverflow: Math.max(0, comboCount - PARKING_CONFIG.RADAR_COMBO_VISIBLE_LIMIT),
    backupOverflow: Math.max(0, backupCount - PARKING_CONFIG.RADAR_BACKUP_VISIBLE_LIMIT),
  };
}

export function resolveOrderingWindowMinutes(root: DockEntry | null): number {
  if (!root) return 30;
  const waitSeconds = getWaitRemainingSeconds(root);
  if (waitSeconds !== null && waitSeconds > 0) {
    return Math.max(1, Math.ceil(waitSeconds / 60));
  }
  if (root.expectedMinutes && root.expectedMinutes > 0) {
    return root.expectedMinutes;
  }
  return 30;
}

// ---------------------------------------------------------------------------
//  Console eviction / ordering helpers
// ---------------------------------------------------------------------------

export function findConsoleEvictionCandidate(
  visibleEntries: DockEntry[],
  currentFocusId: string | null,
): string | null {
  for (let index = visibleEntries.length - 1; index >= 0; index -= 1) {
    const entry = visibleEntries[index];
    if (!entry || entry.taskId === currentFocusId || entry.status === 'focusing' || entry.isMain) {
      continue;
    }
    return entry.taskId;
  }
  return null;
}

export function buildConsoleVisibleOrderHint(
  preVisibleEntries: ReadonlyArray<Pick<DockEntry, 'taskId'>>,
  selectedTaskId: string,
  evictedTaskId: string | null = null,
): string[] {
  return [
    selectedTaskId,
    ...preVisibleEntries
      .map(entry => entry.taskId)
      .filter(taskId => taskId !== selectedTaskId && taskId !== evictedTaskId),
  ].slice(0, PARKING_CONFIG.CONSOLE_STACK_VISIBLE_MAX);
}

// ---------------------------------------------------------------------------
//  Sorting helper
// ---------------------------------------------------------------------------

/**
 * 按调度分数排序入坞条目，用于 UI 展示。
 * @param entries 需排序的条目数组
 * @param toSchedulerCandidate 将 DockEntry 映射为 scheduler 候选的函数
 * @param resolveSourceProjectId 解析条目所属项目 ID 的函数
 */
export function sortDockEntriesForDisplay(
  entries: DockEntry[],
  toSchedulerCandidate: (entry: DockEntry) => {
    taskId: string;
    lane: import('../models/parking-dock').DockLane;
    load: import('../models/parking-dock').CognitiveLoad;
    expectedMinutes: number | null;
    waitMinutes: number | null;
    dockedOrder: number;
    manualOrder: number | null;
    relationScore: number | null;
    sourceProjectId: string | null;
  },
  resolveSourceProjectId: (entry: DockEntry) => string | null,
): DockEntry[] {
  if (entries.length <= 1) return entries;
  const root =
    entries.find(entry => entry.status === 'focusing') ??
    entries.find(entry => entry.isMain) ??
    entries[0] ??
    null;
  const rootProjectId = root ? resolveSourceProjectId(root) : null;
  const remainingMinutes = resolveOrderingWindowMinutes(root);
  const scoreMap = new Map<string, number>();
  const ranked = rankDockCandidates(
    entries.map(entry => toSchedulerCandidate(entry)),
    remainingMinutes,
    {
      rootLoad: root?.load ?? null,
      rootProjectId,
    },
  );
  for (const item of ranked) {
    scoreMap.set(item.taskId, item.score);
  }

  // 排序优先级：主任务 > 手动序 > 调度分数 > 同项目（最低优先级） > 入坞序 > 稳定ID
  // 策划案规定"同项目为最低优先级"，树距离/调度分数应主导排列
  return [...entries].sort((a, b) => {
    if (a.isMain !== b.isMain) return a.isMain ? -1 : 1;

    const aManual = normalizeNullableNumber(a.manualOrder);
    const bManual = normalizeNullableNumber(b.manualOrder);
    if (aManual !== null || bManual !== null) {
      if (aManual === null) return 1;
      if (bManual === null) return -1;
      if (aManual !== bManual) return aManual - bManual;
    }

    const aScore = scoreMap.get(a.taskId) ?? Number.MIN_SAFE_INTEGER;
    const bScore = scoreMap.get(b.taskId) ?? Number.MIN_SAFE_INTEGER;
    if (aScore !== bScore) return bScore - aScore;

    // 同项目为最低优先级弱上下文，仅在调度分数一致时参与排序
    const aSameProject = rootProjectId && resolveSourceProjectId(a) === rootProjectId ? 1 : 0;
    const bSameProject = rootProjectId && resolveSourceProjectId(b) === rootProjectId ? 1 : 0;
    if (aSameProject !== bSameProject) return bSameProject - aSameProject;

    if (a.dockedOrder !== b.dockedOrder) return a.dockedOrder - b.dockedOrder;
    return a.taskId.localeCompare(b.taskId);
  });
}

// ---------------------------------------------------------------------------
//  buildDockEntry（纯函数，从 DockEngineService.dockTask 中提取）
// ---------------------------------------------------------------------------

export interface BuildDockEntryParams {
  taskId: string;
  title: string;
  content: string | null;
  sourceProjectId: string | null;
  currentEntryCount: number;
  lane: DockEntry['lane'];
  zoneSource: DockZoneSource;
  relationScore: number | null;
  relationReason: string | null;
  plannerFields: PlannerFieldSet;
  inheritedLoad: CognitiveLoad;
  muteWaitTone: boolean;
  options?: {
    sourceKind?: DockEntry['sourceKind'];
    sourceSection?: DockSourceSection;
    detail?: string;
  };
}

/** 构建 DockEntry 对象——纯函数，不依赖服务实例 */
export function buildDockEntry(params: BuildDockEntryParams): DockEntry {
  return {
    taskId: params.taskId,
    title: params.title,
    sourceProjectId: params.sourceProjectId,
    status: 'pending_start',
    load: params.plannerFields.cognitiveLoad ?? params.inheritedLoad,
    expectedMinutes: params.plannerFields.expectedMinutes,
    waitMinutes: params.plannerFields.waitMinutes,
    waitStartedAt: null,
    lane: params.lane,
    zoneSource: params.zoneSource,
    isMain: false,
    dockedOrder: params.currentEntryCount,
    detail: params.options?.detail ?? params.content ?? '',
    sourceKind: params.options?.sourceKind ?? 'project-task',
    sourceBlackBoxEntryId: null,
    inlineArchiveStatus: undefined,
    inlineArchivedTaskId: null,
    systemSelected: false,
    recommendedScore: null,
    sourceSection: params.options?.sourceSection,
    manualMainSelected: false,
    recommendationLocked: false,
    snoozeRingMuted: params.muteWaitTone,
    relationScore: params.relationScore,
    relationReason: params.relationReason,
  };
}

// ---------------------------------------------------------------------------
//  Entry patch helpers（信号更新简化）
// ---------------------------------------------------------------------------

/** 按 taskId 局部更新单条 DockEntry，未命中则原样返回。 */
export function patchEntryByTaskId(
  entries: readonly DockEntry[],
  taskId: string,
  patch: Partial<DockEntry>,
): DockEntry[] {
  return entries.map(e => (e.taskId === taskId ? { ...e, ...patch } : e));
}

/** 对所有条目应用相同的局部更新。仅当 patch 实际改变了值时才创建新引用。 */
export function patchAllEntries(
  entries: readonly DockEntry[],
  patch: Partial<DockEntry>,
): DockEntry[] {
  const patchKeys = Object.keys(patch) as (keyof DockEntry)[];
  let changed = false;
  const next = entries.map(e => {
    const needsPatch = patchKeys.some(key => e[key] !== patch[key]);
    if (!needsPatch) return e;
    changed = true;
    return { ...e, ...patch };
  });
  return changed ? next : entries as unknown as DockEntry[];
}

// ---------------------------------------------------------------------------
//  SchedulerCandidate 转换（M-1 修复：消除 DockCompletionFlowService / DockPromotionService 的重复实现）
// ---------------------------------------------------------------------------

/** 调度器候选人数据对象 */
export interface SchedulerCandidate {
  taskId: string;
  lane: DockLane;
  load: CognitiveLoad;
  expectedMinutes: number | null;
  waitMinutes: number | null;
  dockedOrder: number;
  manualOrder: number | null;
  relationScore: number | null;
  sourceProjectId: string | null;
}

/**
 * 将 DockEntry 转换为调度器候选人纯数据对象。
 * @param fallbackProjectId 当 entry.sourceProjectId 为空时使用的回退值
 *   （通常来自 DockZoneService.resolveSourceProjectId）。
 */
export function toSchedulerCandidate(
  entry: DockEntry,
  fallbackProjectId: string | null,
): SchedulerCandidate {
  return {
    taskId: entry.taskId,
    lane: entry.lane,
    load: entry.load,
    expectedMinutes: entry.expectedMinutes,
    waitMinutes: entry.waitMinutes,
    dockedOrder: entry.dockedOrder,
    manualOrder: normalizeNullableNumber(entry.manualOrder),
    relationScore: normalizeNullableNumber(entry.relationScore),
    sourceProjectId: entry.sourceProjectId ?? fallbackProjectId,
  };
}
