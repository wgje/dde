/** 处理远程项目/任务变更；订阅、持久化、会话管理分别由 SyncCoordinator/UserSession 负责。 */
import { Injectable, inject, DestroyRef } from '@angular/core';
import { SyncCoordinatorService } from './sync-coordinator.service';
import { ProjectDataService } from '../core-bridge';
import { UndoService } from './undo.service';
import { UiStateService } from './ui-state.service';
import { ProjectStateService } from './project-state.service';
import { ToastService } from './toast.service';
import { AuthService } from './auth.service';
import { LoggerService } from './logger.service';
import { ChangeTrackerService } from './change-tracker.service';
import { PermissionDeniedHandlerService } from './permission-denied-handler.service';
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
  collectRemoteProjectDeletionSets,
  removeDeletedRecords,
  removeRemoteTaskFromProject,
  resolveRemoteTaskTargetProject,
  shouldAddRemoteTask,
  shouldSkipRemoteProjectUpdate,
  shouldSkipRemoteTaskUpdate,
  shouldSkipStaleRemoteTask,
  type RemoteProjectDeletionSets,
} from './remote-change-handler.helpers';
import { RemoteTaskMergeController } from './remote-task-merge.controller';
export type { RemoteChangeCallbacks, RemoteProjectChangePayload, RemoteTaskChangePayload } from './remote-change-handler.types';

@Injectable({
  providedIn: 'root'
})
export class RemoteChangeHandlerService {
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('RemoteChangeHandler');
  private syncCoordinator = inject(SyncCoordinatorService);
  private projectData = inject(ProjectDataService);
  private undoService = inject(UndoService);
  private uiState = inject(UiStateService);
  private projectState = inject(ProjectStateService);
  private toastService = inject(ToastService);
  private authService = inject(AuthService);
  private changeTracker = inject(ChangeTrackerService);
  private permissionDeniedHandler = inject(PermissionDeniedHandlerService);
  private destroyRef = inject(DestroyRef);
  private readonly remoteTaskMerge = new RemoteTaskMergeController({
    getLockedFields: (taskId, projectId) =>
      this.changeTracker.getLockedFields(taskId, projectId),
    isEditing: () => this.uiState.isEditing,
    logger: this.logger,
  });
  /** 
   * 用于防止在编辑期间处理远程变更的时间阈值（毫秒）
   * 【修复】从 300ms 增加到 2000ms，给弱网环境更多保护时间
   */
  private static readonly EDIT_GUARD_THRESHOLD_MS = 2000;
  
  /** 回调是否已设置（防止重复调用） */
  private callbacksInitialized = false;
  
  /** 服务是否已销毁（用于取消进行中的异步操作） */
  private isDestroyed = false;
  
  /** 
   * 当前任务更新请求 ID
   * 使用单调递增的 ID 替代 AbortController，确保只处理最新请求结果
   * 注：Supabase JS 客户端不原生支持 AbortSignal，此设计更可靠
   */
  private taskUpdateRequestId = 0;
  
  constructor() {
    // 注册 HMR/测试清理
    this.destroyRef.onDestroy(() => {
      this.isDestroyed = true;
      this.callbacksInitialized = false;
      // 递增请求 ID，使所有进行中的请求结果被忽略
      this.taskUpdateRequestId++;
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
        // 项目级更新：如果用户正在编辑，跳过以防止冲突
        if (this.shouldSkipRemoteUpdate()) {
          this.logger.debug('跳过项目级远程更新');
          return;
        }

        try {
          // 【修复 2026-01-31】正确处理 polling 事件类型
          // polling 事件应调用 onLoadProjects 执行全量同步，而非 handleIncrementalUpdate
          const eventType = payload?.eventType;
          const isRealtimeEvent = eventType === 'INSERT' || eventType === 'UPDATE' || eventType === 'DELETE';
          
          if (isRealtimeEvent && payload?.projectId) {
            await this.handleIncrementalUpdate(payload as RemoteProjectChangePayload);
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
    const decision = shouldSkipRemoteProjectUpdate({
      isEditing,
      hasPendingLocalChanges: hasPending,
      now: Date.now(),
      lastPersistAt: this.syncCoordinator.getLastPersistAt(),
      guardMs: RemoteChangeHandlerService.EDIT_GUARD_THRESHOLD_MS,
    });
    
    // 添加调试日志
    if (decision.shouldSkip) {
      this.logger.debug('跳过远程项目更新', {
        isEditing,
        hasPendingLocalChanges: hasPending,
        timeSinceLastPersist: decision.timeSinceLastPersist,
        inEditGuard: decision.inEditGuard,
        threshold: RemoteChangeHandlerService.EDIT_GUARD_THRESHOLD_MS
      });
    }
    
    return decision.shouldSkip;
  }
  
  /**
   * 检查是否应跳过远程任务级更新
   * 更宽松的策略：只在刚刚有持久化操作时跳过，允许不同任务的并发更新
   * 【修复】增加回声保护时间到 3000ms，匹配同步防抖时间 (SYNC_CONFIG.DEBOUNCE_DELAY)
   * 防止本机操作的"回声"覆盖本地状态
   */
  private shouldSkipTaskUpdate(payload: RemoteTaskChangePayload): boolean {
    // 【关键修复】回声保护时间增加到 3 秒，匹配同步防抖延迟
    const ECHO_PROTECTION_WINDOW = 3000;
    const inEchoGuard = shouldSkipRemoteTaskUpdate({
      now: Date.now(),
      lastPersistAt: this.syncCoordinator.getLastPersistAt(),
      echoProtectionMs: ECHO_PROTECTION_WINDOW,
    });

    // DELETE 事件不需要加载远程项目，且对一致性很关键；仅应用回声保护。
    if (payload.eventType === 'DELETE') {
      return inEchoGuard;
    }

    // UPDATE/INSERT 需要尽量及时处理（尤其是软删除 tombstone 通过 UPDATE 传播）。
    // 这里不再因“编辑中/有待同步变更”而整体跳过；改由后续合并逻辑按字段保护本地脏数据。
    return inEchoGuard;
  }

  /**
   * 处理项目级别的增量更新
   */
  private async handleIncrementalUpdate(payload: RemoteProjectChangePayload): Promise<void> {
    const { eventType, projectId } = payload;

    if (eventType === 'DELETE') {
      this.applyRemoteProjectDelete(projectId);
      return;
    }

    if (eventType === 'INSERT' || eventType === 'UPDATE') {
      await this.applyRemoteProjectUpsert(projectId);
    }
  }

  private applyRemoteProjectDelete(projectId: string): void {
    this.undoService.clearOutdatedHistory(projectId, Number.MAX_SAFE_INTEGER);

    this.projectState.updateProjects(ps => ps.filter(p => p.id !== projectId));
    if (this.projectState.activeProjectId() === projectId) {
      const remaining = this.projectState.projects();
      this.projectState.setActiveProjectId(remaining[0]?.id ?? null);
    }
  }

  private async applyRemoteProjectUpsert(projectId: string): Promise<void> {
    const userId = this.authService.currentUserId();
    if (!userId) return;

    const remoteProject = await this.projectData.loadFullProject(projectId, userId);
    if (!remoteProject) return;

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

    this.applyRemoteProjectDeletions(projectId, deletionSets);
    await this.mergeNewerRemoteProject(projectId, localProject, remoteProject, cleanedRemoteProject);
  }

  private applyRemoteProjectDeletions(projectId: string, deletionSets: RemoteProjectDeletionSets): void {
    const { deletedTaskIds, deletedConnectionIds } = deletionSets;
    if (deletedTaskIds.size === 0 && deletedConnectionIds.size === 0) return;

    this.logger.info('处理远程删除操作', {
      projectId,
      deletedTaskCount: deletedTaskIds.size,
      deletedConnectionCount: deletedConnectionIds.size
    });

    this.projectState.updateProjects(ps => ps.map(p => {
      if (p.id !== projectId) return p;

      const updatedTasks = p.tasks.filter(t => !deletedTaskIds.has(t.id));
      const updatedConnections = p.connections.filter(c => !deletedConnectionIds.has(c.id));

      if (updatedTasks.length === p.tasks.length && updatedConnections.length === p.connections.length) {
        return p;
      }

      return this.syncCoordinator.validateAndRebalance({
        ...p,
        tasks: updatedTasks,
        connections: updatedConnections
      });
    }));
  }

  private async mergeNewerRemoteProject(
    projectId: string,
    localProject: Project,
    remoteProject: Project,
    cleanedRemoteProject: Project
  ): Promise<void> {
    const localVersion = localProject.version ?? 0;
    const remoteVersion = remoteProject.version ?? 0;
    if (remoteVersion <= localVersion) return;

    const versionDiff = remoteVersion - localVersion;
    const clearedCount = this.undoService.clearOutdatedHistory(projectId, remoteVersion);
    if (clearedCount > 0) {
      this.logger.debug(`清理了 ${clearedCount} 条过时的撤销历史`, { projectId });
    }

    if (this.uiState.isEditing && versionDiff > 1) {
      this.toastService.info('数据已更新', '其他设备的更改已同步，当前编辑内容将与远程合并');
    }

    const tombstoneIds = await this.syncCoordinator.getTombstoneIds(projectId);
    const currentLocalProject = this.projectState.getProject(projectId);
    if (!currentLocalProject) return;

    const mergeResult = this.syncCoordinator.smartMerge(currentLocalProject, cleanedRemoteProject, tombstoneIds);
    if (mergeResult.conflictCount > 0 && this.uiState.isEditing) {
      this.toastService.warning('合并提示', '检测到与远程更改的冲突，已自动合并');
    }

    const validated = this.syncCoordinator.validateAndRebalance(mergeResult.project);
    this.projectState.updateProjects(ps => ps.map(p => p.id === projectId ? validated : p));
  }

  /**
   * 处理任务级别的实时更新
   * 
   * 🔧 关键修复点：
   * 1. 任务删除需要正确处理 projectId 缺失的情况
   * 2. 任务更新需要智能合并本地编辑和远程变更
   * 3. 需要正确处理位置、状态、stage 等所有字段的同步
   */
  private handleTaskLevelUpdate(payload: RemoteTaskChangePayload): void {
    const { eventType, taskId, projectId } = payload;
    this.changeTracker.pruneExpiredChanges(SYNC_CONFIG.DIRTY_PROTECTION_WINDOW_MS);
    
    // 添加调试日志
    this.logger.info('[TaskSync] 收到任务变更事件', { eventType, taskId, projectId });

    if (!projectId && eventType === 'DELETE') {
      this.logger.warn('DELETE 事件缺少 projectId，在所有项目中查找任务', { taskId });
    }

    const targetResolution = resolveRemoteTaskTargetProject({
      eventType,
      taskId,
      projectId,
      projects: this.projectState.projects(),
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
        this.applyRemoteTaskDelete(taskId, targetProjectId);
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

  private applyRemoteTaskDelete(taskId: string, projectId: string): void {
    this.logger.info('处理远程任务删除', { taskId, projectId });

    this.undoService.clearTaskHistory(taskId, projectId);
    this.projectState.updateProjects(projects =>
      projects.map(p => this.removeTaskFromProject(p, taskId, projectId, true))
    );
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
    if (!userId) return;

    const context: RemoteTaskUpdateContext = {
      eventType,
      taskId,
      targetProjectId,
      currentProjectId: this.projectState.activeProjectId(),
      requestId: ++this.taskUpdateRequestId
    };

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
    const decision = canApplyRemoteTaskUpdateResult({
      requestId: context.requestId,
      currentRequestId: this.taskUpdateRequestId,
      isDestroyed: this.isDestroyed,
      activeProjectId: this.projectState.activeProjectId(),
      originalProjectId: context.currentProjectId,
    });

    if (decision.canApply) return true;

    if (decision.reason === 'superseded') {
      this.logger.debug('远程任务更新已被更新请求取代', {
        requestId: context.requestId,
        currentId: this.taskUpdateRequestId
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
    const tombstoneIds = await this.syncCoordinator.getTombstoneIds(context.targetProjectId);
    if (!this.canApplyTaskUpdateResult(context)) return;
    const isTombstoned = tombstoneIds.has(context.taskId);
    const pendingLocal = this.getPendingTaskChange(context.targetProjectId, context.taskId);

    if (!isTombstoned && pendingLocal && pendingLocal.changeType !== 'delete') {
      this.logger.debug('远程项目中暂未见任务，但本地存在待同步变更，保留本地状态', {
        taskId: context.taskId,
        projectId: context.targetProjectId,
        pendingType: pendingLocal.changeType,
        totalTasks: remoteProject.tasks.length
      });
      return;
    }

    this.logger.info('远程任务已不在项目中，按删除收敛本地状态', {
      taskId: context.taskId,
      projectId: context.targetProjectId,
      reason: isTombstoned ? 'tombstoned' : 'missing',
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
    const localProject = this.projectState.getProject(context.targetProjectId);
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
    if (context.requestId !== this.taskUpdateRequestId || this.isDestroyed) return;

    this.logger.error('处理远程任务更新失败', error);

    const supabaseError = supabaseErrorToError(error);
    if (this.isPermissionDeniedError(supabaseError)) {
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

  private isPermissionDeniedError(supabaseError: ReturnType<typeof supabaseErrorToError>): boolean {
    return supabaseError.errorType === 'PermissionError'
      || supabaseError.code === '403'
      || supabaseError.code === 403
      || supabaseError.code === '401'
      || supabaseError.code === 401
      || supabaseError.code === '42501'
      || supabaseError.code === 42501
      || supabaseError.status === '403'
      || supabaseError.status === 403
      || supabaseError.status === '401'
      || supabaseError.status === 401;
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

    const localProject = this.projectState.getProject(context.targetProjectId);
    const affectedTask = localProject?.tasks.find(t => t.id === context.taskId);
    if (!affectedTask) return;

    await this.permissionDeniedHandler.handlePermissionDenied(
      supabaseError as SupabaseError,
      [affectedTask],
      context.targetProjectId
    );
  }

  private getPendingTaskChange(projectId: string, taskId: string): ReturnType<ChangeTrackerService['getPendingChange']> {
    return this.changeTracker.getPendingChange(
      projectId,
      'task',
      taskId,
      SYNC_CONFIG.DIRTY_PROTECTION_WINDOW_MS
    );
  }
  
  // ========== 测试/HMR 支持 ==========
  
  /**
   * 重置服务状态（用于测试和 HMR）
   */
  reset(): void {
    // 重置请求 ID，使所有进行中的请求结果被忽略
    this.taskUpdateRequestId++;
    
    this.callbacksInitialized = false;
    this.isDestroyed = false;
  }
}
