import { Injector, runInInjectionContext } from '@angular/core';

import { ProjectDataService } from '../app/core/services/sync/project-data.service';
import { ProjectSaveFlightCoordinatorService } from '../app/core/services/sync/project-save-flight-coordinator.service';
import { SimpleSyncService } from '../app/core/services/simple-sync.service';
import { beforeEach, describe, expect, it, vi } from './sync-coordinator.service.spec-context';
import type { Project, Task } from './sync-coordinator.service.spec-context';
import { AuthService } from './auth.service';
import { ChangeTrackerService } from './change-tracker.service';
import { ConflictResolutionService } from './conflict-resolution.service';
import { ConflictStorageService } from './conflict-storage.service';
import { DeltaSyncCoordinatorService } from './delta-sync-coordinator.service';
import { LayoutService } from './layout.service';
import { LoggerService } from './logger.service';
import { ProjectStateService } from './project-state.service';
import { ProjectSyncOperationsService } from './project-sync-operations.service';
import { ToastService } from './toast.service';

interface SyncCoordinatorProjectSyncOperationsSpecContext {
  createTestProject(overrides?: Partial<Project>): Project;
  createTestTask(overrides?: Partial<Task>): Task;
}

export function registerSyncCoordinatorProjectSyncOperationsSpecs(
  context: SyncCoordinatorProjectSyncOperationsSpecContext,
): void {
  const { createTestProject, createTestTask } = context;

  describe('ProjectSyncOperationsService', () => {
    const mockProjectSyncOpsSyncService = {
      loadSingleProject: vi.fn(),
      saveProjectSmart: vi.fn(),
    };
    const mockProjectSyncOpsConflictService = {
      smartMerge: vi.fn(),
    };
    const mockProjectSyncOpsConflictStorage = {
      saveConflict: vi.fn(),
    };
    const mockProjectSyncOpsProjectState = {
      activeProjectId: vi.fn(),
      activeProject: vi.fn(),
      getProjectWithCurrentData: vi.fn(),
      updateProjects: vi.fn(),
    };
    const mockProjectSyncOpsAuthService = {
      currentUserId: vi.fn(),
    };
    const mockProjectSyncOpsChangeTracker = {
      clearProjectFieldLocks: vi.fn(),
    };
    const mockProjectSyncOpsLayoutService = {
      rebalance: vi.fn((project: Project) => project),
    };
    const mockProjectSyncOpsToastService = {
      warning: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      success: vi.fn(),
    };
    const mockProjectSyncOpsDeltaCoordinator = {
      processPendingDeltaSync: vi.fn(),
      hasProjectContentDifference: vi.fn(),
    };
    const mockProjectSyncOpsLoggerCategory = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const mockProjectSyncOpsLoggerService = {
      category: vi.fn(() => mockProjectSyncOpsLoggerCategory),
    };

    let projectSyncOpsService: ProjectSyncOperationsService;
    let projectSyncOpsInjector: Injector;

    beforeEach(() => {
      vi.clearAllMocks();

      mockProjectSyncOpsAuthService.currentUserId.mockReturnValue('user-123');
      mockProjectSyncOpsSyncService.loadSingleProject.mockResolvedValue(null);
      mockProjectSyncOpsSyncService.saveProjectSmart.mockResolvedValue({ success: true });
      mockProjectSyncOpsDeltaCoordinator.hasProjectContentDifference.mockReturnValue(false);

      projectSyncOpsInjector = Injector.create({
        providers: [
          { provide: ProjectSyncOperationsService, useClass: ProjectSyncOperationsService },
          { provide: SimpleSyncService, useValue: mockProjectSyncOpsSyncService },
          { provide: ProjectDataService, useValue: { loadFullProject: mockProjectSyncOpsSyncService.loadSingleProject } },
          { provide: ProjectSaveFlightCoordinatorService, useValue: { save: mockProjectSyncOpsSyncService.saveProjectSmart } },
          { provide: ConflictResolutionService, useValue: mockProjectSyncOpsConflictService },
          { provide: ConflictStorageService, useValue: mockProjectSyncOpsConflictStorage },
          { provide: ProjectStateService, useValue: mockProjectSyncOpsProjectState },
          { provide: AuthService, useValue: mockProjectSyncOpsAuthService },
          { provide: ChangeTrackerService, useValue: mockProjectSyncOpsChangeTracker },
          { provide: LayoutService, useValue: mockProjectSyncOpsLayoutService },
          { provide: ToastService, useValue: mockProjectSyncOpsToastService },
          { provide: DeltaSyncCoordinatorService, useValue: mockProjectSyncOpsDeltaCoordinator },
          { provide: LoggerService, useValue: mockProjectSyncOpsLoggerService },
        ],
      });

      projectSyncOpsService = runInInjectionContext(
        projectSyncOpsInjector,
        () => projectSyncOpsInjector.get(ProjectSyncOperationsService),
      );
    });

    it('resyncActiveProject 应使用当前 store 快照而不是陈旧 activeProject', async () => {
      const staleTask = createTestTask({
        id: 'task-resync-stale',
        title: 'Stale Task',
        stage: null,
        updatedAt: '2026-05-14T09:20:00.000Z',
      });
      const staleConnection = {
        id: 'connection-resync-stale',
        source: 'task-resync-stale',
        target: 'task-resync-target',
        title: 'Stale Connection',
        updatedAt: '2026-05-14T09:20:00.000Z',
      };
      const currentTask = {
        ...staleTask,
        title: 'Current Task',
        stage: 4,
        updatedAt: '2026-05-14T09:22:00.000Z',
      };
      const currentConnection = {
        ...staleConnection,
        title: 'Current Connection',
        updatedAt: '2026-05-14T09:22:00.000Z',
      };
      const staleProject = createTestProject({
        id: 'proj-resync-current-data',
        version: 3,
        tasks: [staleTask],
        connections: [staleConnection],
      });
      const currentProject = {
        ...staleProject,
        tasks: [currentTask],
        connections: [currentConnection],
      };
      const remoteProject = createTestProject({
        id: 'proj-resync-current-data',
        version: 2,
        tasks: [currentTask],
        connections: [currentConnection],
      });

      mockProjectSyncOpsProjectState.activeProjectId.mockReturnValue('proj-resync-current-data');
      mockProjectSyncOpsProjectState.activeProject.mockReturnValue(staleProject);
      mockProjectSyncOpsProjectState.getProjectWithCurrentData.mockReturnValue(currentProject);
      mockProjectSyncOpsSyncService.loadSingleProject.mockResolvedValueOnce(remoteProject);
      mockProjectSyncOpsSyncService.saveProjectSmart.mockResolvedValueOnce({ success: true });

      const result = await projectSyncOpsService.resyncActiveProject(async () => new Set<string>());

      expect(result).toEqual({ success: true, message: '本地更改已推送到云端' });
      expect(mockProjectSyncOpsSyncService.saveProjectSmart).toHaveBeenCalledWith(currentProject, 'user-123');
    });

    it('resyncActiveProject remote-newer 冲突保存失败时不得覆盖本地运行态', async () => {
      const localTask = createTestTask({
        id: 'task-conflict',
        title: '本地离线标题',
        updatedAt: '2026-05-14T09:20:00.000Z',
      });
      const remoteTask = {
        ...localTask,
        title: '远端标题',
        updatedAt: '2026-05-14T09:22:00.000Z',
      };
      const localProject = createTestProject({
        id: 'proj-conflict-save-failed',
        version: 2,
        updatedAt: '2026-05-14T09:20:00.000Z',
        tasks: [localTask],
      });
      const remoteProject = {
        ...localProject,
        version: 3,
        updatedAt: '2026-05-14T09:22:00.000Z',
        tasks: [remoteTask],
      };
      const mergedProject = {
        ...remoteProject,
        tasks: [{ ...remoteTask, title: '合并标题' }],
      };

      mockProjectSyncOpsProjectState.activeProjectId.mockReturnValue('proj-conflict-save-failed');
      mockProjectSyncOpsProjectState.activeProject.mockReturnValue(localProject);
      mockProjectSyncOpsProjectState.getProjectWithCurrentData.mockReturnValue(localProject);
      mockProjectSyncOpsSyncService.loadSingleProject.mockResolvedValueOnce(remoteProject);
      mockProjectSyncOpsConflictService.smartMerge.mockReturnValueOnce({
        project: mergedProject,
        issues: ['task title conflict'],
        conflictCount: 1,
      });
      mockProjectSyncOpsConflictStorage.saveConflict.mockResolvedValueOnce(false);

      const result = await projectSyncOpsService.resyncActiveProject(async () => new Set<string>());

      expect(result).toEqual({
        success: false,
        message: '发现冲突，但冲突证据保存失败，本地数据已保留',
        conflictDetected: true,
      });
      expect(mockProjectSyncOpsConflictStorage.saveConflict).toHaveBeenCalledWith(expect.objectContaining({
        projectId: 'proj-conflict-save-failed',
        localProject,
        remoteProject,
        conflictedFields: ['task title conflict'],
      }));
      expect(mockProjectSyncOpsProjectState.updateProjects).not.toHaveBeenCalled();
      expect(mockProjectSyncOpsChangeTracker.clearProjectFieldLocks).not.toHaveBeenCalled();
    });

    it('resyncActiveProject same-version divergent 冲突保存失败时不得更新本地运行态', async () => {
      const localTask = createTestTask({
        id: 'task-same-version-conflict',
        title: '本地标题',
        updatedAt: '2026-05-14T09:20:00.000Z',
      });
      const remoteTask = {
        ...localTask,
        title: '远端标题',
        updatedAt: '2026-05-14T09:21:00.000Z',
      };
      const localProject = createTestProject({
        id: 'proj-same-version-conflict',
        version: 4,
        updatedAt: '2026-05-14T09:20:00.000Z',
        tasks: [localTask],
      });
      const remoteProject = {
        ...localProject,
        updatedAt: '2026-05-14T09:21:00.000Z',
        tasks: [remoteTask],
      };
      const mergedProject = {
        ...remoteProject,
        tasks: [{ ...remoteTask, title: '合并标题' }],
      };

      mockProjectSyncOpsProjectState.activeProjectId.mockReturnValue('proj-same-version-conflict');
      mockProjectSyncOpsProjectState.activeProject.mockReturnValue(localProject);
      mockProjectSyncOpsProjectState.getProjectWithCurrentData.mockReturnValue(localProject);
      mockProjectSyncOpsSyncService.loadSingleProject.mockResolvedValueOnce(remoteProject);
      mockProjectSyncOpsConflictService.smartMerge.mockReturnValueOnce({
        project: mergedProject,
        issues: ['same version task title conflict'],
        conflictCount: 1,
      });
      mockProjectSyncOpsConflictStorage.saveConflict.mockResolvedValueOnce(false);

      const result = await projectSyncOpsService.resyncActiveProject(async () => new Set<string>());

      expect(result).toEqual({
        success: false,
        message: '发现冲突，但冲突证据保存失败，本地数据已保留',
        conflictDetected: true,
      });
      expect(mockProjectSyncOpsConflictStorage.saveConflict).toHaveBeenCalledWith(expect.objectContaining({
        projectId: 'proj-same-version-conflict',
        localProject,
        remoteProject,
        conflictedFields: ['same version task title conflict'],
      }));
      expect(mockProjectSyncOpsProjectState.updateProjects).not.toHaveBeenCalled();
      expect(mockProjectSyncOpsChangeTracker.clearProjectFieldLocks).not.toHaveBeenCalled();
    });

    it('resyncActiveProject local-newer 推送遇到冲突保存失败时不得声称已保存', async () => {
      const localProject = createTestProject({
        id: 'proj-local-newer-conflict',
        version: 5,
        updatedAt: '2026-05-14T09:25:00.000Z',
        tasks: [createTestTask({ id: 'task-local-newer-conflict', title: '本地标题' })],
      });
      const remoteProject = {
        ...localProject,
        version: 6,
        updatedAt: '2026-05-14T09:26:00.000Z',
        tasks: [{ ...localProject.tasks[0], title: '远端标题' }],
      };

      mockProjectSyncOpsProjectState.activeProjectId.mockReturnValue('proj-local-newer-conflict');
      mockProjectSyncOpsProjectState.activeProject.mockReturnValue(localProject);
      mockProjectSyncOpsProjectState.getProjectWithCurrentData.mockReturnValue(localProject);
      mockProjectSyncOpsSyncService.loadSingleProject.mockResolvedValueOnce({
        ...remoteProject,
        version: 4,
      });
      mockProjectSyncOpsSyncService.saveProjectSmart.mockResolvedValueOnce({
        success: false,
        conflict: true,
        remoteData: remoteProject,
      });
      mockProjectSyncOpsConflictStorage.saveConflict.mockResolvedValueOnce(false);

      const result = await projectSyncOpsService.resyncActiveProject(async () => new Set<string>());

      expect(result).toEqual({
        success: false,
        message: '发现冲突，但冲突证据保存失败，本地数据已保留',
        conflictDetected: true,
      });
      expect(mockProjectSyncOpsConflictStorage.saveConflict).toHaveBeenCalledWith(expect.objectContaining({
        projectId: 'proj-local-newer-conflict',
        localProject,
        remoteProject,
        conflictedFields: [],
      }));
      expect(mockProjectSyncOpsProjectState.updateProjects).not.toHaveBeenCalled();
      expect(mockProjectSyncOpsChangeTracker.clearProjectFieldLocks).not.toHaveBeenCalled();
    });

    it('mergeOfflineDataOnReconnect same-version cloud-newer 冲突证据保存失败时不得推送合并结果', async () => {
      const offlineProject = createTestProject({
        id: 'proj-offline-same-version-conflict-save-failed',
        version: 4,
        updatedAt: '2026-05-14T09:20:00.000Z',
        tasks: [
          createTestTask({
            id: 'task-offline-same-version-conflict',
            title: '离线标题',
            updatedAt: '2026-05-14T09:20:00.000Z',
          }),
        ],
      });
      const cloudProject = {
        ...offlineProject,
        updatedAt: '2026-05-14T09:21:00.000Z',
        tasks: [
          {
            ...offlineProject.tasks[0],
            title: '云端标题',
            updatedAt: '2026-05-14T09:21:00.000Z',
          },
        ],
      };
      const mergedProject = {
        ...cloudProject,
        tasks: [
          {
            ...cloudProject.tasks[0],
            title: '智能合并标题',
          },
        ],
      };
      const onConflict = vi.fn();

      mockProjectSyncOpsDeltaCoordinator.hasProjectContentDifference.mockReturnValueOnce(true);
      mockProjectSyncOpsConflictService.smartMerge.mockReturnValueOnce({
        project: mergedProject,
        issues: ['same version cloud-newer task title conflict'],
        conflictCount: 1,
      });
      mockProjectSyncOpsConflictStorage.saveConflict.mockResolvedValueOnce(false);

      const result = await projectSyncOpsService.mergeOfflineDataOnReconnect(
        [cloudProject],
        [offlineProject],
        'user-123',
        async () => new Set<string>(),
        onConflict,
      );

      expect(mockProjectSyncOpsConflictStorage.saveConflict).toHaveBeenCalledWith(expect.objectContaining({
        projectId: 'proj-offline-same-version-conflict-save-failed',
        localProject: offlineProject,
        remoteProject: cloudProject,
        conflictedFields: ['same version cloud-newer task title conflict'],
      }));
      expect(mockProjectSyncOpsSyncService.saveProjectSmart).not.toHaveBeenCalled();
      expect(onConflict).toHaveBeenCalledWith(offlineProject, cloudProject);
      expect(result).toEqual({
        projects: [cloudProject],
        syncedCount: 0,
        conflictProjects: [offlineProject],
      });
    });
  });
}
