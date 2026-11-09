import { Injector, runInInjectionContext, type Provider } from '@angular/core';
import { expect, it, vi } from 'vitest';

import type { Project } from '../models';
import { SyncCoordinatorService, type ConflictEvent } from './sync-coordinator.service';

type SpecMock = ReturnType<typeof vi.fn>;

interface SyncCoordinatorConflictRehydrateSpecContext {
  buildCoordinatorProviders: () => Provider[];
  createTestProject: (overrides?: Partial<Project>) => Project;
  mockConflictStorageService: {
    getAllConflicts: SpecMock;
  };
  mockSyncService: {
    setConflict: SpecMock;
  };
}

export function registerSyncCoordinatorConflictRehydrateSpecs(
  context: SyncCoordinatorConflictRehydrateSpecContext,
): void {
  it('initialize 应从冲突隔离区恢复并重新发布一次待解决冲突', async () => {
    const localProject = context.createTestProject({
      id: 'project-rehydrate',
      name: 'Local persisted conflict',
      version: 2,
    });
    const remoteProject = context.createTestProject({
      id: 'project-rehydrate',
      name: 'Remote persisted conflict',
      version: 3,
    });
    const operationConflicts = [{
      actionType: 'connection:update' as const,
      entityType: 'connection' as const,
      entityId: 'conn-rehydrate',
      projectId: 'project-rehydrate',
      operationId: 'op-conn-rehydrate',
      localEntity: {
        id: 'conn-rehydrate',
        source: 'task-a',
        target: 'task-b',
        title: 'Local link',
      },
      remoteEntity: {
        id: 'conn-rehydrate',
        source: 'task-a',
        target: 'task-c',
        title: 'Remote link',
      },
      message: 'Remote connection is newer',
      conflictedAt: '2026-06-27T00:01:00.000Z',
      reason: 'remote-newer' as const,
    }];
    context.mockConflictStorageService.getAllConflicts.mockReset();
    context.mockConflictStorageService.getAllConflicts.mockResolvedValue([{
      projectId: 'project-rehydrate',
      localProject,
      remoteProject,
      remoteSnapshotFresh: true,
      conflictedAt: '2026-06-27T00:00:00.000Z',
      pendingTaskDeleteIds: ['task-deleted'],
      pendingTaskDeleteBaseUpdatedAtMap: {
        'task-deleted': '2026-06-26T00:00:00.000Z',
      },
      localVersion: 2,
      remoteVersion: 3,
      reason: 'version_mismatch',
      operationConflicts,
      acknowledged: false,
    }]);
    context.mockSyncService.setConflict.mockClear();

    const startupInjector = Injector.create({
      providers: context.buildCoordinatorProviders(),
    });
    const startupService = runInInjectionContext(
      startupInjector,
      () => new SyncCoordinatorService(),
    );
    const events: ConflictEvent[] = [];
    const subscription = startupService.onConflict$.subscribe(event => events.push(event));

    startupService.initialize();
    await Promise.resolve();

    expect(context.mockSyncService.setConflict).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-rehydrate',
      local: localProject,
      remote: remoteProject,
      pendingTaskDeleteIds: ['task-deleted'],
      pendingTaskDeleteBaseUpdatedAtMap: {
        'task-deleted': '2026-06-26T00:00:00.000Z',
      },
      operationConflicts,
    }));
    expect(events).toEqual([{
      localProject,
      remoteProject,
      projectId: 'project-rehydrate',
      pendingTaskDeleteIds: ['task-deleted'],
      pendingTaskDeleteBaseUpdatedAtMap: {
        'task-deleted': '2026-06-26T00:00:00.000Z',
      },
      operationConflicts,
    }]);

    subscription.unsubscribe();
  });
}
