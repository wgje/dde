import {
  buildFailedOwnerDeadLetterReason,
  LOCAL_QUEUE_CONFIG,
  type QueueRetryError,
} from './action-queue-storage.helpers';
import type { DeadLetterItem, QueuedAction } from './action-queue.types';
import type { CategoryLogger } from './logger.service';
import type {
  QueueBackupProtectedHandoffReason,
  QueueBackupService,
  QueueBackupUpdateContext,
} from './queue-backup.service';
import type { ActionQueueOwnerStorageRuntime, QueueSnapshot } from './action-queue-owner-storage.types';
import { mergeLoadedQueuedActionsWithBackup } from './action-queue-restore.helpers';
import { resolveAtomicMutationBaseQueue } from './action-queue-owner-storage-mutation-base.helper';
import { normalizeQueueForOutbox } from './action-queue-outbox-normalization.helpers';
import {
  type ActionQueueOwnerScopedStorageKeyResolver,
  writeOwnerScopedLocalStorageValue,
} from './action-queue-owner-storage-local-helpers';
import { filterLocallyRemovedQueuedActions } from './action-queue-owner-storage-removal-journal';
import {
  authorizeDeadLetterHandoffDurably,
  ProtectedQueueMutationError,
} from './action-queue-held-action.controller';
import {
  buildFailedActionRetryQueue,
  createFailedActionSettlement,
  type FailedActionSettlement,
} from './action-queue-owner-storage-failed-settlement.helpers';

export interface ActionQueueOwnerQueuePersistenceDeps {
  queueBackup: Pick<QueueBackupService, 'backupQueue'>;
  logger: CategoryLogger;
  getScopedStorageKey: ActionQueueOwnerScopedStorageKeyResolver;
  invalidateLocalQueueSnapshot: (ownerUserId: string) => void;
}

export interface ActionQueueOwnerQueueLoadDeps {
  readQueueSnapshotFromLocalStorage: (ownerUserId: string) => QueueSnapshot;
  restoreQueueFromBackup: (
    ownerUserId: string,
    runtime: ActionQueueOwnerStorageRuntime,
  ) => Promise<QueuedAction[] | null>;
  handleUnrecoverableCorruptQueueSnapshot: (
    ownerUserId: string,
    snapshot: QueueSnapshot,
    runtime: ActionQueueOwnerStorageRuntime,
  ) => void;
}

export interface ActionQueueOwnerQueueMutationDeps {
  queueBackup: Pick<QueueBackupService, 'backupQueue' | 'updateQueue'>
    & Partial<Pick<QueueBackupService, 'updateQueueStrictly'>>;
  logger: CategoryLogger;
  getScopedStorageKey: ActionQueueOwnerScopedStorageKeyResolver;
  invalidateLocalQueueSnapshot: (ownerUserId: string) => void;
  getCurrentOwnerUserId: () => string;
  persistQueueSnapshotForOwner: (
    ownerUserId: string,
    queue: QueuedAction[],
    runtime: ActionQueueOwnerStorageRuntime,
  ) => Promise<boolean>;
  readQueueSnapshotFromLocalStorage: (ownerUserId: string) => QueueSnapshot;
  handleUnrecoverableCorruptQueueSnapshot: (
    ownerUserId: string,
    snapshot: QueueSnapshot,
    runtime: ActionQueueOwnerStorageRuntime,
  ) => void;
}

export interface FailedOwnerActionSettlementDeps {
  logger: CategoryLogger;
  loadQueue: () => Promise<QueuedAction[]>;
  persistQueueMutation: (
    updater: (queue: QueuedAction[]) => QueuedAction[],
  ) => Promise<QueuedAction[] | null>;
  buildDeadLetterQueue: (actionId: string, item: DeadLetterItem) => Promise<DeadLetterItem[]>;
  saveDeadLetterQueue: (queue: DeadLetterItem[]) => boolean;
}

export async function settleFailedOwnerAction(
  ownerUserId: string,
  action: QueuedAction,
  error: string | QueueRetryError,
  runtime: ActionQueueOwnerStorageRuntime,
  deps: FailedOwnerActionSettlementDeps,
): Promise<'retry' | 'dead-letter' | 'missing'> {
  const queue = await deps.loadQueue();
  const existingAction = queue.find(item => item.id === action.id);
  if (!existingAction) {
    deps.logger.debug('旧 owner 队列中未找到待收口的失败 action', {
      ownerUserId,
      actionId: action.id,
    });
    return 'missing';
  }

  const settlement = createFailedActionSettlement(existingAction, error);
  if (settlement.shouldDeadLetter) {
    await moveFailedOwnerActionToDeadLetter(
      ownerUserId, action.id, existingAction, settlement, runtime, deps,
    );
    return 'dead-letter';
  }

  let retried = false;
  const updatedQueue = await deps.persistQueueMutation(latestQueue => {
    retried = latestQueue.some(item => item.id === action.id);
    return retried
      ? buildFailedActionRetryQueue(latestQueue, action.id, settlement)
      : latestQueue;
  });
  if (updatedQueue === null) {
    throw new Error(`owner-scoped 失败 action 重试收口保存失败: ${ownerUserId}`);
  }
  if (!retried) {
    deps.logger.debug('旧 owner 队列中未找到待收口的失败 action', {
      ownerUserId,
      actionId: action.id,
    });
    return 'missing';
  }
  return 'retry';
}

async function moveFailedOwnerActionToDeadLetter(
  ownerUserId: string,
  actionId: string,
  existingAction: QueuedAction,
  settlement: FailedActionSettlement,
  runtime: ActionQueueOwnerStorageRuntime,
  deps: FailedOwnerActionSettlementDeps,
): Promise<void> {
  const authorizedAction = await authorizeDeadLetterHandoffDurably({
    ownerUserId,
    action: existingAction,
    authorizedAt: new Date().toISOString(),
    persistQueueMutationForOwner: (_owner, updater) => deps.persistQueueMutation(updater),
  });
  const deadLetters = await deps.buildDeadLetterQueue(actionId, {
    action: {
      ...authorizedAction,
      lastError: settlement.errorMessage,
      errorType: settlement.errorType,
      syncState: 'dead_letter',
    },
    failedAt: new Date().toISOString(),
    reason: buildFailedOwnerDeadLetterReason(settlement.errorType, settlement.errorMessage),
  });
  if (!deps.saveDeadLetterQueue(deadLetters)) {
    runtime.freezeQueueWrites('storage_failure');
    runtime.triggerStorageFailureEscapeMode();
    throw new Error(`owner-scoped dead-letter 保存失败: ${ownerUserId}`);
  }

  let removed = false;
  const updatedQueue = await deps.persistQueueMutation(latestQueue => {
    const nextQueue = latestQueue.filter(item => item.id !== actionId);
    removed = nextQueue.length !== latestQueue.length;
    return nextQueue;
  });
  if (updatedQueue === null) {
    throw new Error(`owner-scoped dead-letter 队列收口保存失败: ${ownerUserId}`);
  }
  if (!removed) {
    deps.logger.debug('旧 owner 队列中未找到待移入 dead-letter 的失败 action', {
      ownerUserId,
      actionId,
    });
  }
}

interface BackupQueueMutationResult {
  updatedQueue: QueuedAction[] | null;
  fallbackBaseQueue: QueuedAction[] | null;
  fallbackQueue: QueuedAction[] | null;
  blockedByCorruptLocalSnapshot: boolean;
  updaterError: unknown | null;
  error: unknown | null;
  protectedReason: QueueBackupProtectedHandoffReason | null;
  protectedActionIds: string[];
}

export async function loadPersistedQueueForOwner(
  ownerUserId: string,
  runtime: ActionQueueOwnerStorageRuntime,
  deps: ActionQueueOwnerQueueLoadDeps,
): Promise<QueuedAction[]> {
  const localSnapshot = deps.readQueueSnapshotFromLocalStorage(ownerUserId);
  const backupQueue = await deps.restoreQueueFromBackup(ownerUserId, runtime);
  if (localSnapshot.found) {
    return backupQueue !== null
      ? mergeLoadedQueuedActionsWithBackup(
        localSnapshot.queue,
        filterLocallyRemovedQueuedActions(backupQueue, localSnapshot.removedActionIdentities),
      ).queue
      : localSnapshot.queue;
  }

  if (isUnrecoverableCorruptQueueSnapshot(localSnapshot, backupQueue)) {
    deps.handleUnrecoverableCorruptQueueSnapshot(ownerUserId, localSnapshot, runtime);
  }

  return backupQueue ?? [];
}

export async function loadQueueMutationBaseForOwner(
  ownerUserId: string,
  runtime: ActionQueueOwnerStorageRuntime,
  deps: ActionQueueOwnerQueueLoadDeps,
): Promise<QueuedAction[]> {
  const localSnapshot = deps.readQueueSnapshotFromLocalStorage(ownerUserId);
  const backupQueue = await deps.restoreQueueFromBackup(ownerUserId, runtime);
  if (backupQueue !== null) {
    return filterLocallyRemovedQueuedActions(backupQueue, localSnapshot.removedActionIdentities);
  }

  if (isUnrecoverableCorruptQueueSnapshot(localSnapshot, null)) {
    deps.handleUnrecoverableCorruptQueueSnapshot(ownerUserId, localSnapshot, runtime);
  }
  return localSnapshot.found ? localSnapshot.queue : [];
}

export function isUnrecoverableCorruptQueueSnapshot(
  localSnapshot: QueueSnapshot,
  backupQueue: QueuedAction[] | null,
): boolean {
  return localSnapshot.corrupted === true && backupQueue === null;
}

export async function persistQueueMutationForOwner(
  ownerUserId: string,
  updater: (queue: QueuedAction[]) => QueuedAction[],
  runtime: ActionQueueOwnerStorageRuntime,
  deps: ActionQueueOwnerQueueMutationDeps,
): Promise<QueuedAction[] | null> {
  const localSnapshot = deps.readQueueSnapshotFromLocalStorage(ownerUserId);
  const backupResult = await tryPersistQueueMutationInBackup(ownerUserId, localSnapshot, updater, deps);

  if (backupResult.blockedByCorruptLocalSnapshot) {
    deps.handleUnrecoverableCorruptQueueSnapshot(ownerUserId, localSnapshot, runtime);
    return null;
  }

  if (backupResult.updaterError !== null) {
    throw backupResult.updaterError;
  }

  if (backupResult.protectedReason !== null) {
    throw new ProtectedQueueMutationError(
      backupResult.protectedReason,
      backupResult.protectedActionIds,
    );
  }

  if (backupResult.error !== null) {
    warnQueuePersistenceFailure(deps.logger, 'IndexedDB owner-scoped 队列 mutation 失败，降级尝试本地快照持久化', {
      ownerUserId,
      error: backupResult.error,
    });
  }

  if (backupResult.updatedQueue !== null) {
    const normalizedQueue = normalizeQueueForOutbox(backupResult.updatedQueue);
    saveLocalQueueMirrorForOwner(ownerUserId, normalizedQueue, runtime, deps);
    return normalizedQueue;
  }

  if (isUnrecoverableCorruptQueueSnapshot(localSnapshot, null)) {
    deps.handleUnrecoverableCorruptQueueSnapshot(ownerUserId, localSnapshot, runtime);
    return null;
  }

  return persistFallbackQueueMutationForOwner(
    ownerUserId,
    localSnapshot,
    updater,
    runtime,
    deps,
    backupResult.fallbackBaseQueue,
    backupResult.fallbackQueue,
  );
}

export async function saveQueueSnapshotForOwner(
  ownerUserId: string,
  queue: QueuedAction[],
  runtime: ActionQueueOwnerStorageRuntime,
  deps: ActionQueueOwnerQueuePersistenceDeps,
): Promise<void> {
  let localSnapshotSaved = false;
  if (typeof localStorage !== 'undefined') {
    try {
      writeOwnerScopedLocalStorageValue(
        LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY,
        ownerUserId,
        queue,
        deps.getScopedStorageKey,
      );
      localSnapshotSaved = true;
    } catch (error) {
      warnQueuePersistenceFailure(deps.logger, '保存 owner-scoped 队列快照失败，降级写入 IndexedDB 备份', {
        ownerUserId,
        error,
      });
    }
  }

  let backupSucceeded = false;
  try {
    backupSucceeded = await deps.queueBackup.backupQueue(queue, ownerUserId);
  } catch (error) {
    warnQueuePersistenceFailure(deps.logger, 'IndexedDB owner-scoped 队列备份异常，按 durable 备份失败处理', {
      ownerUserId,
      error,
    });
  }

  if (!localSnapshotSaved && backupSucceeded) {
    deps.invalidateLocalQueueSnapshot(ownerUserId);
    return;
  }

  if (backupSucceeded) {
    return;
  }

  if (localSnapshotSaved) {
    warnQueuePersistenceFailure(deps.logger, 'owner-scoped 队列仅写入 localStorage，未达到 durable QueueBackup 持久化要求', {
      ownerUserId,
    });
  }

  runtime.freezeQueueWrites('storage_failure');
  runtime.triggerStorageFailureEscapeMode();
  throw new Error(`owner-scoped 队列保存失败: ${ownerUserId}`);
}

export function saveLocalQueueMirrorForOwner(
  ownerUserId: string,
  queue: QueuedAction[],
  runtime: ActionQueueOwnerStorageRuntime,
  deps: Pick<ActionQueueOwnerQueuePersistenceDeps, 'logger' | 'getScopedStorageKey'>,
): void {
  if (typeof localStorage === 'undefined') {
    return;
  }

  try {
    writeOwnerScopedLocalStorageValue(
      LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY,
      ownerUserId,
      queue,
      deps.getScopedStorageKey,
    );
    runtime.clearQueueFreeze();
  } catch (error) {
    warnQueuePersistenceFailure(deps.logger, '保存 owner-scoped 队列镜像失败，IndexedDB Outbox 仍保留', {
      ownerUserId,
      error,
    });
  }
}

async function tryPersistQueueMutationInBackup(
  ownerUserId: string,
  localSnapshot: QueueSnapshot,
  updater: (queue: QueuedAction[]) => QueuedAction[],
  deps: ActionQueueOwnerQueueMutationDeps,
): Promise<BackupQueueMutationResult> {
  let blockedByCorruptLocalSnapshot = false;
  let updaterError: unknown = null;
  let fallbackBaseQueue: QueuedAction[] | null = null;
  let fallbackQueue: QueuedAction[] | null = null;
  try {
    const applyUpdate = (persistedQueue: QueuedAction[], context: QueueBackupUpdateContext) => {
      if (isUnrecoverableCorruptQueueSnapshot(localSnapshot, context.recordFound ? persistedQueue : null)) {
        blockedByCorruptLocalSnapshot = true;
        throw new Error('owner-scoped queue snapshot is corrupt and has no recoverable IndexedDB baseline');
      }
      const baseQueue = resolveAtomicMutationBaseQueue(
        persistedQueue,
        localSnapshot,
        context.recordFound,
      );
      try {
        fallbackBaseQueue = baseQueue;
        fallbackQueue = normalizeQueueForOutbox(updater(baseQueue));
        return fallbackQueue;
      } catch (error) {
        updaterError = error;
        throw error;
      }
    };
    const result = deps.queueBackup.updateQueueStrictly
      ? await deps.queueBackup.updateQueueStrictly(ownerUserId, applyUpdate)
      : await deps.queueBackup.updateQueue(ownerUserId, applyUpdate).then(queue => queue === null
        ? { status: 'storage-failed' as const }
        : { status: 'committed' as const, queue });
    if (result.status === 'committed') {
      return {
        updatedQueue: result.queue,
        fallbackBaseQueue,
        fallbackQueue,
        blockedByCorruptLocalSnapshot,
        updaterError,
        error: null,
        protectedReason: null,
        protectedActionIds: [],
      };
    }
    if (result.status === 'protected-handoff') {
      return {
        updatedQueue: null,
        fallbackBaseQueue,
        fallbackQueue,
        blockedByCorruptLocalSnapshot,
        updaterError,
        error: null,
        protectedReason: result.reason,
        protectedActionIds: result.actionIds,
      };
    }
    return {
      updatedQueue: null,
      fallbackBaseQueue,
      fallbackQueue,
      blockedByCorruptLocalSnapshot,
      updaterError,
      error: new Error('IndexedDB owner-scoped queue mutation failed'),
      protectedReason: null,
      protectedActionIds: [],
    };
  } catch (error) {
    return {
      updatedQueue: null,
      fallbackBaseQueue,
      fallbackQueue,
      blockedByCorruptLocalSnapshot,
      updaterError,
      error,
      protectedReason: null,
      protectedActionIds: [],
    };
  }
}

async function persistFallbackQueueMutationForOwner(
  ownerUserId: string,
  localSnapshot: QueueSnapshot,
  updater: (queue: QueuedAction[]) => QueuedAction[],
  runtime: ActionQueueOwnerStorageRuntime,
  deps: ActionQueueOwnerQueueMutationDeps,
  preparedBaseQueue: QueuedAction[] | null,
  preparedQueue: QueuedAction[] | null,
): Promise<QueuedAction[] | null> {
  const fallbackBaseQueue = localSnapshot.found
    ? localSnapshot.queue
    : ownerUserId === deps.getCurrentOwnerUserId()
      ? runtime.pendingActions()
      : [];
  const baseQueue = preparedBaseQueue ?? fallbackBaseQueue;
  const fallbackQueue = preparedQueue ?? normalizeQueueForOutbox(updater(baseQueue));
  if (removesQueueMembership(baseQueue, fallbackQueue)
    || (baseQueue.length === 0 && fallbackQueue.length === 0)) {
    warnQueuePersistenceFailure(
      deps.logger,
      'IndexedDB mutation 失败后拒绝使用本地镜像执行可能删减队列的 fallback',
      { ownerUserId },
    );
    return null;
  }
  const saved = await deps.persistQueueSnapshotForOwner(ownerUserId, fallbackQueue, runtime);
  return saved ? fallbackQueue : null;
}

function removesQueueMembership(before: QueuedAction[], after: QueuedAction[]): boolean {
  const retained = new Set(after.map(action => `${action.id}\u0000${action.operationId}`));
  return before.some(action => !retained.has(`${action.id}\u0000${action.operationId}`));
}

function warnQueuePersistenceFailure(
  logger: CategoryLogger,
  message: string,
  context: unknown,
): void {
  try {
    logger.warn(message, context);
  } catch {
    // Logging is best-effort; persistence recovery paths own the business outcome.
  }
}
