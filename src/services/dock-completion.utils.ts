/**
 * dock-completion.utils.ts
 * 从 DockCompletionFlowService 中提取的纯工具函数集。
 * 所有函数均为无状态、无 `this`、不依赖 Angular 服务的纯函数，
 * 便于独立测试与跨模块复用。
 */
import {
  DockEntry,
  DockPendingDecision,
  DockTaskStatus,
  RecommendationGroupType,
} from '../models/parking-dock';
import { entryOrder, hasActiveWaitTimer, isWaitingLike } from './dock-engine.utils';

export interface ApplyRecommendationEntriesInput {
  suspendedTaskId: string;
  recommendationIds: string[];
  scoreByTaskId: ReadonlyMap<string, number>;
}

export interface ApplyPendingDecisionEntryFlagsInput {
  candidateIds: string[];
  scoreByTaskId: ReadonlyMap<string, number>;
}

export interface BuildDockPendingDecisionInput {
  rootTaskId: string;
  rootRemainingMinutes: number;
  candidateGroups: Array<{ type: RecommendationGroupType; taskIds: string[] }>;
  reason: string;
  now: Date;
  minAutoPromoteMs: number;
  autoPromoteAfterMs?: number;
}

export interface BuildDockPendingDecisionResult {
  candidateIds: string[];
  pendingDecision: DockPendingDecision;
}

export function applyRecommendationEntries(
  entries: DockEntry[],
  input: ApplyRecommendationEntriesInput,
): DockEntry[] {
  return entries.map(entry => {
    if (entry.taskId === input.suspendedTaskId) {
      return {
        ...entry,
        status: 'suspended_waiting',
        systemSelected: false,
        recommendationLocked: false,
        recommendedScore: null,
      };
    }
    if (input.recommendationIds.includes(entry.taskId)) {
      return {
        ...entry,
        status: 'pending_start',
        systemSelected: true,
        recommendationLocked: true,
        recommendedScore: input.scoreByTaskId.get(entry.taskId) ?? null,
      };
    }
    return {
      ...entry,
      systemSelected: false,
      recommendationLocked: false,
      recommendedScore: input.scoreByTaskId.get(entry.taskId) ?? null,
    };
  });
}

export function applyPendingDecisionEntryFlags(
  entries: DockEntry[],
  input: ApplyPendingDecisionEntryFlagsInput,
): DockEntry[] {
  return entries.map(entry => {
    if (input.candidateIds.includes(entry.taskId)) {
      return {
        ...entry,
        systemSelected: true,
        recommendationLocked: true,
        recommendedScore: input.scoreByTaskId.get(entry.taskId) ?? null,
      };
    }
    return {
      ...entry,
      systemSelected: false,
      recommendationLocked: false,
    };
  });
}

// ---------------------------------------------------------------------------
//  buildDockPendingDecision
// ---------------------------------------------------------------------------

export function buildDockPendingDecision(input: BuildDockPendingDecisionInput): BuildDockPendingDecisionResult {
  const createdAt = input.now.toISOString();
  const autoPromoteAfterMs =
    typeof input.autoPromoteAfterMs === 'number'
      ? Math.max(input.minAutoPromoteMs, input.autoPromoteAfterMs)
      : null;
  const candidateIds = input.candidateGroups.flatMap(group => group.taskIds);

  return {
    candidateIds,
    pendingDecision: {
      rootTaskId: input.rootTaskId,
      rootRemainingMinutes: input.rootRemainingMinutes,
      candidateGroups: input.candidateGroups,
      reason: input.reason,
      expiresAt: autoPromoteAfterMs === null
        ? undefined
        : new Date(input.now.getTime() + autoPromoteAfterMs).toISOString(),
      autoPromoteAfterMs: autoPromoteAfterMs ?? undefined,
      createdAt,
    },
  };
}

// ---------------------------------------------------------------------------
//  deriveBackgroundStatus
// ---------------------------------------------------------------------------

export function deriveBackgroundStatus(
  entry: DockEntry,
  nextTarget: DockEntry | null = null,
  currentFocus: DockEntry | null = null,
): DockTaskStatus {
  if (hasActiveWaitTimer(entry)) return 'suspended_waiting';
  if (entry.waitStartedAt && entry.waitMinutes) return 'wait_finished';
  if (currentFocus && !currentFocus.isMain && nextTarget?.isMain) return 'stalled';
  if (entry.status === 'stalled') return 'stalled';
  if (entry.status === 'focusing') return 'stalled';
  return 'pending_start';
}

// ---------------------------------------------------------------------------
//  enforceSingleMainInvariant
// ---------------------------------------------------------------------------

export function enforceSingleMainInvariant(
  entries: DockEntry[],
  preferredTaskId: string | null = null,
): DockEntry[] {
  if (entries.length === 0) return entries;

  const activeEntries = entries.filter(entry => entry.status !== 'completed');

  if (activeEntries.length === 0) {
    let changed = false;
    const cleared = entries.map(entry => {
      if (!entry.isMain) return entry;
      changed = true;
      return { ...entry, isMain: false };
    });
    return changed ? cleared : entries;
  }

  const ordered = [...activeEntries].sort((a, b) => entryOrder(a) - entryOrder(b));

  const preferredMain = preferredTaskId
    ? activeEntries.find(entry => entry.taskId === preferredTaskId) ?? null
    : null;
  const existingMain = ordered.find(entry => entry.isMain) ?? null;
  const focusingEntry = activeEntries.find(entry => entry.status === 'focusing') ?? null;
  const fallbackEntry = ordered[0] ?? null;

  const targetMainTaskId =
    preferredMain?.taskId ?? existingMain?.taskId ?? focusingEntry?.taskId ?? fallbackEntry?.taskId ?? null;

  let changed = false;
  const next = entries.map(entry => {
    const normalizedIsMain =
      entry.status !== 'completed' && targetMainTaskId !== null && entry.taskId === targetMainTaskId;
    if (entry.isMain === normalizedIsMain) return entry;
    changed = true;
    return { ...entry, isMain: normalizedIsMain };
  });

  return changed ? next : entries;
}

// ---------------------------------------------------------------------------
//  clearSystemSelectionFlags
// ---------------------------------------------------------------------------

export function clearSystemSelectionFlags(entries: DockEntry[]): DockEntry[] {
  const realMainId = entries.find(
    e => e.isMain && !e.systemSelected && e.status !== 'completed',
  )?.taskId ?? null;

  let changed = false;
  const next = entries.map(entry => {
    const wasSystemSelected = entry.systemSelected || entry.recommendationLocked;
    const hasStaleMain = entry.isMain && entry.systemSelected && entry.taskId !== realMainId;
    if (!wasSystemSelected && !hasStaleMain) return entry;
    changed = true;
    return {
      ...entry,
      isMain: hasStaleMain ? false : entry.isMain,
      systemSelected: false,
      recommendationLocked: false,
    };
  });

  return enforceSingleMainInvariant(changed ? next : entries, realMainId);
}

// ---------------------------------------------------------------------------
//  clearSuspendRecommendationFlags
// ---------------------------------------------------------------------------

export function clearSuspendRecommendationFlags(entries: DockEntry[]): DockEntry[] {
  const realMainId = entries.find(
    e => e.isMain && !e.systemSelected && e.status !== 'completed',
  )?.taskId ?? null;

  let changed = false;
  const next = entries.map(entry => {
    const hasStaleMain = entry.isMain && entry.systemSelected && entry.taskId !== realMainId;
    if (!entry.systemSelected && !entry.recommendationLocked && entry.recommendedScore === null && !hasStaleMain) {
      return entry;
    }
    changed = true;
    return {
      ...entry,
      isMain: hasStaleMain ? false : entry.isMain,
      systemSelected: false,
      recommendationLocked: false,
      recommendedScore: null,
    };
  });

  return enforceSingleMainInvariant(changed ? next : entries, realMainId);
}

// ---------------------------------------------------------------------------
//  pendingCandidateIds
// ---------------------------------------------------------------------------

export function pendingCandidateIds(pending: DockPendingDecision): string[] {
  return pending.candidateGroups.flatMap(group => group.taskIds);
}

function compareFocusStatus(a: DockEntry, b: DockEntry): number {
  if (a.status === 'focusing') return -1;
  if (b.status === 'focusing') return 1;
  return 0;
}

function compareOrderHint(
  a: DockEntry,
  b: DockEntry,
  hintIndex: ReadonlyMap<string, number>,
): number {
  const aHintIndex = hintIndex.get(a.taskId);
  const bHintIndex = hintIndex.get(b.taskId);
  if (aHintIndex === undefined && bHintIndex === undefined) return 0;
  if (aHintIndex !== undefined && bHintIndex !== undefined && aHintIndex !== bHintIndex) {
    return aHintIndex - bHintIndex;
  }
  if (aHintIndex !== undefined && bHintIndex === undefined) return -1;
  if (bHintIndex !== undefined && aHintIndex === undefined) return 1;
  return 0;
}

function compareDemotedEntry(
  a: DockEntry,
  b: DockEntry,
  demotedTaskId: string | null,
): number {
  if (!demotedTaskId) return 0;
  const aDemoted = a.taskId === demotedTaskId && a.status === 'stalled';
  const bDemoted = b.taskId === demotedTaskId && b.status === 'stalled';
  if (aDemoted && !bDemoted) return -1;
  if (bDemoted && !aDemoted) return 1;
  return 0;
}

function compareConsoleStatus(a: DockEntry, b: DockEntry): number {
  const aStalled = a.status === 'stalled';
  const bStalled = b.status === 'stalled';
  if (aStalled && !bStalled) return -1;
  if (bStalled && !aStalled) return 1;

  const aSuspended = isWaitingLike(a.status);
  const bSuspended = isWaitingLike(b.status);
  if (aSuspended && !bSuspended) return 1;
  if (bSuspended && !aSuspended) return -1;
  return 0;
}

function compareStableEntryOrder(a: DockEntry, b: DockEntry): number {
  if (a.dockedOrder !== b.dockedOrder) return a.dockedOrder - b.dockedOrder;
  return a.taskId.localeCompare(b.taskId);
}

// ---------------------------------------------------------------------------
//  sortConsoleEntriesForDisplay
// ---------------------------------------------------------------------------

export function sortConsoleEntriesForDisplay(
  entries: DockEntry[],
  demotedTaskId: string | null,
  orderHint: string[],
): DockEntry[] {
  if (entries.length <= 1) return entries;

  const hintIndex = new Map(orderHint.map((taskId, index) => [taskId, index] as const));

  return [...entries].sort((a, b) => {
    return compareFocusStatus(a, b)
      || compareOrderHint(a, b, hintIndex)
      || compareDemotedEntry(a, b, demotedTaskId)
      || compareConsoleStatus(a, b)
      || compareStableEntryOrder(a, b);
  });
}
