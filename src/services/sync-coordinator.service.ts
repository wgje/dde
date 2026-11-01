/**
 * SyncCoordinatorService - 同步协调服务
 * 
 * 职责：
 * - 管理同步状态（网络连通性、队列长度、最后同步时间）
 * - 协调离线数据与云端数据的合并
 * - 处理同步冲突
 * - 管理持久化调度
 * 
 * 这是「应用状态」（Application State），与「领域数据」（Domain Data）分离：
 * - 领域数据：Project、Task（由 ProjectStateService 管理）
 * - 应用状态：网络状态、同步状态、冲突状态（由本服务管理）
 * 
 * 分离的好处：
 * - 网络波动更新同步状态时，不会触发任务列表的变更检测
 * - 数据流像电路板上的走线一样清晰，互不干扰
 */
import { Injectable, inject, computed, DestroyRef } from '@angular/core';
import { AUTH_CONFIG } from '../config/auth.config';
import { SimpleSyncService, RetryQueueService, SyncStateService, ProjectDataService, RealtimePollingService, TaskSyncOperationsService, ProjectSaveFlightCoordinatorService } from '../core-bridge';
import { ActionQueueService } from './action-queue.service';
import { ActionQueueProcessorsService } from './action-queue-processors.service';
import { DeltaSyncCoordinatorService } from './delta-sync-coordinator.service';
import { ProjectSyncOperationsService } from './project-sync-operations.service';
import { type ConflictResolutionPlan } from './conflict-resolution.types';
import { AuthService } from './auth.service';
import { LoggerService } from './logger.service';
// Sprint 4 技术债务修复：提取的子服务
import { PersistSchedulerService } from './persist-scheduler.service';
// 借鉴思源笔记的同步增强服务
import { SyncModeService, SyncDirection } from './sync-mode.service';
import { Project } from '../models';
import { Result, OperationError } from '../utils/result';
import { BlackBoxSyncService } from './black-box-sync.service';
import { SyncCoordinatorConflictService } from './sync-coordinator-conflicts.service';
import { SyncCoordinatorPersistService } from './sync-coordinator-persist.service';
import { SyncCoordinatorProjectRefreshService } from './sync-coordinator-project-refresh.service';
import { SyncCoordinatorRuntimeService } from './sync-coordinator-runtime.service';
import type { TaskDeleteBaseUpdatedAtMap } from './action-queue.types';
import {
  createTaskTombstoneSnapshot,
  type TaskTombstones,
} from './conflict-resolution-merge.helpers';

export type { ConflictEvent } from './sync-coordinator-conflicts.service';

export interface AccessibleProjectProbe {
  projectId: string;
  accessible: boolean;
  watermark: string | null;
}

export interface ResumeRecoveryProbe {
  activeProjectId: string | null;
  activeAccessible: boolean;
  activeWatermark: string | null;
  projectsWatermark: string | null;
  blackboxWatermark: string | null;
  serverNow: string | null;
}

export interface OfflineSnapshotLoadOptions {
  allowOwnerHint?: boolean;
  ownerUserId?: string | null;
}

export interface StartupOfflineSnapshotLoadResult {
  source: 'idb' | 'localStorage' | 'none';
  projectCount: number;
  bytes: number;
  migratedLegacy: boolean;
  projects: Project[];
  ownerUserId?: string | null;
}

@Injectable({
  providedIn: 'root'
})
export class SyncCoordinatorService {
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('SyncCoordinator');
  
  // ========== 同步门面 composition root（构造锚点） ==========

  /**
   * 【Phase 3 门面安乐死完成】SimpleSyncService 不再被本服务调用任何方法
   * （this.core.X() 调用已全部下切到具体子服务：SyncStateService / ProjectDataService /
   * ProjectSyncCursorService / RealtimePollingService / TaskSyncOperationsService /
   * ProjectSaveFlightCoordinatorService / TombstoneService）。
   *
   * 此字段仅作为「构造锚点」保留：SimpleSyncService 是同步栈的 composition root，
   * 其构造函数负责 wireCoordinatorCallbacks / setupBatchSyncCallbacks / setupLifecycleListeners
   * 等关键 wiring。本服务是其当前唯一的生产期 eager 注入方，删除会改变门面的构造时机
   * （workspace-shell 仅有 lazy getter）。彻底移除需改为 APP_INITIALIZER 显式构造，属独立后续项。
   */
  private readonly facadeCompositionRoot = inject(SimpleSyncService);
  /**
   * 【2026-05-16 单事实源】pendingCount 等同步状态字段必须通过 SyncStateService 公开 setter 写入。
   * 不允许再通过反射式 `core.state.update(...)` 绕过封装，避免与 RetryQueue.onProcessingStateChange
   * 在不同 tick 的竞争写入造成漂移。
   */
  private readonly syncStateService = inject(SyncStateService);
  // Phase 3 门面安乐死：项目数据读写簇直接注入具体 owner（不再经 this.core 门面）
  private readonly projectData = inject(ProjectDataService);
  // Phase 3 门面安乐死：实时轮询回调 + 任务同步操作簇直接注入具体 owner
  private readonly realtimePolling = inject(RealtimePollingService);
  private readonly taskSyncOps = inject(TaskSyncOperationsService);
  // Phase 3 门面安乐死：项目智能保存单飞协调器直接注入具体 owner
  private readonly projectSaveCoordinator = inject(ProjectSaveFlightCoordinatorService);
  
  private actionQueue = inject(ActionQueueService);
  // Sprint 9 技术债务修复：提取的处理器服务
  private actionQueueProcessors = inject(ActionQueueProcessorsService);
  // Sprint 9 技术债务修复：Delta Sync 协调器
  private deltaSyncCoordinator = inject(DeltaSyncCoordinatorService);
  // Sprint 9 技术债务修复：项目同步操作服务
  private projectSyncOps = inject(ProjectSyncOperationsService);
  private authService = inject(AuthService);
  private retryQueue = inject(RetryQueueService);
  private destroyRef = inject(DestroyRef);
  
  // Sprint 4 技术债务修复：提取的持久化调度服务
  private persistScheduler = inject(PersistSchedulerService);
  
  // 借鉴思源笔记的同步增强服务
  private syncModeService = inject(SyncModeService);
  private blackBoxSync = inject(BlackBoxSyncService);
  private conflictCoordinator = inject(SyncCoordinatorConflictService);
  private persistCoordinator = inject(SyncCoordinatorPersistService);
  private projectRefreshCoordinator = inject(SyncCoordinatorProjectRefreshService);
  private runtimeCoordinator = inject(SyncCoordinatorRuntimeService);
  
  // ========== 同步状态 ==========
  
  /** 是否正在同步 */
  readonly isSyncing = computed(() => this.syncStateService.syncState().isSyncing);
  
  /** 是否在线 */
  readonly isOnline = computed(() => this.syncStateService.syncState().isOnline);
  
  /** 离线模式 */
  readonly offlineMode = computed(() => this.syncStateService.syncState().offlineMode);
  
  /** 会话是否过期 */
  readonly sessionExpired = computed(() => this.syncStateService.syncState().sessionExpired);
  
  /** 同步错误 */
  readonly syncError = computed(() => this.syncStateService.syncState().syncError);
  
  /** 是否有冲突 */
  readonly hasConflict = computed(() => this.syncStateService.syncState().hasConflict);
  
  /** 冲突数据 */
  readonly conflictData = computed(() => this.syncStateService.syncState().conflictData);
  
  /** 是否正在加载远程数据 */
  readonly isLoadingRemote = this.syncStateService.isLoadingRemote;
  
  /** 待处理的离线操作数量 */
  readonly pendingActionsCount = this.actionQueue.queueSize;
  
  // ========== 借鉴思源笔记的同步增强状态 ==========
  
  /** 当前同步模式 */
  readonly syncMode = computed(() => this.syncModeService.mode());
  
  /** 是否为自动同步模式 */
  readonly isAutoSyncMode = computed(() => this.syncModeService.isAutomatic());
  
  /** 是否启用同步感知（简化：默认 false） */
  readonly perceptionEnabled = computed(() => this.syncModeService.perceptionEnabled());

  readonly onConflict$ = this.conflictCoordinator.onConflict$;
  
  /** 是否已初始化（幂等保护） */
  private isInitialized = false;
  constructor() {
    // 【性能审计 2026-02-07】延迟初始化：构造函数仅注入依赖，不启动副作用
    // 重型初始化（处理器注册、定时器、回调）延迟到 initialize() 调用
    this.destroyRef.onDestroy(() => {
      this.persistCoordinator.clearTimers();
      this.persistScheduler.stopLocalAutosave();
      this.destroy();
    });
  }

  /**
   * 初始化同步服务（延迟调用）
   *
   * 【性能审计 2026-02-07】从构造函数提取，避免阻塞首屏渲染
   * 由 AppComponent.ngOnInit 在首屏渲染后调用
   * 幂等：重复调用安全
   */
  initialize(): void {
    if (this.isInitialized) return;
    this.isInitialized = true;

    this.actionQueueProcessors.setProjectConflictHandler((
      localProject,
      remoteProject,
      ownerUserId,
      pendingTaskDeleteIds,
      pendingTaskDeleteBaseUpdatedAtMap,
    ) => {
      this.publishConflict(
        localProject,
        remoteProject,
        ownerUserId,
        pendingTaskDeleteIds,
        pendingTaskDeleteBaseUpdatedAtMap,
      );
    });
    this.actionQueueProcessors.setupProcessors();
    this.runtimeCoordinator.validateRequiredProcessors();
    this.runtimeCoordinator.startLocalAutosave();
    this.setupSyncModeCallback();
    this.runtimeCoordinator.setupTabSyncLocalRefresh(
      (projectId) => this.hasPendingChangesForProject(projectId),
    );
    void this.conflictCoordinator.restorePersistedConflictState();
  }
  
  // ========== 借鉴思源笔记的同步增强方法 ==========
  
  /**
   * 设置同步模式回调
   * 当同步模式服务需要执行同步时，调用此回调
   */
  private setupSyncModeCallback(): void {
    this.syncModeService.setSyncCallback(async (direction: SyncDirection) => {
      await this.executeSyncByDirection(direction);
    });
  }

  /**
   * 根据方向执行同步（简化版）
   */
  private async executeSyncByDirection(direction: SyncDirection): Promise<void> {
    const userId = this.authService.currentUserId();
    if (!userId) return;
    
    switch (direction) {
      case 'upload':
        // 仅上传：保存活动项目到云端
        await this.persistCoordinator.persistActiveProject();
        break;
        
      case 'download':
        // 仅下载：从云端加载最新数据并智能合并
        await this.downloadAndMerge(userId);
        break;
        
      case 'both':
        // 双向同步：先上传本地变更，再下载远程变更并合并
        await this.persistCoordinator.persistActiveProject();
        await this.downloadAndMerge(userId);
        break;
    }
  }
  
  /**
   * 下载云端数据并智能合并到本地
   * 确保本地的软删除状态不会被远程数据覆盖
   */
  private async downloadAndMerge(userId: string): Promise<void> {
    await this.projectRefreshCoordinator.downloadAndMerge(userId);
  }

  /** 初始化同步感知（LWW 简化：空实现） */
  async initSyncPerception(_userId: string): Promise<void> { /* no-op */ }
  
  /** 停止同步感知（LWW 简化：空实现） */
  async stopSyncPerception(): Promise<void> { /* no-op */ }
  
  /** 创建同步检查点（LWW 简化：空实现） */
  async createSyncCheckpoint(_memo?: string): Promise<void> { /* no-op */ }
  
  /** 记录冲突到历史（LWW 简化：仅日志） */
  async recordConflictToHistory(projectId: string, _l: Project, _r: Project, reason: string): Promise<void> {
    this.logger.info('检测到冲突（LWW 自动处理）', { projectId, reason });
  }
  
  /** 设置同步模式 */
  setSyncMode(mode: 'automatic' | 'manual' | 'completely-manual'): void {
    this.syncModeService.setMode(mode);
  }
  
  /** 设置是否启用感知（LWW 简化：空实现） */
  async setPerceptionEnabled(_enabled: boolean): Promise<void> { /* no-op */ }
  
  /** 手动触发同步（所有模式下可用） */
  async triggerManualSync(direction: SyncDirection = 'both'): Promise<void> {
    await this.syncModeService.triggerSync(direction);
  }
  
  /**
   * 仅上传（完全手动模式下使用）
   */
  async uploadOnly(): Promise<void> {
    await this.syncModeService.uploadOnly();
  }
  
  /**
   * 仅下载（完全手动模式下使用）
   */
  async downloadOnly(): Promise<void> {
    await this.syncModeService.downloadOnly();
  }
  
  /**
   * 获取冲突历史统计（简化：返回空统计）
   */
  async getConflictStats(): Promise<{
    total: number;
    resolved: number;
    unresolved: number;
  }> {
    // LWW 简化：不再保存冲突历史
    return { total: 0, resolved: 0, unresolved: 0 };
  }
  
  /**
   * 获取检查点历史（简化：返回空数组）
   */
  async getCheckpointHistory(_limit = 20): Promise<unknown[]> {
    // LWW 简化：不再保存检查点历史
    return [];
  }

  // ========== 公共方法 ==========
  
  /**
   * 标记有本地变更待同步
   */
  markLocalChanges(updateType: 'content' | 'structure' | 'position' = 'structure') {
    this.persistCoordinator.markLocalChanges(updateType);
  }
  
  /**
   * 获取上次更新类型
   */
  getLastUpdateType(): 'content' | 'structure' | 'position' {
    return this.persistCoordinator.getLastUpdateType();
  }
  
  /**
   * 检查是否有待处理的本地变更
   */
  hasPendingLocalChanges(): boolean {
    return this.persistCoordinator.hasPendingLocalChanges();
  }
  
  /**
   * 获取上次持久化时间
   */
  getLastPersistAt(): number {
    return this.persistCoordinator.getLastPersistAt();
  }
  
  /**
   * 调度持久化
   */
  schedulePersist() {
    this.persistCoordinator.schedulePersist();
  }
  
  /**
   * 立即刷新待处理的持久化
   * 用于页面卸载前确保数据已保存
   * 注意：这是同步方法，只保存到本地缓存
   */
  flushPendingPersist(): void {
    this.persistCoordinator.flushPendingPersist();
  }

  async preparePendingPersistForOwnerChange(ownerUserId: string | null, reason: string): Promise<boolean> {
    return this.persistCoordinator.preparePendingPersistForOwnerChange(ownerUserId, reason);
  }

  /**
   * 在页面切入后台/卸载前抢发一次云端持久化。
   * 同步本地快照仍是第一优先级；此方法仅在有待同步改动且在线时尝试补齐跨设备可见性。
   */
  async flushPendingPersistToCloud(reason: string, options?: { force?: boolean }): Promise<boolean> {
    return this.persistCoordinator.flushPendingPersistToCloud(reason, options);
  }
  
  /**
   * 设置远程变更回调
   */
  setupRemoteChangeCallbacks(
    onRemoteChange: (payload: { eventType?: string; projectId?: string } | undefined) => Promise<void>,
    onTaskChange: (payload: { eventType: string; taskId: string; projectId: string }) => void
  ) {
    this.realtimePolling.setOnRemoteChange(onRemoteChange);
    this.realtimePolling.setTaskChangeCallback(onTaskChange);
  }

  // ============================================================
  // 【按需加载优化 2026-01-27】单项目加载与待同步检测
  // ============================================================
  
  /**
   * 从云端加载单个项目（按需加载策略）
   * 
   * 【优化目的】避免加载所有项目，只加载用户需要的
   * - 首次同步只加载当前项目
   * - 用户切换项目时再加载目标项目
   * 
   * @param projectId 项目 ID
   * @returns 完整的项目数据
   */
  async loadSingleProjectFromCloud(projectId: string): Promise<Project | null> {
    return this.projectData.loadFullProjectOptimized(projectId);
  }

  loadOfflineSnapshot(options?: OfflineSnapshotLoadOptions): Project[] | null {
    return this.projectData.loadOfflineSnapshot(options);
  }

  async loadStartupOfflineSnapshot(options?: OfflineSnapshotLoadOptions): Promise<StartupOfflineSnapshotLoadResult> {
    return this.projectData.loadStartupOfflineSnapshot(options);
  }

  saveOfflineSnapshot(projects: Project[], ownerUserId?: string | null): void {
    this.projectData.saveOfflineSnapshot(projects, ownerUserId);
  }

  async saveOfflineSnapshotAndWait(projects: Project[], ownerUserId?: string | null): Promise<void> {
    await this.projectData.saveOfflineSnapshotAndWait(projects, ownerUserId);
  }

  clearOfflineSnapshot(ownerUserId?: string | null): void {
    this.projectData.clearOfflineSnapshot(ownerUserId);
  }

  clearOfflineCache(ownerUserId?: string | null): void {
    this.projectData.clearOfflineSnapshot(ownerUserId);
    this.retryQueue.clear();
    this.syncStateService.update({ pendingCount: 0 });
  }

  async getAccessibleProjectProbe(projectId: string): Promise<AccessibleProjectProbe | null> {
    return this.projectData.getAccessibleProjectProbe(projectId);
  }

  async getResumeRecoveryProbe(projectId?: string): Promise<ResumeRecoveryProbe | null> {
    return this.projectData.getResumeRecoveryProbe(projectId);
  }

  async saveProjectSmart(
    project: Project,
    userId: string,
    taskIdsToDelete?: string[],
    taskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap,
  ): ReturnType<ProjectSaveFlightCoordinatorService['save']> {
    const result = await this.projectSaveCoordinator.save(
      project,
      userId,
      taskIdsToDelete,
      taskDeleteBaseUpdatedAtMap,
    );
    return { ...result, newVersion: result.newVersion ?? project.version };
  }

  async initRealtimeSubscription(userId: string): Promise<void> {
    this.logger.debug('Realtime 订阅已初始化', { userId: userId.substring(0, 8) });
  }

  teardownRealtimeSubscription(): void {
    this.realtimePolling.unsubscribeFromProject();
  }
  
  /**
   * 检查项目是否有待同步的本地修改
   * 
   * 【LWW 竞态保护】如果有未同步的本地修改，合并时需要使用 LWW 策略
   * 避免云端旧数据覆盖本地新编辑
   * 
   * @param projectId 项目 ID
   * @returns 是否有待同步修改
   */
  hasPendingChangesForProject(projectId: string, ownerUserId?: string): boolean {
    const resolvedOwnerUserId = ownerUserId
      ?? this.authService.currentUserId()
      ?? AUTH_CONFIG.LOCAL_MODE_USER_ID;
    const actionQueueState = this.actionQueue.getProjectPendingWriteState?.(
      projectId,
      resolvedOwnerUserId,
    ) ?? (this.actionQueue.getPendingActionsForProject(projectId).length > 0 ? 'pending' : 'clear');
    return actionQueueState !== 'clear'
      || this.retryQueue.getProjectPendingWriteState(projectId, resolvedOwnerUserId) !== 'clear';
  }

  subscribeToProjectPendingWriteStateChanges(listener: () => void): () => void {
    const unsubscribeRetryQueue = this.retryQueue.subscribeToPendingWriteStateChanges(listener);
    const unsubscribeActionQueue = this.actionQueue.subscribeToQueueSettled(listener);
    const unsubscribeActionQueueOwnerLoad = this.actionQueue
      .subscribeToOwnerStorageLoadStateChanges?.(listener);
    return () => {
      unsubscribeRetryQueue();
      unsubscribeActionQueue();
      unsubscribeActionQueueOwnerLoad?.();
    };
  }

  private hasPendingProjectQueueReplay(projectId: string): boolean {
    return this.actionQueue.getPendingActionsForProject(projectId).some(action =>
      action.entityType === 'project' && action.entityId === projectId
    );
  }

  // ============================================================
  // 【Stingy Hoarder Protocol】Delta Sync 增量同步入口
  // @see docs/plan_save.md Phase 3
  // ============================================================

  /**
   * Delta Sync 增量同步
   * 
   * 【核心优化】从 MB 级全量拉取降至 ~1 KB 增量检查
   * 
   * 流程：
   * 1. 调用 SimpleSyncService.checkForDrift() 获取增量变更
   * 2. 将增量数据合并到当前项目
   * 3. 更新 ProjectStateService
   * 
   * @param projectId 项目 ID
   * @returns 变更数量，0 表示无变更
   */
  async performDeltaSync(projectId: string): Promise<{ taskChanges: number; connectionChanges: number }> {
    // Sprint 9 技术债务修复：委托给 DeltaSyncCoordinatorService
    return this.deltaSyncCoordinator.performDeltaSync(projectId);
  }
  
  /**
   * 安全批量软删除任务（服务端防护）
   * 
   * 【P0 熔断层】使用 safe_delete_tasks RPC 确保批量删除不会超过限制：
   * - 单次删除不能超过 50% 或 50 条任务
   * - 项目任务数 > 10 时，不允许删到 0
   * 
   * @param projectId 项目 ID
   * @param taskIds 要删除的任务 ID 列表
   * @returns 实际删除的任务数量，-1 表示被服务端拒绝
   */
  async softDeleteTasksBatch(
    projectId: string,
    taskIds: string[],
    tombstoneTimestamps?: Record<string, string | number | null | undefined>,
    baseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap,
    operationId?: string,
  ): Promise<number> {
    return this.taskSyncOps.softDeleteTasksBatch(
      projectId,
      taskIds,
      tombstoneTimestamps,
      baseUpdatedAtMap,
      operationId,
    );
  }
  
  /**
   * 重新同步当前活动项目
   * 
   * 【设计哲学】
   * 这不是暴力的 Force Push/Pull，而是智能的重新同步：
   * 1. 从云端拉取最新数据
   * 2. 与本地数据进行智能合并（使用现有的 smartMerge 逻辑）
   * 3. 如果发现真正的冲突，静默保存到冲突仓库
   * 4. 更新本地状态
   * 
   * @returns 同步结果
   */
  async resyncActiveProject(): Promise<{
    success: boolean;
    message: string;
    conflictDetected?: boolean;
  }> {
    // Sprint 9 技术债务修复：委托给 ProjectSyncOperationsService
    return this.projectSyncOps.resyncActiveProject(
      (projectId) => this.getTaskTombstones(projectId)
    );
  }

  /**
   * 静默刷新当前活动项目
   *
   * 恢复链路专用：优先走水位快路，只有检测到远端更新时才拉取完整项目。
   */
  async refreshActiveProjectSilent(reason: string): Promise<{
    refreshed: boolean;
    skippedReason?: string;
    fastPathHit?: boolean;
  }> {
    return this.projectRefreshCoordinator.refreshActiveProjectSilent(reason);
  }

  /**
   * 刷新项目清单元数据（恢复/后台同步快路）
   *
   * 仅在远端用户项目水位更新时才同步项目头信息，避免无效项目列表重拉。
   */
  async refreshProjectManifestIfNeeded(
    reason: string,
    options?: { prefetchedRemoteWatermark?: string | null; deferCommit?: boolean }
  ): Promise<{ skipped: boolean; watermark?: string }> {
    return this.projectRefreshCoordinator.refreshProjectManifestIfNeeded(reason, options);
  }

  commitProjectManifestWatermark(watermark: string, userId?: string | null): void {
    this.projectRefreshCoordinator.commitProjectManifestWatermark(watermark, userId);
  }

  /**
   * 刷新黑匣子域水位（恢复链路快路）
   *
   * 无变更时仅 watermark RPC；有变更时再拉取明细。
   */
  async refreshBlackBoxWatermarkIfNeeded(
    reason: string,
    options?: { prefetchedRemoteWatermark?: string | null }
  ): Promise<{ skipped: boolean; watermark?: string }> {
    return this.projectRefreshCoordinator.refreshBlackBoxWatermarkIfNeeded(reason, options);
  }
  
  /**
   * 静默保存冲突到仓库（不弹窗）
   */
  private async saveConflictSilently(
    localProject: Project, 
    remoteProject: Project | undefined,
    conflictedFields: string[],
    ownerUserId?: string | null,
    pendingTaskDeleteIds?: string[],
    pendingTaskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap,
    conflictedAt?: string,
  ): Promise<void> {
    await this.conflictCoordinator.saveConflictSilently(
      localProject,
      remoteProject,
      conflictedFields,
      ownerUserId,
      pendingTaskDeleteIds,
      pendingTaskDeleteBaseUpdatedAtMap,
      conflictedAt,
    );
  }

  private publishConflict(
    localProject: Project,
    remoteProject: Project,
    ownerUserId?: string | null,
    pendingTaskDeleteIds?: string[],
    pendingTaskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap,
  ): void {
    this.conflictCoordinator.publishConflict(
      localProject,
      remoteProject,
      ownerUserId,
      pendingTaskDeleteIds,
      pendingTaskDeleteBaseUpdatedAtMap,
    );
  }
  
  /**
   * 尝试重新加载冲突数据
   *
   * 【Phase 3 门面安乐死】原 this.core.tryReloadConflictData 是门面-LOCAL 逻辑
   * （只读自身 syncState + loadFullProject），已内联到此处直接走具体 owner。
   * findProject 参数门面侧本就忽略，保留签名兼容既有调用方。
   */
  async tryReloadConflictData(
    userId: string,
    _findProject: (id: string) => Project | undefined
  ): Promise<Project | undefined> {
    return this.conflictCoordinator.tryReloadConflictData(userId, _findProject);
  }
  
  /**
   * 解决数据冲突
   */
  async resolveConflict(
    projectId: string,
    choice: 'local' | 'remote' | 'merge',
    localProject: Project,
    remoteProject: Project | undefined
  ): Promise<Result<Project, OperationError>> {
    return this.conflictCoordinator.resolveConflict(
      projectId,
      choice,
      localProject,
      remoteProject
    );
  }

  async resolveConflictWithPlan(
    projectId: string,
    plan: ConflictResolutionPlan,
    localProject: Project,
    remoteProject: Project | undefined,
  ): Promise<Result<Project, OperationError>> {
    return this.conflictCoordinator.resolveConflictWithPlan(
      projectId,
      plan,
      localProject,
      remoteProject,
    );
  }

  async captureConflict(
    localProject: Project,
    remoteProject?: Project,
    ownerUserId?: string | null,
    pendingTaskDeleteIds?: string[],
    pendingTaskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap,
    isCurrent?: () => boolean,
  ): Promise<void> {
    await this.conflictCoordinator.captureConflict(
      localProject,
      remoteProject,
      ownerUserId,
      pendingTaskDeleteIds,
      pendingTaskDeleteBaseUpdatedAtMap,
      isCurrent,
    );
  }

  clearActiveConflict(): void {
    this.conflictCoordinator.clearActiveConflict();
  }
  
  /**
   * 智能合并项目
   * 
   * @param localProject 本地项目
   * @param remoteProject 远程项目  
   * @param tombstoneIds 已永久删除的任务 ID 集合（必需参数）
   */
  smartMerge(localProject: Project, remoteProject: Project, tombstoneIds: TaskTombstones) {
    return this.conflictCoordinator.smartMerge(localProject, remoteProject, tombstoneIds);
  }
  
  /**
   * 获取项目的 tombstone IDs
   */
  async getTombstoneIds(projectId: string): Promise<Set<string>> {
    return this.taskSyncOps.getTombstoneIds(projectId);
  }

  private async getTaskTombstones(projectId: string): Promise<TaskTombstones> {
    const result = await this.taskSyncOps.getTombstoneIdsWithStatus(projectId);
    return createTaskTombstoneSnapshot(result.ids, result.deletedAtByTaskId);
  }
  
  /**
   * 合并离线数据
   * 返回冲突项目列表供调用者处理
   * 
   * 合并策略：
   * 1. 云端不存在的项目 → 直接上传
   * 2. 离线版本号 > 云端版本号 → 上传离线数据
   * 3. 版本号相同时 → 比较 updatedAt 时间戳和任务内容
   * 4. 版本号相同但内容不同 → 保留本地数据（用户最近编辑的）
   */
  async mergeOfflineDataOnReconnect(
    cloudProjects: Project[],
    offlineProjects: Project[],
    userId: string
  ): Promise<{ projects: Project[]; syncedCount: number; conflictProjects: Project[] }> {
    // Sprint 9 技术债务修复：委托给 ProjectSyncOperationsService
    const result = await this.projectSyncOps.mergeOfflineDataOnReconnect(
      cloudProjects,
      offlineProjects,
      userId,
      (projectId) => this.getTaskTombstones(projectId),
      (local, remote) => this.publishConflict(local, remote)
    );

    // 同时同步黑匣子数据（不阻塞主流程）
    this.blackBoxSync.forceSync().catch(e => {
      this.logger.warn('黑匣子重连同步失败（非阻塞）', e);
    });

    return result;
  }
  
  /**
   * 验证并重新平衡项目
   */
  validateAndRebalanceWithResult(project: Project): Result<Project, OperationError> {
    // Sprint 9 技术债务修复：委托给 ProjectSyncOperationsService
    return this.projectSyncOps.validateAndRebalanceWithResult(project);
  }
  
  /**
   * 验证并重新平衡项目（简化版，出错时返回清理后的项目）
   */
  validateAndRebalance(project: Project): Project {
    // Sprint 9 技术债务修复：委托给 ProjectSyncOperationsService
    return this.projectSyncOps.validateAndRebalance(project);
  }

  
  /**
   * 销毁服务
   */
  destroy() {
    // 完成冲突事件 Subject
    this.conflictCoordinator.destroy();
    this.runtimeCoordinator.teardownTabSyncLocalRefresh();
    // 生命周期销毁只释放远端订阅；RetryQueue 是持久 outbox，不能在应用退出时清空。
    void this.realtimePolling.unsubscribeFromProject();
  }
}
