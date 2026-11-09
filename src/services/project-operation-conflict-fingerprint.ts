/**
 * ProjectOperationService 的「冲突指纹 / 匹配」纯函数模块。
 *
 * 从 ProjectOperationService「下切」出的无状态冲突身份判定：把「已持久化冲突记录」与
 * 「当前活动冲突」归并成稳定指纹，并判断当前冲突是否仍与某指纹/快照同一身份，用于避免
 * 重复发布冲突 / 误清理他人冲突。
 *
 * 职责单一、纯函数（无 `this`、无副作用）：
 * - captureConflictFingerprint：stored + active 两路冲突归并出权威指纹（conflictedAt 新者优先）
 * - doesStoredConflictMatchFingerprint：当前持久化冲突是否匹配指纹（owner/版本/待删集逐项比较）
 * - doesActiveConflictMatchSnapshot：当前活动冲突是否与期望快照同一身份
 *
 * 为什么抽离：AGENTS.md §12 单文件 ≤ 800 行硬线；ProjectOperationService 长期越界，
 * 这些纯判定自洽且零依赖服务态，适合先行下切。
 */
import { Project } from '../models';
import type { TaskDeleteBaseUpdatedAtMap } from './action-queue.types';
import type { OperationConflictRecord } from './conflict-storage.helpers';

/** 已持久化的冲突记录形态。 */
export interface StoredConflictSnapshot {
  projectId: string;
  ownerUserId?: string;
  conflictedAt: string;
  localVersion: number;
  remoteVersion?: number;
  pendingTaskDeleteIds?: string[];
  pendingTaskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap;
  operationConflicts?: OperationConflictRecord[];
}

/** 当前活动冲突形态（local/remote 与 localProject/remoteProject 双命名兼容）。 */
export interface ActiveConflictSnapshot {
  projectId?: string;
  conflictedAt?: string;
  local?: Project;
  remote?: Project;
  localProject?: Project;
  remoteProject?: Project;
  pendingTaskDeleteIds?: string[];
  pendingTaskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap;
  operationConflicts?: OperationConflictRecord[];
}

/** 归并后的冲突指纹。 */
export interface ConflictFingerprint {
  projectId: string;
  ownerUserId: string | null;
  conflictedAt?: string;
  localVersion?: number;
  remoteVersion?: number;
  pendingTaskDeleteIds?: string[];
  pendingTaskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap;
  operationConflictFingerprints?: string[];
}

export function captureConflictFingerprint(
  storedConflict: StoredConflictSnapshot | null,
  activeConflict: ActiveConflictSnapshot | null,
  ownerUserId: string | null,
): ConflictFingerprint {
  const activeFingerprint = activeConflictToFingerprint(activeConflict, ownerUserId);
  const storedFingerprint = storedConflictToFingerprint(storedConflict, ownerUserId);
  return pickConflictFingerprint(storedFingerprint, activeFingerprint)
    ?? emptyConflictFingerprint(activeConflict, ownerUserId);
}

export function doesStoredConflictMatchFingerprint(
  currentConflict: StoredConflictSnapshot | null,
  fingerprint: ConflictFingerprint,
): boolean {
  if (!currentConflict || currentConflict.projectId !== fingerprint.projectId) {
    return false;
  }

  const currentPendingDeletes = [...(currentConflict.pendingTaskDeleteIds ?? [])].sort();
  const expectedPendingDeletes = [...(fingerprint.pendingTaskDeleteIds ?? [])].sort();
  const currentBaseMap = normalizeTaskDeleteBaseUpdatedAtMap(currentConflict.pendingTaskDeleteBaseUpdatedAtMap);
  const expectedBaseMap = normalizeTaskDeleteBaseUpdatedAtMap(fingerprint.pendingTaskDeleteBaseUpdatedAtMap);
  const currentOperationConflicts = normalizeOperationConflictFingerprints(currentConflict.operationConflicts);
  const expectedOperationConflicts = fingerprint.operationConflictFingerprints ?? [];

  return (currentConflict.ownerUserId ?? fingerprint.ownerUserId) === fingerprint.ownerUserId
    && (fingerprint.conflictedAt === undefined || currentConflict.conflictedAt === fingerprint.conflictedAt)
    && currentConflict.localVersion === (fingerprint.localVersion ?? currentConflict.localVersion)
    && (currentConflict.remoteVersion ?? 0) === (fingerprint.remoteVersion ?? 0)
    && currentPendingDeletes.length === expectedPendingDeletes.length
    && currentPendingDeletes.every((taskId, index) => taskId === expectedPendingDeletes[index])
    && areNormalizedTaskDeleteBaseUpdatedAtMapsEqual(currentBaseMap, expectedBaseMap)
    && areSortedStringArraysEqual(currentOperationConflicts, expectedOperationConflicts);
}

export function doesActiveConflictMatchSnapshot(
  currentConflict: ActiveConflictSnapshot | null,
  expectedConflict?: ActiveConflictSnapshot | null,
): boolean {
  if (!currentConflict || !expectedConflict || currentConflict.projectId !== expectedConflict.projectId) {
    return false;
  }

  if (currentConflict === expectedConflict) {
    return true;
  }

  const currentPendingDeletes = [...(currentConflict.pendingTaskDeleteIds ?? [])].sort();
  const expectedPendingDeletes = [...(expectedConflict.pendingTaskDeleteIds ?? [])].sort();
  const currentBaseMap = normalizeTaskDeleteBaseUpdatedAtMap(currentConflict.pendingTaskDeleteBaseUpdatedAtMap);
  const expectedBaseMap = normalizeTaskDeleteBaseUpdatedAtMap(expectedConflict.pendingTaskDeleteBaseUpdatedAtMap);
  const currentOperationConflicts = normalizeOperationConflictFingerprints(currentConflict.operationConflicts);
  const expectedOperationConflicts = normalizeOperationConflictFingerprints(expectedConflict.operationConflicts);

  return (expectedConflict.conflictedAt === undefined || currentConflict.conflictedAt === expectedConflict.conflictedAt)
    && activeLocalVersion(currentConflict) === activeLocalVersion(expectedConflict)
    && activeRemoteVersion(currentConflict) === activeRemoteVersion(expectedConflict)
    && currentPendingDeletes.length === expectedPendingDeletes.length
    && currentPendingDeletes.every((taskId, index) => taskId === expectedPendingDeletes[index])
    && areNormalizedTaskDeleteBaseUpdatedAtMapsEqual(currentBaseMap, expectedBaseMap)
    && areSortedStringArraysEqual(currentOperationConflicts, expectedOperationConflicts);
}

function activeConflictToFingerprint(
  activeConflict: ActiveConflictSnapshot | null,
  ownerUserId: string | null,
): ConflictFingerprint | null {
  if (!activeConflict?.projectId) return null;
  return {
    projectId: activeConflict.projectId,
    ownerUserId,
    conflictedAt: activeConflict.conflictedAt,
    localVersion: activeLocalVersion(activeConflict, undefined),
    remoteVersion: activeRemoteVersion(activeConflict, undefined),
    pendingTaskDeleteIds: [...(activeConflict.pendingTaskDeleteIds ?? [])],
    pendingTaskDeleteBaseUpdatedAtMap: normalizeTaskDeleteBaseUpdatedAtMap(activeConflict.pendingTaskDeleteBaseUpdatedAtMap),
    operationConflictFingerprints: normalizeOperationConflictFingerprints(activeConflict.operationConflicts),
  };
}

function storedConflictToFingerprint(
  storedConflict: StoredConflictSnapshot | null,
  ownerUserId: string | null,
): ConflictFingerprint | null {
  if (!storedConflict) return null;
  return {
    projectId: storedConflict.projectId,
    ownerUserId: storedConflict.ownerUserId ?? ownerUserId,
    conflictedAt: storedConflict.conflictedAt,
    localVersion: storedConflict.localVersion,
    remoteVersion: storedConflict.remoteVersion,
    pendingTaskDeleteIds: [...(storedConflict.pendingTaskDeleteIds ?? [])],
    pendingTaskDeleteBaseUpdatedAtMap: normalizeTaskDeleteBaseUpdatedAtMap(storedConflict.pendingTaskDeleteBaseUpdatedAtMap),
    operationConflictFingerprints: normalizeOperationConflictFingerprints(storedConflict.operationConflicts),
  };
}

function pickConflictFingerprint(
  storedFingerprint: ConflictFingerprint | null,
  activeFingerprint: ConflictFingerprint | null,
): ConflictFingerprint | null {
  if (!activeFingerprint || !storedFingerprint) {
    return storedFingerprint ?? activeFingerprint;
  }
  if (!activeFingerprint.conflictedAt) return storedFingerprint;
  if (!storedFingerprint.conflictedAt) return activeFingerprint;
  return storedFingerprint.conflictedAt >= activeFingerprint.conflictedAt
    ? storedFingerprint
    : activeFingerprint;
}

function emptyConflictFingerprint(
  activeConflict: ActiveConflictSnapshot | null,
  ownerUserId: string | null,
): ConflictFingerprint {
  return {
    projectId: activeConflict?.projectId ?? '',
    ownerUserId,
    conflictedAt: activeConflict?.conflictedAt,
    localVersion: activeConflict ? activeLocalVersion(activeConflict, undefined) : undefined,
    remoteVersion: activeConflict ? activeRemoteVersion(activeConflict, undefined) : undefined,
    pendingTaskDeleteIds: [...(activeConflict?.pendingTaskDeleteIds ?? [])],
    pendingTaskDeleteBaseUpdatedAtMap: normalizeTaskDeleteBaseUpdatedAtMap(
      activeConflict?.pendingTaskDeleteBaseUpdatedAtMap,
    ),
    operationConflictFingerprints: normalizeOperationConflictFingerprints(activeConflict?.operationConflicts),
  };
}

function activeLocalVersion(
  conflict: ActiveConflictSnapshot,
  fallback = 0,
): number | undefined {
  return conflict.local?.version ?? conflict.localProject?.version ?? fallback;
}

function activeRemoteVersion(
  conflict: ActiveConflictSnapshot,
  fallback = 0,
): number | undefined {
  return conflict.remote?.version ?? conflict.remoteProject?.version ?? fallback;
}

function normalizeTaskDeleteBaseUpdatedAtMap(
  pendingTaskDeleteBaseUpdatedAtMap: TaskDeleteBaseUpdatedAtMap | undefined,
): TaskDeleteBaseUpdatedAtMap {
  return Object.fromEntries(
    Object.entries(pendingTaskDeleteBaseUpdatedAtMap ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([taskId, baseUpdatedAt]) => [taskId, baseUpdatedAt ?? null]),
  );
}

function areNormalizedTaskDeleteBaseUpdatedAtMapsEqual(
  left: TaskDeleteBaseUpdatedAtMap,
  right: TaskDeleteBaseUpdatedAtMap,
): boolean {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  return leftEntries.length === rightEntries.length
    && leftEntries.every(([taskId, baseUpdatedAt], index) => {
      const [rightTaskId, rightBaseUpdatedAt] = rightEntries[index] ?? [];
      return taskId === rightTaskId && (baseUpdatedAt ?? null) === (rightBaseUpdatedAt ?? null);
    });
}

function normalizeOperationConflictFingerprints(
  operationConflicts: OperationConflictRecord[] | undefined,
): string[] {
  return (operationConflicts ?? [])
    .map(conflict => stableStringify({
      actionId: conflict.actionId ?? null,
      actionType: conflict.actionType,
      entityType: conflict.entityType,
      entityId: conflict.entityId,
      projectId: conflict.projectId,
      operationId: conflict.operationId ?? null,
      localEntity: conflict.localEntity,
      remoteEntity: conflict.remoteEntity ?? null,
      code: conflict.code ?? null,
      message: conflict.message,
      details: conflict.details ?? null,
      conflictedAt: conflict.conflictedAt,
      reason: conflict.reason,
    }))
    .sort();
}

function areSortedStringArraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stabilizeJsonValue(value));
}

function stabilizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(item => stabilizeJsonValue(item));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => [key, stabilizeJsonValue(entryValue)]),
  );
}
