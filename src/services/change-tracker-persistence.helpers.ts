import { type ChangeRecord, type FieldLockData } from './change-tracker.types';

export const CHANGE_TRACKER_PENDING_CHANGES_STORAGE_KEY =
  'nanoflow.change-tracker.pending-changes.v1';
export const CHANGE_TRACKER_FIELD_LOCKS_STORAGE_KEY =
  'nanoflow.change-tracker.field-locks.v1';

export interface RestoredPendingChangeRecords {
  changes: ChangeRecord[];
  maxRevision: number;
}

export interface RestoredFieldLocks {
  locks: Array<[string, FieldLockData]>;
}

export function getChangeRecordRevision(
  record: Pick<ChangeRecord, 'revision' | 'timestamp'>,
): number {
  return typeof record.revision === 'number' && Number.isFinite(record.revision)
    ? record.revision
    : record.timestamp;
}

export function restorePendingChangeRecords(raw: string): RestoredPendingChangeRecords {
  const parsed = JSON.parse(raw) as { changes?: unknown };
  if (!Array.isArray(parsed.changes)) {
    return { changes: [], maxRevision: 0 };
  }

  const changes = parsed.changes
    .filter(isRestorableChangeRecord)
    .map(record => ({
      ...record,
      revision: getChangeRecordRevision(record),
    }));

  return {
    changes,
    maxRevision: changes.reduce(
      (maxRevision, record) => Math.max(maxRevision, record.revision ?? 0),
      0,
    ),
  };
}

export function serializePendingChanges(
  changes: ChangeRecord[],
  savedAt = new Date().toISOString(),
): string {
  return JSON.stringify({
    version: 1,
    changes,
    savedAt,
  });
}

export function restoreFieldLocks(
  raw: string,
  now = Date.now(),
  defaultDuration = 30_000,
): RestoredFieldLocks {
  const parsed = JSON.parse(raw) as { locks?: unknown };
  if (!Array.isArray(parsed.locks)) {
    return { locks: [] };
  }

  const locks: Array<[string, FieldLockData]> = [];
  for (const entry of parsed.locks) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') {
      continue;
    }

    const lockData = normalizeFieldLockData(entry[1], defaultDuration);
    if (!lockData) {
      continue;
    }

    if (now - lockData.timestamp > lockData.duration) {
      continue;
    }

    locks.push([entry[0], lockData]);
  }

  return { locks };
}

export function serializeFieldLocks(
  locks: Map<string, FieldLockData | number>,
  defaultDuration: number,
  savedAt = new Date().toISOString(),
): string {
  return JSON.stringify({
    version: 1,
    locks: Array.from(locks.entries()).map(([key, value]) => [
      key,
      typeof value === 'number'
        ? { timestamp: value, duration: defaultDuration }
        : value,
    ]),
    savedAt,
  });
}

function isRestorableChangeRecord(record: unknown): record is ChangeRecord {
  if (!record || typeof record !== 'object') return false;
  const candidate = record as Partial<ChangeRecord>;
  return typeof candidate.entityId === 'string'
    && (candidate.entityType === 'task' || candidate.entityType === 'connection')
    && (candidate.changeType === 'create'
      || candidate.changeType === 'update'
      || candidate.changeType === 'delete')
    && typeof candidate.projectId === 'string'
    && typeof candidate.timestamp === 'number'
    && Number.isFinite(candidate.timestamp);
}

function normalizeFieldLockData(value: unknown, defaultDuration: number): FieldLockData | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { timestamp: value, duration: defaultDuration };
  }

  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Partial<FieldLockData>;
  if (typeof candidate.timestamp !== 'number' || !Number.isFinite(candidate.timestamp)) {
    return null;
  }
  if (typeof candidate.duration !== 'number' || !Number.isFinite(candidate.duration) || candidate.duration <= 0) {
    return null;
  }

  return {
    timestamp: candidate.timestamp,
    duration: candidate.duration,
  };
}
