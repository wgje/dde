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
import { ProjectDataService } from '../core-bridge';
import { UserSessionService } from './user-session.service';
import { ActionQueueService } from './action-queue.service';
import { OptimisticStateService } from './optimistic-state.service';
import { LayoutService } from './layout.service';
import { ToastService } from './toast.service';
import { WriteGuardService } from './write-guard.service';
import { ProjectOperationConflictService } from './project-operation-conflict.service';
import { Project } from '../models';
import { type ConflictResolutionPlan } from './conflict-resolution.types';
import { AUTH_CONFIG } from '../config/auth.config';
import { EnqueueParams } from './action-queue.types';
import { blockProjectMutation } from './project-operation-write-guard.helpers';

@Injectable({
  providedIn: 'root'
})
export class ProjectOperationService {
  private readonly projectState = inject(ProjectStateService);
  private readonly syncCoordinator = inject(SyncCoordinatorService);
  private readonly projectData = inject(ProjectDataService);
  private readonly userSession = inject(UserSessionService);
  private readonly actionQueue = inject(ActionQueueService);
  private readonly optimisticState = inject(OptimisticStateService);
  private readonly layoutService = inject(LayoutService);
  private readonly toastService = inject(ToastService);
  private readonly writeGuard = inject(WriteGuardService);
  private readonly projectConflict = inject(ProjectOperationConflictService);

  private blockProjectMutation(actionLabel: string): { success: false; error: string } | null {
    return blockProjectMutation(actionLabel, {
      isExportOnly: () => this.writeGuard.isExportOnly(),
      isHintOnlyStartupReadOnly: () => this.userSession.isHintOnlyStartupPlaceholderVisible?.() ?? false,
      toastInfo: (title, message) => this.toastService.info(title, message),
    });
  }

  private buildLocalProjectForUser(project: Project, isCloudBackedUser: boolean): Project {
    return {
      ...project,
      syncSource: isCloudBackedUser ? 'synced' : 'local-only',
      pendingSync: isCloudBackedUser,
    };
  }

  private async commitProjectUpdateDurably(
    snapshotId: string,
    project: Project,
    queueErrorMessage: string,
    updateProjects?: (projects: Project[]) => Project[],
  ): Promise<{ success: boolean; error?: string }> {
    const userId = this.userSession.currentUserId();
    const isCloudBackedUser = !!userId && userId !== AUTH_CONFIG.LOCAL_MODE_USER_ID;
    const nextProjects = updateProjects?.(this.projectState.projects());

    if (isCloudBackedUser) {
      const actionId = await this.actionQueue.enqueueDurably({
        type: 'update',
        entityType: 'project',
        entityId: project.id,
        payload: {
          project: { ...project, syncSource: 'synced', pendingSync: true },
          sourceUserId: userId,
        },
      });

      if (!actionId) {
        this.optimisticState.rollbackSnapshot(snapshotId, false);
        this.toastService.error('本地保存失败', `${queueErrorMessage}，请释放浏览器存储空间后重试`);
        this.projectData.saveOfflineSnapshot(this.projectState.projects());
        return { success: false, error: queueErrorMessage };
      }
      if (nextProjects) {
        const failure = await this.persistProjectSnapshotBeforeCommit(
          snapshotId,
          nextProjects,
          { queuedActionId: actionId },
        );
        if (failure) {
          return failure;
        }
      }
    } else if (nextProjects) {
      const failure = await this.persistProjectSnapshotBeforeCommit(
        snapshotId,
        nextProjects,
      );
      if (failure) {
        return failure;
      }
    }

    if (updateProjects) {
      this.projectState.updateProjects(updateProjects);
    }
    this.finalizeDurableLocalProjectMutation(snapshotId);
    return { success: true };
  }

  private findProject(projectId: string): Project | null {
    return this.projectState.projects().find(project => project.id === projectId) ?? null;
  }

  private replaceProjectUpdater(project: Project): (projects: Project[]) => Project[] {
    return projects => projects.map(current =>
      current.id === project.id ? project : current
    );
  }

  private async persistProjectSnapshotBeforeCommit(
    snapshotId: string,
    nextProjects: Project[],
    options: { queuedActionId?: string } = {},
  ): Promise<{ success: false; error: string } | null> {
    try {
      await this.projectData.saveOfflineSnapshotAndWait(nextProjects);
      return null;
    } catch {
      this.discardQueuedAction(options.queuedActionId);
      this.optimisticState.rollbackSnapshot(snapshotId, false);
      this.toastService.error('本地保存失败', '离线快照未能写入，请释放浏览器存储空间后重试');
      return { success: false, error: '离线快照未能写入' };
    }
  }

  private discardQueuedAction(actionId: string | undefined): void {
    if (!actionId) {
      return;
    }

    try {
      this.actionQueue.discardActions(action =>
        action.id === actionId || action.operationId === actionId);
    } catch {
      // The visible mutation is still blocked; keep this path best-effort so the
      // original storage failure remains the user-facing error.
    }
  }

  private finalizeDurableLocalProjectMutation(snapshotId: string): void {
    this.optimisticState.commitSnapshot(snapshotId);
    this.syncCoordinator.markLocalChanges('structure');
    this.syncCoordinator.schedulePersist();
    this.projectData.saveOfflineSnapshot(this.projectState.projects());
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
    const blocked = this.blockProjectMutation('创建项目');
    if (blocked) return blocked;

    const balanced = this.layoutService.rebalance(project);
    const userId = this.userSession.currentUserId();
    const isCloudBackedUser = !!userId && userId !== AUTH_CONFIG.LOCAL_MODE_USER_ID;
    const localProject = this.buildLocalProjectForUser(balanced, isCloudBackedUser);
    const createQueueAction: EnqueueParams = {
      type: 'create',
      entityType: 'project',
      entityId: localProject.id,
      payload: { project: localProject, sourceUserId: userId ?? undefined }
    };
    
    // 创建快照（乐观更新前）
    const snapshot = this.optimisticState.createSnapshot('project-create', '创建项目');
    
    const addProjectUpdater = (projects: Project[]) => [...projects, localProject];
    const nextProjects = addProjectUpdater(this.projectState.projects());
    let actionId = '';
    if (isCloudBackedUser) {
      actionId = await this.actionQueue.enqueueDurably(createQueueAction);
      if (!actionId) {
        this.optimisticState.rollbackSnapshot(snapshot.id, false);
        this.toastService.error('本地保存失败', '离线同步队列未能写入，请释放浏览器存储空间后重试');
        return { success: false, error: '离线同步队列未能写入' };
      }
    }

    const snapshotFailure = await this.persistProjectSnapshotBeforeCommit(
      snapshot.id,
      nextProjects,
      { queuedActionId: isCloudBackedUser ? actionId : undefined },
    );
    if (snapshotFailure) {
      return snapshotFailure;
    }

    this.projectState.updateProjects(addProjectUpdater);
    this.projectState.setActiveProjectId(localProject.id);
    this.finalizeDurableLocalProjectMutation(snapshot.id);
    return { success: true };
  }

  /**
   * 删除项目
   */
  async deleteProject(projectId: string): Promise<{ success: boolean; error?: string }> {
    const blocked = this.blockProjectMutation('删除项目');
    if (blocked) return blocked;

    const userId = this.userSession.currentUserId();
    const isCloudBackedUser = !!userId && userId !== AUTH_CONFIG.LOCAL_MODE_USER_ID;
    const deleteQueueAction: EnqueueParams = {
      type: 'delete',
      entityType: 'project',
      entityId: projectId,
      payload: { projectId, userId: userId ?? AUTH_CONFIG.LOCAL_MODE_USER_ID, sourceUserId: userId ?? undefined }
    };
    
    // 创建快照（乐观更新前）
    const snapshot = this.optimisticState.createSnapshot('project-delete', '删除项目');
    const activeProjectId = this.projectState.activeProjectId();
    const deleteProjectUpdater = (projects: Project[]) => projects.filter(project => project.id !== projectId);
    const remainingProjects = deleteProjectUpdater(this.projectState.projects());
    
    let actionId = '';
    if (isCloudBackedUser) {
      actionId = await this.actionQueue.enqueueDurably(deleteQueueAction);
      if (!actionId) {
        this.optimisticState.rollbackSnapshot(snapshot.id, false);
        this.toastService.error('本地保存失败', '离线删除队列未能写入，请释放浏览器存储空间后重试');
        this.projectData.saveOfflineSnapshot(this.projectState.projects());
        return { success: false, error: '离线删除队列未能写入' };
      }
    }

    const snapshotFailure = await this.persistProjectSnapshotBeforeCommit(
      snapshot.id,
      remainingProjects,
      { queuedActionId: isCloudBackedUser ? actionId : undefined },
    );
    if (snapshotFailure) {
      return snapshotFailure;
    }

    this.projectState.updateProjects(deleteProjectUpdater);

    if (activeProjectId === projectId) {
      this.projectState.setActiveProjectId(remainingProjects[0]?.id ?? null);
    }

    this.finalizeDurableLocalProjectMutation(snapshot.id);
    return { success: true };
  }

  /**
   * 更新项目元数据（描述、创建日期）
   */
  async updateProjectMetadata(
    projectId: string,
    metadata: { description?: string; createdDate?: string },
  ): Promise<{ success: boolean; error?: string }> {
    const blocked = this.blockProjectMutation('保存项目设置');
    if (blocked) return blocked;

    const snapshot = this.optimisticState.createSnapshot('project-update', '保存项目设置');
    const userId = this.userSession.currentUserId();
    const isCloudBackedUser = !!userId && userId !== AUTH_CONFIG.LOCAL_MODE_USER_ID;
    const currentProject = this.findProject(projectId);
    const updatedProject = currentProject
      ? this.buildLocalProjectForUser({
        ...currentProject,
        description: metadata.description ?? currentProject.description,
        createdDate: metadata.createdDate ?? currentProject.createdDate,
      }, isCloudBackedUser)
      : null;

    if (!updatedProject) {
      this.optimisticState.rollbackSnapshot(snapshot.id, false);
      return { success: false, error: '项目不存在' };
    }

    return this.commitProjectUpdateDurably(
      snapshot.id,
      updatedProject,
      '离线项目更新队列未能写入',
      this.replaceProjectUpdater(updatedProject),
    );
  }

  /**
   * 重命名项目
   */
  async renameProject(projectId: string, newName: string): Promise<boolean> {
    if (this.blockProjectMutation('重命名项目')) {
      return false;
    }

    const trimmed = newName.trim();
    if (!trimmed) return false;

    const snapshot = this.optimisticState.createSnapshot('project-update', '重命名项目');
    const userId = this.userSession.currentUserId();
    const isCloudBackedUser = !!userId && userId !== AUTH_CONFIG.LOCAL_MODE_USER_ID;
    const currentProject = this.findProject(projectId);
    const updatedProject = currentProject
      ? this.buildLocalProjectForUser({ ...currentProject, name: trimmed }, isCloudBackedUser)
      : null;

    if (!updatedProject) {
      this.optimisticState.rollbackSnapshot(snapshot.id, false);
      return false;
    }

    const result = await this.commitProjectUpdateDurably(
      snapshot.id,
      updatedProject,
      '离线项目更新队列未能写入',
      this.replaceProjectUpdater(updatedProject),
    );
    return result.success;
  }

  async upsertImportedProject(project: Project): Promise<{ success: boolean; error?: string }> {
    const blocked = this.blockProjectMutation('导入项目');
    if (blocked) return blocked;

    const snapshot = this.optimisticState.createSnapshot('project-import', '导入项目');
    const userId = this.userSession.currentUserId();
    const isCloudBackedUser = !!userId && userId !== AUTH_CONFIG.LOCAL_MODE_USER_ID;
    const existingProject = this.projectState.getProject(project.id);
    const localProject = this.buildLocalProjectForUser(project, isCloudBackedUser);

    if (!isCloudBackedUser || !userId) {
      const upsertProjectUpdater = (projects: Project[]) => this.upsertProjectList(projects, localProject);
      const failure = await this.persistProjectSnapshotBeforeCommit(
        snapshot.id,
        upsertProjectUpdater(this.projectState.projects()),
      );
      if (failure) {
        return failure;
      }
      this.projectState.updateProjects(upsertProjectUpdater);
      this.finalizeDurableLocalProjectMutation(snapshot.id);
      return { success: true };
    }

    const importQueueAction: EnqueueParams = {
      type: existingProject ? 'update' : 'create',
      entityType: 'project',
      entityId: localProject.id,
      payload: {
        project: { ...localProject, syncSource: 'synced', pendingSync: true },
        sourceUserId: userId,
      }
    };

    const actionId = await this.actionQueue.enqueueDurably(importQueueAction);
    if (!actionId) {
      this.optimisticState.rollbackSnapshot(snapshot.id, false);
      this.toastService.error('本地保存失败', '离线导入队列未能写入，请释放浏览器存储空间后重试');
      this.projectData.saveOfflineSnapshot(this.projectState.projects());
      return { success: false, error: '离线导入队列未能写入' };
    }
    const snapshotFailure = await this.persistProjectSnapshotBeforeCommit(
      snapshot.id,
      this.upsertProjectList(this.projectState.projects(), localProject),
      { queuedActionId: actionId },
    );
    if (snapshotFailure) {
      return snapshotFailure;
    }

    this.upsertLocalProject(localProject);
    this.finalizeDurableLocalProjectMutation(snapshot.id);
    return { success: true };
  }

  private upsertLocalProject(localProject: Project): void {
    this.projectState.updateProjects(projects => this.upsertProjectList(projects, localProject));
  }

  private upsertProjectList(projects: Project[], localProject: Project): Project[] {
    const hasExistingProject = projects.some(current => current.id === localProject.id);
    if (!hasExistingProject) {
      return [...projects, localProject];
    }

    return projects.map(current =>
      current.id === localProject.id
        ? { ...current, ...localProject }
        : current
    );
  }

  /**
   * 更新项目的流程图缩略图 URL
   */
  async updateProjectFlowchartUrl(
    projectId: string,
    flowchartUrl: string,
    thumbnailUrl?: string,
  ): Promise<{ success: boolean; error?: string }> {
    const blocked = this.blockProjectMutation('更新流程图');
    if (blocked) return blocked;

    const snapshot = this.optimisticState.createSnapshot('project-update', '更新流程图');
    const userId = this.userSession.currentUserId();
    const isCloudBackedUser = !!userId && userId !== AUTH_CONFIG.LOCAL_MODE_USER_ID;
    const currentProject = this.findProject(projectId);
    const updatedProject = currentProject
      ? this.buildLocalProjectForUser({
        ...currentProject,
        flowchartUrl,
        flowchartThumbnailUrl: thumbnailUrl,
      }, isCloudBackedUser)
      : null;

    if (!updatedProject) {
      this.optimisticState.rollbackSnapshot(snapshot.id, false);
      return { success: false, error: '项目不存在' };
    }

    return this.commitProjectUpdateDurably(
      snapshot.id,
      updatedProject,
      '离线项目更新队列未能写入',
      this.replaceProjectUpdater(updatedProject),
    );
  }

  // ========== 冲突解决 ==========

  async resolveConflict(
    projectId: string,
    choice: 'local' | 'remote' | 'merge',
    options: { backgroundPersist?: boolean } = {}
  ): Promise<boolean> {
    return this.projectConflict.resolveConflict(projectId, choice, options);
  }

  async resolveConflictWithPlan(
    projectId: string,
    plan: ConflictResolutionPlan,
    options: { backgroundPersist?: boolean } = {}
  ): Promise<boolean> {
    return this.projectConflict.resolveConflictWithPlan(projectId, plan, options);
  }
}
