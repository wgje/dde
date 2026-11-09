import { Injectable, inject } from '@angular/core';
import { Subject } from 'rxjs';
import { Project } from '../models';
import { ProjectDataService, SyncStateService, type SyncConflictData } from '../core-bridge';
import { ConflictResolutionService } from './conflict-resolution.service';
import { ConflictStorageService } from './conflict-storage.service';
import { type ConflictResolutionPlan } from './conflict-resolution.types';
import { LoggerService } from './logger.service';
import { Result, OperationError } from '../utils/result';
import { buildConflictSnapshotSignature } from './sync-coordinator-signatures';
import type { TaskDeleteBaseUpdatedAtMap } from './action-queue.types';
import type { OperationConflictRecord } from './conflict-storage.helpers';
import type { TaskTombstones } from './conflict-resolution-merge.helpers';

/**
 * 冲突事件数据
 * 用于发布-订阅模式的冲突通知
 */
export interface ConflictEvent {
  localProject: Project;
  remoteProject: Project;
  projectId: string;
  pendingTaskDeleteIds?: string[];
  pendingTaskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap;
  operationConflicts?: OperationConflictRecord[];
}

@Injectable({ providedIn: 'root' })
export class SyncCoordinatorConflictService {
  private readonly logger = inject(LoggerService).category('SyncCoordinatorConflict');
  private readonly conflictStorage = inject(ConflictStorageService);
  private readonly conflictService = inject(ConflictResolutionService);
  private readonly syncStateService = inject(SyncStateService);
  private readonly projectData = inject(ProjectDataService);

  private readonly conflict$ = new Subject<ConflictEvent>();
  readonly onConflict$ = this.conflict$.asObservable();

  async saveConflictSilently(
    localProject: Project,
    remoteProject: Project | undefined,
    conflictedFields: string[],
    ownerUserId?: string | null,
    pendingTaskDeleteIds?: string[],
    pendingTaskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap,
    conflictedAt?: string,
  ): Promise<boolean> {
    return await this.conflictStorage.saveConflict({
      projectId: localProject.id,
      localProject,
      remoteProject,
      ownerUserId: ownerUserId ?? undefined,
      remoteSnapshotFresh: !!remoteProject,
      conflictedAt: conflictedAt ?? new Date().toISOString(),
      localVersion: localProject.version ?? 0,
      remoteVersion: remoteProject?.version ?? 0,
      reason: 'version_mismatch',
      conflictedFields,
      pendingTaskDeleteIds,
      pendingTaskDeleteBaseUpdatedAtMap,
      acknowledged: false,
    });
  }

  async publishConflict(
    localProject: Project,
    remoteProject: Project,
    ownerUserId?: string | null,
    pendingTaskDeleteIds?: string[],
    pendingTaskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap,
    isCurrent?: () => boolean,
  ): Promise<void> {
    if (isCurrent?.() === false) return;
    const activeConflict = this.syncStateService.syncState().conflictData;
    if (this.isDuplicateActiveConflict(
      activeConflict,
      localProject,
      remoteProject,
      pendingTaskDeleteIds,
      pendingTaskDeleteBaseUpdatedAtMap,
    )) {
      try {
        await this.saveConflictSilently(
          localProject,
          remoteProject,
          [],
          ownerUserId,
          pendingTaskDeleteIds,
          pendingTaskDeleteBaseUpdatedAtMap,
          activeConflict?.conflictedAt,
        );
        if (isCurrent?.() === false) return;
      } catch (error) {
        this.logger.warn('保存重复冲突隔离区记录失败', { error, projectId: localProject.id });
      }
      this.logger.debug('跳过重复冲突发布', { projectId: localProject.id });
      return;
    }

    await this.publishNewConflict(
      localProject,
      remoteProject,
      ownerUserId,
      pendingTaskDeleteIds,
      pendingTaskDeleteBaseUpdatedAtMap,
      isCurrent,
    );
  }

  private async publishNewConflict(
    localProject: Project,
    remoteProject: Project,
    ownerUserId: string | null | undefined,
    pendingTaskDeleteIds: string[] | undefined,
    pendingTaskDeleteBaseUpdatedAtMap: TaskDeleteBaseUpdatedAtMap | undefined,
    isCurrent?: () => boolean,
  ): Promise<void> {
    if (isCurrent?.() === false) return;
    const conflictedAt = new Date().toISOString();
    let saved = false;
    try {
      saved = await this.saveConflictSilently(
        localProject, remoteProject, [], ownerUserId, pendingTaskDeleteIds,
        pendingTaskDeleteBaseUpdatedAtMap, conflictedAt,
      );
    } catch (error) {
      this.logger.warn('保存冲突隔离区记录失败', { error, projectId: localProject.id });
    }
    if (isCurrent?.() === false) return;
    if (!saved) {
      this.logger.warn('冲突隔离区记录未持久化，跳过 active conflict 发布以避免刷新后丢失双方数据', {
        projectId: localProject.id,
      });
      return;
    }
    const conflictData: SyncConflictData = {
      local: localProject, remote: remoteProject, projectId: localProject.id, conflictedAt,
      pendingTaskDeleteIds, pendingTaskDeleteBaseUpdatedAtMap,
    };
    this.syncStateService.setConflict(conflictData);
    this.conflict$.next({
      localProject, remoteProject, projectId: localProject.id,
      pendingTaskDeleteIds, pendingTaskDeleteBaseUpdatedAtMap,
    });
  }

  async tryReloadConflictData(
    userId: string,
    _findProject: (id: string) => Project | undefined,
  ): Promise<Project | undefined> {
    const state = this.syncStateService.syncState();
    if (!state.hasConflict || !state.conflictData) return undefined;
    const project = await this.projectData.loadFullProject(state.conflictData.projectId, userId);
    return project ?? undefined;
  }

  async restorePersistedConflictState(): Promise<boolean> {
    const state = this.syncStateService.syncState();
    if (state.hasConflict && state.conflictData) {
      return false;
    }

    try {
      const conflicts = await this.conflictStorage.getAllConflicts();
      const restorableConflict = conflicts.find(conflict =>
        conflict.remoteSnapshotFresh === true && !!conflict.remoteProject
      );
      if (!restorableConflict?.remoteProject) {
        return false;
      }

      this.syncStateService.setConflict({
        local: restorableConflict.localProject,
        remote: restorableConflict.remoteProject,
        projectId: restorableConflict.projectId,
        conflictedAt: restorableConflict.conflictedAt,
        pendingTaskDeleteIds: restorableConflict.pendingTaskDeleteIds,
        pendingTaskDeleteBaseUpdatedAtMap: restorableConflict.pendingTaskDeleteBaseUpdatedAtMap,
        operationConflicts: restorableConflict.operationConflicts,
      });
      this.conflict$.next({
        localProject: restorableConflict.localProject,
        remoteProject: restorableConflict.remoteProject,
        projectId: restorableConflict.projectId,
        pendingTaskDeleteIds: restorableConflict.pendingTaskDeleteIds,
        pendingTaskDeleteBaseUpdatedAtMap: restorableConflict.pendingTaskDeleteBaseUpdatedAtMap,
        operationConflicts: restorableConflict.operationConflicts,
      });
      this.logger.info('已从冲突隔离区恢复待解决冲突状态', {
        projectId: restorableConflict.projectId,
      });
      return true;
    } catch (error) {
      this.logger.warn('恢复冲突隔离区状态失败', { error });
      return false;
    }
  }

  resolveConflict(
    projectId: string,
    choice: 'local' | 'remote' | 'merge',
    localProject: Project,
    remoteProject: Project | undefined,
  ): Promise<Result<Project, OperationError>> {
    return this.conflictService.resolveConflict(projectId, choice, localProject, remoteProject);
  }

  resolveConflictWithPlan(
    projectId: string,
    plan: ConflictResolutionPlan,
    localProject: Project,
    remoteProject: Project | undefined,
  ): Promise<Result<Project, OperationError>> {
    return this.conflictService.resolveConflictWithPlan(projectId, plan, localProject, remoteProject);
  }

  async captureConflict(
    localProject: Project,
    remoteProject?: Project,
    ownerUserId?: string | null,
    pendingTaskDeleteIds?: string[],
    pendingTaskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap,
    isCurrent?: () => boolean,
  ): Promise<void> {
    if (isCurrent?.() === false) return;
    if (remoteProject) {
      await this.publishConflict(
        localProject,
        remoteProject,
        ownerUserId,
        pendingTaskDeleteIds,
        pendingTaskDeleteBaseUpdatedAtMap,
        isCurrent,
      );
      return;
    }

    if (isCurrent?.() === false) return;
    await this.saveConflictSilently(
      localProject,
      undefined,
      [],
      ownerUserId,
      pendingTaskDeleteIds,
      pendingTaskDeleteBaseUpdatedAtMap,
    );
  }

  clearActiveConflict(): void {
    this.syncStateService.clearConflict();
  }

  smartMerge(localProject: Project, remoteProject: Project, tombstoneIds: TaskTombstones) {
    return this.conflictService.smartMerge(localProject, remoteProject, tombstoneIds);
  }

  destroy(): void {
    this.conflict$.complete();
  }

  private isDuplicateActiveConflict(
    activeConflict: SyncConflictData | null,
    localProject: Project,
    remoteProject: Project,
    pendingTaskDeleteIds?: string[],
    pendingTaskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap,
  ): boolean {
    if (!activeConflict || activeConflict.projectId !== localProject.id) {
      return false;
    }

    return buildConflictSnapshotSignature(
      activeConflict.local,
      activeConflict.remote,
      activeConflict.pendingTaskDeleteIds,
      activeConflict.pendingTaskDeleteBaseUpdatedAtMap,
    ) === buildConflictSnapshotSignature(
      localProject,
      remoteProject,
      pendingTaskDeleteIds,
      pendingTaskDeleteBaseUpdatedAtMap,
    );
  }
}
