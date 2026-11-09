/**
 * 权限拒绝处理服务
 * 【v5.8】RLS 权限拒绝时数据保全机制
 *
 * 职责：
 * - 捕获 403/401 权限拒绝错误
 * - 隔离被拒数据到独立存储或触发下载
 * - 通知用户数据处理方案（复制/导出/放弃）
 * - 阻止被拒数据从主存储中清除
 */
import { Injectable, inject } from '@angular/core';
import { Task, Connection } from '../models';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { ModalService } from './modal.service';
import { SupabaseError } from '../utils/supabase-error';
import { PERMISSION_DENIED_CONFIG } from '../config/sync.config';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { openIndexedDBAdaptive } from '../utils/indexeddb-open';

export interface PermissionDeniedHandlingContext {
  ownerUserId: string;
  shouldNotify: () => boolean;
}
/**
 * 被拒数据隔离记录
 */
export interface RejectedDataRecord {
  id: string;
  /** null is reserved for the ownerless legacy `main` bucket. */
  ownerUserId?: string | null;
  type: 'task' | 'connection';
  projectId: string;
  data: Task | Connection;
  rejectedAt: string;
  reason: string;
  errorCode: string;
  attemptCount: number;
}

/**
 * 被拒数据隔离存储
 */
export interface RejectedDataStore {
  ownerUserId?: string | null;
  records: RejectedDataRecord[];
  totalSize: number;
  createdAt: string;
  lastUpdatedAt: string;
}

@Injectable({
  providedIn: 'root'
})
export class PermissionDeniedHandlerService {
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly logger = inject(LoggerService).category('PermissionDeniedHandler');
  private readonly toast = inject(ToastService);
  private readonly modal = inject(ModalService);

  /**
   * 处理权限拒绝错误（403/401）
   * 防止被拒数据直接丢弃，提供用户恢复机制
   */
  async handlePermissionDenied(
    error: SupabaseError,
    rejectedData: (Task | Connection)[],
    projectId: string,
    context: PermissionDeniedHandlingContext,
  ): Promise<void> {
    if (!context.ownerUserId.trim()) {
      throw new Error('Permission-denied handling requires an owner user id');
    }
    this.logger.warn('检测到权限拒绝错误', {
      errorCode: error.code,
      dataCount: rejectedData.length,
      projectId,
      message: error.message
    });

    // 1. 隔离被拒数据
    const isolatedRecords = await this.isolateRejectedData(rejectedData, projectId, error, context.ownerUserId);

    // 2. 通知用户并提供操作选项
    if (context.shouldNotify()) {
      await this.notifyUserOfRejectedData(isolatedRecords, error);
    }

    // 3. 上报到 Sentry 用于监控
    this.sentryLazyLoader.captureMessage('Permission denied during data sync', {
      level: 'warning',
      tags: {
        service: 'PermissionDeniedHandler',
        errorCode: String(error.code ?? 'UNKNOWN'),
        dataType: rejectedData[0] ? ('source' in rejectedData[0] ? 'connection' : 'task') : 'unknown'
      },
      extra: {
        dataCount: rejectedData.length,
        projectId,
        reason: error.message
      }
    });
  }

  /**
   * 隔离被拒数据到独立存储
   * 【策略】：使用 IndexedDB 隔离存储（避免 localStorage 5-10MB 限制）
   */
  private async isolateRejectedData(
    rejectedData: (Task | Connection)[],
    projectId: string,
    error: SupabaseError,
    ownerUserId: string,
  ): Promise<RejectedDataRecord[]> {
    const isolatedRecords: RejectedDataRecord[] = rejectedData.map(item => ({
      id: `rejected-${crypto.randomUUID()}`,
      ownerUserId,
      type: 'source' in item ? 'connection' as const : 'task' as const,
      projectId,
      data: item,
      rejectedAt: new Date().toISOString(),
      reason: error.message,
      errorCode: String(error.code ?? 'UNKNOWN'),
      attemptCount: 1
    }));

    // 存储到 IndexedDB（容量更大，支持结构化数据）
    try {
      const store = await this.mutateRejectedDataStore(ownerUserId, current => ({
        ...current,
        records: [...current.records, ...isolatedRecords],
        lastUpdatedAt: new Date().toISOString(),
        totalSize: current.totalSize + isolatedRecords.length,
      }));

      this.logger.info('被拒数据已隔离', {
        count: isolatedRecords.length,
        projectId,
        totalRecords: store.records.length
      });

      return isolatedRecords;
    } catch (e) {
      this.logger.error('隔离被拒数据失败', e);
      // 降级：数据无法隔离，触发紧急下载
      await this.triggerEmergencyDownload(rejectedData, projectId, error);
      throw new Error('Unable to isolate rejected data');
    }
  }

  /**
   * 通知用户权限拒绝并提供操作选项
   */
  private async notifyUserOfRejectedData(
    isolatedRecords: RejectedDataRecord[],
    error: SupabaseError
  ): Promise<void> {
    // 对于 403 Forbidden，提示可能是权限被撤销
    if (error.code === '403') {
      this.toast.error(
        '数据同步被拒绝',
        '您没有权限保存这些更改，可能是因为权限被撤销。已自动隔离数据，您可以复制或导出。',
        {
          duration: 8000,
          action: {
            label: '导出隔离数据',
            onClick: () => this.exportRejectedData(isolatedRecords)
          }
        }
      );
    } else if (error.code === '401') {
      // 401 Unauthorized - 通常是认证过期
      this.toast.error(
        '认证失败',
        '您的认证信息已过期，请重新登录。已自动隔离待同步数据。',
        {
          duration: 8000,
          action: {
            label: '重新登录',
            onClick: () => { window.location.href = '/login'; }
          }
        }
      );
    }
  }

  /**
   * 打开被拒数据查看模态框
   * 提供：复制到剪贴板、导出为文件、放弃数据
   */
  private async openRejectedDataModal(records: RejectedDataRecord[]): Promise<void> {
    // 这里应该打开一个模态框，但由于代码库使用的是自定义 modal.service
    // 我们先通过 toast 提供快速操作
    this.toast.success('', `已隔离 ${records.length} 条数据，可通过以下方式处理：`, {
      duration: 0 // 不自动关闭
    });
  }

  /** Export ownerless legacy data separately; it must never be merged into a user bucket. */
  async exportLegacyRejectedData(): Promise<RejectedDataRecord[]> {
    const store = await this.readRejectedDataStore(null);
    this.downloadJson({
      exportedAt: new Date().toISOString(),
      ownerUserId: null,
      recordCount: store.records.length,
      records: store.records,
    }, `rejected-data-legacy-${Date.now()}.json`);
    return store.records;
  }

  private exportRejectedData(records: RejectedDataRecord[]): void {
    const projectId = records[0]?.projectId ?? 'unknown-project';
    this.downloadJson({
      exportedAt: new Date().toISOString(),
      ownerUserId: records[0]?.ownerUserId ?? null,
      recordCount: records.length,
      records,
    }, `rejected-data-${projectId}-${Date.now()}.json`);

    this.logger.info('已导出被拒数据', { projectId, count: records.length });
  }

  private downloadJson(data: unknown, filename: string): void {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  /**
   * 触发紧急数据下载（隔离存储失败时）
   */
  private async triggerEmergencyDownload(
    rejectedData: (Task | Connection)[],
    projectId: string,
    error: SupabaseError
  ): Promise<void> {
    const data = {
      projectId,
      rejectedAt: new Date().toISOString(),
      reason: error.message,
      errorCode: error.code,
      items: rejectedData
    };

    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: 'application/json'
    });

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `rejected-data-${projectId}-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);

    this.logger.info('已触发数据紧急下载', { projectId, count: rejectedData.length });
  }

  private bucketKey(ownerUserId: string | null): string {
    return ownerUserId === null ? 'main' : `owner:${ownerUserId}`;
  }

  private normalizeStore(value: unknown, ownerUserId: string | null): RejectedDataStore {
    if (!value || typeof value !== 'object') return this.createEmptyStore(ownerUserId);
    const candidate = value as Partial<RejectedDataStore> & { records?: unknown };
    const records = Array.isArray(candidate.records)
      ? candidate.records
        .filter((record): record is RejectedDataRecord => !!record && typeof record === 'object')
        .map(record => ({
          ...record,
          ownerUserId,
        }))
      : [];
    return {
      ownerUserId,
      records,
      totalSize: typeof candidate.totalSize === 'number' ? candidate.totalSize : records.length,
      createdAt: typeof candidate.createdAt === 'string' ? candidate.createdAt : new Date().toISOString(),
      lastUpdatedAt: typeof candidate.lastUpdatedAt === 'string' ? candidate.lastUpdatedAt : new Date().toISOString(),
    };
  }

  private async readRejectedDataStore(ownerUserId: string | null): Promise<RejectedDataStore> {
    const db = await this.openIndexedDB();
    const tx = db.transaction(['rejectedData'], 'readonly');
    const objectStore = tx.objectStore('rejectedData');
    const request = objectStore.get(this.bucketKey(ownerUserId));

    return new Promise((resolve, reject) => {
      let result: RejectedDataStore | undefined;
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error ?? 'IndexedDB read failed')));
      };
      request.onsuccess = () => {
        result = this.normalizeStore(request.result, ownerUserId);
      };
      request.onerror = () => fail(request.error);
      tx.onerror = () => fail(tx.error);
      tx.onabort = () => fail(tx.error ?? new Error('IndexedDB read transaction aborted'));
      tx.oncomplete = () => {
        if (settled) return;
        settled = true;
        resolve(result ?? this.createEmptyStore(ownerUserId));
      };
    });
  }

  private async mutateRejectedDataStore(
    ownerUserId: string,
    updater: (current: RejectedDataStore) => RejectedDataStore,
  ): Promise<RejectedDataStore> {
    const db = await this.openIndexedDB();
    const tx = db.transaction(['rejectedData'], 'readwrite');
    const objectStore = tx.objectStore('rejectedData');
    const key = this.bucketKey(ownerUserId);
    const request = objectStore.get(key);

    return new Promise((resolve, reject) => {
      let nextStore: RejectedDataStore | undefined;
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error ?? 'IndexedDB write failed')));
      };
      request.onerror = () => fail(request.error);
      request.onsuccess = () => {
        try {
          const current = this.normalizeStore(request.result, ownerUserId);
          nextStore = this.normalizeStore(updater(current), ownerUserId);
          objectStore.put(nextStore, key);
        } catch (error) {
          try { tx.abort(); } catch { /* transaction may already be terminal */ }
          fail(error);
        }
      };
      tx.onerror = () => fail(tx.error);
      tx.onabort = () => fail(tx.error ?? new Error('IndexedDB write transaction aborted'));
      tx.oncomplete = () => {
        if (settled) return;
        settled = true;
        resolve(nextStore ?? this.createEmptyStore(ownerUserId));
      };
    });
  }

  /**
   * 打开或初始化 IndexedDB
   */
  private async openIndexedDB(): Promise<IDBDatabase> {
    return openIndexedDBAdaptive({
      dbName: 'NanoFlow',
      targetVersion: 1,
      requiredStores: ['rejectedData'],
      ensureStores: db => {
        if (!db.objectStoreNames.contains('rejectedData')) {
          db.createObjectStore('rejectedData');
        }
      },
    });
  }

  /**
   * 创建空的被拒数据存储
   */
  private createEmptyStore(ownerUserId: string | null): RejectedDataStore {
    return {
      ownerUserId,
      records: [],
      totalSize: 0,
      createdAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString()
    };
  }

  /**
   * 清理过期的被拒数据
   * 【定期调用】在应用启动时清理超过 7 天的记录
   */
  async cleanupExpiredRejectedData(ownerUserId: string): Promise<void> {
    try {
      const retentionTime = PERMISSION_DENIED_CONFIG.REJECTED_DATA_RETENTION;
      const now = Date.now();
      let removedCount = 0;
      await this.mutateRejectedDataStore(ownerUserId, store => {
        const filtered = store.records.filter(record => {
          const recordTime = new Date(record.rejectedAt).getTime();
          return now - recordTime < retentionTime;
        });
        removedCount = store.records.length - filtered.length;
        return removedCount === 0
          ? store
          : {
            ...store,
            records: filtered,
            totalSize: filtered.length,
            lastUpdatedAt: new Date().toISOString(),
          };
      });

      if (removedCount > 0) this.logger.info('已清理过期被拒数据', { ownerUserId, removedCount });
    } catch (e) {
      this.logger.error('清理过期被拒数据失败', e);
    }
  }

  /**
   * 获取所有被拒数据
   * 【用于调试和数据恢复】
   */
  async getAllRejectedData(ownerUserId: string): Promise<RejectedDataRecord[]> {
    const store = await this.readRejectedDataStore(ownerUserId);
    return store.records;
  }

  /**
   * 清除指定项目的被拒数据
   * 【用于用户手动清理】
   */
  async clearRejectedDataForProject(ownerUserId: string, projectId: string): Promise<number> {
    let removedCount = 0;
    await this.mutateRejectedDataStore(ownerUserId, store => {
      const records = store.records.filter(record => record.projectId !== projectId);
      removedCount = store.records.length - records.length;
      return removedCount === 0
        ? store
        : {
          ...store,
          records,
          totalSize: records.length,
          lastUpdatedAt: new Date().toISOString(),
        };
    });

    this.logger.info('已清除项目的被拒数据', { ownerUserId, projectId, removedCount });

    return removedCount;
  }
}
