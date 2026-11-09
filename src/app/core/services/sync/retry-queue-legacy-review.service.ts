import { AUTH_CONFIG } from '../../../../config/auth.config';
import type { BlackBoxEntry } from '../../../../models';
import {
  LEGACY_UNKNOWN_OWNER_USER_ID,
  type LegacyRetryReviewItem,
  type RetryQueueItem,
} from './retry-queue.types';
import { RetryQueueCapacityLayer } from './retry-queue-capacity.service';

export abstract class RetryQueueLegacyReviewLayer extends RetryQueueCapacityLayer {
  protected getLegacyReviewStorageKey(ownerUserId = this.authService.currentUserId() ?? AUTH_CONFIG.LOCAL_MODE_USER_ID): string {
    return `${this.LEGACY_REVIEW_STORAGE_KEY_PREFIX}${ownerUserId}`;
  }

  protected resolveLegacyReviewOwnerUserId(item: RetryQueueItem): string {
    if (item.sourceUserId && item.sourceUserId !== AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      return item.sourceUserId;
    }

    return LEGACY_UNKNOWN_OWNER_USER_ID;
  }

  refreshLegacyReviewCount(): void {
    const ownerUserId = this.authService.currentUserId() ?? AUTH_CONFIG.LOCAL_MODE_USER_ID;
    if (typeof localStorage === 'undefined') {
      this.legacyReviewCount.set(0);
      return;
    }

    try {
      const raw = localStorage.getItem(this.getLegacyReviewStorageKey(ownerUserId));
      if (!raw) {
        this.legacyReviewCount.set(0);
        return;
      }

      const items = JSON.parse(raw) as LegacyRetryReviewItem[];
      this.legacyReviewCount.set(Array.isArray(items) ? items.length : 0);
    } catch {
      this.legacyReviewCount.set(0);
    }
  }

  getLegacyReviewItems(): LegacyRetryReviewItem[] {
    if (typeof localStorage === 'undefined') {
      return [];
    }

    try {
      const raw = localStorage.getItem(this.getLegacyReviewStorageKey());
      if (!raw) {
        return [];
      }

      const items = JSON.parse(raw) as LegacyRetryReviewItem[];
      return Array.isArray(items) ? items : [];
    } catch {
      return [];
    }
  }

  /**
   * 启动时修复历史上已被隔离的黑匣子 pending 条目，避免 UI 永远停留在“待同步”。
   */
  protected repairQuarantinedBlackBoxEntriesFromStorage(): void {
    if (typeof localStorage === 'undefined') {
      return;
    }

    const currentOwnerUserId = this.getCurrentOwnerUserId();
    if (!this.isCloudBackedUserId(currentOwnerUserId)) {
      return;
    }

    const candidateRecords = this.loadLegacyReviewRecordsForRepair([
      currentOwnerUserId,
      LEGACY_UNKNOWN_OWNER_USER_ID,
    ]);

    candidateRecords
      .sort((left, right) => this.getLegacyBlackBoxRepairRank(right) - this.getLegacyBlackBoxRepairRank(left))
      .forEach(record => {
        this.repairBlackBoxConflictForLegacyItem(record.item, currentOwnerUserId);
      });
  }

  protected loadLegacyReviewRecordsForRepair(ownerUserIds: string[]): LegacyRetryReviewItem[] {
    const dedupedByEntryId = new Map<string, LegacyRetryReviewItem>();

    for (const ownerUserId of ownerUserIds) {
      const key = this.getLegacyReviewStorageKey(ownerUserId);
      try {
        const raw = localStorage.getItem(key);
        if (!raw) {
          continue;
        }

        const records = JSON.parse(raw) as LegacyRetryReviewItem[];
        if (!Array.isArray(records)) {
          continue;
        }

        for (const record of records) {
          if (record.item.type !== 'blackbox') {
            continue;
          }

          const entry = record.item.data as BlackBoxEntry;
          if (!entry?.id) {
            continue;
          }

          const existing = dedupedByEntryId.get(entry.id);
          if (!existing || this.getLegacyBlackBoxRepairRank(record) > this.getLegacyBlackBoxRepairRank(existing)) {
            dedupedByEntryId.set(entry.id, record);
          }
        }
      } catch (error) {
        this.logger.debug('扫描 legacy review 黑匣子修复记录失败', {
          key,
          error,
        });
      }
    }

    return Array.from(dedupedByEntryId.values());
  }

  protected getLegacyBlackBoxRepairRank(record: LegacyRetryReviewItem): number {
    const entry = record.item.data as Partial<BlackBoxEntry> | undefined;
    const updatedAtMs = typeof entry?.updatedAt === 'string'
      ? Date.parse(entry.updatedAt)
      : Number.NaN;
    if (Number.isFinite(updatedAtMs)) {
      return updatedAtMs;
    }

    const quarantinedAtMs = Date.parse(record.quarantinedAt);
    return Number.isFinite(quarantinedAtMs) ? quarantinedAtMs : 0;
  }

  protected repairBlackBoxConflictForLegacyItem(
    item: RetryQueueItem,
    expectedUserId: string,
  ): void {
    if (item.type !== 'blackbox') {
      return;
    }

    const entry = item.data as BlackBoxEntry;
    if (!entry?.id || entry.userId !== expectedUserId) {
      return;
    }

    void this.blackBoxSync.markEntrySyncConflict(entry).catch((error: unknown) => {
      this.logger.warn('黑匣子隔离项本地 conflict 修复失败', {
        queueItemId: item.id,
        entryId: entry.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  protected isPendingBlackBoxEntry(value: unknown): value is BlackBoxEntry {
    if (!value || typeof value !== 'object') {
      return false;
    }

    const entry = value as Partial<BlackBoxEntry>;
    return typeof entry.id === 'string'
      && typeof entry.userId === 'string'
      && typeof entry.content === 'string'
      && typeof entry.date === 'string'
      && typeof entry.createdAt === 'string'
      && typeof entry.updatedAt === 'string'
      && typeof entry.isRead === 'boolean'
      && typeof entry.isCompleted === 'boolean'
      && typeof entry.isArchived === 'boolean'
      && (typeof entry.deletedAt === 'string' || entry.deletedAt === null)
      && entry.syncStatus === 'pending';
  }

  protected async markBlackBoxTerminalConflict(item: RetryQueueItem, reason: string): Promise<boolean> {
    if (item.type !== 'blackbox') {
      return true;
    }

    if (!this.isPendingBlackBoxEntry(item.data)) {
      return true;
    }

    try {
      await this.blackBoxSync.markEntrySyncConflict(item.data);
      return true;
    } catch (error) {
      this.logger.warn('黑匣子终止态重试项本地 conflict 修复失败', {
        queueItemId: item.id,
        entryId: item.data.id,
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  protected async persistTerminalRetryEvidence(item: RetryQueueItem, reason: string): Promise<boolean> {
    if (item.type === 'blackbox') {
      return await this.markBlackBoxTerminalConflict(item, reason);
    }

    return this.quarantineLegacyRetryItem(item, reason);
  }

  protected quarantineLegacyRetryItem(item: RetryQueueItem, reason: string): boolean {
    const ownerUserId = this.resolveLegacyReviewOwnerUserId(item);
    const record: LegacyRetryReviewItem = {
      item: { ...item },
      reason,
      quarantinedAt: new Date().toISOString(),
      ownerUserId,
    };

    if (typeof localStorage === 'undefined') {
      this.logger.warn('保存 legacy retry 隔离记录失败：localStorage 不可用', {
        itemId: item.id,
        reason,
      });
      return false;
    }

    const key = this.getLegacyReviewStorageKey(ownerUserId);
    try {
      const existing = localStorage.getItem(key);
      const records = existing ? JSON.parse(existing) as LegacyRetryReviewItem[] : [];
      const deduped = records.filter(entry => entry.item.id !== item.id);
      deduped.push(record);
      localStorage.setItem(key, JSON.stringify(deduped));
      this.refreshLegacyReviewCount();
    } catch (error) {
      this.logger.warn('保存 legacy retry 隔离记录失败', { error, itemId: item.id, reason });
      return false;
    }

    const currentOwnerUserId = this.getCurrentOwnerUserId();
    if (this.isCloudBackedUserId(currentOwnerUserId)) {
      this.repairBlackBoxConflictForLegacyItem(item, currentOwnerUserId);
    }

    this.logger.warn('检测到需人工确认的 legacy retry 项，已隔离保留', {
      itemId: item.id,
      type: item.type,
      operation: item.operation,
      ownerUserId,
      reason,
    });

    if (!this.legacyReviewWarningShown) {
      this.legacyReviewWarningShown = true;
      this.toast.warning('检测到待确认的离线同步数据', '旧版或跨账号的重试项已隔离保留，不会被静默丢弃');
    }

    return true;
  }
}
