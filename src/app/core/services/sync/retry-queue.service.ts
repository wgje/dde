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

import { Injectable, inject, DestroyRef, signal } from '@angular/core';
import { LoggerService } from '../../../../services/logger.service';
import { ToastService } from '../../../../services/toast.service';
import { AuthService } from '../../../../services/auth.service';
import { ProjectStateService } from '../../../../services/project-state.service';
import { SYNC_CONFIG, SYNC_DURABILITY_CONFIG, CIRCUIT_BREAKER_CONFIG } from '../../../../config';
import { AUTH_CONFIG } from '../../../../config/auth.config';
import { Task, Project, Connection, BlackBoxEntry } from '../../../../models';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import { isPermanentFailureError } from '../../../../utils/permanent-failure-error';
import { isValidUUID } from '../../../../utils/validation';
import {
  isBrowserNetworkSuspendedError,
  isBrowserNetworkSuspendedWindow,
} from '../../../../utils/browser-network-suspension';
/**
 * 可重试的实体类型
 */
export type RetryableEntityType = 'task' | 'project' | 'connection' | 'blackbox';

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
  data: Task | Project | Connection | BlackBoxEntry | { id: string };
  /** 关联的项目 ID */
  projectId?: string;
  /** 重试次数 */
  retryCount: number;
  /** 创建时间戳 */
  createdAt: number;
  /** 来源用户，用于跨账号 replay 隔离 */
  sourceUserId?: string;
  /** project 级快照重放时需要继续保留的删除意图 */
  taskIdsToDelete?: string[];
}

interface LegacyRetryReviewItem {
  item: RetryQueueItem;
  reason: string;
  quarantinedAt: string;
  ownerUserId: string;
}

/**
 * 重试操作处理器接口
 * 由 SimpleSyncService 实现，提供实际的推送方法
 */
export interface RetryOperationHandler {
  pushTask(task: Task, projectId: string, sourceUserId?: string): Promise<boolean>;
  deleteTask(taskId: string, projectId: string, sourceUserId?: string): Promise<boolean>;
  pushProject(project: Project, sourceUserId?: string, taskIdsToDelete?: string[]): Promise<boolean>;
  pushConnection(connection: Connection, projectId: string, sourceUserId?: string): Promise<boolean>;
  /** 推送黑匣子条目到服务器（专注模式数据同步） */
  pushBlackBoxEntry?(entry: BlackBoxEntry): Promise<boolean>;
  isSessionExpired(): boolean;
  isOnline(): boolean;
  onProcessingStateChange(processing: boolean, pendingCount: number): void;
}

export interface RetryQueueSliceOptions {
  maxItems?: number;
  maxDurationMs?: number;
}

export interface RetryQueueSliceResult {
  processed: number;
  remaining: number;
  durationMs: number;
  completed: boolean;
}

const LEGACY_UNKNOWN_OWNER_USER_ID = '__legacy_unknown__';

/**
 * 重试队列服务
 * 
 * 管理离线操作的持久化队列、熔断器、重试循环
 */
@Injectable({
  providedIn: 'root'
})
export class RetryQueueService {
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('RetryQueue');
  private readonly toast = inject(ToastService);
  private readonly authService = inject(AuthService);
  private readonly projectState = inject(ProjectStateService);
  private readonly destroyRef = inject(DestroyRef);
  
  /** 重试队列 */
  private queue: RetryQueueItem[] = [];
  /** 当前 owner 不可见但仍需保留的其它账号条目 */
  private hiddenQueueItems: RetryQueueItem[] = [];
  
  /** IndexedDB 数据库实例 */
  private db: IDBDatabase | null = null;
  private dbInitPromise: Promise<IDBDatabase | null> | null = null;
  private idbUnsupported = false;
  
  /** IndexedDB 配置 */
  private readonly DB_CONFIG = {
    name: 'nanoflow-retry-queue',
    version: 1,
    storeName: 'offline_mutation_queue'
  };
  
  /** 最大重试次数 */
  readonly MAX_RETRIES = 5;
  
  /** localStorage 降级场景的队列上限 */
  private readonly MAX_SIZE_LOCAL = SYNC_CONFIG.MAX_RETRY_QUEUE_SIZE;
  /** IndexedDB 正常场景的队列上限（容量更高） */
  private readonly MAX_SIZE_INDEXEDDB = SYNC_CONFIG.MAX_RETRY_QUEUE_SIZE_INDEXEDDB;
  /** 当前生效的队列上限 */
  private maxQueueSize: number = this.MAX_SIZE_LOCAL;
  /** 软上限溢出倍数（防止内存无限增长） */
  private readonly MAX_QUEUE_OVERFLOW_FACTOR = 5;
  
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
  /** 入队拒绝提示冷却（防止告警风暴） */
  private readonly ENQUEUE_REJECT_COOLDOWN = 60_000;
  private lastEnqueueRejectTime = 0;
  /** 存储压力恢复探测冷却，避免频繁触发写探测 */
  private readonly STORAGE_RECOVERY_COOLDOWN = 30_000;
  private lastStorageRecoveryAttempt = 0;
  
  /** 操作处理器 */
  private operationHandler: RetryOperationHandler | null = null;
  /** 队列处理锁 */
  private isProcessingQueue = false;
  /** 当前可见队列视图代次；切账号清空时递增以作废旧处理锁 */
  private queueViewGeneration = 0;
  /** 队列内存态代次；本地新增/删除/切账号后用于作废晚到的存储加载结果 */
  private queueStateGeneration = 0;
  private lastProcessTime = 0;
  /** 队列处理超时保护（120s）—— 副作用是释放 isProcessingQueue 死锁 */
  private readonly PROCESS_TIMEOUT = 120_000;
  /** 重试循环定时器 */
  private retryLoopTimer: ReturnType<typeof setInterval> | null = null;
  /** 熔断器状态 */
  private circuitState: 'closed' | 'open' | 'half-open' = 'closed';
  private consecutiveFailures = 0;
  private circuitOpenedAt = 0;

  /** saveToStorage 防抖定时器，避免高频 IDB 写入风暴 */
  private saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly SAVE_DEBOUNCE_MS = 500;
  
  /** 持久化 key */
  private readonly STORAGE_KEY = 'nanoflow.retry-queue';
  
  /** 版本号 */
  private readonly VERSION = 1;
  private readonly LEGACY_REVIEW_STORAGE_KEY_PREFIX = 'nanoflow.retry-queue.legacy-review.';
  /** 队列压力状态 */
  readonly queuePressure = signal(false);
  readonly queuePressureReason = signal<string | null>(null);
  readonly legacyReviewCount = signal(0);
  private pressureEventCount = 0;
  private legacyReviewWarningShown = false;

  private getCurrentOwnerUserId(): string {
    return this.authService.currentUserId() ?? AUTH_CONFIG.LOCAL_MODE_USER_ID;
  }

  private resolveItemOwnerUserId(item: RetryQueueItem): string {
    return item.sourceUserId ?? AUTH_CONFIG.LOCAL_MODE_USER_ID;
  }

  private partitionItemsForCurrentOwner(items: RetryQueueItem[]): {
    visible: RetryQueueItem[];
    hidden: RetryQueueItem[];
  } {
    const currentOwnerUserId = this.getCurrentOwnerUserId();
    const visible: RetryQueueItem[] = [];
    const hidden: RetryQueueItem[] = [];

    for (const item of items) {
      if (this.resolveItemOwnerUserId(item) === currentOwnerUserId) {
        visible.push(item);
        continue;
      }

      hidden.push(item);
    }

    return { visible, hidden };
  }

  private applyLoadedItems(items: RetryQueueItem[]): void {
    const { visible, hidden } = this.partitionItemsForCurrentOwner(items);
    this.queue = visible;
    this.hiddenQueueItems = hidden;
    this.touchQueueState();
  }

  private touchQueueState(): void {
    this.queueStateGeneration += 1;
  }

  private captureStorageLoadToken(): { ownerUserId: string; queueStateGeneration: number } {
    return {
      ownerUserId: this.getCurrentOwnerUserId(),
      queueStateGeneration: this.queueStateGeneration,
    };
  }

  private isStorageLoadTokenCurrent(token: { ownerUserId: string; queueStateGeneration: number }): boolean {
    return token.ownerUserId === this.getCurrentOwnerUserId()
      && token.queueStateGeneration === this.queueStateGeneration;
  }

  private logStaleStorageLoad(token: { ownerUserId: string; queueStateGeneration: number }, stage: string): void {
    this.logger.debug('忽略过期的重试队列加载结果', {
      stage,
      expectedOwnerUserId: token.ownerUserId,
      currentOwnerUserId: this.getCurrentOwnerUserId(),
      expectedQueueStateGeneration: token.queueStateGeneration,
      currentQueueStateGeneration: this.queueStateGeneration,
    });
  }

  private sanitizeLoadedItems(items: RetryQueueItem[]): {
    safeItems: RetryQueueItem[];
    quarantinedCount: number;
  } {
    const safeItems: RetryQueueItem[] = [];
    let quarantinedCount = 0;

    for (const item of items) {
      if (!item.sourceUserId) {
        this.quarantineLegacyRetryItem(item, 'legacy 重试项缺少来源元数据，加载时已隔离');
        quarantinedCount++;
        continue;
      }

      safeItems.push(item);
    }

    return { safeItems, quarantinedCount };
  }

  private getPersistedItems(): RetryQueueItem[] {
    const merged = new Map<string, RetryQueueItem>();
    for (const item of [...this.hiddenQueueItems, ...this.queue]) {
      merged.set(item.id, item);
    }
    return Array.from(merged.values());
  }

  private removeItemsFromAllViews(itemIds: Set<string>): void {
    if (itemIds.size === 0) {
      return;
    }

    this.queue = this.queue.filter(item => !itemIds.has(item.id));
    this.hiddenQueueItems = this.hiddenQueueItems.filter(item => !itemIds.has(item.id));
    this.touchQueueState();
  }
  
  constructor() {
    // 初始化时加载队列
    this.initDb().then(() => {
      this.loadFromStorage();
    });
    
    // 【P2-19 修复】恢复熔断器状态
    this.loadCircuitState();
    this.refreshLegacyReviewCount();
    
    this.destroyRef.onDestroy(() => {
      this.stopLoop();
      // 销毁时立即刷新存储（跳过防抖）
      if (this.saveDebounceTimer) {
        clearTimeout(this.saveDebounceTimer);
        this.saveDebounceTimer = null;
      }
      void this.saveToStorageImmediate().finally(() => {
        void this.closeStorageConnections();
      });
    });
  }
  
  async closeStorageConnections(): Promise<void> {
    if (this.saveDebounceTimer) {
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
  
  // ==================== 公共 API ====================
  
  /**
   * 获取队列长度
   */
  get length(): number {
    return this.queue.length;
  }

  get pressureEvents(): number {
    return this.pressureEventCount;
  }
  
  /**
   * 获取队列副本
   */
  getItems(): RetryQueueItem[] {
    return [...this.queue];
  }

  findItemForOwner(
    type: RetryableEntityType,
    entityId: string,
    ownerUserId: string,
  ): RetryQueueItem | undefined {
    return this.getPersistedItems().find(
      item => item.type === type
        && item.data.id === entityId
        && this.resolveItemOwnerUserId(item) === ownerUserId
    );
  }
  
  /**
   * 检查队列中是否存在指定实体的待重试操作
   */
  hasEntity(type: RetryableEntityType, entityId: string): boolean {
    return this.queue.some(item => item.type === type && item.data.id === entityId);
  }

  /**
   * 移除队列中指定实体的待重试操作
   * 
   * 用于跨队列去重：当 ActionQueue 收到同一实体的新操作时，
   * RetryQueue 中较旧的重试条目已过时，应移除以避免覆盖新数据
   * 
   * @returns 是否成功移除
   */
  removeByEntity(type: RetryableEntityType, entityId: string): boolean {
    const index = this.queue.findIndex(item => item.type === type && item.data.id === entityId);
    if (index === -1) return false;

    this.queue.splice(index, 1);
    this.touchQueueState();
    this.saveToStorage();
    this.logger.debug('跨队列去重：移除 RetryQueue 中的旧条目', { type, entityId });
    return true;
  }

  /**
   * 清空队列
   */
  clear(): void {
    this.queue = [];
    this.hiddenQueueItems = [];
    this.touchQueueState();
    this.clearPressureMode();
    this.saveToStorage();
    this.logger.info('重试队列已清空');
  }

  /**
   * 仅清空当前 owner 的内存视图，不覆盖持久化中的其它账号条目。
   * 用于切账号时立即断开旧账号的可见重试项，再按新 owner 重新加载。
   */
  clearCurrentView(): void {
    this.hiddenQueueItems = this.getPersistedItems();
    this.queue = [];
    this.touchQueueState();
    this.queueViewGeneration += 1;
    this.isProcessingQueue = false;
    this.lastProcessTime = 0;
    this.refreshLegacyReviewCount();
    this.clearPressureMode();
    if (this.operationHandler) {
      try {
        this.operationHandler.onProcessingStateChange(false, 0);
      } catch (error) {
        this.logger.warn('clearCurrentView: 同步处理状态失败', error);
      }
    }
  }

  reloadFromStorageForCurrentOwner(): void {
    this.clearCurrentView();
    this.refreshLegacyReviewCount();
    void this.loadFromStorage();
  }
  
  /**
   * 添加项到队列
   * 
   * 特性：
   * - 去重：同一实体只保留最新操作
   * - 容量限制：达到上限时进入压力模式，但继续接收新写入（软上限）
   */
  add(
    type: RetryableEntityType,
    operation: RetryableOperation,
    data: Task | Project | Connection | BlackBoxEntry | { id: string },
    projectId?: string,
    sourceUserId?: string,
    taskIdsToDelete?: string[],
  ): boolean {
    return this.addInternal(type, operation, data, projectId, sourceUserId, taskIdsToDelete, 'debounced');
  }

  async addDurably(
    type: RetryableEntityType,
    operation: RetryableOperation,
    data: Task | Project | Connection | BlackBoxEntry | { id: string },
    projectId?: string,
    sourceUserId?: string,
    taskIdsToDelete?: string[],
  ): Promise<boolean> {
    const previousVisibleQueue = [...this.queue];
    const previousHiddenQueue = [...this.hiddenQueueItems];
    const accepted = this.addInternal(type, operation, data, projectId, sourceUserId, taskIdsToDelete, 'manual');
    if (!accepted) {
      return false;
    }

    const persisted = await this.persistNow();
    if (persisted) {
      return true;
    }

    this.queue = previousVisibleQueue;
    this.hiddenQueueItems = previousHiddenQueue;
    this.touchQueueState();
    this.saveToStorage();
    this.checkCapacityWarning();
    this.logger.warn('RetryQueue.addDurably: 持久化确认失败，已回滚内存队列', {
      type,
      operation,
      dataId: data.id,
      sourceUserId,
    });
    return false;
  }

  private addInternal(
    type: RetryableEntityType,
    operation: RetryableOperation,
    data: Task | Project | Connection | BlackBoxEntry | { id: string },
    projectId?: string,
    sourceUserId?: string,
    taskIdsToDelete?: string[],
    persistMode: 'debounced' | 'manual' = 'debounced',
  ): boolean {
    // 入队前校验实体 ID 格式，拦截脏数据
    if (data?.id && !isValidUUID(data.id)) {
      this.logger.warn('RetryQueue.add：拒绝非法 ID 入队', { type, id: data.id });
      return false;
    }
    this.tryRecoverQueueFullPressure();

    const currentOwnerUserId = this.getCurrentOwnerUserId();
    const targetOwnerUserId = sourceUserId ?? currentOwnerUserId;
    const targetQueue = targetOwnerUserId !== currentOwnerUserId
      ? this.hiddenQueueItems
      : this.queue;

    // 去重：检查是否已存在同一实体
    const existingIndex = targetQueue.findIndex(
      item => item.type === type && item.data.id === data.id && this.resolveItemOwnerUserId(item) === targetOwnerUserId
    );
    
    if (existingIndex !== -1) {
      // 更新已存在的项
      const existing = targetQueue[existingIndex];
      targetQueue[existingIndex] = {
        ...existing,
        operation,
        data,
        projectId: projectId ?? existing.projectId,
        createdAt: Date.now(),
        sourceUserId: existing.sourceUserId ?? targetOwnerUserId,
        taskIdsToDelete: taskIdsToDelete ?? existing.taskIdsToDelete,
      };
      this.touchQueueState();
      this.logger.debug('更新队列中的现有项', { 
        type, 
        operation, 
        dataId: data.id,
        retryCount: existing.retryCount,
        hidden: targetQueue === this.hiddenQueueItems,
      });
      if (persistMode === 'debounced') {
        this.saveToStorage();
      }
      this.checkCapacityWarning();
      return true;
    }

    const absoluteLimit = this.maxQueueSize * this.MAX_QUEUE_OVERFLOW_FACTOR;
    if (this.queue.length + this.hiddenQueueItems.length >= absoluteLimit) {
      this.reportEnqueueRejected(type, operation, data.id, 'absolute_limit');
      this.checkCapacityWarning();
      return false;
    }

    // 压力模式下不再直接拒绝新写入，优先保证“离线写入不丢”
    if (this.queuePressure()) {
      const reason = this.queuePressureReason() ?? 'pressure_mode';
      this.logger.warn('重试队列处于压力模式，仍继续接收新写入', {
        reason,
        queueSize: this.queue.length,
        maxSize: this.maxQueueSize
      });
      if (reason === 'queue_full') {
        this.triggerEmergencyProcessQueue('pressure_reject');
      }
    }
    
    // 容量检查
    if (this.queue.length >= this.maxQueueSize) {
      this.enterPressureMode('queue_full');
      this.logger.warn('重试队列达到软上限，进入压力模式但继续入队', {
        queueSize: this.queue.length,
        maxSize: this.maxQueueSize
      });
      this.triggerEmergencyProcessQueue('queue_full');
    }
    
    // 添加新项
    const item: RetryQueueItem = {
      id: crypto.randomUUID(),
      type,
      operation,
      data,
      projectId,
      retryCount: 0,
      createdAt: Date.now(),
      sourceUserId: targetOwnerUserId,
      taskIdsToDelete,
    };
    
    targetQueue.push(item);
    this.touchQueueState();
    if (persistMode === 'debounced') {
      this.saveToStorage();
    }

    this.logger.debug('添加到重试队列', {
      type,
      operation,
      dataId: data.id,
      hidden: targetQueue === this.hiddenQueueItems,
      targetOwnerUserId,
    });
    this.checkCapacityWarning();
    if (targetQueue === this.queue && this.queue.length >= Math.floor(this.maxQueueSize * 0.9)) {
      this.triggerEmergencyProcessQueue('high_watermark');
    }
    return true;
  }
  
  /**
   * 移除所有匹配的项
   */
  removeByEntityId(entityId: string): void {
    const originalLength = this.queue.length;
    this.queue = this.queue.filter(item => item.data.id !== entityId);
    if (this.queue.length < originalLength) {
      this.touchQueueState();
      this.saveToStorage();
    }
  }

  /** 移除指定项目相关的所有待重试项，用于冲突解决后的旧 mutation 收口 */
  removeByProjectId(projectId: string): number {
    const itemIds = new Set(
      [...this.queue, ...this.hiddenQueueItems]
        .filter(item => item.projectId === projectId || (item.type === 'project' && item.data.id === projectId))
        .map(item => item.id)
    );

    const removedCount = itemIds.size;
    if (removedCount > 0) {
      this.removeItemsFromAllViews(itemIds);
      this.saveToStorage();
    }
    return removedCount;
  }

  removeByEntities(type: RetryableEntityType, entityIds: string[]): string[] {
    const targetIds = new Set(entityIds.filter(entityId => typeof entityId === 'string' && entityId.length > 0));
    if (targetIds.size === 0) {
      return [];
    }

    const itemIds = new Set<string>();
    const removedEntityIds = new Set<string>();

    for (const item of [...this.queue, ...this.hiddenQueueItems]) {
      if (item.type !== type || !targetIds.has(item.data.id)) {
        continue;
      }

      itemIds.add(item.id);
      removedEntityIds.add(item.data.id);
    }

    if (itemIds.size > 0) {
      this.removeItemsFromAllViews(itemIds);
      this.saveToStorage();
    }

    return Array.from(removedEntityIds);
  }

  removeConnectionsReferencingTasks(projectId: string, taskIds: string[]): string[] {
    const deletedTaskIds = new Set(taskIds.filter(taskId => typeof taskId === 'string' && taskId.length > 0));
    if (deletedTaskIds.size === 0) {
      return [];
    }

    const itemIds = new Set<string>();
    const removedConnectionIds = new Set<string>();

    for (const item of [...this.queue, ...this.hiddenQueueItems]) {
      if (item.type !== 'connection' || item.projectId !== projectId) {
        continue;
      }

      const connection = item.data as Connection;
      if (!deletedTaskIds.has(connection.source) && !deletedTaskIds.has(connection.target)) {
        continue;
      }

      itemIds.add(item.id);
      removedConnectionIds.add(connection.id);
    }

    if (itemIds.size > 0) {
      this.removeItemsFromAllViews(itemIds);
      this.saveToStorage();
    }

    return Array.from(removedConnectionIds);
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
      this.touchQueueState();
      this.saveToStorage();
      this.logger.info('清理队列', { cleaned, remaining: this.queue.length });
    }
    
    return cleaned;
  }
  
  /**
   * 检查队列容量警告（分层预警 + 满载强制处理 + 卡死检测）
   * 
   * 分层策略：
   * - 70%: 仅日志记录
   * - 85%: warning toast
   * - 95%: error toast（严重告警）
   */
  checkCapacityWarning(): void {
    const currentSize = this.queue.length;
    const threshold = Math.floor(this.maxQueueSize * this.WARNING_THRESHOLD);
    const now = Date.now();
    
    // 低于阈值，恢复正常状态
    if (currentSize < threshold) {
      if (this.lastWarningPercent > 0) {
        this.lastWarningPercent = 0;
        this.logger.info('队列容量恢复正常', { currentSize, maxSize: this.maxQueueSize });
      }
      this.tryRecoverQueueFullPressure(true);
      return;
    }
    
    const percentUsed = Math.round((currentSize / this.maxQueueSize) * 100);
    
    // 90% 满载时触发强制处理（含卡死检测）
    if (percentUsed >= 90 && this.operationHandler?.isOnline()) {
      if (this.isProcessingQueue) {
        const duration = now - this.lastProcessTime;
        if (duration > 120_000) {
          this.logger.warn('processQueue 卡死，强制重置', { percentUsed, duration });
          this.isProcessingQueue = false;
          try {
            this.operationHandler.onProcessingStateChange(false, this.queue.length);
          } catch (error) {
            this.logger.warn('卡死恢复时回写处理状态失败', error);
          }
        }
      } else {
        this.processQueue();
      }
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
      maxSize: this.maxQueueSize,
      percentUsed,
      typeBreakdown: this.getTypeBreakdown()
    };
    
    // 分层预警
    if (percentUsed >= 95) {
      this.logger.error('RetryQueue 即将满载', diagnostics);
      if (cooldownPassed) {
        this.toast.error(
          '同步队列即将满载',
          '请尽快恢复网络连接，否则新操作可能无法入队',
          { duration: 30_000 }
        );
      }
      this.sentryLazyLoader.captureMessage('RetryQueue at 95% capacity', {
        level: 'error',
        tags: { operation: 'queueCapacityCheck', percentUsed: String(percentUsed) },
        extra: diagnostics
      });
    } else if (percentUsed >= 85) {
      this.logger.warn('RetryQueue 接近上限', diagnostics);
      if (cooldownPassed) {
        this.toast.warning(
          '同步队列接近上限',
          `已使用 ${percentUsed}%，请尽快连接网络`,
          { duration: 10_000 }
        );
      }
      this.sentryLazyLoader.captureMessage('RetryQueue capacity warning', {
        level: 'warning',
        tags: { operation: 'queueCapacityCheck', percentUsed: String(percentUsed) },
        extra: diagnostics
      });
    } else if (percentUsed >= 70) {
      // 70%：仅日志记录
      this.logger.warn('RetryQueue 容量偏高', diagnostics);
    }
  }

  private enterPressureMode(reason: string): void {
    if (this.queuePressure() && this.queuePressureReason() === reason) {
      return;
    }
    this.queuePressure.set(true);
    this.queuePressureReason.set(reason);
    this.pressureEventCount += 1;
    this.sentryLazyLoader.setTag('retry_queue_pressure', 'true');
    this.sentryLazyLoader.setContext('retry_queue_pressure', {
      reason,
      queue_size: this.queue.length,
      max_size: this.maxQueueSize,
      pressure_events: this.pressureEventCount
    });
  }

  private clearPressureMode(): void {
    if (!this.queuePressure()) {
      return;
    }
    this.queuePressure.set(false);
    this.queuePressureReason.set(null);
    this.sentryLazyLoader.setTag('retry_queue_pressure', 'false');
  }

  private tryRecoverQueueFullPressure(force = false): void {
    if (!this.queuePressure()) {
      return;
    }
    const pressureReason = this.queuePressureReason();
    if (!pressureReason) {
      return;
    }

    if (pressureReason === 'queue_full') {
      const releaseThreshold = force
        ? Math.floor(this.maxQueueSize * this.WARNING_THRESHOLD)
        : this.maxQueueSize - 1;
      if (this.queue.length <= releaseThreshold) {
        this.clearPressureMode();
      }
      return;
    }

    if (!pressureReason.startsWith('storage_') || typeof localStorage === 'undefined') {
      return;
    }

    const now = Date.now();
    if (!force && now - this.lastStorageRecoveryAttempt < this.STORAGE_RECOVERY_COOLDOWN) {
      return;
    }
    this.lastStorageRecoveryAttempt = now;

    if (!this.isLocalStorageWritable()) {
      return;
    }

    this.saveToLocalStorage();
    if (!this.queuePressure()) {
      this.logger.info('存储压力已恢复，重试队列重新开放入队', { pressureReason });
    }
  }

  private isLocalStorageWritable(): boolean {
    const probeKey = `${this.STORAGE_KEY}.probe`;
    try {
      localStorage.setItem(probeKey, '1');
      localStorage.removeItem(probeKey);
      return true;
    } catch {
      return false;
    }
  }

  private reportEnqueueRejected(
    type: RetryableEntityType,
    operation: RetryableOperation,
    dataId: string,
    reason: string
  ): void {
    this.logger.warn('队列拒绝入队', {
      type,
      operation,
      dataId,
      reason,
      queueSize: this.queue.length,
      maxSize: this.maxQueueSize
    });
    const now = Date.now();
    const shouldNotify = now - this.lastEnqueueRejectTime > this.ENQUEUE_REJECT_COOLDOWN;
    if (!shouldNotify) {
      return;
    }
    this.lastEnqueueRejectTime = now;
    const isStoragePressure = reason.startsWith('storage_');
    this.toast.warning(
      isStoragePressure ? '同步队列压力过大' : '同步队列已满',
      isStoragePressure
        ? '新操作暂未入队，请释放浏览器存储空间后重试'
        : '新操作暂未入队，请恢复网络后重试',
      { duration: 8000 }
    );
    this.sentryLazyLoader.captureMessage('RetryQueue enqueue rejected', {
      level: 'warning',
      tags: {
        queueSize: String(this.queue.length),
        dropPolicy: SYNC_DURABILITY_CONFIG.DROP_POLICY,
        reason
      }
    });
  }

  private triggerEmergencyProcessQueue(trigger: 'queue_full' | 'pressure_reject' | 'high_watermark'): void {
    if (!this.operationHandler?.isOnline() || this.isProcessingQueue || this.queue.length === 0) {
      return;
    }
    this.logger.info('触发紧急队列处理', {
      trigger,
      queueSize: this.queue.length,
      maxSize: this.maxQueueSize
    });
    void this.processQueue();
  }
  
  /**
   * 获取队列容量使用百分比（0-100）
   * 用于同步状态面板展示队列健康度
   */
  getCapacityPercent(): number {
    if (this.maxQueueSize === 0) return 0;
    return Math.round((this.queue.length / this.maxQueueSize) * 100);
  }

  /**
   * 获取队列中各类型项的数量统计
   */
  getTypeBreakdown(): Record<string, number> {
    const breakdown: Record<string, number> = { task: 0, project: 0, connection: 0, blackbox: 0 };
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
  
  // ==================== 操作处理器 ====================
  
  /** 设置操作处理器（由 SimpleSyncService 调用） */
  setOperationHandler(handler: RetryOperationHandler): void {
    this.operationHandler = handler;
    
    // 【Bug Fix 2026-03-22】设置处理器后，同步已加载的队列长度到 SyncState
    // 原因：loadFromStorage 在构造函数中异步执行，可能在 handler 设置前完成，
    // 导致 SyncState.pendingCount 与 RetryQueue.length 不一致，UI 在同步中/待同步间闪烁
    if (this.queue.length > 0) {
      try {
        handler.onProcessingStateChange(false, this.queue.length);
        this.logger.debug('setOperationHandler: 同步队列长度到 SyncState', { queueLength: this.queue.length });
      } catch (error) {
        this.logger.warn('setOperationHandler: 同步队列长度失败', error);
      }
    }
  }

  private getLegacyReviewStorageKey(ownerUserId = this.authService.currentUserId() ?? AUTH_CONFIG.LOCAL_MODE_USER_ID): string {
    return `${this.LEGACY_REVIEW_STORAGE_KEY_PREFIX}${ownerUserId}`;
  }

  private resolveLegacyReviewOwnerUserId(item: RetryQueueItem): string {
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

  private quarantineLegacyRetryItem(item: RetryQueueItem, reason: string): void {
    const ownerUserId = this.resolveLegacyReviewOwnerUserId(item);
    const record: LegacyRetryReviewItem = {
      item: { ...item },
      reason,
      quarantinedAt: new Date().toISOString(),
      ownerUserId,
    };

    if (typeof localStorage !== 'undefined') {
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
      }
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
  }
  
  // ==================== 熔断器 ====================
  
  /** 【P2-19 修复】从 sessionStorage 恢复熔断器状态 */
  private readonly CIRCUIT_STORAGE_KEY = 'nanoflow.circuit-breaker';
  
  private loadCircuitState(): void {
    try {
      const stored = sessionStorage.getItem(this.CIRCUIT_STORAGE_KEY);
      if (stored) {
        const { state, openedAt, failures } = JSON.parse(stored);
        if (state === 'open' || state === 'half-open') {
          this.circuitState = state;
          this.circuitOpenedAt = openedAt ?? 0;
          this.consecutiveFailures = failures ?? 0;
        }
      }
    } catch { /* ignore */ }
  }
  
  private saveCircuitState(): void {
    try {
      sessionStorage.setItem(this.CIRCUIT_STORAGE_KEY, JSON.stringify({
        state: this.circuitState,
        openedAt: this.circuitOpenedAt,
        failures: this.consecutiveFailures,
      }));
    } catch { /* ignore */ }
  }
  
  /**
   * 从 Error 对象推断错误类型（用于未携带 errorType 的异常）
   */
  private classifyErrorType(error: Error): string {
    if (isBrowserNetworkSuspendedError(error)) {
      return 'BrowserNetworkSuspendedError';
    }

    const msg = (error.message || '').toLowerCase();
    if (msg.includes('failed to fetch') || msg.includes('network')) return 'NetworkError';
    if (msg.includes('timeout') || msg.includes('timed out')) return 'NetworkTimeoutError';
    if (msg.includes('504')) return 'GatewayError';
    if (msg.includes('503')) return 'ServiceUnavailableError';
    if (msg.includes('offline') || msg.includes('no connection')) return 'NetworkError';
    return 'UnknownError';
  }
  
  checkCircuitBreaker(): boolean {
    if (this.circuitState === 'closed') return true;
    if (this.circuitState === 'open') {
      const elapsed = Date.now() - this.circuitOpenedAt;
      if (elapsed >= CIRCUIT_BREAKER_CONFIG.RECOVERY_TIME) {
        this.circuitState = 'half-open';
        this.saveCircuitState();
        this.logger.info('Circuit Breaker: 进入半开状态');
        return true;
      }
      return false;
    }
    return true;
  }

  recordCircuitSuccess(): void {
    if (this.circuitState === 'half-open') {
      this.circuitState = 'closed';
      this.consecutiveFailures = 0;
      this.saveCircuitState();
      this.logger.info('Circuit Breaker: 恢复正常');
    } else {
      this.consecutiveFailures = 0;
    }
  }

  recordCircuitFailure(errorType: string): void {
    if (!CIRCUIT_BREAKER_CONFIG.TRIGGER_ERROR_TYPES.includes(errorType)) return;
    this.consecutiveFailures++;
    if (this.circuitState === 'half-open') {
      this.circuitState = 'open';
      this.circuitOpenedAt = Date.now();
      this.saveCircuitState();
      this.logger.warn('Circuit Breaker: 半开状态失败，重新熔断');
      return;
    }
    if (this.consecutiveFailures >= CIRCUIT_BREAKER_CONFIG.FAILURE_THRESHOLD) {
      this.circuitState = 'open';
      this.circuitOpenedAt = Date.now();
      this.saveCircuitState();
      this.logger.warn(`Circuit Breaker: 触发熔断，连续失败 ${this.consecutiveFailures} 次`);
    }
  }
  
  // ==================== 队列处理循环 ====================
  
  /** 启动重试循环 */
  startLoop(intervalMs: number): void {
    this.stopLoop();
    this.retryLoopTimer = setInterval(() => {
      if (this.operationHandler?.isSessionExpired()) return;
      if (this.operationHandler?.isOnline() && this.queue.length > 0) {
        this.processQueue();
      }
    }, intervalMs);
  }
  
  /** 停止重试循环 */
  stopLoop(): void {
    if (this.retryLoopTimer) {
      clearInterval(this.retryLoopTimer);
      this.retryLoopTimer = null;
    }
  }
  
  /**
   * 处理重试队列（兼容入口）
   * 无参数时按历史语义尽量处理当前可处理项；有 maxItems 时限制处理条数。
   */
  async processQueue(maxItems?: number): Promise<void> {
    await this.processQueueSlice({
      maxItems: typeof maxItems === 'number' && maxItems > 0 ? maxItems : undefined
    });
  }

  /**
   * 按“条数 + 时间预算”切片处理队列，避免恢复路径阻塞主线程。
   */
  async processQueueSlice(options: RetryQueueSliceOptions = {}): Promise<RetryQueueSliceResult> {
    const sliceStartedAt = Date.now();
    const processGeneration = this.queueViewGeneration;
    const maxItems = typeof options.maxItems === 'number' && options.maxItems > 0
      ? options.maxItems
      : Number.POSITIVE_INFINITY;
    const maxDurationMs = typeof options.maxDurationMs === 'number' && options.maxDurationMs > 0
      ? options.maxDurationMs
      : Number.POSITIVE_INFINITY;

    // 【2026-03-23 修复】网络不可用或熔断器打开时，跳过处理避免无效重试风暴
    if (!this.operationHandler?.isOnline() || !this.checkCircuitBreaker()) {
      return {
        processed: 0,
        remaining: this.queue.length,
        durationMs: Date.now() - sliceStartedAt,
        completed: true
      };
    }

    if (isBrowserNetworkSuspendedWindow()) {
      this.logger.debug('浏览器网络挂起窗口内暂停重试切片', {
        remainingCount: this.queue.length,
      });
      return {
        processed: 0,
        remaining: this.queue.length,
        durationMs: Date.now() - sliceStartedAt,
        completed: false
      };
    }

    if (this.isProcessingQueue || this.queue.length === 0 || !this.operationHandler || this.operationHandler.isSessionExpired()) {
      // 【2026-02-15 修复】处理锁超时保护：如果上次处理已超过 120s 仍未释放锁，强制释放
      if (this.isProcessingQueue && this.lastProcessTime > 0 && (Date.now() - this.lastProcessTime > this.PROCESS_TIMEOUT)) {
        this.logger.warn('processQueueSlice 处理锁超时，强制释放', {
          lastProcessTime: this.lastProcessTime,
          elapsed: Date.now() - this.lastProcessTime
        });
        this.isProcessingQueue = false;
        // 【2026-03-23 修复】释放锁后检查网络和熔断状态，避免离线时立即递归重试
        if (!this.operationHandler?.isOnline() || !this.checkCircuitBreaker()) {
          this.logger.info('锁释放后网络不可用或熔断器打开，跳过重试');
          return {
            processed: 0,
            remaining: this.queue.length,
            durationMs: Date.now() - sliceStartedAt,
            completed: true
          };
        }
        return this.processQueueSlice(options);
      }
      return {
        processed: 0,
        remaining: this.queue.length,
        durationMs: Date.now() - sliceStartedAt,
        completed: true
      };
    }

    this.isProcessingQueue = true;
    this.lastProcessTime = Date.now();
    
    // 【2026-03-20 优化】延迟设置 isSyncing 状态
    // 只有当实际发起网络请求时才设置 isSyncing = true，避免空转检查导致 UI 频繁闪烁
    let hasNotifiedSyncStart = false;
    
    const notifySyncStartOnce = () => {
      if (!hasNotifiedSyncStart && this.operationHandler) {
        hasNotifiedSyncStart = true;
        try {
          this.operationHandler.onProcessingStateChange(true, this.queue.length);
        } catch (error) {
          this.logger.warn('onProcessingStateChange(true) 回调失败', error);
        }
      }
    };

    try {
      const sortedItems = [...this.queue].sort((a, b) => {
        const order: Record<string, number> = { project: 0, task: 1, connection: 2, blackbox: 3 };
        return order[a.type] - order[b.type];
      });

      const now = Date.now();
      const expiredIds = new Set<string>();
      const validItems: RetryQueueItem[] = [];
      for (const item of sortedItems) {
        if (now - item.createdAt > this.MAX_ITEM_AGE) {
          expiredIds.add(item.id);
        } else {
          validItems.push(item);
        }
      }
      if (expiredIds.size > 0) {
        this.queue = this.queue.filter(item => !expiredIds.has(item.id));
        this.touchQueueState();
        this.saveToStorage();
        this.logger.info('清理过期队列项', { expiredCount: expiredIds.size });
      }

      let successCount = 0;
      const processedIds = new Set<string>();
      let exceededCount = 0;
      let processedCount = 0;
      let stoppedByBudget = false;

      for (const item of validItems) {
        if (processedCount >= maxItems || (Date.now() - sliceStartedAt >= maxDurationMs && processedCount > 0)) {
          stoppedByBudget = true;
          break;
        }

        processedCount++;

        if (!this.queue.some(queueItem => queueItem.id === item.id)) {
          continue;
        }

        if ((item.type === 'task' || item.type === 'connection') && !item.projectId) {
          processedIds.add(item.id);
          continue;
        }

        if (item.data?.id && !isValidUUID(item.data.id)) {
          this.logger.warn('队列中发现非法 ID，自动移除', { type: item.type, id: item.data.id });
          processedIds.add(item.id);
          continue;
        }

        const currentUserId = this.authService.currentUserId();
        if (item.sourceUserId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
          this.quarantineLegacyRetryItem(item, 'legacy local-user 重试项禁止自动上云');
          processedIds.add(item.id);
          continue;
        }
        if (item.sourceUserId && currentUserId && item.sourceUserId !== currentUserId) {
          this.quarantineLegacyRetryItem(
            item,
            `跨账号重试项来源 ${item.sourceUserId} 与当前账号 ${currentUserId} 不匹配`
          );
          processedIds.add(item.id);
          continue;
        }
        if (!item.sourceUserId) {
          this.quarantineLegacyRetryItem(item, 'legacy 重试项缺少来源元数据，无法安全判断归属');
          processedIds.add(item.id);
          continue;
        }

        // 【2026-03-20 优化】首次实际处理项目时才通知 UI 进入同步状态
        notifySyncStartOnce();

        let success = false;
        let deferredByBrowserSuspension = false;
        try {
          if (item.type === 'task') {
            success = item.operation === 'upsert'
              ? await this.operationHandler.pushTask(item.data as Task, item.projectId!, item.sourceUserId)
              : await this.operationHandler.deleteTask(item.data.id, item.projectId!, item.sourceUserId);
          } else if (item.type === 'project') {
            success = await this.operationHandler.pushProject(item.data as Project, item.sourceUserId, item.taskIdsToDelete);
          } else if (item.type === 'connection') {
            success = await this.operationHandler.pushConnection(item.data as Connection, item.projectId!, item.sourceUserId);
          } else if (item.type === 'blackbox') {
            if (this.operationHandler.pushBlackBoxEntry) {
              success = await this.operationHandler.pushBlackBoxEntry(item.data as BlackBoxEntry);
            }
          }
        } catch (e) {
          if (isPermanentFailureError(e)) {
            this.logger.warn('永久失败，从队列移除', { type: item.type, id: item.data.id, error: (e as Error).message });
            processedIds.add(item.id);
            continue;
          }
          if (isBrowserNetworkSuspendedError(e) || isBrowserNetworkSuspendedWindow()) {
            deferredByBrowserSuspension = true;
            this.logger.info('浏览器网络挂起，保留当前重试项等待恢复', {
              type: item.type,
              id: item.data.id,
            });
          } else {
          // 【2026-03-23 修复】网络类错误记录到熔断器，触发熔断保护避免重试风暴
            const errorType = (e as { errorType?: string })?.errorType
              || this.classifyErrorType(e as Error);
            this.recordCircuitFailure(errorType);
            this.logger.error('重试失败', e);
            // 熔断器已打开时，停止处理当前批次中剩余项
            if (!this.checkCircuitBreaker()) {
              this.logger.warn('熔断器触发，停止本轮队列处理');
              break;
            }
          }
        }

        if (this.operationHandler.isSessionExpired()) {
          this.logger.info('检测到会话过期，停止本轮重试切片，保留剩余项等待恢复后重放');
          break;
        }

        if (deferredByBrowserSuspension || (!success && isBrowserNetworkSuspendedWindow())) {
          stoppedByBudget = true;
          break;
        }

        if (success) {
          if (item.type === 'project') {
            const previousVisibleQueue = [...this.queue];
            const previousHiddenQueue = [...this.hiddenQueueItems];
            this.removeItemsFromAllViews(new Set([item.id]));
            const persistedRemoval = await this.persistNow();
            if (!persistedRemoval) {
              this.queue = previousVisibleQueue;
              this.hiddenQueueItems = previousHiddenQueue;
              this.touchQueueState();
              this.checkCapacityWarning();
              this.logger.warn('项目重试项移除未能完成持久化确认，保留在 RetryQueue 中等待后续回放', {
                projectId: item.data.id,
                sourceUserId: item.sourceUserId,
              });
              stoppedByBudget = true;
              break;
            }

            successCount++;
            this.recordCircuitSuccess();
            continue;
          }

          successCount++;
          processedIds.add(item.id);
          this.recordCircuitSuccess();
          continue;
        }

        item.retryCount++;
        this.touchQueueState();
        if (item.retryCount >= this.MAX_RETRIES) {
          processedIds.add(item.id);
          exceededCount++;
        }
      }

      if (exceededCount > 0) {
        this.logger.warn('重试次数超限，移除项目', { count: exceededCount });
        this.toast.error('部分数据同步失败，请检查网络连接');
      }

      if (processedIds.size > 0) {
        // 中文注释：切账号期间转入 hidden 的 in-flight 条目也必须同步收口，避免旧 owner 再次 replay。
        this.removeItemsFromAllViews(processedIds);
      }

      const durationMs = Date.now() - sliceStartedAt;
      if (processedCount > 0) {
        this.logger.info('processQueueSlice 完成', {
          processedCount,
          successCount,
          expiredCount: expiredIds.size,
          remainingCount: this.queue.length,
          maxItems: Number.isFinite(maxItems) ? maxItems : null,
          maxDurationMs: Number.isFinite(maxDurationMs) ? maxDurationMs : null,
          durationMs,
          stoppedByBudget
        });
      }

      this.saveToStorage();
      this.checkCapacityWarning();

      return {
        processed: processedCount,
        remaining: this.queue.length,
        durationMs,
        completed: !stoppedByBudget
      };
    } catch (error) {
      this.logger.error('processQueueSlice 发生未捕获异常', error);
      this.sentryLazyLoader.captureException(error, {
        tags: {
          operation: 'retryQueue.processQueueSlice'
        },
        extra: {
          queueSize: this.queue.length
        }
      });
      return {
        processed: 0,
        remaining: this.queue.length,
        durationMs: Date.now() - sliceStartedAt,
        completed: false
      };
    } finally {
      if (processGeneration === this.queueViewGeneration) {
        this.isProcessingQueue = false;
      }
      // 【2026-03-20 优化】只有在实际通知了同步开始时才通知同步结束
      // 避免未发起任何网络请求的空转也触发状态切换
      if (hasNotifiedSyncStart && processGeneration === this.queueViewGeneration) {
        try {
          this.operationHandler.onProcessingStateChange(false, this.queue.length);
        } catch (error) {
          this.logger.warn('onProcessingStateChange(false) 回调失败', error);
        }
      }
    }
  }
  
  // ==================== IndexedDB 支持 ====================
  
  /**
   * 初始化 IndexedDB
   */
  private async initDb(): Promise<IDBDatabase | null> {
    if (this.db) return this.db;
    if (this.idbUnsupported) return null;
    
    if (!this.dbInitPromise) {
      this.dbInitPromise = new Promise((resolve) => {
        let settled = false;
        const finalize = (db: IDBDatabase | null) => {
          if (settled) return;
          settled = true;
          resolve(db);
        };

        if (typeof indexedDB === 'undefined') {
          this.logger.warn('IndexedDB 不可用，将使用 localStorage');
          this.idbUnsupported = true;
          this.dbInitPromise = null;
          finalize(null);
          return;
        }
        
        try {
          const request = indexedDB.open(this.DB_CONFIG.name, this.DB_CONFIG.version);

          request.onblocked = () => {
            this.logger.warn('IndexedDB 打开被阻塞，暂时降级到 localStorage');
            this.dbInitPromise = null;
            finalize(null);
          };
          
          request.onerror = () => {
            this.logger.warn('IndexedDB 打开失败，降级到 localStorage', request.error);
            this.dbInitPromise = null;
            finalize(null);
          };
          
          request.onsuccess = () => {
            this.db = request.result;
            this.maxQueueSize = this.MAX_SIZE_INDEXEDDB;
            this.logger.info('IndexedDB 初始化成功');
            finalize(request.result);
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
          this.dbInitPromise = null;
          finalize(null);
        }
      });
    }
    
    return this.dbInitPromise;
  }
  
  /**
   * 从存储加载队列（优先 IndexedDB，降级 localStorage）
   */
  private async loadFromStorage(): Promise<void> {
    const loadToken = this.captureStorageLoadToken();
    const db = await this.initDb();

    if (!this.isStorageLoadTokenCurrent(loadToken)) {
      this.logStaleStorageLoad(loadToken, 'loadFromStorage:init-db');
      return;
    }
    
    if (db) {
      const items = await this.loadFromIdb(db);

      if (!this.isStorageLoadTokenCurrent(loadToken)) {
        this.logStaleStorageLoad(loadToken, 'loadFromStorage:idb');
        return;
      }

      if (items.length > 0) {
        const { safeItems, quarantinedCount } = this.sanitizeLoadedItems(items);

        if (!this.isStorageLoadTokenCurrent(loadToken)) {
          this.logStaleStorageLoad(loadToken, 'loadFromStorage:idb-sanitized');
          return;
        }

        this.applyLoadedItems(safeItems);
        this.logger.info('从 IndexedDB 加载队列', {
          count: items.length,
          visibleCount: this.queue.length,
          hiddenCount: this.hiddenQueueItems.length,
          quarantinedCount,
          ownerUserId: this.getCurrentOwnerUserId(),
        });
        if (quarantinedCount > 0) {
          this.saveToStorage();
        }
        this.checkCapacityWarning();
        this.syncPendingCountToState();
        return;
      }
    }
    
    // 降级到 localStorage
    const localStorageItems = this.loadFromLocalStorage();

    if (!this.isStorageLoadTokenCurrent(loadToken)) {
      this.logStaleStorageLoad(loadToken, 'loadFromStorage:localStorage');
      return;
    }

    const { safeItems, quarantinedCount } = this.sanitizeLoadedItems(localStorageItems);

    if (!this.isStorageLoadTokenCurrent(loadToken)) {
      this.logStaleStorageLoad(loadToken, 'loadFromStorage:localStorage-sanitized');
      return;
    }

    this.applyLoadedItems(safeItems);
    if (quarantinedCount > 0) {
      this.saveToStorage();
    }
    this.checkCapacityWarning();
    this.syncPendingCountToState();
  }
  
  /**
   * 【Bug Fix 2026-03-22】同步队列长度到 SyncState
   * 解决 loadFromStorage 和 setOperationHandler 时序不确定导致的状态不一致
   */
  private syncPendingCountToState(): void {
    if (this.queue.length > 0 && this.operationHandler) {
      try {
        this.operationHandler.onProcessingStateChange(false, this.queue.length);
        this.logger.debug('loadFromStorage: 同步队列长度到 SyncState', { queueLength: this.queue.length });
      } catch (error) {
        this.logger.warn('loadFromStorage: 同步队列长度失败', error);
      }
    }
  }
  
  /**
   * 从 IndexedDB 加载
   */
  private async loadFromIdb(db: IDBDatabase): Promise<RetryQueueItem[]> {
    return new Promise((resolve) => {
      try {
        const transaction = db.transaction(this.DB_CONFIG.storeName, 'readwrite');
        const store = transaction.objectStore(this.DB_CONFIG.storeName);
        const request = store.getAll();
        
        request.onsuccess = () => {
          const raw = request.result || [];
          const clean: RetryQueueItem[] = [];
          const dirtyKeys: string[] = [];

          for (const item of raw) {
            if (item.data?.id && !isValidUUID(item.data.id)) {
              this.logger.warn('RetryQueue 加载：丢弃非法 ID 条目', { type: item.type, id: item.data.id });
              dirtyKeys.push(item.id);
            } else {
              clean.push(item);
            }
          }

          // 从 IDB 中物理删除脏条目
          if (dirtyKeys.length > 0) {
            console.warn('[RetryQueue] 启动清理：从 IDB 删除脏条目', dirtyKeys);
            this.logger.info('RetryQueue 加载：已过滤脏数据', { removed: dirtyKeys.length });
            try {
              const delTx = db.transaction(this.DB_CONFIG.storeName, 'readwrite');
              const delStore = delTx.objectStore(this.DB_CONFIG.storeName);
              for (const key of dirtyKeys) {
                delStore.delete(key);
              }
            } catch (delErr) {
              this.logger.error('RetryQueue：删除脏条目失败', delErr);
            }
          }

          this.logger.debug('从 IndexedDB 加载', { count: clean.length });
          resolve(clean);
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
  private loadFromLocalStorage(): RetryQueueItem[] {
    if (typeof localStorage === 'undefined') return [];
    
    try {
      const data = localStorage.getItem(this.STORAGE_KEY);
      if (!data) return [];
      
      const parsed = JSON.parse(data);
      if (parsed.version === this.VERSION && Array.isArray(parsed.items)) {
        // 过滤过期项 + 非法 ID 脏数据
        const now = Date.now();
        const items = parsed.items.filter((item: RetryQueueItem) => {
          if (now - item.createdAt >= this.MAX_ITEM_AGE) return false;
          if (item.retryCount >= this.MAX_RETRIES) return false;
          // 过滤非法 ID 的脏数据
          if (item.data?.id && !isValidUUID(item.data.id)) {
            this.logger.warn('RetryQueue localStorage 加载：丢弃非法 ID', { type: item.type, id: item.data.id });
            return false;
          }
          return true;
        });
        this.logger.info('从 localStorage 加载队列', { count: items.length });
        return items;
      }
    } catch (e) {
      this.logger.error('localStorage 加载失败', e);
    }

    return [];
  }
  
  /**
   * 保存队列到存储（防抖版）
   * 在 500ms 内的多次调用会合并为一次实际写入操作
   *
   * 【2026-02-15 修复】解决 processQueueSlice 循环中每处理一个项就触发一次
   * IndexedDB 全量序列化+写入的性能问题
   */
  private saveToStorage(): void {
    if (this.saveDebounceTimer) return; // 已有待执行的保存，跳过
    this.saveDebounceTimer = setTimeout(() => {
      this.saveDebounceTimer = null;
      void this.saveToStorageImmediate();
    }, this.SAVE_DEBOUNCE_MS);
  }

  async persistNow(): Promise<boolean> {
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
      this.saveDebounceTimer = null;
    }

    return this.saveToStorageImmediate();
  }

  /**
   * 立即保存队列到存储（无防抖）
   * 用于组件销毁/beforeunload 等关键路径
   * 【P2-17 修复】添加 catch 处理，防止未捕获的 Promise rejection
   * 注意：调用方故意不 await，采用 fire-and-forget 模式以不阻塞主线程
   */
  private async saveToStorageImmediate(): Promise<boolean> {
    try {
      const db = await this.initDb();
      
      if (db) {
        const success = await this.saveToIdb(db);
        if (success) {
          if ((this.queuePressureReason() ?? '').startsWith('storage_')) {
            this.clearPressureMode();
          }
          return true;
        }
      }
      
      // 降级到 localStorage
      return this.saveToLocalStorage();
    } catch (e) {
      this.logger.warn('saveToStorage 失败，降级到 localStorage', e);
      try {
        return this.saveToLocalStorage();
      } catch {
        // 完全静默：localStorage 也失败时只能丢弃
        return false;
      }
    }
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
        const items = this.getPersistedItems();
        
        store.clear();
        
        for (const item of items) {
          store.put(this.minifyItem(item));
        }
        
        transaction.oncomplete = () => {
          this.logger.debug('保存到 IndexedDB 成功', {
            count: items.length,
            visibleCount: this.queue.length,
            hiddenCount: this.hiddenQueueItems.length,
          });
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
  private saveToLocalStorage(): boolean {
    if (typeof localStorage === 'undefined') return false;
    
    try {
      const items = this.getPersistedItems();
      const data = {
        version: this.VERSION,
        items: items.map(item => this.minifyItem(item)),
        savedAt: Date.now()
      };
      
      const json = JSON.stringify(data);
      
      // 检查大小
      if (json.length > SYNC_CONFIG.RETRY_QUEUE_SIZE_LIMIT_BYTES) {
        this.enterPressureMode('storage_size_limit');
        this.logger.error('队列数据过大，拒绝覆盖存储以保护历史写入', {
          size: json.length,
          limit: SYNC_CONFIG.RETRY_QUEUE_SIZE_LIMIT_BYTES
        });
        this.toast.error('本地存储压力过高', '同步队列写入已冻结，请释放存储空间');
        return false;
      }
      
      localStorage.setItem(this.STORAGE_KEY, json);
      if ((this.queuePressureReason() ?? '').startsWith('storage_')) {
        this.clearPressureMode();
      }
      return true;
    } catch (e) {
      if ((e as Error).name === 'QuotaExceededError') {
        this.enterPressureMode('storage_quota_exceeded');
        this.logger.error('localStorage 配额超限，拒绝淘汰历史写入', {
          queueSize: this.queue.length
        });
        this.toast.error('存储空间不足', '同步队列写入已冻结，请清理浏览器存储后重试');
      } else {
        this.logger.error('localStorage 保存失败', e);
      }
      return false;
    }
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
        // 移除可重建的字段（displayId 是动态计算的）
        // 【P0-05 修复】保留 shortId，它是永久 ID，丢失会导致数据库覆盖为 null
        displayId: undefined as unknown as string
      }
    };
  }
}
