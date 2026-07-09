import { Injector, runInInjectionContext, type StaticProvider } from '@angular/core';
import { vi, type Mock } from 'vitest';
import { AUTH_CONFIG } from '../config/auth.config';
import {
  ProjectDataService,
  ProjectDeleteCoordinatorService,
  ProjectSaveFlightCoordinatorService,
  RetryQueueService,
  TaskSyncOperationsService,
  type SyncConflictData,
} from '../core-bridge';
import type { Project } from '../models';
import { ActionQueueService } from './action-queue.service';
import { ChangeTrackerService } from './change-tracker.service';
import { ConflictStorageService } from './conflict-storage.service';
import { LayoutService } from './layout.service';
import { LoggerService } from './logger.service';
import { OptimisticStateService } from './optimistic-state.service';
import { ProjectConflictCaptureService } from './project-conflict-capture.service';
import { ProjectOperationConflictService } from './project-operation-conflict.service';
import { ProjectOperationService } from './project-operation.service';
import { ProjectStateService } from './project-state.service';
import { SyncCoordinatorService } from './sync-coordinator.service';
import { ToastService } from './toast.service';
import { UndoService } from './undo.service';
import { UserSessionService } from './user-session.service';
import { WriteGuardService } from './write-guard.service';

type ProjectUpdater = (projects: Project[]) => Project[];
export type UpdateProjectsMock = Mock<(updater: ProjectUpdater) => void>;
export type MockFn = Mock<(...args: never[]) => unknown>;
type ProjectStateMock = ProjectOperationServiceSpecContext['mockProjectState'];
type SyncCoordinatorMock = ProjectOperationServiceSpecContext['mockSyncCoordinator'];
type ProjectOperationMocks = Omit<ProjectOperationServiceSpecContext, 'service' | 'projectConflict'>;

export interface ProjectOperationServiceSpecContext {
  service: ProjectOperationService;
  projectConflict: ProjectOperationConflictService;
  mockProjectState: {
    projects: Mock<() => Project[]>;
    updateProjects: UpdateProjectsMock;
    setActiveProjectId: Mock<(projectId: string | null) => void>;
    activeProjectId: Mock<() => string | null>;
    getProject: Mock<(projectId: string) => Project | undefined>;
  };
  mockSyncCoordinator: {
    core: {
      saveProjectSmart: MockFn;
      deleteProjectFromCloud: MockFn;
      deleteTask: MockFn;
      saveOfflineSnapshot: MockFn;
      saveOfflineSnapshotAndWait: MockFn;
    };
    conflictData: MockFn;
    resolveConflict: MockFn;
    resolveConflictWithPlan: MockFn;
    validateAndRebalance: MockFn;
    captureConflict: MockFn;
    clearActiveConflict: MockFn;
    loadSingleProjectFromCloud: MockFn;
    markLocalChanges: MockFn;
    schedulePersist: MockFn;
  };
  mockUserSession: {
    currentUserId: Mock<() => string>;
    getCurrentSessionGeneration: Mock<() => number>;
    isSessionContextCurrent: Mock<() => boolean>;
    isHintOnlyStartupPlaceholderVisible: Mock<() => boolean>;
  };
  mockWriteGuard: {
    isExportOnly: Mock<() => boolean>;
  };
  mockActionQueue: {
    enqueue: MockFn;
    enqueueDurably: MockFn;
    enqueueForOwner: MockFn;
    discardActions: MockFn;
    settleProjectDeleteSuccessForOwner: MockFn;
  };
  mockRetryQueue: {
    removeByProjectIdForOwner: MockFn;
    removeByProjectId: MockFn;
  };
  mockConflictStorage: {
    getConflict: MockFn;
    saveConflict: MockFn;
    deleteConflict: MockFn;
  };
  mockOptimisticState: {
    createSnapshot: MockFn;
    commitSnapshot: MockFn;
    rollbackSnapshot: MockFn;
  };
  mockLayout: {
    rebalance: MockFn;
  };
  mockUndo: {
    clearHistory: MockFn;
  };
  mockChangeTracker: {
    clearProjectFieldLocks: MockFn;
    clearProjectChanges: MockFn;
  };
  mockToast: {
    info: MockFn;
    success: MockFn;
    warning: MockFn;
    error: MockFn;
  };
  mockLoggerService: {
    category: MockFn;
  };
}

export function createProject(overrides: Partial<Project> = {}): Project {
  const now = '2026-03-30T00:00:00.000Z';
  return {
    id: overrides.id ?? 'proj-1',
    name: overrides.name ?? 'Project',
    description: overrides.description ?? '',
    createdDate: overrides.createdDate ?? now,
    updatedAt: overrides.updatedAt ?? now,
    version: overrides.version ?? 1,
    tasks: overrides.tasks ?? [],
    connections: overrides.connections ?? [],
    ...overrides,
  };
}

export function createDeferred<T = unknown>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve: ((value: T | PromiseLike<T>) => void) | null = null;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve: resolve! };
}

export function getProjectUpdater(
  updateProjects: UpdateProjectsMock,
  index: number,
): ProjectUpdater {
  return updateProjects.mock.calls[index]?.[0] as ProjectUpdater;
}

export function getLastProjectUpdater(updateProjects: UpdateProjectsMock): ProjectUpdater {
  return updateProjects.mock.calls.at(-1)?.[0] as ProjectUpdater;
}

export function replayProjectUpdates(
  updateProjects: UpdateProjectsMock,
  initialProjects: Project[] = [],
): Project[] {
  return updateProjects.mock.calls.reduce((projects, call) => call[0](projects), initialProjects);
}

function createProjectStateMock(): ProjectStateMock {
  const mockProjectState = {
    projects: vi.fn((): Project[] => []),
    updateProjects: vi.fn<(updater: ProjectUpdater) => void>(),
    setActiveProjectId: vi.fn<(projectId: string | null) => void>(),
    activeProjectId: vi.fn((): string | null => null),
    getProject: vi.fn((_projectId: string): Project | undefined => undefined),
  };
  mockProjectState.updateProjects.mockImplementation((updater: ProjectUpdater) => {
    updater(mockProjectState.projects());
  });
  return mockProjectState;
}

function createSyncCoordinatorMock(): SyncCoordinatorMock {
  return {
    core: {
      saveProjectSmart: vi.fn().mockResolvedValue({ success: false, conflict: false }),
      deleteProjectFromCloud: vi.fn().mockResolvedValue({
        ok: false,
        error: {
          code: 'SYNC_OFFLINE',
          message: '当前离线，删除将在恢复连接后重试',
          details: { retryable: true },
        },
      }),
      deleteTask: vi.fn().mockResolvedValue(true),
      saveOfflineSnapshot: vi.fn(),
      saveOfflineSnapshotAndWait: vi.fn().mockResolvedValue(undefined),
    },
    conflictData: vi.fn((): (Omit<SyncConflictData, 'remote'> & { remote?: Project }) | null => null),
    resolveConflict: vi.fn().mockResolvedValue({ ok: true, value: createProject({ id: 'proj-1' }) }),
    resolveConflictWithPlan: vi.fn().mockResolvedValue({ ok: true, value: createProject({ id: 'proj-1' }) }),
    validateAndRebalance: vi.fn((project: Project) => project),
    captureConflict: vi.fn().mockResolvedValue(undefined),
    clearActiveConflict: vi.fn(),
    loadSingleProjectFromCloud: vi.fn().mockResolvedValue(null),
    markLocalChanges: vi.fn(),
    schedulePersist: vi.fn(),
  };
}

function createProjectOperationMocks(): ProjectOperationMocks {
  return {
    mockProjectState: createProjectStateMock(),
    mockSyncCoordinator: createSyncCoordinatorMock(),
    mockUserSession: {
      currentUserId: vi.fn((): string => AUTH_CONFIG.LOCAL_MODE_USER_ID),
      getCurrentSessionGeneration: vi.fn(() => 1),
      isSessionContextCurrent: vi.fn(() => true),
      isHintOnlyStartupPlaceholderVisible: vi.fn(() => false),
    },
    mockWriteGuard: { isExportOnly: vi.fn(() => false) },
    mockActionQueue: {
      enqueue: vi.fn(),
      enqueueDurably: vi.fn().mockResolvedValue('queued-action-id'),
      enqueueForOwner: vi.fn().mockResolvedValue('queued-old-owner'),
      discardActions: vi.fn(),
      settleProjectDeleteSuccessForOwner: vi.fn().mockResolvedValue(1),
    },
    mockRetryQueue: {
      removeByProjectIdForOwner: vi.fn(),
      removeByProjectId: vi.fn(),
    },
    mockConflictStorage: {
      getConflict: vi.fn().mockResolvedValue(null),
      saveConflict: vi.fn().mockResolvedValue(true),
      deleteConflict: vi.fn().mockResolvedValue(true),
    },
    mockOptimisticState: {
      createSnapshot: vi.fn(() => ({ id: 'snap-1' })),
      commitSnapshot: vi.fn(),
      rollbackSnapshot: vi.fn(),
    },
    mockLayout: { rebalance: vi.fn((project: Project) => project) },
    mockUndo: { clearHistory: vi.fn() },
    mockChangeTracker: {
      clearProjectFieldLocks: vi.fn(),
      clearProjectChanges: vi.fn(),
    },
    mockToast: {
      info: vi.fn(),
      success: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
    },
    mockLoggerService: createLoggerServiceMock(),
  };
}

function createLoggerServiceMock(): ProjectOperationMocks['mockLoggerService'] {
  return {
    category: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    })),
  };
}

function createProjectOperationProviders(mocks: ProjectOperationMocks): StaticProvider[] {
  return [
    { provide: ProjectOperationService, useClass: ProjectOperationService },
    { provide: ProjectOperationConflictService, useClass: ProjectOperationConflictService },
    { provide: ProjectConflictCaptureService, useClass: ProjectConflictCaptureService },
    { provide: ProjectStateService, useValue: mocks.mockProjectState },
    { provide: SyncCoordinatorService, useValue: mocks.mockSyncCoordinator },
    { provide: ProjectSaveFlightCoordinatorService, useValue: { save: mocks.mockSyncCoordinator.core.saveProjectSmart } },
    { provide: ProjectDeleteCoordinatorService, useValue: { deleteProjectFromCloud: mocks.mockSyncCoordinator.core.deleteProjectFromCloud } },
    { provide: TaskSyncOperationsService, useValue: { deleteTask: mocks.mockSyncCoordinator.core.deleteTask } },
    {
      provide: ProjectDataService,
      useValue: {
        saveOfflineSnapshot: mocks.mockSyncCoordinator.core.saveOfflineSnapshot,
        saveOfflineSnapshotAndWait: mocks.mockSyncCoordinator.core.saveOfflineSnapshotAndWait,
      },
    },
    { provide: UserSessionService, useValue: mocks.mockUserSession },
    { provide: ActionQueueService, useValue: mocks.mockActionQueue },
    { provide: RetryQueueService, useValue: mocks.mockRetryQueue },
    { provide: ConflictStorageService, useValue: mocks.mockConflictStorage },
    { provide: OptimisticStateService, useValue: mocks.mockOptimisticState },
    { provide: LayoutService, useValue: mocks.mockLayout },
    { provide: UndoService, useValue: mocks.mockUndo },
    { provide: ToastService, useValue: mocks.mockToast },
    { provide: LoggerService, useValue: mocks.mockLoggerService },
    { provide: ChangeTrackerService, useValue: mocks.mockChangeTracker },
    { provide: WriteGuardService, useValue: mocks.mockWriteGuard },
  ];
}

export function createProjectOperationServiceSpecContext(): ProjectOperationServiceSpecContext {
  const mocks = createProjectOperationMocks();
  const injector = Injector.create({
    providers: createProjectOperationProviders(mocks),
  });

  const service = runInInjectionContext(injector, () => injector.get(ProjectOperationService));
  const projectConflict = runInInjectionContext(injector, () => injector.get(ProjectOperationConflictService));

  return {
    service,
    projectConflict,
    ...mocks,
  };
}
