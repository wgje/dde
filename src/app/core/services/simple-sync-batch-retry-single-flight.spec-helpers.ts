import { beforeEach, expect, it, vi } from 'vitest';

import type { SimpleSyncService } from './simple-sync.service';
import {
  createMockProject,
  createMockTask,
  expectDeferredCallback,
} from './simple-sync.test-harness';

export interface SimpleSyncBatchRetrySingleFlightSpecContext {
  service(): SimpleSyncService;
  mockBatchSync(): any;
}

export function registerSimpleSyncBatchRetrySingleFlightSpecs(
  context: SimpleSyncBatchRetrySingleFlightSpecContext,
): void {
  let service: SimpleSyncService;
  let mockBatchSync: any;

  beforeEach(() => {
    service = context.service();
    mockBatchSync = context.mockBatchSync();
  });

    it('saveProjectToCloud 应该委托给 BatchSyncService', async () => {
      const project = createMockProject({ id: 'project-1', tasks: [], connections: [] });
      mockBatchSync.saveProjectToCloud = vi.fn().mockResolvedValue({ success: true, newVersion: 1 });

      const result = await service.saveProjectToCloud(project, 'test-user-id');

      expect(mockBatchSync.saveProjectToCloud).toHaveBeenCalledWith(project, 'test-user-id', undefined);
      expect(result.success).toBe(true);
    });

    it('saveProjectToCloud 应将调用方 operationId 传入 BatchSyncService', async () => {
      const project = createMockProject({ id: 'project-save-operation-id', tasks: [], connections: [] });
      mockBatchSync.saveProjectToCloud = vi.fn().mockResolvedValue({ success: true, newVersion: 1 });

      const result = await service.saveProjectToCloud(
        project,
        'test-user-id',
        undefined,
        undefined,
        'queued-project-save-op',
      );

      expect(mockBatchSync.saveProjectToCloud).toHaveBeenCalledWith(
        project,
        'test-user-id',
        undefined,
        undefined,
        'queued-project-save-op',
      );
      expect(result.success).toBe(true);
    });

    it('saveProjectToCloud 应该返回 BatchSyncService 的结果', async () => {
      const project = createMockProject({ id: 'project-1', tasks: [], connections: [] });
      mockBatchSync.saveProjectToCloud = vi.fn().mockResolvedValue({
        success: false,
        conflict: true
      });

      const result = await service.saveProjectToCloud(project, 'test-user-id');

      expect(result.success).toBe(false);
      expect(result.conflict).toBe(true);
    });

    it('saveProjectToCloud 应复用同项目的并发请求', async () => {
      const project = createMockProject({
        id: 'project-single-flight',
        updatedAt: '2026-04-11T08:00:00.000Z',
        tasks: [createMockTask({ id: 'task-1', updatedAt: '2026-04-11T08:00:00.000Z' })],
        connections: [],
      });
      let resolveSave: ((value: { success: boolean; newVersion: number }) => void) | null = null;
      mockBatchSync.saveProjectToCloud = vi.fn().mockImplementation(() => new Promise((resolve) => {
        resolveSave = resolve;
      }));

      const firstPromise = service.saveProjectToCloud(project, 'test-user-id');
      const secondPromise = service.saveProjectToCloud({ ...project }, 'test-user-id');

      expect(mockBatchSync.saveProjectToCloud).toHaveBeenCalledTimes(1);

      expectDeferredCallback(resolveSave, 'resolveSave')({ success: true, newVersion: 2 });

      const [firstResult, secondResult] = await Promise.all([firstPromise, secondPromise]);
      expect(firstResult).toEqual({ success: true, newVersion: 2 });
      expect(secondResult).toEqual({ success: true, newVersion: 2 });
    });

    it('saveProjectToCloud 应串行折叠同项目的后续快照', async () => {
      const firstProject = createMockProject({
        id: 'project-collapse',
        updatedAt: '2026-04-11T08:00:00.000Z',
        tasks: [createMockTask({ id: 'task-1', updatedAt: '2026-04-11T08:00:00.000Z' })],
        connections: [],
      });
      const secondProject = createMockProject({
        id: 'project-collapse',
        updatedAt: '2026-04-11T08:00:01.000Z',
        tasks: [createMockTask({ id: 'task-2', updatedAt: '2026-04-11T08:00:01.000Z' })],
        connections: [],
      });
      const latestProject = createMockProject({
        id: 'project-collapse',
        updatedAt: '2026-04-11T08:00:02.000Z',
        tasks: [createMockTask({ id: 'task-3', updatedAt: '2026-04-11T08:00:02.000Z' })],
        connections: [],
      });
      let resolveFirstSave: ((value: { success: boolean; newVersion: number }) => void) | null = null;
      let resolveSecondSave: ((value: { success: boolean; newVersion: number }) => void) | null = null;
      mockBatchSync.saveProjectToCloud = vi.fn()
        .mockImplementationOnce(() => new Promise((resolve) => {
          resolveFirstSave = resolve;
        }))
        .mockImplementationOnce(() => new Promise((resolve) => {
          resolveSecondSave = resolve;
        }));

      const firstPromise = service.saveProjectToCloud(firstProject, 'test-user-id');
      const secondPromise = service.saveProjectToCloud(secondProject, 'test-user-id');
      const latestPromise = service.saveProjectToCloud(latestProject, 'test-user-id');

      expect(mockBatchSync.saveProjectToCloud).toHaveBeenCalledTimes(1);

      expectDeferredCallback(resolveFirstSave, 'resolveFirstSave')({ success: true, newVersion: 1 });

      await vi.waitFor(() => {
        expect(mockBatchSync.saveProjectToCloud).toHaveBeenCalledTimes(2);
      });
      expect(mockBatchSync.saveProjectToCloud).toHaveBeenNthCalledWith(2, latestProject, 'test-user-id', undefined);

      expectDeferredCallback(resolveSecondSave, 'resolveSecondSave')({ success: true, newVersion: 2 });

      const [firstResult, secondResult, latestResult] = await Promise.all([
        firstPromise,
        secondPromise,
        latestPromise,
      ]);

      expect(firstResult).toEqual({ success: true, newVersion: 1 });
      expect(secondResult).toEqual({ success: true, newVersion: 2 });
      expect(latestResult).toEqual({ success: true, newVersion: 2 });
    });

    it('saveProjectToCloud 折叠到更新快照时应同步替换 operationId', async () => {
      const firstProject = createMockProject({
        id: 'project-collapse-operation-id',
        updatedAt: '2026-04-11T08:00:00.000Z',
        tasks: [createMockTask({ id: 'task-1', updatedAt: '2026-04-11T08:00:00.000Z' })],
        connections: [],
      });
      const secondProject = createMockProject({
        id: 'project-collapse-operation-id',
        updatedAt: '2026-04-11T08:00:01.000Z',
        tasks: [createMockTask({ id: 'task-2', updatedAt: '2026-04-11T08:00:01.000Z' })],
        connections: [],
      });
      const latestProject = createMockProject({
        id: 'project-collapse-operation-id',
        updatedAt: '2026-04-11T08:00:02.000Z',
        tasks: [createMockTask({ id: 'task-3', updatedAt: '2026-04-11T08:00:02.000Z' })],
        connections: [],
      });
      let resolveFirstSave: ((value: { success: boolean; newVersion: number }) => void) | null = null;
      let resolveSecondSave: ((value: { success: boolean; newVersion: number }) => void) | null = null;
      mockBatchSync.saveProjectToCloud = vi.fn()
        .mockImplementationOnce(() => new Promise((resolve) => {
          resolveFirstSave = resolve;
        }))
        .mockImplementationOnce(() => new Promise((resolve) => {
          resolveSecondSave = resolve;
        }));

      const firstPromise = service.saveProjectToCloud(
        firstProject,
        'test-user-id',
        undefined,
        undefined,
        'op-project-first',
      );
      const secondPromise = service.saveProjectToCloud(
        secondProject,
        'test-user-id',
        undefined,
        undefined,
        'op-project-second',
      );
      const latestPromise = service.saveProjectToCloud(
        latestProject,
        'test-user-id',
        undefined,
        undefined,
        'op-project-latest',
      );

      expect(mockBatchSync.saveProjectToCloud).toHaveBeenNthCalledWith(
        1,
        firstProject,
        'test-user-id',
        undefined,
        undefined,
        'op-project-first',
      );

      expectDeferredCallback(resolveFirstSave, 'resolveFirstSave')({ success: true, newVersion: 1 });

      await vi.waitFor(() => {
        expect(mockBatchSync.saveProjectToCloud).toHaveBeenCalledTimes(2);
      });
      expect(mockBatchSync.saveProjectToCloud).toHaveBeenNthCalledWith(
        2,
        latestProject,
        'test-user-id',
        undefined,
        undefined,
        'op-project-latest',
      );

      expectDeferredCallback(resolveSecondSave, 'resolveSecondSave')({ success: true, newVersion: 2 });

      const [firstResult, secondResult, latestResult] = await Promise.all([
        firstPromise,
        secondPromise,
        latestPromise,
      ]);

      expect(firstResult).toEqual({ success: true, newVersion: 1 });
      expect(secondResult).toEqual({ success: true, newVersion: 2 });
      expect(latestResult).toEqual({ success: true, newVersion: 2 });
    });

    it('saveProjectToCloud 不应让迟到的 in-flight 快照重放冲掉排队中的更新快照', async () => {
      const firstProject = createMockProject({
        id: 'project-return-to-active',
        name: 'Active Snapshot',
        updatedAt: '2026-04-11T08:00:00.000Z',
        version: 1,
        tasks: [createMockTask({ id: 'task-1', updatedAt: '2026-04-11T08:00:00.000Z' })],
        connections: [],
      });
      const queuedProject = createMockProject({
        id: 'project-return-to-active',
        name: 'Queued Snapshot',
        updatedAt: '2026-04-11T08:00:02.000Z',
        version: 2,
        tasks: [createMockTask({ id: 'task-2', updatedAt: '2026-04-11T08:00:02.000Z' })],
        connections: [],
      });
      let resolveSecondSave: ((value: { success: boolean; newVersion: number }) => void) | null = null;
      let resolveFirstSave: ((value: { success: boolean; newVersion: number }) => void) | null = null;
      mockBatchSync.saveProjectToCloud = vi.fn()
        .mockImplementationOnce(() => new Promise((resolve) => {
          resolveFirstSave = resolve;
        }))
        .mockImplementationOnce(() => new Promise((resolve) => {
          resolveSecondSave = resolve;
        }));

      const firstPromise = service.saveProjectToCloud(firstProject, 'test-user-id');
      const queuedPromise = service.saveProjectToCloud(queuedProject, 'test-user-id');
      const replayedActivePromise = service.saveProjectToCloud({ ...firstProject }, 'test-user-id');

      expectDeferredCallback(resolveFirstSave, 'resolveFirstSave')({ success: true, newVersion: 1 });

      await vi.waitFor(() => {
        expect(mockBatchSync.saveProjectToCloud).toHaveBeenCalledTimes(2);
      });
      expect(mockBatchSync.saveProjectToCloud).toHaveBeenNthCalledWith(2, queuedProject, 'test-user-id', undefined);

      expectDeferredCallback(resolveSecondSave, 'resolveSecondSave')({ success: true, newVersion: 2 });

      const [firstResult, queuedResult, replayedActiveResult] = await Promise.all([
        firstPromise,
        queuedPromise,
        replayedActivePromise,
      ]);

      expect(firstResult).toEqual({ success: true, newVersion: 1 });
      expect(queuedResult).toEqual({ success: true, newVersion: 2 });
      expect(replayedActiveResult).toEqual({ success: true, newVersion: 1 });
    });

    it('saveProjectToCloud 不应让更旧的后到快照覆盖排队中的更新快照', async () => {
      const firstProject = createMockProject({
        id: 'project-freshness-guard',
        updatedAt: '2026-04-11T08:00:00.000Z',
        version: 1,
        tasks: [createMockTask({ id: 'task-1', updatedAt: '2026-04-11T08:00:00.000Z' })],
        connections: [],
      });
      const newerProject = createMockProject({
        id: 'project-freshness-guard',
        updatedAt: '2026-04-11T08:00:02.000Z',
        version: 2,
        tasks: [createMockTask({ id: 'task-2', updatedAt: '2026-04-11T08:00:02.000Z' })],
        connections: [],
      });
      const olderLateProject = createMockProject({
        id: 'project-freshness-guard',
        updatedAt: '2026-04-11T08:00:01.000Z',
        version: 1,
        tasks: [createMockTask({ id: 'task-3', updatedAt: '2026-04-11T08:00:01.000Z' })],
        connections: [],
      });
      let resolveFirstSave: ((value: { success: boolean; newVersion: number }) => void) | null = null;
      let resolveSecondSave: ((value: { success: boolean; newVersion: number }) => void) | null = null;
      mockBatchSync.saveProjectToCloud = vi.fn()
        .mockImplementationOnce(() => new Promise((resolve) => {
          resolveFirstSave = resolve;
        }))
        .mockImplementationOnce(() => new Promise((resolve) => {
          resolveSecondSave = resolve;
        }));

      const firstPromise = service.saveProjectToCloud(firstProject, 'test-user-id');
      const newerPromise = service.saveProjectToCloud(newerProject, 'test-user-id');
      const olderLatePromise = service.saveProjectToCloud(olderLateProject, 'test-user-id');

      expectDeferredCallback(resolveFirstSave, 'resolveFirstSave')({ success: true, newVersion: 1 });

      await vi.waitFor(() => {
        expect(mockBatchSync.saveProjectToCloud).toHaveBeenCalledTimes(2);
      });
      expect(mockBatchSync.saveProjectToCloud).toHaveBeenNthCalledWith(2, newerProject, 'test-user-id', undefined);

      expectDeferredCallback(resolveSecondSave, 'resolveSecondSave')({ success: true, newVersion: 2 });

      const [firstResult, newerResult, olderLateResult] = await Promise.all([
        firstPromise,
        newerPromise,
        olderLatePromise,
      ]);

      expect(firstResult).toEqual({ success: true, newVersion: 1 });
      expect(newerResult).toEqual({ success: true, newVersion: 2 });
      expect(olderLateResult).toEqual({ success: true, newVersion: 2 });
    });

    it('saveProjectToCloud 不应因更旧的后到快照丢失新的删除 payload', async () => {
      const firstProject = createMockProject({
        id: 'project-freshness-delete-guard',
        updatedAt: '2026-04-11T08:00:00.000Z',
        version: 1,
        tasks: [createMockTask({ id: 'task-1', updatedAt: '2026-04-11T08:00:00.000Z' })],
        connections: [],
      });
      const newerProject = createMockProject({
        id: 'project-freshness-delete-guard',
        updatedAt: '2026-04-11T08:00:02.000Z',
        version: 2,
        tasks: [createMockTask({ id: 'task-2', updatedAt: '2026-04-11T08:00:02.000Z' })],
        connections: [],
      });
      const olderLateProject = createMockProject({
        id: 'project-freshness-delete-guard',
        updatedAt: '2026-04-11T08:00:01.000Z',
        version: 1,
        tasks: [createMockTask({ id: 'task-3', updatedAt: '2026-04-11T08:00:01.000Z' })],
        connections: [],
      });
      let resolveFirstSave: ((value: { success: boolean; newVersion: number }) => void) | null = null;
      let resolveSecondSave: ((value: { success: boolean; newVersion: number }) => void) | null = null;
      mockBatchSync.saveProjectToCloud = vi.fn()
        .mockImplementationOnce(() => new Promise((resolve) => {
          resolveFirstSave = resolve;
        }))
        .mockImplementationOnce(() => new Promise((resolve) => {
          resolveSecondSave = resolve;
        }));

      const firstPromise = service.saveProjectToCloud(firstProject, 'test-user-id');
      const newerPromise = service.saveProjectToCloud(newerProject, 'test-user-id');
      const olderLatePromise = service.saveProjectToCloud(
        olderLateProject,
        'test-user-id',
        ['task-delete-late'],
      );

      expectDeferredCallback(resolveFirstSave, 'resolveFirstSave')({ success: true, newVersion: 1 });

      await vi.waitFor(() => {
        expect(mockBatchSync.saveProjectToCloud).toHaveBeenCalledTimes(2);
      });
      expect(mockBatchSync.saveProjectToCloud).toHaveBeenNthCalledWith(
        2,
        newerProject,
        'test-user-id',
        ['task-delete-late'],
      );

      expectDeferredCallback(resolveSecondSave, 'resolveSecondSave')({ success: true, newVersion: 2 });

      const [firstResult, newerResult, olderLateResult] = await Promise.all([
        firstPromise,
        newerPromise,
        olderLatePromise,
      ]);

      expect(firstResult).toEqual({ success: true, newVersion: 1 });
      expect(newerResult).toEqual({ success: true, newVersion: 2 });
      expect(olderLateResult).toEqual({ success: true, newVersion: 2 });
    });

    it('saveProjectToCloud 应根据 task/connection 的更新时间保护更新快照', async () => {
      const firstProject = createMockProject({
        id: 'project-nested-freshness',
        updatedAt: '2026-04-11T08:00:00.000Z',
        version: 1,
        tasks: [createMockTask({ id: 'task-1', updatedAt: '2026-04-11T08:00:00.000Z' })],
        connections: [],
      });
      const newerNestedProject = createMockProject({
        id: 'project-nested-freshness',
        updatedAt: '2026-04-11T08:00:00.000Z',
        version: 1,
        tasks: [createMockTask({ id: 'task-2', updatedAt: '2026-04-11T08:00:02.000Z' })],
        connections: [],
      });
      const olderNestedProject = createMockProject({
        id: 'project-nested-freshness',
        updatedAt: '2026-04-11T08:00:00.000Z',
        version: 1,
        tasks: [createMockTask({ id: 'task-3', updatedAt: '2026-04-11T08:00:01.000Z' })],
        connections: [],
      });
      let resolveFirstSave: ((value: { success: boolean; newVersion: number }) => void) | null = null;
      let resolveSecondSave: ((value: { success: boolean; newVersion: number }) => void) | null = null;
      mockBatchSync.saveProjectToCloud = vi.fn()
        .mockImplementationOnce(() => new Promise((resolve) => {
          resolveFirstSave = resolve;
        }))
        .mockImplementationOnce(() => new Promise((resolve) => {
          resolveSecondSave = resolve;
        }));

      const firstPromise = service.saveProjectToCloud(firstProject, 'test-user-id');
      const newerPromise = service.saveProjectToCloud(newerNestedProject, 'test-user-id');
      const olderPromise = service.saveProjectToCloud(olderNestedProject, 'test-user-id');

      expectDeferredCallback(resolveFirstSave, 'resolveFirstSave')({ success: true, newVersion: 1 });

      await vi.waitFor(() => {
        expect(mockBatchSync.saveProjectToCloud).toHaveBeenCalledTimes(2);
      });
      expect(mockBatchSync.saveProjectToCloud).toHaveBeenNthCalledWith(2, newerNestedProject, 'test-user-id', undefined);

      expectDeferredCallback(resolveSecondSave, 'resolveSecondSave')({ success: true, newVersion: 2 });

      const [firstResult, newerResult, olderResult] = await Promise.all([
        firstPromise,
        newerPromise,
        olderPromise,
      ]);

      expect(firstResult).toEqual({ success: true, newVersion: 1 });
      expect(newerResult).toEqual({ success: true, newVersion: 2 });
      expect(olderResult).toEqual({ success: true, newVersion: 2 });
    });

    it('saveProjectToCloud 不应吞掉仅项目元数据变化的后续快照', async () => {
      const firstProject = createMockProject({
        id: 'project-metadata-only',
        name: 'Before Rename',
        updatedAt: '2026-04-11T08:00:00.000Z',
        tasks: [createMockTask({ id: 'task-1', updatedAt: '2026-04-11T08:00:00.000Z' })],
        connections: [],
      });
      const renamedProject = createMockProject({
        id: 'project-metadata-only',
        name: 'After Rename',
        updatedAt: '2026-04-11T08:00:00.000Z',
        tasks: [createMockTask({ id: 'task-1', updatedAt: '2026-04-11T08:00:00.000Z' })],
        connections: [],
      });
      let resolveFirstSave: ((value: { success: boolean; newVersion: number }) => void) | null = null;
      let resolveSecondSave: ((value: { success: boolean; newVersion: number }) => void) | null = null;
      mockBatchSync.saveProjectToCloud = vi.fn()
        .mockImplementationOnce(() => new Promise((resolve) => {
          resolveFirstSave = resolve;
        }))
        .mockImplementationOnce(() => new Promise((resolve) => {
          resolveSecondSave = resolve;
        }));

      const firstPromise = service.saveProjectToCloud(firstProject, 'test-user-id');
      const renamedPromise = service.saveProjectToCloud(renamedProject, 'test-user-id');

      expect(mockBatchSync.saveProjectToCloud).toHaveBeenCalledTimes(1);

      expectDeferredCallback(resolveFirstSave, 'resolveFirstSave')({ success: true, newVersion: 1 });

      await vi.waitFor(() => {
        expect(mockBatchSync.saveProjectToCloud).toHaveBeenCalledTimes(2);
      });
      expect(mockBatchSync.saveProjectToCloud).toHaveBeenNthCalledWith(2, renamedProject, 'test-user-id', undefined);

      expectDeferredCallback(resolveSecondSave, 'resolveSecondSave')({ success: true, newVersion: 2 });

      const [firstResult, renamedResult] = await Promise.all([firstPromise, renamedPromise]);
      expect(firstResult).toEqual({ success: true, newVersion: 1 });
      expect(renamedResult).toEqual({ success: true, newVersion: 2 });
    });

    it('saveProjectToCloud 在同等新鲜度时应保留最后到达的元数据快照', async () => {
      const firstProject = createMockProject({
        id: 'project-equal-freshness',
        name: 'Initial',
        updatedAt: '2026-04-11T08:00:00.000Z',
        version: 1,
        tasks: [createMockTask({ id: 'task-1', updatedAt: '2026-04-11T08:00:00.000Z' })],
        connections: [],
      });
      const queuedProject = createMockProject({
        id: 'project-equal-freshness',
        name: 'Queued Rename',
        updatedAt: '2026-04-11T08:00:02.000Z',
        version: 2,
        tasks: [createMockTask({ id: 'task-2', updatedAt: '2026-04-11T08:00:02.000Z' })],
        connections: [],
      });
      const latestEqualFreshnessProject = createMockProject({
        id: 'project-equal-freshness',
        name: 'Latest Rename',
        updatedAt: '2026-04-11T08:00:02.000Z',
        version: 2,
        tasks: [createMockTask({ id: 'task-2', updatedAt: '2026-04-11T08:00:02.000Z' })],
        connections: [],
      });
      let resolveFirstSave: ((value: { success: boolean; newVersion: number }) => void) | null = null;
      let resolveSecondSave: ((value: { success: boolean; newVersion: number }) => void) | null = null;
      mockBatchSync.saveProjectToCloud = vi.fn()
        .mockImplementationOnce(() => new Promise((resolve) => {
          resolveFirstSave = resolve;
        }))
        .mockImplementationOnce(() => new Promise((resolve) => {
          resolveSecondSave = resolve;
        }));

      const firstPromise = service.saveProjectToCloud(firstProject, 'test-user-id');
      const queuedPromise = service.saveProjectToCloud(queuedProject, 'test-user-id');
      const latestPromise = service.saveProjectToCloud(latestEqualFreshnessProject, 'test-user-id');

      expectDeferredCallback(resolveFirstSave, 'resolveFirstSave')({ success: true, newVersion: 1 });

      await vi.waitFor(() => {
        expect(mockBatchSync.saveProjectToCloud).toHaveBeenCalledTimes(2);
      });
      expect(mockBatchSync.saveProjectToCloud).toHaveBeenNthCalledWith(2, latestEqualFreshnessProject, 'test-user-id', undefined);

      expectDeferredCallback(resolveSecondSave, 'resolveSecondSave')({ success: true, newVersion: 2 });

      const [firstResult, queuedResult, latestResult] = await Promise.all([
        firstPromise,
        queuedPromise,
        latestPromise,
      ]);

      expect(firstResult).toEqual({ success: true, newVersion: 1 });
      expect(queuedResult).toEqual({ success: true, newVersion: 2 });
      expect(latestResult).toEqual({ success: true, newVersion: 2 });
    });

    it('saveProjectSmart 应透传并发折叠后的真实云端版本号', async () => {
      const project = createMockProject({
        id: 'project-smart-version',
        version: 3,
        updatedAt: '2026-04-11T08:00:00.000Z',
        tasks: [createMockTask({ id: 'task-1', updatedAt: '2026-04-11T08:00:00.000Z' })],
        connections: [],
      });
      let resolveSave: ((value: { success: boolean; newVersion: number }) => void) | null = null;
      mockBatchSync.saveProjectToCloud = vi.fn().mockImplementation(() => new Promise((resolve) => {
        resolveSave = resolve;
      }));

      const firstPromise = service.saveProjectSmart(project, 'test-user-id');
      const secondPromise = service.saveProjectSmart({ ...project }, 'test-user-id');

      expectDeferredCallback(resolveSave, 'resolveSave')({ success: true, newVersion: 11 });

      const [firstResult, secondResult] = await Promise.all([firstPromise, secondPromise]);
      expect(firstResult.newVersion).toBe(11);
      expect(secondResult.newVersion).toBe(11);
    });
}
