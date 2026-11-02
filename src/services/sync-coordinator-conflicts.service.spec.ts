import { Injector, runInInjectionContext } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import type { Project } from '../models';
import { ProjectDataService, SyncStateService } from '../core-bridge';
import { ConflictResolutionService } from './conflict-resolution.service';
import { ConflictStorageService } from './conflict-storage.service';
import { LoggerService } from './logger.service';
import { SyncCoordinatorConflictService, type ConflictEvent } from './sync-coordinator-conflicts.service';

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createProject(overrides?: Partial<Project>): Project {
  return {
    id: 'project-1',
    name: 'Project',
    description: '',
    createdDate: '2026-06-09T00:00:00.000Z',
    updatedAt: '2026-06-09T00:00:00.000Z',
    tasks: [],
    connections: [],
    version: 1,
    ...overrides,
  };
}

function createService(options?: {
  saveConflict?: ReturnType<typeof vi.fn>;
  getAllConflicts?: ReturnType<typeof vi.fn>;
}) {
  const syncStateService = {
    syncState: vi.fn(() => ({
      hasConflict: false,
      conflictData: null,
    })),
    setConflict: vi.fn(),
    clearConflict: vi.fn(),
  };
  const conflictStorage = {
    saveConflict: options?.saveConflict ?? vi.fn().mockResolvedValue(true),
    getAllConflicts: options?.getAllConflicts ?? vi.fn().mockResolvedValue([]),
  };
  const injector = Injector.create({
    providers: [
      SyncCoordinatorConflictService,
      { provide: ConflictStorageService, useValue: conflictStorage },
      {
        provide: ConflictResolutionService,
        useValue: {
          resolveConflict: vi.fn(),
          resolveConflictWithPlan: vi.fn(),
          smartMerge: vi.fn(),
        },
      },
      { provide: SyncStateService, useValue: syncStateService },
      { provide: ProjectDataService, useValue: { loadFullProject: vi.fn() } },
      {
        provide: LoggerService,
        useValue: {
          category: vi.fn(() => ({
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
          })),
        },
      },
    ],
  });

  return {
    service: runInInjectionContext(injector, () => injector.get(SyncCoordinatorConflictService)),
    conflictStorage,
    syncStateService,
  };
}

describe('SyncCoordinatorConflictService', () => {
  it('publishConflict 应等待冲突隔离区保存完成后再发布 active conflict', async () => {
    const saveConflict = createDeferred<boolean>();
    const localProject = createProject({ name: 'Local', version: 2 });
    const remoteProject = createProject({ name: 'Remote', version: 3 });
    const { service, conflictStorage, syncStateService } = createService({
      saveConflict: vi.fn(() => saveConflict.promise),
    });
    const events: ConflictEvent[] = [];
    service.onConflict$.subscribe(event => events.push(event));

    const publishResult = service.publishConflict(localProject, remoteProject, 'user-1');

    expect(conflictStorage.saveConflict).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-1',
      localProject,
      remoteProject,
      ownerUserId: 'user-1',
      acknowledged: false,
    }));
    expect(syncStateService.setConflict).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);

    saveConflict.resolve(true);
    await publishResult;

    expect(syncStateService.setConflict).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-1',
      local: localProject,
      remote: remoteProject,
    }));
    expect(events).toHaveLength(1);
  });

  it('冲突证据持久化完成前会话失效时不应报告成功', async () => {
    const saveConflict = createDeferred<boolean>();
    const save = vi.fn(() => saveConflict.promise);
    const localProject = createProject({ name: 'Local stale', version: 2 });
    const remoteProject = createProject({ name: 'Remote stale', version: 3 });
    const { service } = createService({ saveConflict: save });
    let current = true;

    const pending = service.saveConflictSilently(
      localProject,
      remoteProject,
      [],
      'user-1',
      undefined,
      undefined,
      undefined,
      () => current,
    );
    expect(save).toHaveBeenCalledOnce();

    current = false;
    saveConflict.resolve(true);

    await expect(pending).resolves.toBe(false);
  });

  it('publishConflict 在冲突隔离区未能持久化时不应发布 active conflict', async () => {
    const localProject = createProject({ name: 'Local Unsafe', version: 2 });
    const remoteProject = createProject({ name: 'Remote Unsafe', version: 3 });
    const { service, syncStateService } = createService({
      saveConflict: vi.fn().mockResolvedValue(false),
    });
    const events: ConflictEvent[] = [];
    service.onConflict$.subscribe(event => events.push(event));

    await service.publishConflict(localProject, remoteProject, 'user-1');

    expect(syncStateService.setConflict).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });

  it('restorePersistedConflictState 应恢复并发布一次带 fresh remote snapshot 的冲突状态', async () => {
    const localProject = createProject({ name: 'Local persisted', version: 2 });
    const remoteProject = createProject({ name: 'Remote persisted', version: 3 });
    const { service, syncStateService } = createService({
      getAllConflicts: vi.fn().mockResolvedValue([{
        projectId: 'project-1',
        localProject,
        remoteProject,
        remoteSnapshotFresh: true,
        conflictedAt: '2026-06-27T00:00:00.000Z',
        pendingTaskDeleteIds: ['task-deleted'],
        pendingTaskDeleteBaseUpdatedAtMap: { 'task-deleted': '2026-06-26T00:00:00.000Z' },
        localVersion: 2,
        remoteVersion: 3,
        reason: 'version_mismatch',
        acknowledged: false,
      }]),
    });
    const events: ConflictEvent[] = [];
    service.onConflict$.subscribe(event => events.push(event));

    await expect(service.restorePersistedConflictState()).resolves.toBe(true);

    expect(syncStateService.setConflict).toHaveBeenCalledWith({
      local: localProject,
      remote: remoteProject,
      projectId: 'project-1',
      conflictedAt: '2026-06-27T00:00:00.000Z',
      pendingTaskDeleteIds: ['task-deleted'],
      pendingTaskDeleteBaseUpdatedAtMap: { 'task-deleted': '2026-06-26T00:00:00.000Z' },
    });
    expect(events).toEqual([{
      localProject,
      remoteProject,
      projectId: 'project-1',
      pendingTaskDeleteIds: ['task-deleted'],
      pendingTaskDeleteBaseUpdatedAtMap: { 'task-deleted': '2026-06-26T00:00:00.000Z' },
    }]);
  });

  it('restorePersistedConflictState 不应恢复缺少 fresh remote snapshot 的冲突', async () => {
    const localProject = createProject({ name: 'Local only persisted', version: 2 });
    const { service, syncStateService } = createService({
      getAllConflicts: vi.fn().mockResolvedValue([{
        projectId: 'project-1',
        localProject,
        remoteSnapshotFresh: false,
        conflictedAt: '2026-06-27T00:00:00.000Z',
        localVersion: 2,
        reason: 'version_mismatch',
        acknowledged: false,
      }]),
    });

    await expect(service.restorePersistedConflictState()).resolves.toBe(false);

    expect(syncStateService.setConflict).not.toHaveBeenCalled();
  });
});
