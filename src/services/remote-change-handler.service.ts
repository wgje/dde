/** 处理远程项目/任务变更；订阅、持久化、会话管理分别由 SyncCoordinator/UserSession 负责。 */
import { Injectable, inject, DestroyRef } from '@angular/core';
import { SyncCoordinatorService } from './sync-coordinator.service';
import { ActionQueueService } from './action-queue.service';
import { ProjectDataService, TaskSyncOperationsService } from '../core-bridge';
import { UndoService } from './undo.service';
import { UiStateService } from './ui-state.service';
import { ProjectStateService } from './project-state.service';
import { ToastService } from './toast.service';
import { AuthService } from './auth.service';
import { LoggerService } from './logger.service';
import { ChangeTrackerService } from './change-tracker.service';
import { PermissionDeniedHandlerService } from './permission-denied-handler.service';
import { UserSessionService } from './user-session.service';
import { Project, Task } from '../models';
import { SupabaseError, supabaseErrorToError } from '../utils/supabase-error';
import { reloadViaForceClearCache } from '../utils/force-clear-cache';
import { SYNC_CONFIG } from '../config/sync.config';
import type {
  RemoteChangeCallbacks,
  RemoteProjectChangePayload,
  RemoteTaskChangePayload,
  RemoteTaskUpdateContext,
} from './remote-change-handler.types';
import {
  canApplyRemoteTaskUpdateResult,
  captureRemoteConnectionDeletionGuard,
  collectRemoteProjectDeletionSets,
  decideRemoteTaskDeletion,
  isRemoteConnectionDeletionStillCurrent,
  removeDeletedRecords,
  removeRemoteTaskFromProject,
  resolveRemoteTaskTargetProject,
  shouldAddRemoteTask,
  shouldSkipStaleRemoteTask,
  type RemoteConnectionDeletionGuard,
  type RemoteProjectDeletionSets,
} from './remote-change-handler.helpers';
import {
  captureRemoteProjectSessionContext,
  createRemoteTaskUpdateContext,
  createStaleRemoteProjectSessionLogContext,
  evaluateRemoteProjectUpdateGuard,
  isPermissionDeniedRemoteTaskError,
  shouldSkipRemoteTaskChange,
} from './remote-change-handler-context';
import { RemoteTaskMergeController } from './remote-task-merge.controller';
import { RemoteTaskUpdateRequestController } from './remote-task-update-request.controller';
import {
  RemoteProjectDeleteDeferralController,
  type RemoteProjectDeleteSessionContext as RemoteProjectSessionContext,
} from './remote-project-delete-deferral.controller';
import { createTaskTombstoneSnapshot } from './conflict-resolution-merge.helpers';
export type { RemoteChangeCallbacks, RemoteProjectChangePayload, RemoteTaskChangePayload } from './remote-change-handler.types';

@Injectable({
  providedIn: 'root'
})
export class RemoteChangeHandlerService {
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('RemoteChangeHandler');
  private syncCoordinator = inject(SyncCoordinatorService);
  private actionQueue = inject(ActionQueueService);
  private projectData = inject(ProjectDataService);
  private taskSyncOps = inject(TaskSyncOperationsService);
  private undoService = inject(UndoService);
  private uiState = inject(UiStateService);
  private projectState = inject(ProjectStateService);
  private toastService = inject(ToastService);
  private authService = inject(AuthService);
  private userSession = inject(UserSessionService);
  private changeTracker = inject(ChangeTrackerService);
  private permissionDeniedHandler = inject(PermissionDeniedHandlerService);
  private destroyRef = inject(DestroyRef);
  private readonly remoteTaskMerge = new RemoteTaskMergeController({
    getLockedFields: (taskId, projectId) =>
      this.changeTracker.getLockedFields(taskId, projectId),
    isEditing: () => this.uiState.isEditing,
    logger: this.logger,
  });
  /** 回调是否已设置（防止重复调用） */
  private callbacksInitialized = false;

  /** 按 project/task 隔离，只允许同一任务的最新请求继续。 */
  private readonly taskUpdateRequests = new RemoteTaskUpdateRequestController();
  private readonly projectDeleteDeferral = new RemoteProjectDeleteDeferralController({
    hasPendingWrite: (projectId, ownerUserId) => (
      this.syncCoordinator.hasPendingLocalChanges()
      || this.syncCoordinator.hasPendingChangesForProject(projectId, ownerUserId)
    ),
    isSessionCurrent: (context, projectId) => (
      this.isRemoteProjectSessionCurrent(context, projectId, 'deferred-project-delete')
    ),
    probe: projectId => this.syncCoordinator.getAccessibleProjectProbe(projectId),
    apply: projectId => this.applyRemoteProjectDelete(projectId),
    debug: (message, context) => this.logger.debug(message, context),
    info: (message, context) => this.logger.info(message, context),
    warn: (message, context) => this.logger.warn(message, context),
  });
  
  constructor() {
    const unsubscribePendingWriteState = this.syncCoordinator
      .subscribeToProjectPendingWriteStateChanges?.(() => {
        this.projectDeleteDeferral.requestReevaluation();
      });
    this.destroyRef.onDestroy(() => {
      unsubscribePendingWriteState?.();
      this.projectDeleteDeferral.destroy();
      this.callbacksInitialized = false;
      this.taskUpdateRequests.destroy();
    });
  }

  /**
   * 设置远程变更回调
   * 应在应用启动时调用一次
   * @throws 如果重复调用会记录警告
   */
  setupCallbacks(callbacks: RemoteChangeCallbacks | (() => Promise<void>)): void {
    if (this.callbacksInitialized) {
      this.logger.warn('setupCallbacks 已被调用过，跳过重复初始化');
      return;
    }

    const normalizedCallbacks: RemoteChangeCallbacks = typeof callbacks === 'function'
      ? { onLoadProjects: callbacks }
      : callbacks;
    
    this.callbacksInitialized = true;
    this.logger.info('远程变更回调已初始化');
    
    this.syncCoordinator.setupRemoteChangeCallbacks(
      async (payload) => {
        const eventType = payload?.eventType;
        const projectId = payload?.projectId;
        const isRealtimeEvent = eventType === 'INSERT' || eventType === 'UPDATE' || eventType === 'DELETE';

        this.projectDeleteDeferral.requestReevaluation();
        if (projectId && (eventType === 'INSERT' || eventType === 'UPDATE')) {
          this.projectDeleteDeferral.cancel(projectId);
        }

        const shouldSkipRemoteUpdate = this.shouldSkipRemoteUpdate();
        // DELETE 必须进入延迟判定，不能因全局脏状态直接丢失事件。
        if (eventType !== 'DELETE' && shouldSkipRemoteUpdate) {
          this.logger.debug('跳过项目级远程更新');
          return;
        }

        try {
          // 【修复 2026-01-31】正确处理 polling 事件类型
          // polling 事件应调用 onLoadProjects 执行全量同步，而非 handleIncrementalUpdate
          if (isRealtimeEvent && projectId) {
            await this.handleIncrementalUpdate(
              payload as RemoteProjectChangePayload,
              shouldSkipRemoteUpdate,
            );
          } else if (normalizedCallbacks.onRefreshActiveProject) {
            await normalizedCallbacks.onRefreshActiveProject(`remote:${eventType ?? 'unknown'}`);
          } else if (normalizedCallbacks.onLoadProjects) {
            await normalizedCallbacks.onLoadProjects();
          }
        } catch (e) {
          this.logger.error('处理远程变更失败', e);
        }
      },
      (payload) => {
        const taskPayload = payload as RemoteTaskChangePayload;

        // 任务级更新：默认更宽松（允许不同任务并发编辑），但仍需避免在本机有未同步修改时被远程覆盖。
        // - 用户正在编辑/有待同步本地变更：跳过 UPDATE/INSERT，避免覆盖本地状态
        // - 刚刚持久化：短暂跳过，避免“自己的回声”覆盖
        if (this.shouldSkipTaskUpdate(taskPayload)) {
          this.logger.debug('跳过任务级远程更新', { eventType: taskPayload.eventType, taskId: taskPayload.taskId });
          return;
        }
        this.handleTaskLevelUpdate(taskPayload);
      }
    );
  }

  // ========== 私有方法 ==========

  /**
   * 检查是否应跳过远程项目级更新
   * 当用户正在编辑或有待同步的本地变更时，跳过项目级更新
   */
  private shouldSkipRemoteUpdate(): boolean {
    const isEditing = this.uiState.isEditing;
    const hasPending = this.syncCoordinator.hasPendingLocalChanges();
    const decision = evaluateRemoteProjectUpdateGuard(
      isEditing,
      hasPending,
      Date.now(),
      this.syncCoordinator.getLastPersistAt(),
    );
    
    // 添加调试日志
    if (decision.logContext) {
      this.logger.debug('跳过远程项目更新', decision.logContext);
    }
    
    return decision.shouldSkip;
  }

  private shouldSkipTaskUpdate(payload: RemoteTaskChangePayload): boolean {
    return shouldSkipRemoteTaskChange(
      payload, Date.now(), this.syncCoordinator.getLastPersistAt(),
    );
  }

  /**
   * 处理项目级别的增量更新
   */
  private async handleIncrementalUpdate(
    payload: RemoteProjectChangePayload,
    forceDeleteDeferral = false,
  ): Promise<void> {
    const { eventType, projectId } = payload;

    if (eventType === 'DELETE') {
      const sessionContext = captureRemoteProjectSessionContext(this.userSession);
      if (!sessionContext) {
        this.logger.warn('远程项目删除缺少当前 owner/session，已保留本地数据', { projectId });
        return;
      }
      this.projectDeleteDeferral.handle(projectId, sessionContext, forceDeleteDeferral);
      return;
    }

    if (eventType === 'INSERT' || eventType === 'UPDATE') {
      await this.applyRemoteProjectUpsert(projectId);
    }
  }

  private applyRemoteProjectDelete(projectId: string): void {
    this.undoService.clearOutdatedHistory(projectId, Number.MAX_SAFE_INTEGER);
    const wasActiveProject = this.projectState.activeProjectId() === projectId;
    this.projectState.updateProjects(ps => ps.filter(p => p.id !== projectId));
    if (wasActiveProject) {
      const remaining = this.projectState.projects();
      this.projectState.setActiveProjectId(remaining[0]?.id ?? null);
    }
  }

  private async applyRemoteProjectUpsert(projectId: string): Promise<void> {
    const sessionContext = captureRemoteProjectSessionContext(this.userSession);
    if (!sessionContext) return;
    if (this.shouldDeferRemoteProjectUpsert(sessionContext, projectId, 'before-project-load')) return;

    const remoteProject = await this.projectData.loadFullProject(projectId, sessionContext.userId);
    if (!remoteProject || this.shouldDeferRemoteProjectUpsert(sessionContext, projectId, 'project-load')) return;

    const deletionSets = collectRemoteProjectDeletionSets(remoteProject);
    const cleanedRemoteProject = removeDeletedRecords(remoteProject);
    const localProject = this.projectState.getProject(projectId);

    if (!localProject) {
      const validated = this.syncCoordinator.validateAndRebalance(cleanedRemoteProject);
      this.projectState.updateProjects(ps => [...ps, validated]);
      return;
    }

    const localVersion = localProject.version ?? 0;
    const remoteVersion = remoteProject.version ?? 0;
    if (remoteVersion <= localVersion) {
      this.logger.debug('跳过过时或相同版本的远程项目更新', { projectId, localVersion, remoteVersion });
      return;
    }

    await this.mergeNewerRemoteProject(
      projectId,
      localProject,
      remoteProject,
      cleanedRemoteProject,
      deletionSets,
      sessionContext,
    );
  }

  private isRemoteProjectSessionCurrent(
    context: RemoteProjectSessionContext,
    projectId: string,
    stage: string,
  ): boolean {
    if (this.userSession.isSessionContextCurrent(context.sessionGeneration, context.userId)) return true;
    this.logger.debug(
      '丢弃过期远程项目更新',
      createStaleRemoteProjectSessionLogContext(context, projectId, stage, this.userSession),
    );
    return false;
  }

  private shouldDeferRemoteProjectUpsert(
    context: RemoteProjectSessionContext,
    projectId: string,
    stage: string,
  ): boolean {
    if (!this.isRemoteProjectSessionCurrent(context, projectId, stage)) return true;
    if (!this.syncCoordinator.hasPendingChangesForProject(projectId, context.userId)) return false;
    this.logger.debug('跳过项目级远程更新，当前 owner 存在待处理本地写入', {
      projectId, ownerUserId: context.userId, stage,
    });
    return true;
  }

  private applyRemoteConnectionDeletions(projectId: string, deletionGuard: RemoteConnectionDeletionGuard): void {
    if (deletionGuard.size === 0) return;

    this.logger.info('处理远程连接删除操作', {
      projectId,
      deletedConnectionCount: deletionGuard.size
    });

    this.projectState.updateProjects(ps => ps.map(p => {
      if (p.id !== projectId) return p;

      const updatedConnections = p.connections.filter(c => !isRemoteConnectionDeletionStillCurrent(deletionGuard, c));

      if (updatedConnections.length === p.connections.length) {
        return p;
      }

      return this.syncCoordinator.validateAndRebalance({
        ...p,
        connections: updatedConnections
      });
    }));
  }

  private async mergeNewerRemoteProject(
    projectId: string,
    localProject: Project,
    remoteProject: Project,
    cleanedRemoteProject: Project,
    deletionSets: RemoteProjectDeletionSets,
    sessionContext: RemoteProjectSessionContext,
  ): Promise<void> {
    const remoteVersion = remoteProject.version ?? 0;
    const connectionDeletionGuard = captureRemoteConnectionDeletionGuard(
      this.projectState.getProjectWithCurrentData(projectId) ?? localProject, deletionSets);

    const tombstoneResult = await this.taskSyncOps.getTombstoneIdsWithStatus(projectId);
    if (this.shouldDeferRemoteProjectUpsert(sessionContext, projectId, 'tombstone-load')) return;

    const currentLocalProject = this.projectState.getProject(projectId);
    if (!currentLocalProject) return;
    const currentLocalVersion = currentLocalProject.version ?? 0;
    if (remoteVersion <= currentLocalVersion) {
      this.logger.debug('跳过等待期间已过时的远程项目更新', {
        projectId, currentLocalVersion, remoteVersion,
      });
      return;
    }

    this.applyRemoteConnectionDeletions(projectId, connectionDeletionGuard);
    const mergeBaseProject = this.projectState.getProjectWithCurrentData(projectId);
    if (!mergeBaseProject) return;
    const versionDiff = remoteVersion - currentLocalVersion;
    const clearedCount = this.undoService.clearOutdatedHistory(projectId, remoteVersion);
    if (clearedCount > 0) {
      this.logger.debug(`清理了 ${clearedCount} 条过时的撤销历史`, { projectId });
    }

    if (this.uiState.isEditing && versionDiff > 1) {
      this.toastService.info('数据已更新', '其他设备的更改已同步，当前编辑内容将与远程合并');
    }

    const mergeResult = this.syncCoordinator.smartMerge(
      mergeBaseProject,
      cleanedRemoteProject,
      createTaskTombstoneSnapshot(tombstoneResult.ids, tombstoneResult.deletedAtByTaskId),
    );
    if (mergeResult.conflictCount > 0 && this.uiState.isEditing) {
      this.toastService.warning('合并提示', '检测到与远程更改的冲突，已自动合并');
    }

    const validated = this.syncCoordinator.validateAndRebalance(mergeResult.project);
    this.projectState.updateProjects(ps => ps.map(p => p.id === projectId ? validated : p));
  }

  /** 处理任务级别的实时更新。 */
  private handleTaskLevelUpdate(payload: RemoteTaskChangePayload): void {
    const { eventType, taskId, projectId } = payload;
    this.changeTracker.pruneExpiredChanges(
      SYNC_CONFIG.DIRTY_PROTECTION_WINDOW_MS,
      record => record.entityType === 'task'
        && this.actionQueue.hasDurablePendingTaskMutation(record.projectId, record.entityId),
    );

    // 添加调试日志
    this.logger.info('[TaskSync] 收到任务变更事件', { eventType, taskId, projectId });

    if (!projectId && eventType === 'DELETE') {
      this.logger.warn('DELETE 事件缺少 projectId，在所有项目中查找任务', { taskId });
    }

    const targetResolution = resolveRemoteTaskTargetProject({
      eventType,
      taskId,
      projectId,
      projects: this.projectState.getProjectsWithCurrentData(),
    });

    if (targetResolution.targetProjectId === null) {
      if (targetResolution.reason === 'delete-task-not-found') {
        this.logger.error('无法找到待删除任务所属项目', { taskId });
        return;
      }

      this.logger.warn('跳过任务更新（无 projectId）', { eventType, taskId });
      return;
    }

    const targetProjectId = targetResolution.targetProjectId;
    if (targetResolution.source === 'local-project-search') {
      this.logger.info('在项目中找到待删除任务', { taskId, projectId: targetProjectId });
    }

    // 只处理当前活动项目的任务（对于非活动项目，等待切换项目时重新加载）
    if (targetProjectId !== this.projectState.activeProjectId()) {
      this.logger.debug('跳过非当前项目的任务更新', { eventType, taskId, projectId: targetProjectId, activeProjectId: this.projectState.activeProjectId() });
      return;
    }

    switch (eventType) {
      case 'DELETE':
        this.queueRemoteTaskUpsert(eventType, taskId, targetProjectId);
        break;

      case 'INSERT':
      case 'UPDATE':
        this.queueRemoteTaskUpsert(eventType, taskId, targetProjectId);
        break;

      default:
        // 未知事件类型，记录警告但不中断处理
        this.logger.warn(`未处理的任务事件类型: ${eventType}`, { taskId, projectId });
        break;
    }
  }

  private removeTaskFromProject(project: Project, taskId: string, projectId: string, logMissing = false): Project {
    if (project.id !== projectId) return project;

    const result = removeRemoteTaskFromProject(project, taskId);
    if (!result.removed) {
      if (logMissing) {
        this.logger.debug('任务已不存在，跳过删除', { taskId });
      }
      return result.project;
    }

    if (logMissing) {
      this.logger.debug('任务已从本地删除', { taskId, remainingTasks: result.remainingTasks });
    }

    return this.syncCoordinator.validateAndRebalance(result.project);
  }

  private queueRemoteTaskUpsert(
    eventType: RemoteTaskChangePayload['eventType'],
    taskId: string,
    targetProjectId: string
  ): void {
    const userId = this.authService.currentUserId();
    const ownerUserId = this.userSession.currentUserId();
    if (!userId || !ownerUserId || userId !== ownerUserId) return;

    const sessionGeneration = this.userSession.getCurrentSessionGeneration();
    const localTask = this.projectState.getProjectWithCurrentData(targetProjectId)
      ?.tasks.find(task => task.id === taskId);
    const permissionDeniedTaskSnapshot = localTask ? structuredClone(localTask) : null;
    if (!this.userSession.isSessionContextCurrent(sessionGeneration, ownerUserId)) return;

    const context = createRemoteTaskUpdateContext({
      eventType,
      taskId,
      targetProjectId,
      ownerUserId,
      sessionGeneration,
      permissionDeniedTaskSnapshot,
      currentProjectId: this.projectState.activeProjectId(),
      requestId: this.taskUpdateRequests.start(targetProjectId, taskId),
    });

    this.logger.info('开始加载远程任务更新', {
      eventType,
      taskId,
      projectId: targetProjectId,
      requestId: context.requestId
    });

    this.projectData.loadFullProject(targetProjectId, userId)
      .then(remoteProject => this.applyLoadedRemoteTaskProject(remoteProject, context))
      .catch(error => this.handleRemoteTaskUpdateError(error, context));
  }

  private async applyLoadedRemoteTaskProject(remoteProject: Project | null, context: RemoteTaskUpdateContext): Promise<void> {
    if (!this.canApplyTaskUpdateResult(context)) return;
    if (!remoteProject) {
      await this.handleMissingRemoteProject(context);
      return;
    }

    const remoteTask = remoteProject.tasks.find(t => t.id === context.taskId);
    if (!remoteTask) {
      await this.handleMissingRemoteTask(remoteProject, context);
      return;
    }

    this.logLoadedRemoteTask(remoteTask, context.taskId);

    const tombstoneIds = await this.syncCoordinator.getTombstoneIds(context.targetProjectId);
    if (!this.canApplyTaskUpdateResult(context)) return;
    if (this.shouldSkipStaleRemoteTask(remoteTask, context)) return;

    this.projectState.updateProjects(projects =>
      projects.map(p => this.applyRemoteTaskToProject(p, remoteTask, context, tombstoneIds))
    );

    this.logger.info('远程任务更新已应用', { taskId: context.taskId, eventType: context.eventType });
  }

  private canApplyTaskUpdateResult(context: RemoteTaskUpdateContext): boolean {
    if (!this.userSession.isSessionContextCurrent(context.sessionGeneration, context.ownerUserId)) {
      this.logger.debug('远程任务更新所属会话已失效', {
        taskId: context.taskId,
        projectId: context.targetProjectId,
        ownerUserId: context.ownerUserId,
        sessionGeneration: context.sessionGeneration,
      });
      return false;
    }

    const currentRequestId = this.taskUpdateRequests.getCurrentRequestId(context.targetProjectId, context.taskId);
    const decision = canApplyRemoteTaskUpdateResult({
      requestId: context.requestId,
      currentRequestId,
      isDestroyed: this.taskUpdateRequests.isDestroyed,
      activeProjectId: this.projectState.activeProjectId(),
      originalProjectId: context.currentProjectId,
    });

    if (decision.canApply) return true;

    if (decision.reason === 'superseded') {
      this.logger.debug('远程任务更新已被更新请求取代', {
        requestId: context.requestId,
        currentId: currentRequestId
      });
      return false;
    }

    if (decision.reason === 'destroyed') {
      this.logger.debug('服务已销毁，忽略远程任务更新');
      return false;
    }

    if (decision.reason === 'project-switched') {
      this.logger.debug('项目已切换，忽略远程任务更新');
      return false;
    }

    return false;
  }

  private async handleMissingRemoteProject(context: RemoteTaskUpdateContext): Promise<void> {
    const loadAccessibleProbe = this.projectData.getAccessibleProjectProbe?.bind(this.projectData);
    const accessibleProbe = loadAccessibleProbe
      ? await loadAccessibleProbe(context.targetProjectId).catch(() => null)
      : null;

    if (accessibleProbe && !accessibleProbe.accessible) {
      this.logger.info('远程任务更新命中已不可访问项目，跳过本次项目拉取', {
        projectId: context.targetProjectId,
        taskId: context.taskId,
      });
      return;
    }

    this.logger.debug('远程项目暂不可用，跳过本次任务级更新', {
      projectId: context.targetProjectId,
      taskId: context.taskId,
      probeAccessible: accessibleProbe?.accessible ?? null,
    });
  }

  private async handleMissingRemoteTask(remoteProject: Project, context: RemoteTaskUpdateContext): Promise<void> {
    const tombstoneResult = await this.taskSyncOps.getTombstoneIdsWithStatus(context.targetProjectId);
    if (!this.canApplyTaskUpdateResult(context)) return;
    const pendingLocal = this.getPendingTaskChange(context.targetProjectId, context.taskId);

    if (pendingLocal && pendingLocal.changeType !== 'delete') {
      this.logger.debug('远程项目中暂未见任务，但本地存在待同步变更，保留本地状态', {
        taskId: context.taskId,
        projectId: context.targetProjectId,
        pendingType: pendingLocal.changeType,
        totalTasks: remoteProject.tasks.length
      });
      return;
    }

    if (tombstoneResult.localCacheOnly || !tombstoneResult.fromRemote) {
      this.logger.warn('远程任务删除仅有本地 tombstone 缓存证据，已保留本地任务', {
        taskId: context.taskId,
        projectId: context.targetProjectId,
        tombstonePresent: tombstoneResult.ids.has(context.taskId),
        tombstoneDeletedAt: tombstoneResult.deletedAtByTaskId?.get(context.taskId) ?? null,
        fromRemote: tombstoneResult.fromRemote,
        localCacheOnly: tombstoneResult.localCacheOnly,
      });
      return;
    }

    const localProject = this.projectState.getProjectWithCurrentData(context.targetProjectId)
      ?? this.projectState.getProject(context.targetProjectId);
    const localTask = localProject?.tasks.find(task => task.id === context.taskId);
    const deletionDecision = decideRemoteTaskDeletion({
      localTask,
      tombstonePresent: tombstoneResult.ids.has(context.taskId),
      tombstoneDeletedAt: tombstoneResult.deletedAtByTaskId?.get(context.taskId),
    });

    if (!deletionDecision.shouldDelete) {
      this.logger.warn('远程任务删除缺少足够证据，已保留本地任务', {
        taskId: context.taskId,
        projectId: context.targetProjectId,
        reason: deletionDecision.reason,
        localUpdatedAt: localTask?.updatedAt ?? null,
        tombstoneDeletedAt: tombstoneResult.deletedAtByTaskId?.get(context.taskId) ?? null,
        localCacheOnly: tombstoneResult.localCacheOnly,
      });
      return;
    }

    this.convergeMissingRemoteTaskDeletion(remoteProject, context, deletionDecision.reason);
  }

  private convergeMissingRemoteTaskDeletion(
    remoteProject: Project, context: RemoteTaskUpdateContext,
    reason: ReturnType<typeof decideRemoteTaskDeletion>['reason'],
  ): void {
    this.logger.info('远程任务已不在项目中，按删除收敛本地状态', {
      taskId: context.taskId,
      projectId: context.targetProjectId,
      reason,
      totalTasks: remoteProject.tasks.length
    });

    this.undoService.clearTaskHistory(context.taskId, context.targetProjectId);
    this.projectState.updateProjects(projects =>
      projects.map(p => this.removeTaskFromProject(p, context.taskId, context.targetProjectId))
    );
  }

  private logLoadedRemoteTask(remoteTask: Task, taskId: string): void {
    this.logger.info('[TaskSync] 成功加载远程任务完整数据', {
      taskId,
      title: remoteTask.title,
      status: remoteTask.status,
      stage: remoteTask.stage,
      parentId: remoteTask.parentId,
      rank: remoteTask.rank,
      x: remoteTask.x,
      y: remoteTask.y,
      updatedAt: remoteTask.updatedAt,
      deletedAt: remoteTask.deletedAt
    });
  }

  private shouldSkipStaleRemoteTask(remoteTask: Task, context: RemoteTaskUpdateContext): boolean {
    const localProject = this.projectState.getProjectWithCurrentData(context.targetProjectId);
    const existingLocalTask = localProject?.tasks.find(t => t.id === context.taskId);

    if (!existingLocalTask?.updatedAt || !remoteTask.updatedAt) return false;
    if (!shouldSkipStaleRemoteTask({ localTask: existingLocalTask, remoteTask })) return false;

    this.logger.debug('幂等检查：跳过过时或相同版本的远程更新', {
      taskId: context.taskId,
      localUpdatedAt: existingLocalTask.updatedAt,
      remoteUpdatedAt: remoteTask.updatedAt
    });
    return true;
  }

  private applyRemoteTaskToProject(
    project: Project,
    remoteTask: Task,
    context: RemoteTaskUpdateContext,
    tombstoneIds: Set<string>
  ): Project {
    if (project.id !== context.targetProjectId) return project;

    const existingTaskIndex = project.tasks.findIndex(t => t.id === context.taskId);
    const pending = this.getPendingTaskChange(context.targetProjectId, context.taskId);
    const updatedProject = existingTaskIndex >= 0
      ? this.updateExistingRemoteTask(project, remoteTask, existingTaskIndex, pending, context)
      : this.addNewRemoteTask(project, remoteTask, pending, tombstoneIds, context.taskId);

    return updatedProject === project
      ? project
      : this.syncCoordinator.validateAndRebalance(updatedProject);
  }

  private updateExistingRemoteTask(
    project: Project,
    remoteTask: Task,
    existingTaskIndex: number,
    pending: ReturnType<ChangeTrackerService['getPendingChange']>,
    context: RemoteTaskUpdateContext
  ): Project {
    const localTask = project.tasks[existingTaskIndex];
    const mergedTask = this.remoteTaskMerge.mergeRemoteTask({
      localTask,
      remoteTask,
      pending,
      context,
    });
    const updatedTasks = [...project.tasks];
    updatedTasks[existingTaskIndex] = mergedTask;
    return { ...project, tasks: updatedTasks };
  }

  private addNewRemoteTask(
    project: Project,
    remoteTask: Task,
    pending: ReturnType<ChangeTrackerService['getPendingChange']>,
    tombstoneIds: Set<string>,
    taskId: string
  ): Project {
    const addDecision = shouldAddRemoteTask({
      taskId,
      pendingChangeType: pending?.changeType,
      tombstoneIds,
    });

    if (!addDecision.shouldAdd && addDecision.reason === 'pending-delete') {
      this.logger.debug('忽略远端任务更新（本机 pending delete）', { taskId });
      return project;
    }

    if (!addDecision.shouldAdd && addDecision.reason === 'tombstone') {
      this.logger.info('忽略远端任务更新（tombstone 保护）', { taskId });
      return project;
    }

    this.logger.info('添加新任务', { taskId });
    return { ...project, tasks: [...project.tasks, remoteTask] };
  }

  private async handleRemoteTaskUpdateError(error: unknown, context: RemoteTaskUpdateContext): Promise<void> {
    if (
      !this.taskUpdateRequests.isCurrent(context.targetProjectId, context.taskId, context.requestId)
      || !this.userSession.isSessionContextCurrent(context.sessionGeneration, context.ownerUserId)
    ) return;

    this.logger.error('处理远程任务更新失败', error);

    const supabaseError = supabaseErrorToError(error);
    if (isPermissionDeniedRemoteTaskError(supabaseError)) {
      await this.handlePermissionDeniedTaskUpdate(supabaseError, context);
      return;
    }

    this.toastService.warning('同步提示', '远程任务更新失败，点击刷新页面', {
      duration: 8000,
      action: {
        label: '刷新页面',
        onClick: () => reloadViaForceClearCache()
      }
    });
  }

  private async handlePermissionDeniedTaskUpdate(
    supabaseError: ReturnType<typeof supabaseErrorToError>,
    context: RemoteTaskUpdateContext
  ): Promise<void> {
    this.logger.warn('权限拒绝，触发数据保全机制', {
      taskId: context.taskId,
      projectId: context.targetProjectId,
      errorCode: supabaseError.code
    });

    const affectedTask = context.permissionDeniedTaskSnapshot;
    if (!affectedTask) return;

    await this.permissionDeniedHandler.handlePermissionDenied(
      supabaseError as SupabaseError,
      [affectedTask],
      context.targetProjectId,
      {
        ownerUserId: context.ownerUserId,
        shouldNotify: () => this.taskUpdateRequests.isCurrent(
          context.targetProjectId,
          context.taskId,
          context.requestId,
        ) && this.userSession.isSessionContextCurrent(
          context.sessionGeneration,
          context.ownerUserId,
        ),
      },
    );
  }

  private getPendingTaskChange(projectId: string, taskId: string): ReturnType<ChangeTrackerService['getPendingChange']> {
    const maxAgeMs = this.actionQueue.hasDurablePendingTaskMutation(projectId, taskId)
      ? Number.POSITIVE_INFINITY
      : SYNC_CONFIG.DIRTY_PROTECTION_WINDOW_MS;
    return this.changeTracker.getPendingChange(
      projectId,
      'task',
      taskId,
      maxAgeMs
    );
  }
  
  // ========== 测试/HMR 支持 ==========
  
  /**
   * 重置服务状态（用于测试和 HMR）
   */
  reset(): void {
    this.taskUpdateRequests.reset();
    this.callbacksInitialized = false;
  }
}
