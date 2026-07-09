import { Injector, runInInjectionContext } from '@angular/core';
import { vi } from 'vitest';
import type { Connection, Project, Task } from '../models';
import { ActionQueueService } from './action-queue.service';
import { AuthService } from './auth.service';
import { ChangeTrackerService } from './change-tracker.service';
import { LayoutService } from './layout.service';
import { LoggerService } from './logger.service';
import { OptimisticStateService } from './optimistic-state.service';
import { ProjectStateService } from './project-state.service';
import { SyncCoordinatorService } from './sync-coordinator.service';
import { TaskRecordTrackingService } from './task-record-tracking.service';
import { ToastService } from './toast.service';
import { UiStateService } from './ui-state.service';
import { UndoService } from './undo.service';

type MockRecord = Record<string, any>;

export interface TaskRecordTrackingSpecHarness {
  service: TaskRecordTrackingService;
  mockProjectState: MockRecord;
  mockUndoService: MockRecord;
  mockSyncCoordinator: MockRecord;
  mockChangeTracker: MockRecord;
  mockLayoutService: MockRecord;
  mockOptimisticState: MockRecord;
  mockUiState: MockRecord;
  mockActionQueue: MockRecord;
  mockAuthService: MockRecord;
  mockLoggerCategory: MockRecord;
  mockToastService: MockRecord;
  restoreConsole(): void;
}

export function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Title',
    content: '',
    stage: 1,
    parentId: null,
    order: 0,
    rank: 10000,
    status: 'active',
    x: 0,
    y: 0,
    createdDate: new Date().toISOString(),
    displayId: '1',
    ...overrides,
  };
}

export function createProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    name: 'Test Project',
    description: '',
    createdDate: new Date().toISOString(),
    tasks: [createTask()],
    connections: [],
    version: 1,
    ...overrides,
  };
}

export function createConnection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: 'conn-1',
    source: 'task-1',
    target: 'task-2',
    title: '旧标题',
    description: '旧描述',
    ...overrides,
  };
}

export function createTaskRecordTrackingSpecHarness(): TaskRecordTrackingSpecHarness {
  vi.clearAllMocks();
  const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  const mockLoggerCategory = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const mockLoggerService = {
    category: vi.fn(() => mockLoggerCategory),
  };
  const mockToastService = {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  };
  const mockProjectState = {
    activeProject: vi.fn().mockReturnValue(createProject()),
    updateProjects: vi.fn((fn: (projects: Project[]) => Project[]) => {
      fn([createProject()]);
    }),
    getProjectsWithCurrentData: vi.fn().mockReturnValue([createProject()]),
    getTask: vi.fn().mockReturnValue(null),
  };
  const mockUndoService = {
    undo: vi.fn(),
    prepareUndo: vi.fn(),
    commitPreparedUndo: vi.fn(),
    redo: vi.fn(),
    prepareRedo: vi.fn(),
    commitPreparedRedo: vi.fn(),
    createProjectSnapshot: vi.fn((p: Project) => ({ tasks: p.tasks, connections: p.connections })),
    recordAction: vi.fn(),
    recordActionDebounced: vi.fn(),
    notifyReplayApplied: vi.fn(),
    forceUndo: vi.fn(),
    clearOutdatedHistory: vi.fn(),
    isProcessing: false,
  };
  const mockSyncCoordinator = {
    markLocalChanges: vi.fn(),
    schedulePersist: vi.fn(),
    saveOfflineSnapshotAndWait: vi.fn().mockResolvedValue(undefined),
    syncError: vi.fn().mockReturnValue(null),
    hasPendingLocalChanges: vi.fn().mockReturnValue(false),
    softDeleteTasksBatch: vi.fn().mockResolvedValue(1),
  };
  const mockChangeTracker = {
    trackTaskCreate: vi.fn(),
    trackTaskUpdate: vi.fn(),
    trackTaskDelete: vi.fn(),
    trackConnectionCreate: vi.fn(),
    trackConnectionUpdate: vi.fn(),
    trackConnectionDelete: vi.fn(),
  };
  const mockLayoutService = {
    rebalance: vi.fn((p: Project) => p),
  };
  const mockOptimisticState = {
    hasSnapshot: vi.fn().mockReturnValue(false),
    commitSnapshot: vi.fn(),
    rollbackSnapshot: vi.fn(),
    restoreTasksFromSnapshot: vi.fn().mockReturnValue(true),
    getTaskFromSnapshot: vi.fn().mockReturnValue(null),
    snapshots: new Map(),
  };
  const mockUiState = {
    isMobile: vi.fn().mockReturnValue(false),
  };
  const mockActionQueue = {
    enqueue: vi.fn().mockReturnValue('queued-action-id'),
    enqueueDurably: vi.fn().mockResolvedValue('queued-action-id'),
    enqueueManyDurably: vi.fn(async (actions: unknown[]) =>
      actions.map((_action, index) => `queued-action-id-${index}`)),
    enqueueDurablyForOwner: vi.fn().mockResolvedValue('queued-owner-action-id'),
    enqueueManyDurablyForOwner: vi.fn(async (_ownerUserId: string, actions: unknown[]) =>
      actions.map((_action, index) => `queued-owner-action-id-${index}`)),
  };
  const mockAuthService = {
    currentUserId: vi.fn().mockReturnValue('test-user'),
    peekPersistedOwnerHint: vi.fn().mockReturnValue(null),
  };

  const injector = Injector.create({
    providers: [
      TaskRecordTrackingService,
      { provide: ProjectStateService, useValue: mockProjectState },
      { provide: UndoService, useValue: mockUndoService },
      { provide: SyncCoordinatorService, useValue: mockSyncCoordinator },
      { provide: ChangeTrackerService, useValue: mockChangeTracker },
      { provide: LayoutService, useValue: mockLayoutService },
      { provide: OptimisticStateService, useValue: mockOptimisticState },
      { provide: ToastService, useValue: mockToastService },
      { provide: UiStateService, useValue: mockUiState },
      { provide: LoggerService, useValue: mockLoggerService },
      { provide: ActionQueueService, useValue: mockActionQueue },
      { provide: AuthService, useValue: mockAuthService },
    ],
  });

  return {
    service: runInInjectionContext(injector, () => injector.get(TaskRecordTrackingService)),
    mockProjectState,
    mockUndoService,
    mockSyncCoordinator,
    mockChangeTracker,
    mockLayoutService,
    mockOptimisticState,
    mockUiState,
    mockActionQueue,
    mockAuthService,
    mockLoggerCategory,
    mockToastService,
    restoreConsole: () => {
      consoleWarnSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    },
  };
}
