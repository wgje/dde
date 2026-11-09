/** Owner-scoped ActionQueue 持久化协作服务，负责存储隔离、legacy 隔离与旧 owner 队列收口。 */
import { Injectable, inject } from '@angular/core';
import { AUTH_CONFIG } from '../config/auth.config';
import { AuthService } from './auth.service';
import {
  QueueBackupService,
  type QueueBackupRestoreSnapshot,
  type QueueBackupStrictUpdateResult,
} from './queue-backup.service';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { trackLocalBackupUiRestoreWriterPromise } from './local-backup-ui-restore-writer-quiescence-tracker';
import type { DeadLetterItem, QueuedAction } from './action-queue.types';
import {
  appendCappedDeadLetterItem,
  LOCAL_QUEUE_CONFIG,
  type QueueRetryError,
} from './action-queue-storage.helpers';
import type { ActionQueueOwnerStorageRuntime, QueueSnapshot } from './action-queue-owner-storage.types';
import { ActionQueueOwnerStorageLegacyQuarantine } from './action-queue-owner-storage-legacy-quarantine.helper';
import {
  shouldKeepAfterProjectDeleteSettlement,
} from './action-queue-owner-storage-failed-settlement.helpers';
import {
  extractRestorableDeadLetters,
  mergeRestoredDeadLetters,
  normalizeStoredDeadLetters,
} from './action-queue-owner-dead-letter-restore.helpers';
import {
  normalizeQueueForOutbox,
} from './action-queue-outbox-normalization.helpers';
import {
  loadPersistedQueueForOwner,
  loadQueueMutationBaseForOwner,
  persistQueueMutationForOwner,
  saveLocalQueueMirrorForOwner,
  saveQueueSnapshotForOwner,
  settleFailedOwnerAction,
} from './action-queue-owner-storage-queue-persistence';
import {
  createActionQueueOwnerStorageStagingRuntime,
  loadCurrentQueueFromStorage as loadCurrentQueueFromStorageWithDeps,
  type ActionQueueOwnerStorageStageResult,
} from './action-queue-owner-storage-load.helpers';
import type { OwnerStorageRestoreOutcome } from './action-queue-restore-barrier.controller';
import {
  handleOwnerQueueLocalStorageWriteFailure,
  handleOwnerQueueQuotaExceeded,
} from './action-queue-owner-storage-write-failure.helpers';
import {
  clearLegacyGlobalStorageForLocalOwner,
  readOwnerDeadLetterSnapshotFromLocalStorage,
  readOwnerQueueSnapshotFromLocalStorage,
  writeOwnerScopedLocalStorageValue,
} from './action-queue-owner-storage-local-helpers';

@Injectable({ providedIn: 'root' })
export class ActionQueueOwnerStorageService {
  private readonly logger = inject(LoggerService).category('ActionQueueOwnerStorage');
  private readonly toast = inject(ToastService);
  private readonly authService = inject(AuthService);
  private readonly queueBackup = inject(QueueBackupService);
  private readonly stagingRuntimes = new WeakSet<ActionQueueOwnerStorageRuntime>();
  private readonly legacyQuarantine = new ActionQueueOwnerStorageLegacyQuarantine({
    getCurrentOwnerUserId: () => this.getCurrentOwnerUserId(),
    getScopedStorageKey: (baseKey, ownerUserId) => this.getScopedStorageKey(baseKey, ownerUserId),
    readDeadLetterSnapshotFromLocalStorage: ownerUserId =>
      this.readDeadLetterSnapshotFromLocalStorage(ownerUserId),
    readScopedDeadLetterQueueFromStorage: () => this.readScopedDeadLetterQueueFromStorage(),
    saveDeadLetterSnapshotForOwner: (ownerUserId, queue) =>
      this.saveDeadLetterSnapshotForOwner(ownerUserId, queue),
    logger: this.logger,
    toast: this.toast,
  });
  private readonly queuePersistence = {
    queueBackup: this.queueBackup,
    logger: this.logger,
    getScopedStorageKey: (baseKey: string, ownerUserId: string) =>
      this.getScopedStorageKey(baseKey, ownerUserId),
    invalidateLocalQueueSnapshot: (ownerUserId: string) =>
      this.invalidateLocalQueueSnapshot(ownerUserId),
  };
  private readonly queueMutation = {
    ...this.queuePersistence,
    getCurrentOwnerUserId: () => this.getCurrentOwnerUserId(),
    persistQueueSnapshotForOwner: (
      ownerUserId: string,
      queue: QueuedAction[],
      runtime: ActionQueueOwnerStorageRuntime,
    ) => this.persistQueueSnapshotForOwner(ownerUserId, queue, runtime),
    readQueueSnapshotFromLocalStorage: (ownerUserId: string) =>
      this.readQueueSnapshotFromLocalStorage(ownerUserId),
    handleUnrecoverableCorruptQueueSnapshot: (
      ownerUserId: string,
      snapshot: QueueSnapshot,
      runtime: ActionQueueOwnerStorageRuntime,
    ) => this.handleUnrecoverableCorruptQueueSnapshot(ownerUserId, snapshot, runtime),
  };
  private readonly queueLoad = {
    readQueueSnapshotFromLocalStorage: (ownerUserId: string) =>
      this.readQueueSnapshotFromLocalStorage(ownerUserId),
    restoreQueueFromBackup: (
      ownerUserId: string,
      runtime: ActionQueueOwnerStorageRuntime,
    ) => this.restoreQueueFromBackup(ownerUserId, runtime),
    handleUnrecoverableCorruptQueueSnapshot: (
      ownerUserId: string,
      snapshot: QueueSnapshot,
      runtime: ActionQueueOwnerStorageRuntime,
    ) => this.handleUnrecoverableCorruptQueueSnapshot(ownerUserId, snapshot, runtime),
  };
  private readonly currentQueueLoad = {
    logger: this.logger,
    toast: this.toast,
    getCurrentOwnerUserId: () => this.getCurrentOwnerUserId(),
    getScopedStorageKey: (baseKey: string, ownerUserId: string) =>
      this.getScopedStorageKey(baseKey, ownerUserId),
    loadScopedOrLegacyStorage: (baseKey: string, runtime: ActionQueueOwnerStorageRuntime) =>
      this.loadScopedOrLegacyStorage(baseKey, runtime),
    restoreQueueSnapshotFromBackup: (
      ownerUserId: string,
      runtime: ActionQueueOwnerStorageRuntime,
    ) => this.restoreQueueSnapshotFromBackup(ownerUserId, runtime),
    handleUnrecoverableCorruptQueueSnapshot: (
      ownerUserId: string,
      snapshot: QueueSnapshot,
      runtime: ActionQueueOwnerStorageRuntime,
    ) => this.handleUnrecoverableCorruptQueueSnapshot(ownerUserId, snapshot, runtime),
  };
  private readonly writeFailureDeps = {
    queueBackup: {
      backupQueue: (queue: QueuedAction[], ownerUserId?: string) => {
        const owner = ownerUserId ?? this.getCurrentOwnerUserId();
        return this.trackBackup(owner, () => this.queueBackup.backupQueue(queue, owner));
      },
    },
    logger: this.logger,
    toast: this.toast,
    getCurrentOwnerUserId: () => this.getCurrentOwnerUserId(),
    invalidateLocalQueueSnapshot: (ownerUserId?: string) =>
      this.invalidateLocalQueueSnapshot(ownerUserId),
  };

  getCurrentOwnerUserId(): string {
    return this.authService.currentUserId() ?? AUTH_CONFIG.LOCAL_MODE_USER_ID;
  }

  private trackBackup<T>(ownerUserId: string, backup: () => Promise<T>): Promise<T> {
    if (typeof localStorage === 'undefined') return backup();
    return trackLocalBackupUiRestoreWriterPromise(ownerUserId, 'action-queue',
      backup, { continuation: true });
  }

  getScopedStorageKey(baseKey: string, ownerUserId = this.getCurrentOwnerUserId()): string {
    return `${baseKey}.${ownerUserId}`;
  }

  invalidateLocalQueueSnapshot(ownerUserId = this.getCurrentOwnerUserId()): void {
    if (typeof localStorage === 'undefined') {
      return;
    }

    try {
      localStorage.removeItem(this.getScopedStorageKey(LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY, ownerUserId));
      if (ownerUserId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
        localStorage.removeItem(LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY);
      }
    } catch (error) {
      this.logger.warn('清理失效的 localStorage 队列快照失败', { ownerUserId, error });
    }
  }

  async persistQueueSnapshotForOwner(
    ownerUserId: string,
    queue: QueuedAction[],
    runtime: ActionQueueOwnerStorageRuntime,
  ): Promise<boolean> {
    try {
      await saveQueueSnapshotForOwner(ownerUserId, queue, runtime, this.queuePersistence);
      return true;
    } catch (error) {
      this.logger.warn('持久化 owner-scoped 队列快照失败', {
        ownerUserId,
        error,
      });
      return false;
    }
  }

  refreshQueueMirrorForOwnerAfterRestore(
    ownerUserId: string,
    queue: QueuedAction[],
  ): boolean {
    if (ownerUserId !== this.getCurrentOwnerUserId() || typeof localStorage === 'undefined') return false;
    try {
      const normalizedQueue = normalizeQueueForOutbox(queue);
      writeOwnerScopedLocalStorageValue(
        LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY,
        ownerUserId,
        normalizedQueue,
        (baseKey, scopedOwnerUserId) => this.getScopedStorageKey(baseKey, scopedOwnerUserId),
      );
      const storageKey = this.getScopedStorageKey(LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY, ownerUserId);
      return localStorage.getItem(storageKey) === JSON.stringify(normalizedQueue);
    } catch (error) {
      try {
        this.logger.warn('恢复后刷新 owner-scoped 队列镜像失败', { ownerUserId, error });
      } catch {
        // Logging is best-effort; the restore journal owns recovery.
      }
      return false;
    }
  }

  async persistQueueMutationForOwner(
    ownerUserId: string,
    updater: (queue: QueuedAction[]) => QueuedAction[],
    runtime: ActionQueueOwnerStorageRuntime,
  ): Promise<QueuedAction[] | null> {
    return persistQueueMutationForOwner(ownerUserId, updater, runtime, this.queueMutation);
  }

  async persistQueueMutationStrictlyForOwner(
    ownerUserId: string,
    updater: (queue: QueuedAction[]) => QueuedAction[],
    runtime: ActionQueueOwnerStorageRuntime,
  ): Promise<QueueBackupStrictUpdateResult> {
    try {
      const result = await this.trackBackup(ownerUserId, () =>
        this.queueBackup.updateQueueStrictly(
          ownerUserId,
          queue => normalizeQueueForOutbox(updater(queue)),
        ));
      if (result.status === 'committed') {
        saveLocalQueueMirrorForOwner(ownerUserId, result.queue, runtime, this.queuePersistence);
      }
      return result;
    } catch (error) {
      this.logger.warn('IndexedDB owner-scoped strict mutation 失败', { ownerUserId, error });
      return { status: 'storage-failed' };
    }
  }

  async settleSuccessfulActionForOwner(
    ownerUserId: string,
    actionId: string,
    runtime: ActionQueueOwnerStorageRuntime,
  ): Promise<boolean> {
    let settled = false;
    const updatedQueue = await this.persistQueueMutationForOwner(
      ownerUserId,
      queue => {
        const nextQueue = queue.filter(action => action.id !== actionId);
        settled = nextQueue.length !== queue.length;
        return nextQueue;
      },
      runtime,
    );

    if (updatedQueue === null) {
      if (!settled) {
        this.logger.debug('旧 owner 队列中未找到待收口的成功 action', { ownerUserId, actionId });
        return false;
      }
      throw new Error(`owner-scoped 成功 action 收口保存失败: ${ownerUserId}`);
    }

    if (!settled) {
      this.logger.debug('旧 owner 队列中未找到待收口的成功 action', { ownerUserId, actionId });
      return false;
    }

    return true;
  }

  loadQueueSnapshotForOwner(
    ownerUserId: string,
    runtime: ActionQueueOwnerStorageRuntime,
  ): Promise<QueuedAction[]> {
    return loadPersistedQueueForOwner(ownerUserId, runtime, this.queueLoad);
  }

  async settleProjectDeleteSuccessForOwner(
    ownerUserId: string,
    projectId: string,
    actionId: string | undefined,
    runtime: ActionQueueOwnerStorageRuntime,
  ): Promise<number> {
    let removedCount = 0;
    const updatedQueue = await this.persistQueueMutationForOwner(
      ownerUserId,
      queue => {
        const nextQueue = queue.filter(action =>
          shouldKeepAfterProjectDeleteSettlement(action, projectId, actionId)
        );
        removedCount = queue.length - nextQueue.length;
        return nextQueue;
      },
      runtime,
    );

    if (updatedQueue === null) {
      if (removedCount === 0) {
        this.logger.debug('旧 owner 队列中未找到待收口的项目删除关联 action', {
          ownerUserId,
          projectId,
          actionId,
        });
        return 0;
      }
      throw new Error(`owner-scoped 项目删除收口保存失败: ${ownerUserId}`);
    }

    if (removedCount === 0) {
      this.logger.debug('旧 owner 队列中未找到待收口的项目删除关联 action', {
        ownerUserId,
        projectId,
        actionId,
      });
      return 0;
    }

    return removedCount;
  }

  async settleFailedActionForOwner(
    ownerUserId: string,
    action: QueuedAction,
    error: string | QueueRetryError,
    runtime: ActionQueueOwnerStorageRuntime,
  ): Promise<'retry' | 'dead-letter' | 'missing'> {
    return settleFailedOwnerAction(ownerUserId, action, error, runtime, {
      logger: this.logger,
      loadQueue: () => loadQueueMutationBaseForOwner(ownerUserId, runtime, this.queueLoad),
      persistQueueMutation: updater => this.persistQueueMutationForOwner(ownerUserId, updater, runtime),
      buildDeadLetterQueue: (actionId, item) => this.buildOwnerDeadLetterQueue(ownerUserId, actionId, item),
      saveDeadLetterQueue: queue => this.saveDeadLetterSnapshotForOwner(ownerUserId, queue),
    });
  }

  async appendActionForOwner(
    ownerUserId: string,
    action: QueuedAction,
    runtime: ActionQueueOwnerStorageRuntime,
  ): Promise<void> {
    const updatedQueue = await this.persistQueueMutationForOwner(
      ownerUserId,
      queue => [
        ...queue.filter(existing => existing.id !== action.id),
        action,
      ],
      runtime,
    );
    if (updatedQueue === null) {
      throw new Error(`owner-scoped 队列追加失败: ${ownerUserId}`);
    }
  }

  clearLegacyGlobalStorageIfLocalOwner(baseKey: string): void {
    clearLegacyGlobalStorageForLocalOwner(this.getCurrentOwnerUserId(), baseKey);
  }

  loadScopedOrLegacyStorage(baseKey: string, runtime: ActionQueueOwnerStorageRuntime): string | null {
    const scopedKey = this.getScopedStorageKey(baseKey);
    const scopedValue = localStorage.getItem(scopedKey);
    if (scopedValue !== null) {
      return scopedValue;
    }

    const legacyValue = localStorage.getItem(baseKey);
    if (legacyValue === null) {
      return null;
    }
    if (this.stagingRuntimes.has(runtime)) return null;

    if (baseKey === LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY) {
      this.legacyQuarantine.quarantineLegacyQueueStorageValue(legacyValue, baseKey, runtime);
      return null;
    }

    if (baseKey === LOCAL_QUEUE_CONFIG.DEAD_LETTER_STORAGE_KEY) {
      this.legacyQuarantine.quarantineLegacyDeadLetterStorageValue(legacyValue, baseKey, runtime);
      return null;
    }

    return null;
  }

  async restoreQueueFromBackup(
    ownerUserId: string,
    runtime: ActionQueueOwnerStorageRuntime,
  ): Promise<QueuedAction[] | null> {
    const queue = await this.queueBackup.restoreQueue(ownerUserId, (legacyItems) => {
      if (this.stagingRuntimes.has(runtime)) return;
      this.legacyQuarantine.quarantineLegacyQueueForReview(
        legacyItems.map((item) => item.action),
        'legacy-idb-backup',
        runtime,
      );
    });
    return queue ? normalizeQueueForOutbox(queue) : null;
  }

  private async restoreQueueSnapshotFromBackup(ownerUserId: string, runtime: ActionQueueOwnerStorageRuntime): Promise<QueueBackupRestoreSnapshot | null> {
    const restoreSnapshot = this.queueBackup.restoreQueueSnapshot?.bind(this.queueBackup);
    if (!restoreSnapshot) {
      const actions = await this.restoreQueueFromBackup(ownerUserId, runtime);
      return actions === null ? null : { recordFound: true, actions, savedAt: null };
    }
    const snapshot = await restoreSnapshot(ownerUserId, legacyItems => {
      if (this.stagingRuntimes.has(runtime)) return;
      this.legacyQuarantine.quarantineLegacyQueueForReview(
        legacyItems.map(item => item.action),
        'legacy-idb-backup',
        runtime,
      );
    });
    return snapshot ? { ...snapshot, actions: normalizeQueueForOutbox(snapshot.actions) } : null;
  }

  backupQueue(queue: QueuedAction[], ownerUserId = this.getCurrentOwnerUserId()): Promise<boolean> {
    return this.queueBackup.backupQueue(queue, ownerUserId);
  }

  saveCurrentQueueToStorage(runtime: ActionQueueOwnerStorageRuntime): void {
    if (typeof localStorage === 'undefined') {
      this.handleQueueLocalStorageWriteFailure(runtime, new Error('localStorage unavailable'));
      return;
    }

    try {
      const queue = runtime.pendingActions();
      const ownerUserId = this.getCurrentOwnerUserId();
      writeOwnerScopedLocalStorageValue(
        LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY,
        this.getCurrentOwnerUserId(),
        queue,
        (baseKey, ownerUserId) => this.getScopedStorageKey(baseKey, ownerUserId),
      );
      void this.trackBackup(ownerUserId, () => this.queueBackup.backupQueue(queue, ownerUserId)).catch((error: unknown) => {
        this.logger.warn('owner-scoped 队列已写入 localStorage，但 IndexedDB 备份镜像失败', {
          ownerUserId,
          error,
        });
      });
      runtime.clearQueueFreeze();
    } catch (e: unknown) {
      const isQuotaError =
        (e instanceof DOMException && (e.name === 'QuotaExceededError' || e.code === 22)) ||
        (e instanceof Error && e.name === 'QuotaExceededError');

      if (isQuotaError) {
        this.handleQueueQuotaExceeded(runtime);
        return;
      }

      this.logger.warn('Failed to save action queue to storage', e);
      this.handleQueueLocalStorageWriteFailure(runtime, e);
    }
  }

  loadCurrentQueueFromStorage(
    restoreGeneration: number,
    restoreOwnerUserId: string,
    getCurrentRestoreGeneration: () => number,
    runtime: ActionQueueOwnerStorageRuntime,
  ): Promise<OwnerStorageRestoreOutcome> {
    return loadCurrentQueueFromStorageWithDeps(
      restoreGeneration,
      restoreOwnerUserId,
      getCurrentRestoreGeneration,
      runtime,
      this.currentQueueLoad,
    );
  }

  async stageCurrentOwnerStorage(
    restoreGeneration: number,
    restoreOwnerUserId: string,
    getCurrentRestoreGeneration: () => number,
  ): Promise<ActionQueueOwnerStorageStageResult> {
    const staging = createActionQueueOwnerStorageStagingRuntime();
    this.stagingRuntimes.add(staging.runtime);
    const queueOutcome = await this.loadCurrentQueueFromStorage(
      restoreGeneration,
      restoreOwnerUserId,
      getCurrentRestoreGeneration,
      staging.runtime,
    );
    if (queueOutcome !== 'ready') return { outcome: queueOutcome };
    const deadLetterOutcome = await this.loadCurrentDeadLettersFromStorage(
      restoreGeneration,
      restoreOwnerUserId,
      getCurrentRestoreGeneration,
      staging.runtime,
      false,
    );
    if (deadLetterOutcome !== 'ready') return { outcome: deadLetterOutcome };
    if (restoreGeneration !== getCurrentRestoreGeneration()
      || restoreOwnerUserId !== this.getCurrentOwnerUserId()) return { outcome: 'stale' };
    return { outcome: 'ready', state: staging.capture() };
  }

  private handleUnrecoverableCorruptQueueSnapshot(
    ownerUserId: string,
    snapshot: QueueSnapshot,
    runtime: ActionQueueOwnerStorageRuntime,
  ): void {
    this.logger.warn(
      'owner-scoped 队列快照损坏且 IndexedDB 备份不可用，已冻结队列写入避免静默丢失',
      {
        ownerUserId,
        storageKey: snapshot.storageKey ?? this.getScopedStorageKey(LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY, ownerUserId),
        error: snapshot.error,
      },
    );
    runtime.freezeQueueWrites('corrupt_local_queue_snapshot');
    runtime.triggerStorageFailureEscapeMode();
  }

  saveCurrentDeadLettersToStorage(runtime: ActionQueueOwnerStorageRuntime): boolean {
    const ownerUserId = this.getCurrentOwnerUserId();
    if (typeof localStorage === 'undefined') {
      this.backupDeadLetterSnapshotForOwner(ownerUserId, runtime.deadLetterQueue(), 'localStorage-unavailable');
      return false;
    }

    try {
      const deadLetterStorageKey = this.getScopedStorageKey(LOCAL_QUEUE_CONFIG.DEAD_LETTER_STORAGE_KEY);
      localStorage.setItem(deadLetterStorageKey, JSON.stringify(runtime.deadLetterQueue()));
      this.clearLegacyGlobalStorageIfLocalOwner(LOCAL_QUEUE_CONFIG.DEAD_LETTER_STORAGE_KEY);
      this.backupDeadLetterSnapshotForOwner(ownerUserId, runtime.deadLetterQueue(), 'save-current');
      return true;
    } catch (e) {
      this.logger.warn('Failed to save dead letter queue to storage', { error: e });
      this.backupDeadLetterSnapshotForOwner(ownerUserId, runtime.deadLetterQueue(), 'localStorage-write-failed');
      runtime.freezeQueueWrites('storage_failure');
      runtime.triggerStorageFailureEscapeMode();
      return false;
    }
  }

  loadCurrentDeadLettersFromStorage(
    restoreGeneration: number, restoreOwnerUserId: string,
    getCurrentRestoreGeneration: () => number, runtime: ActionQueueOwnerStorageRuntime, persistRestoredSnapshot = true,
  ): Promise<OwnerStorageRestoreOutcome> {
    let localSnapshotCorrupt = false;
    if (typeof localStorage !== 'undefined') {
      try {
        const saved = this.loadScopedOrLegacyStorage(LOCAL_QUEUE_CONFIG.DEAD_LETTER_STORAGE_KEY, runtime);
        if (!saved) {
          return this.restoreDeadLetterBackupIntoRuntime(
            restoreGeneration, restoreOwnerUserId, getCurrentRestoreGeneration, runtime, false,
            persistRestoredSnapshot,
          );
        }
        const queue = JSON.parse(saved) as DeadLetterItem[];
        if (!Array.isArray(queue)) {
          localSnapshotCorrupt = true;
          return this.restoreDeadLetterBackupIntoRuntime(
            restoreGeneration, restoreOwnerUserId, getCurrentRestoreGeneration, runtime, true,
            persistRestoredSnapshot,
          );
        }
        // §5.6：死信是失败写入的最后一份副本，必须随时可导出/可重放。
        // 超龄条目只提示不删除（等效替用户 dismiss 属于静默丢失），
        // 容量上限 MAX_DEAD_LETTER_SIZE 负责封顶；非法 failedAt 修复为当前时间保留。
        const normalized = normalizeStoredDeadLetters(queue);
        runtime.setDeadLetterQueue(normalized.queue);
        runtime.setDeadLetterSize(normalized.queue.length);
        runtime.syncSentryContext();
        if (normalized.repairedCount > 0 && persistRestoredSnapshot) {
          this.saveCurrentDeadLettersToStorage(runtime);
          this.logger.warn(`修复了 ${normalized.repairedCount} 个死信条目的非法 failedAt 时间戳`);
        }
        if (normalized.agedCount > 0) {
          this.logger.info(`${normalized.agedCount} 个死信条目已超过 24 小时未处理，仍保留供导出/重试/放弃`);
        }
        return Promise.resolve('ready');
      } catch (e) {
        localSnapshotCorrupt = true;
        this.logger.warn('Failed to load dead letter queue from storage; IndexedDB backup restore will still be attempted', {
          error: e,
        });
      }
    }
    return this.restoreDeadLetterBackupIntoRuntime(
      restoreGeneration,
      restoreOwnerUserId,
      getCurrentRestoreGeneration,
      runtime,
      localSnapshotCorrupt,
      persistRestoredSnapshot,
    );
  }
  private restoreDeadLetterBackupIntoRuntime(
    restoreGeneration: number, ownerUserId: string,
    getCurrentRestoreGeneration: () => number, runtime: ActionQueueOwnerStorageRuntime,
    localSnapshotCorrupt: boolean,
    persistRestoredSnapshot: boolean,
  ): Promise<OwnerStorageRestoreOutcome> {
    return this.queueBackup.restoreDeadLetters(ownerUserId).then(backupDeadLetters => {
      if (ownerUserId !== this.getCurrentOwnerUserId()) {
        if (backupDeadLetters && backupDeadLetters.length > 0) {
          this.restoreDeadLettersFromBackupItems(
            ownerUserId, backupDeadLetters, runtime, persistRestoredSnapshot,
          );
        }
        return 'stale';
      }
      if (restoreGeneration !== getCurrentRestoreGeneration()) return 'stale';
      if (!backupDeadLetters || backupDeadLetters.length === 0) {
        if (localSnapshotCorrupt) {
          runtime.freezeQueueWrites('storage_failure');
          runtime.triggerStorageFailureEscapeMode();
          return 'failed';
        }
        return 'ready';
      }
      const restoredCount = this.restoreDeadLettersFromBackupItems(
        ownerUserId, backupDeadLetters, runtime, persistRestoredSnapshot,
      );
      if (restoredCount > 0) {
        this.toast.info('死信队列恢复', `从备用存储恢复了 ${restoredCount} 个失败操作`);
        runtime.clearQueueFreeze();
      }
      return 'ready';
    }).catch((error: unknown) => {
      if (restoreGeneration !== getCurrentRestoreGeneration()
        || ownerUserId !== this.getCurrentOwnerUserId()) return 'stale';
      this.logger.warn('IndexedDB 死信队列备份恢复失败，保留当前死信队列视图', {
        ownerUserId,
        error,
      });
      runtime.freezeQueueWrites('storage_failure');
      runtime.triggerStorageFailureEscapeMode();
      return 'failed';
    });
  }

  restoreDeadLettersFromBackupItems(
    ownerUserId: string,
    items: unknown[],
    runtime: ActionQueueOwnerStorageRuntime,
    persistSnapshot = true,
  ): number {
    const backupDeadLetters = extractRestorableDeadLetters(
      items,
      ownerUserId,
      item => this.resolveDeadLetterOwnerUserId(item),
    );
    if (backupDeadLetters.length === 0) {
      return 0;
    }

    const existingDeadLetters = ownerUserId === this.getCurrentOwnerUserId()
      ? [
          ...this.readDeadLetterSnapshotFromLocalStorage(ownerUserId),
          ...runtime.deadLetterQueue(),
        ]
      : this.readDeadLetterSnapshotFromLocalStorage(ownerUserId);
    const mergeResult = mergeRestoredDeadLetters(existingDeadLetters, backupDeadLetters);
    if (mergeResult.restoredCount === 0) {
      return 0;
    }

    if (persistSnapshot && !this.saveDeadLetterSnapshotForOwner(ownerUserId, mergeResult.queue)) {
      runtime.freezeQueueWrites('storage_failure');
      runtime.triggerStorageFailureEscapeMode();
      return 0;
    }

    if (ownerUserId === this.getCurrentOwnerUserId()) {
      runtime.setDeadLetterQueue(mergeResult.queue);
      runtime.setDeadLetterSize(mergeResult.queue.length);
      runtime.syncSentryContext();
    }

    return mergeResult.restoredCount;
  }

  private handleQueueQuotaExceeded(runtime: ActionQueueOwnerStorageRuntime): void {
    handleOwnerQueueQuotaExceeded(runtime, this.writeFailureDeps);
  }

  private handleQueueLocalStorageWriteFailure(
    runtime: ActionQueueOwnerStorageRuntime,
    error: unknown,
  ): void {
    handleOwnerQueueLocalStorageWriteFailure(runtime, error, this.writeFailureDeps);
  }

  private readQueueSnapshotFromLocalStorage(ownerUserId: string): QueueSnapshot {
    return readOwnerQueueSnapshotFromLocalStorage({
      ownerUserId,
      getScopedStorageKey: (baseKey, scopedOwnerUserId) =>
        this.getScopedStorageKey(baseKey, scopedOwnerUserId),
      logger: this.logger,
    });
  }

  private readDeadLetterSnapshotFromLocalStorage(ownerUserId: string): DeadLetterItem[] {
    return readOwnerDeadLetterSnapshotFromLocalStorage({
      ownerUserId,
      getScopedStorageKey: (baseKey, scopedOwnerUserId) =>
        this.getScopedStorageKey(baseKey, scopedOwnerUserId),
      logger: this.logger,
    });
  }

  private resolveDeadLetterOwnerUserId(item: DeadLetterItem): string {
    const payload = item.action.payload as unknown;
    const sourceUserId = payload && typeof payload === 'object' && 'sourceUserId' in payload
      && typeof payload.sourceUserId === 'string'
      ? payload.sourceUserId
      : undefined;
    return sourceUserId ?? this.getCurrentOwnerUserId();
  }

  private saveDeadLetterSnapshotForOwner(ownerUserId: string, queue: DeadLetterItem[]): boolean {
    if (typeof localStorage === 'undefined') {
      return false;
    }

    try {
      writeOwnerScopedLocalStorageValue(
        LOCAL_QUEUE_CONFIG.DEAD_LETTER_STORAGE_KEY,
        ownerUserId,
        queue,
        (baseKey, scopedOwnerUserId) => this.getScopedStorageKey(baseKey, scopedOwnerUserId),
      );
      this.backupDeadLetterSnapshotForOwner(ownerUserId, queue, 'save-snapshot');
      return true;
    } catch (error) {
      this.logger.warn('保存 owner-scoped dead-letter 快照失败', { ownerUserId, error });
      this.backupDeadLetterSnapshotForOwner(ownerUserId, queue, 'localStorage-snapshot-failed');
      return false;
    }
  }

  private backupDeadLetterSnapshotForOwner(
    ownerUserId: string,
    queue: DeadLetterItem[],
    reason: string,
  ): void {
    const pending = this.trackBackup(ownerUserId,
      () => this.queueBackup.backupDeadLetters(queue, ownerUserId));
    void pending.then(success => {
      if (!success) {
        this.logger.warn('IndexedDB dead-letter 备份失败', {
          ownerUserId,
          reason,
          count: queue.length,
        });
      }
    }).catch((error: unknown) => {
      this.logger.warn('IndexedDB dead-letter 备份异常', {
        ownerUserId,
        reason,
        error,
      });
    });
  }

  private async buildOwnerDeadLetterQueue(
    ownerUserId: string,
    actionId: string,
    item: DeadLetterItem,
  ): Promise<DeadLetterItem[]> {
    const existing = (await this.readOwnerDeadLetterMergeBase(ownerUserId))
      .filter(deadLetter => deadLetter.action.id !== actionId);
    return appendCappedDeadLetterItem(existing, item).queue;
  }

  private async readOwnerDeadLetterMergeBase(ownerUserId: string): Promise<DeadLetterItem[]> {
    const localDeadLetters = this.readDeadLetterSnapshotFromLocalStorage(ownerUserId);
    let backupDeadLetters: DeadLetterItem[] = [];

    try {
      const restored = await this.queueBackup.restoreDeadLetters(ownerUserId);
      backupDeadLetters = extractRestorableDeadLetters(
        restored ?? [],
        ownerUserId,
        () => ownerUserId,
      );
    } catch (error) {
      this.logger.warn('读取 owner-scoped dead-letter IndexedDB 备份失败，保留本地快照', {
        ownerUserId,
        error,
      });
    }

    if (backupDeadLetters.length === 0) {
      return localDeadLetters;
    }

    return mergeRestoredDeadLetters(localDeadLetters, backupDeadLetters).queue;
  }

  private readScopedDeadLetterQueueFromStorage(): DeadLetterItem[] {
    return this.readDeadLetterSnapshotFromLocalStorage(this.getCurrentOwnerUserId());
  }

}
