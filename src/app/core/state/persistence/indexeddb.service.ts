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
   */
  async initDatabase(): Promise<IDBDatabase> {
    if (this.db) return this.db;
    
    if (!this.dbInitPromise) {
      this.dbInitPromise = new Promise<IDBDatabase>((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
          reject(new Error('IndexedDB 不可用'));
          return;
        }
        
        const request = indexedDB.open(DB_CONFIG.name, DB_CONFIG.version);
        
        request.onerror = () => {
          this.logger.error('IndexedDB 打开失败', request.error);
          // 【P1-01 修复】失败后清除 promise，允许重试
          this.dbInitPromise = null;
          reject(request.error);
        };
        
        request.onsuccess = () => {
          this.db = request.result;
          // 【P3-01 修复】处理其他标签页触发数据库版本升级
          this.db.onversionchange = () => {
            this.logger.warn('检测到数据库版本变更，关闭当前连接');
            this.db?.close();
            this.db = null;
            this.dbInitPromise = null;
          };
          this.logger.debug('IndexedDB 初始化成功');
          resolve(request.result);
        };
        
        request.onupgradeneeded = (event) => {
          const db = (event.target as IDBOpenDBRequest).result;
          const oldVersion = event.oldVersion;
          
          if (!db.objectStoreNames.contains(DB_CONFIG.stores.projects)) {
            db.createObjectStore(DB_CONFIG.stores.projects, { keyPath: 'id' });
          }
          if (!db.objectStoreNames.contains(DB_CONFIG.stores.tasks)) {
            const taskStore = db.createObjectStore(DB_CONFIG.stores.tasks, { keyPath: 'id' });
            taskStore.createIndex('projectId', 'projectId', { unique: false });
            // 【P3-05】复合索引：支持按 projectId + updatedAt 范围查询增量任务
            taskStore.createIndex('projectId_updatedAt', ['projectId', 'updatedAt'], { unique: false });
          }
          if (!db.objectStoreNames.contains(DB_CONFIG.stores.connections)) {
            const connStore = db.createObjectStore(DB_CONFIG.stores.connections, { keyPath: 'id' });
            connStore.createIndex('projectId', 'projectId', { unique: false });
          }
          if (!db.objectStoreNames.contains(DB_CONFIG.stores.meta)) {
            db.createObjectStore(DB_CONFIG.stores.meta, { keyPath: 'key' });
          }
          
          // 版本 1 → 2 升级：为已有的 tasks store 补建复合索引
          if (oldVersion < 2) {
            const tx = (event.target as IDBOpenDBRequest).transaction;
            if (tx && db.objectStoreNames.contains(DB_CONFIG.stores.tasks)) {
              const taskStore = tx.objectStore(DB_CONFIG.stores.tasks);
              if (!taskStore.indexNames.contains('projectId_updatedAt')) {
                taskStore.createIndex('projectId_updatedAt', ['projectId', 'updatedAt'], { unique: false });
              }
            }
          }
        };
      });
    }
    
    return this.dbInitPromise;
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
