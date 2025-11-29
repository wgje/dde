import { Injectable, inject, signal } from '@angular/core';
import { CACHE_CONFIG } from '../config/constants';

/**
 * 操作队列项
 */
export interface QueuedAction {
  id: string;
  type: 'create' | 'update' | 'delete';
  entityType: 'project' | 'task' | 'preference';
  entityId: string;
  payload: any;
  timestamp: number;
  retryCount: number;
  lastError?: string;
}

/**
 * 操作队列配置
 */
const QUEUE_CONFIG = {
  /** 最大重试次数 */
  MAX_RETRIES: 5,
  /** 重试延迟基数（毫秒） */
  RETRY_BASE_DELAY: 1000,
  /** 队列存储键 */
  QUEUE_STORAGE_KEY: 'nanoflow.action-queue',
  /** 最大队列大小 */
  MAX_QUEUE_SIZE: 100
} as const;

/**
 * 离线操作队列服务
 * 负责存储失败的变更操作，网络恢复后自动重试
 * 实现离线优先架构的可靠性保证
 */
@Injectable({
  providedIn: 'root'
})
export class ActionQueueService {
  /** 待处理队列 */
  readonly pendingActions = signal<QueuedAction[]>([]);
  
  /** 是否正在处理队列 */
  readonly isProcessing = signal(false);
  
  /** 队列大小 */
  readonly queueSize = signal(0);
  
  /** 网络状态 */
  private isOnline = true;
  
  /** 处理器函数映射 */
  private processors: Map<string, (action: QueuedAction) => Promise<boolean>> = new Map();
  
  constructor() {
    this.loadQueueFromStorage();
    this.setupNetworkListeners();
  }
  
  // ========== 公共方法 ==========
  
  /**
   * 注册操作处理器
   * @param type 操作类型标识，如 'project:update'
   * @param processor 处理函数，返回 true 表示成功
   */
  registerProcessor(type: string, processor: (action: QueuedAction) => Promise<boolean>) {
    this.processors.set(type, processor);
  }
  
  /**
   * 添加操作到队列
   */
  enqueue(action: Omit<QueuedAction, 'id' | 'timestamp' | 'retryCount'>): string {
    const queuedAction: QueuedAction = {
      ...action,
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      retryCount: 0
    };
    
    this.pendingActions.update(queue => {
      // 限制队列大小
      let newQueue = [...queue, queuedAction];
      if (newQueue.length > QUEUE_CONFIG.MAX_QUEUE_SIZE) {
        // 移除最旧的操作
        newQueue = newQueue.slice(-QUEUE_CONFIG.MAX_QUEUE_SIZE);
      }
      return newQueue;
    });
    
    this.queueSize.set(this.pendingActions().length);
    this.saveQueueToStorage();
    
    // 如果在线，立即尝试处理
    if (this.isOnline) {
      void this.processQueue();
    }
    
    return queuedAction.id;
  }
  
  /**
   * 从队列中移除操作
   */
  dequeue(actionId: string) {
    this.pendingActions.update(queue => queue.filter(a => a.id !== actionId));
    this.queueSize.set(this.pendingActions().length);
    this.saveQueueToStorage();
  }
  
  /**
   * 处理队列中的所有操作
   */
  async processQueue(): Promise<{ processed: number; failed: number }> {
    if (this.isProcessing() || !this.isOnline) {
      return { processed: 0, failed: 0 };
    }
    
    this.isProcessing.set(true);
    let processed = 0;
    let failed = 0;
    
    try {
      const queue = [...this.pendingActions()];
      
      for (const action of queue) {
        const processorKey = `${action.entityType}:${action.type}`;
        const processor = this.processors.get(processorKey);
        
        if (!processor) {
          console.warn('No processor registered for action type:', processorKey);
          failed++;
          continue;
        }
        
        try {
          const success = await processor(action);
          
          if (success) {
            this.dequeue(action.id);
            processed++;
          } else {
            await this.handleRetry(action, 'Operation returned false');
            failed++;
          }
        } catch (error: any) {
          await this.handleRetry(action, error?.message ?? String(error));
          failed++;
        }
      }
    } finally {
      this.isProcessing.set(false);
    }
    
    return { processed, failed };
  }
  
  /**
   * 清空队列
   */
  clearQueue() {
    this.pendingActions.set([]);
    this.queueSize.set(0);
    this.saveQueueToStorage();
  }
  
  /**
   * 获取特定实体的待处理操作
   */
  getActionsForEntity(entityType: string, entityId: string): QueuedAction[] {
    return this.pendingActions().filter(
      a => a.entityType === entityType && a.entityId === entityId
    );
  }
  
  /**
   * 检查是否有待处理的操作
   */
  hasPendingActions(): boolean {
    return this.pendingActions().length > 0;
  }
  
  // ========== 私有方法 ==========
  
  /**
   * 处理重试逻辑
   */
  private async handleRetry(action: QueuedAction, error: string) {
    if (action.retryCount >= QUEUE_CONFIG.MAX_RETRIES) {
      // 超过最大重试次数，从队列移除并记录
      console.error('Action exceeded max retries, removing from queue:', {
        actionId: action.id,
        type: action.type,
        entityType: action.entityType,
        entityId: action.entityId,
        error
      });
      this.dequeue(action.id);
      return;
    }
    
    // 更新重试次数和错误信息
    this.pendingActions.update(queue => 
      queue.map(a => a.id === action.id 
        ? { ...a, retryCount: a.retryCount + 1, lastError: error }
        : a
      )
    );
    this.saveQueueToStorage();
    
    // 指数退避
    const delay = QUEUE_CONFIG.RETRY_BASE_DELAY * Math.pow(2, action.retryCount);
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  
  /**
   * 设置网络状态监听
   */
  private setupNetworkListeners() {
    if (typeof window === 'undefined') return;
    
    window.addEventListener('online', () => {
      this.isOnline = true;
      // 网络恢复时自动处理队列
      void this.processQueue();
    });
    
    window.addEventListener('offline', () => {
      this.isOnline = false;
    });
    
    this.isOnline = navigator.onLine;
  }
  
  /**
   * 保存队列到本地存储
   */
  private saveQueueToStorage() {
    if (typeof localStorage === 'undefined') return;
    
    try {
      localStorage.setItem(
        QUEUE_CONFIG.QUEUE_STORAGE_KEY,
        JSON.stringify(this.pendingActions())
      );
    } catch (e) {
      console.warn('Failed to save action queue to storage', e);
    }
  }
  
  /**
   * 从本地存储加载队列
   */
  private loadQueueFromStorage() {
    if (typeof localStorage === 'undefined') return;
    
    try {
      const saved = localStorage.getItem(QUEUE_CONFIG.QUEUE_STORAGE_KEY);
      if (saved) {
        const queue = JSON.parse(saved) as QueuedAction[];
        if (Array.isArray(queue)) {
          this.pendingActions.set(queue);
          this.queueSize.set(queue.length);
        }
      }
    } catch (e) {
      console.warn('Failed to load action queue from storage', e);
    }
  }
}
