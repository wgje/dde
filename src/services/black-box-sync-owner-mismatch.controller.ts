import { AUTH_CONFIG } from '../config/auth.config';
import { type BlackBoxEntry } from '../models/focus';
import { isValidUUID } from '../utils/validation';

type RetryQueueHandler = (entry: BlackBoxEntry) => Promise<boolean>;

export interface BlackBoxSyncOwnerMismatchControllerOptions {
  deleteFromLocal(entryId: string): Promise<void>;
  getRetryQueueHandler?: () => RetryQueueHandler | null | undefined;
  getVisibleEntries(): Map<string, BlackBoxEntry>;
  logger: {
    debug(message: string, context?: unknown): void;
    error(message: string, context?: unknown): void;
    warn(message: string, context?: unknown): void;
  };
  markEntrySyncConflict(entry: BlackBoxEntry): Promise<void>;
  pushToServer(entry: BlackBoxEntry, sessionUserId: string): Promise<unknown>;
  retryQueueHandler?: RetryQueueHandler;
  saveToLocal(entry: BlackBoxEntry): Promise<void>;
  setVisibleEntries(entries: BlackBoxEntry[]): void;
  updateVisibleEntry(entry: BlackBoxEntry): void;
}

export class BlackBoxSyncOwnerMismatchController {
  constructor(private readonly options: BlackBoxSyncOwnerMismatchControllerOptions) {}

  async selfHealOwnerMismatchedEntry(
    entry: BlackBoxEntry,
    sessionUserId: string,
    sourceUserId: string | undefined,
  ): Promise<void> {
    if (
      entry.userId === AUTH_CONFIG.LOCAL_MODE_USER_ID
      && (!sourceUserId || sourceUserId === sessionUserId)
    ) {
      await this.rebrandLocalModeOwnerAndRetry(entry, sessionUserId);
      return;
    }

    if (!entry.userId || !isValidUUID(entry.userId)) {
      await this.deleteInvalidOwnerEntry(entry);
      return;
    }

    await this.markOwnerMismatchConflict(entry);
  }

  async rebrandLocalModeOwnerAndRetry(
    entry: BlackBoxEntry,
    sessionUserId: string,
  ): Promise<void> {
    const rebranded: BlackBoxEntry = {
      ...entry,
      userId: sessionUserId,
      syncStatus: 'pending',
    };

    try {
      await this.options.saveToLocal(rebranded);
    } catch (error) {
      this.options.logger.warn('黑匣子 owner 改写持久化失败，跳过续推，保留下次启动时再恢复', {
        entryId: entry.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const visibleEntry = this.options.getVisibleEntries().get(entry.id);
    if (!visibleEntry || visibleEntry.userId === entry.userId) {
      this.options.updateVisibleEntry(rebranded);
    }

    const retryQueueHandler = this.resolveRetryQueueHandler();
    if (retryQueueHandler) {
      const enqueued = await retryQueueHandler(rebranded);
      if (!enqueued) {
        this.options.logger.warn('黑匣子 owner 改写后 RetryQueue 持久化失败，保留 pending 等待后续恢复', {
          entryId: rebranded.id,
        });
      }
      return;
    }

    void this.options.pushToServer(rebranded, sessionUserId).catch(err => {
      this.options.logger.error(
        '黑匣子 owner 改写后内联续推失败',
        err instanceof Error ? err.message : String(err),
      );
    });
  }

  async deleteInvalidOwnerEntry(entry: BlackBoxEntry): Promise<void> {
    try {
      await this.options.deleteFromLocal(entry.id);
    } catch (error) {
      this.options.logger.debug('黑匣子非法 owner 条目本地删除失败，忽略错误', {
        entryId: entry.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const inMemory = this.options.getVisibleEntries();
    if (inMemory.has(entry.id)) {
      const next = new Map(inMemory);
      next.delete(entry.id);
      this.options.setVisibleEntries(Array.from(next.values()));
    }
  }

  async markOwnerMismatchConflict(entry: BlackBoxEntry): Promise<void> {
    try {
      await this.options.markEntrySyncConflict(entry);
    } catch (error) {
      this.options.logger.warn('黑匣子 owner 冲突标记失败，保留 pending 由后续循环重试', {
        entryId: entry.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private resolveRetryQueueHandler(): RetryQueueHandler | null | undefined {
    return this.options.getRetryQueueHandler?.() ?? this.options.retryQueueHandler;
  }
}
