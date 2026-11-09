import { offlinePendingCount } from '../state/focus-stores';
import type { SpeechToTextOfflineCacheStore } from './speech-to-text-offline-cache.store';
import { replayOfflineAudioItems } from './speech-to-text-offline-replay';

type SpeechToTextLogger = {
  debug: (scope: string, message: string, data?: unknown) => void;
  error: (scope: string, message: string, data?: unknown) => void;
  warn: (scope: string, message: string, data?: unknown) => void;
};

type BlackBoxCreateResult =
  | { ok: true }
  | { ok: false; error: { message: string } };

type SpeechToTextOfflineReplayControllerOptions = {
  batchSize: number;
  cacheStore: Pick<
    SpeechToTextOfflineCacheStore,
    'countOwnedBy' | 'delete' | 'migrateLegacyOwners' | 'quarantine' | 'readAll'
  >;
  continuationDelayMs: number;
  createBlackBoxEntry: (
    content: string,
    userId: string,
    clientOperationId: string,
  ) => Promise<BlackBoxCreateResult>;
  currentUserId: () => string | null;
  deleteFromCache: (id: string) => Promise<void>;
  ensureReady: () => Promise<void> | void;
  isOnline: () => boolean;
  isRetryableTranscribeError: (error: unknown) => boolean;
  logger: SpeechToTextLogger;
  runTranscribing: <T>(operation: () => Promise<T>) => Promise<T>;
  scheduleContinuation: (reason: string, delayMs: number) => void;
  scheduleRetryableTranscribeReplay: (error: unknown, reason: string) => void;
  toastWarning: (title: string, message: string) => void;
  transcribeBlob: (blob: Blob, expectedOwnerUserId: string | null) => Promise<string>;
  unknownOwnerUserId: string;
  updatePendingCount: () => Promise<void>;
};

export class SpeechToTextOfflineReplayController {
  constructor(private readonly options: SpeechToTextOfflineReplayControllerOptions) {}

  async processOfflineCache(): Promise<{ id: string; text: string }[]> {
    if (!this.options.isOnline()) return [];
    const ready = this.options.ensureReady();
    if (ready) {
      await ready;
    }

    const currentUserId = this.options.currentUserId();
    if (!currentUserId) {
      this.options.logger.warn(
        'SpeechToText',
        'Skipping offline audio replay because no authenticated user is available',
      );
      offlinePendingCount.set(0);
      return [];
    }

    let stoppedByBudget = false;
    let results: { id: string; text: string }[] = [];

    try {
      const replayResult = await this.replayOfflineAudioItems(currentUserId);
      stoppedByBudget = replayResult.stoppedByBudget;
      results = replayResult.results;
    } finally {
      await this.options.updatePendingCount().catch(() => undefined);
    }

    if (stoppedByBudget && this.options.isOnline()) {
      this.options.scheduleContinuation(
        'bounded-replay-continuation',
        this.options.continuationDelayMs,
      );
    }

    return results;
  }

  async deleteFromCache(id: string): Promise<void> {
    await this.options.cacheStore.delete(id);
  }

  async updateOfflinePendingCount(): Promise<void> {
    const count = await this.options.cacheStore
      .countOwnedBy(this.options.currentUserId())
      .catch(() => 0);
    offlinePendingCount.set(count);
  }

  async migrateLegacyOfflineAudioOwners(): Promise<void> {
    const migratedCount = await this.options.cacheStore.migrateLegacyOwners();
    if (migratedCount <= 0) {
      return;
    }

    this.options.logger.warn(
      'SpeechToText',
      'Quarantined legacy offline audio without owner metadata',
      { migratedCount },
    );
    this.options.toastWarning(
      '发现旧版离线录音',
      '为避免转入错误账号，旧缓存录音已被隔离，不会自动转写',
    );
  }

  private async replayOfflineAudioItems(
    replayOwnerUserId: string,
  ): Promise<{ results: { id: string; text: string }[]; stoppedByBudget: boolean }> {
    const items = await this.readOfflineAudioCache();
    return replayOfflineAudioItems({
      items,
      replayOwnerUserId,
      unknownOwnerUserId: this.options.unknownOwnerUserId,
      batchSize: this.options.batchSize,
      isReplayOwnerActive: ownerUserId => this.isReplayOwnerActive(ownerUserId),
      transcribe: blob => this.options.runTranscribing(
        () => this.options.transcribeBlob(blob, replayOwnerUserId),
      ),
      persist: (itemId, text, ownerUserId) =>
        this.persistOfflineTranscription(itemId, text, ownerUserId),
      deleteFromCache: id => this.options.deleteFromCache(id),
      onQuarantinedSkip: itemId => this.logQuarantinedSkip(itemId),
      onForeignOwnerSkip: (itemId, hasOwnerUserId) =>
        this.logForeignOwnerSkip(itemId, hasOwnerUserId),
      onOwnerChangedBeforeItem: ownerUserId =>
        this.logOwnerChangedBeforeItem(ownerUserId),
      onOwnerChangedBeforePersistence: (itemId, ownerUserId) =>
        this.logOwnerChangedBeforePersistence(itemId, ownerUserId),
      onPersistenceFailure: () => undefined,
      onProcessed: itemId => {
        this.options.logger.debug('SpeechToText', `Processed offline audio: ${itemId}`);
      },
      onError: (error, itemId) => this.handleOfflineReplayItemError(error, itemId),
    });
  }

  private logQuarantinedSkip(itemId: string): void {
    this.options.logger.warn(
      'SpeechToText',
      'Skipping quarantined legacy offline audio with unknown owner',
      { itemId },
    );
  }

  private logForeignOwnerSkip(itemId: string, hasOwnerUserId: boolean): void {
    this.options.logger.warn(
      'SpeechToText',
      'Skipping offline audio owned by a different session',
      { itemId, hasOwnerUserId },
    );
  }

  private logOwnerChangedBeforeItem(ownerUserId: string): void {
    this.options.logger.warn(
      'SpeechToText',
      'Aborting offline audio replay because session owner changed mid-run',
      { replayOwnerUserId: ownerUserId },
    );
  }

  private logOwnerChangedBeforePersistence(itemId: string, ownerUserId: string): void {
    this.options.logger.warn(
      'SpeechToText',
      'Discarding transcribed offline audio because session owner changed before persistence',
      { itemId, replayOwnerUserId: ownerUserId },
    );
  }

  private readOfflineAudioCache() {
    return this.options.cacheStore.readAll().catch(error => {
      this.options.logger.error(
        'SpeechToText',
        'Failed to read offline cache',
        error instanceof Error ? error.message : 'Unknown error',
      );
      throw error;
    });
  }

  private async persistOfflineTranscription(
    itemId: string,
    text: string,
    replayOwnerUserId: string,
  ): Promise<boolean> {
    const created = await this.options.createBlackBoxEntry(
      text,
      replayOwnerUserId,
      this.buildOfflineReplayOperationId(itemId),
    );

    if (!created.ok) {
      this.options.logger.warn(
        'SpeechToText',
        'Failed to persist transcribed offline audio, keeping cache entry for retry',
        { itemId, error: created.error.message },
      );
      return false;
    }

    this.options.logger.debug(
      'SpeechToText',
      `Created BlackBox entry from offline audio: "${text.slice(0, 50)}..."`,
    );
    return true;
  }

  private buildOfflineReplayOperationId(itemId: string): string {
    return `speech-to-text-offline-replay:${itemId}`;
  }

  private async handleOfflineReplayItemError(error: unknown, itemId: string): Promise<'continue' | 'stop'> {
    this.options.logger.error(
      'SpeechToText',
      'Failed to process offline item',
      error instanceof Error ? error.message : String(error),
    );

    if (this.options.isRetryableTranscribeError(error)) {
      if (this.options.isOnline()) {
        this.options.scheduleRetryableTranscribeReplay(error, 'offline-replay-retryable-error');
      }
      return 'stop';
    }

    // 永久拒绝（非可重试）的录音必须隔离：留在 owned 集合会按稳定的 IDB key 顺序
    // 反复占据 2 条重放预算，让后面的健康录音永远轮不到，且 15s 续跑循环无限重放同一 blob
    await this.quarantinePermanentlyRejectedItem(itemId, error);
    return 'continue';
  }

  private async quarantinePermanentlyRejectedItem(itemId: string, error: unknown): Promise<void> {
    try {
      const quarantined = await this.options.cacheStore.quarantine(itemId);
      if (!quarantined) {
        return;
      }

      this.options.logger.warn(
        'SpeechToText',
        'Quarantined offline audio after permanent transcribe rejection',
        { itemId, error: error instanceof Error ? error.message : String(error) },
      );
      this.options.toastWarning(
        '录音已隔离',
        '一段离线录音被转写服务拒绝，已停止自动重试；音频仍保留在本地缓存中',
      );
    } catch (quarantineError) {
      this.options.logger.warn(
        'SpeechToText',
        'Failed to quarantine permanently rejected offline audio',
        {
          itemId,
          error: quarantineError instanceof Error ? quarantineError.message : String(quarantineError),
        },
      );
    }
  }

  private isReplayOwnerActive(ownerUserId: string): boolean {
    return this.options.currentUserId() === ownerUserId;
  }
}
