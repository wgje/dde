/** Owner-scoped ActionQueue 持久化协作服务，负责存储隔离、legacy 隔离与旧 owner 队列收口。 */
import { Injectable, inject } from '@angular/core';
import { AUTH_CONFIG } from '../config/auth.config';
import { AuthService } from './auth.service';
import { QueueBackupService } from './queue-backup.service';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import type { DeadLetterItem, QueuedAction } from './action-queue.types';
import {
  appendCappedDeadLetterItem,
  buildFailedOwnerDeadLetterReason,
  LOCAL_QUEUE_CONFIG,
  type QueueRetryError,
} from './action-queue-storage.helpers';
import type { ActionQueueOwnerStorageRuntime, QueueSnapshot } from './action-queue-owner-storage.types';
import { ActionQueueOwnerStorageLegacyQuarantine } from './action-queue-owner-storage-legacy-quarantine.helper';
import {
  buildFailedActionRetryQueue,
  createFailedActionSettlement,
  shouldKeepAfterProjectDeleteSettlement,
  type FailedActionSettlement,
} from './action-queue-owner-storage-failed-settlement.helpers';
import {
  extractRestorableDeadLetters,
  mergeRestoredDeadLetters,
} from './action-queue-owner-dead-letter-restore.helpers';
import {
  normalizeQueueForOutbox,
} from './action-queue-outbox-normalization.helpers';
import {
  loadPersistedQueueForOwner,
  loadQueueMutationBaseForOwner,
  persistQueueMutationForOwner,
  saveQueueSnapshotForOwner,
} from './action-queue-owner-storage-queue-persistence';
import {
  loadCurrentQueueFromStorage as loadCurrentQueueFromStorageWithDeps,
} from './action-queue-owner-storage-load.helpers';
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
  private readonly writeFailureDeps = {
    queueBackup: this.queueBackup,
    logger: this.logger,
    toast: this.toast,
    getCurrentOwnerUserId: () => this.getCurrentOwnerUserId(),
    invalidateLocalQueueSnapshot: (ownerUserId?: string) =>
      this.invalidateLocalQueueSnapshot(ownerUserId),
  };

  getCurrentOwnerUserId(): string {
    return this.authService.currentUserId() ?? AUTH_CONFIG.LOCAL_MODE_USER_ID;
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

  async persistQueueMutationForOwner(
    ownerUserId: string,
    updater: (queue: QueuedAction[]) => QueuedAction[],
    runtime: ActionQueueOwnerStorageRuntime,
  ): Promise<QueuedAction[] | null> {
    return persistQueueMutationForOwner(ownerUserId, updater, runtime, this.queueMutation);
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
    const queue = await loadQueueMutationBaseForOwner(ownerUserId, runtime, this.queueLoad);
    const existingAction = queue.find(item => item.id === action.id);
    if (!existingAction) {
      this.logger.debug('旧 owner 队列中未找到待收口的失败 action', {
        ownerUserId,
        actionId: action.id,
      });
      return 'missing';
    }

    const settlement = createFailedActionSettlement(existingAction, error);

    if (settlement.shouldDeadLetter) {
      await this.moveFailedOwnerActionToDeadLetter(ownerUserId, action.id, existingAction, settlement, runtime);
      return 'dead-letter';
    }

    let retried = false;
    const updatedQueue = await this.persistQueueMutationForOwner(
      ownerUserId,
      latestQueue => {
        retried = latestQueue.some(item => item.id === action.id);
        return retried
          ? buildFailedActionRetryQueue(latestQueue, action.id, settlement)
          : latestQueue;
      },
      runtime,
    );

    if (updatedQueue === null) {
      throw new Error(`owner-scoped 失败 action 重试收口保存失败: ${ownerUserId}`);
    }

    if (!retried) {
      this.logger.debug('旧 owner 队列中未找到待收口的失败 action', {
        ownerUserId,
        actionId: action.id,
      });
      return 'missing';
    }

    return 'retry';
  }

  private async moveFailedOwnerActionToDeadLetter(
    ownerUserId: string,
    actionId: string,
    existingAction: QueuedAction,
    settlement: FailedActionSettlement,
    runtime: ActionQueueOwnerStorageRuntime,
  ): Promise<void> {
    const deadLetters = await this.buildOwnerDeadLetterQueue(ownerUserId, actionId, {
      action: {
        ...existingAction,
        lastError: settlement.errorMessage,
        errorType: settlement.errorType,
        syncState: 'dead_letter',
      },
      failedAt: new Date().toISOString(),
      reason: buildFailedOwnerDeadLetterReason(
        settlement.errorType,
        settlement.errorMessage,
      ),
    });
    if (!this.saveDeadLetterSnapshotForOwner(ownerUserId, deadLetters)) {
      runtime.freezeQueueWrites('storage_failure');
      runtime.triggerStorageFailureEscapeMode();
      throw new Error(`owner-scoped dead-letter 保存失败: ${ownerUserId}`);
    }

    let removed = false;
    const updatedQueue = await this.persistQueueMutationForOwner(
      ownerUserId,
      latestQueue => {
        const nextQueue = latestQueue.filter(item => item.id !== actionId);
        removed = nextQueue.length !== latestQueue.length;
        return nextQueue;
      },
      runtime,
    );

    if (updatedQueue === null) {
      throw new Error(`owner-scoped dead-letter 队列收口保存失败: ${ownerUserId}`);
    }

    if (!removed) {
      this.logger.debug('旧 owner 队列中未找到待移入 dead-letter 的失败 action', {
        ownerUserId,
        actionId,
      });
    }
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
      this.legacyQuarantine.quarantineLegacyQueueForReview(
        legacyItems.map((item) => item.action),
        'legacy-idb-backup',
        runtime,
      );
    });
    return queue ? normalizeQueueForOutbox(queue) : null;
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
      const queueStorageKey = this.getScopedStorageKey(LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY);
      const queue = runtime.pendingActions();
      localStorage.setItem(queueStorageKey, JSON.stringify(queue));
      this.clearLegacyGlobalStorageIfLocalOwner(LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY);
      void this.queueBackup.backupQueue(queue, this.getCurrentOwnerUserId()).catch((error: unknown) => {
        this.logger.warn('owner-scoped 队列已写入 localStorage，但 IndexedDB 备份镜像失败', {
          ownerUserId: this.getCurrentOwnerUserId(),
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
  ): void {
    loadCurrentQueueFromStorageWithDeps(
      restoreGeneration,
      restoreOwnerUserId,
      getCurrentRestoreGeneration,
      runtime,
      this.currentQueueLoad,
    );
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

  loadCurrentDeadLettersFromStorage(runtime: ActionQueueOwnerStorageRuntime): void {
    const ownerUserId = this.getCurrentOwnerUserId();
    let shouldRestoreBackup = true;

    if (typeof localStorage !== 'undefined') {
      try {
        const saved = this.loadScopedOrLegacyStorage(LOCAL_QUEUE_CONFIG.DEAD_LETTER_STORAGE_KEY, runtime);
        if (!saved) {
          this.restoreDeadLetterBackupIntoRuntime(ownerUserId, runtime);
          return;
        }

        const queue = JSON.parse(saved) as DeadLetterItem[];
        if (!Array.isArray(queue)) {
          this.restoreDeadLetterBackupIntoRuntime(ownerUserId, runtime);
          return;
        }

        // §5.6：死信是失败写入的最后一份副本，必须随时可导出/可重放。
        // 超龄条目只提示不删除（等效替用户 dismiss 属于静默丢失），
        // 容量上限 MAX_DEAD_LETTER_SIZE 负责封顶；非法 failedAt 修复为当前时间保留。
        const now = Date.now();
        let repairedCount = 0;
        let agedCount = 0;
        const validQueue = queue.map(item => {
          const failedTime = new Date(item.failedAt).getTime();
          if (!Number.isFinite(failedTime)) {
            repairedCount += 1;
            return { ...item, failedAt: new Date(now).toISOString() };
          }
          if (now - failedTime >= LOCAL_QUEUE_CONFIG.DEAD_LETTER_TTL) {
            agedCount += 1;
          }
          return item;
        });

        runtime.setDeadLetterQueue(validQueue);
        runtime.setDeadLetterSize(validQueue.length);
        runtime.syncSentryContext();
        shouldRestoreBackup = false;

        if (repairedCount > 0) {
          this.saveCurrentDeadLettersToStorage(runtime);
          this.logger.warn(`修复了 ${repairedCount} 个死信条目的非法 failedAt 时间戳`);
        }
        if (agedCount > 0) {
          this.logger.info(`${agedCount} 个死信条目已超过 24 小时未处理，仍保留供导出/重试/放弃`);
        }
      } catch (e) {
        this.logger.warn('Failed to load dead letter queue from storage; IndexedDB backup restore will still be attempted', {
          error: e,
        });
      }
    }

    if (shouldRestoreBackup) {
      this.restoreDeadLetterBackupIntoRuntime(ownerUserId, runtime);
    }
  }

  private restoreDeadLetterBackupIntoRuntime(
    ownerUserId: string,
    runtime: ActionQueueOwnerStorageRuntime,
  ): void {
    void this.queueBackup.restoreDeadLetters(ownerUserId).then(backupDeadLetters => {
      if (!backupDeadLetters || backupDeadLetters.length === 0) {
        return;
      }

      const restoredCount = this.restoreDeadLettersFromBackupItems(ownerUserId, backupDeadLetters, runtime);
      if (restoredCount > 0 && ownerUserId === this.getCurrentOwnerUserId()) {
        this.toast.info('死信队列恢复', `从备用存储恢复了 ${restoredCount} 个失败操作`);
        runtime.clearQueueFreeze();
      }
    }).catch((error: unknown) => {
      this.logger.warn('IndexedDB 死信队列备份恢复失败，保留当前死信队列视图', {
        ownerUserId,
        error,
      });
    });
  }

  restoreDeadLettersFromBackupItems(
    ownerUserId: string,
    items: unknown[],
    runtime: ActionQueueOwnerStorageRuntime,
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

    if (!this.saveDeadLetterSnapshotForOwner(ownerUserId, mergeResult.queue)) {
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
    void this.queueBackup.backupDeadLetters(queue, ownerUserId).then(success => {
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
