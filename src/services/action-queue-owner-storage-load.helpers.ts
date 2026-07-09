import { LOCAL_QUEUE_CONFIG } from './action-queue-storage.helpers';
import type { QueuedAction } from './action-queue.types';
import type { ActionQueueOwnerStorageRuntime, QueueSnapshot } from './action-queue-owner-storage.types';
import {
  haveSameQueuedActionRestoreSnapshots,
  mergeLoadedQueuedActionsWithBackup,
  mergeRestoredQueuedActions,
} from './action-queue-restore.helpers';
import { normalizeQueueForOutbox } from './action-queue-outbox-normalization.helpers';
import type { CategoryLogger } from './logger.service';
import type { ToastService } from './toast.service';

export interface ActionQueueOwnerCurrentQueueLoadDeps {
  logger: Pick<CategoryLogger, 'debug' | 'warn'>;
  toast: Pick<ToastService, 'info'>;
  getCurrentOwnerUserId: () => string;
  getScopedStorageKey: (baseKey: string, ownerUserId: string) => string;
  loadScopedOrLegacyStorage: (
    baseKey: string,
    runtime: ActionQueueOwnerStorageRuntime,
  ) => string | null;
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

interface CurrentQueueLoadResult {
  queueAtRestoreStart: QueuedAction[];
  corruptLocalSnapshot: QueueSnapshot | null;
}

export function loadCurrentQueueFromStorage(
  restoreGeneration: number,
  restoreOwnerUserId: string,
  getCurrentRestoreGeneration: () => number,
  runtime: ActionQueueOwnerStorageRuntime,
  deps: ActionQueueOwnerCurrentQueueLoadDeps,
): void {
  const { queueAtRestoreStart, corruptLocalSnapshot } = loadCurrentQueueSnapshotFromStorage(
    restoreOwnerUserId,
    runtime,
    deps,
  );
  restoreQueueBackupIntoRuntime(
    restoreGeneration,
    restoreOwnerUserId,
    getCurrentRestoreGeneration,
    queueAtRestoreStart,
    corruptLocalSnapshot,
    runtime,
    deps,
  );
}

function loadCurrentQueueSnapshotFromStorage(
  restoreOwnerUserId: string,
  runtime: ActionQueueOwnerStorageRuntime,
  deps: ActionQueueOwnerCurrentQueueLoadDeps,
): CurrentQueueLoadResult {
  const initialResult = {
    queueAtRestoreStart: runtime.pendingActions(),
    corruptLocalSnapshot: null,
  };
  if (typeof localStorage === 'undefined') {
    return initialResult;
  }

  try {
    const saved = deps.loadScopedOrLegacyStorage(LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY, runtime);
    return saved === null
      ? initialResult
      : applySavedQueueSnapshot(saved, restoreOwnerUserId, runtime, deps);
  } catch (error) {
    deps.logger.warn('Failed to load action queue from localStorage; IndexedDB backup restore will still be attempted', {
      error,
    });
    return {
      queueAtRestoreStart: initialResult.queueAtRestoreStart,
      corruptLocalSnapshot: buildCorruptQueueSnapshot(restoreOwnerUserId, error, deps),
    };
  }
}

function applySavedQueueSnapshot(
  saved: string,
  restoreOwnerUserId: string,
  runtime: ActionQueueOwnerStorageRuntime,
  deps: ActionQueueOwnerCurrentQueueLoadDeps,
): CurrentQueueLoadResult {
  const queue = JSON.parse(saved) as QueuedAction[];
  if (!Array.isArray(queue)) {
    const error = new Error('owner-scoped queue snapshot is not an array');
    deps.logger.warn('Failed to load action queue from localStorage; IndexedDB backup restore will still be attempted', {
      error,
    });
    return {
      queueAtRestoreStart: runtime.pendingActions(),
      corruptLocalSnapshot: buildCorruptQueueSnapshot(restoreOwnerUserId, error, deps),
    };
  }

  const normalizedQueue = normalizeQueueForOutbox(queue);
  runtime.setPendingActions(normalizedQueue);
  runtime.setQueueSize(normalizedQueue.length);
  runtime.syncSentryContext();
  return { queueAtRestoreStart: normalizedQueue, corruptLocalSnapshot: null };
}

function buildCorruptQueueSnapshot(
  ownerUserId: string,
  error: unknown,
  deps: ActionQueueOwnerCurrentQueueLoadDeps,
): QueueSnapshot {
  return {
    found: false,
    queue: [],
    corrupted: true,
    storageKey: getQueueStorageKeyForRestoreFailure(ownerUserId, deps),
    error,
  };
}

function getQueueStorageKeyForRestoreFailure(
  ownerUserId: string,
  deps: Pick<ActionQueueOwnerCurrentQueueLoadDeps, 'getScopedStorageKey'>,
): string {
  if (typeof localStorage === 'undefined') {
    return deps.getScopedStorageKey(LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY, ownerUserId);
  }

  const scopedKey = deps.getScopedStorageKey(LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY, ownerUserId);
  return localStorage.getItem(scopedKey) !== null
    ? scopedKey
    : LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY;
}

function restoreQueueBackupIntoRuntime(
  restoreGeneration: number,
  restoreOwnerUserId: string,
  getCurrentRestoreGeneration: () => number,
  queueAtRestoreStart: QueuedAction[],
  corruptLocalSnapshot: QueueSnapshot | null,
  runtime: ActionQueueOwnerStorageRuntime,
  deps: ActionQueueOwnerCurrentQueueLoadDeps,
): void {
  void deps.restoreQueueFromBackup(restoreOwnerUserId, runtime).then(backupQueue => {
    if (shouldIgnoreQueueRestore(restoreGeneration, restoreOwnerUserId, getCurrentRestoreGeneration, deps)) {
      return;
    }
    if (backupQueue === null) {
      handleMissingQueueBackup(restoreOwnerUserId, corruptLocalSnapshot, runtime, deps);
      return;
    }
    if (backupQueue.length === 0) {
      return;
    }

    const restoredCount = applyRestoredQueueBackup(queueAtRestoreStart, backupQueue, runtime);
    deps.toast.info('队列恢复', `从备用存储恢复了 ${restoredCount} 个待处理操作`);
    runtime.clearQueueFreeze();
    runtime.saveQueueToStorage();
    requestProcessingForRestoredBackup(restoreOwnerUserId, restoredCount, runtime, deps);
  }).catch((error: unknown) => {
    deps.logger.warn('IndexedDB 队列备份恢复失败，保留当前队列视图', {
      ownerUserId: restoreOwnerUserId,
      error,
    });
  });
}

function requestProcessingForRestoredBackup(
  ownerUserId: string,
  restoredCount: number,
  runtime: ActionQueueOwnerStorageRuntime,
  deps: Pick<ActionQueueOwnerCurrentQueueLoadDeps, 'logger'>,
): void {
  if (restoredCount <= 0) {
    return;
  }

  try {
    runtime.requestQueueProcessing('backup-restore');
  } catch (error) {
    deps.logger.warn('IndexedDB 队列备份恢复后触发后台处理失败，待下次网络事件继续重试', {
      ownerUserId,
      restoredCount,
      error,
    });
  }
}

function shouldIgnoreQueueRestore(
  restoreGeneration: number,
  restoreOwnerUserId: string,
  getCurrentRestoreGeneration: () => number,
  deps: Pick<ActionQueueOwnerCurrentQueueLoadDeps, 'getCurrentOwnerUserId' | 'logger'>,
): boolean {
  const currentOwnerUserId = deps.getCurrentOwnerUserId();
  if (restoreGeneration === getCurrentRestoreGeneration() && restoreOwnerUserId === currentOwnerUserId) {
    return false;
  }
  deps.logger.debug('忽略过期的队列备份恢复结果', { restoreOwnerUserId });
  return true;
}

function handleMissingQueueBackup(
  restoreOwnerUserId: string,
  corruptLocalSnapshot: QueueSnapshot | null,
  runtime: ActionQueueOwnerStorageRuntime,
  deps: Pick<ActionQueueOwnerCurrentQueueLoadDeps, 'handleUnrecoverableCorruptQueueSnapshot'>,
): void {
  if (corruptLocalSnapshot) {
    deps.handleUnrecoverableCorruptQueueSnapshot(restoreOwnerUserId, corruptLocalSnapshot, runtime);
  }
}

function applyRestoredQueueBackup(
  queueAtRestoreStart: QueuedAction[],
  backupQueue: QueuedAction[],
  runtime: ActionQueueOwnerStorageRuntime,
): number {
  const currentQueue = runtime.pendingActions();
  const foregroundQueueChanged = !haveSameQueuedActionRestoreSnapshots(
    queueAtRestoreStart,
    currentQueue,
  );
  const { queue, restoredCount } = foregroundQueueChanged
    ? mergeRestoredQueuedActions(currentQueue, backupQueue)
    : mergeLoadedQueuedActionsWithBackup(currentQueue, backupQueue);

  runtime.setPendingActions(queue);
  runtime.setQueueSize(queue.length);
  runtime.syncSentryContext();
  return restoredCount;
}
