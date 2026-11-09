import { Injectable, inject, computed } from '@angular/core';
import {
  SyncStateService,
  TaskSyncOperationsService,
  ProjectSaveFlightCoordinatorService,
} from '../core-bridge';
import { LayoutService } from './layout.service';
import { ToastService } from './toast.service';
import { LoggerService } from './logger.service';
import { ConflictDetectionService } from './conflict-detection.service';
import { BlackBoxSyncService } from './black-box-sync.service';
import { Project, Task } from '../models';
import {
  Result, OperationError, ErrorCodes, success, failure
} from '../utils/result';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import {
  ConflictResolutionPlan,
  ConflictResolutionStrategy,
  MergeResult,
} from './conflict-resolution.types';
import { collectKeepBothTasks } from './conflict-resolution-keep-both.helpers';
import {
  appendUnprocessedRemoteTasks as appendUnprocessedRemoteTasksPure,
  createTaskMergeState,
  createTaskTombstoneSnapshot,
  getTaskTombstoneCount,
  keepConservativeLocalTask,
  keepSoftDeletedLocalTask as keepSoftDeletedLocalTaskPure,
  skipTombstoneTask as skipTombstoneTaskPure,
  type TaskMergeState,
  type TaskTombstones,
} from './conflict-resolution-merge.helpers';

// 重新导出类型以保持向后兼容
export type {
  ConflictResolutionPlan,
  ConflictResolutionStrategy,
  MergeResult
} from './conflict-resolution.types';

type ProjectMergeCollections = {
  localTasks: Task[];
  remoteTasks: Task[];
  localConnections: Project['connections'];
  remoteConnections: Project['connections'];
};

/**
 * 冲突解决服务（LWW 简化版）
 * 
 * 采用 Last-Write-Wins 策略：
 * - 默认使用本地版本（用户刚刚编辑的内容）
 * - 用户可选择使用远程版本
 * - 支持简单的智能合并（保留双方新增的任务）
 * 
 * 职责：
 * - 冲突检测
 * - LWW 策略执行
 * - 离线数据重连合并
 */
@Injectable({
  providedIn: 'root'
})
export class ConflictResolutionService {
  private readonly conflictDetection = inject(ConflictDetectionService);
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly blackBoxSync = inject(BlackBoxSyncService);
  private readonly syncStateService = inject(SyncStateService);
  private readonly taskSyncOps = inject(TaskSyncOperationsService);
  private readonly projectSaveFlight = inject(ProjectSaveFlightCoordinatorService);
  private layoutService = inject(LayoutService);
  private toast = inject(ToastService);
  private readonly loggerService = inject(LoggerService);
  private logger = this.loggerService.category('ConflictResolution');

  // ========== 冲突状态 ==========
  
  /** 是否有冲突 */
  readonly hasConflict = computed(() => this.syncStateService.syncState().hasConflict);
  
  /** 冲突数据 */
  readonly conflictData = computed(() => this.syncStateService.syncState().conflictData);

  /**
   * 标记冲突已解决：清空冲突态。
   * 等价于原 SimpleSyncService.resolveConflict——其 resolvedProject 参数从未被使用，
   * 解决后的项目数据由各方法经返回值交给调用方落盘，故此处仅负责清理冲突标记。
   */
  private markConflictResolved(projectId: string, strategy: 'local' | 'remote'): void {
    this.logger.info('解决冲突', { projectId, strategy });
    this.syncStateService.update({ hasConflict: false, conflictData: null });
  }

  // ========== 公共方法 ==========

  /**
   * 解决冲突（LWW 简化版）
   * @param projectId 项目 ID
   * @param strategy 解决策略: local（本地优先）, remote（远程优先）, merge（智能合并）
   * @param localProject 本地项目
   * @param remoteProject 远程项目
   * @returns 解决后的项目
   */
  async resolveConflict(
    projectId: string,
    strategy: ConflictResolutionStrategy,
    localProject: Project,
    remoteProject?: Project
  ): Promise<Result<Project, OperationError>> {
    this.logger.info('[LWW] 解决冲突', { projectId, strategy });

    switch (strategy) {
      case 'local':
        return success(this.resolveWithLocalVersion(projectId, localProject, remoteProject));

      case 'remote':
        return this.resolveWithRemoteVersion(projectId, remoteProject);

      case 'merge':
        return await this.resolveWithMergedVersion(projectId, localProject, remoteProject);

      default:
        this.logger.warn('[LWW] 未知策略，默认使用本地', { strategy });
        return success(this.resolveWithLocalVersion(projectId, localProject, remoteProject, false));
    }
  }

  private resolveWithLocalVersion(
    projectId: string,
    localProject: Project,
    remoteProject?: Project,
    showToast = true,
  ): Project {
    const resolvedProject = {
      ...localProject,
      version: Math.max(localProject.version ?? 0, remoteProject?.version ?? 0) + 1
    };
    this.markConflictResolved(projectId, 'local');
    if (showToast) {
      this.toast.success('已使用本地版本', '您的编辑已保留');
    }
    return resolvedProject;
  }

  private resolveWithRemoteVersion(
    projectId: string,
    remoteProject?: Project,
  ): Result<Project, OperationError> {
    if (!remoteProject) {
      return failure(ErrorCodes.DATA_NOT_FOUND, '远程项目数据不存在');
    }

    const resolvedProject = this.validateAndRebalance(remoteProject);
    this.markConflictResolved(projectId, 'remote');
    this.toast.success('已使用远程版本', '已同步其他设备的内容');
    return success(resolvedProject);
  }

  private async resolveWithMergedVersion(
    projectId: string,
    localProject: Project,
    remoteProject?: Project,
  ): Promise<Result<Project, OperationError>> {
    if (!remoteProject) {
      return failure(ErrorCodes.DATA_NOT_FOUND, '远程项目数据不存在');
    }

    const tombstoneResult = await this.taskSyncOps.getTombstoneIdsWithStatus(projectId);
    const mergeResult = this.smartMerge(
      localProject,
      remoteProject,
      createTaskTombstoneSnapshot(tombstoneResult.ids, tombstoneResult.deletedAtByTaskId),
      tombstoneResult.localCacheOnly,
    );
    this.notifySmartMergeResult(mergeResult, tombstoneResult.localCacheOnly, tombstoneResult.ids.size);
    this.markConflictResolved(projectId, 'local');
    return success(mergeResult.project);
  }

  private notifySmartMergeResult(mergeResult: MergeResult, localCacheOnly: boolean, tombstoneCount: number): void {
    if (mergeResult.issues.length > 0) {
      this.toast.info('智能合并完成', `已自动修复 ${mergeResult.issues.length} 个数据问题`);
    }
    if (mergeResult.conflictCount > 0) {
      this.toast.warning('合并提示', `${mergeResult.conflictCount} 个任务存在修改冲突，已使用本地版本`);
    }
    if (localCacheOnly && tombstoneCount === 0) {
      this.toast.warning('合并提示', '无法确认远程删除状态，已保守处理');
    }
  }

  /**
   * 按逐任务计划解决冲突
   *
   * 用于把“系统推荐 + 用户逐任务覆写”真正落实到最终项目数据，
   * 避免 UI 展示的是按任务选择，落盘时却退化成整体 local/remote 二选一。
   */
  async resolveConflictWithPlan(
    projectId: string,
    plan: ConflictResolutionPlan,
    localProject: Project,
    remoteProject?: Project,
  ): Promise<Result<Project, OperationError>> {
    this.logger.info('[Selective] 应用逐任务冲突解决方案', {
      projectId,
      taskChoiceCount: Object.keys(plan.taskChoices).length,
      appliedBy: plan.appliedBy ?? 'system',
    });

    if (!remoteProject) {
      return failure(ErrorCodes.DATA_NOT_FOUND, '远程项目数据不存在');
    }

    const tombstoneResult = await this.taskSyncOps.getTombstoneIdsWithStatus(projectId);
    const mergeResult = this.mergeWithResolutionPlan(
      localProject,
      remoteProject,
      createTaskTombstoneSnapshot(tombstoneResult.ids, tombstoneResult.deletedAtByTaskId),
      plan,
      tombstoneResult.localCacheOnly,
    );

    const resolvedProject = mergeResult.project;
    if (mergeResult.issues.length > 0) {
      this.toast.info('冲突处理提示', `已自动修复 ${mergeResult.issues.length} 个数据问题`);
    }
    if (tombstoneResult.localCacheOnly && tombstoneResult.ids.size === 0) {
      this.toast.warning('冲突处理提示', '无法确认远程删除状态，已保守处理');
    }
    this.markConflictResolved(projectId, 'local');
    return success(resolvedProject);
  }

  /**
   * 保留两者策略 - 简化版合并
   * 
   * 策略：
   * 1. 使用远程版本作为"有效"记录
   * 2. 将本地版本中仅存在于本地的任务保留
   * 3. 对于冲突的任务（双方都有但不同），创建副本
   * 
   * 这比复杂的智能合并更简单、更安全，适合个人应用场景。
   * 
   * @param projectId 项目 ID
   * @param localProject 本地项目
   * @param remoteProject 远程项目（可选）
   * @returns 解决后的项目
   */
  async resolveKeepBoth(
    projectId: string,
    localProject: Project,
    remoteProject?: Project
  ): Promise<Result<Project, OperationError>> {
    this.logger.info('[KeepBoth] 保留两者', { projectId });
    
    if (!remoteProject) {
      // 没有远程版本，直接使用本地
      return this.resolveConflict(projectId, 'local', localProject);
    }
    
    const localTasks = Array.isArray(localProject.tasks) ? localProject.tasks : [];
    const remoteTasks = Array.isArray(remoteProject.tasks) ? remoteProject.tasks : [];
    const { mergedTasks, copiedCount } = collectKeepBothTasks(localTasks, remoteTasks, {
      createId: () => crypto.randomUUID(),
      createShortId: () => this.conflictDetection.generateShortId(),
      nowIso: () => new Date().toISOString(),
    });
    
    // 合并 connections（Tombstone Wins 策略，确保删除状态不被逆转）
    const localConnections = Array.isArray(localProject.connections) ? localProject.connections : [];
    const remoteConnections = Array.isArray(remoteProject.connections) ? remoteProject.connections : [];
    const resolvedProject = this.buildKeepBothProject(
      localProject,
      remoteProject,
      mergedTasks,
      localConnections,
      remoteConnections,
    );

    this.markConflictResolved(projectId, 'local');
    this.notifyKeepBothResult(copiedCount);
    return success(resolvedProject);
  }

  private buildKeepBothProject(
    localProject: Project,
    remoteProject: Project,
    mergedTasks: Task[],
    localConnections: Project['connections'],
    remoteConnections: Project['connections'],
  ): Project {
    const mergedConnections = this.conflictDetection.mergeConnections(localConnections, remoteConnections);
    const connectionMap = new Map(mergedConnections.map(c => [c.id, c]));
    const resolvedProject: Project = {
      ...remoteProject,
      tasks: mergedTasks,
      connections: Array.from(connectionMap.values()),
      updatedAt: new Date().toISOString(),
      version: Math.max(localProject.version ?? 0, remoteProject.version ?? 0) + 1
    };
    const { project: validatedProject, issues } = this.layoutService.validateAndFixTree(resolvedProject);
    if (issues.length > 0) {
      this.logger.info('[KeepBoth] 修复了数据问题', { count: issues.length });
    }
    return validatedProject;
  }

  private notifyKeepBothResult(copiedCount: number): void {
    if (copiedCount > 0) {
      this.toast.success('已保留两者', `创建了 ${copiedCount} 个副本任务`);
    } else {
      this.toast.success('已保留两者', '本地独有的任务已保留');
    }
  }

  /**
   * 智能合并两个项目（LWW 二路合并）
   * 策略：
   * 1. 新增任务：双方都保留
   * 2. 删除任务：双方都执行
   * 3. 修改冲突：字段级合并 - 选择每个字段较新的版本
   * 4. 合并后执行完整性检查
   * 
   * 【关键修复】正确处理已删除任务：
   * - 本地存在但远程不存在 + 在 tombstones 中 = 远程已删除，不保留
   * - 本地存在但远程不存在 + 不在 tombstones 中 = 本地新增，保留
   * 
   * 【v5.9 保守处理】当 tombstone 查询失败时：
   * - 如果本地任务不在远程中，且本地缓存为空，则保守地不添加（防止复活）
   * - 记录警告日志和 Sentry 事件
   * 
   * @param local 本地项目
   * @param remote 远程项目
   * @param tombstoneIds 已永久删除的任务 ID 集合（必需参数，用于防止已删除任务复活）
   * @param tombstoneQueryFailed 是否 tombstone 查询失败（仅使用本地缓存）
   */
  smartMerge(
    local: Project, 
    remote: Project, 
    tombstoneIds: TaskTombstones,
    tombstoneQueryFailed: boolean = false
  ): MergeResult {
    const issues: string[] = [];
    const collections = this.getProjectMergeCollections(local, remote, issues, 'smartMerge');
    this.warnSmartMergeConservativeMode(local.id, tombstoneIds, tombstoneQueryFailed, issues);

    const state = createTaskMergeState(issues);
    const remoteTaskMap = new Map(collections.remoteTasks.map(task => [task.id, task]));
    for (const localTask of collections.localTasks) {
      this.mergeSmartLocalTask(localTask, remoteTaskMap, local.id, tombstoneIds, tombstoneQueryFailed, state);
    }

    this.appendUnprocessedRemoteTasks(
      collections.remoteTasks,
      state,
      remoteTask => !remoteTask.deletedAt
        && !this.skipTombstoneTask(remoteTask, tombstoneIds, state, 'smartMerge'),
    );
    this.recordSmartMergeSummary(local.id, state);
    const mergedProject = this.buildValidatedMergedProject(
      local,
      remote,
      state.mergedTasks,
      collections.localConnections,
      collections.remoteConnections,
      state.issues,
    );
    
    return {
      project: mergedProject,
      issues: state.issues,
      conflictCount: state.conflictCount
    };
  }

  private getProjectMergeCollections(
    local: Project,
    remote: Project,
    issues?: string[],
    logPrefix?: 'smartMerge',
  ): ProjectMergeCollections {
    const localTasks = Array.isArray(local.tasks) ? local.tasks : [];
    const remoteTasks = Array.isArray(remote.tasks) ? remote.tasks : [];
    const localConnections = Array.isArray(local.connections) ? local.connections : [];
    const remoteConnections = Array.isArray(remote.connections) ? remote.connections : [];

    if (issues && logPrefix && !Array.isArray(local.tasks)) {
      this.logger.warn(`${logPrefix}: local.tasks 不是数组，使用空数组`, { projectId: local.id });
      issues.push('本地项目 tasks 数据异常，已使用空数组');
    }
    if (issues && logPrefix && !Array.isArray(remote.tasks)) {
      this.logger.warn(`${logPrefix}: remote.tasks 不是数组，使用空数组`, { projectId: remote.id });
      issues.push('远程项目 tasks 数据异常，已使用空数组');
    }

    return { localTasks, remoteTasks, localConnections, remoteConnections };
  }

  private warnSmartMergeConservativeMode(
    projectId: string,
    tombstoneIds: TaskTombstones,
    tombstoneQueryFailed: boolean,
    issues: string[],
  ): void {
    if (!tombstoneQueryFailed || getTaskTombstoneCount(tombstoneIds) > 0) return;

    this.logger.warn('smartMerge: tombstone 查询失败且本地缓存为空，启用保守模式', { projectId });
    this.sentryLazyLoader.captureMessage('smartMerge 启用保守模式', {
      level: 'warning',
      tags: { operation: 'smartMerge', projectId },
      extra: { reason: 'tombstone 查询失败且本地缓存为空' }
    });
    issues.push('无法确认远程删除状态，已启用保守合并模式');
  }

  private mergeSmartLocalTask(
    localTask: Task,
    remoteTaskMap: Map<string, Task>,
    projectId: string,
    tombstoneIds: TaskTombstones,
    tombstoneQueryFailed: boolean,
    state: TaskMergeState,
  ): void {
    state.processedIds.add(localTask.id);

    if (this.skipTombstoneTask(localTask, tombstoneIds, state, 'smartMerge')) return;

    const remoteTask = remoteTaskMap.get(localTask.id);
    if (this.keepConservativeSmartTask(localTask, remoteTask, tombstoneIds, tombstoneQueryFailed, state)) return;
    if (this.keepSoftDeletedLocalTask(localTask, remoteTask, state, 'smartMerge')) return;
    if (!remoteTask) {
      state.mergedTasks.push(localTask);
      return;
    }

    this.mergeSharedSmartTask(localTask, remoteTask, projectId, state);
  }

  private skipTombstoneTask(
    task: Task,
    tombstoneIds: TaskTombstones,
    state: TaskMergeState,
    logPrefix?: 'smartMerge',
  ): boolean {
    const skipped = skipTombstoneTaskPure(task, tombstoneIds, state);
    if (!skipped) return false;

    if (logPrefix) {
      this.logger.info(`${logPrefix}: 跳过 tombstone 任务`, { taskId: task.id });
    }
    return true;
  }

  private keepConservativeSmartTask(
    localTask: Task,
    remoteTask: Task | undefined,
    tombstoneIds: TaskTombstones,
    tombstoneQueryFailed: boolean,
    state: TaskMergeState,
  ): boolean {
    const kept = keepConservativeLocalTask(localTask, remoteTask, tombstoneIds, tombstoneQueryFailed, state);
    if (!kept) return false;

    this.logger.warn('smartMerge: tombstone 不可用，保守保留本地任务', { taskId: localTask.id });
    return true;
  }

  private keepSoftDeletedLocalTask(
    localTask: Task,
    remoteTask: Task | undefined,
    state: TaskMergeState,
    logPrefix?: 'smartMerge' | 'selectiveMerge',
  ): boolean {
    const kept = keepSoftDeletedLocalTaskPure(localTask, remoteTask, state);
    if (!kept) return false;

    if (logPrefix === 'smartMerge') {
      this.logger.debug('smartMerge: 保留软删除任务（远程不存在）', { taskId: localTask.id });
    }
    return true;
  }

  private mergeSharedSmartTask(localTask: Task, remoteTask: Task, projectId: string, state: TaskMergeState): void {
    const { mergedTask, hasConflict, contentConflictCopy } =
      this.conflictDetection.mergeTaskFields(localTask, remoteTask, projectId);

    if (hasConflict) {
      state.conflictCount++;
      this.logger.debug('任务存在字段冲突，已合并', { taskId: localTask.id });
    }

    state.mergedTasks.push(mergedTask);
    if (contentConflictCopy) {
      state.mergedTasks.push(contentConflictCopy);
      this.logger.info('smartMerge: 创建 content 冲突副本', {
        originalId: localTask.id,
        copyId: contentConflictCopy.id,
        copyTitle: contentConflictCopy.title
      });
      state.issues.push(`任务 "${localTask.title || localTask.displayId}" 存在内容冲突，已创建副本`);
    }
  }

  private appendUnprocessedRemoteTasks(
    remoteTasks: Task[],
    state: TaskMergeState,
    shouldInclude: (remoteTask: Task) => boolean,
  ): void {
    appendUnprocessedRemoteTasksPure(remoteTasks, state, shouldInclude);
  }

  private recordSmartMergeSummary(projectId: string, state: TaskMergeState): void {
    this.recordSkippedTombstoneSummary(projectId, state, 'smartMerge');
    this.recordPreservedSoftDeleteSummary(projectId, state, 'smartMerge');
    if (state.conservativeCount === 0) return;

    this.logger.warn('smartMerge: 保守模式跳过任务', { count: state.conservativeCount, projectId });
    state.issues.push(`保守模式跳过 ${state.conservativeCount} 个可能已删除的任务`);
    this.sentryLazyLoader.captureMessage('smartMerge 保守跳过任务', {
      level: 'warning',
      tags: { operation: 'smartMerge', projectId },
      extra: { conservativeSkipCount: state.conservativeCount }
    });
  }

  private recordSkippedTombstoneSummary(
    projectId: string,
    state: TaskMergeState,
    logPrefix?: 'smartMerge',
  ): void {
    if (state.skippedTombstoneCount === 0) return;

    if (logPrefix) {
      this.logger.info(`${logPrefix}: 已过滤 tombstone 任务`, {
        count: state.skippedTombstoneCount,
        projectId
      });
    }
    state.issues.push(`已过滤 ${state.skippedTombstoneCount} 个已删除的任务`);
  }

  private recordPreservedSoftDeleteSummary(
    projectId: string,
    state: TaskMergeState,
    logPrefix: 'smartMerge' | 'selectiveMerge',
  ): void {
    if (state.preservedSoftDeleteCount === 0) return;

    this.logger.info(`${logPrefix}: 保留软删除任务`, {
      count: state.preservedSoftDeleteCount,
      projectId
    });
  }

  private buildValidatedMergedProject(
    local: Project,
    remote: Project,
    mergedTasks: Task[],
    localConnections: Project['connections'],
    remoteConnections: Project['connections'],
    issues: string[],
  ): Project {
    const mergedConnections = this.conflictDetection.mergeConnections(localConnections, remoteConnections);
    const mergedProject: Project = {
      ...local,
      tasks: mergedTasks,
      connections: mergedConnections,
      updatedAt: new Date().toISOString(),
      version: Math.max(local.version ?? 0, remote.version ?? 0) + 1
    };
    const { project: validatedProject, issues: validationIssues } =
      this.layoutService.validateAndFixTree(mergedProject);
    issues.push(...validationIssues);
    return validatedProject;
  }

  /**
   * 基于逐任务计划合并冲突项目
   */
  private mergeWithResolutionPlan(
    local: Project,
    remote: Project,
    tombstoneIds: TaskTombstones,
    plan: ConflictResolutionPlan,
    tombstoneQueryFailed: boolean = false,
  ): MergeResult {
    const issues: string[] = [];
    const taskChoices = plan.taskChoices ?? {};
    const collections = this.getProjectMergeCollections(local, remote);
    const state = createTaskMergeState(issues);
    const remoteTaskMap = new Map(collections.remoteTasks.map(task => [task.id, task]));

    for (const localTask of collections.localTasks) {
      this.mergePlannedLocalTask(localTask, remoteTaskMap, local.id, tombstoneIds, tombstoneQueryFailed, taskChoices, state);
    }

    this.appendUnprocessedRemoteTasks(
      collections.remoteTasks,
      state,
      remoteTask => taskChoices[remoteTask.id] !== 'local' && !remoteTask.deletedAt,
    );
    this.recordPlannedMergeSummary(local.id, state);
    const mergedProject = this.buildValidatedMergedProject(
      local,
      remote,
      state.mergedTasks,
      collections.localConnections,
      collections.remoteConnections,
      state.issues,
    );

    return {
      project: mergedProject,
      issues: state.issues,
      conflictCount: state.conflictCount,
    };
  }

  private mergePlannedLocalTask(
    localTask: Task,
    remoteTaskMap: Map<string, Task>,
    projectId: string,
    tombstoneIds: TaskTombstones,
    tombstoneQueryFailed: boolean,
    taskChoices: ConflictResolutionPlan['taskChoices'],
    state: TaskMergeState,
  ): void {
    state.processedIds.add(localTask.id);

    if (this.skipTombstoneTask(localTask, tombstoneIds, state)) return;

    const remoteTask = remoteTaskMap.get(localTask.id);
    const choice = taskChoices[localTask.id];
    if (!remoteTask && choice === 'remote') return;
    if (this.keepConservativePlannedTask(localTask, remoteTask, tombstoneIds, tombstoneQueryFailed, state)) return;
    if (this.keepSoftDeletedLocalTask(localTask, remoteTask, state, 'selectiveMerge')) return;

    this.mergePlannedTaskByChoice(localTask, remoteTask, choice, projectId, state);
  }

  private keepConservativePlannedTask(
    localTask: Task,
    remoteTask: Task | undefined,
    tombstoneIds: TaskTombstones,
    tombstoneQueryFailed: boolean,
    state: TaskMergeState,
  ): boolean {
    return keepConservativeLocalTask(localTask, remoteTask, tombstoneIds, tombstoneQueryFailed, state);
  }

  private mergePlannedTaskByChoice(
    localTask: Task,
    remoteTask: Task | undefined,
    choice: ConflictResolutionPlan['taskChoices'][string] | undefined,
    projectId: string,
    state: TaskMergeState,
  ): void {
    if (!remoteTask || choice === 'local') {
      state.mergedTasks.push(localTask);
      return;
    }
    if (choice === 'remote') {
      state.mergedTasks.push(remoteTask);
      return;
    }

    const { mergedTask, hasConflict, contentConflictCopy } = this.conflictDetection.mergeTaskFields(
      localTask,
      remoteTask,
      projectId,
    );
    if (hasConflict) {
      state.conflictCount++;
    }
    state.mergedTasks.push(mergedTask);
    if (contentConflictCopy) {
      state.mergedTasks.push(contentConflictCopy);
      state.issues.push(`任务 "${localTask.title || localTask.displayId}" 存在内容冲突，已创建副本`);
    }
  }

  private recordPlannedMergeSummary(projectId: string, state: TaskMergeState): void {
    this.recordSkippedTombstoneSummary(projectId, state);
    this.recordPreservedSoftDeleteSummary(projectId, state, 'selectiveMerge');
    if (state.conservativeCount > 0) {
      state.issues.push(`保守模式保留 ${state.conservativeCount} 个本地任务`);
    }
  }

  /**
   * 在重新连接时合并离线数据
   * 比较离线缓存和云端数据，将离线期间的修改同步到云端
   */
  async mergeOfflineDataOnReconnect(
    cloudProjects: Project[],
    offlineProjects: Project[],
    userId: string
  ): Promise<{ projects: Project[]; syncedCount: number; conflictProjects: Project[] }> {
    const cloudMap = new Map(cloudProjects.map(p => [p.id, p]));
    const mergedProjects: Project[] = [...cloudProjects];
    const conflictProjects: Project[] = [];
    let syncedCount = 0;
    
    for (const offlineProject of offlineProjects) {
      // 【P0-07 修复】不再过滤软删除任务 —— 软删除状态需要同步到服务器
      // 否则离线删除的任务在下次拉取时会复活
      const cleanedOfflineProject = offlineProject;
      
      const cloudProject = cloudMap.get(cleanedOfflineProject.id);
      
      if (!cloudProject) {
        // 离线创建的新项目，需要上传到云端
        const result = await this.projectSaveFlight.save(cleanedOfflineProject, userId);
        if (result.success) {
          mergedProjects.push(cleanedOfflineProject);
          syncedCount++;
          this.logger.info('离线新建项目已同步', { projectName: cleanedOfflineProject.name });
        }
        continue;
      }
      
      // 比较版本号
      const offlineVersion = cleanedOfflineProject.version ?? 0;
      const cloudVersion = cloudProject.version ?? 0;
      
      if (offlineVersion > cloudVersion) {
        // 离线版本更新，需要同步到云端
        const projectToSync = {
          ...cleanedOfflineProject,
          version: Math.max(offlineVersion, cloudVersion) + 1
        };
        
        const result = await this.projectSaveFlight.save(projectToSync, userId);
        if (result.success) {
          const idx = mergedProjects.findIndex(p => p.id === cleanedOfflineProject.id);
          if (idx !== -1) {
            mergedProjects[idx] = projectToSync;
          }
          syncedCount++;
          this.logger.info('离线修改已同步', { projectName: cleanedOfflineProject.name });
        } else if (result.conflict) {
          // 存在冲突
          conflictProjects.push(cleanedOfflineProject);
          this.logger.warn('离线数据存在冲突', { projectName: cleanedOfflineProject.name });
        }
      }
    }
    
    return { projects: mergedProjects, syncedCount, conflictProjects };
  }

  /**
   * 同步黑匣子数据（重连时调用）
   * 确保离线期间的黑匣子条目在重连时同步到服务器
   */
  async syncBlackBoxOnReconnect(): Promise<void> {
    try {
      await this.blackBoxSync.forceSync();
      this.logger.info('黑匣子数据重连同步完成');
    } catch (e) {
      this.logger.error('黑匣子数据重连同步失败', e);
    }
  }

  // ========== 私有方法 ==========

  /**
   * 验证并重平衡项目
   */
  private validateAndRebalance(project: Project): Project {
    const { project: validatedProject } = this.layoutService.validateAndFixTree(project);
    return this.layoutService.rebalance(validatedProject);
  }
}
