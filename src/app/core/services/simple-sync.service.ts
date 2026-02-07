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
  ConnectionSyncOperationsService,
  RetryQueueService
} from './sync';
import type { RetryableEntityType, RetryableOperation } from './sync';
import { Task, Project, Connection, UserPreferences } from '../../../models';
import { ProjectRow } from '../../../models/supabase-types';
import { nowISO } from '../../../utils/date';
import { supabaseErrorToError, EnhancedError } from '../../../utils/supabase-error';
import { PermanentFailureError, isPermanentFailureError } from '../../../utils/permanent-failure-error';
import { SYNC_CONFIG, FIELD_SELECT_CONFIG, CACHE_CONFIG } from '../../../config';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SentryLazyLoaderService } from '../../../services/sentry-lazy-loader.service';
import { BlackBoxSyncService } from '../../../services/black-box-sync.service';
import { BlackBoxEntry } from '../../../models/focus';

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
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly retryQueueService = inject(RetryQueueService);
  private readonly blackBoxSync = inject(BlackBoxSyncService);
  
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
  
  /** 最后一次同步时间 */
  private lastSyncTimeByProject: Map<string, string> = new Map();
  
  /** 配置常量 */
  private readonly RETRY_INTERVAL = 5000;
  private readonly OFFLINE_CACHE_KEY = CACHE_CONFIG.OFFLINE_CACHE_KEY;
  
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
    
    // 设置重试队列操作处理器
    this.retryQueueService.setOperationHandler({
      pushTask: (task, pid) => this.pushTask(task, pid, true, true),
      deleteTask: (tid, pid) => this.deleteTask(tid, pid),
      pushProject: (project) => this.pushProject(project, true),
      pushConnection: (conn, pid) => this.pushConnection(conn, pid, true, true, true),
      pushBlackBoxEntry: (entry: BlackBoxEntry) => this.blackBoxSync.pushToServer(entry),
      isSessionExpired: () => this.syncState().sessionExpired,
      isOnline: () => this.state().isOnline,
      onProcessingStateChange: (processing, pendingCount) =>
        this.state.update(s => ({ ...s, isSyncing: processing, pendingCount }))
    });

    // 将黑匣子同步集成到主同步体系的 RetryQueue
    this.blackBoxSync.setRetryQueueHandler((entry: BlackBoxEntry) => {
      this.retryQueueService.add('blackbox', 'upsert', entry, entry.projectId);
    });
    
    // 启动网络监听和重试循环
    this.setupNetworkListeners();
    this.retryQueueService.startLoop(this.RETRY_INTERVAL);
    
    this.destroyRef.onDestroy(() => this.cleanup());
  }
  
  // ==================== 网络与生命周期 ====================
  
  private setupNetworkListeners(): void {
    if (typeof window === 'undefined') return;
    
    const handleOnline = () => {
      this.logger.info('网络恢复');
      this.state.update(s => ({ ...s, isOnline: true }));
      if (this.retryQueueService.length > 0) {
        this.retryQueueService.processQueue();
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
  
  private cleanup(): void {
    this.retryQueueService.stopLoop();
    this.realtimePollingService.unsubscribeFromProject();
  }
  
  flushRetryQueueSync(): void {
    this.retryQueueService.flushSync();
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
  
  // ==================== 重试队列（委托 RetryQueueService） ====================
  
  /**
   * 添加项目到重试队列（含会话和数据有效性检查）
   */
  addToRetryQueue(
    type: RetryableEntityType,
    operation: RetryableOperation,
    data: Task | Project | Connection | { id: string },
    projectId?: string
  ): void {
    if (this.syncState().sessionExpired) return;
    if (!data?.id) {
      this.logger.warn('addToRetryQueue: 跳过无效数据（缺少 id）', { type, operation });
      return;
    }
    if ((type === 'task' || type === 'connection') && !projectId) {
      this.logger.warn('addToRetryQueue: 跳过无效数据（缺少 projectId）', { type, operation, id: data.id });
      return;
    }
    this.retryQueueService.add(type, operation, data, projectId);
    this.state.update(s => ({ ...s, pendingCount: this.retryQueueService.length }));
    this.retryQueueService.checkCapacityWarning();
  }
  
  clearRetryQueue(): void {
    const count = this.retryQueueService.length;
    this.retryQueueService.clear();
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
    this.retryQueueService.clear();
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
    
    const previousQueueLength = this.retryQueueService.length;
    this.syncState.update(s => ({ ...s, sessionExpired: false }));
    
    this.logger.info('会话状态已重置', { previousQueueLength });
    
    if (this.state().isOnline && this.retryQueueService.length > 0) {
      this.logger.info('会话恢复，触发重试队列处理');
      this.retryQueueService.processQueue();
    }
  }
  
  destroy(): void {
    this.cleanup();
    this.unsubscribeFromProject();
    this.retryQueueService.clear();
    this.logger.info('SimpleSyncService 已销毁');
  }
}
