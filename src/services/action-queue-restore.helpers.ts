import type { OutboxSyncState, QueuedAction } from './action-queue.types';
import {
  getQueuedActionOperationIdentity,
  normalizeQueuedActionOperationId,
} from './action-queue-outbox-normalization.helpers';
import { isSyncOperationId } from '../utils/sync-operation-id';

const RESTORABLE_SYNC_STATES = new Set<OutboxSyncState>([
  'held',
  'retry_scheduled',
  'conflict_detected',
  'conflict_saved',
  'blocked_by_auth',
  'blocked_by_protocol',
  'storage_frozen',
]);

export interface RestoredQueuedActionMergeResult {
  queue: QueuedAction[];
  restoredCount: number;
}

export function extractBackupActionQueueActions(source: unknown): QueuedAction[] {
  return readBackupActionQueueActions(source)
    .filter(isRestorablePendingQueuedAction)
    .map(normalizeRestoredQueuedAction);
}

export function extractBackupActionQueueActionsForRestore(source: unknown): QueuedAction[] {
  const candidates = readBackupActionQueueActions(source);
  const pendingCandidates = candidates.filter(candidate => !isDeadLetterAction(candidate));
  if (!pendingCandidates.every(isRestorableQueuedAction)) {
    throw new Error('backup ActionQueue contains a malformed pending action');
  }

  return pendingCandidates.map(action => {
    const candidate = action as QueuedAction & { id?: unknown; operationId?: unknown };
    if (typeof candidate.id !== 'string' || candidate.id.length === 0) {
      throw new Error('backup ActionQueue action id is missing');
    }
    if (!isSyncOperationId(candidate.operationId)) {
      throw new Error('backup ActionQueue operationId is invalid');
    }
    const normalized = normalizeRestoredQueuedAction(action);
    if (normalized.id !== candidate.id || normalized.operationId !== candidate.operationId) {
      throw new Error('backup ActionQueue identity changed during restore validation');
    }
    return normalized;
  });
}

export function mergeRestoredQueuedActions(
  currentQueue: QueuedAction[],
  restoredQueue: QueuedAction[],
): RestoredQueuedActionMergeResult {
  const queue = currentQueue
    .filter(isRestorablePendingQueuedAction)
    .map(normalizeRestoredQueuedAction);
  const indexByIdentity = new Map<string, number>();
  queue.forEach((action, index) => {
    const identity = getQueuedActionRestoreIdentity(action);
    if (identity) {
      indexByIdentity.set(identity, index);
    }
  });
  let restoredCount = 0;

  for (const restoredAction of restoredQueue
    .filter(isRestorablePendingQueuedAction)
    .map(normalizeRestoredQueuedAction)) {
    const identity = getQueuedActionRestoreIdentity(restoredAction);
    if (!identity) {
      continue;
    }

    const existingIndex = indexByIdentity.get(identity);
    if (existingIndex !== undefined) {
      queue[existingIndex] = mergeDuplicateQueuedActionForRestore(queue[existingIndex], restoredAction);
      continue;
    }

    queue.push(restoredAction);
    indexByIdentity.set(identity, queue.length - 1);
    restoredCount += 1;
  }

  return { queue, restoredCount };
}

export function mergeLoadedQueuedActionsWithBackup(
  loadedQueue: QueuedAction[],
  backupQueue: QueuedAction[],
): RestoredQueuedActionMergeResult {
  const loadedActions = loadedQueue
    .filter(isRestorablePendingQueuedAction)
    .map(normalizeRestoredQueuedAction);
  const { backupActions, backupByIdentity, backupMaxRecency } = buildBackupRestoreIndex(backupQueue);
  const queue: QueuedAction[] = [];
  const queuedIdentities = new Set<string>();
  let restoredCount = 0;

  for (const loadedAction of loadedActions) {
    const identity = getQueuedActionRestoreIdentity(loadedAction);
    if (!identity) {
      continue;
    }

    const backupAction = backupByIdentity.get(identity);
    if (backupAction) {
      queue.push(mergeDuplicateQueuedActionForRestore(loadedAction, backupAction));
      queuedIdentities.add(identity);
      continue;
    }

    if (shouldKeepLoadedActionDuringBackupRestore(loadedAction, backupMaxRecency)) {
      queue.push(loadedAction);
      queuedIdentities.add(identity);
    }
  }

  for (const backupAction of backupActions) {
    const identity = getQueuedActionRestoreIdentity(backupAction);
    if (!identity || queuedIdentities.has(identity)) {
      continue;
    }
    queue.push(backupAction);
    queuedIdentities.add(identity);
    restoredCount += 1;
  }

  return { queue, restoredCount };
}

function buildBackupRestoreIndex(backupQueue: QueuedAction[]): {
  backupActions: QueuedAction[];
  backupByIdentity: Map<string, QueuedAction>;
  backupMaxRecency: number;
} {
  const backupByIdentity = new Map<string, QueuedAction>();
  const backupIdentityOrder: string[] = [];

  for (const backupAction of backupQueue
    .filter(isRestorablePendingQueuedAction)
    .map(normalizeRestoredQueuedAction)) {
    const identity = getQueuedActionRestoreIdentity(backupAction);
    if (!identity) {
      continue;
    }

    const existing = backupByIdentity.get(identity);
    if (!existing) {
      backupIdentityOrder.push(identity);
    }
    if (!existing || getQueuedActionRestoreRecency(backupAction) >= getQueuedActionRestoreRecency(existing)) {
      backupByIdentity.set(identity, backupAction);
    }
  }

  const backupActions = backupIdentityOrder
    .map(identity => backupByIdentity.get(identity))
    .filter((action): action is QueuedAction => action !== undefined);
  return {
    backupActions,
    backupByIdentity,
    backupMaxRecency: backupActions.reduce(
      (maxRecency, action) => Math.max(maxRecency, getQueuedActionRestoreRecency(action)),
      0,
    ),
  };
}

function shouldKeepLoadedActionDuringBackupRestore(
  loadedAction: QueuedAction,
  backupMaxRecency: number,
): boolean {
  return getQueuedActionRestoreRecency(loadedAction) > backupMaxRecency;
}

function mergeDuplicateQueuedActionForRestore(
  currentAction: QueuedAction,
  restoredAction: QueuedAction,
): QueuedAction {
  const preferredAction = selectPreferredDuplicateActionForRestore(currentAction, restoredAction);
  const secondaryAction = preferredAction === currentAction ? restoredAction : currentAction;
  return {
    ...preferredAction,
    timestamp: Math.max(
      getFiniteNumber(preferredAction.timestamp),
      getFiniteNumber(secondaryAction.timestamp),
    ),
    localCommittedAt: Math.max(
      getFiniteNumber(preferredAction.localCommittedAt),
      getFiniteNumber(secondaryAction.localCommittedAt),
    ),
    retryCount: Math.max(
      getFiniteNumber(preferredAction.retryCount),
      getFiniteNumber(secondaryAction.retryCount),
    ),
    lastError: preferredAction.lastError ?? secondaryAction.lastError,
    errorType: preferredAction.errorType ?? secondaryAction.errorType,
  };
}

function selectPreferredDuplicateActionForRestore(
  currentAction: QueuedAction,
  restoredAction: QueuedAction,
): QueuedAction {
  const currentPreservation = getQueuedActionPreservationScore(currentAction);
  const restoredPreservation = getQueuedActionPreservationScore(restoredAction);
  if (currentPreservation !== restoredPreservation) {
    return currentPreservation > restoredPreservation ? currentAction : restoredAction;
  }

  const currentRecency = getQueuedActionRestoreRecency(currentAction);
  const restoredRecency = getQueuedActionRestoreRecency(restoredAction);
  if (currentRecency !== restoredRecency) {
    return currentRecency > restoredRecency ? currentAction : restoredAction;
  }

  return currentAction;
}

function getQueuedActionPreservationScore(action: QueuedAction): number {
  return getSyncStatePreservationRank(action.syncState)
    + (action.lastError ? 8 : 0)
    + (action.errorType ? 4 : 0)
    + Math.min(Math.max(getFiniteNumber(action.retryCount), 0), 5);
}

function getSyncStatePreservationRank(syncState: OutboxSyncState | undefined): number {
  switch (syncState) {
    case 'held':
      return 110;
    case 'conflict_saved':
      return 100;
    case 'conflict_detected':
      return 90;
    case 'dead_letter':
      return 85;
    case 'blocked_by_protocol':
      return 80;
    case 'blocked_by_auth':
      return 70;
    case 'storage_frozen':
      return 60;
    case 'retry_scheduled':
      return 50;
    case 'local_committed':
      return 20;
    case 'pending_sync':
    case 'syncing':
      return 10;
    case 'synced':
    default:
      return 0;
  }
}

export function haveSameQueuedActionRestoreIdentities(
  left: QueuedAction[],
  right: QueuedAction[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((action, index) =>
    getQueuedActionRestoreIdentity(action) === getQueuedActionRestoreIdentity(right[index])
  );
}

export function haveSameQueuedActionRestoreSnapshots(
  left: QueuedAction[],
  right: QueuedAction[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((action, index) =>
    getQueuedActionRestoreIdentity(action) === getQueuedActionRestoreIdentity(right[index])
    && stableSerialize(normalizeRestoredQueuedAction(action)) === stableSerialize(normalizeRestoredQueuedAction(right[index]))
  );
}

function isRestorableQueuedAction(action: unknown): action is QueuedAction {
  if (!action || typeof action !== 'object') {
    return false;
  }

  const candidate = action as Partial<QueuedAction> & Record<string, unknown>;
  return (
    (isNonEmptyString(candidate.operationId) || isNonEmptyString(candidate.id))
    && isNonEmptyString(candidate.type)
    && isNonEmptyString(candidate.entityType)
    && isNonEmptyString(candidate.entityId)
    && !!candidate.payload
    && typeof candidate.payload === 'object'
  );
}

function isRestorablePendingQueuedAction(action: unknown): action is QueuedAction {
  return isRestorableQueuedAction(action) && (action as { syncState?: unknown }).syncState !== 'dead_letter';
}

function isDeadLetterAction(action: unknown): boolean {
  return !!action && typeof action === 'object' && !Array.isArray(action)
    && (action as Record<string, unknown>)['syncState'] === 'dead_letter';
}

function readBackupActionQueueActions(source: unknown): unknown[] {
  if (Array.isArray(source)) return source;
  if (!source || typeof source !== 'object') return [];

  const record = source as Record<string, unknown>;
  if (Array.isArray(record['actions'])) return record['actions'];
  if (Array.isArray(record['queue'])) return record['queue'];
  return [];
}

function normalizeRestoredQueuedAction(action: QueuedAction): QueuedAction {
  const legacy = action as QueuedAction & {
    id?: unknown;
    operationId?: unknown;
    localCommittedAt?: unknown;
    retryCount?: unknown;
    syncState?: unknown;
    timestamp?: unknown;
  };
  const timestamp = typeof legacy.timestamp === 'number' ? legacy.timestamp : Date.now();
  const operationId = normalizeQueuedActionOperationId(legacy.operationId, legacy.id);
  const id = isNonEmptyString(legacy.id) ? legacy.id : operationId;

  return {
    ...action,
    id,
    operationId,
    timestamp,
    localCommittedAt: typeof legacy.localCommittedAt === 'number'
      ? legacy.localCommittedAt
      : timestamp,
    retryCount: typeof legacy.retryCount === 'number' ? legacy.retryCount : 0,
    syncState: normalizeRestoredSyncState(legacy.syncState),
  };
}

function getQueuedActionRestoreIdentity(action: QueuedAction): string | null {
  const candidate = action as QueuedAction & { operationId?: unknown; id?: unknown };
  const operationIdentity = getQueuedActionOperationIdentity(candidate.operationId);
  if (operationIdentity !== null) {
    return operationIdentity;
  }

  return isNonEmptyString(candidate.id) ? candidate.id : null;
}

function getQueuedActionRestoreRecency(action: QueuedAction): number {
  const localCommittedAt = typeof action.localCommittedAt === 'number' ? action.localCommittedAt : 0;
  const timestamp = typeof action.timestamp === 'number' ? action.timestamp : 0;
  return Math.max(localCommittedAt, timestamp);
}

function getFiniteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function normalizeRestoredSyncState(syncState: unknown): OutboxSyncState {
  return RESTORABLE_SYNC_STATES.has(syncState as OutboxSyncState)
    ? syncState as OutboxSyncState
    : 'pending_sync';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function stableSerialize(value: unknown): string | undefined {
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
