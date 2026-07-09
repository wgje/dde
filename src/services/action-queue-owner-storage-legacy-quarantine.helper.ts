import type { ToastService } from './toast.service';
import type { DeadLetterItem, QueuedAction } from './action-queue.types';
import type { ActionQueueOwnerStorageRuntime } from './action-queue-owner-storage.types';
import {
  LEGACY_UNKNOWN_OWNER_USER_ID,
  LOCAL_QUEUE_CONFIG,
  type LegacyActionReviewItem,
  type LegacyQueueSource,
} from './action-queue-storage.helpers';

interface LegacyQuarantineLogger {
  warn(message: string, data?: unknown): void;
}

export interface ActionQueueOwnerStorageLegacyQuarantineOptions {
  getCurrentOwnerUserId: () => string;
  getScopedStorageKey: (baseKey: string, ownerUserId?: string) => string;
  readDeadLetterSnapshotFromLocalStorage: (ownerUserId: string) => DeadLetterItem[];
  readScopedDeadLetterQueueFromStorage: () => DeadLetterItem[];
  saveDeadLetterSnapshotForOwner: (ownerUserId: string, queue: DeadLetterItem[]) => boolean;
  logger: LegacyQuarantineLogger;
  toast: Pick<ToastService, 'warning'>;
}

export class ActionQueueOwnerStorageLegacyQuarantine {
  private readonly LEGACY_REVIEW_STORAGE_KEY_PREFIX = 'nanoflow.action-queue.legacy-review.';
  private legacyReviewWarningShown = false;

  constructor(private readonly options: ActionQueueOwnerStorageLegacyQuarantineOptions) {}

  quarantineLegacyQueueForReview(
    actions: QueuedAction[],
    source: LegacyQueueSource,
    runtime: ActionQueueOwnerStorageRuntime,
  ): void {
    if (typeof localStorage === 'undefined' || actions.length === 0) {
      return;
    }

    const ownerUserId = LEGACY_UNKNOWN_OWNER_USER_ID;
    const key = this.getLegacyReviewStorageKey(ownerUserId);

    try {
      const existing = localStorage.getItem(key);
      const records = existing ? JSON.parse(existing) as LegacyActionReviewItem[] : [];
      const deduped = records.filter(record => !actions.some(action => action.id === record.action.id));
      const capturedAt = new Date().toISOString();
      const nextRecords = [
        ...deduped,
        ...actions.map(action => ({ action, source, capturedAt, ownerUserId } satisfies LegacyActionReviewItem)),
      ];
      localStorage.setItem(key, JSON.stringify(nextRecords));
      this.mergeLegacyDeadLetters(this.buildLegacyQueueDeadLetters(actions, source), ownerUserId, runtime);
      this.warnLegacyReviewOnce(
        '旧版离线队列已隔离保留，不会在当前账号下自动执行',
      );
      this.options.logger.warn('检测到 legacy ActionQueue 数据，已隔离保留待人工确认', {
        ownerUserId,
        source,
        count: actions.length,
      });
    } catch (error) {
      this.options.logger.warn('隔离 legacy ActionQueue 数据失败，已保留原始存储键', { source, error });
    }
  }

  quarantineLegacyDeadLetters(
    deadLetters: DeadLetterItem[],
    runtime: ActionQueueOwnerStorageRuntime,
  ): void {
    if (deadLetters.length === 0) {
      return;
    }

    const ownerUserId = LEGACY_UNKNOWN_OWNER_USER_ID;
    const migratedDeadLetters = deadLetters.map(item => ({
      ...item,
      reason: `旧版全局死信已隔离待确认: ${item.reason}`,
    }));
    this.mergeLegacyDeadLetters(migratedDeadLetters, ownerUserId, runtime);
    this.warnLegacyReviewOnce('旧版离线死信已隔离保留，不会并入当前账号的失败队列');
    this.options.logger.warn('检测到 legacy dead-letter 数据，已隔离到未知 owner 桶', {
      ownerUserId,
      count: deadLetters.length,
    });
  }

  quarantineLegacyQueueStorageValue(
    legacyValue: string,
    baseKey: string,
    runtime: ActionQueueOwnerStorageRuntime,
  ): void {
    try {
      const legacyQueue = JSON.parse(legacyValue) as QueuedAction[];
      if (Array.isArray(legacyQueue) && legacyQueue.length > 0) {
        try {
          this.quarantineLegacyQueueForReview(legacyQueue, 'legacy-global-queue', runtime);
        } finally {
          localStorage.removeItem(baseKey);
        }
      }
    } catch (error) {
      this.options.logger.warn('读取 legacy 全局队列失败，已保留原始存储键', { error });
    }
  }

  quarantineLegacyDeadLetterStorageValue(
    legacyValue: string,
    baseKey: string,
    runtime: ActionQueueOwnerStorageRuntime,
  ): void {
    try {
      const legacyDeadLetters = JSON.parse(legacyValue) as DeadLetterItem[];
      if (Array.isArray(legacyDeadLetters) && legacyDeadLetters.length > 0) {
        try {
          this.quarantineLegacyDeadLetters(legacyDeadLetters, runtime);
        } finally {
          localStorage.removeItem(baseKey);
        }
      }
    } catch (error) {
      this.options.logger.warn('读取 legacy 全局死信失败，已保留原始存储键', { error });
    }
  }

  private getLegacyReviewStorageKey(ownerUserId = this.options.getCurrentOwnerUserId()): string {
    return `${this.LEGACY_REVIEW_STORAGE_KEY_PREFIX}${ownerUserId}`;
  }

  private buildLegacyQueueDeadLetters(
    actions: QueuedAction[],
    source: LegacyQueueSource,
  ): DeadLetterItem[] {
    const failedAt = new Date().toISOString();
    const reason = source === 'legacy-global-queue'
      ? '旧版全局离线队列已隔离待确认'
      : '旧版离线备份队列已隔离待确认';
    return actions.map(action => ({ action, failedAt, reason }));
  }

  private warnLegacyReviewOnce(message: string): void {
    if (this.legacyReviewWarningShown) {
      return;
    }

    this.legacyReviewWarningShown = true;
    this.options.toast.warning('检测到待确认的离线操作', message);
  }

  private mergeLegacyDeadLetters(
    deadLetters: DeadLetterItem[],
    ownerUserId: string,
    runtime: ActionQueueOwnerStorageRuntime,
  ): void {
    if (deadLetters.length === 0) {
      return;
    }

    const currentOwnerUserId = this.options.getCurrentOwnerUserId();
    const existingDeadLetters = ownerUserId === currentOwnerUserId
      ? [
          ...this.options.readScopedDeadLetterQueueFromStorage(),
          ...runtime.deadLetterQueue(),
        ]
      : this.options.readDeadLetterSnapshotFromLocalStorage(ownerUserId);
    const mergedByActionId = new Map<string, DeadLetterItem>();

    for (const item of [...existingDeadLetters, ...deadLetters]) {
      mergedByActionId.set(item.action.id, item);
    }

    const mergedQueue = Array.from(mergedByActionId.values()).slice(-LOCAL_QUEUE_CONFIG.MAX_DEAD_LETTER_SIZE);
    this.options.saveDeadLetterSnapshotForOwner(ownerUserId, mergedQueue);

    if (ownerUserId === currentOwnerUserId) {
      runtime.setDeadLetterQueue(mergedQueue);
      runtime.setDeadLetterSize(mergedQueue.length);
      runtime.syncSentryContext();
    }
  }
}
