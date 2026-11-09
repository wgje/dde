import { Injectable, inject } from '@angular/core';
import { SyncCoordinatorService } from './sync-coordinator.service';
import { ConflictStorageService } from './conflict-storage.service';
import { UserSessionService } from './user-session.service';
import { AuthService } from './auth.service';
import { LoggerService } from './logger.service';
import { Project } from '../models';
import type { TaskDeleteBaseUpdatedAtMap } from './action-queue.types';
import type { ProjectConflictHandler } from './action-queue-project-processors.types';

type ProjectSessionContext = {
  ownerUserId: string | null;
  sessionGeneration: number;
  authFence?: string;
};

export interface ActionQueueConflictCaptureInput {
  localProject: Project;
  ownerUserId: string;
  pendingTaskDeleteIds?: string[];
  pendingTaskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap;
  isCurrent: () => boolean;
  loadRemoteProject: () => Promise<Project | null>;
  remoteHandler: ProjectConflictHandler | null;
}

export async function captureActionQueueConflict(
  input: ActionQueueConflictCaptureInput,
  deps: {
    saveConflict: ConflictStorageService['saveConflict'];
    warn: (title: string, message: string) => void;
  },
): Promise<boolean> {
  const remoteProject = await input.loadRemoteProject().catch(() => null);
  if (!input.isCurrent()) return true;
  if (remoteProject && input.remoteHandler) {
    input.remoteHandler(
      input.localProject,
      remoteProject,
      input.ownerUserId,
      input.pendingTaskDeleteIds,
      input.pendingTaskDeleteBaseUpdatedAtMap,
    );
    return true;
  }

  await deps.saveConflict({
    projectId: input.localProject.id,
    localProject: input.localProject,
    remoteProject: remoteProject ?? undefined,
    ownerUserId: input.ownerUserId,
    remoteSnapshotFresh: remoteProject ? true : undefined,
    conflictedAt: new Date().toISOString(),
    localVersion: input.localProject.version ?? 0,
    remoteVersion: remoteProject?.version,
    reason: 'version_mismatch',
    pendingTaskDeleteIds: input.pendingTaskDeleteIds,
    pendingTaskDeleteBaseUpdatedAtMap: input.pendingTaskDeleteBaseUpdatedAtMap,
    acknowledged: false,
  });
  deps.warn(
    '检测到数据冲突',
    remoteProject
      ? '已补拉远端版本，冲突详情已转入冲突中心'
      : '远端详情暂不可用，已转入冲突中心等待处理',
  );
  return true;
}

@Injectable({ providedIn: 'root' })
export class ProjectConflictCaptureService {
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('ProjectOps');
  private readonly syncCoordinator = inject(SyncCoordinatorService);
  private readonly conflictStorage = inject(ConflictStorageService);
  private readonly userSession = inject(UserSessionService);
  private readonly auth = inject(AuthService);

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
      return this.isSessionCurrent(sessionContext, 'captureConflict:remote-saved', localProject.id);
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
      return this.isSessionCurrent(sessionContext, 'captureConflict:loaded-remote-saved', localProject.id);
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
    if (!this.isSessionCurrent(sessionContext, 'captureConflict:before-remote-save', localProject.id)) return;
    await this.syncCoordinator.captureConflict(
      localProject,
      remoteProject,
      sessionContext?.ownerUserId,
      pendingTaskDeleteIds,
      pendingTaskDeleteBaseUpdatedAtMap,
      () => this.isSessionCurrent(sessionContext, 'captureConflict:nested-effect', localProject.id),
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
        if (!this.isSessionCurrent(sessionContext, 'tryLoadRemoteConflictProject:before-save', projectId)) {
          return undefined;
        }
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
        if (!this.isSessionCurrent(sessionContext, 'tryLoadRemoteConflictProject:after-save', projectId)) {
          return undefined;
        }
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
    if (!this.isSessionCurrent(sessionContext, 'captureConflict:before-fallback-save', localProject.id)) return;
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
    const authCurrent = !context?.authFence || (
      this.auth.currentUserId() === context.ownerUserId
      && this.auth.captureAuthIdentityFence() === context.authFence
    );
    if (!context || (authCurrent
      && this.userSession.isSessionContextCurrent(context.sessionGeneration, context.ownerUserId))) {
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
