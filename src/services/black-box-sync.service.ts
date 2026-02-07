/**
 * 黑匣子同步服务
 *
 * 负责黑匣子条目的离线同步
 * 遵循 Offline-first：IndexedDB 持久化 + RetryQueue 集成
 * 冲突解决：LWW (Last-Write-Wins)
 *
 * 【数据安全设计】
 * - 所有条目先写入 IndexedDB，再推送到服务器
 * - 通过 retryQueueHandler 集成到主同步体系的 RetryQueue（持久化队列）
 * - 推送失败时自动进入 RetryQueue，浏览器崩溃/刷新后不丢失
 * - 启动时扫描 IndexedDB 中 syncStatus=pending 的条目，恢复未完成的同步
 */

import { Injectable, inject } from '@angular/core';
import { BlackBoxEntry } from '../models/focus';
import { FOCUS_CONFIG } from '../config/focus.config';
import { SYNC_CONFIG } from '../config/sync.config';
import {
  blackBoxEntriesMap,
  setBlackBoxEntries,
  updateBlackBoxEntry
} from '../state/focus-stores';
import { SupabaseClientService } from './supabase-client.service';
import { NetworkAwarenessService } from './network-awareness.service';
import { LoggerService } from './logger.service';

/**
 * IndexedDB 中的黑匣子条目格式
 */
interface IDBBlackBoxEntry extends BlackBoxEntry {
  /** 本地版本号，用于冲突检测 */
  _localVersion?: number;
}

/**
 * RetryQueue 回调接口
 * 由 SimpleSyncService 通过 setRetryQueueHandler 注入
 */
type RetryQueueHandler = (entry: BlackBoxEntry) => void;

@Injectable({
  providedIn: 'root'
})
export class BlackBoxSyncService {
  private supabase = inject(SupabaseClientService);
  private network = inject(NetworkAwarenessService);
  private logger = inject(LoggerService);

  private db: IDBDatabase | null = null;
  private lastSyncTime: string | null = null;

  /** RetryQueue 集成回调，由 SimpleSyncService 注入 */
  private retryQueueHandler: RetryQueueHandler | null = null;

  /** 防抖定时器（合并短时间内的多次写入） */
  private pushDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingPushEntries: Map<string, BlackBoxEntry> = new Map();

  // 防重保护：避免重复拉取
  private isPulling = false;
  private pullPromise: Promise<void> | null = null;

  private readonly IDB_NAME = FOCUS_CONFIG.SYNC.IDB_NAME;
  private readonly IDB_VERSION = FOCUS_CONFIG.SYNC.IDB_VERSION;
  private readonly STORE_NAME = FOCUS_CONFIG.IDB_STORES.BLACK_BOX_ENTRIES;
  private readonly DEBOUNCE_DELAY = SYNC_CONFIG.DEBOUNCE_DELAY;

  constructor() {
    // 初始化 IndexedDB
    this.initIndexedDB();

    // 监听网络状态变化
    this.setupNetworkListener();
  }
  private readonly SYNC_METADATA_STORE = FOCUS_CONFIG.IDB_STORES.SYNC_METADATA;
  private readonly LAST_SYNC_TIME_KEY = 'black_box_last_sync_time';

  // ==================== RetryQueue 集成 ====================

  /**
   * 设置 RetryQueue 处理器
   * 由 SimpleSyncService 在初始化时调用，将黑匣子同步集成到主同步体系
   */
  setRetryQueueHandler(handler: RetryQueueHandler): void {
    this.retryQueueHandler = handler;

    // 处理器就绪后，恢复 IndexedDB 中未同步的条目到 RetryQueue
    this.recoverPendingEntries();
  }

  /**
   * 从 IndexedDB 恢复 syncStatus=pending 的条目到 RetryQueue
   * 防止浏览器崩溃/刷新导致数据丢失
   */
  private async recoverPendingEntries(): Promise<void> {
    if (!this.retryQueueHandler) return;

    try {
      const entries = await this.loadFromLocal();
      const pendingEntries = entries.filter(e => e.syncStatus === 'pending');

      if (pendingEntries.length > 0) {
        this.logger.info('BlackBoxSync', `Recovering ${pendingEntries.length} pending entries to RetryQueue`);
        for (const entry of pendingEntries) {
          this.retryQueueHandler(entry);
        }
      }
    } catch (e) {
      this.logger.error('BlackBoxSync', 'Failed to recover pending entries',
        e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * 初始化 IndexedDB
   */
  private async initIndexedDB(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.IDB_NAME, this.IDB_VERSION);

      request.onerror = () => {
        this.logger.error('BlackBoxSync', 'Failed to open IndexedDB for focus mode', request.error?.message || 'Unknown error');
        reject(request.error);
      };

      request.onsuccess = async () => {
        this.db = request.result;
        this.logger.debug('BlackBoxSync', 'IndexedDB opened for focus mode');

        // 从 IndexedDB 恢复上次同步时间
        await this.loadLastSyncTime();

        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        // 黑匣子条目存储
        if (!db.objectStoreNames.contains(this.STORE_NAME)) {
          const store = db.createObjectStore(this.STORE_NAME, { keyPath: 'id' });
          store.createIndex('by-date', 'date', { unique: false });
          store.createIndex('by-updated', 'updatedAt', { unique: false });
          store.createIndex('by-sync-status', 'syncStatus', { unique: false });
        }

        // 离线音频缓存存储
        if (!db.objectStoreNames.contains(FOCUS_CONFIG.IDB_STORES.OFFLINE_AUDIO_CACHE)) {
          db.createObjectStore(FOCUS_CONFIG.IDB_STORES.OFFLINE_AUDIO_CACHE, { keyPath: 'id' });
        }

        // 偏好设置存储
        if (!db.objectStoreNames.contains(FOCUS_CONFIG.IDB_STORES.FOCUS_PREFERENCES)) {
          db.createObjectStore(FOCUS_CONFIG.IDB_STORES.FOCUS_PREFERENCES, { keyPath: 'key' });
        }

        // 同步元数据存储（v2 新增）
        if (!db.objectStoreNames.contains(FOCUS_CONFIG.IDB_STORES.SYNC_METADATA)) {
          db.createObjectStore(FOCUS_CONFIG.IDB_STORES.SYNC_METADATA, { keyPath: 'key' });
        }
      };
    });
  }

  /**
   * 从 IndexedDB 加载上次同步时间
   */
  private async loadLastSyncTime(): Promise<void> {
    if (!this.db) return;

    return new Promise((resolve) => {
      try {
        const tx = this.db!.transaction(this.SYNC_METADATA_STORE, 'readonly');
        const store = tx.objectStore(this.SYNC_METADATA_STORE);
        const request = store.get(this.LAST_SYNC_TIME_KEY);

        request.onsuccess = () => {
          if (request.result) {
            this.lastSyncTime = request.result.value;
            this.logger.debug('BlackBoxSync', `Loaded lastSyncTime: ${this.lastSyncTime}`);
          }
          resolve();
        };

        request.onerror = () => {
          this.logger.warn('BlackBoxSync', 'Failed to load lastSyncTime');
          resolve();
        };
      } catch (e) {
        // 降级处理：Store 可能不存在（首次升级前）
        this.logger.debug('loadLastSyncTime', 'IndexedDB store 不存在', { error: e });
        resolve();
      }
    });
  }

  /**
   * 保存上次同步时间到 IndexedDB
   */
  private async saveLastSyncTime(): Promise<void> {
    if (!this.db || !this.lastSyncTime) return;

    return new Promise((resolve) => {
      try {
        const tx = this.db!.transaction(this.SYNC_METADATA_STORE, 'readwrite');
        const store = tx.objectStore(this.SYNC_METADATA_STORE);
        store.put({ key: this.LAST_SYNC_TIME_KEY, value: this.lastSyncTime });
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch (e) {
        // 降级处理：保存失败时静默继续
        this.logger.debug('saveLastSyncTime', '保存同步时间失败', { error: e });
        resolve();
      }
    });
  }

  /**
   * 设置网络状态监听
   * 网络恢复时，扫描并恢复未同步条目
   */
  private setupNetworkListener(): void {
    window.addEventListener('online', () => {
      this.logger.info('BlackBoxSync', 'Network restored, recovering pending entries');
      this.recoverPendingEntries();
    });
  }

  /**
   * 调度同步（防抖 3s）
   *
   * 数据安全保证：
   * 1. 立即写入 IndexedDB（syncStatus=pending）
   * 2. 防抖结束后通过 RetryQueue 推送（持久化队列）
   * 3. 即使浏览器崩溃，下次启动时 recoverPendingEntries 会恢复
   */
  scheduleSync(entry: BlackBoxEntry): void {
    // 1. 立即保存到本地 IndexedDB（syncStatus=pending）
    const pendingEntry: BlackBoxEntry = { ...entry, syncStatus: 'pending' };
    this.saveToLocal(pendingEntry);

    // 2. 加入防抖批次
    this.pendingPushEntries.set(entry.id, pendingEntry);

    // 3. 防抖处理
    if (this.pushDebounceTimer) {
      clearTimeout(this.pushDebounceTimer);
    }

    this.pushDebounceTimer = setTimeout(() => {
      this.flushPendingToRetryQueue();
    }, this.DEBOUNCE_DELAY);
  }

  /**
   * 将防抖批次中的条目提交到 RetryQueue
   */
  private flushPendingToRetryQueue(): void {
    const entries = Array.from(this.pendingPushEntries.values());
    this.pendingPushEntries.clear();

    for (const entry of entries) {
      if (this.retryQueueHandler) {
        // 通过主同步体系的 RetryQueue（持久化）
        this.retryQueueHandler(entry);
      } else {
        // 降级：直接推送（不经过 RetryQueue）
        this.pushToServer(entry);
      }
    }
  }

  /**
   * 保存到本地 IndexedDB
   */
  async saveToLocal(entry: BlackBoxEntry): Promise<void> {
    if (!this.db) {
      await this.initIndexedDB();
    }

    return new Promise((resolve, reject) => {
      if (!this.db) {
        reject(new Error('IndexedDB not initialized'));
        return;
      }

      const tx = this.db.transaction(this.STORE_NAME, 'readwrite');
      const store = tx.objectStore(this.STORE_NAME);

      const idbEntry: IDBBlackBoxEntry = {
        ...entry,
        _localVersion: Date.now()
      };

      const request = store.put(idbEntry);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * 从本地 IndexedDB 加载
   */
  async loadFromLocal(): Promise<BlackBoxEntry[]> {
    if (!this.db) {
      await this.initIndexedDB();
    }

    return new Promise((resolve, reject) => {
      if (!this.db) {
        reject(new Error('IndexedDB not initialized'));
        return;
      }

      const tx = this.db.transaction(this.STORE_NAME, 'readonly');
      const store = tx.objectStore(this.STORE_NAME);
      const request = store.getAll();

      request.onsuccess = () => {
        const entries = (request.result as IDBBlackBoxEntry[]).map(e => {

          const { _localVersion, ...entry } = e;
          return entry;
        });

        // 更新状态
        setBlackBoxEntries(entries);

        resolve(entries);
      };

      request.onerror = () => reject(request.error);
    });
  }

  /**
   * 推送到服务器
   *
   * 公开方法：由 RetryQueue 处理器回调调用
   * 返回 boolean 表示是否成功（供 RetryQueue 决定是否重试）
   */
  async pushToServer(entry: BlackBoxEntry): Promise<boolean> {
    try {
      const client = this.supabase.client();

      // 使用 upsert 确保幂等性
      const { error } = await client
        .from('black_box_entries')
        .upsert({
          id: entry.id,
          project_id: entry.projectId,
          user_id: entry.userId,
          content: entry.content,
          date: entry.date,
          created_at: entry.createdAt,
          updated_at: entry.updatedAt,
          is_read: entry.isRead,
          is_completed: entry.isCompleted,
          is_archived: entry.isArchived,
          snooze_until: entry.snoozeUntil,
          snooze_count: entry.snoozeCount,
          deleted_at: entry.deletedAt
        }, {
          onConflict: 'id'
        });

      if (error) {
        this.logger.error('BlackBoxSync', 'Failed to push entry to server', error.message || 'Unknown error');
        return false;
      }

      // 更新本地同步状态为已同步
      const synced: BlackBoxEntry = { ...entry, syncStatus: 'synced' };
      await this.saveToLocal(synced);
      updateBlackBoxEntry(synced);

      this.logger.debug('BlackBoxSync', `Entry synced to server: ${entry.id}`);
      return true;
    } catch (error) {
      this.logger.error('BlackBoxSync', 'Sync error', error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  /**
   * 从服务器拉取变更（增量同步）
   */
  async pullChanges(): Promise<void> {
    // 防重保护：如果正在拉取，返回现有 Promise
    if (this.isPulling && this.pullPromise) {
      this.logger.debug('BlackBoxSync', 'Pull already in progress, reusing promise');
      return this.pullPromise;
    }

    if (!this.network.isOnline()) {
      this.logger.debug('BlackBoxSync', 'Offline, loading from local');
      await this.loadFromLocal();
      return;
    }

    this.isPulling = true;
    this.pullPromise = this.doPullChanges();

    try {
      await this.pullPromise;
    } finally {
      this.isPulling = false;
      this.pullPromise = null;
    }
  }

  /**
   * 实际执行拉取变更的内部方法
   */
  private async doPullChanges(): Promise<void> {
    try {
      const client = this.supabase.client();

      // 获取上次同步时间
      const lastSync = this.lastSyncTime || '1970-01-01T00:00:00Z';
      this.logger.debug('BlackBoxSync', `Pulling changes since: ${lastSync}`);

      // 增量拉取（使用字段筛选优化，减少 ~30% 数据传输）
      const { data, error } = await client
        .from('black_box_entries')
        .select('id,project_id,user_id,content,date,created_at,updated_at,is_read,is_completed,is_archived,snooze_until,snooze_count,deleted_at')
        .gt('updated_at', lastSync)
        .order('updated_at', { ascending: true });

      if (error) {
        this.logger.error('BlackBoxSync', 'Failed to pull changes', error.message || 'Unknown error');
        await this.loadFromLocal();
        return;
      }

      // 合并到本地
      for (const row of data ?? []) {
        const entry = this.mapRowToEntry(row);
        await this.mergeWithLocal(entry);
      }

      // 更新同步时间并持久化
      if (data && data.length > 0) {
        this.lastSyncTime = data[data.length - 1].updated_at;
        await this.saveLastSyncTime();
      }

      this.logger.info('BlackBoxSync', `Pulled changes from server: ${data?.length ?? 0} entries`);
    } catch (error) {
      this.logger.error('BlackBoxSync', 'Pull changes error', error instanceof Error ? error.message : String(error));
      await this.loadFromLocal();
    }
  }

  /**
   * 合并远程数据到本地（LWW 冲突解决）
   */
  private async mergeWithLocal(remote: BlackBoxEntry): Promise<void> {
    const local = blackBoxEntriesMap().get(remote.id);

    // LWW: 远程更新时间更新则使用远程
    if (!local || remote.updatedAt > local.updatedAt) {
      await this.saveToLocal(remote);
      updateBlackBoxEntry(remote);
    }
  }

  /**
   * 映射数据库行到条目
   */
  private mapRowToEntry(row: Record<string, unknown>): BlackBoxEntry {
    return {
      id: row['id'] as string,
      projectId: (row['project_id'] as string) || '',
      userId: (row['user_id'] as string) || '',
      content: (row['content'] as string) || '',  // 防止 content 为 null/undefined
      date: (row['date'] as string) || new Date().toISOString().split('T')[0],
      createdAt: (row['created_at'] as string) || new Date().toISOString(),
      updatedAt: (row['updated_at'] as string) || new Date().toISOString(),
      isRead: (row['is_read'] as boolean) ?? false,
      isCompleted: (row['is_completed'] as boolean) ?? false,
      isArchived: (row['is_archived'] as boolean) ?? false,
      snoozeUntil: row['snooze_until'] as string | undefined,
      snoozeCount: row['snooze_count'] as number | undefined,
      deletedAt: row['deleted_at'] as string | null,
      syncStatus: 'synced'
    };
  }

  /**
   * 获取待同步条目数量
   */
  getPendingSyncCount(): number {
    return this.pendingPushEntries.size;
  }

  /**
   * 强制同步
   */
  async forceSync(): Promise<void> {
    // 立即刷新防抖中的条目
    if (this.pushDebounceTimer) {
      clearTimeout(this.pushDebounceTimer);
      this.pushDebounceTimer = null;
    }
    this.flushPendingToRetryQueue();

    await this.pullChanges();
  }
}
