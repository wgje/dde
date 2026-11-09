/**
 * ProjectSyncOperationsService - 项目同步操作服务
 * 
 * 职责：
 * - 重新同步活动项目
 * - 离线数据重连合并
 * - 项目验证和重平衡
 * 
 * 从 SyncCoordinatorService 提取，作为 Sprint 9 技术债务修复的一部分
 */

import { Injectable, inject } from '@angular/core';
import { ProjectDataService, ProjectSaveFlightCoordinatorService } from '../core-bridge';
import { ConflictResolutionService } from './conflict-resolution.service';
import { ConflictStorageService } from './conflict-storage.service';
import { ProjectStateService } from './project-state.service';
import { AuthService } from './auth.service';
import { ChangeTrackerService } from './change-tracker.service';
import { LayoutService } from './layout.service';
import { ToastService } from './toast.service';
import { LoggerService } from './logger.service';
import { DeltaSyncCoordinatorService } from './delta-sync-coordinator.service';
import { Project } from '../models';
import { Result, success, failure, isFailure, ErrorCodes, OperationError } from '../utils/result';
import { validateProject, sanitizeProject } from '../utils/validation';
import type { TaskTombstones } from './conflict-resolution-merge.helpers';

type ProjectResyncResult = {
  success: boolean;
  message: string;
  conflictDetected?: boolean;
};

type OfflineMergeResult = {
  project?: Project;
  conflictProject?: Project;
  synced: boolean;
};

type OfflineProjectToSync = {
  project: Project;
  reason: string;
  conflictEvidenceFailed?: boolean;
};

const CONFLICT_EVIDENCE_SAVE_FAILED_MESSAGE = '发现冲突，但冲突证据保存失败，本地数据已保留';

@Injectable({
  providedIn: 'root'
})
export class ProjectSyncOperationsService {
  private readonly projectData = inject(ProjectDataService);
  private readonly projectSaveCoordinator = inject(ProjectSaveFlightCoordinatorService);
  private readonly conflictService = inject(ConflictResolutionService);
  private readonly conflictStorage = inject(ConflictStorageService);
  private readonly projectState = inject(ProjectStateService);
  private readonly authService = inject(AuthService);
  private readonly changeTracker = inject(ChangeTrackerService);
  private readonly layoutService = inject(LayoutService);
  private readonly toastService = inject(ToastService);
  private readonly deltaSyncCoordinator = inject(DeltaSyncCoordinatorService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('ProjectSyncOps');

  /**
   * 重新同步当前活动项目
   */
  async resyncActiveProject(
    getTombstoneIds: (projectId: string) => Promise<TaskTombstones>
  ): Promise<ProjectResyncResult> {
    const projectId = this.projectState.activeProjectId();
    const userId = this.authService.currentUserId();
    
    if (!projectId || !userId) {
      return { success: false, message: '无活动项目或未登录' };
    }
    
    const activeProject = this.projectState.activeProject();
    const localProject = this.projectState.getProjectWithCurrentData(projectId)
      ?? (activeProject?.id === projectId ? activeProject : null);
    if (!localProject) {
      return { success: false, message: '本地项目不存在' };
    }
    
    this.logger.info('开始重新同步项目', { projectId });
    
    try {
      const remoteProject = await this.projectData.loadFullProject(projectId, userId);

      if (!remoteProject) {
        return { success: false, message: '云端项目不存在' };
      }

      const tombstoneIds = await getTombstoneIds(projectId);
      const localVersion = localProject.version ?? 0;
      const remoteVersion = remoteProject.version ?? 0;

      if (localVersion === remoteVersion) {
        return await this.applySameVersionResync(projectId, localProject, remoteProject, tombstoneIds);
      }

      if (remoteVersion > localVersion) {
        return await this.applyRemoteNewerResync(projectId, localProject, remoteProject, tombstoneIds);
      }
      
      return await this.pushLocalNewerProject(projectId, userId, localProject);

    } catch (error) {
      this.logger.error('重新同步失败', error);
      return { success: false, message: '同步时发生错误' };
    }
  }

  private async applySameVersionResync(
    projectId: string,
    localProject: Project,
    remoteProject: Project,
    tombstoneIds: TaskTombstones,
  ): Promise<ProjectResyncResult> {
    const mergeResult = this.conflictService.smartMerge(localProject, remoteProject, tombstoneIds);
    if (mergeResult.conflictCount > 0) {
      const conflictPersisted = await this.saveConflictSilently(localProject, remoteProject, mergeResult.issues);
      if (!conflictPersisted) {
        return this.createConflictEvidenceSaveFailedResult(projectId, mergeResult.conflictCount);
      }
    }

    this.updateProjectInState(projectId, mergeResult.project);
    return {
      success: true,
      message: mergeResult.conflictCount > 0
        ? `已合并，${mergeResult.conflictCount} 处冲突已保存供稍后处理`
        : '数据已是最新',
      conflictDetected: mergeResult.conflictCount > 0,
    };
  }

  private async applyRemoteNewerResync(
    projectId: string,
    localProject: Project,
    remoteProject: Project,
    tombstoneIds: TaskTombstones,
  ): Promise<ProjectResyncResult> {
    const mergeResult = this.conflictService.smartMerge(localProject, remoteProject, tombstoneIds);
    if (mergeResult.conflictCount > 0) {
      const conflictPersisted = await this.saveConflictSilently(localProject, remoteProject, mergeResult.issues);
      if (!conflictPersisted) {
        return this.createConflictEvidenceSaveFailedResult(projectId, mergeResult.conflictCount);
      }
      this.logger.info('检测到冲突，已保存到冲突仓库', {
        projectId,
        conflictCount: mergeResult.conflictCount
      });
    }

    this.updateProjectInState(projectId, mergeResult.project);
    this.changeTracker.clearProjectFieldLocks(projectId);
    return {
      success: true,
      message: mergeResult.conflictCount > 0
        ? `已合并，${mergeResult.conflictCount} 处冲突已保存供稍后处理`
        : '已与云端同步',
      conflictDetected: mergeResult.conflictCount > 0
    };
  }

  private async pushLocalNewerProject(
    projectId: string,
    userId: string,
    localProject: Project,
  ): Promise<ProjectResyncResult> {
    const saveResult = await this.projectSaveCoordinator.save(localProject, userId);
    if (saveResult.success) {
      this.changeTracker.clearProjectFieldLocks(projectId);
      return { success: true, message: '本地更改已推送到云端' };
    }

    if (!saveResult.conflict) {
      return { success: false, message: '同步失败' };
    }

    if (saveResult.remoteData) {
      const conflictPersisted = await this.saveConflictSilently(localProject, saveResult.remoteData, []);
      if (!conflictPersisted) {
        return this.createConflictEvidenceSaveFailedResult(projectId, 1);
      }
    } else {
      return this.createConflictEvidenceSaveFailedResult(projectId, 1);
    }
    return {
      success: false,
      message: '发现版本冲突，已保存到冲突仓库',
      conflictDetected: true
    };
  }

  private updateProjectInState(projectId: string, project: Project): void {
    const validated = this.validateAndRebalance(project);
    this.projectState.updateProjects(ps =>
      ps.map(p => p.id === projectId ? validated : p)
    );
  }

  /**
   * 离线数据重连合并
   */
  async mergeOfflineDataOnReconnect(
    cloudProjects: Project[], 
    offlineProjects: Project[],
    userId: string,
    getTombstoneIds: (projectId: string) => Promise<TaskTombstones>,
    onConflict: (local: Project, remote: Project) => void
  ): Promise<{ projects: Project[]; syncedCount: number; conflictProjects: Project[] }> {
    const cloudMap = new Map(cloudProjects.map(p => [p.id, p]));
    const mergedProjects: Project[] = [...cloudProjects];
    const conflictProjects: Project[] = [];
    let syncedCount = 0;
    
    for (const offlineProject of offlineProjects) {
      const cloudProject = cloudMap.get(offlineProject.id);

      if (!cloudProject) {
        const mergeResult = await this.syncNewOfflineProject(offlineProject, userId);
        if (mergeResult.project) mergedProjects.push(mergeResult.project);
        if (mergeResult.synced) syncedCount++;
        continue;
      }

      const mergeResult = await this.syncExistingOfflineProject(
        offlineProject,
        cloudProject,
        userId,
        getTombstoneIds,
        onConflict,
      );
      if (mergeResult.project) {
        this.replaceMergedProject(mergedProjects, offlineProject.id, mergeResult.project);
      }
      if (mergeResult.conflictProject) conflictProjects.push(mergeResult.conflictProject);
      if (mergeResult.synced) syncedCount++;
    }
    
    return { projects: mergedProjects, syncedCount, conflictProjects };
  }

  private async syncNewOfflineProject(
    offlineProject: Project,
    userId: string,
  ): Promise<OfflineMergeResult> {
    const result = await this.projectSaveCoordinator.save(offlineProject, userId);
    if (!result.success) {
      return { synced: false };
    }

    this.logger.info('离线新建项目已同步:', offlineProject.name);
    return {
      project: { ...offlineProject, version: result.newVersion ?? offlineProject.version },
      synced: true,
    };
  }

  private async syncExistingOfflineProject(
    offlineProject: Project,
    cloudProject: Project,
    userId: string,
    getTombstoneIds: (projectId: string) => Promise<TaskTombstones>,
    onConflict: (local: Project, remote: Project) => void,
  ): Promise<OfflineMergeResult> {
    const offlineVersion = offlineProject.version ?? 0;
    const cloudVersion = cloudProject.version ?? 0;
    const projectToSync = await this.selectOfflineProjectToSync(
      offlineProject,
      cloudProject,
      getTombstoneIds,
    );
    if (!projectToSync) {
      return { synced: false };
    }

    if (projectToSync.conflictEvidenceFailed) {
      this.logger.warn('离线同版本合并冲突证据保存失败，跳过云端推送', {
        projectId: offlineProject.id,
      });
      onConflict(offlineProject, cloudProject);
      return { conflictProject: offlineProject, synced: false };
    }

    const projectWithVersion = {
      ...projectToSync.project,
      version: Math.max(offlineVersion, cloudVersion) + 1
    };
    this.logger.info('同步离线修改', {
      projectId: offlineProject.id,
      reason: projectToSync.reason,
      offlineVersion,
      cloudVersion
    });

    const result = await this.projectSaveCoordinator.save(projectWithVersion, userId);
    if (result.success) {
      this.logger.info('离线修改已同步:', offlineProject.name);
      return {
        project: { ...projectWithVersion, version: result.newVersion ?? projectWithVersion.version },
        synced: true,
      };
    }

    if (result.conflict) {
      this.logger.warn('离线数据存在冲突', { projectName: offlineProject.name });
      onConflict(offlineProject, result.remoteData!);
      return { conflictProject: offlineProject, synced: false };
    }

    return { synced: false };
  }

  private async selectOfflineProjectToSync(
    offlineProject: Project,
    cloudProject: Project,
    getTombstoneIds: (projectId: string) => Promise<TaskTombstones>,
  ): Promise<OfflineProjectToSync | null> {
    const offlineVersion = offlineProject.version ?? 0;
    const cloudVersion = cloudProject.version ?? 0;
    if (offlineVersion > cloudVersion) {
      return { project: offlineProject, reason: '版本号更高' };
    }

    if (offlineVersion !== cloudVersion) {
      return null;
    }

    return await this.selectSameVersionOfflineProjectToSync(offlineProject, cloudProject, getTombstoneIds);
  }

  private async selectSameVersionOfflineProjectToSync(
    offlineProject: Project,
    cloudProject: Project,
    getTombstoneIds: (projectId: string) => Promise<TaskTombstones>,
  ): Promise<OfflineProjectToSync | null> {
    const hasContentDiff = this.deltaSyncCoordinator.hasProjectContentDifference(offlineProject, cloudProject);
    if (!hasContentDiff) {
      return null;
    }

    const offlineTime = new Date(offlineProject.updatedAt || 0).getTime();
    const cloudTime = new Date(cloudProject.updatedAt || 0).getTime();
    if (offlineTime >= cloudTime) {
      return { project: offlineProject, reason: '本地有未同步的修改' };
    }

    this.logger.info('检测到本地修改可能被覆盖', {
      projectId: offlineProject.id,
      offlineTime: new Date(offlineTime).toISOString(),
      cloudTime: new Date(cloudTime).toISOString()
    });
    const tombstoneIds = await getTombstoneIds(offlineProject.id);
    const mergeResult = this.conflictService.smartMerge(offlineProject, cloudProject, tombstoneIds);
    if (mergeResult.conflictCount > 0) {
      const conflictPersisted = await this.saveConflictSilently(
        offlineProject,
        cloudProject,
        mergeResult.issues,
      );
      if (!conflictPersisted) {
        return {
          project: offlineProject,
          reason: '冲突证据保存失败',
          conflictEvidenceFailed: true,
        };
      }
    }
    return { project: mergeResult.project, reason: '智能合并本地和云端修改' };
  }

  private replaceMergedProject(projects: Project[], projectId: string, project: Project): void {
    const idx = projects.findIndex(p => p.id === projectId);
    if (idx !== -1) {
      projects[idx] = project;
    }
  }

  /**
   * 验证并重新平衡项目（Result 版本）
   */
  validateAndRebalanceWithResult(project: Project): Result<Project, OperationError> {
    const validation = validateProject(project);
    
    const fatalErrors = validation.errors.filter(e =>
      e.includes('项目 ID 无效或缺失') ||
      e.includes('项目任务列表必须是数组')
    );
    
    if (fatalErrors.length > 0) {
      this.logger.error('项目数据致命错误，无法恢复', { 
        projectId: project.id, 
        fatalErrors 
      });
      return failure(
        ErrorCodes.VALIDATION_ERROR,
        `项目数据损坏无法修复: ${fatalErrors.join('; ')}`,
        { projectId: project.id, errors: fatalErrors }
      );
    }
    
    if (!validation.valid) {
      this.logger.warn('项目数据验证失败，尝试清理修复', { 
        projectId: project.id, 
        errors: validation.errors 
      });
      project = sanitizeProject(project);
      
      const revalidation = validateProject(project);
      if (!revalidation.valid) {
        this.logger.error('清理后数据仍然无效', { errors: revalidation.errors });
        return failure(
          ErrorCodes.VALIDATION_ERROR,
          `项目数据清理后仍然无效: ${revalidation.errors.join('; ')}`,
          { projectId: project.id, errors: revalidation.errors }
        );
      }
    }
    
    if (validation.warnings.length > 0) {
      this.logger.warn('项目数据警告', { projectId: project.id, warnings: validation.warnings });
    }
    
    const { project: fixedProject, issues } = this.layoutService.validateAndFixTree(project);
    if (issues.length > 0) {
      this.logger.info('已修复数据问题', { projectId: project.id, issues });
    }
    
    return success(this.layoutService.rebalance(fixedProject));
  }

  /**
   * 验证并重新平衡项目（简化版）
   */
  validateAndRebalance(project: Project): Project {
    const result = this.validateAndRebalanceWithResult(project);
    if (isFailure(result)) {
      const errorMsg = result.error.message;
      this.logger.error('validateAndRebalance 失败', { error: errorMsg });
      this.toastService.error('数据验证失败', errorMsg);
      return sanitizeProject(project);
    }
    return result.value;
  }

  /**
   * 静默保存冲突到仓库
   */
  private async saveConflictSilently(
    localProject: Project, 
    remoteProject: Project,
    conflictedFields: string[]
  ): Promise<boolean> {
    try {
      return await this.conflictStorage.saveConflict({
        projectId: localProject.id,
        localProject,
        remoteProject,
        remoteSnapshotFresh: true,
        conflictedAt: new Date().toISOString(),
        localVersion: localProject.version ?? 0,
        remoteVersion: remoteProject.version ?? 0,
        reason: 'version_mismatch',
        conflictedFields,
        acknowledged: false
      });
    } catch (error) {
      this.logger.error('保存冲突证据失败', { projectId: localProject.id, error });
      return false;
    }
  }

  private createConflictEvidenceSaveFailedResult(
    projectId: string,
    conflictCount: number,
  ): ProjectResyncResult {
    this.logger.warn('冲突证据保存失败，保留本地项目状态', { projectId, conflictCount });
    return {
      success: false,
      message: CONFLICT_EVIDENCE_SAVE_FAILED_MESSAGE,
      conflictDetected: true,
    };
  }
}
