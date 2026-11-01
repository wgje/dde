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

interface ProjectOperationSessionContext {
  sessionGeneration: number;
  userId: string | null;
}

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

  private captureSessionContext(): ProjectOperationSessionContext {
    return {
      sessionGeneration: this.userSession.getCurrentSessionGeneration(),
      userId: this.userSession.currentUserId(),
    };
  }

  private isSessionContextCurrent(context: ProjectOperationSessionContext): boolean {
    return this.userSession.isSessionContextCurrent(context.sessionGeneration, context.userId);
  }

  private discardStaleProjectOperation(
    snapshotId: string,
  ): { success: false; error: string } {
    this.optimisticState.discardSnapshot(snapshotId);
    return { success: false, error: '会话已切换' };
  }

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

  private currentProjects(): Project[] {
    return this.projectState.getProjectsWithCurrentData();
  }

  private async commitProjectUpdateDurably(
    snapshotId: string,
    project: Project,
    queueErrorMessage: string,
    sessionContext: ProjectOperationSessionContext,
    updateProjects?: (projects: Project[]) => Project[],
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.isSessionContextCurrent(sessionContext)) {
      return this.discardStaleProjectOperation(snapshotId);
    }

    const nextProjects = updateProjects?.(this.currentProjects());
    const failure = await this.prepareProjectUpdateCommit(
      snapshotId,
      project,
      queueErrorMessage,
      sessionContext,
      nextProjects,
    );
    if (failure) {
      return failure;
    }

    if (!this.isSessionContextCurrent(sessionContext)) {
      return this.discardStaleProjectOperation(snapshotId);
    }
    if (updateProjects) {
      this.projectState.updateProjects(updateProjects);
    }
    this.finalizeDurableLocalProjectMutation(snapshotId);
    return { success: true };
  }

  private async prepareProjectUpdateCommit(
    snapshotId: string,
    project: Project,
    queueErrorMessage: string,
    sessionContext: ProjectOperationSessionContext,
    nextProjects: Project[] | undefined,
  ): Promise<{ success: false; error: string } | null> {
    const userId = sessionContext.userId;
    const isCloudBackedUser = !!userId && userId !== AUTH_CONFIG.LOCAL_MODE_USER_ID;
    if (!isCloudBackedUser) {
      return nextProjects
        ? this.persistProjectSnapshotBeforeCommit(snapshotId, nextProjects, sessionContext)
        : null;
    }

    const actionId = await this.actionQueue.enqueueDurably({
      type: 'update',
      entityType: 'project',
      entityId: project.id,
      payload: {
        project: { ...project, syncSource: 'synced', pendingSync: true },
        sourceUserId: userId,
      },
    });
    if (!this.isSessionContextCurrent(sessionContext)) {
      return this.discardStaleProjectOperation(snapshotId);
    }
    if (!actionId) {
      this.optimisticState.rollbackSnapshot(snapshotId, false);
      this.toastService.error('本地保存失败', `${queueErrorMessage}，请释放浏览器存储空间后重试`);
      this.projectData.saveOfflineSnapshot(this.currentProjects());
      return { success: false, error: queueErrorMessage };
    }

    return nextProjects
      ? this.persistProjectSnapshotBeforeCommit(
        snapshotId,
        nextProjects,
        sessionContext,
        { queuedActionId: actionId },
      )
      : null;
  }

  private findProject(projectId: string): Project | null {
    return this.projectState.getProjectWithCurrentData(projectId) ?? null;
  }

  private replaceProjectUpdater(project: Project): (projects: Project[]) => Project[] {
    return projects => projects.map(current =>
      current.id === project.id ? project : current
    );
  }

  private buildDeleteQueueAction(projectId: string, userId: string | null): EnqueueParams {
    const projectToDelete = this.findProject(projectId);
    return {
      type: 'delete',
      entityType: 'project',
      entityId: projectId,
      payload: {
        projectId,
        userId: userId ?? AUTH_CONFIG.LOCAL_MODE_USER_ID,
        sourceUserId: userId ?? undefined,
        baseUpdatedAt: projectToDelete?.updatedAt ?? null,
      },
    };
  }

  private async persistProjectSnapshotBeforeCommit(
    snapshotId: string,
    nextProjects: Project[],
    sessionContext: ProjectOperationSessionContext,
    options: { queuedActionId?: string; canPublishUi?: () => boolean } = {},
  ): Promise<{ success: false; error: string } | null> {
    if (!this.isSessionContextCurrent(sessionContext)) {
      return this.discardStaleProjectOperation(snapshotId);
    }

    try {
      await this.projectData.saveOfflineSnapshotAndWait(nextProjects);
      if (!this.isSessionContextCurrent(sessionContext)) {
        return this.discardStaleProjectOperation(snapshotId);
      }
      return null;
    } catch {
      if (!this.isSessionContextCurrent(sessionContext)) {
        return this.discardStaleProjectOperation(snapshotId);
      }
      this.discardQueuedAction(options.queuedActionId);
      if (options.canPublishUi?.() === false) this.optimisticState.discardSnapshot(snapshotId);
      else {
        this.optimisticState.rollbackSnapshot(snapshotId, false);
        this.toastService.error('本地保存失败', '离线快照未能写入，请释放浏览器存储空间后重试');
      }
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
    this.projectData.saveOfflineSnapshot(this.currentProjects());
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

    const sessionContext = this.captureSessionContext();
    const balanced = this.layoutService.rebalance(project);
    const userId = sessionContext.userId;
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
    const nextProjects = addProjectUpdater(this.currentProjects());
    let actionId = '';
    if (isCloudBackedUser) {
      actionId = await this.actionQueue.enqueueDurably(createQueueAction);
      if (!this.isSessionContextCurrent(sessionContext)) {
        return this.discardStaleProjectOperation(snapshot.id);
      }
      if (!actionId) {
        this.optimisticState.rollbackSnapshot(snapshot.id, false);
        this.toastService.error('本地保存失败', '离线同步队列未能写入，请释放浏览器存储空间后重试');
        return { success: false, error: '离线同步队列未能写入' };
      }
    }

    const snapshotFailure = await this.persistProjectSnapshotBeforeCommit(
      snapshot.id,
      nextProjects,
      sessionContext,
      { queuedActionId: isCloudBackedUser ? actionId : undefined },
    );
    if (snapshotFailure) {
      return snapshotFailure;
    }

    if (!this.isSessionContextCurrent(sessionContext)) {
      return this.discardStaleProjectOperation(snapshot.id);
    }
    this.projectState.updateProjects(addProjectUpdater);
    this.projectState.setActiveProjectId(localProject.id);
    this.finalizeDurableLocalProjectMutation(snapshot.id);
    return { success: true };
  }

  /**
   * 删除项目
   */
  async deleteProject(
    projectId: string,
    options: { canPublishUi?: () => boolean } = {},
  ): Promise<{ success: boolean; error?: string }> {
    const blocked = this.blockProjectMutation('删除项目');
    if (blocked) return blocked;

    const sessionContext = this.captureSessionContext();
    const userId = sessionContext.userId;
    const isCloudBackedUser = !!userId && userId !== AUTH_CONFIG.LOCAL_MODE_USER_ID;
    const deleteQueueAction = this.buildDeleteQueueAction(projectId, userId);
    
    // 创建快照（乐观更新前）
    const snapshot = this.optimisticState.createSnapshot('project-delete', '删除项目');
    const deleteProjectUpdater = (projects: Project[]) => projects.filter(project => project.id !== projectId);
    const remainingProjects = deleteProjectUpdater(this.currentProjects());
    
    let actionId = '';
    if (isCloudBackedUser) {
      actionId = await this.actionQueue.enqueueDurably(deleteQueueAction);
      if (!this.isSessionContextCurrent(sessionContext)) {
        return this.discardStaleProjectOperation(snapshot.id);
      }
      if (!actionId) {
        if (options.canPublishUi?.() === false) this.optimisticState.discardSnapshot(snapshot.id);
        else {
          this.optimisticState.rollbackSnapshot(snapshot.id, false);
          this.toastService.error('本地保存失败', '离线删除队列未能写入，请释放浏览器存储空间后重试');
        }
        this.projectData.saveOfflineSnapshot(this.currentProjects());
        return { success: false, error: '离线删除队列未能写入' };
      }
    }

    const snapshotFailure = await this.persistProjectSnapshotBeforeCommit(
      snapshot.id,
      remainingProjects,
      sessionContext,
      { queuedActionId: isCloudBackedUser ? actionId : undefined, canPublishUi: options.canPublishUi },
    );
    if (snapshotFailure) {
      return snapshotFailure;
    }

    if (!this.isSessionContextCurrent(sessionContext)) {
      return this.discardStaleProjectOperation(snapshot.id);
    }
    this.projectState.updateProjects(deleteProjectUpdater);

    if (this.projectState.activeProjectId() === projectId) {
      this.projectState.setActiveProjectId(deleteProjectUpdater(this.currentProjects())[0]?.id ?? null);
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

    const sessionContext = this.captureSessionContext();
    const snapshot = this.optimisticState.createSnapshot('project-update', '保存项目设置');
    const userId = sessionContext.userId;
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
      sessionContext,
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

    const sessionContext = this.captureSessionContext();
    const snapshot = this.optimisticState.createSnapshot('project-update', '重命名项目');
    const userId = sessionContext.userId;
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
      sessionContext,
      this.replaceProjectUpdater(updatedProject),
    );
    return result.success;
  }

  async upsertImportedProject(project: Project): Promise<{ success: boolean; error?: string }> {
    const blocked = this.blockProjectMutation('导入项目');
    if (blocked) return blocked;

    const sessionContext = this.captureSessionContext();
    const snapshot = this.optimisticState.createSnapshot('project-import', '导入项目');
    const userId = sessionContext.userId;
    const isCloudBackedUser = !!userId && userId !== AUTH_CONFIG.LOCAL_MODE_USER_ID;
    const existingProject = this.projectState.getProjectWithCurrentData(project.id);
    const localProject = this.buildLocalProjectForUser(project, isCloudBackedUser);

    if (!isCloudBackedUser || !userId) {
      return this.persistImportedLocalProject(snapshot.id, localProject, sessionContext);
    }

    return this.persistImportedCloudProject(
      snapshot.id,
      localProject,
      !!existingProject,
      userId,
      sessionContext,
    );
  }

  private async persistImportedLocalProject(
    snapshotId: string,
    localProject: Project,
    sessionContext: ProjectOperationSessionContext,
  ): Promise<{ success: boolean; error?: string }> {
    const upsertProjectUpdater = (projects: Project[]) => this.upsertProjectList(projects, localProject);
    const failure = await this.persistProjectSnapshotBeforeCommit(
      snapshotId,
      upsertProjectUpdater(this.currentProjects()),
      sessionContext,
    );
    if (failure) {
      return failure;
    }
    if (!this.isSessionContextCurrent(sessionContext)) {
      return this.discardStaleProjectOperation(snapshotId);
    }
    this.projectState.updateProjects(upsertProjectUpdater);
    this.finalizeDurableLocalProjectMutation(snapshotId);
    return { success: true };
  }

  private async persistImportedCloudProject(
    snapshotId: string,
    localProject: Project,
    hasExistingProject: boolean,
    userId: string,
    sessionContext: ProjectOperationSessionContext,
  ): Promise<{ success: boolean; error?: string }> {
    const importQueueAction: EnqueueParams = {
      type: hasExistingProject ? 'update' : 'create',
      entityType: 'project',
      entityId: localProject.id,
      payload: {
        project: { ...localProject, syncSource: 'synced', pendingSync: true },
        sourceUserId: userId,
      }
    };

    const actionId = await this.actionQueue.enqueueDurably(importQueueAction);
    if (!this.isSessionContextCurrent(sessionContext)) {
      return this.discardStaleProjectOperation(snapshotId);
    }
    if (!actionId) {
      this.optimisticState.rollbackSnapshot(snapshotId, false);
      this.toastService.error('本地保存失败', '离线导入队列未能写入，请释放浏览器存储空间后重试');
      this.projectData.saveOfflineSnapshot(this.currentProjects());
      return { success: false, error: '离线导入队列未能写入' };
    }
    const snapshotFailure = await this.persistProjectSnapshotBeforeCommit(
      snapshotId,
      this.upsertProjectList(this.currentProjects(), localProject),
      sessionContext,
      { queuedActionId: actionId },
    );
    if (snapshotFailure) {
      return snapshotFailure;
    }

    if (!this.isSessionContextCurrent(sessionContext)) {
      return this.discardStaleProjectOperation(snapshotId);
    }
    this.upsertLocalProject(localProject);
    this.finalizeDurableLocalProjectMutation(snapshotId);
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

    const sessionContext = this.captureSessionContext();
    const snapshot = this.optimisticState.createSnapshot('project-update', '更新流程图');
    const userId = sessionContext.userId;
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
      sessionContext,
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
