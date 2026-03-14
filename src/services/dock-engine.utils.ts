/**
 * dock-engine.utils.ts
 * 从 DockEngineService / DockCompletionFlowService 中提取的纯函数工具集。
 * 所有函数均为无状态、不依赖 Angular 服务的纯函数。
 */
import { PARKING_CONFIG } from '../config/parking.config';
import {
  DockEntry,
  DockTaskStatus,
  DockUiStatus,
  FocusTaskSlot,
  StatusMachineEntry,
  StatusMachineLabel,
} from '../models/parking-dock';
import { normalizeNullableNumber } from './dock-snapshot-persistence.service';
import { rankDockCandidates } from './dock-scheduler.rules';

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
  const elapsed = Date.now() - new Date(entry.waitStartedAt).getTime();
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
      label = '专注中';
      break;
    case 'waiting_done':
      label = '等待结束';
      break;
    case 'suspended_waiting':
      label = '挂起等待';
      break;
    case 'stalled':
      label = '停滞中';
      break;
    default:
      label = '待启动';
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

export function nextManualOrder(entries: ReadonlyArray<DockEntry>): number {
  const orders = entries
    .map(entry => entry.manualOrder)
    .filter((value): value is number => Number.isFinite(value));
  if (orders.length === 0) return entries.length;
  return Math.max(...orders) + 1;
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
