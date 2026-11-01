import type { OutboxSyncState, QueuedAction } from './action-queue.types';
import {
  createDerivedSyncOperationId,
  createSyncOperationId,
  isSyncOperationId,
} from '../utils/sync-operation-id';

export function normalizeQueueForOutbox(queue: QueuedAction[]): QueuedAction[] {
  return queue.map((action, queueIndex) => normalizeQueuedActionForOutbox(action, queueIndex));
}

export function normalizeQueuedActionForOutbox(action: QueuedAction, queueIndex = 0): QueuedAction {
  const legacyAction = action as QueuedAction & {
    id?: unknown;
    operationId?: unknown;
    localCommittedAt?: unknown;
    retryCount?: unknown;
    syncState?: unknown;
    timestamp?: unknown;
  };
  const timestamp = typeof legacyAction.timestamp === 'number' ? legacyAction.timestamp : Date.now();
  const operationId = normalizeQueuedActionOperationId(
    legacyAction.operationId,
    legacyAction.id,
    buildLegacyQueuedActionFingerprint(legacyAction, queueIndex),
  );
  const id = normalizeQueuedActionId(legacyAction.id, operationId);

  return {
    ...action,
    id,
    operationId,
    timestamp,
    localCommittedAt: typeof legacyAction.localCommittedAt === 'number'
      ? legacyAction.localCommittedAt
      : timestamp,
    syncState: normalizePendingActionSyncState(legacyAction.syncState),
  };
}

export function normalizeQueuedActionOperationId(
  operationId: unknown,
  fallbackId?: unknown,
  fallbackFingerprint?: string,
): string {
  const stableIdentity = getQueuedActionOperationIdentity(operationId);
  if (stableIdentity !== null) {
    return stableIdentity;
  }

  if (typeof fallbackId === 'string' && fallbackId.length > 0) {
    return createDerivedSyncOperationId(fallbackId, 'legacy-outbox-action-id');
  }

  if (typeof fallbackFingerprint === 'string' && fallbackFingerprint.length > 0) {
    return createDerivedSyncOperationId(fallbackFingerprint, 'legacy-outbox-action-fingerprint');
  }

  return createSyncOperationId();
}

export function normalizeQueuedActionId(actionId: unknown, operationId: string): string {
  if (typeof actionId === 'string' && actionId.length > 0) {
    return actionId;
  }

  return createDerivedSyncOperationId(operationId, 'legacy-outbox-missing-action-id');
}

export function getQueuedActionOperationIdentity(operationId: unknown): string | null {
  if (isSyncOperationId(operationId)) {
    return operationId;
  }

  if (typeof operationId === 'string' && operationId.length > 0) {
    return createDerivedSyncOperationId(operationId, 'legacy-outbox-operation-id');
  }

  return null;
}

function normalizePendingActionSyncState(syncState: unknown): OutboxSyncState {
  if (
    syncState === 'held'
    || syncState === 'retry_scheduled'
    || syncState === 'conflict_detected'
    || syncState === 'conflict_saved'
    || syncState === 'blocked_by_auth'
    || syncState === 'blocked_by_protocol'
    || syncState === 'storage_frozen'
  ) {
    return syncState;
  }

  return 'pending_sync';
}

function buildLegacyQueuedActionFingerprint(
  action: QueuedAction & {
    localCommittedAt?: unknown;
    retryCount?: unknown;
    syncState?: unknown;
    timestamp?: unknown;
  },
  queueIndex: number,
): string {
  return stableSerialize({
    queueIndex,
    type: action.type,
    entityType: action.entityType,
    entityId: action.entityId,
    payload: action.payload,
    timestamp: typeof action.timestamp === 'number' ? action.timestamp : null,
    localCommittedAt: typeof action.localCommittedAt === 'number' ? action.localCommittedAt : null,
    retryCount: typeof action.retryCount === 'number' ? action.retryCount : null,
    priority: action.priority ?? null,
    syncState: action.syncState ?? null,
  });
}

function stableSerialize(value: unknown): string {
  return JSON.stringify(toStableJsonValue(value));
}

function toStableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(toStableJsonValue);
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  return Object.keys(value)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = toStableJsonValue((value as Record<string, unknown>)[key]);
      return acc;
    }, {});
}
