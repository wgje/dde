import { Injector, runInInjectionContext } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Project } from '../../../../models';
import { ChangeTrackerService } from '../../../../services/change-tracker.service';
import { LoggerService } from '../../../../services/logger.service';
import { SessionRuntimeResetRegistry } from '../../../../services/session-runtime-reset.service';
import { SessionManagerService } from './session-manager.service';
import { BatchSyncService } from './batch-sync.service';
import { ProjectSaveFlightCoordinatorService, type ProjectSaveResult } from './project-save-flight-coordinator.service';
import { RetryQueueService } from './retry-queue.service';
import { SyncStateService } from './sync-state.service';

const OPERATION_A = '00000000-0000-4000-8000-0000000000a1';
const OPERATION_B = '00000000-0000-4000-8000-0000000000b2';
const OPERATION_C = '00000000-0000-4000-8000-0000000000c3';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

function createProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-1',
    name: 'Project 1',
    description: '',
    createdDate: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    version: 1,
    tasks: [],
    connections: [],
    ...overrides,
  };
}

describe('ProjectSaveFlightCoordinatorService', () => {
  let service: ProjectSaveFlightCoordinatorService;
  let saveProjectToCloud: ReturnType<typeof vi.fn>;
  let loggerCategory: {
    debug: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  let resetRuntime: (() => void) | undefined;

  beforeEach(() => {
    saveProjectToCloud = vi.fn();
    resetRuntime = undefined;
    loggerCategory = {
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const injector = Injector.create({
      providers: [
        { provide: ProjectSaveFlightCoordinatorService, useClass: ProjectSaveFlightCoordinatorService },
        {
          provide: BatchSyncService,
          useValue: { saveProjectToCloud },
        },
        {
          provide: LoggerService,
          useValue: { category: vi.fn(() => loggerCategory) },
        },
        {
          provide: ChangeTrackerService,
          useValue: {
            getProjectChanges: vi.fn(() => ({
              taskIdsToDelete: [],
              taskDeleteBaseUpdatedAtMap: {},
            })),
          },
        },
        {
          provide: RetryQueueService,
          useValue: {
            length: 1,
            hasProjectRetryForOwner: vi.fn(() => true),
            removeByProjectIdForOwner: vi.fn(() => 0),
          },
        },
        {
          provide: SyncStateService,
          useValue: { update: vi.fn() },
        },
        {
          provide: SessionManagerService,
          useValue: { getRecentValidationSnapshot: vi.fn(() => null) },
        },
        {
          provide: SessionRuntimeResetRegistry,
          useValue: {
            register: vi.fn((_owner: string, reset: () => void) => {
              resetRuntime = reset;
              return vi.fn();
            }),
          },
        },
      ],
    });

    service = runInInjectionContext(injector, () => injector.get(ProjectSaveFlightCoordinatorService));
  });

  it('replays the queued save when retry payload refresh throws during failed flight settlement', async () => {
    const activeSave = createDeferred<ProjectSaveResult>();
    const queuedReplay = createDeferred<ProjectSaveResult>();
    const activeFailure: ProjectSaveResult = {
      success: false,
      retryEnqueued: ['project:project-1'],
      failureReason: 'network offline',
    };
    const queuedSuccess: ProjectSaveResult = {
      success: true,
      projectPushed: true,
    };

    saveProjectToCloud
      .mockReturnValueOnce(activeSave.promise)
      .mockReturnValueOnce(queuedReplay.promise);
    service.durableRetryHandler = vi.fn().mockRejectedValue(new Error('retry store unavailable'));

    const activePromise = service.save(createProject(), 'user-1');
    const queuedPromise = service.save(
      createProject({ name: 'Project 1 updated', updatedAt: '2026-06-01T00:01:00.000Z' }),
      'user-1',
    );

    activeSave.resolve(activeFailure);
    await expect(activePromise).resolves.toEqual(activeFailure);

    // 结算链经由 .then 微任务推进，但测试矩阵并行 CPU 饱和时单次 setTimeout(0)
    // 等待可能不够；改为条件轮询，消除负载相关的超时抖动
    await vi.waitFor(() => {
      expect(service.durableRetryHandler).toHaveBeenCalledTimes(1);
      expect(saveProjectToCloud).toHaveBeenCalledTimes(2);
    }, { timeout: 8000 });

    queuedReplay.resolve(queuedSuccess);
    await expect(queuedPromise).resolves.toEqual(queuedSuccess);
  }, 10_000);

  it('A-B-A session reset 后同 owner/project 保存不得复用旧代际 active promise', async () => {
    const staleSave = createDeferred<ProjectSaveResult>();
    const currentSave = createDeferred<ProjectSaveResult>();
    saveProjectToCloud.mockReturnValueOnce(staleSave.promise).mockReturnValueOnce(currentSave.promise);

    const stalePromise = service.save(createProject(), 'user-1');
    expect(resetRuntime).toBeTypeOf('function');
    resetRuntime?.();
    const currentPromise = service.save(createProject(), 'user-1');

    expect(saveProjectToCloud).toHaveBeenCalledTimes(2);
    currentSave.resolve({ success: true });
    await expect(currentPromise).resolves.toEqual({ success: true });
    const sessionChanged = { success: false, failureReason: 'project sync session changed' };
    staleSave.resolve(sessionChanged);
    await expect(stalePromise).resolves.toEqual(sessionChanged);
  });

  it('旧代际 active 结算后不得自动推进 reset 前排队的保存快照', async () => {
    const activeSave = createDeferred<ProjectSaveResult>();
    saveProjectToCloud.mockReturnValueOnce(activeSave.promise);
    service.durableRetryHandler = vi.fn().mockRejectedValue(new Error('retry store unavailable'));

    const activePromise = service.save(createProject(), 'user-1');
    const queuedPromise = service.save(
      createProject({ name: 'Queued stale snapshot', updatedAt: '2026-06-01T00:01:00.000Z' }),
      'user-1',
    );
    resetRuntime?.();
    const sessionChanged = { success: false, failureReason: 'project sync session changed' };
    activeSave.resolve(sessionChanged);

    await expect(activePromise).resolves.toEqual(sessionChanged);
    await vi.waitFor(() => expect(saveProjectToCloud).toHaveBeenCalledTimes(1));
    await expect(queuedPromise).resolves.toEqual(sessionChanged);
  });

  it('same snapshot with a different operationId queues instead of coalescing', async () => {
    const activeSave = createDeferred<ProjectSaveResult>();
    const queuedSave = createDeferred<ProjectSaveResult>();
    saveProjectToCloud.mockReturnValueOnce(activeSave.promise).mockReturnValueOnce(queuedSave.promise);
    const project = createProject();

    const firstPromise = service.save(project, 'user-1', undefined, undefined, OPERATION_A);
    const secondPromise = service.save(project, 'user-1', undefined, undefined, OPERATION_B);

    expect(saveProjectToCloud).toHaveBeenCalledTimes(1);
    expect(saveProjectToCloud.mock.calls[0]?.[4]).toBe(OPERATION_A);
    activeSave.resolve({ success: true });
    await expect(firstPromise).resolves.toEqual({ success: true });
    await vi.waitFor(() => expect(saveProjectToCloud).toHaveBeenCalledTimes(2));
    expect(saveProjectToCloud.mock.calls[1]?.[4]).toBe(OPERATION_B);
    queuedSave.resolve({ success: true });
    await expect(secondPromise).resolves.toEqual({ success: true });
  });

  it('queued replacement preserves the replacing operationId', async () => {
    const activeSave = createDeferred<ProjectSaveResult>();
    const replacementSave = createDeferred<ProjectSaveResult>();
    saveProjectToCloud.mockReturnValueOnce(activeSave.promise).mockReturnValueOnce(replacementSave.promise);

    const activePromise = service.save(createProject(), 'user-1', undefined, undefined, OPERATION_A);
    const queuedPromise = service.save(
      createProject({ name: 'Queued B', updatedAt: '2026-06-01T00:01:00.000Z' }),
      'user-1', undefined, undefined, OPERATION_B,
    );
    const replacementPromise = service.save(
      createProject({ name: 'Replacement C', updatedAt: '2026-06-01T00:02:00.000Z' }),
      'user-1', undefined, undefined, OPERATION_C,
    );

    expect(saveProjectToCloud.mock.calls[0]?.[4]).toBe(OPERATION_A);
    activeSave.resolve({ success: true });
    await expect(activePromise).resolves.toEqual({ success: true });
    await vi.waitFor(() => expect(saveProjectToCloud).toHaveBeenCalledTimes(2));
    expect(saveProjectToCloud.mock.calls[1]?.[4]).toBe(OPERATION_C);
    replacementSave.resolve({ success: true });
    await expect(queuedPromise).resolves.toEqual({ success: true });
    await expect(replacementPromise).resolves.toEqual({ success: true });
  });
});
