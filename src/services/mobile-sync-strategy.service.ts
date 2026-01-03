/**
 * MobileSyncStrategyService - 移动端同步策略服务
 * 
 * 【Stingy Hoarder Protocol】核心服务
 * 
 * 职责：
 * - 根据网络状况提供同步策略决策
 * - 管理请求合并（Batch Requests）
 * - 提供移动端优化配置
 * 
 * @see docs/plan_save.md Phase 4.5
 */

import { Injectable, inject, signal, computed, DestroyRef } from '@angular/core';
import { NetworkAwarenessService, NetworkQuality } from './network-awareness.service';
import { MOBILE_SYNC_CONFIG, SYNC_CONFIG } from '../config/sync.config';
import { LoggerService } from './logger.service';
import * as Sentry from '@sentry/angular';

/**
 * 同步策略配置
 */
export interface SyncStrategyConfig {
  /** 是否允许自动同步 */
  allowAutoSync: boolean;
  
  /** 是否允许附件同步 */
  allowAttachmentSync: boolean;
  
  /** 同步间隔（毫秒） */
  syncInterval: number;
  
  /** 是否启用 Realtime */
  enableRealtime: boolean;
  
  /** 是否启用请求批量合并 */
  batchRequests: boolean;
  
  /** 批量等待时间（毫秒） */
  batchWaitMs: number;
  
  /** 最大 payload 大小（字节） */
  maxPayloadBytes: number;
  
  /** 请求超时（毫秒） */
  requestTimeout: number;
  
  /** 重试次数 */
  retryCount: number;
}

/**
 * 批量请求项
 */
interface BatchedRequest<T = unknown> {
  id: string;
  type: 'task' | 'connection' | 'project';
  operation: 'upsert' | 'delete';
  data: T;
  projectId: string;
  timestamp: number;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

@Injectable({ providedIn: 'root' })
export class MobileSyncStrategyService {
  private readonly network = inject(NetworkAwarenessService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('MobileSyncStrategy');
  private readonly destroyRef = inject(DestroyRef);
  
  // ==================== 状态信号 ====================
  
  /** 当前同步策略配置 */
  readonly currentStrategy = computed(() => this.calculateStrategy());
  
  /** 是否处于后台 */
  readonly isBackground = signal<boolean>(false);
  
  /** 批量请求队列大小 */
  readonly batchQueueSize = signal<number>(0);
  
  // ==================== 私有状态 ====================
  
  /** 批量请求队列 */
  private batchQueue: BatchedRequest[] = [];
  
  /** 批量刷新定时器 */
  private batchFlushTimer: ReturnType<typeof setTimeout> | null = null;
  
  /** 【修复】刷新锁，防止并发刷新时竞态条件 */
  private isFlushingBatch = false;
  
  /** 批量刷新回调（由 SimpleSyncService 注册） */
  private batchFlushCallback: ((requests: BatchedRequest[]) => Promise<void>) | null = null;
  
  constructor() {
    this.initialize();
    
    this.destroyRef.onDestroy(() => {
      this.cleanup();
    });
  }
  
  /**
   * 初始化
   */
  private initialize(): void {
    // 监听页面可见性变化
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        this.isBackground.set(document.visibilityState === 'hidden');
        
        if (document.visibilityState === 'hidden') {
          this.logger.debug('页面进入后台');
          // 立即刷新批量队列
          this.flushBatchQueue();
        } else {
          this.logger.debug('页面恢复前台');
        }
      });
    }
    
    this.logger.info('移动端同步策略服务已初始化');
  }
  
  /**
   * 决定当前是否允许同步
   */
  shouldAllowSync(): boolean {
    const quality = this.network.networkQuality();
    
    // 离线不允许
    if (quality === 'offline') {
      return false;
    }
    
    // 低网络质量：仅允许手动触发
    if (quality === 'low' && MOBILE_SYNC_CONFIG.DISABLE_AUTO_SYNC_ON_LOW_QUALITY) {
      return false;
    }
    
    // 后台暂停同步
    if (MOBILE_SYNC_CONFIG.PAUSE_WHEN_BACKGROUND && this.isBackground()) {
      return false;
    }
    
    return true;
  }
  
  /**
   * 是否应强制手动同步（而非自动）
   */
  shouldForceManualSync(): boolean {
    const quality = this.network.networkQuality();
    return quality === 'low' || (this.network.isLowBattery() && !this.network.isCharging());
  }
  
  /**
   * 计算当前同步策略
   */
  private calculateStrategy(): SyncStrategyConfig {
    const quality = this.network.networkQuality();
    const dataSaver = this.network.dataSaverMode() === 'on';
    const lowBattery = this.network.isLowBattery() && !this.network.isCharging();
    
    // 基础配置
    const baseConfig: SyncStrategyConfig = {
      allowAutoSync: true,
      allowAttachmentSync: true,
      syncInterval: SYNC_CONFIG.POLLING_INTERVAL,
      enableRealtime: SYNC_CONFIG.REALTIME_ENABLED,
      batchRequests: MOBILE_SYNC_CONFIG.BATCH_REQUESTS,
      batchWaitMs: MOBILE_SYNC_CONFIG.BATCH_WAIT_MS,
      maxPayloadBytes: Infinity,
      requestTimeout: SYNC_CONFIG.CLOUD_LOAD_TIMEOUT,
      retryCount: 3
    };
    
    // 根据网络质量调整
    switch (quality) {
      case 'high':
        // WiFi/4G - 正常配置
        return {
          ...baseConfig,
          allowAttachmentSync: !this.network.isCellular() || !MOBILE_SYNC_CONFIG.DISABLE_ATTACHMENT_SYNC_ON_CELLULAR
        };
        
      case 'medium':
        // 3G - 延迟同步
        return {
          ...baseConfig,
          syncInterval: MOBILE_SYNC_CONFIG.MEDIUM_QUALITY_SYNC_DELAY,
          allowAttachmentSync: false,
          batchWaitMs: 10000,
          maxPayloadBytes: 30 * 1024, // 30 KB
        };
        
      case 'low':
        // 2G/弱网 - 仅手动同步
        return {
          ...baseConfig,
          allowAutoSync: false,
          allowAttachmentSync: false,
          enableRealtime: false,
          batchRequests: true,
          batchWaitMs: 15000,
          maxPayloadBytes: 10 * 1024, // 10 KB
          requestTimeout: MOBILE_SYNC_CONFIG.WEAK_NETWORK_TIMEOUT,
          retryCount: MOBILE_SYNC_CONFIG.WEAK_NETWORK_RETRIES
        };
        
      case 'offline':
        // 离线
        return {
          ...baseConfig,
          allowAutoSync: false,
          allowAttachmentSync: false,
          enableRealtime: false,
        };
    }
    
    // Data Saver 模式覆盖
    if (dataSaver) {
      return {
        ...baseConfig,
        enableRealtime: false,
        allowAttachmentSync: false,
        batchRequests: true,
      };
    }
    
    // 低电量模式覆盖
    if (lowBattery) {
      return {
        ...baseConfig,
        syncInterval: MOBILE_SYNC_CONFIG.LOW_BATTERY_SYNC_INTERVAL,
        enableRealtime: false,
      };
    }
    
    return baseConfig;
  }
  
  /**
   * 获取当前网络下的同步配置
   */
  getSyncConfig(): Record<string, unknown> {
    const quality = this.network.networkQuality();
    
    switch (quality) {
      case 'low':
        return {
          PAUSE_WHEN_BACKGROUND: true,
          DISABLE_ATTACHMENT_SYNC_ON_CELLULAR: true,
          MAX_PAYLOAD_ON_CELLULAR: 10 * 1024, // 10 KB
          BATCH_WAIT_MS: 10000, // 10s
        };
      case 'medium':
        return {
          PAUSE_WHEN_BACKGROUND: true,
          DISABLE_ATTACHMENT_SYNC_ON_CELLULAR: true,
          MAX_PAYLOAD_ON_CELLULAR: 30 * 1024, // 30 KB
          BATCH_WAIT_MS: 5000,
        };
      default:
        return { ...MOBILE_SYNC_CONFIG };
    }
  }
  
  // ==================== 请求批量合并 ====================
  
  /**
   * 注册批量刷新回调
   */
  registerBatchFlushCallback(callback: (requests: BatchedRequest[]) => Promise<void>): void {
    this.batchFlushCallback = callback;
    this.logger.debug('批量刷新回调已注册');
  }
  
  /**
   * 将请求加入批量队列
   */
  enqueueBatchRequest<T>(request: Omit<BatchedRequest<T>, 'resolve' | 'reject' | 'timestamp'>): Promise<T> {
    return new Promise((resolve, reject) => {
      const fullRequest: BatchedRequest<T> = {
        ...request,
        timestamp: Date.now(),
        resolve: resolve as (value: unknown) => void,
        reject
      };
      
      this.batchQueue.push(fullRequest as BatchedRequest);
      this.batchQueueSize.set(this.batchQueue.length);
      
      this.logger.debug('请求已加入批量队列', {
        type: request.type,
        operation: request.operation,
        queueSize: this.batchQueue.length
      });
      
      // 启动/重置刷新定时器
      this.scheduleBatchFlush();
    });
  }
  
  /**
   * 调度批量刷新
   */
  private scheduleBatchFlush(): void {
    if (this.batchFlushTimer) {
      clearTimeout(this.batchFlushTimer);
    }
    
    const waitMs = this.currentStrategy().batchWaitMs;
    
    this.batchFlushTimer = setTimeout(() => {
      this.flushBatchQueue();
    }, waitMs);
  }
  
  /**
   * 刷新批量队列
   */
  async flushBatchQueue(): Promise<void> {
    if (this.batchQueue.length === 0) {
      return;
    }
    
    if (!this.batchFlushCallback) {
      this.logger.warn('批量刷新回调未注册，无法刷新队列');
      return;
    }
    
    // 【修复】加锁防止并发刷新
    if (this.isFlushingBatch) {
      this.logger.debug('刷新正在进行中，跳过');
      return;
    }
    this.isFlushingBatch = true;
    
    try {
      // 循环处理：确保刷新期间新入队的请求也被处理
      while (this.batchQueue.length > 0) {
        // 取出当前所有待处理请求
        const requests = this.batchQueue.splice(0, this.batchQueue.length);
        this.batchQueueSize.set(this.batchQueue.length);
        
        if (this.batchFlushTimer) {
          clearTimeout(this.batchFlushTimer);
          this.batchFlushTimer = null;
        }
        
        this.logger.info('刷新批量队列', { count: requests.length });
        
        try {
          await this.batchFlushCallback(requests);
          
          // 全部成功，resolve 所有请求
          for (const req of requests) {
            req.resolve(req.data);
          }
        } catch (err) {
          // 失败，reject 所有请求
          this.logger.error('批量刷新失败', err);
          Sentry.captureException(err, {
            tags: { operation: 'batchFlush' },
            extra: { requestCount: requests.length }
          });
          
          for (const req of requests) {
            req.reject(err);
          }
          // 失败后不继续处理队列中的新请求，等待下次调度
          break;
        }
      }
    } finally {
      this.isFlushingBatch = false;
    }
  }
  
  /**
   * 获取网络状态摘要（用于调试）
   */
  getStatusSummary(): {
    networkQuality: NetworkQuality;
    strategy: SyncStrategyConfig;
    isBackground: boolean;
    batchQueueSize: number;
    shouldAllowSync: boolean;
  } {
    return {
      networkQuality: this.network.networkQuality(),
      strategy: this.currentStrategy(),
      isBackground: this.isBackground(),
      batchQueueSize: this.batchQueueSize(),
      shouldAllowSync: this.shouldAllowSync()
    };
  }
  
  /**
   * 清理资源
   */
  private cleanup(): void {
    if (this.batchFlushTimer) {
      clearTimeout(this.batchFlushTimer);
    }
    
    // 刷新剩余队列
    this.flushBatchQueue().catch(() => {
      // 忽略清理时的错误
    });
  }
}
