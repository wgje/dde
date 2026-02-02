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
  version: 1,
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
      this.dbInitPromise = new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
          reject(new Error('IndexedDB 不可用'));
          return;
        }
        
        const request = indexedDB.open(DB_CONFIG.name, DB_CONFIG.version);
        
        request.onerror = () => {
          this.logger.error('IndexedDB 打开失败', request.error);
          reject(request.error);
        };
        
        request.onsuccess = () => {
          this.db = request.result;
          this.logger.debug('IndexedDB 初始化成功');
          resolve(request.result);
        };
        
        request.onupgradeneeded = (event) => {
          const db = (event.target as IDBOpenDBRequest).result;
          
          if (!db.objectStoreNames.contains(DB_CONFIG.stores.projects)) {
            db.createObjectStore(DB_CONFIG.stores.projects, { keyPath: 'id' });
          }
          if (!db.objectStoreNames.contains(DB_CONFIG.stores.tasks)) {
            const taskStore = db.createObjectStore(DB_CONFIG.stores.tasks, { keyPath: 'id' });
            taskStore.createIndex('projectId', 'projectId', { unique: false });
          }
          if (!db.objectStoreNames.contains(DB_CONFIG.stores.connections)) {
            const connStore = db.createObjectStore(DB_CONFIG.stores.connections, { keyPath: 'id' });
            connStore.createIndex('projectId', 'projectId', { unique: false });
          }
          if (!db.objectStoreNames.contains(DB_CONFIG.stores.meta)) {
            db.createObjectStore(DB_CONFIG.stores.meta, { keyPath: 'key' });
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
   */
  async putToStore<T>(
    db: IDBDatabase,
    storeName: string,
    data: T
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readwrite');
      const store = transaction.objectStore(storeName);
      const request = store.put(data);
      
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
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
