/**
 * RetryQueueService - 重试队列管理
 *
 * 公开 Angular 服务入口。具体职责按层下切到同目录的 queue item、capacity、legacy review、
 * circuit breaker、runner 和 storage 层，保持单实例状态与原公开 API 不变。
 */
import { Injectable } from '@angular/core';
import { RetryQueueStorageLayer } from './retry-queue-storage.service';

export type {
  LegacyRetryReviewItem,
  RetryOperationHandler,
  RetryQueueItem,
  RetryQueueLastFailure,
  RetryQueueSliceOptions,
  RetryQueueSliceResult,
  TaskDeleteBaseUpdatedAtMap,
  RetryableEntityType,
  RetryableOperation,
} from './retry-queue.types';

@Injectable({
  providedIn: 'root'
})
export class RetryQueueService extends RetryQueueStorageLayer {
  constructor() {
    super();

    // 初始化时加载队列
    void this.initializeStorageLoad();
    
    // 【P2-19 修复】恢复熔断器状态
    this.loadCircuitState();
    this.refreshLegacyReviewCount();
    this.repairQuarantinedBlackBoxEntriesFromStorage();
    
    this.destroyRef.onDestroy(() => {
      this.lifecycleClosed = true;
      this.stopLoop();
      // 销毁时立即刷新存储（跳过防抖）
      if (this.saveDebounceTimer !== null) {
        clearTimeout(this.saveDebounceTimer);
        this.saveDebounceTimer = null;
      }
      void this.flushStorageOnDestroy();
    });
  }

  private async flushStorageOnDestroy(): Promise<void> {
    try {
      await this.saveToStorageImmediate();
    } catch (error) {
      this.logger.warn('RetryQueue 销毁持久化失败，继续关闭存储连接', error);
    }

    try {
      await this.closeStorageConnections();
    } catch (error) {
      this.logger.warn('RetryQueue 销毁关闭存储连接失败', error);
    }
  }

  private async initializeStorageLoad(): Promise<void> {
    const loadToken = this.captureStorageLoadToken();

    try {
      await this.initDb();
      if (!this.isStorageLoadTokenCurrent(loadToken)) {
        this.logStaleStorageLoad(loadToken, 'constructor:init-db');
        return;
      }

      await this.loadFromStorage();
    } catch (error) {
      this.logger.warn('RetryQueue 初始化加载失败，已跳过本次启动加载', error);
    }
  }
  
  async closeStorageConnections(): Promise<void> {
    if (this.saveDebounceTimer !== null) {
      clearTimeout(this.saveDebounceTimer);
      this.saveDebounceTimer = null;
    }

    const pendingDbInit = this.dbInitPromise;
    this.dbInitPromise = null;

    if (pendingDbInit) {
      try {
        const pendingDb = await pendingDbInit;
        pendingDb?.close();
      } catch {
        // 忽略打开失败：此时不存在可关闭连接
      }
    }

    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  protected override async initDb(): Promise<IDBDatabase | null> {
    return await super.initDb();
  }

  protected override async loadFromStorage(): Promise<void> {
    await super.loadFromStorage();
  }

  protected override saveToStorage(): void {
    super.saveToStorage();
  }

  protected override async saveToStorageImmediate(): Promise<boolean> {
    return await super.saveToStorageImmediate();
  }
}
