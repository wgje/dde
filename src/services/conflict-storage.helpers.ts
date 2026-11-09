import type { Connection, Project, Task } from '../models';
import type {
  ProjectConflictLocalHandoff,
  TaskDeleteBaseUpdatedAtMap,
} from './action-queue.types';

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
  /** 已解决项目重放前必须完成的本地交接证据。 */
  localHandoff?: ProjectConflictLocalHandoff;
  /** 是否已读/已处理 */
  acknowledged?: boolean;
}

export interface ProjectConflictLocalHandoffIdentity {
  ownerUserId: string;
  projectId: string;
  actionId: string;
  operationId: string;
  payloadDigest: string;
  conflictFingerprint: string;
}

export interface ReserveProjectConflictLocalHandoffInput
  extends ProjectConflictLocalHandoffIdentity {
  reservationId: string;
  reservedAt: string;
}

export interface PersistProjectConflictLocalHandoffRequirementInput
  extends ProjectConflictLocalHandoffIdentity {
  conflictRecord: ConflictRecord;
}

export interface VerifyProjectConflictLocalHandoffInput
  extends ProjectConflictLocalHandoffIdentity {
  reservationId: string;
}

export interface AdvanceProjectConflictLocalHandoffInput
  extends VerifyProjectConflictLocalHandoffInput {
  expectedState: 'reserved' | 'effects-applied';
  nextState: 'effects-applied' | 'complete';
  transitionedAt: string;
}

export type ProjectConflictLocalHandoffReservationResult =
  | { status: 'committed'; reservationId: string }
  | { status: 'missing' | 'identity-mismatch' | 'contended' | 'storage-failed' };

export type ProjectConflictLocalHandoffMutationResult =
  | { status: 'committed' }
  | { status: 'missing' | 'identity-mismatch' | 'state-mismatch' | 'contended' | 'storage-failed' };

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
  const localHandoff = selectConflictLocalHandoff(
    existingRecord.localHandoff,
    incomingRecord.localHandoff,
  );

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
    localHandoff,
  };
}

export function mergeConflictOperationEvidence(
  baseRecord: ConflictRecord,
  ...sources: Array<ConflictRecord | null | undefined>
): ConflictRecord {
  const merged = [
    ...sources.flatMap(source => source?.operationConflicts ?? []),
    ...(baseRecord.operationConflicts ?? []),
  ];
  if (merged.length === 0) return baseRecord;

  const conflicts = merged.reduce((result, conflict) => {
    result.set(getOperationConflictStorageKey(conflict), conflict);
    return result;
  }, new Map<string, OperationConflictRecord>());
  const operationConflicts = Array.from(conflicts.values()).sort((left, right) => {
    const timeOrder = left.conflictedAt.localeCompare(right.conflictedAt);
    return timeOrder || getOperationConflictStorageKey(left).localeCompare(getOperationConflictStorageKey(right));
  });
  return { ...baseRecord, operationConflicts };
}

function getOperationConflictStorageKey(conflict: OperationConflictRecord): string {
  if (conflict.operationId) return `operation:${conflict.operationId}`;
  if (conflict.actionId) return `action:${conflict.actionId}`;
  return `${conflict.entityType}:${conflict.entityId}:${conflict.actionType}:${conflict.conflictedAt}`;
}

function selectConflictLocalHandoff(
  existing: ProjectConflictLocalHandoff | undefined,
  incoming: ProjectConflictLocalHandoff | undefined,
): ProjectConflictLocalHandoff | undefined {
  if (!existing) return incoming;
  if (!incoming) return existing;
  if (!isSameLocalHandoffIdentity(existing, incoming)) {
    return existing.state === 'complete' ? incoming : existing;
  }

  const stateRank: Record<ProjectConflictLocalHandoff['state'], number> = {
    required: 0,
    reserved: 1,
    'effects-applied': 2,
    complete: 3,
  };
  return stateRank[incoming.state] > stateRank[existing.state] ? incoming : existing;
}

export function createProjectConflictRecordFingerprint(record: ConflictRecord): string {
  return stableStringify({
    projectId: record.projectId,
    ownerUserId: record.ownerUserId ?? null,
    localProject: record.localProject,
    remoteProject: record.remoteProject ?? null,
    remoteSnapshotFresh: record.remoteSnapshotFresh === true,
    conflictedAt: record.conflictedAt,
    localVersion: record.localVersion,
    remoteVersion: record.remoteVersion ?? null,
    reason: record.reason,
    conflictedFields: [...(record.conflictedFields ?? [])].sort(),
    pendingTaskDeleteIds: [...(record.pendingTaskDeleteIds ?? [])].sort(),
    pendingTaskDeleteBaseUpdatedAtMap: Object.fromEntries(
      Object.entries(record.pendingTaskDeleteBaseUpdatedAtMap ?? {})
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([taskId, value]) => [taskId, value ?? null]),
    ),
    operationConflicts: [...(record.operationConflicts ?? [])]
      .sort((left, right) => getOperationConflictStorageKey(left)
        .localeCompare(getOperationConflictStorageKey(right))),
  });
}

export function persistStoredConflictLocalHandoffRequirement(
  db: IDBDatabase,
  storeName: string,
  input: PersistProjectConflictLocalHandoffRequirementInput,
): Promise<ProjectConflictLocalHandoffMutationResult> {
  return mutateStoredConflictLocalHandoff<ProjectConflictLocalHandoffMutationResult>(
    db, storeName, input, storedRecord => {
    const current = storedRecord ?? toStoredConflictRecord({
      ...input.conflictRecord,
      ownerUserId: input.ownerUserId,
    }, input.ownerUserId);
    if (createProjectConflictRecordFingerprint(current) !== input.conflictFingerprint) {
      return { result: { status: 'identity-mismatch' } };
    }
    if (current.localHandoff) {
      const matches = isSameLocalHandoffIdentity(current.localHandoff, input);
      return {
        record: !storedRecord && matches ? current : undefined,
        result: matches ? { status: 'committed' } : { status: 'contended' },
      };
    }
    return {
      record: {
        ...current,
        localHandoff: {
          kind: 'resolved-project-conflict',
          state: 'required',
          ownerUserId: input.ownerUserId,
          projectId: input.projectId,
          actionId: input.actionId,
          operationId: input.operationId,
          payloadDigest: input.payloadDigest,
          conflictFingerprint: input.conflictFingerprint,
        },
      },
      result: { status: 'committed' },
    };
    }, { status: 'storage-failed' },
  );
}

export function isSameLocalHandoffIdentity(
  handoff: ProjectConflictLocalHandoff,
  identity: ProjectConflictLocalHandoffIdentity,
): boolean {
  return handoff.ownerUserId === identity.ownerUserId
    && handoff.projectId === identity.projectId
    && handoff.actionId === identity.actionId
    && handoff.operationId === identity.operationId
    && handoff.payloadDigest === identity.payloadDigest
    && handoff.conflictFingerprint === identity.conflictFingerprint;
}

export function reserveStoredConflictLocalHandoff(
  db: IDBDatabase,
  storeName: string,
  input: ReserveProjectConflictLocalHandoffInput,
): Promise<ProjectConflictLocalHandoffReservationResult> {
  return mutateStoredConflictLocalHandoff<ProjectConflictLocalHandoffReservationResult>(
    db, storeName, input, record => {
    if (!record) return { result: { status: 'missing' } };
    const handoff = record.localHandoff;
    if (!handoff) return { result: { status: 'identity-mismatch' } };
    if (!isSameLocalHandoffIdentity(handoff, input)) return { result: { status: 'contended' } };
    if (handoff.state !== 'required') {
      return {
        result: handoff.reservationId
          ? { status: 'committed', reservationId: handoff.reservationId }
          : { status: 'identity-mismatch' },
      };
    }
    return {
      record: {
        ...record,
        localHandoff: {
          ...handoff,
          state: 'reserved',
          reservationId: input.reservationId,
          reservedAt: input.reservedAt,
        },
      },
      result: { status: 'committed', reservationId: input.reservationId },
    };
    }, { status: 'storage-failed' },
  );
}

export function verifyStoredConflictLocalHandoffReservation(
  db: IDBDatabase,
  storeName: string,
  input: VerifyProjectConflictLocalHandoffInput,
): Promise<ProjectConflictLocalHandoffMutationResult> {
  return mutateStoredConflictLocalHandoff<ProjectConflictLocalHandoffMutationResult>(
    db, storeName, input, record => {
    if (!record) return { result: { status: 'missing' } };
    const handoff = record.localHandoff;
    if (!handoff || !isSameLocalHandoffIdentity(handoff, input)) {
      return { result: { status: 'identity-mismatch' } };
    }
    if (handoff.reservationId !== input.reservationId) {
      return { result: { status: 'contended' } };
    }
    return {
      result: handoff.state === 'reserved' || handoff.state === 'effects-applied'
        ? { status: 'committed' }
        : { status: 'state-mismatch' },
    };
    }, { status: 'storage-failed' },
  );
}

export function advanceStoredConflictLocalHandoff(
  db: IDBDatabase,
  storeName: string,
  input: AdvanceProjectConflictLocalHandoffInput,
): Promise<ProjectConflictLocalHandoffMutationResult> {
  return mutateStoredConflictLocalHandoff<ProjectConflictLocalHandoffMutationResult>(
    db, storeName, input, record => {
    if (!record) return { result: { status: 'missing' } };
    const handoff = record.localHandoff;
    if (!handoff || !isSameLocalHandoffIdentity(handoff, input)) {
      return { result: { status: 'identity-mismatch' } };
    }
    if (handoff.reservationId !== input.reservationId) {
      return { result: { status: 'contended' } };
    }
    const stateRank: Record<ProjectConflictLocalHandoff['state'], number> = {
      required: 0, reserved: 1, 'effects-applied': 2, complete: 3,
    };
    if (stateRank[handoff.state] >= stateRank[input.nextState]) {
      return { result: { status: 'committed' } };
    }
    if (handoff.state !== input.expectedState) {
      return { result: { status: 'state-mismatch' } };
    }
    const transitionTimestamp = input.nextState === 'effects-applied'
      ? { effectsAppliedAt: input.transitionedAt }
      : { completedAt: input.transitionedAt };
    return {
      record: {
        ...record,
        localHandoff: { ...handoff, ...transitionTimestamp, state: input.nextState },
      },
      result: { status: 'committed' },
    };
    }, { status: 'storage-failed' },
  );
}

export function deleteCompletedStoredConflictLocalHandoff(
  db: IDBDatabase,
  storeName: string,
  input: VerifyProjectConflictLocalHandoffInput,
): Promise<ProjectConflictLocalHandoffMutationResult> {
  return mutateStoredConflictLocalHandoff<ProjectConflictLocalHandoffMutationResult>(
    db, storeName, input, record => {
    if (!record) return { result: { status: 'missing' } };
    const handoff = record.localHandoff;
    if (!handoff || !isSameLocalHandoffIdentity(handoff, input)) {
      return { result: { status: 'identity-mismatch' } };
    }
    if (handoff.reservationId !== input.reservationId) {
      return { result: { status: 'contended' } };
    }
    return handoff.state === 'complete'
      ? { delete: true, result: { status: 'committed' } }
      : { result: { status: 'state-mismatch' } };
    }, { status: 'storage-failed' },
  );
}

type StoredConflictMutation<T> = {
  delete?: boolean;
  record?: StoredConflictRecord;
  result: T;
};

function mutateStoredConflictLocalHandoff<T>(
  db: IDBDatabase,
  storeName: string,
  identity: Pick<ProjectConflictLocalHandoffIdentity, 'ownerUserId' | 'projectId'>,
  mutate: (record: StoredConflictRecord | undefined) => StoredConflictMutation<T>,
  storageFailure: T,
): Promise<T> {
  return new Promise(resolve => {
    let outcome: T | undefined;
    let settled = false;
    const finish = (result: T): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    try {
      const transaction = db.transaction([storeName], 'readwrite');
      const store = transaction.objectStore(storeName);
      const getRequest = store.get(getScopedConflictId(identity.projectId, identity.ownerUserId));

      getRequest.onsuccess = () => {
        const record = getRequest.result as StoredConflictRecord | undefined;
        const mutation = mutate(record);
        outcome = mutation.result;
        if (mutation.delete) {
          const deleteRequest = store.delete(getScopedConflictId(identity.projectId, identity.ownerUserId));
          deleteRequest.onerror = () => finish(storageFailure);
          return;
        }
        if (!mutation.record) return;
        const putRequest = store.put(mutation.record);
        putRequest.onerror = () => finish(storageFailure);
      };
      getRequest.onerror = () => finish(storageFailure);
      transaction.oncomplete = () => finish(outcome ?? storageFailure);
      transaction.onerror = () => finish(storageFailure);
      transaction.onabort = () => finish(storageFailure);
    } catch {
      finish(storageFailure);
    }
  });
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

  const indexedProtected = indexedRecord.localHandoff
    && indexedRecord.localHandoff.state !== 'complete';
  const fallbackProtected = fallbackRecord.localHandoff
    && fallbackRecord.localHandoff.state !== 'complete';
  if (indexedProtected !== fallbackProtected) {
    return indexedProtected ? indexedRecord : fallbackRecord;
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

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort()
      .map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}
