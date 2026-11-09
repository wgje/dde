import { Injectable, inject } from '@angular/core';

import type { Project } from '../../../../models';
import { ConflictStorageService } from '../../../../services/conflict-storage.service';
import { LoggerService } from '../../../../services/logger.service';
import {
  resolveRefreshedPendingTaskDeleteBaseUpdatedAtMap,
} from '../../../../services/project-operation-conflict-pending-task-deletes';
import { ProjectStateService } from '../../../../services/project-state.service';
import type { TaskDeleteBaseUpdatedAtMap } from './retry-queue.types';
import { ProjectDataService } from './project-data.service';

export interface TaskDeleteConflictCaptureInput {
  projectId: string;
  taskIds: string[];
  sourceUserId?: string;
  baseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap;
  remoteUpdatedAt?: string | null;
}

@Injectable({ providedIn: 'root' })
export class TaskDeleteConflictCaptureService {
  private readonly logger = inject(LoggerService).category('TaskDeleteConflict');
  private readonly projectState = inject(ProjectStateService);
  private readonly projectData = inject(ProjectDataService);
  private readonly conflictStorage = inject(ConflictStorageService);

  async capture(input: TaskDeleteConflictCaptureInput): Promise<boolean> {
    const taskIds = [...new Set(input.taskIds.filter(taskId => taskId.length > 0))];
    if (taskIds.length === 0) return true;

    const remoteProject = await this.projectData
      .loadFullProjectOptimized(input.projectId)
      .catch(error => {
        this.logger.warn('任务删除冲突远端快照加载失败，先保存本地删除意图', {
          projectId: input.projectId,
          taskIds,
          error,
        });
        return null;
      });
    const localProject = this.resolveLocalProject(input.projectId, taskIds, remoteProject);
    const pendingTaskDeleteBaseUpdatedAtMap = resolveRefreshedPendingTaskDeleteBaseUpdatedAtMap(
      remoteProject,
      taskIds,
      input.baseUpdatedAtMap,
      input.remoteUpdatedAt,
    );

    try {
      return await this.conflictStorage.saveConflict({
        projectId: input.projectId,
        ownerUserId: input.sourceUserId,
        localProject,
        ...(remoteProject ? { remoteProject, remoteSnapshotFresh: true } : { remoteSnapshotFresh: false }),
        conflictedAt: new Date().toISOString(),
        localVersion: localProject.version ?? 0,
        remoteVersion: remoteProject?.version,
        reason: 'version_mismatch',
        pendingTaskDeleteIds: taskIds,
        pendingTaskDeleteBaseUpdatedAtMap,
        acknowledged: false,
      });
    } catch (error) {
      this.logger.error('任务删除冲突持久化失败', {
        projectId: input.projectId,
        taskIds,
        error,
      });
      return false;
    }
  }

  private resolveLocalProject(
    projectId: string,
    taskIds: string[],
    remoteProject: Project | null,
  ): Project {
    const currentProject = this.projectState.getProjectWithCurrentData(projectId);
    if (currentProject) return currentProject;

    if (remoteProject) {
      const deletedTaskIds = new Set(taskIds);
      return {
        ...remoteProject,
        tasks: (remoteProject.tasks ?? []).filter(task => !deletedTaskIds.has(task.id)),
      };
    }

    const now = new Date().toISOString();
    return {
      id: projectId,
      name: '',
      description: '',
      createdDate: now,
      updatedAt: now,
      version: 0,
      tasks: [],
      connections: [],
    };
  }
}
