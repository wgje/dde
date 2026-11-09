import { DestroyRef, Injector, runInInjectionContext } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import type { Project, Task } from '../models';
import { ConnectionStore, ProjectStore, TaskStore } from '../app/core/state/stores';
import {
  ProjectDataService,
  ProjectSyncCursorService,
  RetryQueueService,
  TaskSyncOperationsService,
  TombstoneService,
} from '../core-bridge';
import { ActionQueueService } from './action-queue.service';
import { AuthService } from './auth.service';
import { BlackBoxSyncService } from './black-box-sync.service';
import { ChangeTrackerService } from './change-tracker.service';
import { LayoutService } from './layout.service';
import { LoggerService } from './logger.service';
import { PermissionDeniedHandlerService } from './permission-denied-handler.service';
import { ProjectStateService } from './project-state.service';
import { ProjectSyncOperationsService } from './project-sync-operations.service';
import {
  RemoteChangeHandlerService,
  type RemoteProjectChangePayload,
} from './remote-change-handler.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { SupabaseClientService } from './supabase-client.service';
import { SyncCoordinatorConflictService } from './sync-coordinator-conflicts.service';
import { SyncCoordinatorProjectRefreshService } from './sync-coordinator-project-refresh.service';
import { SyncCoordinatorService } from './sync-coordinator.service';
import { ToastService } from './toast.service';
import { UiStateService } from './ui-state.service';
import { UndoService } from './undo.service';
import { UserSessionService } from './user-session.service';

type ProjectChangeCallback = (payload: RemoteProjectChangePayload) => Promise<void>;

interface DownloadMergeApplier {
  applyDownloadedProjects(projects: Project[]): void;
}

function task(id: string): Task {
  return {
    id,
    title: id,
    content: `${id} content must remain visible`,
    stage: 1,
    parentId: null,
    order: 0,
    rank: 1000,
    status: 'active',
    x: 0,
    y: 0,
    createdDate: '2026-07-26T00:00:00.000Z',
    updatedAt: '2026-07-26T00:00:00.000Z',
    displayId: id,
  };
}

function project(id: string, tasks: Task[]): Project {
  return {
    id,
    name: id,
    description: '',
    createdDate: '2026-07-26T00:00:00.000Z',
    updatedAt: '2026-07-26T00:00:00.000Z',
    version: 1,
    tasks,
    connections: [],
  };
}

function createRealProjectState(uiState: object): ProjectStateService {
  const injector = Injector.create({
    providers: [
      { provide: TaskStore, useValue: new TaskStore() },
      { provide: ProjectStore, useValue: new ProjectStore() },
      { provide: ConnectionStore, useValue: new ConnectionStore() },
      { provide: LayoutService, useValue: {} },
      { provide: UiStateService, useValue: uiState },
    ],
  });
  return runInInjectionContext(injector, () => new ProjectStateService());
}

function seedActiveProjectRemovalScenario(projectState: ProjectStateService): Project {
  const removed = project('project-a', [task('task-a')]);
  const retained = project('project-b', [task('task-b')]);
  projectState.setProjects([removed, retained]);
  projectState.setActiveProjectId(removed.id);
  return retained;
}

describe('active project removal data safety', () => {
  it('远程 DELETE 当前项目后应切换到剩余项目并保持其任务可见', async () => {
    const uiState = { isEditing: false, filterMode: () => 'all' };
    const projectState = createRealProjectState(uiState);
    const retained = seedActiveProjectRemovalScenario(projectState);
    let projectChangeCallback: ProjectChangeCallback | undefined;
    const syncCoordinator = {
      setupRemoteChangeCallbacks: vi.fn((projectCallback: ProjectChangeCallback) => {
        projectChangeCallback = projectCallback;
      }),
      hasPendingLocalChanges: vi.fn(() => false),
      hasPendingChangesForProject: vi.fn(() => false),
      getAccessibleProjectProbe: vi.fn().mockResolvedValue({
        projectId: 'project-a',
        accessible: false,
        watermark: null,
      }),
      getLastPersistAt: vi.fn(() => 0),
    };
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const injector = Injector.create({
      providers: [
        { provide: SyncCoordinatorService, useValue: syncCoordinator },
        { provide: ActionQueueService, useValue: { getPendingActionsForProject: vi.fn(() => []) } },
        { provide: ProjectDataService, useValue: {} },
        { provide: TaskSyncOperationsService, useValue: {} },
        { provide: UndoService, useValue: { clearOutdatedHistory: vi.fn() } },
        { provide: UiStateService, useValue: uiState },
        { provide: ProjectStateService, useValue: projectState },
        { provide: ToastService, useValue: {} },
        { provide: AuthService, useValue: { currentUserId: vi.fn(() => 'user-1') } },
        { provide: UserSessionService, useValue: {
          currentUserId: vi.fn(() => 'user-1'),
          getCurrentSessionGeneration: vi.fn(() => 1),
          isSessionContextCurrent: vi.fn((generation: number, userId: string) => (
            generation === 1 && userId === 'user-1'
          )),
        } },
        { provide: LoggerService, useValue: { category: () => logger } },
        { provide: ChangeTrackerService, useValue: { getLockedFields: vi.fn(() => []) } },
        { provide: PermissionDeniedHandlerService, useValue: {} },
        { provide: DestroyRef, useValue: { onDestroy: vi.fn() } },
      ],
    });
    const service = runInInjectionContext(injector, () => new RemoteChangeHandlerService());
    service.setupCallbacks(vi.fn().mockResolvedValue(undefined));

    await projectChangeCallback?.({ eventType: 'DELETE', projectId: 'project-a' });

    expect(projectState.activeProjectId()).toBe(retained.id);
    expect(projectState.tasks()).toEqual(retained.tasks);
    expect(projectState.tasks()[0]?.content).toBe('task-b content must remain visible');
  });

  it('download merge 裁剪当前项目后应切换到剩余项目并保持其任务可见', () => {
    const uiState = { isEditing: false, filterMode: () => 'all' };
    const projectState = createRealProjectState(uiState);
    const retained = seedActiveProjectRemovalScenario(projectState);
    const saveOfflineSnapshot = vi.fn();
    const injector = Injector.create({
      providers: [
        { provide: LoggerService, useValue: { category: () => ({ info: vi.fn() }) } },
        { provide: ProjectDataService, useValue: { saveOfflineSnapshot } },
        { provide: ProjectSyncCursorService, useValue: {} },
        { provide: ProjectStateService, useValue: projectState },
        { provide: ChangeTrackerService, useValue: {} },
        { provide: ActionQueueService, useValue: {} },
        { provide: RetryQueueService, useValue: {} },
        { provide: SentryLazyLoaderService, useValue: {} },
        { provide: AuthService, useValue: {} },
        { provide: BlackBoxSyncService, useValue: {} },
        { provide: SyncCoordinatorConflictService, useValue: {} },
        { provide: ProjectSyncOperationsService, useValue: {} },
        { provide: TaskSyncOperationsService, useValue: {} },
        { provide: SupabaseClientService, useValue: {} },
        { provide: TombstoneService, useValue: {} },
      ],
    });
    const service = runInInjectionContext(
      injector,
      () => new SyncCoordinatorProjectRefreshService(),
    );

    (service as unknown as DownloadMergeApplier).applyDownloadedProjects([retained]);

    expect(projectState.activeProjectId()).toBe(retained.id);
    expect(projectState.tasks()).toEqual(retained.tasks);
    expect(projectState.tasks()[0]?.content).toBe('task-b content must remain visible');
    expect(saveOfflineSnapshot).toHaveBeenCalledWith([retained]);
  });
});
