import { Injectable, inject } from '@angular/core';
import {
  ProjectDataService,
} from '../core-bridge';
import { SYNC_CONFIG } from '../config/sync.config';
import { STARTUP_PERF_CONFIG } from '../config/startup-performance.config';
import { FEATURE_FLAGS } from '../config/feature-flags.config';
import { Project } from '../models';
import { ActionQueueService } from './action-queue.service';
import { ChangeTrackerService } from './change-tracker.service';
import { LoggerService } from './logger.service';
import { PersistSchedulerService } from './persist-scheduler.service';
import { ProjectStateService } from './project-state.service';
import { ProjectSyncOperationsService } from './project-sync-operations.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { TabSyncService } from './tab-sync.service';
import { AuthService } from './auth.service';

@Injectable({ providedIn: 'root' })
export class SyncCoordinatorRuntimeService {
  private readonly logger = inject(LoggerService).category('SyncCoordinator');
  private readonly actionQueue = inject(ActionQueueService);
  private readonly authService = inject(AuthService);
  private readonly changeTracker = inject(ChangeTrackerService);
  private readonly persistScheduler = inject(PersistSchedulerService);
  private readonly projectData = inject(ProjectDataService);
  private readonly projectState = inject(ProjectStateService);
  private readonly projectSyncOps = inject(ProjectSyncOperationsService);
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly tabSync = inject(TabSyncService);

  private lastSnapshotHash = '';
  private readonly tabSyncLocalRefreshAt = new Map<string, number>();
  private tabSyncLocalRefreshCount = 0;

  startLocalAutosave(): void {
    this.persistScheduler.setCallbacks({
      saveSnapshot: async () => {
        const projects = this.projectState.getProjectsWithCurrentData();
        if (projects.length === 0) return;

        const userId = this.authService.currentUserId();
        if (!userId) return;

        const hash = `${userId}|${JSON.stringify(projects)}`;
        if (hash === this.lastSnapshotHash) return;

        await this.projectData.saveOfflineSnapshotAndWait(projects, userId);
        this.lastSnapshotHash = hash;
      },
      doPersist: async () => {
        // 持久化交由 saveSnapshot 逻辑统一处理。
      },
    });
    this.persistScheduler.startLocalAutosave();

    this.logger.info('本地自动保存已启动（委托 PersistSchedulerService）', {
      interval: `${SYNC_CONFIG.LOCAL_AUTOSAVE_INTERVAL}ms`,
      dirtyCheck: true,
    });
  }

  validateRequiredProcessors(): void {
    const requiredProcessors = [
      'project:create',
      'project:update',
      'project:delete',
      'task:create',
      'task:update',
      'task:delete',
      'attachment:create',
      'preference:update',
    ];

    const missing = this.actionQueue.validateProcessors(requiredProcessors);
    if (missing.length > 0 && typeof ngDevMode !== 'undefined' && ngDevMode) {
      this.logger.error('缺少必需的 ActionQueue 处理器', {
        missing: missing.join(', '),
        registered: this.actionQueue.getRegisteredProcessorTypes(),
      });
    }
  }

  setupTabSyncLocalRefresh(
    hasPendingChangesForProject: (projectId: string) => boolean,
  ): void {
    if (!FEATURE_FLAGS.TAB_SYNC_LOCAL_REFRESH_V1) {
      return;
    }

    this.tabSync.setOnDataSyncedCallback((projectId, updatedAt) => {
      this.handleTabSyncLocalRefresh(projectId, updatedAt, hasPendingChangesForProject);
    });
  }

  teardownTabSyncLocalRefresh(): void {
    this.tabSyncLocalRefreshAt.clear();
    if (FEATURE_FLAGS.TAB_SYNC_LOCAL_REFRESH_V1) {
      this.tabSync.setOnDataSyncedCallback(() => {});
    }
  }

  private handleTabSyncLocalRefresh(
    projectId: string,
    updatedAt: string,
    hasPendingChangesForProject: (projectId: string) => boolean,
  ): void {
    const now = Date.now();
    const lastRefreshAt = this.tabSyncLocalRefreshAt.get(projectId) ?? 0;
    if (now - lastRefreshAt < STARTUP_PERF_CONFIG.TAB_SYNC_LOCAL_REFRESH_COOLDOWN_MS) {
      return;
    }
    this.tabSyncLocalRefreshAt.set(projectId, now);

    if (hasPendingChangesForProject(projectId) || this.changeTracker.hasProjectChanges(projectId)) {
      return;
    }

    const snapshotProject = this.findSnapshotProject(projectId);
    if (!snapshotProject || !this.projectState.projects().some(project => project.id === projectId)) {
      return;
    }

    this.projectState.updateProjects(projects => projects.map(project => {
      if (project.id !== projectId) {
        return project;
      }

      return this.projectSyncOps.validateAndRebalance({
        ...snapshotProject,
        pendingSync: false,
        syncSource: 'synced',
      });
    }));

    this.recordTabSyncLocalRefresh(projectId, updatedAt);
  }

  private findSnapshotProject(projectId: string): Project | null {
    const snapshot = this.projectData.loadOfflineSnapshot();
    if (!snapshot || snapshot.length === 0) {
      return null;
    }
    return snapshot.find(project => project.id === projectId) ?? null;
  }

  private recordTabSyncLocalRefresh(projectId: string, updatedAt: string): void {
    this.tabSyncLocalRefreshCount += 1;
    this.sentryLazyLoader.addBreadcrumb({
      category: 'tabsync',
      message: 'tabsync.local_refresh.count',
      level: 'info',
      data: {
        projectId,
        updatedAt,
        count: this.tabSyncLocalRefreshCount,
      },
    });
  }
}
