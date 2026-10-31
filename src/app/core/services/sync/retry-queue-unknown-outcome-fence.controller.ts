import {
  clearRetryQueuePendingUnknownOutcomeFence,
  createRetryQueuePendingUnknownOutcomeFence,
  hasMalformedRetryQueuePendingUnknownOutcomeFenceForOwner,
  matchesRetryQueuePendingUnknownOutcomeFence,
  readRetryQueuePendingUnknownOutcomeFences,
  RETRY_QUEUE_UNKNOWN_OUTCOME_STORAGE_PRESSURE_REASON,
  writeRetryQueuePendingUnknownOutcomeFence,
  type RetryQueuePendingUnknownOutcomeFence,
} from './retry-queue-pending-unknown-outcome-fence';
import { markRetryQueueItemUnknownOutcome } from './retry-queue-unknown-outcome.helpers';
import type { RetryOperationHandler, RetryQueueItem, RetryQueueSliceRuntime } from './retry-queue.types';

export interface RetryQueueUnknownOutcomeFenceControllerOptions {
  getCurrentOwnerUserId: () => string;
  getQueue: () => RetryQueueItem[];
  getOperationHandler: () => RetryOperationHandler | null;
  getStorageKey: () => string;
  touchQueueState: () => void;
  saveToStorageImmediate: () => Promise<boolean>;
  saveToLocalStorage: () => boolean;
  isLocalStorageWritable: () => boolean;
  enterPressureMode: (reason: string) => void;
  clearPressureMode: () => void;
  getQueuePressureReason: () => string | null;
  tryRecoverStoragePressure: () => void;
  warn: (message: string, data?: unknown) => void;
  info: (message: string, data?: unknown) => void;
}

export class RetryQueueUnknownOutcomeFenceController {
  constructor(private readonly options: RetryQueueUnknownOutcomeFenceControllerOptions) {}

  shouldPauseSliceForStorageUnknownOutcome(): boolean {
    if (this.options.getQueuePressureReason() !== RETRY_QUEUE_UNKNOWN_OUTCOME_STORAGE_PRESSURE_REASON) {
      return false;
    }
    this.options.tryRecoverStoragePressure();
    return this.options.getQueuePressureReason() === RETRY_QUEUE_UNKNOWN_OUTCOME_STORAGE_PRESSURE_REASON;
  }

  async markUnknownOutcomeAndPersist(item: RetryQueueItem, error: unknown): Promise<boolean> {
    return await markRetryQueueItemUnknownOutcome(item, error, () => {
      const fence = createRetryQueuePendingUnknownOutcomeFence(
        item,
        this.options.getCurrentOwnerUserId(),
      );
      if (!writeRetryQueuePendingUnknownOutcomeFence(fence)) {
        this.options.warn('RetryQueue unknown-outcome fence 无法写入，当前实例仍保持 fail closed', {
          ownerUserId: this.options.getCurrentOwnerUserId(),
          queueItemId: item.id,
          operationId: item.operationId,
        });
      }
      return this.persistStateChange(item, fence);
    });
  }

  async deferServerPressureRetry(
    runtime: RetryQueueSliceRuntime,
    item: RetryQueueItem,
    error?: unknown,
  ): Promise<'break' | 'deferred-server-pressure'> {
    const ownerUserId = this.options.getCurrentOwnerUserId();
    let persisted = false;
    try {
      persisted = await this.markUnknownOutcomeAndPersist(item, error);
    } catch (persistError) {
      this.options.warn('unknown-outcome 标记持久化异常，仅保留当前内存副本', persistError);
    }
    if (!persisted) {
      runtime.stoppedByBudget = true;
      if (this.options.getCurrentOwnerUserId() === ownerUserId) {
        this.options.enterPressureMode(RETRY_QUEUE_UNKNOWN_OUTCOME_STORAGE_PRESSURE_REASON);
        this.options.warn('unknown-outcome 标记未能持久化，停止 RetryQueue 重放并等待存储恢复', {
          type: item.type,
          id: item.data.id,
          operationId: item.operationId,
        });
      } else {
        this.options.warn('owner 切换期间 unknown-outcome 持久化未完成，保留原 owner fence', {
          ownerUserId,
          queueItemId: item.id,
          operationId: item.operationId,
        });
      }
      return 'break';
    }
    this.options.info('服务端限流或暂时不可用，停止本轮重试切片并保留队列项等待后台退避', {
      type: item.type,
      id: item.data.id,
    });
    return 'deferred-server-pressure';
  }

  async persistStateChange(
    item?: RetryQueueItem,
    expectedUnknownOutcomeFence?: RetryQueuePendingUnknownOutcomeFence,
  ): Promise<boolean> {
    this.options.touchQueueState();
    try {
      const persisted = await this.options.saveToStorageImmediate();
      if (!persisted) return false;

      if (expectedUnknownOutcomeFence && !this.hasPersistedUnknownOutcomeMarker(expectedUnknownOutcomeFence)) {
        if (expectedUnknownOutcomeFence.ownerUserId === this.options.getCurrentOwnerUserId()) {
          this.options.enterPressureMode(RETRY_QUEUE_UNKNOWN_OUTCOME_STORAGE_PRESSURE_REASON);
        }
        this.options.warn('RetryQueue unknown-outcome marker was not read back for the same operation; preserving fence', {
          ownerUserId: expectedUnknownOutcomeFence.ownerUserId,
          queueItemId: expectedUnknownOutcomeFence.queueItemId,
          operationId: expectedUnknownOutcomeFence.operationId,
        });
        return false;
      }

      if (this.options.getQueuePressureReason() === RETRY_QUEUE_UNKNOWN_OUTCOME_STORAGE_PRESSURE_REASON) {
        this.options.clearPressureMode();
      }
      if (expectedUnknownOutcomeFence) {
        clearRetryQueuePendingUnknownOutcomeFence(expectedUnknownOutcomeFence);
      } else if (item) {
        this.clearFenceForItem(item);
      }
      return true;
    } catch (error) {
      this.options.warn('RetryQueue unknown-outcome 标记持久化异常，停止本轮重放', error);
      return false;
    }
  }

  restoreAfterStorageLoad(): void {
    const ownerUserId = this.options.getCurrentOwnerUserId();
    const snapshot = readRetryQueuePendingUnknownOutcomeFences();
    if (hasMalformedRetryQueuePendingUnknownOutcomeFenceForOwner(snapshot, ownerUserId)) {
      this.options.enterPressureMode(RETRY_QUEUE_UNKNOWN_OUTCOME_STORAGE_PRESSURE_REASON);
      this.options.warn('RetryQueue unknown-outcome fence 损坏，阻止当前 owner 重放', { ownerUserId });
      return;
    }

    const uniqueRecords = this.uniqueOwnerRecords(ownerUserId, snapshot.records);
    const [record] = uniqueRecords.values();
    if (!record) return;
    if (uniqueRecords.size !== 1) {
      this.options.enterPressureMode(RETRY_QUEUE_UNKNOWN_OUTCOME_STORAGE_PRESSURE_REASON);
      this.options.warn('RetryQueue unknown-outcome fence 数量异常，阻止当前 owner 重放', {
        ownerUserId,
        count: uniqueRecords.size,
      });
      return;
    }

    const item = this.options.getQueue().find(candidate =>
      matchesRetryQueuePendingUnknownOutcomeFence(candidate, record.fence));
    if (!item) {
      this.options.enterPressureMode(RETRY_QUEUE_UNKNOWN_OUTCOME_STORAGE_PRESSURE_REASON);
      this.options.warn('RetryQueue unknown-outcome fence 与已加载队列身份不匹配，阻止重放', {
        ownerUserId,
        queueItemId: record.fence.queueItemId,
        operationId: record.fence.operationId,
      });
      return;
    }

    if (item.lastFailure?.remoteOutcome === 'unknown') {
      clearRetryQueuePendingUnknownOutcomeFence(record.fence);
      return;
    }

    item.lastFailure = record.fence.lastFailure;
    this.options.touchQueueState();
    this.options.enterPressureMode(RETRY_QUEUE_UNKNOWN_OUTCOME_STORAGE_PRESSURE_REASON);
    this.options.warn('RetryQueue unknown-outcome fence 已恢复，等待持久化确认后再对账', {
      ownerUserId,
      queueItemId: item.id,
      operationId: item.operationId,
    });
  }

  recoverStoragePressure(): void {
    const ownerUserId = this.options.getCurrentOwnerUserId();
    const snapshot = readRetryQueuePendingUnknownOutcomeFences();
    if (hasMalformedRetryQueuePendingUnknownOutcomeFenceForOwner(snapshot, ownerUserId)) return;
    const uniqueRecords = this.uniqueOwnerRecords(ownerUserId, snapshot.records);
    const [record] = uniqueRecords.values();
    if (!record || uniqueRecords.size !== 1) return;

    const item = this.options.getQueue().find(candidate =>
      matchesRetryQueuePendingUnknownOutcomeFence(candidate, record.fence));
    if (!item
      || item.lastFailure?.remoteOutcome !== 'unknown'
      || !this.options.getOperationHandler()?.reconcileUnknownOutcome
      || !this.options.isLocalStorageWritable()) return;
    if (!this.options.saveToLocalStorage()) {
      this.options.enterPressureMode(RETRY_QUEUE_UNKNOWN_OUTCOME_STORAGE_PRESSURE_REASON);
      return;
    }

    if (!this.hasPersistedUnknownOutcomeMarker(record.fence)) {
      this.options.enterPressureMode(RETRY_QUEUE_UNKNOWN_OUTCOME_STORAGE_PRESSURE_REASON);
      return;
    }

    clearRetryQueuePendingUnknownOutcomeFence(record.fence);
    this.options.clearPressureMode();
    this.options.info('RetryQueue unknown-outcome marker 已写回并读验，恢复对账', {
      ownerUserId,
      queueItemId: item.id,
      operationId: item.operationId,
    });
  }

  clearProcessedFences(
    runtime: RetryQueueSliceRuntime,
    hasPersistedItem: (itemId: string) => boolean,
  ): void {
    for (const item of runtime.itemsSnapshot) {
      if (!runtime.processedIds.has(item.id)) {
        continue;
      }
      const presentInQueue = this.options.getQueue().some(current => current.id === item.id);
      if (presentInQueue && hasPersistedItem(item.id)) {
        continue;
      }
      this.clearFenceForItem(item);
    }
  }

  private uniqueOwnerRecords(ownerUserId: string, records: ReturnType<
    typeof readRetryQueuePendingUnknownOutcomeFences
  >['records']): Map<string, (typeof records)[number]> {
    const uniqueRecords = new Map<string, (typeof records)[number]>();
    for (const record of records) {
      if (record.fence.ownerUserId !== ownerUserId) continue;
      const key = `${record.fence.queueItemId}:${record.fence.operationId}`;
      const existing = uniqueRecords.get(key);
      if (!existing || existing.fence.lastFailure.recordedAt < record.fence.lastFailure.recordedAt) {
        uniqueRecords.set(key, record);
      }
    }
    return uniqueRecords;
  }

  private hasPersistedUnknownOutcomeMarker(
    fence: RetryQueuePendingUnknownOutcomeFence,
  ): boolean {
    if (fence.ownerUserId !== this.options.getCurrentOwnerUserId()) return false;

    try {
      const raw = localStorage.getItem(this.options.getStorageKey());
      const envelope = raw ? JSON.parse(raw) as { items?: RetryQueueItem[] } : null;
      return Array.isArray(envelope?.items)
        && envelope.items.some(item =>
          matchesRetryQueuePendingUnknownOutcomeFence(item, fence)
          && item.lastFailure?.remoteOutcome === 'unknown');
    } catch {
      return false;
    }
  }

  private clearFenceForItem(item: RetryQueueItem): void {
    clearRetryQueuePendingUnknownOutcomeFence(
      createRetryQueuePendingUnknownOutcomeFence(item, this.options.getCurrentOwnerUserId()),
    );
  }
}
