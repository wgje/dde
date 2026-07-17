import { DestroyRef, Injector } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import { ProjectDataService } from '../core-bridge';
import { SYNC_CONFIG } from '../config/sync.config';
import type { Connection, Project, Task } from '../models';
import { createMockDestroyRef } from '../test-setup-destroy-ref.mock';
import { ActionQueueService } from './action-queue.service';
import { AuthService } from './auth.service';
import { ChangeTrackerService } from './change-tracker.service';
import { LoggerService } from './logger.service';
import { PersistSchedulerService } from './persist-scheduler.service';
import { ProjectStateService } from './project-state.service';
import { ProjectSyncOperationsService } from './project-sync-operations.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { SyncCoordinatorRuntimeService } from './sync-coordinator-runtime.service';
import { TabSyncService } from './tab-sync.service';

describe('SyncCoordinatorRuntimeService', () => {
  const FIXTURE_CREATED_AT = '2026-07-14T00:00:00.000Z';
  const FIXTURE_UPDATED_AT = '2026-07-14T00:00:05.000Z';

  type DurableSnapshotWrite = (projects: Project[], ownerUserId?: string | null) => Promise<void>;

  function createTaskFixture(overrides: {
    id: string;
    title: string;
    content: string;
    displayId: string;
    order?: number;
    rank?: number;
    x?: number;
    y?: number;
    updatedAt?: string;
  }): Task {
    return {
      id: overrides.id,
      title: overrides.title,
      content: overrides.content,
      stage: null,
      parentId: null,
      order: overrides.order ?? 0,
      rank: overrides.rank ?? overrides.order ?? 0,
      status: 'active',
      x: overrides.x ?? 0,
      y: overrides.y ?? 0,
      createdDate: FIXTURE_CREATED_AT,
      updatedAt: overrides.updatedAt ?? FIXTURE_UPDATED_AT,
      displayId: overrides.displayId,
    };
  }

  function createConnectionFixture(overrides: {
    id: string;
    source: string;
    target: string;
    updatedAt?: string;
  }): Connection {
    return {
      id: overrides.id,
      source: overrides.source,
      target: overrides.target,
      updatedAt: overrides.updatedAt ?? FIXTURE_UPDATED_AT,
    };
  }

  function createProjectFixture(overrides: {
    id?: string;
    name?: string;
    description?: string;
    createdDate?: string;
    updatedAt?: string;
    tasks?: Task[];
    connections?: Connection[];
    version?: number;
  } = {}): Project {
    return {
      id: overrides.id ?? crypto.randomUUID(),
      name: overrides.name ?? 'Autosave Project',
      description: overrides.description ?? 'Project fixture for runtime autosave tests.',
      createdDate: overrides.createdDate ?? FIXTURE_CREATED_AT,
      updatedAt: overrides.updatedAt ?? FIXTURE_UPDATED_AT,
      tasks: overrides.tasks ?? [],
      connections: overrides.connections ?? [],
      version: overrides.version ?? 1,
    };
  }

  function createRuntimeHarness(options: {
    currentUserId?: () => string | null;
    projects?: () => Project[];
    currentProjects?: () => Project[];
    saveOfflineSnapshotAndWaitImpl?: DurableSnapshotWrite;
    useRealPersistScheduler?: boolean;
  } = {}) {
    const validateProcessors = vi.fn().mockReturnValue([]);
    const getRegisteredProcessorTypes = vi.fn().mockReturnValue([]);
    const setCallbacks = vi.fn();
    const saveOfflineSnapshotAndWait = vi.fn<DurableSnapshotWrite>(
      options.saveOfflineSnapshotAndWaitImpl ?? (async () => undefined),
    );
    const saveOfflineSnapshot = vi.fn((projects: Project[], ownerUserId?: string | null) => {
      void saveOfflineSnapshotAndWait(projects, ownerUserId).catch(() => undefined);
    });
    const logger = {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    };
    const { destroyRef, destroy } = createMockDestroyRef();

    const persistSchedulerProvider = options.useRealPersistScheduler
      ? { provide: PersistSchedulerService, useClass: PersistSchedulerService }
      : {
        provide: PersistSchedulerService,
        useValue: {
          setCallbacks,
          startLocalAutosave: vi.fn(),
        },
      };

    const injector = Injector.create({
      providers: [
        { provide: SyncCoordinatorRuntimeService, useClass: SyncCoordinatorRuntimeService },
        { provide: DestroyRef, useValue: destroyRef as DestroyRef },
        {
          provide: ActionQueueService,
          useValue: {
            validateProcessors,
            getRegisteredProcessorTypes,
          },
        },
        { provide: AuthService, useValue: { currentUserId: vi.fn(() => options.currentUserId?.() ?? 'user-1') } },
        { provide: ChangeTrackerService, useValue: { hasProjectChanges: vi.fn(() => false) } },
        {
          provide: LoggerService,
          useValue: {
            category: vi.fn(() => logger),
          },
        },
        persistSchedulerProvider,
        {
          provide: ProjectDataService,
          useValue: {
            loadOfflineSnapshot: vi.fn(() => []),
            saveOfflineSnapshot,
            saveOfflineSnapshotAndWait,
          },
        },
        {
          provide: ProjectStateService,
          useValue: {
            projects: vi.fn(() => options.projects?.() ?? []),
            getProjectsWithCurrentData: vi.fn(() => options.currentProjects?.() ?? options.projects?.() ?? []),
            updateProjects: vi.fn(),
          },
        },
        {
          provide: ProjectSyncOperationsService,
          useValue: {
            validateAndRebalance: vi.fn(project => project),
          },
        },
        {
          provide: SentryLazyLoaderService,
          useValue: {
            addBreadcrumb: vi.fn(),
          },
        },
        {
          provide: TabSyncService,
          useValue: {
            setOnDataSyncedCallback: vi.fn(),
          },
        },
      ],
    });

    return {
      service: injector.get(SyncCoordinatorRuntimeService),
      validateProcessors,
      setCallbacks,
      saveOfflineSnapshot,
      saveOfflineSnapshotAndWait,
      logger,
      destroy,
    };
  }

  it('requires the attachment create processor before action queue replay is marked ready', () => {
    const { service, validateProcessors } = createRuntimeHarness();

    service.validateRequiredProcessors();

    expect(validateProcessors).toHaveBeenCalledWith(expect.arrayContaining([
      'attachment:create',
    ]));
  });

  it('自动快照去重应按 owner 隔离相同项目签名', async () => {
    let ownerUserId = 'owner-a';
    const projects = [createProjectFixture({ id: crypto.randomUUID() })];
    const { service, setCallbacks, saveOfflineSnapshot, saveOfflineSnapshotAndWait } = createRuntimeHarness({
      currentUserId: () => ownerUserId,
      projects: () => projects,
      currentProjects: () => projects,
    });
    service.startLocalAutosave();
    const callbacks = setCallbacks.mock.calls[0]?.[0] as {
      saveSnapshot: () => Promise<void>;
    };

    await callbacks.saveSnapshot();
    ownerUserId = 'owner-b';
    await callbacks.saveSnapshot();

    expect(saveOfflineSnapshot).not.toHaveBeenCalled();
    expect(saveOfflineSnapshotAndWait).toHaveBeenCalledTimes(2);
    expect(saveOfflineSnapshotAndWait).toHaveBeenNthCalledWith(1, projects, 'owner-a');
    expect(saveOfflineSnapshotAndWait).toHaveBeenNthCalledWith(2, projects, 'owner-b');
  });

  it('autosave persists current entity stores instead of metadata shells', async () => {
    const projectId = crypto.randomUUID();
    const taskId = crypto.randomUUID();
    const siblingTaskId = crypto.randomUUID();
    const connectionId = crypto.randomUUID();
    const task = createTaskFixture({
      id: taskId,
      title: 'Primary task',
      content: 'primary task content',
      displayId: 'T1',
      order: 0,
    });
    const siblingTask = createTaskFixture({
      id: siblingTaskId,
      title: 'Secondary task',
      content: 'secondary task content',
      displayId: 'T2',
      order: 1,
      rank: 1,
      x: 32,
      y: 64,
    });
    const connection = createConnectionFixture({
      id: connectionId,
      source: taskId,
      target: siblingTaskId,
    });
    const currentProject = createProjectFixture({
      id: projectId,
      tasks: [task, siblingTask],
      connections: [connection],
    });
    const metadataShell: Project[] = [{
      ...currentProject,
      tasks: [],
      connections: [],
    }];
    const currentProjectGraph: Project[] = [currentProject];
    const { service, setCallbacks, saveOfflineSnapshot, saveOfflineSnapshotAndWait } = createRuntimeHarness({
      currentUserId: () => 'owner-1',
      projects: () => metadataShell,
      currentProjects: () => currentProjectGraph,
    });
    service.startLocalAutosave();
    const callbacks = setCallbacks.mock.calls[0]?.[0] as {
      saveSnapshot: () => Promise<void>;
    };

    await callbacks.saveSnapshot();

    expect.soft(saveOfflineSnapshot).not.toHaveBeenCalled();
    expect.soft(saveOfflineSnapshotAndWait).toHaveBeenCalledTimes(1);
    expect.soft(saveOfflineSnapshotAndWait).toHaveBeenCalledWith(currentProjectGraph, 'owner-1');
  });

  it('autosave retries the same fingerprint after a failed snapshot write', async () => {
    const projects: Project[] = [createProjectFixture({
      tasks: [createTaskFixture({
        id: crypto.randomUUID(),
        title: 'Retry task',
        content: 'retry me',
        displayId: 'T1',
      })],
    })];
    const saveError = new Error('snapshot write failed');
    const { service, setCallbacks, saveOfflineSnapshotAndWait } = createRuntimeHarness({
      currentUserId: () => 'owner-1',
      projects: () => projects,
      currentProjects: () => projects,
      saveOfflineSnapshotAndWaitImpl: vi.fn()
        .mockRejectedValueOnce(saveError)
        .mockResolvedValueOnce(undefined),
    });
    service.startLocalAutosave();
    const callbacks = setCallbacks.mock.calls[0]?.[0] as {
      saveSnapshot: () => Promise<void>;
    };

    let firstError: unknown = null;
    try {
      await callbacks.saveSnapshot();
    } catch (error) {
      firstError = error;
    }

    await callbacks.saveSnapshot();

    expect.soft(firstError).toBe(saveError);
    expect.soft(saveOfflineSnapshotAndWait).toHaveBeenCalledTimes(2);
  });

  it('autosave retries the same fingerprint through PersistSchedulerService after a failed snapshot write', async () => {
    vi.useFakeTimers();

    const projects: Project[] = [createProjectFixture({
      tasks: [
        createTaskFixture({
          id: crypto.randomUUID(),
          title: 'Scheduler retry task',
          content: 'scheduler boundary retry content',
          displayId: 'T1',
        }),
      ],
    })];
    const saveError = new Error('snapshot write failed');
    const durableWrite = vi.fn<DurableSnapshotWrite>()
      .mockRejectedValueOnce(saveError)
      .mockResolvedValueOnce(undefined);
    const {
      service,
      saveOfflineSnapshot,
      saveOfflineSnapshotAndWait,
      logger,
      destroy,
    } = createRuntimeHarness({
      currentUserId: () => 'owner-1',
      projects: () => projects,
      currentProjects: () => projects,
      saveOfflineSnapshotAndWaitImpl: durableWrite,
      useRealPersistScheduler: true,
    });

    try {
      service.startLocalAutosave();

      await vi.advanceTimersByTimeAsync(SYNC_CONFIG.LOCAL_AUTOSAVE_INTERVAL);
      expect(saveOfflineSnapshot).not.toHaveBeenCalled();
      expect(saveOfflineSnapshotAndWait).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith('本地自动保存快照失败', saveError);

      await vi.advanceTimersByTimeAsync(SYNC_CONFIG.LOCAL_AUTOSAVE_INTERVAL);
      expect(saveOfflineSnapshotAndWait).toHaveBeenCalledTimes(2);
      expect(saveOfflineSnapshotAndWait).toHaveBeenNthCalledWith(1, projects, 'owner-1');
      expect(saveOfflineSnapshotAndWait).toHaveBeenNthCalledWith(2, projects, 'owner-1');
    } finally {
      destroy();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
