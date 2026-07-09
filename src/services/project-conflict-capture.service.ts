import { Injectable, inject } from '@angular/core';
import { SyncCoordinatorService } from './sync-coordinator.service';
import { ConflictStorageService } from './conflict-storage.service';
import { UserSessionService } from './user-session.service';
import { LoggerService } from './logger.service';
import { Project } from '../models';
import type { TaskDeleteBaseUpdatedAtMap } from './action-queue.types';

type ProjectSessionContext = {
  ownerUserId: string | null;
  sessionGeneration: number;
};

@Injectable({ providedIn: 'root' })
export class ProjectConflictCaptureService {
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('ProjectOps');
  private readonly syncCoordinator = inject(SyncCoordinatorService);
  private readonly conflictStorage = inject(ConflictStorageService);
  private readonly userSession = inject(UserSessionService);

  async captureConflictWithRemoteFallback(
    localProject: Project,
    remoteProject?: Project,
    fallbackRemoteProject?: Project,
    sessionContext?: ProjectSessionContext,
    pendingTaskDeleteIds?: string[],
    pendingTaskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap,
  ): Promise<boolean> {
    if (!this.isSessionCurrent(sessionContext, 'captureConflict:start', localProject.id)) {
      return false;
    }

    if (remoteProject) {
      await this.captureRemoteConflict(localProject, remoteProject, sessionContext, pendingTaskDeleteIds, pendingTaskDeleteBaseUpdatedAtMap);
      return true;
    }

    const resolvedRemoteProject = await this.tryLoadRemoteConflictProject(
      localProject.id,
      localProject,
      sessionContext,
      pendingTaskDeleteIds,
      pendingTaskDeleteBaseUpdatedAtMap,
    );
    if (!this.isSessionCurrent(sessionContext, 'captureConflict:resolved-remote', localProject.id)) {
      return false;
    }

    if (resolvedRemoteProject) {
      await this.captureRemoteConflict(
        localProject,
        resolvedRemoteProject,
        sessionContext,
        pendingTaskDeleteIds,
        pendingTaskDeleteBaseUpdatedAtMap,
      );
      return true;
    }

    await this.saveFallbackConflict(
      localProject,
      fallbackRemoteProject,
      sessionContext,
      pendingTaskDeleteIds,
      pendingTaskDeleteBaseUpdatedAtMap,
    );
    if (!this.isSessionCurrent(sessionContext, 'captureConflict:fallback-saved', localProject.id)) {
      return false;
    }
    this.syncCoordinator.clearActiveConflict();
    return true;
  }

  private async captureRemoteConflict(
    localProject: Project,
    remoteProject: Project,
    sessionContext: ProjectSessionContext | undefined,
    pendingTaskDeleteIds: string[] | undefined,
    pendingTaskDeleteBaseUpdatedAtMap: TaskDeleteBaseUpdatedAtMap | undefined,
  ): Promise<void> {
    await this.syncCoordinator.captureConflict(
      localProject,
      remoteProject,
      sessionContext?.ownerUserId,
      pendingTaskDeleteIds,
      pendingTaskDeleteBaseUpdatedAtMap,
    );
  }

  async tryLoadRemoteConflictProject(
    projectId: string,
    localProject: Project,
    sessionContext?: ProjectSessionContext,
    pendingTaskDeleteIds?: string[],
    pendingTaskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap,
  ): Promise<Project | undefined> {
    try {
      const remoteProject = await this.syncCoordinator.loadSingleProjectFromCloud(projectId);
      if (!this.isSessionCurrent(sessionContext, 'tryLoadRemoteConflictProject:load-remote', projectId)) {
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
          pendingTaskDeleteIds,
          pendingTaskDeleteBaseUpdatedAtMap,
          acknowledged: false,
        });
        return remoteProject;
      }
    } catch (_error) {
      // 远端快照获取失败时保留当前冲突记录，稍后由用户重试。
    }

    return undefined;
  }

  private async saveFallbackConflict(
    localProject: Project,
    fallbackRemoteProject: Project | undefined,
    sessionContext: ProjectSessionContext | undefined,
    pendingTaskDeleteIds: string[] | undefined,
    pendingTaskDeleteBaseUpdatedAtMap: TaskDeleteBaseUpdatedAtMap | undefined,
  ): Promise<void> {
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
      pendingTaskDeleteIds,
      pendingTaskDeleteBaseUpdatedAtMap,
      acknowledged: false,
    });
  }

  private isSessionCurrent(
    context: ProjectSessionContext | undefined,
    stage: string,
    projectId: string,
  ): boolean {
    if (!context || this.userSession.isSessionContextCurrent(context.sessionGeneration, context.ownerUserId)) {
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
}
