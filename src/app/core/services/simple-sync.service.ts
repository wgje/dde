/** SimpleSyncService 门面只做同步编排；新增业务分支应下切到 sync 子服务。 */

import { Injectable, inject, computed, DestroyRef, Injector } from '@angular/core';
import { SupabaseClientService } from '../../../services/supabase-client.service';
import { LoggerService } from '../../../services/logger.service';
import { ToastService } from '../../../services/toast.service';
import { ActionQueueService } from '../../../services/action-queue.service';
import { RequestThrottleService } from '../../../services/request-throttle.service';
import { ClockSyncService } from '../../../services/clock-sync.service';
import { EventBusService } from '../../../services/event-bus.service';
import {
  TombstoneService,
  RealtimePollingService,
  SessionManagerService,
  SyncOperationHelperService,
  UserPreferencesSyncService,
  ProjectDataService,
  BatchSyncService,
  TaskSyncOperationsService,
  type TaskPurgeResult,
  ConnectionSyncOperationsService,
  RetryQueueService,
  ConnectivityRecoveryService,
  type RetryQueueLastFailure,
  type RetryableEntityType,
  type RetryableOperation,
  type TaskDeleteBaseUpdatedAtMap,
} from './sync';
import type {
  ProjectListMetadataLoadOptions,
  StartupOfflineSnapshotLoadResult,
} from './sync/project-data.service';
import { Task, Project, Connection, UserPreferences } from '../../../models';
import { nowISO } from '../../../utils/date';
import type { Result, OperationError } from '../../../utils/result';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SentryLazyLoaderService } from '../../../services/sentry-lazy-loader.service';
import {
  ProjectSaveFlightCoordinatorService,
  type ProjectSaveResult,
} from './sync/project-save-flight-coordinator.service';
import {
  SyncResumeCoordinatorService,
  type ResumeRecoverOptions,
} from './sync/sync-resume-coordinator.service';
import { ProjectPushService } from './sync/project-push.service';
import { ProjectDeleteCoordinatorService } from './sync/project-delete-coordinator.service';
import {
  ProjectSyncCursorService,
  type ProjectDeltaDrift,
} from './sync/project-sync-cursor.service';
import type { RemoteChangeCallback, TaskChangeCallback, UserPreferencesChangeCallback } from './sync/realtime-polling.service';
import { RetryQueueEnqueueService } from './sync/retry-queue-enqueue.service';
import { BlackBoxSyncService } from '../../../services/black-box-sync.service';
import { ChangeTrackerService } from '../../../services/change-tracker.service';
import type { TaskWriteIntent } from '../../../services/sync-rpc-client.service';
import { SyncStateService, type ConflictData } from './sync/sync-state.service';
import type { ProjectSyncCursor } from '../state/persistence';
import {
  configureSimpleSyncBatchCallbacks,
  wireSimpleSyncCoordinatorCallbacks,
} from './simple-sync-callbacks.helpers';
import { resolveSimpleSyncSupabaseClient } from './simple-sync-client.helpers';
import {
  optionalTail,
  taskDeleteOperationTail,
} from './simple-sync-delegate-tail.helpers';
import { SimpleSyncRuntimeController } from './simple-sync-runtime.controller';

export type { ProjectSyncCursor, ProjectSyncCursorEntityType } from '../state/persistence';
export type { ProjectDeltaDrift } from './sync/project-sync-cursor.service';
export type { RemoteChangeCallback, TaskChangeCallback, UserPreferencesChangeCallback } from './sync/realtime-polling.service';
export type { ResumeRecoverOptions } from './sync/sync-resume-coordinator.service';

@Injectable({ providedIn: 'root' })
export class SimpleSyncService {
  private readonly supabase = inject(SupabaseClientService);
  private readonly injector = inject(Injector);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('SimpleSync');
  private readonly toast = inject(ToastService);
  private readonly throttle = inject(RequestThrottleService);
  private readonly clockSync = inject(ClockSyncService);
  private readonly eventBus = inject(EventBusService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly changeTracker = inject(ChangeTrackerService);

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
  private readonly syncStateService = inject(SyncStateService);
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly retryQueueService = inject(RetryQueueService);
  private readonly blackBoxSync = inject(BlackBoxSyncService);
  private readonly connectivityRecovery = inject(ConnectivityRecoveryService);
  private readonly projectSaveFlightCoordinator = inject(ProjectSaveFlightCoordinatorService);
  private readonly syncResumeCoordinator = inject(SyncResumeCoordinatorService);
  private readonly projectPush = inject(ProjectPushService);
  private readonly projectDelete = inject(ProjectDeleteCoordinatorService);
  private readonly projectSyncCursor = inject(ProjectSyncCursorService);
  private readonly retryEnqueue = inject(RetryQueueEnqueueService);
  private getActionQueue(): ActionQueueService | null {
    return this.injector.get(ActionQueueService, null);
  }

  /**
   * 获取 Supabase 客户端
   */
  private async getSupabaseClient(): Promise<SupabaseClient | null> {
    return resolveSimpleSyncSupabaseClient({
      supabase: this.supabase,
      syncStateService: this.syncStateService,
      sentryLazyLoader: this.sentryLazyLoader,
      logger: this.logger,
    });
  }

  /** 同步状态（委托给 SyncStateService 统一管理，解决双源进度不一致问题） */
  readonly syncState = this.syncStateService.syncState;

  /** 兼容旧接口 */
  readonly state = this.syncState;

  /** 便捷 computed 属性 */
  readonly isOnline = computed(() => this.syncState().isOnline);
  readonly isSyncing = computed(() => this.syncState().isSyncing);
  readonly hasConflict = computed(() => this.syncState().hasConflict);
  /** 远程加载状态统一委派给 SyncStateService，避免门面持有第二份进度状态。 */
  readonly isLoadingRemote = this.syncStateService.isLoadingRemote;

  private readonly runtime = new SimpleSyncRuntimeController({
    logger: this.logger,
    eventBus: this.eventBus,
    destroyRef: this.destroyRef,
    supabase: this.supabase,
    realtimePollingService: this.realtimePollingService,
    retryQueueService: this.retryQueueService,
    syncStateService: this.syncStateService,
    connectivityRecovery: this.connectivityRecovery,
    blackBoxSync: this.blackBoxSync,
    getActionQueue: () => this.getActionQueue(),
    syncState: this.syncState,
    state: this.state,
    pushTask: (task, projectId, skipTombstoneCheck, fromRetryQueue, sourceUserId, treatTombstoneAsPermanent, writeIntent, operationId) =>
      this.pushTask(task, projectId, skipTombstoneCheck, fromRetryQueue, sourceUserId, treatTombstoneAsPermanent, writeIntent, operationId),
    deleteTask: (taskId, projectId, sourceUserId, fromRetryQueue, baseUpdatedAt, operationId) =>
      this.deleteTask(taskId, projectId, sourceUserId, fromRetryQueue, baseUpdatedAt, operationId),
    pushConnection: (connection, projectId, skipTombstoneCheck, skipTaskExistenceCheck, fromRetryQueue, sourceUserId, operationId) =>
      this.pushConnection(connection, projectId, skipTombstoneCheck, skipTaskExistenceCheck, fromRetryQueue, sourceUserId, operationId),
    addToRetryQueueDurably: (type, operation, data, projectId, sourceUserId, taskIdsToDelete, writeIntent, taskDeleteBaseUpdatedAtMap, operationId) =>
      this.addToRetryQueueDurably(type, operation, data, projectId, sourceUserId, taskIdsToDelete, writeIntent, taskDeleteBaseUpdatedAtMap, operationId),
    markSyncRecoveredIfIdle: (timestamp) => this.markSyncRecoveredIfIdle(timestamp),
    resetSessionExpired: () => this.resetSessionExpired(),
  });

  constructor() {
    this.runtime.setupSyncStateListeners();
    configureSimpleSyncBatchCallbacks({
      batchSyncService: this.batchSyncService,
      facade: {
        pushProjectFromBatchSync: this.pushProjectFromBatchSync.bind(this),
        pushTaskWithResult: this.pushTaskWithResult.bind(this),
        pushTaskPosition: this.pushTaskPosition.bind(this),
        pushConnectionWithResult: this.pushConnectionWithResult.bind(this),
        getTombstoneIds: this.getTombstoneIds.bind(this),
        getConnectionTombstoneIds: this.getConnectionTombstoneIds.bind(this),
        purgeTasksFromCloudWithResult: this.purgeTasksFromCloudWithResult.bind(this),
        topologicalSortTasks: this.topologicalSortTasks.bind(this),
        addToRetryQueue: this.addToRetryQueue.bind(this),
        addToRetryQueueDurably: this.addToRetryQueueDurably.bind(this),
        confirmRetryQueuePersistence: this.confirmRetryQueuePersistence.bind(this),
      },
    });
    wireSimpleSyncCoordinatorCallbacks({
      projectSaveFlightCoordinator: this.projectSaveFlightCoordinator,
      projectPush: this.projectPush,
      projectDelete: this.projectDelete,
      projectSyncCursor: this.projectSyncCursor,
      getSupabaseClient: this.getSupabaseClient.bind(this),
      addToRetryQueueDurably: this.addToRetryQueueDurably.bind(this),
    });
    this.runtime.setupRetryQueueHandler();
    this.runtime.setupBlackBoxRetryHandler();
    this.runtime.setupLifecycleListeners(() => this.cleanup());
  }

  private pushProjectFromBatchSync(
    project: Project,
    fromRetryQueue = false,
    sourceUserId?: string,
    taskIdsToDelete?: string[],
    taskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap,
    operationId?: string,
  ): Promise<{ success: boolean; conflict?: boolean; remoteData?: Project; retryEnqueued?: boolean; failureReason?: string; terminal?: boolean }> {
    return this.pushProjectWithResult(
      project,
      fromRetryQueue,
      sourceUserId,
      taskIdsToDelete,
      ...taskDeleteOperationTail(taskDeleteBaseUpdatedAtMap, operationId),
    );
  }

  startRuntime(): void {
    this.runtime.startRuntime();
  }

  stopRuntime(): void {
    this.syncResumeCoordinator.cancelPendingBackgroundRecovery();
    this.runtime.stopRuntime();
  }

  // ==================== 网络与生命周期 ====================

  private cleanup(): void {
    this.stopRuntime();
    this.realtimePollingService.unsubscribeFromProject();
  }

  async suspendRemoteTransport(): Promise<void> {
    await this.realtimePollingService.suspendTransport();
  }

  async restoreRemoteConnectivity(reason: string): Promise<void> {
    await this.connectivityRecovery.restoreRemoteConnectivity(reason);
  }

  flushRetryQueueSync(): void {
    this.retryQueueService.flushSync();
  }

  /**
   * 页面恢复后的同步自愈流程
   * 顺序：重试队列 -> 远程增量/全量拉取回调 -> 恢复实时更新
   */
  async recoverAfterResume(reason: string, options: ResumeRecoverOptions = {}): Promise<void> {
    return this.syncResumeCoordinator.recoverAfterResume(reason, options);
  }

  // ==================== 任务同步（委托） ====================

  async pushTask(
    task: Task,
    projectId: string,
    skipTombstoneCheck = false,
    fromRetryQueue = false,
    sourceUserId?: string,
    treatTombstoneAsPermanent = false,
    writeIntent?: TaskWriteIntent,
    operationId?: string,
  ): Promise<boolean> {
    return this.taskSyncOps.pushTask(
      task,
      projectId,
      skipTombstoneCheck,
      fromRetryQueue,
      sourceUserId,
      treatTombstoneAsPermanent,
      writeIntent,
      ...optionalTail(operationId),
    );
  }

  async pushTaskPosition(
    taskId: string,
    x: number,
    y: number,
    projectId?: string,
    fallbackTask?: Task,
    sourceUserId?: string,
    operationId?: string,
  ): Promise<boolean> {
    return this.taskSyncOps.pushTaskPosition(
      taskId,
      x,
      y,
      projectId,
      fallbackTask,
      sourceUserId,
      ...optionalTail(operationId),
    );
  }

  async pullTasks(projectId: string, since?: string): Promise<Task[]> {
    return this.taskSyncOps.pullTasks(projectId, since);
  }

  async deleteTask(
    taskId: string,
    projectId: string,
    sourceUserId?: string,
    fromRetryQueue = false,
    baseUpdatedAt?: string | null,
    operationId?: string,
  ): Promise<boolean> {
    return this.taskSyncOps.deleteTask(
      taskId,
      projectId,
      sourceUserId,
      fromRetryQueue,
      baseUpdatedAt,
      ...optionalTail(operationId),
    );
  }

  async softDeleteTasksBatch(
    projectId: string,
    taskIds: string[],
    tombstoneTimestamps?: Record<string, string | number | null | undefined>,
    baseUpdatedAtMap?: Record<string, string | null | undefined>,
  ): Promise<number> {
    return this.taskSyncOps.softDeleteTasksBatch(projectId, taskIds, tombstoneTimestamps, baseUpdatedAtMap);
  }

  async purgeTasksFromCloud(projectId: string, taskIds: string[], sourceUserId?: string): Promise<boolean> {
    return this.taskSyncOps.purgeTasksFromCloud(projectId, taskIds, sourceUserId);
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

  addLocalTombstones(
    projectId: string,
    taskIds: string[],
    timestampsByTaskId?: Record<string, string | number | null | undefined>,
  ): void {
    this.taskSyncOps.addLocalTombstones(projectId, taskIds, timestampsByTaskId);
  }

  private topologicalSortTasks(tasks: Task[]): Task[] {
    return this.taskSyncOps.topologicalSortTasks(tasks);
  }

  invalidateTombstoneCache(projectId: string): void {
    this.tombstoneService.invalidateCache(projectId);
  }

  // ==================== 连接同步（委托） ====================

  async pushConnection(
    connection: Connection,
    projectId: string,
    skipTombstoneCheck = false,
    skipTaskExistenceCheck = false,
    fromRetryQueue = false,
    sourceUserId?: string,
    operationId?: string,
    requireSyncRpc = false,
  ): Promise<boolean> {
    if (requireSyncRpc) {
      return this.connectionSyncOps.pushConnection(
        connection,
        projectId,
        skipTombstoneCheck,
        skipTaskExistenceCheck,
        fromRetryQueue,
        sourceUserId,
        operationId,
        true,
      );
    }

    return this.connectionSyncOps.pushConnection(
      connection,
      projectId,
      skipTombstoneCheck,
      skipTaskExistenceCheck,
      fromRetryQueue,
      sourceUserId,
      ...optionalTail(operationId),
    );
  }

  async getConnectionTombstoneIds(projectId: string): Promise<Set<string>> {
    return this.connectionSyncOps.getConnectionTombstoneIds(projectId);
  }

  private async pushTaskWithResult(
    task: Task,
    projectId: string,
    skipTombstoneCheck = false,
    fromRetryQueue = false,
    sourceUserId?: string,
    writeIntent?: TaskWriteIntent,
    operationId?: string,
  ): Promise<{ success: boolean; retryEnqueued?: boolean }> {
    const success = await this.pushTask(
      task,
      projectId,
      skipTombstoneCheck,
      fromRetryQueue,
      sourceUserId,
      false,
      writeIntent,
      ...optionalTail(operationId),
    );
    return {
      success,
      retryEnqueued: !success && this.retryEnqueue.hasRetryQueueEntity('task', task.id),
    };
  }

  private async pushConnectionWithResult(
    connection: Connection,
    projectId: string,
    skipTombstoneCheck = false,
    skipTaskExistenceCheck = false,
    fromRetryQueue = false,
    sourceUserId?: string,
    operationId?: string,
    requireSyncRpc = false,
  ): Promise<{ success: boolean; retryEnqueued?: boolean }> {
    if (requireSyncRpc) {
      const success = await this.pushConnection(
        connection,
        projectId,
        skipTombstoneCheck,
        skipTaskExistenceCheck,
        fromRetryQueue,
        sourceUserId,
        operationId,
        true,
      );
      return {
        success,
        retryEnqueued: !success && this.retryEnqueue.hasRetryQueueEntity('connection', connection.id),
      };
    }

    const success = await this.pushConnection(
      connection,
      projectId,
      skipTombstoneCheck,
      skipTaskExistenceCheck,
      fromRetryQueue,
      sourceUserId,
      ...optionalTail(operationId),
    );
    return {
      success,
      retryEnqueued: !success && this.retryEnqueue.hasRetryQueueEntity('connection', connection.id),
    };
  }

  private async purgeTasksFromCloudWithResult(
    projectId: string,
    taskIds: string[],
    sourceUserId?: string,
    baseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap,
    operationId?: string,
  ): Promise<TaskPurgeResult> {
    return this.taskSyncOps.purgeTasksFromCloudDetailed(projectId, taskIds, sourceUserId, false, baseUpdatedAtMap, operationId);
  }

  /** 批量预热所有项目的 tombstone 缓存（单次 RPC 替代 N 次查询） */
  async batchPreloadTombstones(projectIds: string[]): Promise<boolean> {
    const client = await this.getSupabaseClient();
    if (!client) return false;
    return this.tombstoneService.batchPreloadTombstones(projectIds, client);
  }

  // ==================== 项目同步 ====================

  async pushProject(
    project: Project,
    fromRetryQueue = false,
    sourceUserId?: string,
    taskIdsToDelete?: string[],
    taskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap,
    operationId?: string,
  ): Promise<boolean> {
    return this.projectPush.pushProject(
      project,
      fromRetryQueue,
      sourceUserId,
      taskIdsToDelete,
      ...taskDeleteOperationTail(taskDeleteBaseUpdatedAtMap, operationId),
    );
  }

  // 同名 delegate：项目推送链路已抽离到 ProjectPushService（单一事实源）。
  // 保留此方法以维持 BatchSync 回调旧契约与既有 spec 的直接调用合约。
  private pushProjectWithResult(
    project: Project,
    fromRetryQueue = false,
    sourceUserId?: string,
    taskIdsToDelete?: string[],
    taskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap,
    operationId?: string,
  ): Promise<{ success: boolean; conflict?: boolean; remoteData?: Project; retryEnqueued?: boolean; failureReason?: string; terminal?: boolean }> {
    return this.projectPush.pushProjectWithResult(
      project,
      fromRetryQueue,
      sourceUserId,
      taskIdsToDelete,
      ...taskDeleteOperationTail(taskDeleteBaseUpdatedAtMap, operationId),
    );
  }

  private async confirmRetryQueuePersistence(): Promise<boolean> {
    return this.retryQueueService.persistNow();
  }

  async pullProjects(since?: string): Promise<Project[]> {
    return this.projectDataService.pullProjects(since, {
      getClient: () => this.getSupabaseClient(),
      getRecentValidatedUserId: () => this.sessionManager.getRecentValidationSnapshot(60_000)?.userId,
      rowToProject: row => this.projectDataService.rowToProject(row),
    });
  }

  // ==================== 重试队列（委托 RetryQueueService） ====================

  async addToRetryQueue(
    type: RetryableEntityType,
    operation: RetryableOperation,
    data: Task | Project | Connection | { id: string },
    projectId?: string,
    sourceUserId?: string,
    taskIdsToDelete?: string[],
    writeIntent?: TaskWriteIntent,
    taskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap,
    operationId?: string,
    lastFailure?: RetryQueueLastFailure,
  ): Promise<boolean> {
    return this.retryEnqueue.addToRetryQueue(
      type,
      operation,
      data,
      projectId,
      sourceUserId,
      taskIdsToDelete,
      writeIntent,
      taskDeleteBaseUpdatedAtMap,
      operationId,
      ...optionalTail(lastFailure),
    );
  }

  async addToRetryQueueDurably(
    type: RetryableEntityType,
    operation: RetryableOperation,
    data: Task | Project | Connection | { id: string },
    projectId?: string,
    sourceUserId?: string,
    taskIdsToDelete?: string[],
    writeIntent?: TaskWriteIntent,
    taskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap,
    operationId?: string,
    lastFailure?: RetryQueueLastFailure,
  ): Promise<boolean> {
    return this.retryEnqueue.addToRetryQueueDurably(
      type,
      operation,
      data,
      projectId,
      sourceUserId,
      taskIdsToDelete,
      writeIntent,
      taskDeleteBaseUpdatedAtMap,
      operationId,
      ...optionalTail(lastFailure),
    );
  }

  clearRetryQueue(): void {
    this.retryEnqueue.clearRetryQueue();
  }

  // ==================== Realtime / 轮询 ====================

  isRealtimeEnabled(): boolean { return this.realtimePollingService.isRealtimeEnabled(); }

  setOnRemoteChange(callback: RemoteChangeCallback): void { this.realtimePollingService.setOnRemoteChange(callback); }

  setUserPreferencesChangeCallback(callback: UserPreferencesChangeCallback | null): void { this.realtimePollingService.setUserPreferencesChangeCallback(callback); }

  setRealtimeEnabled(enabled: boolean): void { this.realtimePollingService.setRealtimeEnabled(enabled); }

  async subscribeToProject(projectId: string, userId: string): Promise<void> { await this.realtimePollingService.subscribeToProject(projectId, userId); }

  async unsubscribeFromProject(): Promise<void> { await this.realtimePollingService.unsubscribeFromProject(); }

  setRemoteChangeCallback(callback: RemoteChangeCallback): void { this.realtimePollingService.setOnRemoteChange(callback); }

  setTaskChangeCallback(callback: TaskChangeCallback): void { this.realtimePollingService.setTaskChangeCallback(callback); }

  async initRealtimeSubscription(userId: string): Promise<void> {
    this.logger.debug('Realtime 订阅已初始化', { userId: userId.substring(0, 8) });
  }

  teardownRealtimeSubscription(): void { this.realtimePollingService.unsubscribeFromProject(); }

  pauseRealtimeUpdates(): void { this.realtimePollingService.pauseRealtimeUpdates(); }

  resumeRealtimeUpdates(): void { this.realtimePollingService.resumeRealtimeUpdates(); }

  // ==================== 用户偏好 ====================

  async loadUserPreferences(userId: string): Promise<UserPreferences | null> { return this.userPrefsSync.loadUserPreferences(userId); }

  async saveUserPreferences(userId: string, preferences: Partial<UserPreferences>): Promise<boolean> { return this.userPrefsSync.saveUserPreferences(userId, preferences); }

  // ==================== Delta Sync ====================

  async checkForDrift(projectId: string): Promise<ProjectDeltaDrift> { return this.projectSyncCursor.checkForDrift(projectId); }

  buildProjectSyncCursorFromProject(project: Project): ProjectSyncCursor | null { return this.projectSyncCursor.buildProjectSyncCursorFromProject(project); }

  setLastSyncTime(projectId: string, timestamp: string): void { this.projectSyncCursor.setLastSyncTime(projectId, timestamp); }

  getLastSyncTime(projectId: string): string | null { return this.projectSyncCursor.getLastSyncTime(projectId); }

  getProjectSyncCursor(projectId: string): ProjectSyncCursor | null { return this.projectSyncCursor.getProjectSyncCursor(projectId); }

  async commitProjectSyncCursor(projectId: string, cursor: ProjectSyncCursor | null | undefined): Promise<void> { return this.projectSyncCursor.commitProjectSyncCursor(projectId, cursor); }

  async commitProjectSyncTimestamp(projectId: string, timestamp: string): Promise<void> { return this.projectSyncCursor.commitProjectSyncTimestamp(projectId, timestamp); }

  markSyncRecoveredIfIdle(timestamp = nowISO()): boolean { return this.retryEnqueue.markSyncRecoveredIfIdle(timestamp); }

  hasPendingRetryRecovery(): boolean { return this.retryEnqueue.hasPendingRetryRecovery(); }

  clearLastSyncTime(projectId: string): void { this.projectSyncCursor.clearLastSyncTime(projectId); }

  // ==================== 冲突解决 ====================

  resolveConflict(projectId: string, resolvedProject: Project, strategy: 'local' | 'remote'): void {
    this.logger.info('解决冲突', { projectId, strategy });
    this.syncStateService.update({ hasConflict: false, conflictData: null });
  }

  setConflict(conflictData: ConflictData): void { this.syncStateService.update({ hasConflict: true, conflictData }); }

  clearConflict(): void { this.syncStateService.update({ hasConflict: false, conflictData: null }); }

  // ==================== 项目加载 ====================

  async saveProjectToCloud(
    project: Project,
    userId: string,
    taskIdsToDelete?: string[],
    taskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap,
    operationId?: string,
  ): Promise<ProjectSaveResult> {
    return this.projectSaveFlightCoordinator.save(
      project,
      userId,
      taskIdsToDelete,
      ...taskDeleteOperationTail(taskDeleteBaseUpdatedAtMap, operationId),
    );
  }

  async saveProjectSmart(
    project: Project,
    userId: string,
    taskIdsToDelete?: string[],
    taskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap,
  ): Promise<{ success: boolean; conflict?: boolean; remoteData?: Project; newVersion?: number; validationWarnings?: string[]; projectPushed?: boolean; failedTaskIds?: string[]; failedConnectionIds?: string[]; retryEnqueued?: string[]; failureReason?: string; terminal?: boolean; partialRetryHandoff?: boolean }> {
    const result = await this.saveProjectToCloud(project, userId, taskIdsToDelete, taskDeleteBaseUpdatedAtMap);
    return { ...result, newVersion: result.newVersion ?? project.version };
  }

  async loadFullProjectOptimized(projectId: string, expectedUserId?: string): Promise<Project | null> { return this.projectDataService.loadFullProjectOptimized(projectId, expectedUserId); }

  async loadFullProject(projectId: string, userId?: string): Promise<Project | null> { return this.projectDataService.loadFullProject(projectId, userId); }

  async loadProjectsFromCloud(userId: string, _silent?: boolean): Promise<Project[] | null> { return this.projectDataService.loadProjectsFromCloud(userId); }

  async loadProjectListMetadataFromCloud(userId: string, options: ProjectListMetadataLoadOptions = {}): Promise<Project[] | null> { return this.projectDataService.loadProjectListMetadataFromCloud(userId, options); }

  // 同名 delegate：项目删除链路已抽离到 ProjectDeleteCoordinatorService（单一事实源）。
  async deleteProjectFromCloud(projectId: string, userId: string, operationId?: string): Promise<Result<void, OperationError>> { return this.projectDelete.deleteProjectFromCloud(projectId, userId, operationId); }

  async loadSingleProject(projectId: string, userId: string): Promise<Project | null> { return this.loadFullProject(projectId, userId); }

  async getProjectSyncWatermark(projectId: string): Promise<string | null> { return this.projectDataService.getProjectSyncWatermark(projectId); }

  async getUserProjectsWatermark(): Promise<string | null> { return this.projectDataService.getUserProjectsWatermark(); }

  async listProjectHeadsSince(
    watermark: string | null,
    upperWatermark: string,
  ): Promise<Array<{ id: string; updatedAt: string; version: number }> | null> {
    return this.projectDataService.listProjectHeadsSince(watermark, upperWatermark);
  }

  async getAccessibleProjectProbe(projectId: string): Promise<{
    projectId: string;
    accessible: boolean;
    watermark: string | null;
  } | null> {
    return this.projectDataService.getAccessibleProjectProbe(projectId);
  }

  async getBlackBoxSyncWatermark(): Promise<string | null> { return this.projectDataService.getBlackBoxSyncWatermark(); }

  async getResumeRecoveryProbe(projectId?: string): Promise<{
    activeProjectId: string | null;
    activeAccessible: boolean;
    activeWatermark: string | null;
    projectsWatermark: string | null;
    blackboxWatermark: string | null;
    serverNow: string | null;
  } | null> {
    return this.projectDataService.getResumeRecoveryProbe(projectId);
  }

  async tryReloadConflictData(userId: string, _findProject?: (id: string) => Project | undefined): Promise<Project | undefined> {
    const state = this.syncState();
    if (!state.hasConflict || !state.conflictData) return undefined;
    const project = await this.loadFullProject(state.conflictData.projectId, userId);
    return project ?? undefined;
  }

  clearOfflineCache(): void {
    this.projectDataService.clearOfflineSnapshot();
    this.retryQueueService.clear();
    this.syncStateService.update({ pendingCount: 0 });
    this.logger.info('离线缓存已清除');
  }

  clearOfflineSnapshot(): void { this.projectDataService.clearOfflineSnapshot(); }

  saveOfflineSnapshot(projects: Project[], ownerUserId?: string | null): void { this.projectDataService.saveOfflineSnapshot(projects, ownerUserId); }

  async saveOfflineSnapshotAndWait(projects: Project[], ownerUserId?: string | null): Promise<void> { await this.projectDataService.saveOfflineSnapshotAndWait(projects, ownerUserId); }

  loadOfflineSnapshot(options?: { allowOwnerHint?: boolean }): Project[] | null { return this.projectDataService.loadOfflineSnapshot(options); }

  async loadStartupOfflineSnapshot(): Promise<StartupOfflineSnapshotLoadResult> { return this.projectDataService.loadStartupOfflineSnapshot(); }

  async loadOfflineSnapshotAsync(): Promise<Project[] | null> { return this.projectDataService.loadOfflineSnapshotAsync(); }

  // ==================== 会话管理 ====================

  resetSessionExpired(): void {
    if (!this.syncState().sessionExpired) return;

    const previousQueueLength = this.retryQueueService.length;
    this.syncStateService.update({ sessionExpired: false });

    this.logger.info('会话状态已重置', { previousQueueLength });

    if (this.state().isOnline && this.retryQueueService.length > 0) {
      this.logger.info('会话恢复，触发重试队列处理');
      void this.retryQueueService.processQueue().catch((error: unknown) => {
        this.logger.warn('会话恢复后的重试队列处理失败，保留队列等待后续自动重试', {
          error,
          previousQueueLength,
          remainingQueueLength: this.retryQueueService.length,
        });
      });
    }
  }

  destroy(): void {
    this.cleanup();
    this.unsubscribeFromProject();
    this.logger.info('SimpleSyncService 已销毁');
  }
}
