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
import { Injectable, inject, signal, computed, DestroyRef } from '@angular/core';
import { Subject } from 'rxjs';
import { SimpleSyncService, RetryQueueService } from '../core-bridge';
import { ActionQueueService } from './action-queue.service';
import { ActionQueueProcessorsService } from './action-queue-processors.service';
import { DeltaSyncCoordinatorService } from './delta-sync-coordinator.service';
import { ProjectSyncOperationsService } from './project-sync-operations.service';
import { ConflictResolutionService } from './conflict-resolution.service';
import { ConflictStorageService } from './conflict-storage.service';
import { ChangeTrackerService } from './change-tracker.service';
import { ProjectStateService } from './project-state.service';
import { AuthService } from './auth.service';
import { ToastService } from './toast.service';
import { LayoutService } from './layout.service';
import { LoggerService } from './logger.service';
import { SentryAlertService } from './sentry-alert.service';
// Sprint 4 技术债务修复：提取的子服务
import { PersistSchedulerService } from './persist-scheduler.service';
// 借鉴思源笔记的同步增强服务
import { SyncModeService, SyncDirection } from './sync-mode.service';
import { Project } from '../models';
import { SYNC_CONFIG } from '../config';
import { Result, OperationError } from '../utils/result';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { BlackBoxSyncService } from './black-box-sync.service';
/**
 * 冲突事件数据
 * 用于发布-订阅模式的冲突通知
 */
export interface ConflictEvent {
  localProject: Project;
  remoteProject: Project;
  projectId: string;
}

/**
 * 持久化状态
 */
interface PersistState {
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

interface PersistOutcome {
  remoteConfirmed: boolean;
  projectId?: string;
}

@Injectable({
  providedIn: 'root'
})
export class SyncCoordinatorService {
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('SyncCoordinator');
  
  // ========== 公开子服务（减少代理方法） ==========
  
  /** 
   * 底层同步服务 - 可直接访问以减少代理方法
   * 调用方可使用 sync.core.xxx 替代 sync.proxyMethod()
   */
  readonly core = inject(SimpleSyncService);
  
  private actionQueue = inject(ActionQueueService);
  // Sprint 9 技术债务修复：提取的处理器服务
  private actionQueueProcessors = inject(ActionQueueProcessorsService);
  // Sprint 9 技术债务修复：Delta Sync 协调器
  private deltaSyncCoordinator = inject(DeltaSyncCoordinatorService);
  // Sprint 9 技术债务修复：项目同步操作服务
  private projectSyncOps = inject(ProjectSyncOperationsService);
  private conflictService = inject(ConflictResolutionService);
  private conflictStorage = inject(ConflictStorageService);
  private changeTracker = inject(ChangeTrackerService);
  private projectState = inject(ProjectStateService);
  private authService = inject(AuthService);
  private toastService = inject(ToastService);
  private layoutService = inject(LayoutService);
  private sentryAlert = inject(SentryAlertService);
  private retryQueue = inject(RetryQueueService);
  private destroyRef = inject(DestroyRef);
  
  // Sprint 4 技术债务修复：提取的持久化调度服务
  private persistScheduler = inject(PersistSchedulerService);
  
  // 借鉴思源笔记的同步增强服务
  private syncModeService = inject(SyncModeService);
  private blackBoxSync = inject(BlackBoxSyncService);
  
  // ========== 同步状态 ==========
  
  /** 是否正在同步 */
  readonly isSyncing = computed(() => this.core.syncState().isSyncing);
  
  /** 是否在线 */
  readonly isOnline = computed(() => this.core.syncState().isOnline);
  
  /** 离线模式 */
  readonly offlineMode = computed(() => this.core.syncState().offlineMode);
  
  /** 会话是否过期 */
  readonly sessionExpired = computed(() => this.core.syncState().sessionExpired);
  
  /** 同步错误 */
  readonly syncError = computed(() => this.core.syncState().syncError);
  
  /** 是否有冲突 */
  readonly hasConflict = computed(() => this.core.syncState().hasConflict);
  
  /** 冲突数据 */
  readonly conflictData = computed(() => this.core.syncState().conflictData);
  
  /** 是否正在加载远程数据 */
  readonly isLoadingRemote = this.core.isLoadingRemote;
  
  /** 待处理的离线操作数量 */
  readonly pendingActionsCount = this.actionQueue.queueSize;
  
  // ========== 借鉴思源笔记的同步增强状态 ==========
  
  /** 当前同步模式 */
  readonly syncMode = computed(() => this.syncModeService.mode());
  
  /** 是否为自动同步模式 */
  readonly isAutoSyncMode = computed(() => this.syncModeService.isAutomatic());
  
  /** 是否启用同步感知（简化：默认 false） */
  readonly perceptionEnabled = computed(() => this.syncModeService.perceptionEnabled());

  // ========== 持久化状态 ==========
  
  private persistState = signal<PersistState>({
    isPersisting: false,
    hasPending: false,
    lastPersistAt: 0,
    hasPendingLocalChanges: false,
    lastUpdateType: 'structure'
  });
  
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  
  /** 本地自动保存定时器 - 保守模式：每秒自动保存到本地 */
  private localAutosaveTimer: ReturnType<typeof setInterval> | null = null;
  
  /** 
   * 冲突事件 Subject - 使用发布-订阅模式替代回调
   * 
   * 优势：
   * 1. 解耦：SyncCoordinatorService 不需要知道谁在消费冲突事件
   * 2. 多订阅者：UI、日志、自动解决器可以同时订阅
   * 3. 类型安全：ConflictEvent 接口明确定义事件结构
   * 4. 可测试：Subject 比回调更容易 mock 和验证
   */
  private readonly conflict$ = new Subject<ConflictEvent>();
  private syncAttempts = 0;
  private syncConfirmed = 0;
  
  /** 
   * 冲突事件流（只读）
   * 订阅者应使用此 Observable 而非直接访问 Subject
   */
  readonly onConflict$ = this.conflict$.asObservable();
  
  /** 上次快照哈希，用于脏检查避免无变更写入 */
  private lastSnapshotHash = '';

  /** 是否已初始化（幂等保护） */
  private isInitialized = false;

  constructor() {
    // 【性能审计 2026-02-07】延迟初始化：构造函数仅注入依赖，不启动副作用
    // 重型初始化（处理器注册、定时器、回调）延迟到 initialize() 调用
    this.destroyRef.onDestroy(() => {
      if (this.persistTimer) {
        clearTimeout(this.persistTimer);
      }
      if (this.localAutosaveTimer) {
        clearInterval(this.localAutosaveTimer);
      }
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

    this.actionQueueProcessors.setupProcessors();
    this.validateRequiredProcessors();
    this.startLocalAutosave();
    this.setupSyncModeCallback();
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
        await this.persistActiveProject();
        break;
        
      case 'download':
        // 仅下载：从云端加载最新数据并智能合并
        await this.downloadAndMerge(userId);
        break;
        
      case 'both':
        // 双向同步：先上传本地变更，再下载远程变更并合并
        await this.persistActiveProject();
        await this.downloadAndMerge(userId);
        break;
    }
  }
  
  /**
   * 下载云端数据并智能合并到本地
   * 确保本地的软删除状态不会被远程数据覆盖
   */
  private async downloadAndMerge(userId: string): Promise<void> {
    const remoteProjects = await this.core.loadProjectsFromCloud(userId, true);
    if (remoteProjects.length === 0) {
      return;
    }
    const localProjects = this.projectState.projects();
    const localProjectMap = new Map(localProjects.map(p => [p.id, p]));
    const remoteProjectMap = new Map(remoteProjects.map(p => [p.id, p]));
    
    // 智能合并每个项目
    const mergedProjects: Project[] = [];
    for (const remoteProject of remoteProjects) {
      const localProject = localProjectMap.get(remoteProject.id);
      if (!localProject) {
        // 远程新增的项目，直接使用
        mergedProjects.push(this.validateAndRebalance({
          ...remoteProject,
          syncSource: 'synced',
          pendingSync: false
        }));
        continue;
      }
      // 【关键修复】获取 tombstoneIds 防止已删除任务在合并时复活
      const tombstoneIds = await this.getTombstoneIds(remoteProject.id);
      const mergeResult = this.smartMerge(localProject, remoteProject, tombstoneIds);
      mergedProjects.push(this.validateAndRebalance({
        ...mergeResult.project,
        syncSource: 'synced',
        pendingSync: this.changeTracker.hasProjectChanges(remoteProject.id)
      }));
    }

    // 保留 local-only 项目，禁止下载覆盖丢失
    for (const localProject of localProjects) {
      if (remoteProjectMap.has(localProject.id)) {
        continue;
      }

      const hasPendingChanges = localProject.pendingSync === true
        || this.changeTracker.hasProjectChanges(localProject.id)
        || this.hasPendingChangesForProject(localProject.id);

      // 【P0-10 修复】即使没有待同步变更，含有实际数据的项目也不应被静默删除
      // 只有真正空的项目才允许被服务器删除操作清理
      const hasSubstantialData = (localProject.tasks?.length ?? 0) > 0;

      if (!hasPendingChanges && !hasSubstantialData) {
        this.logger.info('跳过无数据且无待同步改动的 local-only 项目', {
          projectId: localProject.id
        });
        continue;
      }

      if (!hasPendingChanges && hasSubstantialData) {
        this.logger.warn('本地存在含数据的项目但服务器不存在，保守保留', {
          projectId: localProject.id,
          taskCount: localProject.tasks?.length
        });
      }

      mergedProjects.push(this.validateAndRebalance({
        ...localProject,
        syncSource: 'local-only',
        pendingSync: true
      }));
    }
    
    // 更新本地状态
    this.projectState.setProjects(mergedProjects);
    this.core.saveOfflineSnapshot(mergedProjects);
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
   * 启动本地自动保存
   * 保守模式核心机制：定期保存到本地，确保用户数据永不丢失
   */
  private startLocalAutosave(): void {
    // 【性能审计 2026-02-07】每 3s 自动保存到本地缓存（含脏检查，无变更时跳过写入）
    this.localAutosaveTimer = setInterval(() => {
      const projects = this.projectState.projects();
      if (projects.length === 0) return;

      // 脏检查：计算简易哈希，跳过无变更的写入
      const hash = projects.map(p => `${p.id}:${p.updatedAt ?? ''}:${p.version ?? 0}`).join('|');
      if (hash === this.lastSnapshotHash) return;

      this.lastSnapshotHash = hash;
      this.core.saveOfflineSnapshot(projects);
    }, SYNC_CONFIG.LOCAL_AUTOSAVE_INTERVAL);

    this.logger.info('本地自动保存已启动', {
      interval: `${SYNC_CONFIG.LOCAL_AUTOSAVE_INTERVAL}ms`,
      dirtyCheck: true
    });
  }
  
  // ========== 公共方法 ==========
  
  /**
   * 验证必需的处理器是否已注册
   * 在构造函数中调用，确保启动时就能发现配置问题
   */
  private validateRequiredProcessors(): void {
    const requiredProcessors = [
      'project:create',
      'project:update',
      'project:delete',
      'task:create',
      'task:update',
      'task:delete',
      'preference:update'
    ];
    
    const missing = this.actionQueue.validateProcessors(requiredProcessors);
    if (missing.length > 0) {
      // 开发环境下抛出错误，便于早期发现问题
      if (typeof ngDevMode !== 'undefined' && ngDevMode) {
        this.logger.error('缺少必需的 ActionQueue 处理器', {
          missing: missing.join(', '),
          registered: this.actionQueue.getRegisteredProcessorTypes()
        });
      }
    }
  }
  
  /**
   * 标记有本地变更待同步
   */
  markLocalChanges(updateType: 'content' | 'structure' | 'position' = 'structure') {
    this.persistState.update(s => ({
      ...s,
      hasPendingLocalChanges: true,
      lastUpdateType: updateType
    }));
  }
  
  /**
   * 获取上次更新类型
   */
  getLastUpdateType(): 'content' | 'structure' | 'position' {
    return this.persistState().lastUpdateType;
  }
  
  /**
   * 检查是否有待处理的本地变更
   */
  hasPendingLocalChanges(): boolean {
    return this.persistState().hasPendingLocalChanges;
  }
  
  /**
   * 获取上次持久化时间
   */
  getLastPersistAt(): number {
    return this.persistState().lastPersistAt;
  }
  
  /**
   * 调度持久化
   */
  schedulePersist() {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persistActiveProject();
    }, SYNC_CONFIG.DEBOUNCE_DELAY);
  }
  
  /**
   * 立即刷新待处理的持久化
   * 用于页面卸载前确保数据已保存
   * 注意：这是同步方法，只保存到本地缓存
   */
  flushPendingPersist(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    
    // 同步保存到本地缓存（不等待云端）
    const projects = this.projectState.projects();
    if (projects.length > 0) {
      this.core.saveOfflineSnapshot(projects);
      this.logger.info('页面卸载前已保存本地缓存', { projectCount: projects.length });
    }
  }
  
  /**
   * 设置远程变更回调
   */
  setupRemoteChangeCallbacks(
    onRemoteChange: (payload: { eventType?: string; projectId?: string } | undefined) => Promise<void>,
    onTaskChange: (payload: { eventType: string; taskId: string; projectId: string }) => void
  ) {
    this.core.setRemoteChangeCallback(onRemoteChange);
    this.core.setTaskChangeCallback(onTaskChange);
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
    return this.core.loadFullProjectOptimized(projectId);
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
  hasPendingChangesForProject(projectId: string): boolean {
    // 检查 ActionQueue 中是否有该项目的待处理操作
    const pendingActions = this.actionQueue.getPendingActionsForProject(projectId);
    return pendingActions.length > 0;
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
  async softDeleteTasksBatch(projectId: string, taskIds: string[]): Promise<number> {
    return this.core.softDeleteTasksBatch(projectId, taskIds);
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
      (projectId) => this.getTombstoneIds(projectId)
    );
  }
  
  /**
   * 静默保存冲突到仓库（不弹窗）
   */
  private async saveConflictSilently(
    localProject: Project, 
    remoteProject: Project,
    conflictedFields: string[]
  ): Promise<void> {
    await this.conflictStorage.saveConflict({
      projectId: localProject.id,
      localProject,
      remoteProject,
      conflictedAt: new Date().toISOString(),
      localVersion: localProject.version ?? 0,
      remoteVersion: remoteProject.version ?? 0,
      reason: 'version_mismatch',
      conflictedFields,
      acknowledged: false
    });
  }
  
  /**
   * 尝试重新加载冲突数据
   */
  async tryReloadConflictData(
    userId: string, 
    findProject: (id: string) => Project | undefined
  ) {
    return this.core.tryReloadConflictData(userId, findProject);
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
    return this.conflictService.resolveConflict(
      projectId,
      choice,
      localProject,
      remoteProject
    );
  }
  
  /**
   * 智能合并项目
   * 
   * @param localProject 本地项目
   * @param remoteProject 远程项目  
   * @param tombstoneIds 已永久删除的任务 ID 集合（必需参数）
   */
  smartMerge(localProject: Project, remoteProject: Project, tombstoneIds: Set<string>) {
    return this.conflictService.smartMerge(localProject, remoteProject, tombstoneIds);
  }
  
  /**
   * 获取项目的 tombstone IDs
   */
  async getTombstoneIds(projectId: string): Promise<Set<string>> {
    return this.core.getTombstoneIds(projectId);
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
      (projectId) => this.getTombstoneIds(projectId),
      (local, remote) => this.conflict$.next({
        localProject: local,
        remoteProject: remote,
        projectId: local.id
      })
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
    this.conflict$.complete();
    this.core.destroy();
  }
  
  // ========== 私有方法 ==========
  
  private async persistActiveProject() {
    const state = this.persistState();
    if (state.isPersisting) {
      this.persistState.update(s => ({ ...s, hasPending: true }));
      return;
    }
    
    this.persistState.update(s => ({ ...s, isPersisting: true }));
    let outcome: PersistOutcome = { remoteConfirmed: false };
    
    try {
      outcome = await this.doPersistActiveProject();
    } finally {
      const currentState = this.persistState();
      this.persistState.update(s => ({ 
        ...s, 
        isPersisting: false,
        lastPersistAt: Date.now(),
        hasPendingLocalChanges: outcome.remoteConfirmed
          ? false
          : currentState.hasPendingLocalChanges
      }));
      
      if (currentState.hasPending) {
        this.persistState.update(s => ({ ...s, hasPending: false }));
        this.schedulePersist();
      }

      this.updateSyncObservability(outcome);
    }
  }
  
  private async doPersistActiveProject(): Promise<PersistOutcome> {
    const project = this.projectState.activeProject();
    const projects = this.projectState.projects();
    const now = new Date().toISOString();
    
    // 更新活动项目的 updatedAt 时间戳
    const updatedProjects = projects.map(p => 
      p.id === project?.id ? { ...p, updatedAt: now } : p
    );
    
    // 始终先保存到本地离线快照（防止任何情况下的数据丢失）
    // 注意：这里使用更新后的项目列表，确保 updatedAt 被保存
    this.core.saveOfflineSnapshot(updatedProjects);
    
    if (!project) {
      return { remoteConfirmed: false };
    }

    const userId = this.authService.currentUserId();
    if (!userId) {
      // 未登录时仅保存到本地，但需要更新本地状态的 updatedAt
      this.projectState.updateProjects(ps =>
        ps.map(p => p.id === project.id ? { ...p, updatedAt: now } : p)
      );
      return { remoteConfirmed: false, projectId: project.id };
    }

    // 若该项目已有未解决的冲突：
    // - 只做本地快照（上面已做），不再反复触发云端保存与冲突弹窗；
    // - 让用户在合适时机进入冲突解决流程。
    const existingConflict = this.conflictData();
    if (this.hasConflict() && existingConflict && (existingConflict as { projectId?: string }).projectId === project.id) {
      this.logger.info('存在未解决冲突，跳过云端持久化', { projectId: project.id });
      return { remoteConfirmed: false, projectId: project.id };
    }

    try {
      // 使用智能同步：根据变更量自动选择增量或全量同步
      const result = await this.core.saveProjectSmart(
        { ...project, updatedAt: now },
        userId
      );
      
      if (result.success) {
        // 更新本地状态：updatedAt 和 version（如果有返回）
        this.projectState.updateProjects(ps =>
          ps.map(p => 
            p.id === project.id 
              ? {
                  ...p,
                  updatedAt: now,
                  version: result.newVersion ?? p.version,
                  syncSource: 'synced',
                  pendingSync: false
                }
              : p
          )
        );
        // 同步成功后，再次保存快照以确保版本号同步
        this.core.saveOfflineSnapshot(this.projectState.projects());
        
        // 【关键】同步成功后，解锁该项目的所有字段锁
        this.changeTracker.clearProjectFieldLocks(project.id);
        this.changeTracker.clearProjectChanges(project.id);
        
        // 如果有验证警告，记录日志但不打扰用户
        if (result.validationWarnings && result.validationWarnings.length > 0) {
          this.logger.warn('同步完成但有警告', {
            projectId: project.id,
            warnings: result.validationWarnings
          });
        }
        return { remoteConfirmed: true, projectId: project.id };
      } else if (result.conflict && result.remoteData) {
        // 版本冲突处理：静默保存到冲突仓库，不弹窗打扰用户
        await this.saveConflictSilently(project, result.remoteData, []);
        this.logger.warn('检测到数据冲突，已保存到冲突仓库', { projectId: project.id });
        return { remoteConfirmed: false, projectId: project.id };
      } else if (result.validationWarnings && result.validationWarnings.length > 0) {
        // 验证失败导致同步中止
        this.logger.error('同步验证失败', {
          projectId: project.id,
          warnings: result.validationWarnings
        });
        this.toastService.error(
          '同步验证失败',
          '检测到潜在的数据丢失风险，已中止同步。数据已保存到本地。'
        );
        return { remoteConfirmed: false, projectId: project.id };
      }
      if (!result.success) {
        const failedTasks = result.failedTaskIds?.length ?? 0;
        const failedConnections = result.failedConnectionIds?.length ?? 0;
        if (failedTasks > 0 || failedConnections > 0) {
          this.logger.warn('远端未完全确认，同步保持待处理状态', {
            projectId: project.id,
            failedTasks,
            failedConnections
          });
          this.toastService.warning(
            '同步未完成',
            `任务失败 ${failedTasks} 项，连接失败 ${failedConnections} 项，已保留待同步标记`
          );
        }
      }
      return { remoteConfirmed: false, projectId: project.id };
    } catch (error) {
      this.logger.error('持久化项目时发生异常', { error });
      // 乐观UI：静默记录错误，不阻塞用户操作
      // 数据已保存到本地离线快照，网络恢复后会自动重试
      this.logger.warn('自动保存失败，更改已保存到本地', { error });
      
      // 增强：在离线模式下提示用户
      if (!navigator.onLine) {
        this.toastService.info('离线模式', '更改已保存到本地，联网后将自动同步');
      }
      return { remoteConfirmed: false, projectId: project.id };
    }
  }

  private updateSyncObservability(outcome: PersistOutcome): void {
    this.syncAttempts += 1;
    if (outcome.remoteConfirmed) {
      this.syncConfirmed += 1;
    }
    const successRate = this.syncAttempts === 0
      ? null
      : Number((this.syncConfirmed / this.syncAttempts).toFixed(4));
    const dirtyAgeMs = outcome.projectId
      ? this.changeTracker.getOldestChangeAgeMs(outcome.projectId)
      : this.changeTracker.getOldestChangeAgeMs();
    const lastSync = outcome.projectId ? this.core.getLastSyncTime(outcome.projectId) : null;
    const cursorLagMs = lastSync ? Math.max(0, Date.now() - new Date(lastSync).getTime()) : 0;
    const queuePressureEvents =
      this.retryQueue.pressureEvents +
      (this.actionQueue.queueFrozen() ? 1 : 0);

    this.sentryAlert.updateSyncContext({
      lastSyncTimestamp: this.core.syncState().lastSyncTime,
      pendingActions: this.pendingActionsCount(),
      syncSuccessRate: successRate,
      queuePressureEvents,
      dirtyAgeMs,
      cursorLagMs
    });
  }
}
