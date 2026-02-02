/**
 * SimpleSyncService - 简化的同步服务（门面模式）
 * 
 * 核心原则（来自 agents.md）：
 * - 采用 Last-Write-Wins (LWW) 策略
 * - 用户操作 → 立即写入本地 → 后台推送到 Supabase
 * - 错误处理：失败放入 RetryQueue，网络恢复自动重试
 * 
 * 【技术债务重构】2026-02-01
 * - 从 3499 行重构为 ≤800 行门面服务
 * - 任务同步逻辑委托给 TaskSyncOperationsService
 * - 连接同步逻辑委托给 ConnectionSyncOperationsService
 * - 重试队列逻辑整合到 RetryQueueService
 * - 项目同步逻辑委托给 ProjectDataService
 */

import { Injectable, inject, signal, computed, DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { SupabaseClientService } from '../../../services/supabase-client.service';
import { LoggerService } from '../../../services/logger.service';
import { ToastService } from '../../../services/toast.service';
import { RequestThrottleService } from '../../../services/request-throttle.service';
import { ClockSyncService } from '../../../services/clock-sync.service';
import { EventBusService } from '../../../services/event-bus.service';
// 拆分的子服务
import { 
  TombstoneService, 
  RealtimePollingService,
  SessionManagerService,
  SyncOperationHelperService,
  UserPreferencesSyncService,
  ProjectDataService,
  BatchSyncService,
  TaskSyncOperationsService,
  ConnectionSyncOperationsService
} from './sync';
import { Task, Project, Connection, UserPreferences } from '../../../models';
import { ProjectRow } from '../../../models/supabase-types';
import { nowISO } from '../../../utils/date';
import { supabaseErrorToError, EnhancedError } from '../../../utils/supabase-error';
import { PermanentFailureError, isPermanentFailureError } from '../../../utils/permanent-failure-error';
import { SYNC_CONFIG, CIRCUIT_BREAKER_CONFIG, FIELD_SELECT_CONFIG, CACHE_CONFIG } from '../../../config';
import type { SupabaseClient } from '@supabase/supabase-js';
import * as Sentry from '@sentry/angular';

/**
 * 重试队列项
 */
interface RetryQueueItem {
  id: string;
  type: 'task' | 'project' | 'connection';
  operation: 'upsert' | 'delete';
  data: Task | Project | Connection | { id: string };
  projectId?: string;
  retryCount: number;
  createdAt: number;
}

/**
 * 同步状态
 */
interface SyncState {
  isSyncing: boolean;
  isOnline: boolean;
  offlineMode: boolean;
  sessionExpired: boolean;
  lastSyncTime: string | null;
  pendingCount: number;
  syncError: string | null;
  hasConflict: boolean;
  conflictData: ConflictData | null;
}

/**
 * 冲突数据
 */
interface ConflictData {
  local: Project;
  remote: Project;
  remoteData?: Project;
  projectId: string;
}

/** 远程变更回调 */
export type RemoteChangeCallback = (payload: { eventType?: string; projectId?: string } | undefined) => Promise<void>;

/** 任务变更回调 */
export type TaskChangeCallback = (payload: { eventType: string; taskId: string; projectId: string }) => void;

/** 用户偏好变更回调 */
export type UserPreferencesChangeCallback = (payload: { eventType: string; userId: string }) => void;

@Injectable({
  providedIn: 'root'
})
export class SimpleSyncService {
  private readonly supabase = inject(SupabaseClientService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('SimpleSync');
  private readonly toast = inject(ToastService);
  private readonly throttle = inject(RequestThrottleService);
  private readonly clockSync = inject(ClockSyncService);
  private readonly eventBus = inject(EventBusService);
  private readonly destroyRef = inject(DestroyRef);
  
  // 子服务注入
  private readonly tombstoneService = inject(TombstoneService);
  private readonly realtimePollingService = inject(RealtimePollingService);
  private readonly sessionManager = inject(SessionManagerService);
  private readonly syncOpHelper = inject(SyncOperationHelperService);
  private readonly userPrefsSync = inject(UserPreferencesSyncService);
  private readonly projectDataService = inject(ProjectDataService);
  private readonly batchSyncService = inject(BatchSyncService);
  private readonly taskSyncOps = inject(TaskSyncOperationsService);
  private readonly connectionSyncOps = inject(ConnectionSyncOperationsService);
  
  /**
   * 获取 Supabase 客户端
   */
  private getSupabaseClient(): SupabaseClient | null {
    if (!this.supabase.isConfigured) return null;
    try {
      return this.supabase.client();
    } catch {
      return null;
    }
  }
  
  /** 同步状态 */
  readonly syncState = signal<SyncState>({
    isSyncing: false,
    isOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
    offlineMode: false,
    sessionExpired: false,
    lastSyncTime: null,
    pendingCount: 0,
    syncError: null,
    hasConflict: false,
    conflictData: null
  });
  
  /** 兼容旧接口 */
  readonly state = this.syncState;
  
  /** 便捷 computed 属性 */
  readonly isOnline = computed(() => this.syncState().isOnline);
  readonly isSyncing = computed(() => this.syncState().isSyncing);
  readonly hasConflict = computed(() => this.syncState().hasConflict);
  readonly isLoadingRemote = signal(false);
  
  /** 重试队列 */
  private retryQueue: RetryQueueItem[] = [];
  private retryTimer: ReturnType<typeof setInterval> | null = null;
  
  /** 最后一次同步时间 */
  private lastSyncTimeByProject: Map<string, string> = new Map();
  
  /** 熔断器状态 */
  private circuitState: 'closed' | 'open' | 'half-open' = 'closed';
  private consecutiveFailures = 0;
  private circuitOpenedAt = 0;
  
  /** 配置常量 */
  private readonly MAX_RETRIES = 5;
  private readonly RETRY_INTERVAL = 5000;
  private readonly MAX_RETRY_QUEUE_SIZE = SYNC_CONFIG.MAX_RETRY_QUEUE_SIZE;
  private readonly RETRY_QUEUE_STORAGE_KEY = 'nanoflow.retry-queue';
  private readonly OFFLINE_CACHE_KEY = CACHE_CONFIG.OFFLINE_CACHE_KEY;
  
  /** 容量警告节流配置 */
  private readonly CAPACITY_WARNING_COOLDOWN = 300_000; // 5 分钟冷却
  private readonly CAPACITY_WARNING_THRESHOLD = 0.8; // 80% 触发警告
  private lastCapacityWarningTime = 0;
  private lastWarningPercent = 0;
  
  /** 
   * 队列处理锁 - 防止 processRetryQueue 并发执行
   * 【修复 2026-02-02】解决队列满载问题：之前 isSyncing 标志可能被外部重置导致并发处理
   */
  private isProcessingQueue = false;
  private lastQueueProcessTime = 0;
  
  /** 任务变更回调 */
  private taskChangeCallback: TaskChangeCallback | null = null;

  constructor() {
    // 订阅会话恢复事件
    this.eventBus.onSessionRestored$.pipe(
      takeUntilDestroyed(this.destroyRef)
    ).subscribe(() => this.resetSessionExpired());
    
    // 初始化 BatchSyncService 回调
    this.batchSyncService.setCallbacks({
      pushProject: (p, f) => this.pushProject(p, f),
      pushTask: (t, pid, s, f) => this.pushTask(t, pid, s, f),
      pushTaskPosition: (tid, x, y) => this.pushTaskPosition(tid, x, y),
      pushConnection: (c, pid, s, te, f) => this.pushConnection(c, pid, s, te, f),
      getTombstoneIds: (pid) => this.getTombstoneIds(pid),
      getConnectionTombstoneIds: (pid) => this.getConnectionTombstoneIds(pid),
      purgeTasksFromCloud: (pid, tids) => this.purgeTasksFromCloud(pid, tids),
      topologicalSortTasks: (tasks) => this.topologicalSortTasks(tasks),
      addToRetryQueue: (t, o, d, p) => this.addToRetryQueue(t, o, d as Task | Project | Connection | { id: string }, p)
    });
    
    // 初始化子服务回调
    this.initSubserviceCallbacks();
    
    // 加载重试队列并启动网络监听
    this.loadRetryQueueFromStorage();
    this.setupNetworkListeners();
    this.startRetryLoop();
    
    this.destroyRef.onDestroy(() => this.cleanup());
  }
  
  /**
   * 初始化子服务回调
   */
  private initSubserviceCallbacks(): void {
    this.taskSyncOps.setCallbacks({
      addToRetryQueue: (t, o, d, p) => this.addToRetryQueue(t, o, d, p),
      circuitBreaker: {
        check: () => this.checkCircuitBreaker(),
        recordSuccess: () => this.recordCircuitSuccess(),
        recordFailure: (et) => this.recordCircuitFailure(et)
      },
      syncStateCheck: {
        isSessionExpired: () => this.syncState().sessionExpired,
        updateLastSyncTime: () => this.state.update(s => ({ ...s, lastSyncTime: nowISO() }))
      }
    });
    
    this.connectionSyncOps.setCallbacks({
      addToRetryQueue: (t, o, d, p) => this.addToRetryQueue(t, o, d as Connection | { id: string }, p),
      syncStateCheck: {
        isSessionExpired: () => this.syncState().sessionExpired,
        updateSyncState: (u) => this.syncState.update(s => ({ ...s, ...u }))
      }
    });
  }
  
  // ==================== 网络与生命周期 ====================
  
  private setupNetworkListeners(): void {
    if (typeof window === 'undefined') return;
    
    const handleOnline = () => {
      this.logger.info('网络恢复');
      this.state.update(s => ({ ...s, isOnline: true }));
      if (this.retryQueue.length > 0) {
        this.processRetryQueue();
      }
    };
    
    const handleOffline = () => {
      this.logger.info('网络断开');
      this.state.update(s => ({ ...s, isOnline: false }));
    };
    
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    
    this.destroyRef.onDestroy(() => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    });
  }
  
  private startRetryLoop(): void {
    this.retryTimer = setInterval(() => {
      if (this.syncState().sessionExpired) return;
      if (this.state().isOnline && this.retryQueue.length > 0) {
        this.processRetryQueue();
      }
    }, this.RETRY_INTERVAL);
  }
  
  private cleanup(): void {
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
    // 【修复 2026-02-02】重置队列处理状态
    this.isProcessingQueue = false;
    this.realtimePollingService.unsubscribeFromProject();
  }
  
  flushRetryQueueSync(): void {
    this.saveRetryQueueToStorage();
    if (this.retryQueue.length > 0) {
      this.logger.info('beforeunload: 保存待处理同步项', { count: this.retryQueue.length });
    }
  }
  
  // ==================== 熔断器 ====================
  
  private checkCircuitBreaker(): boolean {
    if (this.circuitState === 'closed') return true;
    if (this.circuitState === 'open') {
      const elapsed = Date.now() - this.circuitOpenedAt;
      if (elapsed >= CIRCUIT_BREAKER_CONFIG.RECOVERY_TIME) {
        this.circuitState = 'half-open';
        this.logger.info('Circuit Breaker: 进入半开状态');
        return true;
      }
      return false;
    }
    return true;
  }

  private recordCircuitSuccess(): void {
    if (this.circuitState === 'half-open') {
      this.circuitState = 'closed';
      this.consecutiveFailures = 0;
      this.logger.info('Circuit Breaker: 恢复正常');
    } else {
      this.consecutiveFailures = 0;
    }
  }

  private recordCircuitFailure(errorType: string): void {
    if (!CIRCUIT_BREAKER_CONFIG.TRIGGER_ERROR_TYPES.includes(errorType)) return;
    
    this.consecutiveFailures++;
    
    if (this.circuitState === 'half-open') {
      this.circuitState = 'open';
      this.circuitOpenedAt = Date.now();
      this.logger.warn('Circuit Breaker: 半开状态失败，重新熔断');
      return;
    }
    
    if (this.consecutiveFailures >= CIRCUIT_BREAKER_CONFIG.FAILURE_THRESHOLD) {
      this.circuitState = 'open';
      this.circuitOpenedAt = Date.now();
      this.logger.warn(`Circuit Breaker: 触发熔断，连续失败 ${this.consecutiveFailures} 次`);
    }
  }
  
  // ==================== 任务同步（委托） ====================
  
  async pushTask(task: Task, projectId: string, skipTombstoneCheck = false, fromRetryQueue = false): Promise<boolean> {
    return this.taskSyncOps.pushTask(task, projectId, skipTombstoneCheck, fromRetryQueue);
  }
  
  async pushTaskPosition(taskId: string, x: number, y: number): Promise<boolean> {
    return this.taskSyncOps.pushTaskPosition(taskId, x, y);
  }
  
  async pullTasks(projectId: string, since?: string): Promise<Task[]> {
    return this.taskSyncOps.pullTasks(projectId, since);
  }
  
  async deleteTask(taskId: string, projectId: string): Promise<boolean> {
    return this.taskSyncOps.deleteTask(taskId, projectId);
  }
  
  async softDeleteTasksBatch(projectId: string, taskIds: string[]): Promise<number> {
    return this.taskSyncOps.softDeleteTasksBatch(projectId, taskIds);
  }
  
  async purgeTasksFromCloud(projectId: string, taskIds: string[]): Promise<boolean> {
    return this.taskSyncOps.purgeTasksFromCloud(projectId, taskIds);
  }
  
  async getTombstoneIds(projectId: string): Promise<Set<string>> {
    return this.taskSyncOps.getTombstoneIds(projectId);
  }
  
  async getTombstoneIdsWithStatus(projectId: string): Promise<{ ids: Set<string>; fromRemote: boolean; localCacheOnly: boolean; timestamp: number }> {
    return this.taskSyncOps.getTombstoneIdsWithStatus(projectId);
  }
  
  getLocalTombstones(projectId: string): Set<string> {
    return this.taskSyncOps.getLocalTombstones(projectId);
  }
  
  addLocalTombstones(projectId: string, taskIds: string[]): void {
    this.taskSyncOps.addLocalTombstones(projectId, taskIds);
  }
  
  private topologicalSortTasks(tasks: Task[]): Task[] {
    return this.taskSyncOps.topologicalSortTasks(tasks);
  }
  
  invalidateTombstoneCache(projectId: string): void {
    this.tombstoneService.invalidateCache(projectId);
  }
  
  // ==================== 连接同步（委托） ====================
  
  async pushConnection(connection: Connection, projectId: string, skipTombstoneCheck = false, skipTaskExistenceCheck = false, fromRetryQueue = false): Promise<boolean> {
    return this.connectionSyncOps.pushConnection(connection, projectId, skipTombstoneCheck, skipTaskExistenceCheck, fromRetryQueue);
  }
  
  async getConnectionTombstoneIds(projectId: string): Promise<Set<string>> {
    return this.connectionSyncOps.getConnectionTombstoneIds(projectId);
  }
  
  // ==================== 项目同步 ====================
  
  async pushProject(project: Project, fromRetryQueue = false): Promise<boolean> {
    if (this.syncState().sessionExpired) {
      this.sessionManager.handleSessionExpired('pushProject', { projectId: project.id });
    }
    
    const client = this.getSupabaseClient();
    if (!client) {
      if (!fromRetryQueue) this.addToRetryQueue('project', 'upsert', project);
      return false;
    }
    
    try {
      await this.throttle.execute(
        `push-project:${project.id}`,
        async () => {
          const { data: { session } } = await client.auth.getSession();
          const userId = session?.user?.id;
          if (!userId) {
            this.sessionManager.handleSessionExpired('pushProject.getSession', { projectId: project.id });
          }
          
          const { error } = await client
            .from('projects')
            .upsert({
              id: project.id,
              owner_id: userId,
              title: project.name,
              description: project.description,
              version: project.version || 1,
              updated_at: project.updatedAt || nowISO(),
              migrated_to_v2: true
            });
          
          if (error) throw supabaseErrorToError(error);
        },
        { priority: 'high', retries: 2 }
      );
      return true;
    } catch (e) {
      const enhanced = supabaseErrorToError(e);
      
      if (enhanced.errorType === 'VersionConflictError') {
        this.toast.warning('版本冲突', '数据已被修改，请刷新后重试');
        throw new PermanentFailureError('Version conflict', enhanced, { operation: 'pushProject', projectId: project.id });
      }
      
      if (enhanced.isRetryable && !fromRetryQueue) {
        this.addToRetryQueue('project', 'upsert', project);
      }
      return false;
    }
  }
  
  async pullProjects(since?: string): Promise<Project[]> {
    const client = this.getSupabaseClient();
    if (!client) return [];
    
    try {
      let query = client.from('projects').select(FIELD_SELECT_CONFIG.PROJECT_LIST_FIELDS);
      if (since) query = query.gt('updated_at', since);
      
      const { data, error } = await query;
      if (error) throw supabaseErrorToError(error);
      
      return (data || []).map(row => this.projectDataService.rowToProject(row as ProjectRow));
    } catch (e) {
      this.logger.error('拉取项目失败', e);
      return [];
    }
  }
  
  // ==================== 重试队列 ====================
  
  private loadRetryQueueFromStorage(): void {
    if (typeof localStorage === 'undefined') return;
    
    try {
      const stored = localStorage.getItem(this.RETRY_QUEUE_STORAGE_KEY);
      if (!stored) return;
      
      const data = JSON.parse(stored);
      if (data.items && Array.isArray(data.items)) {
        this.retryQueue = data.items;
        this.state.update(s => ({ ...s, pendingCount: this.retryQueue.length }));
        this.logger.debug('加载重试队列', { count: this.retryQueue.length });
      }
    } catch (e) {
      this.logger.warn('加载重试队列失败', e);
    }
  }
  
  private saveRetryQueueToStorage(): void {
    if (typeof localStorage === 'undefined') return;
    
    try {
      if (this.retryQueue.length === 0) {
        localStorage.removeItem(this.RETRY_QUEUE_STORAGE_KEY);
        return;
      }
      
      const data = { version: 1, items: this.retryQueue, savedAt: Date.now() };
      localStorage.setItem(this.RETRY_QUEUE_STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      this.logger.warn('保存重试队列失败', e);
    }
  }
  
  /**
   * 添加项目到重试队列
   * 
   * 【修复 2026-02-02】添加诊断日志和有效性检查
   */
  addToRetryQueue(
    type: 'task' | 'project' | 'connection',
    operation: 'upsert' | 'delete',
    data: Task | Project | Connection | { id: string },
    projectId?: string
  ): void {
    if (this.syncState().sessionExpired) return;
    
    // 【修复】验证数据有效性
    if (!data?.id) {
      this.logger.warn('addToRetryQueue: 跳过无效数据（缺少 id）', { type, operation });
      return;
    }
    
    // 【修复】task 和 connection 类型必须有 projectId
    if ((type === 'task' || type === 'connection') && !projectId) {
      this.logger.warn('addToRetryQueue: 跳过无效数据（缺少 projectId）', { type, operation, id: data.id });
      return;
    }
    
    const existingIndex = this.retryQueue.findIndex(item => item.type === type && item.data.id === data.id);
    
    if (existingIndex !== -1) {
      // 更新已存在的项（去重）
      this.retryQueue[existingIndex] = {
        ...this.retryQueue[existingIndex],
        operation,
        data,
        projectId: projectId ?? this.retryQueue[existingIndex].projectId,
        createdAt: Date.now()
      };
      // 【诊断】记录去重情况
      this.logger.debug('addToRetryQueue: 更新已存在项', { type, id: data.id, queueSize: this.retryQueue.length });
    } else {
      // 容量检查：队列满时移除最老的项
      if (this.retryQueue.length >= this.MAX_RETRY_QUEUE_SIZE) {
        const removed = this.retryQueue.shift();
        this.logger.warn('重试队列已满，移除最老的项', {
          removed: { type: removed?.type, id: removed?.data.id, retryCount: removed?.retryCount },
          newItem: { type, id: data.id },
          queueSize: this.retryQueue.length,
          isProcessingQueue: this.isProcessingQueue
        });
        Sentry.captureMessage('重试队列溢出', {
          level: 'warning',
          tags: { 
            queueSize: String(this.retryQueue.length),
            newItemType: type,
            isProcessing: String(this.isProcessingQueue)
          }
        });
      }
      
      this.retryQueue.push({
        id: crypto.randomUUID(),
        type,
        operation,
        data,
        projectId,
        retryCount: 0,
        createdAt: Date.now()
      });
    }
    
    this.state.update(s => ({ ...s, pendingCount: this.retryQueue.length }));
    this.saveRetryQueueToStorage();
    
    // 检查容量警告（带节流）
    this.checkQueueCapacityWarning();
  }
  
  /**
   * 检查队列容量并发出警告（带节流）
   * 
   * 设计：
   * - 80% 容量触发警告
   * - 5 分钟冷却防止告警风暴
   * - 每增加 10% 容量允许新的警告
   * - 90% 时触发强制处理尝试
   */
  private checkQueueCapacityWarning(): void {
    const currentSize = this.retryQueue.length;
    const threshold = Math.floor(this.MAX_RETRY_QUEUE_SIZE * this.CAPACITY_WARNING_THRESHOLD);
    const now = Date.now();
    
    // 低于阈值，恢复正常状态
    if (currentSize < threshold) {
      if (this.lastWarningPercent > 0) {
        this.lastWarningPercent = 0;
        this.logger.info('RetryQueue 容量恢复正常', { currentSize, maxSize: this.MAX_RETRY_QUEUE_SIZE });
      }
      return;
    }
    
    const percentUsed = Math.round((currentSize / this.MAX_RETRY_QUEUE_SIZE) * 100);
    const syncState = this.state();
    
    // 90% 满载时尝试强制处理
    if (percentUsed >= 90 && syncState.isOnline) {
      // 【修复 2026-02-02】使用 isProcessingQueue 检测真正的处理状态
      if (this.isProcessingQueue) {
        // 检测处理是否卡死（超过 2 分钟）
        const processingDuration = now - this.lastQueueProcessTime;
        if (processingDuration > 120_000) {
          this.logger.warn('processRetryQueue 卡死，强制重置', { 
            percentUsed, 
            processingDuration,
            isSyncing: syncState.isSyncing 
          });
          this.isProcessingQueue = false;
          this.state.update(s => ({ ...s, isSyncing: false }));
        } else {
          this.logger.debug('队列处理中，跳过强制处理', { processingDuration });
          return;
        }
      }
      
      // 【修复】如果 isSyncing 为 true 但 isProcessingQueue 为 false，说明状态不一致
      if (syncState.isSyncing && !this.isProcessingQueue) {
        this.logger.warn('isSyncing 状态不一致，重置', { percentUsed });
        this.state.update(s => ({ ...s, isSyncing: false }));
      }
      
      this.logger.info('队列接近满载，触发强制处理', { percentUsed, queueLength: currentSize });
      this.processRetryQueue();
    }
    
    // 节流检查：冷却期内且无显著增长则跳过
    const cooldownPassed = now - this.lastCapacityWarningTime > this.CAPACITY_WARNING_COOLDOWN;
    const significantIncrease = percentUsed >= this.lastWarningPercent + 10;
    
    if (!cooldownPassed && !significantIncrease) {
      return;
    }
    
    // 更新警告状态
    this.lastCapacityWarningTime = now;
    this.lastWarningPercent = percentUsed;
    
    const diagnostics = {
      currentSize,
      maxSize: this.MAX_RETRY_QUEUE_SIZE,
      percentUsed,
      isOnline: syncState.isOnline,
      isSyncing: syncState.isSyncing,
      circuitState: this.circuitState,
      retryQueueTypes: this.getQueueTypeBreakdown()
    };
    
    this.logger.warn('RetryQueue 容量警告', diagnostics);
    
    // 仅在冷却期过后显示 Toast（避免用户疲劳）
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
  }
  
  /**
   * 获取队列中各类型项的数量统计
   */
  private getQueueTypeBreakdown(): Record<string, number> {
    const breakdown: Record<string, number> = { task: 0, project: 0, connection: 0 };
    for (const item of this.retryQueue) {
      breakdown[item.type] = (breakdown[item.type] || 0) + 1;
    }
    return breakdown;
  }
  
  /**
   * 处理重试队列
   * 
   * 【修复 2026-02-02】解决 RetryQueue 持续满载问题：
   * 1. 使用独立的 isProcessingQueue 锁防止并发处理
   * 2. 在处理前清理过期项目（超过 MAX_RETRY_ITEM_AGE）
   * 3. 添加 projectId 有效性检查，防止无效项目持续重试
   * 4. 添加详细诊断日志帮助定位问题
   */
  private async processRetryQueue(): Promise<void> {
    // 【修复】使用独立锁而非 isSyncing，防止外部重置导致并发处理
    if (this.isProcessingQueue || this.retryQueue.length === 0) {
      return;
    }
    
    // 额外检查 isSyncing 作为保护层
    if (this.state().isSyncing) {
      this.logger.debug('processRetryQueue: isSyncing 为 true，跳过处理');
      return;
    }
    
    this.isProcessingQueue = true;
    this.lastQueueProcessTime = Date.now();
    this.state.update(s => ({ ...s, isSyncing: true }));
    
    const initialCount = this.retryQueue.length;
    const items = [...this.retryQueue];
    this.retryQueue = [];
    
    // 【修复】清理过期项目（超过 24 小时）
    const now = Date.now();
    const maxAge = SYNC_CONFIG.MAX_RETRY_ITEM_AGE;
    const validItems: RetryQueueItem[] = [];
    let expiredCount = 0;
    
    for (const item of items) {
      if (now - item.createdAt > maxAge) {
        expiredCount++;
        this.logger.debug('移除过期队列项', { 
          type: item.type, 
          id: item.data.id, 
          ageHours: Math.round((now - item.createdAt) / 3600000) 
        });
        continue;
      }
      validItems.push(item);
    }
    
    if (expiredCount > 0) {
      this.logger.info('清理过期队列项', { expiredCount, remainingCount: validItems.length });
    }
    
    let successCount = 0;
    let failCount = 0;
    let skipCount = 0;
    
    for (const item of validItems) {
      let success = false;
      
      try {
        // 【修复】验证必要字段存在
        if ((item.type === 'task' || item.type === 'connection') && !item.projectId) {
          this.logger.warn('跳过无效队列项（缺少 projectId）', { type: item.type, id: item.data.id });
          skipCount++;
          continue;
        }
        
        if (item.type === 'task') {
          success = item.operation === 'upsert'
            ? await this.pushTask(item.data as Task, item.projectId!, true, true)
            : await this.deleteTask(item.data.id, item.projectId!);
        } else if (item.type === 'project') {
          success = await this.pushProject(item.data as Project, true);
        } else if (item.type === 'connection') {
          success = await this.pushConnection(item.data as Connection, item.projectId!, true, true, true);
        }
        
        if (success) {
          successCount++;
        }
      } catch (e) {
        if (isPermanentFailureError(e)) {
          this.logger.warn('永久失败，移除队列项', { type: item.type, id: item.data.id });
          skipCount++;
          continue;
        }
        this.logger.error('重试失败', e);
      }
      
      if (!success) {
        item.retryCount++;
        if (item.retryCount < this.MAX_RETRIES) {
          this.retryQueue.push(item);
          failCount++;
        } else {
          this.logger.warn('重试次数超限，放弃', { type: item.type, id: item.data.id, retryCount: item.retryCount });
          // 【改进】只在首次达到上限时显示 Toast，避免用户疲劳
          if (item.retryCount === this.MAX_RETRIES) {
            this.toast.error('部分数据同步失败，请检查网络连接');
          }
        }
      }
    }
    
    // 【诊断】记录处理结果
    if (initialCount > 0) {
      this.logger.info('processRetryQueue 完成', {
        initialCount,
        successCount,
        failCount,
        skipCount,
        expiredCount,
        remainingCount: this.retryQueue.length,
        duration: Date.now() - this.lastQueueProcessTime
      });
    }
    
    this.saveRetryQueueToStorage();
    this.state.update(s => ({ ...s, isSyncing: false, pendingCount: this.retryQueue.length }));
    this.isProcessingQueue = false;
  }
  
  clearRetryQueue(): void {
    const count = this.retryQueue.length;
    this.retryQueue = [];
    this.saveRetryQueueToStorage();
    this.state.update(s => ({ ...s, pendingCount: 0 }));
    this.logger.info(`已清理 ${count} 个重试项`);
    this.toast.info(`已清理 ${count} 个待同步项`);
  }
  
  // ==================== Realtime / 轮询 ====================
  
  isRealtimeEnabled(): boolean {
    return this.realtimePollingService.isRealtimeEnabled();
  }
  
  setOnRemoteChange(callback: RemoteChangeCallback): void {
    this.realtimePollingService.setOnRemoteChange(callback);
  }

  setUserPreferencesChangeCallback(callback: UserPreferencesChangeCallback | null): void {
    this.realtimePollingService.setUserPreferencesChangeCallback(callback);
  }
  
  setRealtimeEnabled(enabled: boolean): void {
    this.realtimePollingService.setRealtimeEnabled(enabled);
  }
  
  async subscribeToProject(projectId: string, userId: string): Promise<void> {
    await this.realtimePollingService.subscribeToProject(projectId, userId);
  }
  
  async unsubscribeFromProject(): Promise<void> {
    await this.realtimePollingService.unsubscribeFromProject();
  }
  
  setRemoteChangeCallback(callback: RemoteChangeCallback): void {
    this.realtimePollingService.setOnRemoteChange(callback);
  }
  
  setTaskChangeCallback(callback: TaskChangeCallback): void {
    this.taskChangeCallback = callback;
  }
  
  async initRealtimeSubscription(userId: string): Promise<void> {
    this.logger.debug('Realtime 订阅已初始化', { userId: userId.substring(0, 8) });
  }
  
  teardownRealtimeSubscription(): void {
    this.realtimePollingService.unsubscribeFromProject();
  }
  
  pauseRealtimeUpdates(): void {
    this.realtimePollingService.pauseRealtimeUpdates();
  }
  
  resumeRealtimeUpdates(): void {
    this.realtimePollingService.resumeRealtimeUpdates();
  }
  
  // ==================== 用户偏好 ====================
  
  async loadUserPreferences(userId: string): Promise<UserPreferences | null> {
    return this.userPrefsSync.loadUserPreferences(userId);
  }
  
  async saveUserPreferences(userId: string, preferences: Partial<UserPreferences>): Promise<boolean> {
    return this.userPrefsSync.saveUserPreferences(userId, preferences);
  }
  
  // ==================== Delta Sync ====================
  
  async checkForDrift(projectId: string): Promise<{ tasks: Task[]; connections: Connection[] }> {
    const client = this.getSupabaseClient();
    if (!client || !SYNC_CONFIG.DELTA_SYNC_ENABLED) {
      return { tasks: [], connections: [] };
    }
    
    const lastSyncTime = this.lastSyncTimeByProject.get(projectId);
    if (!lastSyncTime) {
      return { tasks: [], connections: [] };
    }
    
    try {
      const [tasksResult, connectionsResult] = await Promise.all([
        client.from('tasks').select(FIELD_SELECT_CONFIG.TASK_LIST_FIELDS).eq('project_id', projectId).gt('updated_at', lastSyncTime),
        client.from('connections').select(FIELD_SELECT_CONFIG.CONNECTION_FIELDS).eq('project_id', projectId).gt('updated_at', lastSyncTime)
      ]);
      
      if (tasksResult.error || connectionsResult.error) {
        throw supabaseErrorToError(tasksResult.error || connectionsResult.error);
      }
      
      const deltaTasks = (tasksResult.data || []) as unknown as Task[];
      const deltaConnections = (connectionsResult.data || []) as unknown as Connection[];
      
      this.lastSyncTimeByProject.set(projectId, nowISO());
      
      return {
        tasks: deltaTasks.filter(t => !t.deletedAt),
        connections: deltaConnections.filter(c => !c.deletedAt)
      };
    } catch (e) {
      this.logger.error('Delta Sync 检查失败', e);
      throw e;
    }
  }
  
  setLastSyncTime(projectId: string, timestamp: string): void {
    this.lastSyncTimeByProject.set(projectId, timestamp);
  }
  
  getLastSyncTime(projectId: string): string | null {
    return this.lastSyncTimeByProject.get(projectId) || null;
  }
  
  clearLastSyncTime(projectId: string): void {
    this.lastSyncTimeByProject.delete(projectId);
  }
  
  // ==================== 冲突解决 ====================
  
  resolveConflict(projectId: string, resolvedProject: Project, strategy: 'local' | 'remote'): void {
    this.logger.info('解决冲突', { projectId, strategy });
    this.syncState.update(s => ({ ...s, hasConflict: false, conflictData: null }));
  }
  
  setConflict(conflictData: ConflictData): void {
    this.syncState.update(s => ({ ...s, hasConflict: true, conflictData }));
  }
  
  // ==================== 项目加载 ====================
  
  async saveProjectToCloud(project: Project, userId: string): Promise<{ success: boolean; conflict?: boolean; remoteData?: Project; newVersion?: number }> {
    return this.batchSyncService.saveProjectToCloud(project, userId);
  }
  
  async saveProjectSmart(project: Project, userId: string): Promise<{ success: boolean; conflict?: boolean; remoteData?: Project; newVersion?: number; validationWarnings?: string[] }> {
    const result = await this.saveProjectToCloud(project, userId);
    return { ...result, newVersion: project.version };
  }
  
  async loadFullProjectOptimized(projectId: string): Promise<Project | null> {
    return this.projectDataService.loadFullProjectOptimized(projectId);
  }
  
  async loadFullProject(projectId: string, _userId: string): Promise<Project | null> {
    return this.projectDataService.loadFullProject(projectId);
  }
  
  async loadProjectsFromCloud(userId: string, _silent?: boolean): Promise<Project[]> {
    return this.projectDataService.loadProjectsFromCloud(userId);
  }
  
  async deleteProjectFromCloud(projectId: string, userId: string): Promise<boolean> {
    const client = this.getSupabaseClient();
    if (!client) return false;
    
    try {
      const { error } = await client.from('projects').delete().eq('id', projectId).eq('owner_id', userId);
      if (error) throw supabaseErrorToError(error);
      return true;
    } catch (e) {
      this.logger.error('删除项目失败', e);
      return false;
    }
  }
  
  async loadSingleProject(projectId: string, userId: string): Promise<Project | null> {
    return this.loadFullProject(projectId, userId);
  }
  
  async tryReloadConflictData(userId: string, _findProject?: (id: string) => Project | undefined): Promise<Project | undefined> {
    const state = this.syncState();
    if (!state.hasConflict || !state.conflictData) return undefined;
    const project = await this.loadFullProject(state.conflictData.projectId, userId);
    return project ?? undefined;
  }
  
  clearOfflineCache(): void {
    this.retryQueue = [];
    this.syncState.update(s => ({ ...s, pendingCount: 0 }));
    this.logger.info('离线缓存已清除');
  }
  
  saveOfflineSnapshot(projects: Project[]): void {
    this.projectDataService.saveOfflineSnapshot(projects);
  }
  
  loadOfflineSnapshot(): Project[] | null {
    return this.projectDataService.loadOfflineSnapshot();
  }
  
  // ==================== 会话管理 ====================
  
  resetSessionExpired(): void {
    if (!this.syncState().sessionExpired) return;
    
    const previousQueueLength = this.retryQueue.length;
    this.syncState.update(s => ({ ...s, sessionExpired: false }));
    
    this.logger.info('会话状态已重置', { previousQueueLength, currentQueueLength: this.retryQueue.length });
    
    if (this.state().isOnline && this.retryQueue.length > 0) {
      this.logger.info('会话恢复，触发重试队列处理');
      this.processRetryQueue();
    }
  }
  
  destroy(): void {
    this.cleanup();
    this.unsubscribeFromProject();
    this.retryQueue = [];
    this.logger.info('SimpleSyncService 已销毁');
  }
}
