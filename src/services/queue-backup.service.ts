/**
 * QueueBackupService — IndexedDB 队列备份服务
 *
 * 职责：
 * - IndexedDB 备份数据库管理
 * - 队列备份写入与恢复
 * - Legacy 备份迁移处理
 *
 * 从 ActionQueueStorageService 抽离（2026-05-13）
 */
import { Injectable, inject } from '@angular/core';
import { LoggerService } from './logger.service';
import type { DeadLetterItem, QueuedAction } from './action-queue.types';

export const QUEUE_BACKUP_DB_NAME = 'nanoflow-queue-backup';
export const QUEUE_BACKUP_DB_VERSION = 1;
export const QUEUE_BACKUP_STORE_NAME = 'queue-backup';

/**
 * 队列备份记录
 */
export interface QueueBackupRecord {
  id: string;
  ownerUserId: string;
  actions: QueuedAction[];
  savedAt: string;
}

export interface DeadLetterBackupRecord {
  id: string;
  ownerUserId: string;
  deadLetters: DeadLetterItem[];
  savedAt: string;
}

export interface QueueBackupUpdateContext {
  /** True when the owner already has an IndexedDB record, even if that record contains an empty queue. */
  recordFound: boolean;
}

/**
 * Legacy 队列审查条目
 */
export interface LegacyQueueReviewItem {
  action: QueuedAction;
  source: 'legacy-global-queue' | 'legacy-idb-backup';
  capturedAt: string;
  ownerUserId: string;
}

const LEGACY_QUEUE_BACKUP_RECORD_ID = 'nanoflow-queue-backup-v1';
const LEGACY_UNKNOWN_OWNER_USER_ID = '__legacy_unknown__';

@Injectable({ providedIn: 'root' })
export class QueueBackupService {
  private readonly logger = inject(LoggerService).category('QueueBackup');

  /**
   * 生成用户专属的备份记录 ID
   */
  getQueueBackupRecordId(ownerUserId: string): string {
    return `queue-backup:${ownerUserId}`;
  }

  getDeadLetterBackupRecordId(ownerUserId: string): string {
    return `dead-letter-backup:${ownerUserId}`;
  }

  /**
   * 备份队列到 IndexedDB
   */
  async backupQueue(queue: QueuedAction[], ownerUserId: string): Promise<boolean> {
    if (typeof indexedDB === 'undefined') return false;

    try {
      const recordId = this.getQueueBackupRecordId(ownerUserId);
      const db = await this.openQueueBackupDb();
      return new Promise((resolve) => {
        const transaction = db.transaction([QUEUE_BACKUP_STORE_NAME], 'readwrite');
        const store = transaction.objectStore(QUEUE_BACKUP_STORE_NAME);
        const record: QueueBackupRecord = {
          id: recordId,
          ownerUserId,
          actions: queue,
          savedAt: new Date().toISOString(),
        };
        const putRequest = store.put(record);

        putRequest.onerror = () => {
          this.logger.error('IndexedDB 写入失败', putRequest.error);
        };

        transaction.oncomplete = () => {
          db.close();
          this.logger.info('队列已备份到 IndexedDB', { count: queue.length, ownerUserId });
          resolve(true);
        };

        transaction.onerror = () => {
          db.close();
          this.logger.error('IndexedDB 写入事务失败', transaction.error ?? putRequest.error);
          resolve(false);
        };

        transaction.onabort = () => {
          db.close();
          this.logger.error('IndexedDB 写入事务中止', transaction.error ?? putRequest.error);
          resolve(false);
        };
      });
    } catch (e) {
      this.logger.error('IndexedDB 备份异常', e);
      return false;
    }
  }

  async backupDeadLetters(deadLetters: DeadLetterItem[], ownerUserId: string): Promise<boolean> {
    if (typeof indexedDB === 'undefined') return false;

    try {
      const recordId = this.getDeadLetterBackupRecordId(ownerUserId);
      const db = await this.openQueueBackupDb();
      return new Promise((resolve) => {
        const transaction = db.transaction([QUEUE_BACKUP_STORE_NAME], 'readwrite');
        const store = transaction.objectStore(QUEUE_BACKUP_STORE_NAME);
        const record: DeadLetterBackupRecord = {
          id: recordId,
          ownerUserId,
          deadLetters,
          savedAt: new Date().toISOString(),
        };
        const putRequest = store.put(record);

        putRequest.onerror = () => {
          this.logger.error('IndexedDB 死信队列写入失败', putRequest.error);
        };

        transaction.oncomplete = () => {
          db.close();
          this.logger.info('死信队列已备份到 IndexedDB', { count: deadLetters.length, ownerUserId });
          resolve(true);
        };

        transaction.onerror = () => {
          db.close();
          this.logger.error('IndexedDB 死信队列写入事务失败', transaction.error ?? putRequest.error);
          resolve(false);
        };

        transaction.onabort = () => {
          db.close();
          this.logger.error('IndexedDB 死信队列写入事务中止', transaction.error ?? putRequest.error);
          resolve(false);
        };
      });
    } catch (e) {
      this.logger.error('IndexedDB 死信队列备份异常', e);
      return false;
    }
  }

  /**
   * 在同一个 IndexedDB readwrite transaction 中更新 owner 队列。
   *
   * 这条路径用于 Outbox 的 read-modify-write 场景：追加、合并、收口都必须基于
   * 最新持久化队列计算，不能先 restore 再 backup，否则多标签页或并发操作会互相覆盖。
   */
  async updateQueue(
    ownerUserId: string,
    updater: (queue: QueuedAction[], context: QueueBackupUpdateContext) => QueuedAction[],
  ): Promise<QueuedAction[] | null> {
    if (typeof indexedDB === 'undefined') return null;

    let updatedQueue: QueuedAction[] | null = null;
    try {
      const recordId = this.getQueueBackupRecordId(ownerUserId);
      const db = await this.openQueueBackupDb();
      updatedQueue = await this.updateQueueRecord(db, recordId, ownerUserId, updater);
    } catch (e) {
      this.logger.error('IndexedDB 原子更新异常', e);
    }
    return updatedQueue;
  }

  private updateQueueRecord(
    db: IDBDatabase,
    recordId: string,
    ownerUserId: string,
    updater: (queue: QueuedAction[], context: QueueBackupUpdateContext) => QueuedAction[],
  ): Promise<QueuedAction[] | null> {
    return new Promise((resolve) => {
      let nextActions: QueuedAction[] | null = null;
      const transaction = db.transaction([QUEUE_BACKUP_STORE_NAME], 'readwrite');
      const store = transaction.objectStore(QUEUE_BACKUP_STORE_NAME);
      const getRequest = store.get(recordId);

      getRequest.onsuccess = () => {
        nextActions = this.writeUpdatedQueueRecord(
          getRequest.result as QueueBackupRecord | undefined,
          store,
          transaction,
          recordId,
          ownerUserId,
          updater,
        );
      };
      getRequest.onerror = () => this.abortFailedQueueRead(transaction, getRequest.error);
      transaction.oncomplete = () => this.completeQueueUpdate(db, nextActions, ownerUserId, resolve);
      transaction.onerror = () => this.failQueueUpdate(db, transaction.error, resolve);
      transaction.onabort = () => this.abortQueueUpdate(db, transaction.error, resolve);
    });
  }

  private writeUpdatedQueueRecord(
    existingRecord: QueueBackupRecord | undefined,
    store: IDBObjectStore,
    transaction: IDBTransaction,
    recordId: string,
    ownerUserId: string,
    updater: (queue: QueuedAction[], context: QueueBackupUpdateContext) => QueuedAction[],
  ): QueuedAction[] | null {
    const currentActions = Array.isArray(existingRecord?.actions) ? existingRecord.actions : [];
    const context: QueueBackupUpdateContext = { recordFound: existingRecord !== undefined };
    let nextActions: QueuedAction[] | null = null;
    try {
      nextActions = updater(currentActions, context);
      store.put({
        id: recordId,
        ownerUserId,
        actions: nextActions,
        savedAt: new Date().toISOString(),
      } satisfies QueueBackupRecord);
      return nextActions;
    } catch (error) {
      this.logger.error('IndexedDB 原子更新 updater 失败', error);
      transaction.abort();
    }
    return nextActions;
  }

  private abortFailedQueueRead(transaction: IDBTransaction, error: unknown): void {
    this.logger.error('IndexedDB 原子更新读取失败', error);
    transaction.abort();
  }

  private completeQueueUpdate(
    db: IDBDatabase,
    nextActions: QueuedAction[] | null,
    ownerUserId: string,
    resolve: (queue: QueuedAction[] | null) => void,
  ): void {
    db.close();
    this.logger.info('队列已原子更新到 IndexedDB', {
      count: nextActions?.length ?? 0,
      ownerUserId,
    });
    resolve(nextActions);
  }

  private failQueueUpdate(
    db: IDBDatabase,
    error: unknown,
    resolve: (queue: QueuedAction[] | null) => void,
  ): void {
    db.close();
    this.logger.error('IndexedDB 原子更新事务失败', error);
    resolve(null);
  }

  private abortQueueUpdate(
    db: IDBDatabase,
    error: unknown,
    resolve: (queue: QueuedAction[] | null) => void,
  ): void {
    db.close();
    this.logger.error('IndexedDB 原子更新事务中止', error);
    resolve(null);
  }

  /**
   * 从 IndexedDB 恢复队列
   * 优先恢复当前用户的备份，若无则检查 legacy 备份
   *
   * @returns 恢复的队列数据；若无备份或读取失败返回 null
   *          legacy 备份会被隔离到审查队列，不直接返回
   */
  async restoreQueue(
    ownerUserId: string,
    onLegacyFound?: (items: LegacyQueueReviewItem[]) => void
  ): Promise<QueuedAction[] | null> {
    if (typeof indexedDB === 'undefined') return null;

    try {
      const recordId = this.getQueueBackupRecordId(ownerUserId);
      const db = await this.openQueueBackupDb();

      return new Promise((resolve) => {
        const transaction = db.transaction([QUEUE_BACKUP_STORE_NAME], 'readonly');
        const store = transaction.objectStore(QUEUE_BACKUP_STORE_NAME);
        const request = store.get(recordId);

        request.onsuccess = () => {
          const data = request.result as QueueBackupRecord | undefined;
          if (this.resolveCurrentUserBackup(data, db, resolve)) return;
          this.resolveLegacyBackup(store, db, resolve, onLegacyFound);
        };

        request.onerror = () => {
          db.close();
          this.logger.warn('从 IndexedDB 读取备份失败', request.error);
          resolve(null);
        };
      });
    } catch (e) {
      this.logger.warn('IndexedDB 恢复异常', e);
    }
    return null;
  }

  async restoreDeadLetters(ownerUserId: string): Promise<DeadLetterItem[] | null> {
    if (typeof indexedDB === 'undefined') return null;

    try {
      const recordId = this.getDeadLetterBackupRecordId(ownerUserId);
      const db = await this.openQueueBackupDb();

      return new Promise((resolve) => {
        const transaction = db.transaction([QUEUE_BACKUP_STORE_NAME], 'readonly');
        const store = transaction.objectStore(QUEUE_BACKUP_STORE_NAME);
        const request = store.get(recordId);

        request.onsuccess = () => {
          const data = request.result as DeadLetterBackupRecord | undefined;
          db.close();
          if (!Array.isArray(data?.deadLetters)) {
            resolve(null);
            return;
          }

          this.logger.info('从 IndexedDB 恢复死信队列备份', {
            count: data.deadLetters.length,
            savedAt: data.savedAt,
          });
          resolve(data.deadLetters);
        };

        request.onerror = () => {
          db.close();
          this.logger.warn('从 IndexedDB 读取死信队列备份失败', request.error);
          resolve(null);
        };
      });
    } catch (e) {
      this.logger.warn('IndexedDB 死信队列恢复异常', e);
    }
    return null;
  }

  private resolveCurrentUserBackup(
    data: QueueBackupRecord | undefined,
    db: IDBDatabase,
    resolve: (queue: QueuedAction[] | null) => void,
  ): boolean {
    if (!data?.actions) return false;

    db.close();
    this.logger.info('从 IndexedDB 恢复队列备份', {
      count: data.actions.length,
      savedAt: data.savedAt,
    });
    resolve(data.actions);
    return true;
  }

  private resolveLegacyBackup(
    store: IDBObjectStore,
    db: IDBDatabase,
    resolve: (queue: QueuedAction[] | null) => void,
    onLegacyFound?: (items: LegacyQueueReviewItem[]) => void,
  ): void {
    const legacyRequest = store.get(LEGACY_QUEUE_BACKUP_RECORD_ID);

    legacyRequest.onsuccess = () => {
      const legacyData = legacyRequest.result as QueueBackupRecord | undefined;
      db.close();
      this.emitLegacyReviewItems(legacyData, onLegacyFound);
      resolve(null);
    };

    legacyRequest.onerror = () => {
      db.close();
      this.logger.warn('从 IndexedDB 读取 legacy 备份失败', legacyRequest.error);
      resolve(null);
    };
  }

  private emitLegacyReviewItems(
    legacyData: QueueBackupRecord | undefined,
    onLegacyFound?: (items: LegacyQueueReviewItem[]) => void,
  ): void {
    if (!legacyData?.actions?.length) return;

    this.logger.warn('检测到 legacy 队列备份，已隔离待审查', {
      count: legacyData.actions.length,
      savedAt: legacyData.savedAt,
    });

    const reviewItems: LegacyQueueReviewItem[] = legacyData.actions.map((action) => ({
      action,
      source: 'legacy-idb-backup' as const,
      capturedAt: legacyData.savedAt,
      ownerUserId: LEGACY_UNKNOWN_OWNER_USER_ID,
    }));

    onLegacyFound?.(reviewItems);
  }

  /**
   * 打开队列备份数据库
   */
  private openQueueBackupDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(QUEUE_BACKUP_DB_NAME, QUEUE_BACKUP_DB_VERSION);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(QUEUE_BACKUP_STORE_NAME)) {
          db.createObjectStore(QUEUE_BACKUP_STORE_NAME, { keyPath: 'id' });
        }
      };
    });
  }
}
