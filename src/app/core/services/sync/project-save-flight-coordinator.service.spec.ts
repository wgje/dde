import { Injector, runInInjectionContext } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Project } from '../../../../models';
import { ChangeTrackerService } from '../../../../services/change-tracker.service';
import { LoggerService } from '../../../../services/logger.service';
import { SessionManagerService } from './session-manager.service';
import { BatchSyncService } from './batch-sync.service';
import { ProjectSaveFlightCoordinatorService, type ProjectSaveResult } from './project-save-flight-coordinator.service';
import { RetryQueueService } from './retry-queue.service';
import { SyncStateService } from './sync-state.service';

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

  beforeEach(() => {
    saveProjectToCloud = vi.fn();
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
});
