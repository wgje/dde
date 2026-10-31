import { DestroyRef, Injector, runInInjectionContext } from '@angular/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConnectionStore, ProjectStore, TaskStore } from '../app/core/state/stores';
import { RetryQueueService } from '../app/core/services/sync/retry-queue.service';
import {
  createRetryQueueServiceSpecHarness,
  type RetryQueueServiceSpecHarness,
} from '../app/core/services/sync/retry-queue-service.spec-fixture';
import type { Connection, Project, Task } from '../models';
import { ProjectDataService, TaskSyncOperationsService } from '../core-bridge';
import { ActionQueueService } from './action-queue.service';
import { AuthService } from './auth.service';
import { ChangeTrackerService } from './change-tracker.service';
import { LayoutService } from './layout.service';
import { LoggerService } from './logger.service';
import { PermissionDeniedHandlerService } from './permission-denied-handler.service';
import { ProjectStateService } from './project-state.service';
import {
  RemoteChangeHandlerService,
  type RemoteProjectChangePayload,
} from './remote-change-handler.service';
import { SyncCoordinatorService } from './sync-coordinator.service';
import { ToastService } from './toast.service';
import { UiStateService } from './ui-state.service';
import { UndoService } from './undo.service';
import { UserSessionService } from './user-session.service';

const OWNER_A = '00000000-0000-4000-8000-0000000000a1';
const OWNER_B = '00000000-0000-4000-8000-0000000000b2';
const PROJECT_ID = '00000000-0000-4000-8000-000000000101';
const TASK_ID = '00000000-0000-4000-8000-000000000201';
const CONNECTION_ID = '00000000-0000-4000-8000-000000000301';
const LOCAL_UPDATED_AT = '2026-07-26T02:00:00.000Z';
const CLOUD_UPDATED_AT = '2026-07-26T01:00:00.000Z';

interface PendingStateContext {
  actionQueue: {
    getPendingActionsForProject: (projectId: string) => unknown[];
    subscribeToQueueSettled?: (listener: () => void) => () => void;
  };
  retryQueue: RetryQueueService;
  authService: {
    currentUserId: () => string | null;
  };
}

type ProjectChangeCallback = (payload: RemoteProjectChangePayload) => Promise<void>;

interface RemoteChangeHandlerHarness {
  service: RemoteChangeHandlerService;
  projectChange: ProjectChangeCallback;
  getAccessibleProjectProbe: ReturnType<typeof vi.fn>;
  setCurrentUserId: (userId: string) => void;
  destroy: () => void;
}

interface UserSessionDataSafetyHarness {
  projectState: ProjectStateService;
  syncCoordinator: {
    hasPendingChangesForProject: (projectId: string, ownerUserId?: string) => boolean;
  };
  changeTracker: {
    hasProjectChanges: (projectId: string) => boolean;
  };
  supabase: {
    isOfflineMode: () => boolean;
  };
  logger: {
    debug: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  hydratedProjectIds: Set<string>;
  shouldAbortStaleSession: () => boolean;
  isSupabaseSessionCurrentForUser: () => Promise<boolean>;
  getPersistedGuestDraftProjectIds: () => Set<string>;
  setProjectAuthoritativeAccessibility: ReturnType<typeof vi.fn>;
  saveProjectsToOfflineSnapshot: ReturnType<typeof vi.fn>;
  loadProjectForHydration: ReturnType<typeof vi.fn>;
  doHydrateProject: (projectId: string, userId: string) => Promise<void>;
  reconcileInaccessibleHydrationProject: (projectId: string, userId: string) => Promise<void>;
}

let retryQueueHarness: RetryQueueServiceSpecHarness | null = null;

afterEach(async () => {
  await retryQueueHarness?.teardown();
  retryQueueHarness = null;
  vi.restoreAllMocks();
  localStorage.clear();
});

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    title: 'Local task',
    content: 'local content must survive',
    stage: 2,
    parentId: null,
    order: 0,
    rank: 1000,
    status: 'active',
    x: 10,
    y: 20,
    createdDate: '2026-07-26T00:00:00.000Z',
    updatedAt: LOCAL_UPDATED_AT,
    displayId: '1',
    ...overrides,
  };
}

function connection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: CONNECTION_ID,
    source: TASK_ID,
    target: TASK_ID,
    title: 'Local connection',
    updatedAt: LOCAL_UPDATED_AT,
    ...overrides,
  };
}

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: PROJECT_ID,
    name: 'Data safety project',
    description: '',
    createdDate: '2026-07-26T00:00:00.000Z',
    updatedAt: LOCAL_UPDATED_AT,
    version: 1,
    syncSource: 'synced',
    pendingSync: false,
    tasks: [task()],
    connections: [connection()],
    ...overrides,
  };
}

function createRealProjectState(): ProjectStateService {
  const injector = Injector.create({
    providers: [
      { provide: TaskStore, useValue: new TaskStore() },
      { provide: ProjectStore, useValue: new ProjectStore() },
      { provide: ConnectionStore, useValue: new ConnectionStore() },
      { provide: LayoutService, useValue: {} },
      { provide: UiStateService, useValue: { isEditing: false, filterMode: () => 'all' } },
    ],
  });
  return runInInjectionContext(injector, () => new ProjectStateService());
}

function createPendingStateReader(
  retryQueue: RetryQueueService,
  currentOwnerUserId = OWNER_A,
  actionQueue: PendingStateContext['actionQueue'] = {
    getPendingActionsForProject: () => [],
  },
): UserSessionDataSafetyHarness['syncCoordinator'] {
  const context: PendingStateContext = {
    actionQueue,
    retryQueue,
    authService: {
      currentUserId: () => currentOwnerUserId,
    },
  };
  const hasPendingChangesForProject = SyncCoordinatorService.prototype
    .hasPendingChangesForProject as unknown as (
      this: PendingStateContext,
      projectId: string,
      ownerUserId?: string,
    ) => boolean;

  return {
    hasPendingChangesForProject: (projectId, ownerUserId) => (
      hasPendingChangesForProject.call(context, projectId, ownerUserId)
    ),
  };
}

function createPendingStateSubscription(
  retryQueue: RetryQueueService,
  listener: () => void,
  actionQueue: PendingStateContext['actionQueue'],
): () => void {
  const subscribe = (
    SyncCoordinatorService.prototype as unknown as {
      subscribeToProjectPendingWriteStateChanges?: (
        this: PendingStateContext,
        callback: () => void,
      ) => () => void;
    }
  ).subscribeToProjectPendingWriteStateChanges;
  if (!subscribe) return () => {};
  return subscribe.call({
    actionQueue,
    retryQueue,
    authService: { currentUserId: () => OWNER_A },
  }, listener);
}

function createUserSessionHarness(
  projectState: ProjectStateService,
  retryQueue: RetryQueueService,
  cloudProject: Project = project(),
): UserSessionDataSafetyHarness {
  const harness = Object.create(UserSessionService.prototype) as UserSessionDataSafetyHarness;
  Object.assign(harness, {
    projectState,
    syncCoordinator: createPendingStateReader(retryQueue),
    changeTracker: { hasProjectChanges: () => false },
    supabase: { isOfflineMode: () => false },
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    hydratedProjectIds: new Set<string>(),
    shouldAbortStaleSession: () => false,
    isSupabaseSessionCurrentForUser: async () => true,
    getPersistedGuestDraftProjectIds: () => new Set<string>(),
    setProjectAuthoritativeAccessibility: vi.fn(),
    saveProjectsToOfflineSnapshot: vi.fn().mockResolvedValue(undefined),
    loadProjectForHydration: vi.fn().mockResolvedValue({
      status: 'loaded',
      project: cloudProject,
    }),
  });
  return harness;
}

function createRetryQueueHarness(options: Parameters<typeof createRetryQueueServiceSpecHarness>[0] = {}) {
  retryQueueHarness = createRetryQueueServiceSpecHarness(options);
  retryQueueHarness.authServiceMock.currentUserId.mockReturnValue(OWNER_A);
  return retryQueueHarness;
}

function createRemoteChangeHandlerHarness(
  projectState: ProjectStateService,
  retryQueue: RetryQueueService,
): RemoteChangeHandlerHarness {
  let projectChange: ProjectChangeCallback | null = null;
  const destroyCallbacks: Array<() => void> = [];
  const actionQueue = {
    getPendingActionsForProject: vi.fn(() => []),
    subscribeToQueueSettled: vi.fn(() => () => {}),
    hasPendingActions: vi.fn(() => false),
    hasDurablePendingTaskMutation: vi.fn(() => false),
  };
  const pendingState = createPendingStateReader(retryQueue, OWNER_A, actionQueue);
  const getAccessibleProjectProbe = vi.fn().mockResolvedValue({ accessible: false });
  const syncCoordinator = {
    ...pendingState,
    subscribeToProjectPendingWriteStateChanges: (listener: () => void) => (
      createPendingStateSubscription(retryQueue, listener, actionQueue)
    ),
    setupRemoteChangeCallbacks: vi.fn((callback: ProjectChangeCallback) => {
      projectChange = callback;
    }),
    hasPendingLocalChanges: vi.fn(() => false),
    getLastPersistAt: vi.fn(() => 0),
    getAccessibleProjectProbe,
    validateAndRebalance: vi.fn((value: Project) => value),
    smartMerge: vi.fn(),
  };
  const userSession = {
    currentUserId: vi.fn(() => OWNER_A),
    getCurrentSessionGeneration: vi.fn(() => 1),
    isSessionContextCurrent: vi.fn((generation: number, userId: string) => (
      generation === 1 && userId === OWNER_A
    )),
  };
  const injector = Injector.create({
    providers: [
      { provide: SyncCoordinatorService, useValue: syncCoordinator },
      { provide: ActionQueueService, useValue: actionQueue },
      { provide: ProjectDataService, useValue: {} },
      { provide: TaskSyncOperationsService, useValue: {} },
      { provide: UndoService, useValue: {
        clearOutdatedHistory: vi.fn(),
        clearTaskHistory: vi.fn(),
      } },
      { provide: UiStateService, useValue: { isEditing: false } },
      { provide: ProjectStateService, useValue: projectState },
      { provide: ToastService, useValue: { info: vi.fn(), warning: vi.fn() } },
      { provide: AuthService, useValue: { currentUserId: vi.fn(() => OWNER_A) } },
      { provide: UserSessionService, useValue: userSession },
      { provide: LoggerService, useValue: {
        category: () => ({
          debug: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        }),
      } },
      { provide: ChangeTrackerService, useValue: {
        getLockedFields: vi.fn(() => []),
        pruneExpiredChanges: vi.fn(),
        getPendingChange: vi.fn(() => null),
      } },
      { provide: PermissionDeniedHandlerService, useValue: {} },
      { provide: DestroyRef, useValue: {
        onDestroy: (callback: () => void) => {
          destroyCallbacks.push(callback);
          return () => {};
        },
      } },
    ],
  });
  const service = runInInjectionContext(injector, () => new RemoteChangeHandlerService());
  service.setupCallbacks(vi.fn().mockResolvedValue(undefined));
  if (!projectChange) throw new Error('Remote project change callback was not registered');

  return {
    service,
    projectChange,
    getAccessibleProjectProbe,
    setCurrentUserId: userId => userSession.currentUserId.mockReturnValue(userId),
    destroy: () => {
      for (const callback of destroyCallbacks) callback();
    },
  };
}

async function flushAsyncWork(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

function enqueueOwnerATaskWrite(retryQueue: RetryQueueService, localTask: Task): void {
  expect(retryQueue.add(
    'task',
    'upsert',
    localTask,
    PROJECT_ID,
    OWNER_A,
    undefined,
    undefined,
    undefined,
    crypto.randomUUID(),
  )).toBe(true);
  expect(retryQueue.getProjectPendingWriteState(PROJECT_ID, OWNER_A)).toBe('pending');
}

describe('UserSession RetryQueue and Store data safety', () => {
  it('RetryQueue-only 本地写在真实 Store 水合后保留 stage、content 与 connection', async () => {
    const projectState = createRealProjectState();
    const localProject = project();
    projectState.setProjects([localProject]);
    const retryQueue = createRetryQueueHarness().service;
    enqueueOwnerATaskWrite(retryQueue, localProject.tasks[0]!);
    const cloudProject = project({
      updatedAt: CLOUD_UPDATED_AT,
      tasks: [task({
        title: 'Stale cloud task',
        content: 'stale cloud content',
        stage: null,
        updatedAt: CLOUD_UPDATED_AT,
      })],
      connections: [],
    });
    const userSession = createUserSessionHarness(projectState, retryQueue, cloudProject);

    await userSession.doHydrateProject(PROJECT_ID, OWNER_A);

    const hydrated = projectState.getProjectWithCurrentData(PROJECT_ID);
    expect(hydrated?.tasks[0]).toMatchObject({
      id: TASK_ID,
      stage: 2,
      content: 'local content must survive',
      updatedAt: LOCAL_UPDATED_AT,
    });
    expect(hydrated?.connections).toEqual([connection()]);
  });

  it('远端 inaccessible 时 owner pending 写保留真实 Store 数据并降级为 local-only', async () => {
    const projectState = createRealProjectState();
    const localProject = project();
    projectState.setProjects([localProject]);
    const retryQueue = createRetryQueueHarness().service;
    enqueueOwnerATaskWrite(retryQueue, localProject.tasks[0]!);
    const userSession = createUserSessionHarness(projectState, retryQueue);

    await userSession.reconcileInaccessibleHydrationProject(PROJECT_ID, OWNER_A);

    const preserved = projectState.getProjectWithCurrentData(PROJECT_ID);
    expect(preserved).toMatchObject({ syncSource: 'local-only', pendingSync: true });
    expect(preserved?.tasks).toEqual(localProject.tasks);
    expect(preserved?.connections).toEqual(localProject.connections);
  });

  it('RetryQueue storage unknown 时远端 inaccessible 仍保留真实 Store 数据', async () => {
    const projectState = createRealProjectState();
    const localProject = project();
    projectState.setProjects([localProject]);
    const retryQueue = createRetryQueueHarness().service;
    retryQueue.clearCurrentView();
    expect(retryQueue.getProjectPendingWriteState(PROJECT_ID, OWNER_A)).toBe('unknown');
    const userSession = createUserSessionHarness(projectState, retryQueue);

    await userSession.reconcileInaccessibleHydrationProject(PROJECT_ID, OWNER_A);

    const preserved = projectState.getProjectWithCurrentData(PROJECT_ID);
    expect(preserved).toMatchObject({ syncSource: 'local-only', pendingSync: true });
    expect(preserved?.tasks).toEqual(localProject.tasks);
    expect(preserved?.connections).toEqual(localProject.connections);
  });

  it('foreign owner RetryQueue 写在当前 owner 已确认 clear 后不保护其项目', async () => {
    const projectState = createRealProjectState();
    projectState.setProjects([project()]);
    const retryQueue = createRetryQueueHarness({ useRealLoadFromStorage: true }).service;
    await retryQueue.reloadFromStorageForCurrentOwner();
    expect(retryQueue.getProjectPendingWriteState(PROJECT_ID, OWNER_A)).toBe('clear');
    expect(retryQueue.add(
      'task',
      'upsert',
      task(),
      PROJECT_ID,
      OWNER_B,
      undefined,
      undefined,
      undefined,
      crypto.randomUUID(),
    )).toBe(true);
    expect(retryQueue.getProjectPendingWriteState(PROJECT_ID, OWNER_A)).toBe('clear');
    const userSession = createUserSessionHarness(projectState, retryQueue);

    await userSession.reconcileInaccessibleHydrationProject(PROJECT_ID, OWNER_A);

    expect(projectState.getProjectWithCurrentData(PROJECT_ID)).toBeUndefined();
  });
});

describe('Realtime project DELETE data safety', () => {
  it('当前 owner RetryQueue pending 时延迟远程 DELETE', async () => {
    const projectState = createRealProjectState();
    const localProject = project();
    projectState.setProjects([localProject]);
    const retryQueue = createRetryQueueHarness().service;
    enqueueOwnerATaskWrite(retryQueue, localProject.tasks[0]!);
    const remote = createRemoteChangeHandlerHarness(projectState, retryQueue);

    await remote.projectChange({ eventType: 'DELETE', projectId: PROJECT_ID });

    expect(projectState.getProjectWithCurrentData(PROJECT_ID)).toEqual(localProject);
    expect(remote.getAccessibleProjectProbe).not.toHaveBeenCalled();
    remote.destroy();
  });

  it('RetryQueue storage unknown 时延迟远程 DELETE', async () => {
    const projectState = createRealProjectState();
    const localProject = project();
    projectState.setProjects([localProject]);
    const retryQueue = createRetryQueueHarness().service;
    retryQueue.clearCurrentView();
    expect(retryQueue.getProjectPendingWriteState(PROJECT_ID, OWNER_A)).toBe('unknown');
    const remote = createRemoteChangeHandlerHarness(projectState, retryQueue);

    await remote.projectChange({ eventType: 'DELETE', projectId: PROJECT_ID });

    expect(projectState.getProjectWithCurrentData(PROJECT_ID)).toEqual(localProject);
    expect(remote.getAccessibleProjectProbe).not.toHaveBeenCalled();
    remote.destroy();
  });

  it('RetryQueue settle 为 clear 后经远端不可访问探针确认再应用延迟 DELETE', async () => {
    const projectState = createRealProjectState();
    const localProject = project();
    projectState.setProjects([localProject]);
    const retryQueue = createRetryQueueHarness({ useRealLoadFromStorage: true }).service;
    await retryQueue.reloadFromStorageForCurrentOwner();
    enqueueOwnerATaskWrite(retryQueue, localProject.tasks[0]!);
    const remote = createRemoteChangeHandlerHarness(projectState, retryQueue);
    await remote.projectChange({ eventType: 'DELETE', projectId: PROJECT_ID });
    expect(projectState.getProjectWithCurrentData(PROJECT_ID)).toEqual(localProject);

    retryQueue.removeByEntityId(TASK_ID);
    expect(retryQueue.getProjectPendingWriteState(PROJECT_ID, OWNER_A)).toBe('clear');
    await flushAsyncWork();

    expect(remote.getAccessibleProjectProbe).toHaveBeenCalledWith(PROJECT_ID);
    expect(projectState.getProjectWithCurrentData(PROJECT_ID)).toBeUndefined();
    remote.destroy();
  });

  it('延迟 DELETE 重评估探针未知时继续保留本地项目', async () => {
    const projectState = createRealProjectState();
    const localProject = project();
    projectState.setProjects([localProject]);
    const retryQueue = createRetryQueueHarness({ useRealLoadFromStorage: true }).service;
    await retryQueue.reloadFromStorageForCurrentOwner();
    enqueueOwnerATaskWrite(retryQueue, localProject.tasks[0]!);
    const remote = createRemoteChangeHandlerHarness(projectState, retryQueue);
    remote.getAccessibleProjectProbe.mockResolvedValue(null);
    await remote.projectChange({ eventType: 'DELETE', projectId: PROJECT_ID });

    retryQueue.removeByEntityId(TASK_ID);
    await flushAsyncWork();

    expect(remote.getAccessibleProjectProbe).toHaveBeenCalledWith(PROJECT_ID);
    expect(projectState.getProjectWithCurrentData(PROJECT_ID)).toEqual(localProject);
    remote.destroy();
  });

  it('owner 切换后旧会话的延迟 DELETE 不得删除新 owner 的同 ID 项目', async () => {
    const projectState = createRealProjectState();
    const localProject = project();
    projectState.setProjects([localProject]);
    const retryQueue = createRetryQueueHarness().service;
    enqueueOwnerATaskWrite(retryQueue, localProject.tasks[0]!);
    const remote = createRemoteChangeHandlerHarness(projectState, retryQueue);

    await remote.projectChange({ eventType: 'DELETE', projectId: PROJECT_ID });
    const ownerBProject = project({ name: 'Owner B project' });
    projectState.setProjects([ownerBProject]);
    remote.setCurrentUserId(OWNER_B);
    retryQueue.removeByEntityId(TASK_ID);
    await flushAsyncWork();

    expect(remote.getAccessibleProjectProbe).not.toHaveBeenCalled();
    expect(projectState.getProjectWithCurrentData(PROJECT_ID)).toEqual(ownerBProject);
    remote.destroy();
  });
});
