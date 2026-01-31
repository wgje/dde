/**
 * PersistSchedulerService - 持久化调度服务
 * 
 * 职责：
 * - 管理本地自动保存定时器
 * - 持久化状态追踪
 * - 防抖持久化调度
 * 
 * 从 SyncCoordinatorService 提取，作为 Sprint 4 技术债务修复的一部分
 */

import { Injectable, inject, signal, DestroyRef } from '@angular/core';
import { LoggerService } from './logger.service';
import { SYNC_CONFIG } from '../config';

/**
 * 持久化状态
 */
export interface PersistState {
  /** 是否正在持久化 */
  isPersisting: boolean;
  /** 是否有待处理的持久化请求 */
  hasPending: boolean;
  /** 上次持久化时间 */
  lastPersistAt: number;
  /** 是否有本地未同步的变更 */
  hasPendingLocalChanges: boolean;
  /** 上次更新类型 */
  lastUpdateType: 'content' | 'structure' | 'position';
}

/**
 * 持久化回调
 */
export interface PersistCallbacks {
  /** 保存快照回调 */
  saveSnapshot: () => void;
  /** 执行持久化回调 */
  doPersist: () => Promise<void>;
}

/**
 * 持久化调度服务
 * 
 * 管理本地自动保存和云端同步的调度
 */
@Injectable({
  providedIn: 'root'
})
export class PersistSchedulerService {
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('PersistScheduler');
  private readonly destroyRef = inject(DestroyRef);
  
  /** 持久化状态 */
  private readonly _state = signal<PersistState>({
    isPersisting: false,
    hasPending: false,
    lastPersistAt: 0,
    hasPendingLocalChanges: false,
    lastUpdateType: 'structure'
  });
  
  /** 只读状态访问器 */
  readonly state = this._state.asReadonly();
  
  /** 持久化定时器 */
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  
  /** 本地自动保存定时器 */
  private localAutosaveTimer: ReturnType<typeof setInterval> | null = null;
  
  /** 持久化回调 */
  private callbacks: PersistCallbacks | null = null;
  
  constructor() {
    this.destroyRef.onDestroy(() => {
      this.cleanup();
    });
  }
  
  /**
   * 设置持久化回调
   */
  setCallbacks(callbacks: PersistCallbacks): void {
    this.callbacks = callbacks;
  }
  
  /**
   * 启动本地自动保存
   * 
   * 保守模式核心机制：定期保存到本地，确保用户数据永不丢失
   */
  startLocalAutosave(): void {
    if (this.localAutosaveTimer) {
      this.logger.debug('本地自动保存已运行，跳过重复启动');
      return;
    }
    
    this.localAutosaveTimer = setInterval(() => {
      this.callbacks?.saveSnapshot();
    }, SYNC_CONFIG.LOCAL_AUTOSAVE_INTERVAL);
    
    this.logger.info('本地自动保存已启动', { 
      interval: `${SYNC_CONFIG.LOCAL_AUTOSAVE_INTERVAL}ms` 
    });
  }
  
  /**
   * 停止本地自动保存
   */
  stopLocalAutosave(): void {
    if (this.localAutosaveTimer) {
      clearInterval(this.localAutosaveTimer);
      this.localAutosaveTimer = null;
      this.logger.info('本地自动保存已停止');
    }
  }
  
  /**
   * 标记有本地变更待同步
   */
  markLocalChanges(updateType: 'content' | 'structure' | 'position' = 'structure'): void {
    this._state.update(s => ({
      ...s,
      hasPendingLocalChanges: true,
      lastUpdateType: updateType
    }));
  }
  
  /**
   * 清除本地变更标记
   */
  clearLocalChanges(): void {
    this._state.update(s => ({
      ...s,
      hasPendingLocalChanges: false
    }));
  }
  
  /**
   * 获取上次更新类型
   */
  getLastUpdateType(): 'content' | 'structure' | 'position' {
    return this._state().lastUpdateType;
  }
  
  /**
   * 检查是否有待处理的本地变更
   */
  hasPendingLocalChanges(): boolean {
    return this._state().hasPendingLocalChanges;
  }
  
  /**
   * 获取上次持久化时间
   */
  getLastPersistAt(): number {
    return this._state().lastPersistAt;
  }
  
  /**
   * 是否正在持久化
   */
  isPersisting(): boolean {
    return this._state().isPersisting;
  }
  
  /**
   * 调度持久化（防抖）
   * 
   * 多次调用会合并为一次执行
   */
  schedulePersist(debounceMs: number = SYNC_CONFIG.DEBOUNCE_DELAY): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
    }
    
    this._state.update(s => ({ ...s, hasPending: true }));
    
    this.persistTimer = setTimeout(async () => {
      await this.executePersist();
    }, debounceMs);
  }
  
  /**
   * 立即执行待处理的持久化
   */
  async flushPendingPersist(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    
    if (this._state().hasPending) {
      await this.executePersist();
    }
  }
  
  /**
   * 执行持久化
   */
  private async executePersist(): Promise<void> {
    if (this._state().isPersisting) {
      this.logger.debug('持久化正在进行中，跳过');
      return;
    }
    
    this._state.update(s => ({
      ...s,
      isPersisting: true,
      hasPending: false
    }));
    
    try {
      await this.callbacks?.doPersist();
      
      this._state.update(s => ({
        ...s,
        isPersisting: false,
        lastPersistAt: Date.now(),
        hasPendingLocalChanges: false
      }));
    } catch (error) {
      this.logger.error('持久化失败', error);
      
      this._state.update(s => ({
        ...s,
        isPersisting: false
      }));
    }
  }
  
  /**
   * 清理资源
   */
  private cleanup(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    
    if (this.localAutosaveTimer) {
      clearInterval(this.localAutosaveTimer);
      this.localAutosaveTimer = null;
    }
  }
}
