import type {
  BackupData,
  BackupDataSafetyLastWriteExplain,
  BackupDataSafetyReplayEntry,
} from '../../supabase/functions/_shared/backup-utils';
import {
  compareProjectSyncCursor,
  isProjectSyncCursor,
  type ProjectSyncCursor,
} from '../app/core/state/persistence';

export interface DataSafetyProjectCursorSnapshot {
  projectId: string;
  userId: string;
  cursor: ProjectSyncCursor;
}
export interface DataSafetyTaskTombstoneSnapshot {
  [projectId: string]: Record<string, number>;
}

export interface DataSafetyConnectionTombstoneSnapshot {
  projectId: string;
  connectionId: string;
  timestamp: number;
}

export interface DataSafetyMetadataRestoreState {
  projectCursors: DataSafetyProjectCursorSnapshot[];
  lastSyncTime: string | null;
  replayLog: BackupDataSafetyReplayEntry[];
  lastWriteExplain: BackupDataSafetyLastWriteExplain | null;
  taskTombstones: DataSafetyTaskTombstoneSnapshot;
  connectionTombstones: DataSafetyConnectionTombstoneSnapshot[];
}

export interface DataSafetyMetadataRestoreCounts {
  projectCursors: number;
  lastSyncTime: number;
  replayLog: number;
  lastWriteExplain: number;
  taskTombstones: number;
  connectionTombstones: number;
}

export interface DataSafetyMetadataRestorePlan {
  ownerUserId: string;
  target: DataSafetyMetadataRestoreState;
  counts: DataSafetyMetadataRestoreCounts;
}

export interface DataSafetyMetadataRestoreAdapter {
  readCurrent(
    ownerUserId: string,
    visibleProjectIds: ReadonlySet<string>,
  ): Promise<DataSafetyMetadataRestoreState>;
  replaceAtomically(
    ownerUserId: string,
    target: DataSafetyMetadataRestoreState,
    rollbackState: DataSafetyMetadataRestoreState,
  ): Promise<void>;
}

export class DataSafetyMetadataValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DataSafetyMetadataValidationError';
  }
}

interface MergeResult<T> {
  value: T;
  changed: number;
}

export function buildDataSafetyMetadataRestorePlan(
  backup: BackupData,
  ownerUserId: string,
  current: DataSafetyMetadataRestoreState,
): DataSafetyMetadataRestorePlan {
  const incoming = readIncomingDataSafetyMetadata(backup, ownerUserId);
  const projectCursors = mergeProjectCursorSnapshots(current.projectCursors, incoming.projectCursors);
  const replayLog = mergeReplayLog(current.replayLog, incoming.replayLog);
  const lastWriteExplain = pickLatestLastWriteExplain(
    current.lastWriteExplain,
    incoming.lastWriteExplain,
  );
  const taskTombstones = mergeTaskTombstones(current.taskTombstones, incoming.taskTombstones);
  const connectionTombstones = mergeConnectionTombstones(
    current.connectionTombstones,
    incoming.connectionTombstones,
  );
  const lastSyncTime = pickLatestIsoTimestamp(current.lastSyncTime, incoming.lastSyncTime);

  return {
    ownerUserId,
    target: {
      projectCursors: projectCursors.value,
      lastSyncTime,
      replayLog: replayLog.value,
      lastWriteExplain,
      taskTombstones: taskTombstones.value,
      connectionTombstones: connectionTombstones.value,
    },
    counts: {
      projectCursors: projectCursors.changed,
      lastSyncTime: lastSyncTime !== current.lastSyncTime ? 1 : 0,
      replayLog: replayLog.changed,
      lastWriteExplain: lastWriteExplain !== current.lastWriteExplain ? 1 : 0,
      taskTombstones: taskTombstones.changed,
      connectionTombstones: connectionTombstones.changed,
    },
  };
}

export async function restoreDataSafetyMetadataFromBackup(
  backup: BackupData,
  ownerUserId: string,
  adapter: DataSafetyMetadataRestoreAdapter,
): Promise<DataSafetyMetadataRestoreCounts> {
  const visibleProjectIds = new Set(
    (backup.projects ?? [])
      .filter(project => project.userId === ownerUserId)
      .map(project => project.id),
  );
  const current = await adapter.readCurrent(ownerUserId, visibleProjectIds);
  const plan = buildDataSafetyMetadataRestorePlan(backup, ownerUserId, current);
  await adapter.replaceAtomically(ownerUserId, plan.target, current);
  return plan.counts;
}

function readIncomingDataSafetyMetadata(
  backup: BackupData,
  ownerUserId: string,
): DataSafetyMetadataRestoreState {
  const snapshot = backup.localState?.dataSafety;
  if (!snapshot) {
    throw new DataSafetyMetadataValidationError('localState.dataSafety is required');
  }
  if (snapshot.schemaVersion !== '1.0.0') {
    throw new DataSafetyMetadataValidationError('localState.dataSafety.schemaVersion must be 1.0.0');
  }
  if (snapshot.ownerUserId !== ownerUserId) {
    throw new DataSafetyMetadataValidationError('localState.dataSafety.ownerUserId does not match restore owner');
  }
  if (!isValidIsoTimestamp(snapshot.exportedAt)) {
    throw new DataSafetyMetadataValidationError('localState.dataSafety.exportedAt is invalid');
  }
  validateReplayPlan(snapshot.replayPlan, ownerUserId);

  const visibleProjectIds = new Set(
    (backup.projects ?? [])
      .filter(project => project.userId === ownerUserId)
      .map(project => project.id),
  );

  return {
    projectCursors: readProjectCursorSnapshots(
      snapshot.syncSnapshot?.projectCursors,
      ownerUserId,
      visibleProjectIds,
    ),
    lastSyncTime: readNullableIsoTimestamp(
      snapshot.syncSnapshot?.syncState?.lastSyncTime,
      'localState.dataSafety.syncSnapshot.syncState.lastSyncTime',
    ),
    replayLog: readReplayLog(snapshot.replayLog),
    lastWriteExplain: readLastWriteExplain(snapshot.lastWriteExplain),
    taskTombstones: readTaskTombstones(backup.localState?.taskTombstones, visibleProjectIds),
    connectionTombstones: readConnectionTombstones(
      backup.localState?.connectionTombstones,
      visibleProjectIds,
    ),
  };
}

function readProjectCursorSnapshots(
  value: unknown,
  ownerUserId: string,
  visibleProjectIds: ReadonlySet<string>,
): DataSafetyProjectCursorSnapshot[] {
  if (!Array.isArray(value)) {
    throw new DataSafetyMetadataValidationError(
      'localState.dataSafety.syncSnapshot.projectCursors must be an array',
    );
  }

  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new DataSafetyMetadataValidationError(`projectCursors[${index}] must be an object`);
    }
    const record = entry as Record<string, unknown>;
    const projectId = record['projectId'];
    const userId = record['userId'];
    const cursor = record['cursor'];
    if (typeof projectId !== 'string' || !visibleProjectIds.has(projectId)) {
      throw new DataSafetyMetadataValidationError(
        `projectCursors[${index}].projectId is outside the backup project scope`,
      );
    }
    if (userId !== ownerUserId) {
      throw new DataSafetyMetadataValidationError(
        `projectCursors[${index}].userId does not match restore owner`,
      );
    }
    if (!isProjectSyncCursor(cursor) || !isValidIsoTimestamp(cursor.updatedAt)) {
      throw new DataSafetyMetadataValidationError(`projectCursors[${index}].cursor is invalid`);
    }
    return { projectId, userId, cursor };
  });
}

function readReplayLog(value: unknown): BackupDataSafetyReplayEntry[] {
  if (!Array.isArray(value) || !value.every(isBackupReplayEntry)) {
    throw new DataSafetyMetadataValidationError('localState.dataSafety.replayLog is invalid');
  }
  return value;
}

function readLastWriteExplain(value: unknown): BackupDataSafetyLastWriteExplain | null {
  if (value === null) return null;
  if (!isBackupLastWriteExplain(value)) {
    throw new DataSafetyMetadataValidationError('localState.dataSafety.lastWriteExplain is invalid');
  }
  return value;
}

export function readTaskTombstones(
  value: unknown,
  visibleProjectIds: ReadonlySet<string>,
): DataSafetyTaskTombstoneSnapshot {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new DataSafetyMetadataValidationError('localState.taskTombstones must be an object');
  }

  const result: DataSafetyTaskTombstoneSnapshot = {};
  for (const [projectId, rawEntries] of Object.entries(value)) {
    if (!visibleProjectIds.has(projectId)) {
      throw new DataSafetyMetadataValidationError(
        `localState.taskTombstones.${projectId} is outside the backup project scope`,
      );
    }
    if (!rawEntries || typeof rawEntries !== 'object' || Array.isArray(rawEntries)) {
      throw new DataSafetyMetadataValidationError(
        `localState.taskTombstones.${projectId} must be an object`,
      );
    }
    const entries: Record<string, number> = {};
    for (const [taskId, timestamp] of Object.entries(rawEntries)) {
      if (!taskId || !isValidTombstoneTimestamp(timestamp)) {
        throw new DataSafetyMetadataValidationError(
          `localState.taskTombstones.${projectId}.${taskId || '<empty>'} is invalid`,
        );
      }
      entries[taskId] = timestamp;
    }
    result[projectId] = entries;
  }
  return result;
}

export function readConnectionTombstones(
  value: unknown,
  visibleProjectIds: ReadonlySet<string>,
): DataSafetyConnectionTombstoneSnapshot[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new DataSafetyMetadataValidationError('localState.connectionTombstones must be an array');
  }

  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new DataSafetyMetadataValidationError(`connectionTombstones[${index}] must be an object`);
    }
    const record = entry as Record<string, unknown>;
    const projectId = record['projectId'];
    const connectionId = record['connectionId'] ?? record['id'];
    const timestamp = record['timestamp'];
    if (typeof projectId !== 'string' || !visibleProjectIds.has(projectId)) {
      throw new DataSafetyMetadataValidationError(
        `connectionTombstones[${index}].projectId is outside the backup project scope`,
      );
    }
    if (typeof connectionId !== 'string' || !connectionId) {
      throw new DataSafetyMetadataValidationError(`connectionTombstones[${index}].connectionId is invalid`);
    }
    if (!isValidTombstoneTimestamp(timestamp)) {
      throw new DataSafetyMetadataValidationError(`connectionTombstones[${index}].timestamp is invalid`);
    }
    return { projectId, connectionId, timestamp };
  });
}

function mergeProjectCursorSnapshots(
  current: DataSafetyProjectCursorSnapshot[],
  incoming: DataSafetyProjectCursorSnapshot[],
): MergeResult<DataSafetyProjectCursorSnapshot[]> {
  const merged = new Map(current.map(entry => [entry.projectId, entry]));
  let changed = 0;
  for (const entry of incoming) {
    const existing = merged.get(entry.projectId);
    if (!existing || compareProjectSyncCursor(entry.cursor, existing.cursor) > 0) {
      merged.set(entry.projectId, entry);
      changed += 1;
    }
  }
  return {
    value: Array.from(merged.values()).sort((left, right) => left.projectId.localeCompare(right.projectId)),
    changed,
  };
}

function mergeReplayLog(
  current: BackupDataSafetyReplayEntry[],
  incoming: BackupDataSafetyReplayEntry[],
): MergeResult<BackupDataSafetyReplayEntry[]> {
  const merged = new Map(incoming.map(entry => [entry.operationId, entry]));
  for (const entry of current) {
    merged.set(entry.operationId, entry);
  }
  const currentOperationIds = new Set(current.map(entry => entry.operationId));
  const value = Array.from(merged.values())
    .sort((left, right) =>
      left.localCommittedAt - right.localCommittedAt
        || left.operationId.localeCompare(right.operationId))
    .slice(-100);
  return {
    value,
    changed: value.filter(entry => !currentOperationIds.has(entry.operationId)).length,
  };
}

function validateReplayPlan(value: unknown, ownerUserId: string): void {
  if (!value || typeof value !== 'object') {
    throw new DataSafetyMetadataValidationError('localState.dataSafety.replayPlan is invalid');
  }
  const record = value as Record<string, unknown>;
  if (record['ownerUserId'] !== ownerUserId) {
    throw new DataSafetyMetadataValidationError(
      'localState.dataSafety.replayPlan.ownerUserId does not match restore owner',
    );
  }
  if (typeof record['idempotencyKey'] !== 'string' || !record['idempotencyKey']) {
    throw new DataSafetyMetadataValidationError(
      'localState.dataSafety.replayPlan.idempotencyKey is invalid',
    );
  }
  if (typeof record['exportedAt'] !== 'string' || !isValidIsoTimestamp(record['exportedAt'])) {
    throw new DataSafetyMetadataValidationError(
      'localState.dataSafety.replayPlan.exportedAt is invalid',
    );
  }
  if (!Array.isArray(record['steps']) || !isReplayPlanSummary(record['summary'])) {
    throw new DataSafetyMetadataValidationError('localState.dataSafety.replayPlan is invalid');
  }
}

function isReplayPlanSummary(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return ['replayable', 'inspectOnly', 'retryQueue', 'actionQueue', 'auditLog']
    .every(key => typeof record[key] === 'number'
      && Number.isFinite(record[key])
      && (record[key] as number) >= 0);
}

function pickLatestLastWriteExplain(
  current: BackupDataSafetyLastWriteExplain | null,
  incoming: BackupDataSafetyLastWriteExplain | null,
): BackupDataSafetyLastWriteExplain | null {
  if (!incoming) return current;
  if (!current) return incoming;
  return incoming.localTimestamp > current.localTimestamp ? incoming : current;
}

function mergeTaskTombstones(
  current: DataSafetyTaskTombstoneSnapshot,
  incoming: DataSafetyTaskTombstoneSnapshot,
): MergeResult<DataSafetyTaskTombstoneSnapshot> {
  const value = Object.fromEntries(
    Object.entries(current).map(([projectId, entries]) => [projectId, { ...entries }]),
  );
  let changed = 0;
  for (const [projectId, entries] of Object.entries(incoming)) {
    const targetEntries = value[projectId] ?? {};
    for (const [taskId, timestamp] of Object.entries(entries)) {
      const existing = targetEntries[taskId];
      if (existing === undefined || timestamp > existing) {
        targetEntries[taskId] = timestamp;
        changed += 1;
      }
    }
    value[projectId] = targetEntries;
  }
  return { value, changed };
}

function mergeConnectionTombstones(
  current: DataSafetyConnectionTombstoneSnapshot[],
  incoming: DataSafetyConnectionTombstoneSnapshot[],
): MergeResult<DataSafetyConnectionTombstoneSnapshot[]> {
  const keyOf = (entry: DataSafetyConnectionTombstoneSnapshot): string =>
    `${entry.projectId}\u0000${entry.connectionId}`;
  const merged = new Map(current.map(entry => [keyOf(entry), entry]));
  let changed = 0;
  for (const entry of incoming) {
    const key = keyOf(entry);
    const existing = merged.get(key);
    if (!existing || entry.timestamp > existing.timestamp) {
      merged.set(key, entry);
      changed += 1;
    }
  }
  return {
    value: Array.from(merged.values()).sort((left, right) =>
      left.projectId.localeCompare(right.projectId)
        || left.connectionId.localeCompare(right.connectionId)),
    changed,
  };
}

function pickLatestIsoTimestamp(current: string | null, incoming: string | null): string | null {
  if (!incoming) return current;
  if (!current) return incoming;
  return Date.parse(incoming) > Date.parse(current) ? incoming : current;
}

function readNullableIsoTimestamp(value: unknown, path: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !isValidIsoTimestamp(value)) {
    throw new DataSafetyMetadataValidationError(`${path} is invalid`);
  }
  return value;
}

function isValidIsoTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function isValidTombstoneTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isBackupReplayEntry(value: unknown): value is BackupDataSafetyReplayEntry {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record['operationId'] === 'string'
    && typeof record['entityType'] === 'string'
    && typeof record['entityId'] === 'string'
    && typeof record['operation'] === 'string'
    && typeof record['localCommittedAt'] === 'number'
    && !!record['queue']
    && !!record['rpc']
    && !!record['lww']
    && !!record['lastSyncTime'];
}

function isBackupLastWriteExplain(value: unknown): value is BackupDataSafetyLastWriteExplain {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record['operationId'] === 'string'
    && typeof record['operation'] === 'string'
    && typeof record['localTimestamp'] === 'number'
    && !!record['actor']
    && !!record['entity']
    && !!record['queueResult']
    && !!record['rpcResult']
    && !!record['lwwDecision']
    && !!record['lastSyncTime'];
}
