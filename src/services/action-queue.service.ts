import { Injectable, inject, signal, DestroyRef } from '@angular/core';
import { QUEUE_CONFIG } from '../config';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { SentryAlertService } from './sentry-alert.service';
import { extractErrorMessage } from '../utils/result';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { ActionQueueStorageService, LOCAL_QUEUE_CONFIG } from './action-queue-storage.service';
import { 
  OperationPriority, 
  TaskPayload, 
  TaskDeletePayload, 
  QueuedAction,
  EnqueueParams,
  DeadLetterItem
} from './action-queue.types';

// 重新导出类型供外部使用
export type { 
  OperationPriority, 
  ActionPayload, 
  ProjectPayload, 
  ProjectDeletePayload, 
  TaskPayload, 
  TaskDeletePayload, 
  PreferencePayload,
  QueuedAction,
  EnqueueParams,
  DeadLetterItem
} from './action-queue.types';

/**
 * 离线操作队列服务
 * 负责存储失败的变更操作，网络恢复后自动重试
 * 实现离线优先架构的可靠性保证
 * 
 * 存储/死信/网络/重试逻辑委托给 ActionQueueStorageService
 */
@Injectable({
  providedIn: 'root'
})
export class ActionQueueService {
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('ActionQueue');
  private readonly toast = inject(ToastService);
  private readonly sentryAlert = inject(SentryAlertService);
  private readonly destroyRef = inject(DestroyRef);
  readonly storage = inject(ActionQueueStorageService);
  
  /** 待处理队列 */
  readonly pendingActions = signal<QueuedAction[]>([]);
  
  /** 死信队列 — 委托给 storage */
  readonly deadLetterQueue = this.storage.deadLetterQueue;
  
  /** 是否正在处理队列 */
  readonly isProcessing = signal(false);
  
  /** 队列大小 */
  readonly queueSize = signal(0);
  
  /** 死信队列大小 — 委托给 storage */
  readonly deadLetterSize = this.storage.deadLetterSize;
  
  /** 存储失败状态 — 委托给 storage */
  readonly storageFailure = this.storage.storageFailure;
  /** 队列冻结状态（配额/存储压力） */
  readonly queueFrozen = this.storage.queueFrozen;
  
  // 【Sentry 上下文】手动同步队列状态到 Sentry
  private syncSentryContext(): void {
    const queueLength = this.pendingActions().length;
    const deadLetterCount = this.deadLetterQueue().length;
    
    this.sentryAlert.updateSyncContext({
      actionQueueLength: queueLength,
      pendingActions: queueLength,
      deadLetterCount: deadLetterCount,
    });
  }
  
  /** 处理器函数映射 */
  private processors: Map<string, (action: QueuedAction) => Promise<boolean>> = new Map();
  
  /** 队列处理生命周期回调 */
  private onQueueProcessStart: (() => void) | null = null;
  private onQueueProcessEnd: (() => void) | null = null;
  /** 压力模式通知节流 */
  private readonly QUEUE_PRESSURE_NOTICE_COOLDOWN = 60_000;
  private lastQueuePressureNoticeAt = 0;
  /** 冻结状态下尝试持久化的最小间隔 */
  private readonly FROZEN_PERSIST_RETRY_COOLDOWN = 30_000;
  private lastFrozenPersistAttemptAt = 0;
  
  constructor() {
    // 初始化 storage 上下文引用
    this.storage.init({
      dequeue: (id) => this.dequeue(id),
      syncSentryContext: () => this.syncSentryContext(),
      processQueue: () => this.processQueue(),
      pendingActions: this.pendingActions,
      queueSize: this.queueSize,
    });
    
    this.storage.loadQueueFromStorage();
    this.storage.loadDeadLetterFromStorage();
    this.storage.setupNetworkListeners();
    
    this.destroyRef.onDestroy(() => this.storage.removeNetworkListeners());
  }
  
  // ========== 公共方法 ==========
  
  /**
   * 注册操作处理器
   */
  registerProcessor(type: string, processor: (action: QueuedAction) => Promise<boolean>) {
    this.processors.set(type, processor);
    this.logger.debug('处理器已注册', { type });
  }
  
  /**
   * 验证所有必需的处理器是否已注册
   */
  validateProcessors(requiredProcessors: string[]): string[] {
    const missing = requiredProcessors.filter(type => !this.processors.has(type));
    if (missing.length > 0) {
      this.logger.error('缺少必需的处理器', { missing });
    }
    return missing;
  }
  
  /**
   * 获取已注册的处理器类型列表（用于调试）
   */
  getRegisteredProcessorTypes(): string[] {
    return Array.from(this.processors.keys());
  }
  
  /** 注册失败通知回调 */
  onFailure(callback: (item: DeadLetterItem) => void) {
    this.storage.onFailure(callback);
  }
  
  /** 注册存储失败回调（逃生模式） */
  onStorageFailure(callback: (data: { queue: QueuedAction[]; deadLetter: DeadLetterItem[] }) => void) {
    this.storage.onStorageFailure(callback);
  }
  
  /** 导出待同步数据为 JSON 并下载（逃生导出，冻结时使用） */
  downloadEscapeExport(): void {
    this.storage.downloadEscapeExport();
  }
  
  /**
   * 添加操作到队列（类型安全版本）
   * 支持优先级分级 + 智能合并
   */
  enqueue(action: EnqueueParams): string {
    if (this.storage.queueFrozen()) {
      this.logger.warn('队列处于冻结状态，改为内存兜底接收写入', {
        type: action.type,
        entityType: action.entityType,
        entityId: action.entityId,
        reason: this.storage.queueFreezeReason()
      });
      this.notifyQueuePressureOnce('同步队列存储受限', '当前写入先保存在内存中，请尽快释放浏览器存储空间');
    }

    // 设置默认优先级
    const defaultPriority: OperationPriority = 
      action.entityType === 'project' ? 'critical' :
      action.entityType === 'preference' ? 'low' : 'normal';
    
    const queuedAction: QueuedAction = {
      ...action,
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      retryCount: 0,
      priority: action.priority ?? defaultPriority
    };
    let resolvedActionId = queuedAction.id;
    let wasEnqueued = false;
    /** 智能合并导致队列缩小（如 create+delete 取消） */
    let wasMergeShrunk = false;

    this.pendingActions.update(queue => {
      const newQueue = [...queue];

      // ========== 智能合并：对同一实体的操作去重 ==========
      const existingIndex = newQueue.findIndex(a =>
        a.entityType === action.entityType &&
        a.entityId === action.entityId &&
        a.retryCount === 0
      );

      if (existingIndex !== -1) {
        const existing = newQueue[existingIndex];

        // 场景1: 队列中有delete，新操作是update/create → 忽略
        if (existing.type === 'delete' && (action.type === 'update' || action.type === 'create')) {
          this.logger.debug(`忽略已删除实体的操作`, { entityType: action.entityType, entityId: action.entityId });
          resolvedActionId = '';
          return queue;
        }

        // 场景2: 两个update → 合并为一次
        if (existing.type === 'update' && action.type === 'update') {
          this.logger.debug(`合并重复的update操作`, { entityType: action.entityType, entityId: action.entityId });
          newQueue[existingIndex] = { ...queuedAction, id: existing.id };
          resolvedActionId = existing.id;
          wasEnqueued = true;
          return newQueue;
        }

        // 场景3: create + update → 合并到create中
        if (existing.type === 'create' && action.type === 'update') {
          this.logger.debug(`合并create后的update`, { entityType: action.entityType, entityId: action.entityId });
          newQueue[existingIndex] = { ...queuedAction, type: 'create', id: existing.id };
          resolvedActionId = existing.id;
          wasEnqueued = true;
          return newQueue;
        }

        // 场景4: create + delete → 直接移除create
        if (existing.type === 'create' && action.type === 'delete') {
          this.logger.debug(`取消未同步的create操作`, { entityType: action.entityType, entityId: action.entityId });
          newQueue.splice(existingIndex, 1);
          resolvedActionId = '';
          wasMergeShrunk = true;
          return newQueue;
        }
      }

      const softLimit = LOCAL_QUEUE_CONFIG.MAX_QUEUE_SIZE;
      const absoluteLimit = softLimit * 5;
      if (newQueue.length >= absoluteLimit) {
        this.logger.error('队列达到绝对上限，拒绝新操作入队', {
          absoluteLimit,
          rejectedType: action.type,
          rejectedEntityType: action.entityType,
          rejectedEntityId: action.entityId
        });
        this.notifyQueuePressureOnce('同步队列超限', '已达保护上限，请先完成同步后再重试');
        resolvedActionId = '';
        return queue;
      }

      if (newQueue.length >= softLimit) {
        this.logger.warn('队列达到软上限，进入压力模式但继续入队', {
          softLimit,
          queueSize: newQueue.length,
          maxSize: LOCAL_QUEUE_CONFIG.MAX_QUEUE_SIZE,
          type: action.type,
          entityType: action.entityType
        });
        this.notifyQueuePressureOnce('同步队列压力较高', '仍在接收写入，建议尽快联网完成同步');
      }

      // 正常添加
      newQueue.push(queuedAction);
      wasEnqueued = true;
      return newQueue;
    });

    // 智能合并导致队列缩小时，同步 queueSize 并持久化
    if (wasMergeShrunk) {
      this.queueSize.set(this.pendingActions().length);
      this.persistQueue();
      this.syncSentryContext();
      return resolvedActionId;
    }

    if (!wasEnqueued) {
      return resolvedActionId;
    }

    this.queueSize.set(this.pendingActions().length);
    this.persistQueue();
    this.syncSentryContext();
    
    // Sentry breadcrumb
    this.sentryLazyLoader.addBreadcrumb({
      category: 'sync',
      message: `Action enqueued: ${action.type} ${action.entityType}`,
      level: 'info',
      data: {
        actionId: resolvedActionId,
        entityType: action.entityType,
        entityId: action.entityId,
        type: action.type,
        priority: queuedAction.priority,
        queueSize: this.pendingActions().length
      }
    });
    
    if (this.storage.isOnline) {
      void this.processQueue();
    }
    
    return resolvedActionId;
  }

  private notifyQueuePressureOnce(title: string, message: string): void {
    const now = Date.now();
    if (now - this.lastQueuePressureNoticeAt < this.QUEUE_PRESSURE_NOTICE_COOLDOWN) {
      return;
    }
    this.lastQueuePressureNoticeAt = now;
    this.toast.warning(title, message);
  }

  private persistQueue(): void {
    const isFrozen = this.storage.queueFrozen();
    const now = Date.now();
    if (isFrozen && now - this.lastFrozenPersistAttemptAt < this.FROZEN_PERSIST_RETRY_COOLDOWN) {
      return;
    }

    if (isFrozen) {
      this.lastFrozenPersistAttemptAt = now;
    }
    this.storage.saveQueueToStorage();
  }
  
  /**
   * 从队列中移除操作
   */
  dequeue(actionId: string) {
    this.pendingActions.update(queue => queue.filter(a => a.id !== actionId));
    this.queueSize.set(this.pendingActions().length);
    this.storage.saveQueueToStorage();
    this.syncSentryContext();
  }
  
  /**
   * 设置队列处理生命周期回调
   */
  setQueueProcessCallbacks(onStart: () => void, onEnd: () => void) {
    this.onQueueProcessStart = onStart;
    this.onQueueProcessEnd = onEnd;
  }
  
  /**
   * 处理队列中的所有操作
   * 
   * 【依赖顺序控制】
   * Create 操作必须在对应实体的 Update/Delete 操作之前成功
   */
  async processQueue(): Promise<{ processed: number; failed: number; movedToDeadLetter: number }> {
    if (this.isProcessing() || !this.storage.isOnline) {
      return { processed: 0, failed: 0, movedToDeadLetter: 0 };
    }
    
    const queueSnapshot = this.pendingActions();
    
    this.sentryLazyLoader.addBreadcrumb({
      category: 'sync',
      message: `Queue processing started`,
      level: 'info',
      data: {
        queueSize: queueSnapshot.length,
        actionTypes: queueSnapshot.map(a => `${a.entityType}:${a.type}`).join(', ')
      }
    });
    
    this.isProcessing.set(true);
    this.onQueueProcessStart?.();
    
    let processed = 0;
    let failed = 0;
    let movedToDeadLetter = 0;
    
    // 跟踪失败的 Create 操作
    const failedCreateEntities = new Set<string>();
    
    try {
      const queue = [...this.pendingActions()];

      for (const action of queue) {
        // 验证 action 仍在队列中（可能已被 dequeue 或前一次处理移除）
        if (!this.pendingActions().some(a => a.id === action.id)) {
          continue;
        }

        const entityKey = `${action.entityType}:${action.entityId}`;
        
        // 依赖顺序检查：Create 失败的实体跳过后续操作
        if (action.type !== 'create' && failedCreateEntities.has(entityKey)) {
          this.logger.debug('跳过操作：依赖的 Create 尚未成功', { actionId: action.id, type: action.type, entityKey });
          continue;
        }
        
        // 依赖顺序检查：有未处理的 Create 则跳过
        if (action.type !== 'create') {
          const hasUnprocessedCreate = queue.some(a => 
            a.entityType === action.entityType && 
            a.entityId === action.entityId && 
            a.type === 'create' &&
            a.id !== action.id
          );
          if (hasUnprocessedCreate) {
            this.logger.debug('跳过操作：队列中有未处理的 Create', { actionId: action.id, type: action.type, entityKey });
            continue;
          }
        }
        
        const processorKey = `${action.entityType}:${action.type}`;
        const processor = this.processors.get(processorKey);
        
        if (!processor) {
          this.logger.warn(`No processor registered for action type: ${processorKey} - action will remain in queue`);
          const waitTime = Date.now() - action.timestamp;
          if (waitTime > QUEUE_CONFIG.NO_PROCESSOR_TIMEOUT) {
            this.logger.warn(`Action ${action.id} has no processor and timed out (${Math.round(waitTime / 1000)}s), moving to dead letter`);
            this.storage.moveToDeadLetter(action, `无处理器且等待超时 (${Math.round(waitTime / 60000)}分钟)`);
            movedToDeadLetter++;
            if (action.type === 'create') {
              failedCreateEntities.add(entityKey);
            }
          } else if (action.retryCount > 2) {
            this.toast.warning('操作待处理', `有 ${processorKey} 类型的操作尚未处理，请稍后重试`);
          }
          failed++;
          continue;
        }
        
        try {
          const success = await processor(action);
          
          if (success) {
            this.dequeue(action.id);
            processed++;
          } else {
            const result = this.storage.handleRetry(action, 'Operation returned false');
            if (result === 'dead-letter') {
              movedToDeadLetter++;
              if (action.type === 'create') {
                failedCreateEntities.add(entityKey);
                this.storage.pauseDependentActions(action.entityType, action.entityId, queue);
              }
            }
            failed++;
          }
        } catch (error: unknown) {
          const errorMessage = extractErrorMessage(error);
          const result = this.storage.handleRetry(action, errorMessage);
          if (result === 'dead-letter') {
            movedToDeadLetter++;
            if (action.type === 'create') {
              failedCreateEntities.add(entityKey);
              this.storage.pauseDependentActions(action.entityType, action.entityId, queue);
            }
          }
          failed++;
        }
      }
    } finally {
      this.isProcessing.set(false);
      this.onQueueProcessEnd?.();
      
      this.sentryLazyLoader.addBreadcrumb({
        category: 'sync',
        message: `Queue processing completed`,
        level: processed > 0 ? 'info' : (failed > 0 ? 'warning' : 'info'),
        data: { processed, failed, movedToDeadLetter }
      });
    }
    
    return { processed, failed, movedToDeadLetter };
  }
  
  /** 清空队列 */
  clearQueue() {
    this.pendingActions.set([]);
    this.queueSize.set(0);
    this.storage.saveQueueToStorage();
    this.syncSentryContext();
  }
  
  /** 清空死信队列 */
  clearDeadLetterQueue() { this.storage.clearDeadLetterQueue(); }
  
  /** 从死信队列重试操作 */
  retryDeadLetter(itemId: string) { this.storage.retryDeadLetter(itemId); }
  
  /** 从死信队列删除操作（放弃同步） */
  dismissDeadLetter(itemId: string) { this.storage.dismissDeadLetter(itemId); }
  
  /** 获取特定实体的待处理操作 */
  getActionsForEntity(entityType: string, entityId: string): QueuedAction[] {
    return this.pendingActions().filter(
      a => a.entityType === entityType && a.entityId === entityId
    );
  }

  /**
   * 获取特定项目的所有待处理操作
   */
  getPendingActionsForProject(projectId: string): QueuedAction[] {
    return this.pendingActions().filter(action => {
      if (action.entityType === 'project' && action.entityId === projectId) {
        return true;
      }
      if (action.entityType === 'task') {
        const payload = action.payload as TaskPayload | TaskDeletePayload;
        if ('projectId' in payload && payload.projectId === projectId) {
          return true;
        }
      }
      return false;
    });
  }

  /** 检查是否有待处理的操作 */
  hasPendingActions(): boolean {
    return this.pendingActions().length > 0;
  }
  
  /** 检查是否有死信 */
  hasDeadLetters(): boolean {
    return this.storage.hasDeadLetters();
  }
  
  /** 检查指定实体是否有未完成的 Create 操作 */
  hasUncompletedCreate(entityType: string, entityId: string): boolean {
    return this.pendingActions().some(a => 
      a.entityType === entityType && 
      a.entityId === entityId && 
      a.type === 'create'
    );
  }
  
  /** 获取被阻塞的操作（等待 Create 成功） */
  getBlockedActions(): QueuedAction[] {
    const queue = this.pendingActions();
    const blocked: QueuedAction[] = [];
    
    for (const action of queue) {
      if (action.type === 'create') continue;
      
      const hasCreate = queue.some(a => 
        a.entityType === action.entityType && 
        a.entityId === action.entityId && 
        a.type === 'create'
      );
      
      if (hasCreate) {
        blocked.push(action);
      }
    }
    
    return blocked;
  }

  // ========== 状态重置 ==========
  
  /**
   * 显式重置服务状态（测试 / HMR）
   */
  reset(): void {
    this.storage.reset();
    
    this.pendingActions.set([]);
    this.queueSize.set(0);
    this.isProcessing.set(false);
    this.syncSentryContext();
    
    this.processors.clear();
    this.onQueueProcessStart = null;
    this.onQueueProcessEnd = null;
  }
}
