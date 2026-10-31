import type { BlackBoxEntry } from '../../../../models';
import type {
  RetryQueueItem,
  RetryQueueItemProcessResult,
  RetryQueueSliceRuntime,
} from './retry-queue.types';

export interface RetryQueueRunnerSuccessControllerOptions {
  getRefreshedItemDuringProcessing: (item: RetryQueueItem) => RetryQueueItem | null;
  wasItemRefreshedDuringProcessing: (item: RetryQueueItem) => boolean;
  buildBlackBoxRetryDataFingerprint: (entry: BlackBoxEntry) => string;
  recordCompletedOperation: (item: RetryQueueItem) => void;
  recordCircuitSuccess: () => void;
  removeItemsDurably: (itemIds: Set<string>) => Promise<boolean>;
  debug: (message: string, data?: unknown) => void;
}

export class RetryQueueRunnerSuccessController {
  constructor(private readonly options: RetryQueueRunnerSuccessControllerOptions) {}

  async handleSuccessfulReplay(
    runtime: RetryQueueSliceRuntime,
    item: RetryQueueItem,
  ): Promise<RetryQueueItemProcessResult> {
    if (item.type === 'project') return await this.handleSuccessfulProjectReplay(runtime, item);

    const refreshedItem = this.options.getRefreshedItemDuringProcessing(item);
    if (refreshedItem) {
      if (this.isSameBlackBoxReplay(item, refreshedItem)) {
        this.recordSuccessfulItem(runtime, item);
        return 'continue';
      }
      this.logRefreshedItem(item);
      this.options.recordCircuitSuccess();
      return 'continue';
    }

    this.recordSuccessfulItem(runtime, item);
    return 'continue';
  }

  async handleSuccessfulProjectReplay(
    runtime: RetryQueueSliceRuntime,
    item: RetryQueueItem,
  ): Promise<RetryQueueItemProcessResult> {
    if (this.options.wasItemRefreshedDuringProcessing(item)) {
      this.logRefreshedItem(item);
      this.options.recordCircuitSuccess();
      return 'continue';
    }

    this.options.recordCompletedOperation(item);
    if (!await this.options.removeItemsDurably(new Set([item.id]))) {
      runtime.stoppedByBudget = true;
      return 'break';
    }
    runtime.successfulReplayCount++;
    this.options.recordCircuitSuccess();
    return 'continue';
  }

  private isSameBlackBoxReplay(item: RetryQueueItem, refreshedItem: RetryQueueItem): boolean {
    return item.type === 'blackbox'
      && refreshedItem.type === 'blackbox'
      && this.options.buildBlackBoxRetryDataFingerprint(refreshedItem.data as BlackBoxEntry)
        === this.options.buildBlackBoxRetryDataFingerprint(item.data as BlackBoxEntry);
  }

  private recordSuccessfulItem(runtime: RetryQueueSliceRuntime, item: RetryQueueItem): void {
    this.options.recordCompletedOperation(item);
    runtime.successfulReplayCount++;
    runtime.processedIds.add(item.id);
    this.options.recordCircuitSuccess();
  }

  private logRefreshedItem(item: RetryQueueItem): void {
    this.options.debug('重试项处理期间已刷新，保留最新快照等待下一轮回放', {
      type: item.type,
      queueItemId: item.id,
      dataId: item.data.id,
    });
  }
}
