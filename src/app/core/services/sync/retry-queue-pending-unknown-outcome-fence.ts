import type {
  RetryQueueItem,
  RetryQueueLastFailure,
  RetryableEntityType,
  RetryableOperation,
} from './retry-queue.types';

export const RETRY_QUEUE_UNKNOWN_OUTCOME_STORAGE_PRESSURE_REASON = 'storage_unknown_outcome';

const PENDING_UNKNOWN_OUTCOME_FENCE_PREFIX = 'nanoflow.retry-queue.pending-unknown-outcome.';
const PENDING_UNKNOWN_OUTCOME_FENCE_VERSION = 1 as const;

const RETRYABLE_ENTITY_TYPES = new Set<RetryableEntityType>([
  'task',
  'project',
  'connection',
  'blackbox',
]);
const RETRYABLE_OPERATIONS = new Set<RetryableOperation>(['upsert', 'delete']);

export interface RetryQueuePendingUnknownOutcomeFence {
  schemaVersion: typeof PENDING_UNKNOWN_OUTCOME_FENCE_VERSION;
  ownerUserId: string;
  queueItemId: string;
  entityType: RetryableEntityType;
  operation: RetryableOperation;
  entityId: string;
  sourceUserId: string | null;
  operationId: string;
  lastFailure: RetryQueueLastFailure;
  createdAt: number;
}

export type RetryQueueFenceStorageKind = 'local' | 'session';

export interface RetryQueuePendingUnknownOutcomeFenceRecord {
  fence: RetryQueuePendingUnknownOutcomeFence;
  storageKind: RetryQueueFenceStorageKind;
  key: string;
}

export interface RetryQueuePendingUnknownOutcomeFenceSnapshot {
  records: RetryQueuePendingUnknownOutcomeFenceRecord[];
  malformedKeys: string[];
}

export function createRetryQueuePendingUnknownOutcomeFence(
  item: RetryQueueItem,
  ownerUserId: string,
  createdAt = Date.now(),
): RetryQueuePendingUnknownOutcomeFence {
  return {
    schemaVersion: PENDING_UNKNOWN_OUTCOME_FENCE_VERSION,
    ownerUserId,
    queueItemId: item.id,
    entityType: item.type,
    operation: item.operation,
    entityId: item.data.id,
    sourceUserId: item.sourceUserId ?? null,
    operationId: item.operationId,
    lastFailure: item.lastFailure ?? {
      errorType: 'PendingUnknownOutcome',
      message: 'RetryQueue replay was in flight when the remote outcome became unknown',
      remoteOutcome: 'unknown',
      recordedAt: createdAt,
    },
    createdAt,
  };
}

export function updateRetryQueuePendingUnknownOutcomeFence(
  fence: RetryQueuePendingUnknownOutcomeFence,
  lastFailure: RetryQueueLastFailure | undefined,
): RetryQueuePendingUnknownOutcomeFence {
  return lastFailure?.remoteOutcome === 'unknown'
    ? { ...fence, lastFailure }
    : fence;
}

export function pendingUnknownOutcomeFenceKey(ownerUserId: string): string {
  return `${PENDING_UNKNOWN_OUTCOME_FENCE_PREFIX}${encodeURIComponent(ownerUserId)}`;
}

export function readRetryQueuePendingUnknownOutcomeFences(): RetryQueuePendingUnknownOutcomeFenceSnapshot {
  const records: RetryQueuePendingUnknownOutcomeFenceRecord[] = [];
  const malformedKeys: string[] = [];
  readFencesFromStorage('local', records, malformedKeys);
  readFencesFromStorage('session', records, malformedKeys);
  return { records, malformedKeys };
}

export function writeRetryQueuePendingUnknownOutcomeFence(
  fence: RetryQueuePendingUnknownOutcomeFence,
): boolean {
  const key = pendingUnknownOutcomeFenceKey(fence.ownerUserId);
  const serialized = JSON.stringify(fence);

  try {
    const storage = getStorage('local');
    if (storage) {
      storage.setItem(key, serialized);
      removeFenceFromStorage('session', key);
      return true;
    }
  } catch {
    // Fall through to sessionStorage so a local storage failure still leaves a
    // same-session recovery fence before the remote write starts.
  }

  try {
    const storage = getStorage('session');
    if (!storage) return false;
    storage.setItem(key, serialized);
    return true;
  } catch {
    return false;
  }
}

export function clearRetryQueuePendingUnknownOutcomeFence(
  fence: RetryQueuePendingUnknownOutcomeFence,
): boolean {
  const snapshot = readRetryQueuePendingUnknownOutcomeFences();
  if (hasMalformedRetryQueuePendingUnknownOutcomeFenceForOwner(snapshot, fence.ownerUserId)) {
    return false;
  }

  const records = snapshot.records.filter(record => isSameFenceIdentity(record.fence, fence));
  if (records.length === 0) return true;

  let cleared = true;
  for (const record of records) {
    try {
      const storage = getStorage(record.storageKind);
      if (!storage) {
        cleared = false;
        continue;
      }
      storage.removeItem(record.key);
    } catch {
      cleared = false;
    }
  }
  return cleared;
}

export function hasMalformedRetryQueuePendingUnknownOutcomeFenceForOwner(
  snapshot: RetryQueuePendingUnknownOutcomeFenceSnapshot,
  ownerUserId: string,
): boolean {
  const key = pendingUnknownOutcomeFenceKey(ownerUserId);
  return snapshot.malformedKeys.some(malformedKey =>
    malformedKey.endsWith(`:${key}`) || malformedKey.endsWith(':*'));
}

export function matchesRetryQueuePendingUnknownOutcomeFence(
  item: RetryQueueItem,
  fence: RetryQueuePendingUnknownOutcomeFence,
): boolean {
  return item.id === fence.queueItemId
    && item.type === fence.entityType
    && item.operation === fence.operation
    && item.data.id === fence.entityId
    && (item.sourceUserId ?? null) === fence.sourceUserId
    && item.operationId === fence.operationId;
}

function readFencesFromStorage(
  storageKind: RetryQueueFenceStorageKind,
  records: RetryQueuePendingUnknownOutcomeFenceRecord[],
  malformedKeys: string[],
): void {
  const storage = getStorage(storageKind);
  if (!storage) return;

  let keys: string[];
  try {
    keys = Array.from({ length: storage.length }, (_, index) => storage.key(index))
      .filter((key): key is string => typeof key === 'string' && key.startsWith(PENDING_UNKNOWN_OUTCOME_FENCE_PREFIX));
  } catch {
    malformedKeys.push(`${storageKind}:*`);
    return;
  }

  for (const key of keys) {
    try {
      const raw = storage.getItem(key);
      const parsed = raw === null ? null : JSON.parse(raw) as unknown;
      const fence = isRetryQueuePendingUnknownOutcomeFence(parsed)
        && pendingUnknownOutcomeFenceKey(parsed.ownerUserId) === key
        ? parsed
        : null;
      if (!fence) {
        malformedKeys.push(`${storageKind}:${key}`);
        continue;
      }
      records.push({ fence, storageKind, key });
    } catch {
      malformedKeys.push(`${storageKind}:${key}`);
    }
  }
}

function isRetryQueuePendingUnknownOutcomeFence(
  value: unknown,
): value is RetryQueuePendingUnknownOutcomeFence {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<RetryQueuePendingUnknownOutcomeFence>;
  const lastFailure = candidate.lastFailure as Partial<RetryQueueLastFailure> | undefined;
  return candidate.schemaVersion === PENDING_UNKNOWN_OUTCOME_FENCE_VERSION
    && typeof candidate.ownerUserId === 'string' && candidate.ownerUserId.length > 0
    && typeof candidate.queueItemId === 'string' && candidate.queueItemId.length > 0
    && RETRYABLE_ENTITY_TYPES.has(candidate.entityType as RetryableEntityType)
    && RETRYABLE_OPERATIONS.has(candidate.operation as RetryableOperation)
    && typeof candidate.entityId === 'string' && candidate.entityId.length > 0
    && (candidate.sourceUserId === null
      || (typeof candidate.sourceUserId === 'string' && candidate.sourceUserId.length > 0))
    && typeof candidate.operationId === 'string' && candidate.operationId.length > 0
    && Number.isFinite(candidate.createdAt)
    && !!lastFailure
    && typeof lastFailure.errorType === 'string'
    && typeof lastFailure.message === 'string'
    && lastFailure.remoteOutcome === 'unknown'
    && Number.isFinite(lastFailure.recordedAt);
}

function isSameFenceIdentity(
  left: RetryQueuePendingUnknownOutcomeFence,
  right: RetryQueuePendingUnknownOutcomeFence,
): boolean {
  return left.ownerUserId === right.ownerUserId
    && left.queueItemId === right.queueItemId
    && left.operationId === right.operationId;
}

function getStorage(storageKind: RetryQueueFenceStorageKind): Storage | null {
  try {
    const storage = storageKind === 'local'
      ? globalThis.localStorage
      : globalThis.sessionStorage;
    return typeof storage === 'undefined' ? null : storage;
  } catch {
    return null;
  }
}

function removeFenceFromStorage(storageKind: RetryQueueFenceStorageKind, key: string): void {
  try {
    getStorage(storageKind)?.removeItem(key);
  } catch {
    // A stale fallback copy is harmless; clear will retry it after the durable
    // queue snapshot has been confirmed.
  }
}
