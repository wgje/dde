/**
 * 黑匣子同步服务
 * 
 * 负责黑匣子条目的离线同步
 * 遵循 Offline-first：IndexedDB + RetryQueue
 * 冲突解决：LWW (Last-Write-Wins)
 */

import { Injectable, inject } from '@angular/core';
import { BlackBoxEntry } from '../models/focus';
import { FOCUS_CONFIG } from '../config/focus.config';
import { SYNC_CONFIG } from '../config/sync.config';
import { 
  blackBoxEntriesMap, 
  setBlackBoxEntries,
  updateBlackBoxEntry
} from '../app/core/state/focus-stores';
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

@Injectable({
  providedIn: 'root'
})
export class BlackBoxSyncService {
  private supabase = inject(SupabaseClientService);
  private network = inject(NetworkAwarenessService);
  private logger = inject(LoggerService);
  
  private db: IDBDatabase | null = null;
  private syncQueue: Map<string, BlackBoxEntry> = new Map();
  private syncDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSyncTime: string | null = null;
  
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
      
      request.onsuccess = () => {
        this.db = request.result;
        this.logger.debug('BlackBoxSync', 'IndexedDB opened for focus mode');
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
      };
    });
  }
  
  /**
   * 设置网络状态监听
   */
  private setupNetworkListener(): void {
    // 当网络恢复时，自动同步待处理的条目
    window.addEventListener('online', () => {
      this.logger.info('BlackBoxSync', 'Network restored, syncing pending entries');
      this.processSyncQueue();
    });
  }
  
  /**
   * 调度同步（防抖 3s）
   */
  scheduleSync(entry: BlackBoxEntry): void {
    // 保存到本地 IndexedDB
    this.saveToLocal(entry);
    
    // 加入同步队列
    this.syncQueue.set(entry.id, entry);
    
    // 防抖处理
    if (this.syncDebounceTimer) {
      clearTimeout(this.syncDebounceTimer);
    }
    
    this.syncDebounceTimer = setTimeout(() => {
      this.processSyncQueue();
    }, this.DEBOUNCE_DELAY);
  }
  
  /**
   * 处理同步队列
   */
  private async processSyncQueue(): Promise<void> {
    if (!this.network.isOnline()) {
      this.logger.debug('BlackBoxSync', 'Offline, skipping sync');
      return;
    }
    
    if (this.syncQueue.size === 0) {
      return;
    }
    
    const entries = Array.from(this.syncQueue.values());
    this.syncQueue.clear();
    
    for (const entry of entries) {
      await this.pushToServer(entry);
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
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
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
   */
  private async pushToServer(entry: BlackBoxEntry): Promise<void> {
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
        // 重新加入队列稍后重试
        this.syncQueue.set(entry.id, entry);
        return;
      }
      
      // 更新本地同步状态
      const synced: BlackBoxEntry = { ...entry, syncStatus: 'synced' };
      await this.saveToLocal(synced);
      updateBlackBoxEntry(synced);
      
      this.logger.debug('BlackBoxSync', `Entry synced to server: ${entry.id}`);
    } catch (error) {
      this.logger.error('BlackBoxSync', 'Sync error', error instanceof Error ? error.message : String(error));
      // 重新加入队列
      this.syncQueue.set(entry.id, entry);
    }
  }
  
  /**
   * 从服务器拉取变更（增量同步）
   */
  async pullChanges(): Promise<void> {
    if (!this.network.isOnline()) {
      this.logger.debug('BlackBoxSync', 'Offline, loading from local');
      await this.loadFromLocal();
      return;
    }
    
    try {
      const client = this.supabase.client();
      
      // 获取上次同步时间
      const lastSync = this.lastSyncTime || '1970-01-01T00:00:00Z';
      
      // 增量拉取
      const { data, error } = await client
        .from('black_box_entries')
        .select('*')
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
      
      // 更新同步时间
      if (data && data.length > 0) {
        this.lastSyncTime = data[data.length - 1].updated_at;
      }
      
      // 处理本地待同步的条目
      await this.processSyncQueue();
      
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
      projectId: row['project_id'] as string,
      userId: row['user_id'] as string,
      content: row['content'] as string,
      date: row['date'] as string,
      createdAt: row['created_at'] as string,
      updatedAt: row['updated_at'] as string,
      isRead: row['is_read'] as boolean,
      isCompleted: row['is_completed'] as boolean,
      isArchived: row['is_archived'] as boolean,
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
    return this.syncQueue.size;
  }
  
  /**
   * 强制同步
   */
  async forceSync(): Promise<void> {
    await this.pullChanges();
  }
}
