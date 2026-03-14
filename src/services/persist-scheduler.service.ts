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
  /** 上次更新类型；null 表示初始化后尚未有任何更新 */
  lastUpdateType: 'content' | 'structure' | 'position' | null;
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
    lastUpdateType: null
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
   *
   * 注：PersistSchedulerService 是 root-scoped 单例，多个调用方注册时后者覆盖前者。
   * 如发生意外覆盖，此处会记录警告。
   */
  setCallbacks(callbacks: PersistCallbacks): void {
    if (this.callbacks) {
      this.logger.warn('PersistScheduler.setCallbacks: 覆盖已有回调，请检查调用方是否重复注册');
    }
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
  getLastUpdateType(): 'content' | 'structure' | 'position' | null {
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
   *
   * 如果当前正在持久化中，等待其完成后再执行一次，
   * 而非直接跳过（避免"已在进行中则不执行"导致的数据丢失）。
   */
  async flushPendingPersist(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }

    if (this._state().hasPending || this._state().isPersisting) {
      await this.executePersist();
    }
  }

  /**
   * 执行持久化
   *
   * 修复：
   * 1. callbacks 为 null 时提前返回，不标记 lastPersistAt（避免虚假成功）
   * 2. isPersisting 时重新调度而非直接跳过（避免并发写入丢失）
   */
  private async executePersist(): Promise<void> {
    if (!this.callbacks) {
      this.logger.warn('executePersist 调用但 callbacks 未设置，跳过');
      return;
    }

    if (this._state().isPersisting) {
      // 当前正在持久化，说明有并发请求——等待当前完成后立即再执行一次
      this.logger.debug('持久化正在进行中，标记 hasPending 待下次执行');
      this._state.update(s => ({ ...s, hasPending: true }));
      return;
    }

    this._state.update(s => ({
      ...s,
      isPersisting: true,
      hasPending: false
    }));

    try {
      await this.callbacks.doPersist();

      this._state.update(s => ({
        ...s,
        isPersisting: false,
        lastPersistAt: Date.now(),
        hasPendingLocalChanges: false
      }));

      // 如果在本次持久化过程中有新的变更进来，立即再执行一次
      if (this._state().hasPending) {
        this.logger.debug('持久化完成后发现新 hasPending，立即再次执行');
        await this.executePersist();
      }
    } catch (error) {
      this.logger.error('持久化失败', error);

      // 失败时保留 hasPending = true，确保下次 schedulePersist() 触发时仍会重试，
      // 避免本次异常导致数据变更永久丢失。
      this._state.update(s => ({
        ...s,
        isPersisting: false,
        hasPending: true
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
