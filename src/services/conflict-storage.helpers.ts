import type { Connection, Project, Task } from '../models';
import type { TaskDeleteBaseUpdatedAtMap } from './action-queue.types';

export type OperationConflictEntityType = 'task' | 'connection';

export type OperationConflictActionType =
  | 'task:create'
  | 'task:update'
  | 'task:delete'
  | 'connection:create'
  | 'connection:update'
  | 'connection:delete';

export interface OperationConflictRecord {
  actionId?: string;
  actionType: OperationConflictActionType;
  entityType: OperationConflictEntityType;
  entityId: string;
  projectId: string;
  operationId?: string;
  localEntity: Task | Connection;
  remoteEntity?: Task | Connection;
  code?: string;
  message: string;
  details?: unknown;
  conflictedAt: string;
  reason: 'remote-newer' | 'remote-tombstone' | 'version_mismatch';
}

export interface ConflictRecord {
  /** 项目 ID */
  projectId: string;
  /** 冲突所属用户，用于跨账号隔离 */
  ownerUserId?: string;
  /** 完整的本地项目数据（用户心血所在） */
  localProject: Project;
  /** 完整的远程项目数据（用于对比和解决） */
  remoteProject?: Project;
  /** 远端快照是否为本轮冲突新鲜获取，false 表示仅作参考不可直接用于 remote/merge */
  remoteSnapshotFresh?: boolean;
  /** 冲突发生时间 */
  conflictedAt: string;
  /** 本地版本号 */
  localVersion: number;
  /** 远程版本号（如果已知） */
  remoteVersion?: number;
  /** 冲突原因 */
  reason: 'version_mismatch' | 'concurrent_edit' | 'network_recovery' | 'status_conflict' | 'field_conflict';
  /** 冲突的字段列表（用于展示差异） */
  conflictedFields?: string[];
  /** 冲突前已确认的待删除任务，解决冲突后仍需继续回放 */
  pendingTaskDeleteIds?: string[];
  /** pendingTaskDeleteIds 对应的 task.updatedAt CAS 基线 */
  pendingTaskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap;
  /** 细粒度本地操作冲突证据，用于 task / connection 级别不可自动合并的写入 */
  operationConflicts?: OperationConflictRecord[];
  /** 是否已读/已处理 */
  acknowledged?: boolean;
}

export interface StoredConflictRecord extends ConflictRecord {
  scopedId: string;
}

export const LEGACY_UNKNOWN_OWNER_USER_ID = '__legacy_unknown__';
export const CONFLICT_FALLBACK_KEY_PREFIX = 'nanoflow.conflict.';

export function resolveConflictOwnerUserId(
  record: ConflictRecord,
  defaultOwnerUserId = LEGACY_UNKNOWN_OWNER_USER_ID,
): string {
  return record.ownerUserId || defaultOwnerUserId;
}

export function getScopedConflictId(projectId: string, ownerUserId: string): string {
  return `${ownerUserId}::${projectId}`;
}

export function toStoredConflictRecord(
  record: ConflictRecord,
  defaultOwnerUserId = LEGACY_UNKNOWN_OWNER_USER_ID,
): StoredConflictRecord {
  const ownerUserId = resolveConflictOwnerUserId(record, defaultOwnerUserId);
  return {
    ...record,
    ownerUserId,
    scopedId: getScopedConflictId(record.projectId, ownerUserId),
  };
}

export function mergeConflictRecords(
  existingRecord: ConflictRecord | null | undefined,
  incomingRecord: ConflictRecord,
): ConflictRecord {
  if (!existingRecord) {
    return incomingRecord;
  }

  const operationConflicts = mergeOperationConflicts(
    existingRecord.operationConflicts,
    incomingRecord.operationConflicts,
  );
  const hasIncomingRemoteSnapshot = !!incomingRecord.remoteProject;
  const shouldKeepExistingFreshRemoteSnapshot = !hasIncomingRemoteSnapshot
    && existingRecord.remoteSnapshotFresh === true
    && !!existingRecord.remoteProject
    && (incomingRecord.operationConflicts?.length ?? 0) > 0
    && incomingRecord.localVersion === existingRecord.localVersion
    && (incomingRecord.remoteVersion ?? existingRecord.remoteVersion) === existingRecord.remoteVersion;
  const carriesIncomingFreshRemoteSnapshot = incomingRecord.remoteSnapshotFresh === true && hasIncomingRemoteSnapshot;

  return {
    ...existingRecord,
    ...incomingRecord,
    remoteProject: hasIncomingRemoteSnapshot
      ? incomingRecord.remoteProject
      : shouldKeepExistingFreshRemoteSnapshot
        ? existingRecord.remoteProject
        : undefined,
    remoteSnapshotFresh: carriesIncomingFreshRemoteSnapshot || shouldKeepExistingFreshRemoteSnapshot,
    remoteVersion: hasIncomingRemoteSnapshot
      ? incomingRecord.remoteVersion
      : shouldKeepExistingFreshRemoteSnapshot
        ? existingRecord.remoteVersion
        : undefined,
    conflictedFields: incomingRecord.conflictedFields ?? existingRecord.conflictedFields,
    pendingTaskDeleteIds: incomingRecord.pendingTaskDeleteIds ?? existingRecord.pendingTaskDeleteIds,
    pendingTaskDeleteBaseUpdatedAtMap: incomingRecord.pendingTaskDeleteBaseUpdatedAtMap
      ?? existingRecord.pendingTaskDeleteBaseUpdatedAtMap,
    operationConflicts: operationConflicts.length > 0 ? operationConflicts : undefined,
  };
}

function mergeOperationConflicts(
  existingConflicts: OperationConflictRecord[] | undefined,
  incomingConflicts: OperationConflictRecord[] | undefined,
): OperationConflictRecord[] {
  const merged: OperationConflictRecord[] = [];
  const conflictIndexes = new Map<string, number>();

  for (const conflict of [...(existingConflicts ?? []), ...(incomingConflicts ?? [])]) {
    const key = getOperationConflictKey(conflict);
    const existingIndex = conflictIndexes.get(key);
    if (existingIndex === undefined) {
      conflictIndexes.set(key, merged.length);
      merged.push(conflict);
      continue;
    }

    merged[existingIndex] = {
      ...merged[existingIndex],
      ...conflict,
      remoteEntity: conflict.remoteEntity ?? merged[existingIndex].remoteEntity,
      details: conflict.details ?? merged[existingIndex].details,
    };
  }

  return merged;
}

function getOperationConflictKey(conflict: OperationConflictRecord): string {
  if (conflict.operationId) {
    return `operation:${conflict.operationId}`;
  }
  if (conflict.actionId) {
    return `action:${conflict.actionId}`;
  }
  return `${conflict.entityType}:${conflict.entityId}:${conflict.actionType}:${conflict.conflictedAt}`;
}

export function isConflictRecordVisible(
  record: ConflictRecord | null | undefined,
  currentOwnerUserId: string,
): record is ConflictRecord {
  if (!record) return false;

  return typeof record.ownerUserId === 'string'
    && record.ownerUserId.length > 0
    && record.ownerUserId === currentOwnerUserId;
}

export function getConflictFallbackKey(
  projectId: string,
  ownerUserId: string,
  keyPrefix = CONFLICT_FALLBACK_KEY_PREFIX,
): string {
  if (ownerUserId === LEGACY_UNKNOWN_OWNER_USER_ID) {
    return `${keyPrefix}${projectId}`;
  }

  return `${keyPrefix}${ownerUserId}.${projectId}`;
}

export function selectPreferredConflictRecord(
  indexedRecord: ConflictRecord | null,
  fallbackRecord: ConflictRecord | null,
): ConflictRecord | null {
  if (!fallbackRecord) {
    return indexedRecord;
  }

  if (!indexedRecord) {
    return fallbackRecord;
  }

  return shouldPreferFallbackRecord(fallbackRecord, indexedRecord)
    ? fallbackRecord
    : indexedRecord;
}

function shouldPreferFallbackRecord(fallbackRecord: ConflictRecord, indexedRecord: ConflictRecord): boolean {
  if (fallbackRecord.conflictedAt !== indexedRecord.conflictedAt) {
    return fallbackRecord.conflictedAt > indexedRecord.conflictedAt;
  }

  return fallbackRecord.localVersion >= indexedRecord.localVersion;
}
