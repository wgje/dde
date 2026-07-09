import { LOCAL_QUEUE_CONFIG } from './action-queue-storage.helpers';
import type { QueuedAction } from './action-queue.types';
import type { CategoryLogger } from './logger.service';
import type { QueueBackupService } from './queue-backup.service';
import type { ActionQueueOwnerStorageRuntime, QueueSnapshot } from './action-queue-owner-storage.types';
import { mergeLoadedQueuedActionsWithBackup } from './action-queue-restore.helpers';
import { resolveAtomicMutationBaseQueue } from './action-queue-owner-storage-mutation-base.helper';
import { normalizeQueueForOutbox } from './action-queue-outbox-normalization.helpers';
import {
  type ActionQueueOwnerScopedStorageKeyResolver,
  writeOwnerScopedLocalStorageValue,
} from './action-queue-owner-storage-local-helpers';

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
  queueBackup: Pick<QueueBackupService, 'backupQueue' | 'updateQueue'>;
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

interface BackupQueueMutationResult {
  updatedQueue: QueuedAction[] | null;
  blockedByCorruptLocalSnapshot: boolean;
  updaterError: unknown | null;
  error: unknown | null;
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
      ? mergeLoadedQueuedActionsWithBackup(localSnapshot.queue, backupQueue).queue
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
  const backupQueue = await deps.restoreQueueFromBackup(ownerUserId, runtime);
  if (backupQueue !== null) {
    return backupQueue;
  }

  const localSnapshot = deps.readQueueSnapshotFromLocalStorage(ownerUserId);
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

  return persistFallbackQueueMutationForOwner(ownerUserId, localSnapshot, updater, runtime, deps);
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
  try {
    const updatedQueue = await deps.queueBackup.updateQueue(ownerUserId, (persistedQueue, context) => {
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
        return normalizeQueueForOutbox(updater(baseQueue));
      } catch (error) {
        updaterError = error;
        throw error;
      }
    });
    return { updatedQueue, blockedByCorruptLocalSnapshot, updaterError, error: null };
  } catch (error) {
    return { updatedQueue: null, blockedByCorruptLocalSnapshot, updaterError, error };
  }
}

async function persistFallbackQueueMutationForOwner(
  ownerUserId: string,
  localSnapshot: QueueSnapshot,
  updater: (queue: QueuedAction[]) => QueuedAction[],
  runtime: ActionQueueOwnerStorageRuntime,
  deps: ActionQueueOwnerQueueMutationDeps,
): Promise<QueuedAction[] | null> {
  const fallbackBaseQueue = localSnapshot.found
    ? localSnapshot.queue
    : ownerUserId === deps.getCurrentOwnerUserId()
      ? runtime.pendingActions()
      : [];
  const fallbackQueue = normalizeQueueForOutbox(updater(fallbackBaseQueue));
  const saved = await deps.persistQueueSnapshotForOwner(ownerUserId, fallbackQueue, runtime);
  return saved ? fallbackQueue : null;
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
