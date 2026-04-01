/**
 * ProjectOperationService - 项目操作服务
 * 
 * 【职责边界】
 * ✓ 项目 CRUD 操作（创建、删除、重命名、更新元数据）
 * ✓ 项目操作的乐观更新 + 离线队列
 * ✓ 数据冲突解决
 * ✗ 项目数据读取 → ProjectStateService
 * ✗ 任务操作 → TaskOperationAdapterService
 * ✗ 同步调度 → SyncCoordinatorService
 * 
 * 从 StoreService 中拆分，减少门面膨胀
 */
import { Injectable, inject } from '@angular/core';
import { ProjectStateService } from './project-state.service';
import { SyncCoordinatorService } from './sync-coordinator.service';
import { UserSessionService } from './user-session.service';
import { ActionQueueService } from './action-queue.service';
import { ConflictStorageService } from './conflict-storage.service';
import { OptimisticStateService } from './optimistic-state.service';
import { LayoutService } from './layout.service';
import { UndoService } from './undo.service';
import { ToastService } from './toast.service';
import { LoggerService } from './logger.service';
import { ChangeTrackerService } from './change-tracker.service';
import { RetryQueueService } from '../app/core/services/sync/retry-queue.service';
import { Project } from '../models';
import { isFailure } from '../utils/result';
import { AUTH_CONFIG } from '../config/auth.config';
import { EnqueueParams, TaskDeletePayload, TaskPayload } from './action-queue.types';

@Injectable({
  providedIn: 'root'
})
export class ProjectOperationService {
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('ProjectOps');
  
  private readonly projectState = inject(ProjectStateService);
  private readonly syncCoordinator = inject(SyncCoordinatorService);
  private readonly userSession = inject(UserSessionService);
  private readonly actionQueue = inject(ActionQueueService);
  private readonly conflictStorage = inject(ConflictStorageService);
  private readonly optimisticState = inject(OptimisticStateService);
  private readonly layoutService = inject(LayoutService);
  private readonly undoService = inject(UndoService);
  private readonly toastService = inject(ToastService);
  private readonly changeTracker = inject(ChangeTrackerService);
  private readonly retryQueue = inject(RetryQueueService);

  private captureProjectSessionContext(ownerUserId: string | null): {
    ownerUserId: string | null;
    sessionGeneration: number;
  } {
    return {
      ownerUserId,
      sessionGeneration: this.userSession.getCurrentSessionGeneration(),
    };
  }

  private isProjectSessionContextCurrent(
    context: { ownerUserId: string | null; sessionGeneration: number },
    stage: string,
    projectId: string
  ): boolean {
    if (this.userSession.isSessionContextCurrent(context.sessionGeneration, context.ownerUserId)) {
      return true;
    }

    this.logger.debug('忽略过期的项目操作结果', {
      stage,
      projectId,
      expectedOwnerUserId: context.ownerUserId,
      currentUserId: this.userSession.currentUserId(),
      sessionGeneration: context.sessionGeneration,
      currentGeneration: this.userSession.getCurrentSessionGeneration(),
    });
    return false;
  }

  private async settleStaleProjectCrudFailure(
    context: { ownerUserId: string | null; sessionGeneration: number },
    action: EnqueueParams,
    stage: string
  ): Promise<void> {
    if (!context.ownerUserId || context.ownerUserId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      return;
    }

    await this.actionQueue.enqueueForOwner(context.ownerUserId, action);
    this.logger.info('过期项目 CRUD 已写回原 owner 队列', {
      stage,
      ownerUserId: context.ownerUserId,
      actionType: action.type,
      entityId: action.entityId,
    });
  }

  // ========== 项目 CRUD 操作 ==========

  /**
   * 创建新项目
   * 
   * 实现乐观更新：
   * 1. 立即更新本地状态
   * 2. 后台同步到云端
   * 3. 失败时回滚或加入离线队列
   */
  async addProject(project: Project): Promise<{ success: boolean; error?: string }> {
    const balanced = this.layoutService.rebalance(project);
    const userId = this.userSession.currentUserId();
    const isCloudBackedUser = !!userId && userId !== AUTH_CONFIG.LOCAL_MODE_USER_ID;
    const sessionContext = this.captureProjectSessionContext(userId);
    const localProject: Project = {
      ...balanced,
      syncSource: isCloudBackedUser ? 'synced' : 'local-only',
      pendingSync: isCloudBackedUser,
    };
    const createQueueAction: EnqueueParams = {
      type: 'create',
      entityType: 'project',
      entityId: localProject.id,
      payload: { project: localProject, sourceUserId: userId ?? undefined }
    };
    
    // 创建快照（乐观更新前）
    const snapshot = this.optimisticState.createSnapshot('project-create', '创建项目');
    
    // 乐观更新：立即显示新项目
    this.projectState.updateProjects(p => [...p, localProject]);
    this.projectState.setActiveProjectId(localProject.id);
    
    if (isCloudBackedUser) {
      try {
        const result = await this.syncCoordinator.core.saveProjectSmart(localProject, userId);
        if (!this.isProjectSessionContextCurrent(sessionContext, 'addProject:saveProjectSmart', localProject.id)) {
          if (!result.success && !result.conflict) {
            await this.settleStaleProjectCrudFailure(sessionContext, createQueueAction, 'addProject:saveProjectSmart');
          }
          this.optimisticState.commitSnapshot(snapshot.id);
          return { success: true };
        }
        
        if (!result.success && !result.conflict) {
          // 同步失败（离线或网络异常）：保留本地乐观更新，加入离线队列
          // 不回滚——确保离线状态下用户操作不受阻断
          this.actionQueue.enqueue(createQueueAction);
          this.toastService.info('已保存到本地', '项目将在网络恢复后同步到云端');
          this.optimisticState.commitSnapshot(snapshot.id);
        } else if (result.conflict) {
          this.toastService.warning('数据冲突', '检测到数据冲突，请检查');
          this.optimisticState.commitSnapshot(snapshot.id);
        } else {
          this.optimisticState.commitSnapshot(snapshot.id);
        }
      } catch (_e) {
        if (!this.isProjectSessionContextCurrent(sessionContext, 'addProject:saveProjectSmart-error', localProject.id)) {
          await this.settleStaleProjectCrudFailure(sessionContext, createQueueAction, 'addProject:saveProjectSmart-error');
          this.optimisticState.commitSnapshot(snapshot.id);
          return { success: true };
        }

        // 异常情况也不回滚，保留本地数据，加入离线队列
        this.actionQueue.enqueue(createQueueAction);
        this.toastService.info('已保存到本地', '网络恢复后将自动同步');
        this.optimisticState.commitSnapshot(snapshot.id);
      }
    } else {
      // 未登录：提交快照（本地保存）
      this.optimisticState.commitSnapshot(snapshot.id);
    }
    
    this.syncCoordinator.markLocalChanges('structure');
    this.syncCoordinator.schedulePersist();
    return { success: true };
  }

  /**
   * 删除项目
   */
  async deleteProject(projectId: string): Promise<{ success: boolean; error?: string }> {
    const userId = this.userSession.currentUserId();
    const isCloudBackedUser = !!userId && userId !== AUTH_CONFIG.LOCAL_MODE_USER_ID;
    const sessionContext = this.captureProjectSessionContext(userId);
    const deleteQueueAction: EnqueueParams = {
      type: 'delete',
      entityType: 'project',
      entityId: projectId,
      payload: { projectId, userId: userId ?? AUTH_CONFIG.LOCAL_MODE_USER_ID, sourceUserId: userId ?? undefined }
    };
    
    // 创建快照（乐观更新前）
    const snapshot = this.optimisticState.createSnapshot('project-delete', '删除项目');
    
    // 乐观更新：立即从列表中移除
    this.projectState.updateProjects(p => p.filter(proj => proj.id !== projectId));
    
    if (this.projectState.activeProjectId() === projectId) {
      const remaining = this.projectState.projects();
      this.projectState.setActiveProjectId(remaining[0]?.id ?? null);
    }
    
    if (isCloudBackedUser) {
      try {
        const deleteSuccess = await this.syncCoordinator.core.deleteProjectFromCloud(projectId, userId);
        if (!this.isProjectSessionContextCurrent(sessionContext, 'deleteProject:deleteProjectFromCloud', projectId)) {
          if (!deleteSuccess) {
            await this.settleStaleProjectCrudFailure(sessionContext, deleteQueueAction, 'deleteProject:deleteProjectFromCloud');
          }
          this.optimisticState.commitSnapshot(snapshot.id);
          return { success: true };
        }
        
        if (!deleteSuccess) {
          // 同步失败（离线或网络异常）：保留本地乐观更新，加入离线队列
          this.actionQueue.enqueue(deleteQueueAction);
          this.toastService.info('已在本地删除', '网络恢复后将同步到云端');
          this.optimisticState.commitSnapshot(snapshot.id);
        } else {
          this.optimisticState.commitSnapshot(snapshot.id);
        }
      } catch (_e) {
        if (!this.isProjectSessionContextCurrent(sessionContext, 'deleteProject:deleteProjectFromCloud-error', projectId)) {
          await this.settleStaleProjectCrudFailure(sessionContext, deleteQueueAction, 'deleteProject:deleteProjectFromCloud-error');
          this.optimisticState.commitSnapshot(snapshot.id);
          return { success: true };
        }

        // 异常情况也不回滚，保留本地删除操作
        this.actionQueue.enqueue(deleteQueueAction);
        this.toastService.info('已在本地删除', '网络恢复后将自动同步');
        this.optimisticState.commitSnapshot(snapshot.id);
      }
    } else {
      this.optimisticState.commitSnapshot(snapshot.id);
    }
    
    this.syncCoordinator.core.saveOfflineSnapshot(this.projectState.projects());
    return { success: true };
  }

  /**
   * 更新项目元数据（描述、创建日期）
   */
  updateProjectMetadata(projectId: string, metadata: { description?: string; createdDate?: string }): void {
    this.projectState.updateProjects(projects => projects.map(p => p.id === projectId ? {
      ...p,
      description: metadata.description ?? p.description,
      createdDate: metadata.createdDate ?? p.createdDate
    } : p));
    
    if (this.projectState.activeProjectId() === projectId) {
      this.syncCoordinator.markLocalChanges('structure');
      this.syncCoordinator.schedulePersist();
    }
  }

  /**
   * 重命名项目
   */
  renameProject(projectId: string, newName: string): boolean {
    const success = this.projectState.renameProject(projectId, newName);
    if (success) {
      this.syncCoordinator.markLocalChanges('structure');
      this.syncCoordinator.schedulePersist();
    }
    return success;
  }

  async upsertImportedProject(project: Project): Promise<{ success: boolean; error?: string }> {
    const snapshot = this.optimisticState.createSnapshot('project-import', '导入项目');
    const userId = this.userSession.currentUserId();
    const isCloudBackedUser = !!userId && userId !== AUTH_CONFIG.LOCAL_MODE_USER_ID;
    const existingProject = this.projectState.getProject(project.id);
    const localProject: Project = {
      ...project,
      syncSource: isCloudBackedUser ? 'synced' : 'local-only',
      pendingSync: isCloudBackedUser,
    };

    this.projectState.updateProjects(projects => {
      const hasExistingProject = projects.some(current => current.id === localProject.id);
      if (!hasExistingProject) {
        return [...projects, localProject];
      }

      return projects.map(current =>
        current.id === localProject.id
          ? { ...current, ...localProject }
          : current
      );
    });
    this.syncCoordinator.core.saveOfflineSnapshot(this.projectState.projects());

    if (!isCloudBackedUser || !userId) {
      this.optimisticState.commitSnapshot(snapshot.id);
      return { success: true };
    }

    const sessionContext = this.captureProjectSessionContext(userId);
    const importQueueAction: EnqueueParams = {
      type: existingProject ? 'update' : 'create',
      entityType: 'project',
      entityId: localProject.id,
      payload: {
        project: { ...localProject, syncSource: 'synced', pendingSync: true },
        sourceUserId: userId,
      }
    };

    try {
      const result = await this.syncCoordinator.core.saveProjectSmart(localProject, userId);

      if (!this.isProjectSessionContextCurrent(sessionContext, 'upsertImportedProject:saveProjectSmart', localProject.id)) {
        if (!result.success && !result.conflict) {
          await this.settleStaleProjectCrudFailure(
            sessionContext,
            importQueueAction,
            'upsertImportedProject:saveProjectSmart'
          );
        }
        this.optimisticState.commitSnapshot(snapshot.id);
        return { success: true };
      }

      if (result.success) {
        this.projectState.updateProjects(projects => projects.map(current =>
          current.id === localProject.id
            ? {
                ...current,
                syncSource: 'synced',
                pendingSync: false,
                version: result.newVersion ?? current.version,
              }
            : current
        ));
        this.syncCoordinator.core.saveOfflineSnapshot(this.projectState.projects());
        this.optimisticState.commitSnapshot(snapshot.id);
        return { success: true };
      }

      if (result.conflict) {
        const captured = await this.captureConflictWithRemoteFallback(localProject, result.remoteData, undefined, sessionContext);
        if (!captured) {
          this.optimisticState.commitSnapshot(snapshot.id);
          return { success: true };
        }
        this.toastService.warning('导入存在冲突', '检测到云端版本冲突，请检查后重试');
        this.optimisticState.commitSnapshot(snapshot.id);
        return { success: false, error: '导入冲突' };
      }

      this.actionQueue.enqueue(importQueueAction);
      this.toastService.info('已保存到本地', '导入内容将在网络恢复后同步到云端');
      this.optimisticState.commitSnapshot(snapshot.id);
      this.syncCoordinator.core.saveOfflineSnapshot(this.projectState.projects());
      return { success: true };
    } catch (_error) {
      if (!this.isProjectSessionContextCurrent(sessionContext, 'upsertImportedProject:saveProjectSmart-error', localProject.id)) {
        await this.settleStaleProjectCrudFailure(
          sessionContext,
          importQueueAction,
          'upsertImportedProject:saveProjectSmart-error'
        );
        this.optimisticState.commitSnapshot(snapshot.id);
        return { success: true };
      }

      this.actionQueue.enqueue(importQueueAction);
      this.toastService.info('已保存到本地', '导入内容将在网络恢复后自动同步');
      this.optimisticState.commitSnapshot(snapshot.id);
      this.syncCoordinator.core.saveOfflineSnapshot(this.projectState.projects());
      return { success: true };
    }
  }

  /**
   * 更新项目的流程图缩略图 URL
   */
  updateProjectFlowchartUrl(projectId: string, flowchartUrl: string, thumbnailUrl?: string): void {
    this.projectState.updateProjects(projects => projects.map(p => {
      if (p.id === projectId) {
        return {
          ...p,
          flowchartUrl,
          flowchartThumbnailUrl: thumbnailUrl
        };
      }
      return p;
    }));
    this.syncCoordinator.markLocalChanges('structure');
    this.syncCoordinator.schedulePersist();
  }

  // ========== 冲突解决 ==========

  /**
   * 解决数据冲突
   * 
   * @param projectId 项目 ID
   * @param choice 解决方式：local（保留本地）、remote（使用远程）、merge（合并）
   */
  async resolveConflict(projectId: string, choice: 'local' | 'remote' | 'merge'): Promise<boolean> {
    const sessionContext = this.captureProjectSessionContext(this.userSession.currentUserId());
    const activeConflict = this.syncCoordinator.conflictData();
    const storedConflict = await this.conflictStorage.getConflict(projectId);
    if (!this.isProjectSessionContextCurrent(sessionContext, 'resolveConflict:get-stored-conflict', projectId)) {
      return false;
    }

    const conflictData = activeConflict && activeConflict.projectId === projectId
      ? activeConflict
      : null;
    const remoteSnapshotFresh = storedConflict?.remoteSnapshotFresh === true;

    const localProject = this.projectState.getProject(projectId)
      ?? storedConflict?.localProject;
    if (!localProject) return false;
    
    let remoteProject = (conflictData?.remote as Project | undefined)
      ?? (remoteSnapshotFresh ? storedConflict?.remoteProject : undefined);

    if (!remoteProject && choice !== 'local') {
      remoteProject = await this.tryLoadRemoteConflictProject(projectId, localProject, sessionContext);
      if (!this.isProjectSessionContextCurrent(sessionContext, 'resolveConflict:load-remote-project', projectId)) {
        return false;
      }
      if (!remoteProject) {
        this.toastService.error('冲突解决失败', '远端版本暂不可用，请稍后重试，或先保留本地版本');
        return false;
      }
    }
    
    const result = await this.syncCoordinator.resolveConflict(
      projectId,
      choice,
      localProject,
      remoteProject
    );
    if (!this.isProjectSessionContextCurrent(sessionContext, 'resolveConflict:resolve', projectId)) {
      return false;
    }
    
    if (isFailure(result)) {
      this.toastService.error('冲突解决失败', result.error.message);
      return false;
    }
    
    const resolvedProject = this.syncCoordinator.validateAndRebalance(result.value);
    
    this.projectState.updateProjects(ps => {
      const hasExistingProject = ps.some(project => project.id === projectId);
      if (!hasExistingProject) {
        return [...ps, resolvedProject];
      }

      return ps.map(project =>
        project.id === projectId ? resolvedProject : project
      );
    });
    this.syncCoordinator.core.saveOfflineSnapshot(this.projectState.projects());
    
    if (this.projectState.activeProjectId() === projectId) {
      this.undoService.clearHistory(projectId);
    }

    this.discardStaleProjectMutations(projectId);
    
    if (choice !== 'remote') {
      const userId = sessionContext.ownerUserId;
      const isCloudBackedUser = !!userId && userId !== AUTH_CONFIG.LOCAL_MODE_USER_ID;
      if (isCloudBackedUser) {
        try {
          const syncResult = await this.syncCoordinator.core.saveProjectSmart(resolvedProject, userId);
          if (!this.isProjectSessionContextCurrent(sessionContext, 'resolveConflict:saveProjectSmart', projectId)) {
            return true;
          }
          if (!syncResult.success && !syncResult.conflict) {
            this.actionQueue.enqueue({
              type: 'update',
              entityType: 'project',
              entityId: projectId,
              payload: { project: resolvedProject, sourceUserId: userId }
            });
            this.finalizeResolvedProject(projectId, resolvedProject, {
              pendingSync: true,
            });
            this.toastService.warning('同步待重试', '冲突已解决，但同步失败，稍后将自动重试');
          } else if (syncResult.conflict) {
            const captured = await this.captureConflictWithRemoteFallback(
              resolvedProject,
              syncResult.remoteData,
              remoteProject,
              sessionContext
            );
            if (!captured) {
              return true;
            }
            this.toastService.error('同步冲突', '解决冲突后又发生新冲突，请稍后重试');
            return false;
          } else {
            this.finalizeResolvedProject(projectId, resolvedProject, {
              version: syncResult.newVersion ?? resolvedProject.version,
              pendingSync: false,
            });
          }
        } catch (_e) {
          if (!this.isProjectSessionContextCurrent(sessionContext, 'resolveConflict:saveProjectSmart-error', projectId)) {
            return true;
          }

          this.actionQueue.enqueue({
            type: 'update',
            entityType: 'project',
            entityId: projectId,
            payload: { project: resolvedProject, sourceUserId: userId }
          });
          this.finalizeResolvedProject(projectId, resolvedProject, {
            pendingSync: true,
          });
        }
      } else {
        this.finalizeResolvedProject(projectId, resolvedProject, {
          pendingSync: false,
        });
      }
    } else {
      if (!this.isProjectSessionContextCurrent(sessionContext, 'resolveConflict:finalize-remote', projectId)) {
        return false;
      }
      this.finalizeResolvedProject(projectId, resolvedProject, {
        pendingSync: false,
      });
    }

    if (!this.isProjectSessionContextCurrent(sessionContext, 'resolveConflict:delete-conflict', projectId)) {
      return false;
    }

    await this.conflictStorage.deleteConflict(projectId, sessionContext.ownerUserId);
    if (!this.isProjectSessionContextCurrent(sessionContext, 'resolveConflict:clear-active-conflict', projectId)) {
      return false;
    }

    if (activeConflict?.projectId === projectId) {
      this.syncCoordinator.clearActiveConflict();
    }

    return true;
  }

  private async captureConflictWithRemoteFallback(
    localProject: Project,
    remoteProject?: Project,
    fallbackRemoteProject?: Project,
    sessionContext?: { ownerUserId: string | null; sessionGeneration: number }
  ): Promise<boolean> {
    if (sessionContext && !this.isProjectSessionContextCurrent(sessionContext, 'captureConflict:start', localProject.id)) {
      return false;
    }

    if (remoteProject) {
      await this.syncCoordinator.captureConflict(localProject, remoteProject, sessionContext?.ownerUserId);
      return true;
    }

    const resolvedRemoteProject = await this.tryLoadRemoteConflictProject(localProject.id, localProject, sessionContext);
    if (sessionContext && !this.isProjectSessionContextCurrent(sessionContext, 'captureConflict:resolved-remote', localProject.id)) {
      return false;
    }

    if (resolvedRemoteProject) {
      await this.syncCoordinator.captureConflict(localProject, resolvedRemoteProject, sessionContext?.ownerUserId);
      return true;
    }

    await this.conflictStorage.saveConflict({
      projectId: localProject.id,
      localProject,
      ownerUserId: sessionContext?.ownerUserId ?? undefined,
      remoteProject: fallbackRemoteProject,
      remoteSnapshotFresh: false,
      conflictedAt: new Date().toISOString(),
      localVersion: localProject.version ?? 0,
      remoteVersion: fallbackRemoteProject?.version,
      reason: 'version_mismatch',
      acknowledged: false,
    });
    if (sessionContext && !this.isProjectSessionContextCurrent(sessionContext, 'captureConflict:fallback-saved', localProject.id)) {
      return false;
    }
    this.syncCoordinator.clearActiveConflict();
    return true;
  }

  private async tryLoadRemoteConflictProject(
    projectId: string,
    localProject: Project,
    sessionContext?: { ownerUserId: string | null; sessionGeneration: number }
  ): Promise<Project | undefined> {
    try {
      const remoteProject = await this.syncCoordinator.loadSingleProjectFromCloud(projectId);
      if (sessionContext && !this.isProjectSessionContextCurrent(sessionContext, 'tryLoadRemoteConflictProject:load-remote', projectId)) {
        return undefined;
      }

      if (remoteProject) {
        await this.conflictStorage.saveConflict({
          projectId,
          localProject,
          remoteProject,
          ownerUserId: sessionContext?.ownerUserId ?? undefined,
          remoteSnapshotFresh: true,
          conflictedAt: new Date().toISOString(),
          localVersion: localProject.version ?? 0,
          remoteVersion: remoteProject.version ?? 0,
          reason: 'version_mismatch',
          acknowledged: false,
        });
        return remoteProject;
      }
    } catch (_error) {
      // 远端快照获取失败时保留当前冲突记录，稍后由用户重试。
    }

    return undefined;
  }

  private finalizeResolvedProject(
    projectId: string,
    project: Project,
    options: { version?: number; pendingSync: boolean }
  ): void {
    this.projectState.updateProjects(projects => projects.map(current =>
      current.id === projectId
        ? {
            ...current,
            ...project,
            version: options.version ?? project.version,
            syncSource: 'synced',
            pendingSync: options.pendingSync,
          }
        : current
    ));
    this.syncCoordinator.core.saveOfflineSnapshot(this.projectState.projects());
    this.changeTracker.clearProjectFieldLocks(projectId);
    this.changeTracker.clearProjectChanges(projectId);
  }

  private discardStaleProjectMutations(projectId: string): void {
    this.actionQueue.discardActions(action => {
      if (action.entityType === 'project' && action.entityId === projectId) {
        return true;
      }

      if (action.entityType === 'task') {
        const payload = action.payload as TaskPayload | TaskDeletePayload;
        return payload.projectId === projectId;
      }

      return false;
    });
    this.retryQueue.removeByProjectId(projectId);
  }
}
