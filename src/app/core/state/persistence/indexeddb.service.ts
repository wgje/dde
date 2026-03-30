/**
 * IndexedDBService - IndexedDB 基础操作服务
 * 
 * 职责：
 * - IndexedDB 数据库初始化
 * - 基础 CRUD 操作
 * - 事务管理
 * 
 * 从 StorePersistenceService 提取，作为 Sprint 8 技术债务修复的一部分
 */

import { Injectable, inject } from '@angular/core';
import { LoggerService } from '../../../../services/logger.service';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import { openIndexedDBAdaptive } from '../../../../utils/indexeddb-open';

/** IndexedDB 数据库配置 */
export const DB_CONFIG = {
  name: 'nanoflow-store-cache',
  version: 2,
  stores: {
    projects: 'projects',
    tasks: 'tasks',
    connections: 'connections',
    meta: 'meta'
  }
} as const;

@Injectable({
  providedIn: 'root'
})
export class IndexedDBService {
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('IndexedDB');
  
  /** IndexedDB 数据库实例 */
  private db: IDBDatabase | null = null;
  private dbInitPromise: Promise<IDBDatabase> | null = null;
  
  /**
   * 初始化 IndexedDB
   * 
   * 【修复 VersionError】使用 openIndexedDBAdaptive 避免版本降级错误：
   * - 先无版本打开，获取当前数据库实际版本
   * - 仅当需要升级或补建 store 时才指定新版本
   * - 避免 PWA 缓存旧代码导致的 "requested version < existing version" 错误
   */
  async initDatabase(): Promise<IDBDatabase> {
    if (this.db) return this.db;
    
    if (!this.dbInitPromise) {
      this.dbInitPromise = (async () => {
        if (typeof indexedDB === 'undefined') {
          throw new Error('IndexedDB 不可用');
        }
        
        try {
          const db = await openIndexedDBAdaptive({
            dbName: DB_CONFIG.name,
            targetVersion: DB_CONFIG.version,
            requiredStores: Object.values(DB_CONFIG.stores),
            schemaNeedsUpgrade: this.hasMissingIndexes.bind(this),
            ensureStores: this.ensureStores.bind(this),
          });
          
          this.db = db;
          
          // 【P3-01 修复】处理其他标签页触发数据库版本升级
          this.db.onversionchange = () => {
            this.logger.warn('检测到数据库版本变更，关闭当前连接');
            this.db?.close();
            this.db = null;
            this.dbInitPromise = null;
          };
          
          this.logger.debug('IndexedDB 初始化成功', { version: db.version });
          return db;
        } catch (error) {
          this.logger.error('IndexedDB 打开失败', error);
          // 【P1-01 修复】失败后清除 promise，允许重试
          this.dbInitPromise = null;
          throw error;
        }
      })();
    }
    
    return this.dbInitPromise;
  }
  
  /**
   * 确保所有必需的 object stores 存在
   * 在 onupgradeneeded 事件中调用
   */
  private ensureStores(db: IDBDatabase, transaction: IDBTransaction | null): void {
    if (!db.objectStoreNames.contains(DB_CONFIG.stores.projects)) {
      db.createObjectStore(DB_CONFIG.stores.projects, { keyPath: 'id' });
    }

    let taskStore: IDBObjectStore | null = null;
    if (!db.objectStoreNames.contains(DB_CONFIG.stores.tasks)) {
      taskStore = db.createObjectStore(DB_CONFIG.stores.tasks, { keyPath: 'id' });
    } else if (transaction) {
      taskStore = transaction.objectStore(DB_CONFIG.stores.tasks);
    }

    if (taskStore) {
      if (!taskStore.indexNames.contains('projectId')) {
        taskStore.createIndex('projectId', 'projectId', { unique: false });
      }
      if (!taskStore.indexNames.contains('projectId_updatedAt')) {
        // 【P3-05】复合索引：支持按 projectId + updatedAt 范围查询增量任务
        taskStore.createIndex('projectId_updatedAt', ['projectId', 'updatedAt'], { unique: false });
      }
    }

    let connStore: IDBObjectStore | null = null;
    if (!db.objectStoreNames.contains(DB_CONFIG.stores.connections)) {
      connStore = db.createObjectStore(DB_CONFIG.stores.connections, { keyPath: 'id' });
    } else if (transaction) {
      connStore = transaction.objectStore(DB_CONFIG.stores.connections);
    }

    if (connStore && !connStore.indexNames.contains('projectId')) {
      connStore.createIndex('projectId', 'projectId', { unique: false });
    }

    if (!db.objectStoreNames.contains(DB_CONFIG.stores.meta)) {
      db.createObjectStore(DB_CONFIG.stores.meta, { keyPath: 'key' });
    }
  }

  private hasMissingIndexes(db: IDBDatabase): boolean {
    return this.isIndexMissing(db, DB_CONFIG.stores.tasks, 'projectId')
      || this.isIndexMissing(db, DB_CONFIG.stores.tasks, 'projectId_updatedAt')
      || this.isIndexMissing(db, DB_CONFIG.stores.connections, 'projectId');
  }

  private isIndexMissing(db: IDBDatabase, storeName: string, indexName: string): boolean {
    if (!db.objectStoreNames.contains(storeName)) {
      return false;
    }

    const transaction = db.transaction(storeName, 'readonly');
    return !transaction.objectStore(storeName).indexNames.contains(indexName);
  }
  
  /**
   * 获取数据库实例
   */
  getDatabase(): IDBDatabase | null {
    return this.db;
  }
  
  /**
   * 通过索引获取数据
   */
  async getByIndex<T>(
    db: IDBDatabase,
    storeName: string,
    indexName: string,
    key: IDBValidKey
  ): Promise<T[]> {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readonly');
      const store = transaction.objectStore(storeName);
      const index = store.index(indexName);
      const request = index.getAll(key);
      
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * 【P3-05】通过复合索引范围查询数据
   * 
   * 利用 IDB 复合索引进行范围查询，避免全表扫描 + 内存过滤。
   * 例如：查询某项目自某时间以来更新的任务。
   * 
   * @param db 数据库实例
   * @param storeName 对象存储名
   * @param indexName 复合索引名（如 'projectId_updatedAt'）
   * @param lowerBound 范围下界（含）
   * @param upperBound 范围上界（含），可选
   */
  async getByIndexRange<T>(
    db: IDBDatabase,
    storeName: string,
    indexName: string,
    lowerBound: IDBValidKey,
    upperBound?: IDBValidKey
  ): Promise<T[]> {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readonly');
      const store = transaction.objectStore(storeName);
      const index = store.index(indexName);
      const range = upperBound
        ? IDBKeyRange.bound(lowerBound, upperBound)
        : IDBKeyRange.lowerBound(lowerBound);
      const request = index.getAll(range);
      
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }
  
  /**
   * 获取单条数据
   */
  async getFromStore<T>(
    db: IDBDatabase,
    storeName: string,
    key: IDBValidKey
  ): Promise<T | null> {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readonly');
      const store = transaction.objectStore(storeName);
      const request = store.get(key);
      
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }
  
  /**
   * 获取所有数据
   */
  async getAllFromStore<T>(db: IDBDatabase, storeName: string): Promise<T[]> {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readonly');
      const store = transaction.objectStore(storeName);
      const request = store.getAll();
      
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }
  
  /**
   * 保存单条数据
   * 【P1-03 修复】使用 transaction.oncomplete 确保数据已持久化
   */
  async putToStore<T>(
    db: IDBDatabase,
    storeName: string,
    data: T
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readwrite');
      const store = transaction.objectStore(storeName);
      store.put(data);
      
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }
  
  /**
   * 删除数据
   */
  async deleteFromStore(
    db: IDBDatabase,
    storeName: string,
    key: IDBValidKey
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readwrite');
      const store = transaction.objectStore(storeName);
      const request = store.delete(key);
      
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * 【P3-08 优化】批量删除多个记录（单事务，避免 N 次事务开销）
   */
  async batchDeleteFromStore(
    db: IDBDatabase,
    storeName: string,
    keys: IDBValidKey[]
  ): Promise<void> {
    if (keys.length === 0) return;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readwrite');
      const store = transaction.objectStore(storeName);
      for (const key of keys) {
        store.delete(key);
      }
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }
  
  /**
   * 清空存储
   */
  async clearStore(db: IDBDatabase, storeName: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readwrite');
      const store = transaction.objectStore(storeName);
      const request = store.clear();
      
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }
  
  /**
   * 删除数据库
   */
  async deleteDatabase(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.dbInitPromise = null;
    
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        resolve();
        return;
      }
      
      const request = indexedDB.deleteDatabase(DB_CONFIG.name);
      request.onsuccess = () => {
        this.logger.info('IndexedDB 数据库已删除');
        resolve();
      };
      request.onerror = () => reject(request.error);
    });
  }
}
