import { LOCAL_QUEUE_CONFIG } from './action-queue-storage.helpers';
import type { DeadLetterItem, QueuedAction } from './action-queue.types';
import type { ActionQueueOwnerStorageRuntime, QueueSnapshot } from './action-queue-owner-storage.types';
import type { QueueBackupRestoreSnapshot } from './queue-backup.service';
import {
  haveSameQueuedActionRestoreSnapshots,
  mergeLoadedQueuedActionsWithBackup,
  mergeRestoredQueuedActions,
} from './action-queue-restore.helpers';
import {
  getQueuedActionOperationIdentity,
  normalizeQueuedActionOperationId,
  normalizeQueueForOutbox,
} from './action-queue-outbox-normalization.helpers';
import type { CategoryLogger } from './logger.service';
import type { ToastService } from './toast.service';
import type { OwnerStorageRestoreOutcome } from './action-queue-restore-barrier.controller';
import {
  filterLocallyRemovedQueuedActions,
  readOwnerQueueRemovalJournal,
} from './action-queue-owner-storage-removal-journal';

export interface ActionQueueOwnerCurrentQueueLoadDeps {
  logger: Pick<CategoryLogger, 'debug' | 'warn'>;
  toast: Pick<ToastService, 'info'>;
  getCurrentOwnerUserId: () => string;
  getScopedStorageKey: (baseKey: string, ownerUserId: string) => string;
  loadScopedOrLegacyStorage: (
    baseKey: string,
    runtime: ActionQueueOwnerStorageRuntime,
  ) => string | null;
  restoreQueueSnapshotFromBackup: (
    ownerUserId: string,
    runtime: ActionQueueOwnerStorageRuntime,
  ) => Promise<QueueBackupRestoreSnapshot | null>;
  handleUnrecoverableCorruptQueueSnapshot: (
    ownerUserId: string,
    snapshot: QueueSnapshot,
    runtime: ActionQueueOwnerStorageRuntime,
  ) => void;
}

interface CurrentQueueLoadResult {
  queueAtRestoreStart: QueuedAction[];
  removedActionIdentities: string[];
  corruptLocalSnapshot: QueueSnapshot | null;
}

export interface ActionQueueOwnerStorageStagedState {
  queue: readonly QueuedAction[];
  queueSize: number;
  deadLetters: readonly DeadLetterItem[];
  deadLetterSize: number;
  queueFrozen: boolean;
  queueFreezeReason: string | null;
}

export interface ActionQueueOwnerStorageStageResult {
  outcome: OwnerStorageRestoreOutcome;
  state?: ActionQueueOwnerStorageStagedState;
}

export function createActionQueueOwnerStorageStagingRuntime(): {
  runtime: ActionQueueOwnerStorageRuntime;
  capture: () => ActionQueueOwnerStorageStagedState;
} {
  let queue: QueuedAction[] = [];
  let queueSize = 0;
  let deadLetters: DeadLetterItem[] = [];
  let deadLetterSize = 0;
  let queueFrozen = false;
  let queueFreezeReason: string | null = null;
  const runtime: ActionQueueOwnerStorageRuntime = {
    pendingActions: () => queue,
    setPendingActions: value => { queue = value; },
    setQueueSize: value => { queueSize = value; },
    deadLetterQueue: () => deadLetters,
    setDeadLetterQueue: value => { deadLetters = value; },
    setDeadLetterSize: value => { deadLetterSize = value; },
    syncSentryContext: () => undefined,
    freezeQueueWrites: reason => { queueFrozen = true; queueFreezeReason = reason; },
    clearQueueFreeze: () => { queueFrozen = false; queueFreezeReason = null; },
    triggerStorageFailureEscapeMode: () => undefined,
    saveQueueToStorage: () => undefined,
    requestQueueProcessing: () => undefined,
  };
  return {
    runtime,
    capture: () => ({
      queue: Object.freeze([...queue]),
      queueSize,
      deadLetters: Object.freeze([...deadLetters]),
      deadLetterSize,
      queueFrozen,
      queueFreezeReason,
    }),
  };
}

export function haveSameActionQueueOwnerStorageState(
  expected: ActionQueueOwnerStorageStagedState,
  actual: ActionQueueOwnerStorageStagedState,
): boolean {
  return expected.queue === actual.queue
    && expected.queueSize === actual.queueSize
    && expected.deadLetters === actual.deadLetters
    && expected.deadLetterSize === actual.deadLetterSize
    && expected.queueFrozen === actual.queueFrozen
    && expected.queueFreezeReason === actual.queueFreezeReason;
}

export function loadCurrentQueueFromStorage(
  restoreGeneration: number,
  restoreOwnerUserId: string,
  getCurrentRestoreGeneration: () => number,
  runtime: ActionQueueOwnerStorageRuntime,
  deps: ActionQueueOwnerCurrentQueueLoadDeps,
): Promise<OwnerStorageRestoreOutcome> {
  const { queueAtRestoreStart, removedActionIdentities, corruptLocalSnapshot } = loadCurrentQueueSnapshotFromStorage(
    restoreOwnerUserId,
    runtime,
    deps,
  );
  return restoreQueueBackupIntoRuntime(
    restoreGeneration,
    restoreOwnerUserId,
    getCurrentRestoreGeneration,
    queueAtRestoreStart,
    removedActionIdentities,
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
    removedActionIdentities: readOwnerQueueRemovalJournal(
      restoreOwnerUserId,
      deps.getScopedStorageKey,
    ),
    corruptLocalSnapshot: null,
  };
  if (typeof localStorage === 'undefined') {
    return initialResult;
  }

  try {
    const saved = deps.loadScopedOrLegacyStorage(LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY, runtime);
    return saved === null
      ? initialResult
      : applySavedQueueSnapshot(
        saved,
        restoreOwnerUserId,
        initialResult.removedActionIdentities,
        runtime,
        deps,
      );
  } catch (error) {
    deps.logger.warn('Failed to load action queue from localStorage; IndexedDB backup restore will still be attempted', {
      error,
    });
    return {
      queueAtRestoreStart: initialResult.queueAtRestoreStart,
      removedActionIdentities: initialResult.removedActionIdentities,
      corruptLocalSnapshot: buildCorruptQueueSnapshot(restoreOwnerUserId, error, deps),
    };
  }
}

function applySavedQueueSnapshot(
  saved: string,
  restoreOwnerUserId: string,
  removedActionIdentities: string[],
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
      removedActionIdentities,
      corruptLocalSnapshot: buildCorruptQueueSnapshot(restoreOwnerUserId, error, deps),
    };
  }

  const normalizedQueue = filterLocallyRemovedQueuedActions(
    normalizeQueueForOutbox(queue),
    removedActionIdentities,
  );
  runtime.setPendingActions(normalizedQueue);
  runtime.setQueueSize(normalizedQueue.length);
  runtime.syncSentryContext();
  return { queueAtRestoreStart: normalizedQueue, removedActionIdentities, corruptLocalSnapshot: null };
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
  removedActionIdentities: string[],
  corruptLocalSnapshot: QueueSnapshot | null,
  runtime: ActionQueueOwnerStorageRuntime,
  deps: ActionQueueOwnerCurrentQueueLoadDeps,
): Promise<OwnerStorageRestoreOutcome> {
  return deps.restoreQueueSnapshotFromBackup(restoreOwnerUserId, runtime).then(backupSnapshot => {
    if (shouldIgnoreQueueRestore(restoreGeneration, restoreOwnerUserId, getCurrentRestoreGeneration, deps)) {
      return 'stale';
    }
    if (backupSnapshot === null || !backupSnapshot.recordFound) {
      return handleMissingQueueBackup(restoreOwnerUserId, corruptLocalSnapshot, runtime, deps);
    }
    const backupQueue = filterLocallyRemovedQueuedActions(
      backupSnapshot.actions,
      removedActionIdentities,
    );
    if (backupQueue.length === 0) {
      applyAuthoritativeEmptyQueueBackup(queueAtRestoreStart, backupSnapshot.savedAt, runtime, deps);
      return 'ready';
    }

    const restoredCount = applyRestoredQueueBackup(queueAtRestoreStart, backupQueue, runtime);
    deps.toast.info('队列恢复', `从备用存储恢复了 ${restoredCount} 个待处理操作`);
    runtime.clearQueueFreeze();
    runtime.saveQueueToStorage();
    requestProcessingForRestoredBackup(restoreOwnerUserId, restoredCount, runtime, deps);
    return 'ready';
  }).catch((error: unknown) => {
    deps.logger.warn('IndexedDB 队列备份恢复失败，保留当前队列视图', {
      ownerUserId: restoreOwnerUserId,
      error,
    });
    runtime.freezeQueueWrites('storage_failure');
    runtime.triggerStorageFailureEscapeMode();
    return 'failed';
  });
}

function applyAuthoritativeEmptyQueueBackup(
  queueAtRestoreStart: QueuedAction[],
  backupSavedAt: string | null,
  runtime: ActionQueueOwnerStorageRuntime,
  deps: Pick<ActionQueueOwnerCurrentQueueLoadDeps, 'logger'>,
): void {
  const backupSavedAtMs = backupSavedAt ? new Date(backupSavedAt).getTime() : Number.NaN;
  const localMaxRecency = queueAtRestoreStart.reduce(
    (max, action) => Math.max(max, action.localCommittedAt ?? 0, action.timestamp ?? 0),
    0,
  );
  if (!Number.isFinite(backupSavedAtMs) || backupSavedAtMs < localMaxRecency
    || !haveSameQueuedActionRestoreSnapshots(queueAtRestoreStart, runtime.pendingActions())) {
    return;
  }

  runtime.setPendingActions([]);
  runtime.setQueueSize(0);
  runtime.syncSentryContext();
  runtime.clearQueueFreeze();
  runtime.saveQueueToStorage();
  deps.logger.debug('已应用较新的空 IndexedDB 队列记录，清除陈旧 localStorage 镜像');
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
): OwnerStorageRestoreOutcome {
  if (corruptLocalSnapshot) {
    deps.handleUnrecoverableCorruptQueueSnapshot(restoreOwnerUserId, corruptLocalSnapshot, runtime);
    return 'failed';
  }
  return 'ready';
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
    ? mergeBackupWithoutReplacingCurrentActions(queueAtRestoreStart, currentQueue, backupQueue)
    : mergeLoadedQueuedActionsWithBackup(currentQueue, backupQueue);

  runtime.setPendingActions(queue);
  runtime.setQueueSize(queue.length);
  runtime.syncSentryContext();
  return restoredCount;
}

function mergeBackupWithoutReplacingCurrentActions(
  queueAtRestoreStart: QueuedAction[],
  currentQueue: QueuedAction[],
  backupQueue: QueuedAction[],
): ReturnType<typeof mergeRestoredQueuedActions> {
  const currentIdentities = new Set(currentQueue
    .map(getRestoreIdentity)
    .filter((identity): identity is string => identity !== null));
  const removedWhileRestorePending = new Set(queueAtRestoreStart
    .map(getRestoreIdentity)
    .filter((identity): identity is string => identity !== null && !currentIdentities.has(identity)));
  return mergeRestoredQueuedActions(
    currentQueue,
    backupQueue.filter(action => {
      const identity = getRestoreIdentity(action);
      return identity === null
        || (!currentIdentities.has(identity) && !removedWhileRestorePending.has(identity));
    }),
  );
}

function getRestoreIdentity(action: QueuedAction): string | null {
  return getQueuedActionOperationIdentity(
    normalizeQueuedActionOperationId(action.operationId, action.id),
  );
}
