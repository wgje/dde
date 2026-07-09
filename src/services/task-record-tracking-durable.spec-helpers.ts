import { describe, expect, it, vi } from 'vitest';
import type { Project } from '../models';
import {
  createConnection,
  createProject,
  createTask,
  type TaskRecordTrackingSpecHarness,
} from './task-record-tracking.service.spec-helpers';

interface TaskRecordTrackingDurableSpecContext {
  service: () => TaskRecordTrackingSpecHarness['service'];
  mockProjectState: () => TaskRecordTrackingSpecHarness['mockProjectState'];
  mockUndoService: () => TaskRecordTrackingSpecHarness['mockUndoService'];
  mockSyncCoordinator: () => TaskRecordTrackingSpecHarness['mockSyncCoordinator'];
  mockChangeTracker: () => TaskRecordTrackingSpecHarness['mockChangeTracker'];
  mockActionQueue: () => TaskRecordTrackingSpecHarness['mockActionQueue'];
  mockAuthService: () => TaskRecordTrackingSpecHarness['mockAuthService'];
  mockLoggerCategory: () => TaskRecordTrackingSpecHarness['mockLoggerCategory'];
  mockToastService: () => TaskRecordTrackingSpecHarness['mockToastService'];
}

function createDeferred<T = unknown>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve: ((value: T | PromiseLike<T>) => void) | null = null;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve: resolve! };
}

export function registerTaskRecordTrackingDurableSpecs(
  context: TaskRecordTrackingDurableSpecContext,
): void {
  describe('recordAndUpdateDurably', () => {
    it('should persist the outbox entry before exposing task updates to local UI', async () => {
      const queueWrite = createDeferred<string>();
      const project = createProject({
        tasks: [
          createTask({
            id: 'task-durable-title',
            title: 'Before',
            updatedAt: '2026-06-13T00:00:00.000Z',
          }),
        ],
      });
      context.mockProjectState().activeProject.mockReturnValue(project);
      context.mockProjectState().updateProjects.mockImplementation((fn: (projects: Project[]) => Project[]) => {
        return fn([project]);
      });
      context.mockActionQueue().enqueueDurably.mockReturnValueOnce(queueWrite.promise);

      const resultPromise = context.service().recordAndUpdateDurably((currentProject) => ({
        ...currentProject,
        tasks: currentProject.tasks.map(task =>
          task.id === 'task-durable-title'
            ? { ...task, title: 'After', updatedAt: '2026-06-13T01:00:00.000Z' }
            : task,
        ),
      }));

      expect(context.mockActionQueue().enqueueDurably).toHaveBeenCalledWith(expect.objectContaining({
        type: 'update',
        entityType: 'task',
        entityId: 'task-durable-title',
      }));
      expect(context.mockProjectState().updateProjects).not.toHaveBeenCalled();
      expect(context.mockUndoService().recordAction).not.toHaveBeenCalled();
      expect(context.mockChangeTracker().trackTaskUpdate).not.toHaveBeenCalled();

      queueWrite.resolve('queued-action-id');
      await expect(resultPromise).resolves.toBe(true);

      expect(context.mockProjectState().updateProjects).toHaveBeenCalledOnce();
      const updater = context.mockProjectState().updateProjects.mock.calls[0][0] as (projects: Project[]) => Project[];
      expect(updater([project])[0].tasks[0]).toEqual(expect.objectContaining({
        id: 'task-durable-title',
        title: 'After',
      }));
      expect(context.mockUndoService().recordAction).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'task-update', projectId: 'proj-1' }),
        expect.any(Number),
      );
      expect(context.mockChangeTracker().trackTaskUpdate).toHaveBeenCalledWith(
        'proj-1',
        expect.objectContaining({ id: 'task-durable-title', title: 'After' }),
        expect.arrayContaining(['title']),
      );
      expect(context.mockSyncCoordinator().saveOfflineSnapshotAndWait).toHaveBeenCalledWith(
        [expect.objectContaining({
          id: 'proj-1',
          tasks: [expect.objectContaining({ id: 'task-durable-title', title: 'After' })],
        })],
        'test-user',
      );
      expect(context.mockSyncCoordinator().markLocalChanges).toHaveBeenCalledWith('structure');
      expect(context.mockSyncCoordinator().schedulePersist).toHaveBeenCalled();
    });

    it('should serialize overlapping durable updates instead of dropping the later local intent', async () => {
      const firstQueueWrite = createDeferred<string>();
      const secondQueueWrite = createDeferred<string>();
      let activeProject = createProject({
        tasks: [
          createTask({
            id: 'task-overlap-durable',
            title: 'Before',
            updatedAt: '2026-06-13T00:00:00.000Z',
          }),
        ],
      });
      context.mockProjectState().activeProject.mockImplementation(() => activeProject);
      context.mockProjectState().updateProjects.mockImplementation((fn: (projects: Project[]) => Project[]) => {
        const [updatedProject] = fn([activeProject]);
        activeProject = updatedProject;
        return [activeProject];
      });
      context.mockActionQueue().enqueueDurably
        .mockReturnValueOnce(firstQueueWrite.promise)
        .mockReturnValueOnce(secondQueueWrite.promise);

      const firstUpdate = context.service().recordAndUpdateDurably((currentProject) => ({
        ...currentProject,
        tasks: currentProject.tasks.map(task =>
          task.id === 'task-overlap-durable'
            ? { ...task, title: 'First', updatedAt: '2026-06-13T01:00:00.000Z' }
            : task,
        ),
      }));

      expect(context.mockActionQueue().enqueueDurably).toHaveBeenCalledTimes(1);

      let secondSettled = false;
      const secondUpdate = context.service().recordAndUpdateDurably((currentProject) => ({
        ...currentProject,
        tasks: currentProject.tasks.map(task =>
          task.id === 'task-overlap-durable'
            ? { ...task, title: `${task.title} + Second`, updatedAt: '2026-06-13T02:00:00.000Z' }
            : task,
        ),
      })).finally(() => {
        secondSettled = true;
      });

      await Promise.resolve();
      expect(secondSettled).toBe(false);
      expect(context.mockActionQueue().enqueueDurably).toHaveBeenCalledTimes(1);

      firstQueueWrite.resolve('queued-first-update');
      await vi.waitFor(() => {
        expect(context.mockActionQueue().enqueueDurably).toHaveBeenCalledTimes(2);
      });
      secondQueueWrite.resolve('queued-second-update');

      await expect(Promise.all([firstUpdate, secondUpdate])).resolves.toEqual([true, true]);
      expect(activeProject.tasks[0]).toEqual(expect.objectContaining({
        id: 'task-overlap-durable',
        title: 'First + Second',
      }));
      expect(context.mockProjectState().updateProjects).toHaveBeenCalledTimes(2);
    });

    it('should keep the committed local update when immediate offline snapshot persistence fails', async () => {
      const project = createProject({
        tasks: [
          createTask({
            id: 'task-snapshot-fails',
            title: 'Before',
            updatedAt: '2026-06-13T00:00:00.000Z',
          }),
        ],
      });
      context.mockProjectState().activeProject.mockReturnValue(project);
      context.mockProjectState().updateProjects.mockImplementation((fn: (projects: Project[]) => Project[]) => fn([project]));
      context.mockSyncCoordinator().saveOfflineSnapshotAndWait.mockRejectedValueOnce(new Error('idb unavailable'));

      const result = await context.service().recordAndUpdateDurably((currentProject) => ({
        ...currentProject,
        tasks: currentProject.tasks.map(task =>
          task.id === 'task-snapshot-fails'
            ? { ...task, title: 'After', updatedAt: '2026-06-13T01:00:00.000Z' }
            : task,
        ),
      }));

      expect(result).toBe(true);
      expect(context.mockProjectState().updateProjects).toHaveBeenCalledOnce();
      expect(context.mockActionQueue().enqueueDurably).toHaveBeenCalledOnce();
      expect(context.mockSyncCoordinator().schedulePersist).toHaveBeenCalled();
      expect(context.mockLoggerCategory().warn).toHaveBeenCalledWith(
        '即时离线快照持久化失败，保留 Outbox 并等待后台持久化重试',
        expect.objectContaining({
          projectId: 'proj-1',
          error: expect.any(Error),
        }),
      );
    });

    it('should leave local-only task updates unchanged when immediate offline snapshot persistence fails', async () => {
      const project = createProject({
        syncSource: 'local-only',
        tasks: [
          createTask({
            id: 'task-local-only-snapshot-fails',
            title: 'Before',
            updatedAt: '2026-06-13T00:00:00.000Z',
          }),
        ],
      });
      context.mockProjectState().activeProject.mockReturnValue(project);
      context.mockSyncCoordinator().saveOfflineSnapshotAndWait.mockRejectedValueOnce(new Error('idb unavailable'));

      const result = await context.service().recordAndUpdateDurably((currentProject) => ({
        ...currentProject,
        tasks: currentProject.tasks.map(task =>
          task.id === 'task-local-only-snapshot-fails'
            ? { ...task, title: 'After', updatedAt: '2026-06-13T01:00:00.000Z' }
            : task,
        ),
      }));

      expect(result).toBe(false);
      expect(context.mockActionQueue().enqueueDurably).not.toHaveBeenCalled();
      expect(context.mockProjectState().updateProjects).not.toHaveBeenCalled();
      expect(context.mockUndoService().recordAction).not.toHaveBeenCalled();
      expect(context.mockChangeTracker().trackTaskUpdate).not.toHaveBeenCalled();
      expect(context.mockSyncCoordinator().markLocalChanges).not.toHaveBeenCalled();
      expect(context.mockSyncCoordinator().schedulePersist).not.toHaveBeenCalled();
      expect(context.mockToastService().error).toHaveBeenCalledWith(
        '本地保存失败',
        expect.stringContaining('本地快照未能写入'),
      );
      expect(context.mockLoggerCategory().warn).toHaveBeenCalledWith(
        '本地项目快照持久化失败，取消本次 UI 提交',
        expect.objectContaining({
          projectId: 'proj-1',
          error: expect.any(Error),
        }),
      );
    });

    it('should leave local UI unchanged when durable task outbox persistence fails', async () => {
      const project = createProject({
        tasks: [
          createTask({
            id: 'task-durable-fails',
            title: 'Before',
            updatedAt: '2026-06-13T00:00:00.000Z',
          }),
        ],
      });
      context.mockProjectState().activeProject.mockReturnValue(project);
      context.mockActionQueue().enqueueDurably.mockResolvedValueOnce('');

      const result = await context.service().recordAndUpdateDurably((currentProject) => ({
        ...currentProject,
        tasks: currentProject.tasks.map(task =>
          task.id === 'task-durable-fails'
            ? { ...task, title: 'After', updatedAt: '2026-06-13T01:00:00.000Z' }
            : task,
        ),
      }));

      expect(result).toBe(false);
      expect(context.mockActionQueue().enqueueDurably).toHaveBeenCalledOnce();
      expect(context.mockProjectState().updateProjects).not.toHaveBeenCalled();
      expect(context.mockUndoService().recordAction).not.toHaveBeenCalled();
      expect(context.mockChangeTracker().trackTaskUpdate).not.toHaveBeenCalled();
      expect(context.mockToastService().error).toHaveBeenCalledWith(
        '本地保存失败',
        expect.stringContaining('离线同步队列未能写入'),
      );
      expect(context.mockSyncCoordinator().markLocalChanges).not.toHaveBeenCalled();
      expect(context.mockSyncCoordinator().schedulePersist).not.toHaveBeenCalled();
    });

    it('should not leave a partial outbox when one durable batch action fails before local commit', async () => {
      const durableWrites: unknown[] = [];
      context.mockActionQueue().enqueueDurably.mockImplementation(async (action: unknown) => {
        durableWrites.push(action);
        return durableWrites.length === 1 ? 'first-action-id' : '';
      });
      context.mockActionQueue().enqueueManyDurably.mockResolvedValueOnce([]);
      const project = createProject({
        tasks: [
          createTask({
            id: 'task-batch-partial',
            title: 'Before',
            updatedAt: '2026-06-13T00:00:00.000Z',
          }),
        ],
        connections: [
          createConnection({
            id: 'conn-batch-partial',
            title: 'Before connection',
            updatedAt: '2026-06-13T00:00:00.000Z',
          }),
        ],
      });
      context.mockProjectState().activeProject.mockReturnValue(project);

      const result = await context.service().recordAndUpdateDurably((currentProject) => ({
        ...currentProject,
        tasks: currentProject.tasks.map(task =>
          task.id === 'task-batch-partial'
            ? { ...task, title: 'After', updatedAt: '2026-06-13T01:00:00.000Z' }
            : task,
        ),
        connections: currentProject.connections.map(connection =>
          connection.id === 'conn-batch-partial'
            ? { ...connection, title: 'After connection', updatedAt: '2026-06-13T01:00:00.000Z' }
            : connection,
        ),
      }));

      expect(result).toBe(false);
      expect(context.mockActionQueue().enqueueManyDurably).toHaveBeenCalledWith([
        expect.objectContaining({ entityType: 'task', entityId: 'task-batch-partial' }),
        expect.objectContaining({ entityType: 'connection', entityId: 'conn-batch-partial' }),
      ]);
      expect(durableWrites).toEqual([]);
      expect(context.mockProjectState().updateProjects).not.toHaveBeenCalled();
      expect(context.mockUndoService().recordAction).not.toHaveBeenCalled();
      expect(context.mockChangeTracker().trackTaskUpdate).not.toHaveBeenCalled();
      expect(context.mockChangeTracker().trackConnectionUpdate).not.toHaveBeenCalled();
    });

    it('should reject a durable batch when any returned action id is missing', async () => {
      const project = createProject({
        tasks: [
          createTask({
            id: 'task-batch-missing-id',
            title: 'Before',
            updatedAt: '2026-06-13T00:00:00.000Z',
          }),
        ],
        connections: [
          createConnection({
            id: 'conn-batch-missing-id',
            title: 'Before connection',
            updatedAt: '2026-06-13T00:00:00.000Z',
          }),
        ],
      });
      context.mockProjectState().activeProject.mockReturnValue(project);
      context.mockActionQueue().enqueueManyDurably.mockResolvedValueOnce([
        'queued-task-action',
        '',
      ]);

      const result = await context.service().recordAndUpdateDurably((currentProject) => ({
        ...currentProject,
        tasks: currentProject.tasks.map(task =>
          task.id === 'task-batch-missing-id'
            ? { ...task, title: 'After', updatedAt: '2026-06-13T01:00:00.000Z' }
            : task,
        ),
        connections: currentProject.connections.map(connection =>
          connection.id === 'conn-batch-missing-id'
            ? { ...connection, title: 'After connection', updatedAt: '2026-06-13T01:00:00.000Z' }
            : connection,
        ),
      }));

      expect(result).toBe(false);
      expect(context.mockActionQueue().enqueueManyDurably).toHaveBeenCalledWith([
        expect.objectContaining({ entityType: 'task', entityId: 'task-batch-missing-id' }),
        expect.objectContaining({ entityType: 'connection', entityId: 'conn-batch-missing-id' }),
      ]);
      expect(context.mockProjectState().updateProjects).not.toHaveBeenCalled();
      expect(context.mockUndoService().recordAction).not.toHaveBeenCalled();
      expect(context.mockChangeTracker().trackTaskUpdate).not.toHaveBeenCalled();
      expect(context.mockChangeTracker().trackConnectionUpdate).not.toHaveBeenCalled();
      expect(context.mockSyncCoordinator().markLocalChanges).not.toHaveBeenCalled();
      expect(context.mockSyncCoordinator().schedulePersist).not.toHaveBeenCalled();
      expect(context.mockToastService().error).toHaveBeenCalledWith(
        '本地保存失败',
        expect.stringContaining('离线同步队列未能写入'),
      );
    });

    it('should reject cloud mutations when owner metadata is unavailable for durable outbox', async () => {
      context.mockAuthService().currentUserId.mockReturnValue(null);
      context.mockAuthService().peekPersistedOwnerHint.mockReturnValue(null);
      const project = createProject({
        syncSource: 'synced',
        tasks: [
          createTask({
            id: 'task-no-owner',
            title: 'Before',
            updatedAt: '2026-06-13T00:00:00.000Z',
          }),
        ],
      });
      context.mockProjectState().activeProject.mockReturnValue(project);

      const result = await context.service().recordAndUpdateDurably((currentProject) => ({
        ...currentProject,
        tasks: currentProject.tasks.map(task =>
          task.id === 'task-no-owner'
            ? { ...task, title: 'After', updatedAt: '2026-06-13T01:00:00.000Z' }
            : task,
        ),
      }));

      expect(result).toBe(false);
      expect(context.mockActionQueue().enqueueDurably).not.toHaveBeenCalled();
      expect(context.mockProjectState().updateProjects).not.toHaveBeenCalled();
      expect(context.mockUndoService().recordAction).not.toHaveBeenCalled();
      expect(context.mockChangeTracker().trackTaskUpdate).not.toHaveBeenCalled();
      expect(context.mockToastService().error).toHaveBeenCalledWith(
        '本地保存失败',
        expect.stringContaining('无法写入可恢复的离线队列'),
      );
      expect(context.mockSyncCoordinator().markLocalChanges).not.toHaveBeenCalled();
      expect(context.mockSyncCoordinator().schedulePersist).not.toHaveBeenCalled();
    });

    it('should use the persisted owner hint for durable task outbox while auth is restoring', async () => {
      const queueWrite = createDeferred<string>();
      const project = createProject({
        syncSource: 'synced',
        tasks: [
          createTask({
            id: 'task-owner-hint',
            title: 'Before',
            updatedAt: '2026-06-13T00:00:00.000Z',
          }),
        ],
      });
      context.mockAuthService().currentUserId.mockReturnValue(null);
      context.mockAuthService().peekPersistedOwnerHint.mockReturnValue('owner-from-cache');
      context.mockProjectState().activeProject.mockReturnValue(project);
      context.mockProjectState().updateProjects.mockImplementation((fn: (projects: Project[]) => Project[]) =>
        fn([project]));
      context.mockActionQueue().enqueueDurablyForOwner.mockReturnValueOnce(queueWrite.promise);

      const resultPromise = context.service().recordAndUpdateDurably((currentProject) => ({
        ...currentProject,
        tasks: currentProject.tasks.map(task =>
          task.id === 'task-owner-hint'
            ? { ...task, title: 'After', updatedAt: '2026-06-13T01:00:00.000Z' }
            : task,
        ),
      }));

      expect(context.mockActionQueue().enqueueDurably).not.toHaveBeenCalled();
      expect(context.mockActionQueue().enqueueDurablyForOwner).toHaveBeenCalledWith(
        'owner-from-cache',
        expect.objectContaining({
          type: 'update',
          entityType: 'task',
          entityId: 'task-owner-hint',
          payload: expect.objectContaining({
            projectId: 'proj-1',
            sourceUserId: 'owner-from-cache',
          }),
        }),
      );
      expect(context.mockProjectState().updateProjects).not.toHaveBeenCalled();

      queueWrite.resolve('queued-owner-task-update');
      await expect(resultPromise).resolves.toBe(true);

      expect(context.mockProjectState().updateProjects).toHaveBeenCalledOnce();
      expect(context.mockSyncCoordinator().markLocalChanges).toHaveBeenCalledWith('structure');
      expect(context.mockSyncCoordinator().schedulePersist).toHaveBeenCalled();
    });

    it('should use owner-scoped bulk outbox writes when auth is restoring', async () => {
      const project = createProject({
        syncSource: 'synced',
        tasks: [
          createTask({
            id: 'task-owner-bulk',
            title: 'Before',
            updatedAt: '2026-06-13T00:00:00.000Z',
          }),
        ],
        connections: [
          createConnection({
            id: 'conn-owner-bulk',
            title: 'Before connection',
            updatedAt: '2026-06-13T00:00:00.000Z',
          }),
        ],
      });
      context.mockAuthService().currentUserId.mockReturnValue(null);
      context.mockAuthService().peekPersistedOwnerHint.mockReturnValue('owner-from-cache');
      context.mockProjectState().activeProject.mockReturnValue(project);
      context.mockProjectState().updateProjects.mockImplementation((fn: (projects: Project[]) => Project[]) =>
        fn([project]));
      context.mockActionQueue().enqueueManyDurablyForOwner.mockResolvedValueOnce([
        'queued-owner-task',
        'queued-owner-connection',
      ]);

      const result = await context.service().recordAndUpdateDurably((currentProject) => ({
        ...currentProject,
        tasks: currentProject.tasks.map(task =>
          task.id === 'task-owner-bulk'
            ? { ...task, title: 'After', updatedAt: '2026-06-13T01:00:00.000Z' }
            : task,
        ),
        connections: currentProject.connections.map(connection =>
          connection.id === 'conn-owner-bulk'
            ? { ...connection, title: 'After connection', updatedAt: '2026-06-13T01:00:00.000Z' }
            : connection,
        ),
      }));

      expect(result).toBe(true);
      expect(context.mockActionQueue().enqueueManyDurably).not.toHaveBeenCalled();
      expect(context.mockActionQueue().enqueueManyDurablyForOwner).toHaveBeenCalledWith(
        'owner-from-cache',
        [
          expect.objectContaining({
            entityType: 'task',
            entityId: 'task-owner-bulk',
            payload: expect.objectContaining({ sourceUserId: 'owner-from-cache' }),
          }),
          expect.objectContaining({
            entityType: 'connection',
            entityId: 'conn-owner-bulk',
            payload: expect.objectContaining({ sourceUserId: 'owner-from-cache' }),
          }),
        ],
      );
      expect(context.mockProjectState().updateProjects).toHaveBeenCalledOnce();
    });
  });
}
