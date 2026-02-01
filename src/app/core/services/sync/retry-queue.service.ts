/**
 * RetryQueueService - 重试队列管理
 * 
 * 职责：
 * - 管理 IndexedDB + localStorage 的重试队列持久化
 * - 队列容量控制和警告
 * - 队列去重和过期清理
 * 
 * 从 SimpleSyncService 提取，作为 Sprint 3 技术债务修复的一部分
 * 
 * 【设计决策】
 * - IndexedDB 为主存储（50MB+），localStorage 为降级方案（5MB）
 * - 队列大小限制防止溢出
 * - 去重机制防止队列膨胀
 */

import { Injectable, inject, DestroyRef } from '@angular/core';
import { LoggerService } from '../../../../services/logger.service';
import { ToastService } from '../../../../services/toast.service';
import { SYNC_CONFIG } from '../../../../config';
import { Task, Project, Connection } from '../../../../models';
import * as Sentry from '@sentry/angular';

/**
 * 可重试的实体类型
 */
export type RetryableEntityType = 'task' | 'project' | 'connection';

/**
 * 可重试的操作类型
 */
export type RetryableOperation = 'upsert' | 'delete';

/**
 * 重试队列项
 */
export interface RetryQueueItem {
  /** 唯一标识符 */
  id: string;
  /** 实体类型 */
  type: RetryableEntityType;
  /** 操作类型 */
  operation: RetryableOperation;
  /** 实体数据 */
  data: Task | Project | Connection | { id: string };
  /** 关联的项目 ID */
  projectId?: string;
  /** 重试次数 */
  retryCount: number;
  /** 创建时间戳 */
  createdAt: number;
}

/**
 * 重试队列服务
 * 
 * 管理离线操作的持久化队列
 */
@Injectable({
  providedIn: 'root'
})
export class RetryQueueService {
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('RetryQueue');
  private readonly toast = inject(ToastService);
  private readonly destroyRef = inject(DestroyRef);
  
  /** 重试队列 */
  private queue: RetryQueueItem[] = [];
  
  /** IndexedDB 数据库实例 */
  private db: IDBDatabase | null = null;
  private dbInitPromise: Promise<IDBDatabase | null> | null = null;
  
  /** IndexedDB 配置 */
  private readonly DB_CONFIG = {
    name: 'nanoflow-retry-queue',
    version: 1,
    storeName: 'offline_mutation_queue'
  };
  
  /** 最大重试次数 */
  readonly MAX_RETRIES = 5;
  
  /** 重试队列最大大小 */
  private readonly MAX_SIZE = SYNC_CONFIG.MAX_RETRY_QUEUE_SIZE;
  
  /** 重试项最大年龄（毫秒，24 小时） */
  private readonly MAX_ITEM_AGE = SYNC_CONFIG.MAX_RETRY_ITEM_AGE;
  
  /** 队列容量预警阈值 */
  private readonly WARNING_THRESHOLD = 0.8;
  
  /** 容量警告冷却时间（毫秒） */
  private readonly WARNING_COOLDOWN = 300_000; // 5 分钟
  
  /** 上次显示容量警告的时间戳 */
  private lastWarningTime = 0;
  
  /** 上次警告时的队列使用百分比 */
  private lastWarningPercent = 0;
  
  /** 持久化 key */
  private readonly STORAGE_KEY = 'nanoflow.retry-queue';
  
  /** 版本号 */
  private readonly VERSION = 1;
  
  constructor() {
    // 初始化时加载队列
    this.initDb().then(() => {
      this.loadFromStorage();
    });
    
    this.destroyRef.onDestroy(() => {
      // 确保队列保存
      this.saveToStorage();
    });
  }
  
  // ==================== 公共 API ====================
  
  /**
   * 获取队列长度
   */
  get length(): number {
    return this.queue.length;
  }
  
  /**
   * 获取队列副本
   */
  getItems(): RetryQueueItem[] {
    return [...this.queue];
  }
  
  /**
   * 清空队列
   */
  clear(): void {
    this.queue = [];
    this.saveToStorage();
    this.logger.info('重试队列已清空');
  }
  
  /**
   * 添加项到队列
   * 
   * 特性：
   * - 去重：同一实体只保留最新操作
   * - 容量限制：超限时移除最老的项
   */
  add(
    type: RetryableEntityType,
    operation: RetryableOperation,
    data: Task | Project | Connection | { id: string },
    projectId?: string
  ): void {
    // 去重：检查是否已存在同一实体
    const existingIndex = this.queue.findIndex(
      item => item.type === type && item.data.id === data.id
    );
    
    if (existingIndex !== -1) {
      // 更新已存在的项
      const existing = this.queue[existingIndex];
      this.queue[existingIndex] = {
        ...existing,
        operation,
        data,
        projectId: projectId ?? existing.projectId,
        createdAt: Date.now()
      };
      this.logger.debug('更新队列中的现有项', { 
        type, 
        operation, 
        dataId: data.id,
        retryCount: existing.retryCount
      });
      this.saveToStorage();
      return;
    }
    
    // 容量检查
    if (this.queue.length >= this.MAX_SIZE) {
      const removed = this.queue.shift();
      this.logger.warn('队列已满，移除最老的项', {
        removed: { type: removed?.type, id: removed?.data.id },
        queueSize: this.queue.length
      });
      Sentry.captureMessage('重试队列溢出', {
        level: 'warning',
        tags: { queueSize: String(this.queue.length) }
      });
    }
    
    // 添加新项
    const item: RetryQueueItem = {
      id: crypto.randomUUID(),
      type,
      operation,
      data,
      projectId,
      retryCount: 0,
      createdAt: Date.now()
    };
    
    this.queue.push(item);
    this.saveToStorage();
    
    this.logger.debug('添加到重试队列', { type, operation, dataId: data.id });
  }
  
  /**
   * 移除指定项
   */
  remove(id: string): void {
    const index = this.queue.findIndex(item => item.id === id);
    if (index !== -1) {
      this.queue.splice(index, 1);
      this.saveToStorage();
    }
  }
  
  /**
   * 移除所有匹配的项
   */
  removeByEntityId(entityId: string): void {
    const originalLength = this.queue.length;
    this.queue = this.queue.filter(item => item.data.id !== entityId);
    if (this.queue.length < originalLength) {
      this.saveToStorage();
    }
  }
  
  /**
   * 更新项的重试次数
   */
  incrementRetryCount(id: string): void {
    const item = this.queue.find(i => i.id === id);
    if (item) {
      item.retryCount++;
      this.saveToStorage();
    }
  }
  
  /**
   * 获取并清空队列（用于处理）
   * 返回按依赖顺序排列的项（project → task → connection）
   */
  takeAll(): RetryQueueItem[] {
    const items = [...this.queue];
    this.queue = [];
    this.saveToStorage();
    
    // 按类型排序：project → task → connection
    return items.sort((a, b) => {
      const order = { project: 0, task: 1, connection: 2 };
      return order[a.type] - order[b.type];
    });
  }
  
  /**
   * 将项放回队列（处理失败时）
   */
  putBack(items: RetryQueueItem[]): void {
    for (const item of items) {
      // 检查是否已存在（防止重复）
      const exists = this.queue.some(q => q.id === item.id);
      if (!exists) {
        this.queue.push(item);
      }
    }
    this.saveToStorage();
  }
  
  /**
   * 清理过期和超过重试限制的项
   */
  cleanExpired(): number {
    const now = Date.now();
    const originalLength = this.queue.length;
    
    this.queue = this.queue.filter(item => {
      const isExpired = now - item.createdAt > this.MAX_ITEM_AGE;
      const isMaxRetried = item.retryCount >= this.MAX_RETRIES;
      
      if (isExpired) {
        this.logger.debug('清理过期项', { 
          type: item.type, 
          id: item.data.id,
          ageHours: Math.floor((now - item.createdAt) / 1000 / 60 / 60)
        });
        return false;
      }
      
      if (isMaxRetried) {
        this.logger.debug('清理超过重试限制的项', { 
          type: item.type, 
          id: item.data.id,
          retryCount: item.retryCount
        });
        return false;
      }
      
      return true;
    });
    
    const cleaned = originalLength - this.queue.length;
    if (cleaned > 0) {
      this.saveToStorage();
      this.logger.info('清理队列', { cleaned, remaining: this.queue.length });
    }
    
    return cleaned;
  }
  
  /**
   * 检查队列容量警告
   */
  checkCapacityWarning(callbacks?: {
    onWarning?: () => void;
    onForceProcess?: () => void;
  }): void {
    const currentSize = this.queue.length;
    const threshold = Math.floor(this.MAX_SIZE * this.WARNING_THRESHOLD);
    const now = Date.now();
    
    // 低于阈值，恢复正常状态
    if (currentSize < threshold) {
      if (this.lastWarningPercent > 0) {
        this.lastWarningPercent = 0;
        this.logger.info('队列容量恢复正常', { currentSize, maxSize: this.MAX_SIZE });
      }
      return;
    }
    
    const percentUsed = Math.round((currentSize / this.MAX_SIZE) * 100);
    
    // 满载时触发强制处理
    if (percentUsed >= 90 && callbacks?.onForceProcess) {
      callbacks.onForceProcess();
    }
    
    // 节流检查
    const cooldownPassed = now - this.lastWarningTime > this.WARNING_COOLDOWN;
    const significantIncrease = percentUsed >= this.lastWarningPercent + 10;
    
    if (!cooldownPassed && !significantIncrease) {
      return;
    }
    
    // 更新警告状态
    this.lastWarningTime = now;
    this.lastWarningPercent = percentUsed;
    
    const diagnostics = {
      currentSize,
      maxSize: this.MAX_SIZE,
      percentUsed,
      typeBreakdown: this.getTypeBreakdown()
    };
    
    this.logger.warn('队列容量警告', diagnostics);
    
    if (cooldownPassed) {
      this.toast.error(
        '⚠️ 同步队列即将满载',
        '请连接网络以防止数据丢失',
        { duration: 30_000 }
      );
    }
    
    Sentry.captureMessage('RetryQueue capacity warning', {
      level: 'warning',
      tags: { 
        operation: 'queueCapacityCheck',
        percentUsed: String(percentUsed)
      },
      extra: diagnostics
    });
    
    callbacks?.onWarning?.();
  }
  
  /**
   * 获取队列中各类型项的数量统计
   */
  getTypeBreakdown(): Record<string, number> {
    const breakdown: Record<string, number> = { task: 0, project: 0, connection: 0 };
    for (const item of this.queue) {
      breakdown[item.type] = (breakdown[item.type] || 0) + 1;
    }
    return breakdown;
  }
  
  /**
   * 立即保存队列（用于 beforeunload）
   */
  flushSync(): void {
    this.saveToStorageSync();
    
    if (this.queue.length > 0) {
      this.logger.info('beforeunload: 保存待处理同步项', { 
        count: this.queue.length 
      });
    }
  }
  
  // ==================== IndexedDB 支持 ====================
  
  /**
   * 初始化 IndexedDB
   */
  private async initDb(): Promise<IDBDatabase | null> {
    if (this.db) return this.db;
    
    if (!this.dbInitPromise) {
      this.dbInitPromise = new Promise((resolve) => {
        if (typeof indexedDB === 'undefined') {
          this.logger.warn('IndexedDB 不可用，将使用 localStorage');
          resolve(null);
          return;
        }
        
        try {
          const request = indexedDB.open(this.DB_CONFIG.name, this.DB_CONFIG.version);
          
          request.onerror = () => {
            this.logger.warn('IndexedDB 打开失败，降级到 localStorage', request.error);
            resolve(null);
          };
          
          request.onsuccess = () => {
            this.db = request.result;
            this.logger.info('IndexedDB 初始化成功');
            resolve(request.result);
          };
          
          request.onupgradeneeded = (event) => {
            const db = (event.target as IDBOpenDBRequest).result;
            
            if (!db.objectStoreNames.contains(this.DB_CONFIG.storeName)) {
              const store = db.createObjectStore(this.DB_CONFIG.storeName, { keyPath: 'id' });
              store.createIndex('createdAt', 'createdAt', { unique: false });
              store.createIndex('type', 'type', { unique: false });
              this.logger.info('IndexedDB store 创建成功');
            }
          };
        } catch (err) {
          this.logger.error('IndexedDB 初始化异常', err);
          resolve(null);
        }
      });
    }
    
    return this.dbInitPromise;
  }
  
  /**
   * 从存储加载队列（优先 IndexedDB，降级 localStorage）
   */
  private async loadFromStorage(): Promise<void> {
    const db = await this.initDb();
    
    if (db) {
      const items = await this.loadFromIdb(db);
      if (items.length > 0) {
        this.queue = items;
        this.logger.info('从 IndexedDB 加载队列', { count: items.length });
        return;
      }
    }
    
    // 降级到 localStorage
    this.loadFromLocalStorage();
  }
  
  /**
   * 从 IndexedDB 加载
   */
  private async loadFromIdb(db: IDBDatabase): Promise<RetryQueueItem[]> {
    return new Promise((resolve) => {
      try {
        const transaction = db.transaction(this.DB_CONFIG.storeName, 'readonly');
        const store = transaction.objectStore(this.DB_CONFIG.storeName);
        const request = store.getAll();
        
        request.onsuccess = () => {
          const items = request.result || [];
          this.logger.debug('从 IndexedDB 加载', { count: items.length });
          resolve(items);
        };
        
        request.onerror = () => {
          this.logger.error('IndexedDB 加载失败', request.error);
          resolve([]);
        };
      } catch (err) {
        this.logger.error('IndexedDB 读取异常', err);
        resolve([]);
      }
    });
  }
  
  /**
   * 从 localStorage 加载
   */
  private loadFromLocalStorage(): void {
    if (typeof localStorage === 'undefined') return;
    
    try {
      const data = localStorage.getItem(this.STORAGE_KEY);
      if (!data) return;
      
      const parsed = JSON.parse(data);
      if (parsed.version === this.VERSION && Array.isArray(parsed.items)) {
        // 过滤过期项
        const now = Date.now();
        this.queue = parsed.items.filter((item: RetryQueueItem) => 
          now - item.createdAt < this.MAX_ITEM_AGE &&
          item.retryCount < this.MAX_RETRIES
        );
        this.logger.info('从 localStorage 加载队列', { count: this.queue.length });
      }
    } catch (e) {
      this.logger.error('localStorage 加载失败', e);
    }
  }
  
  /**
   * 保存队列到存储
   */
  private async saveToStorage(): Promise<void> {
    const db = await this.initDb();
    
    if (db) {
      const success = await this.saveToIdb(db);
      if (success) return;
    }
    
    // 降级到 localStorage
    this.saveToLocalStorage();
  }
  
  /**
   * 同步保存（用于 beforeunload）
   */
  private saveToStorageSync(): void {
    // IndexedDB 不支持同步操作，只能保存到 localStorage
    this.saveToLocalStorage();
  }
  
  /**
   * 保存到 IndexedDB
   */
  private async saveToIdb(db: IDBDatabase): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        const transaction = db.transaction(this.DB_CONFIG.storeName, 'readwrite');
        const store = transaction.objectStore(this.DB_CONFIG.storeName);
        
        store.clear();
        
        for (const item of this.queue) {
          store.put(this.minifyItem(item));
        }
        
        transaction.oncomplete = () => {
          this.logger.debug('保存到 IndexedDB 成功', { count: this.queue.length });
          resolve(true);
        };
        
        transaction.onerror = () => {
          this.logger.error('保存到 IndexedDB 失败', transaction.error);
          resolve(false);
        };
      } catch (err) {
        this.logger.error('IndexedDB 写入异常', err);
        resolve(false);
      }
    });
  }
  
  /**
   * 保存到 localStorage
   */
  private saveToLocalStorage(): void {
    if (typeof localStorage === 'undefined') return;
    
    try {
      const data = {
        version: this.VERSION,
        items: this.queue.map(item => this.minifyItem(item)),
        savedAt: Date.now()
      };
      
      const json = JSON.stringify(data);
      
      // 检查大小
      if (json.length > SYNC_CONFIG.RETRY_QUEUE_SIZE_LIMIT_BYTES) {
        this.logger.warn('队列数据过大，触发缩减', { size: json.length });
        this.shrinkQueue();
        return;
      }
      
      localStorage.setItem(this.STORAGE_KEY, json);
    } catch (e) {
      if ((e as Error).name === 'QuotaExceededError') {
        this.logger.warn('localStorage 配额超限，触发缩减');
        this.shrinkQueue();
      } else {
        this.logger.error('localStorage 保存失败', e);
      }
    }
  }
  
  /**
   * 缩减队列（当存储空间不足时）
   */
  private shrinkQueue(): void {
    // 按创建时间排序，保留较新的一半
    this.queue.sort((a, b) => a.createdAt - b.createdAt);
    const half = Math.ceil(this.queue.length / 2);
    const removed = this.queue.splice(0, half);
    
    this.logger.info('缩减队列', { 
      removed: removed.length, 
      remaining: this.queue.length 
    });
    
    Sentry.captureMessage('RetryQueue shrunk due to quota', {
      level: 'info',
      tags: {
        removedCount: String(removed.length),
        remainingCount: String(this.queue.length)
      }
    });
    
    // 重新尝试保存
    this.saveToLocalStorage();
  }
  
  /**
   * 压缩队列项（移除不必要的数据以节省空间）
   */
  private minifyItem(item: RetryQueueItem): RetryQueueItem {
    if (item.type !== 'task') {
      return item;
    }
    
    const task = item.data as Task;
    return {
      ...item,
      data: {
        ...task,
        // 移除可重建的字段
        displayId: undefined as unknown as string,
        shortId: undefined
      }
    };
  }
}
