/**
 * TaskRecordTrackingService 单元测试
 *
 * 测试覆盖：
 * 1. showUndoToast（桌面/移动端不同表现）
 * 2. performUndo（正常撤销、版本不匹配、无可撤销操作）
 * 3. performRedo（正常重做、版本不匹配、无可重做操作）
 * 4. recordAndUpdate（含竞态保护和变更追踪）
 * 5. recordAndUpdateDebounced（内容更新场景）
 * 6. setupSyncResultHandler（同步结果回调）
 * 7. triggerServerSideDelete（服务端删除保护，见 task-record-tracking.service.delete.spec.ts）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Project } from '../models';
import {
  createConnection,
  createProject,
  createTask,
  createTaskRecordTrackingSpecHarness,
  type TaskRecordTrackingSpecHarness,
} from './task-record-tracking.service.spec-helpers';
import { registerTaskRecordTrackingDurableSpecs } from './task-record-tracking-durable.spec-helpers';
import {
  registerTaskRecordTrackingQueuedContextSpecs,
} from './task-record-tracking-queued-context.spec-helpers';
import { registerTaskRecordTrackingSyncResultSpecs } from './task-record-tracking-sync-result.spec-helpers';

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

describe('TaskRecordTrackingService', () => {
  let harness: TaskRecordTrackingSpecHarness;
  let service: TaskRecordTrackingSpecHarness['service'];
  let mockProjectState: TaskRecordTrackingSpecHarness['mockProjectState'];
  let mockUndoService: TaskRecordTrackingSpecHarness['mockUndoService'];
  let mockSyncCoordinator: TaskRecordTrackingSpecHarness['mockSyncCoordinator'];
  let mockChangeTracker: TaskRecordTrackingSpecHarness['mockChangeTracker'];
  let mockOptimisticState: TaskRecordTrackingSpecHarness['mockOptimisticState'];
  let mockUiState: TaskRecordTrackingSpecHarness['mockUiState'];
  let mockActionQueue: TaskRecordTrackingSpecHarness['mockActionQueue'];
  let mockLoggerCategory: TaskRecordTrackingSpecHarness['mockLoggerCategory'];
  let mockToastService: TaskRecordTrackingSpecHarness['mockToastService'];

  beforeEach(() => {
    harness = createTaskRecordTrackingSpecHarness();
    service = harness.service;
    mockProjectState = harness.mockProjectState;
    mockUndoService = harness.mockUndoService;
    mockSyncCoordinator = harness.mockSyncCoordinator;
    mockChangeTracker = harness.mockChangeTracker;
    mockOptimisticState = harness.mockOptimisticState;
    mockUiState = harness.mockUiState;
    mockActionQueue = harness.mockActionQueue;
    mockLoggerCategory = harness.mockLoggerCategory;
    mockToastService = harness.mockToastService;
  });

  afterEach(() => {
    harness.destroy();
    harness.restoreConsole();
  });

  // ==================== showUndoToast ====================

  describe('showUndoToast', () => {
    it('should show toast with short duration on desktop', () => {
      mockUiState.isMobile.mockReturnValue(false);

      service.showUndoToast('Task deleted');

      expect(mockToastService.success).toHaveBeenCalledWith(
        'Task deleted',
        undefined,
        expect.objectContaining({ duration: 3000 })
      );
    });

    it('should show toast with undo action on mobile', () => {
      mockUiState.isMobile.mockReturnValue(true);

      service.showUndoToast('Task deleted');

      expect(mockToastService.success).toHaveBeenCalledWith(
        'Task deleted',
        undefined,
        expect.objectContaining({
          duration: 5000,
          action: expect.objectContaining({ label: '撤销' }),
        })
      );
    });
  });

  // ==================== performUndo ====================

  describe('performUndo', () => {
    it('should log warning when there is nothing to undo', async () => {
      mockUndoService.prepareUndo.mockReturnValue(null);

      await expect(service.performUndo()).resolves.toBe(false);

      expect(mockLoggerCategory.warn).toHaveBeenCalled();
    });

    it('should show warning toast on version-mismatch', async () => {
      mockUndoService.prepareUndo.mockReturnValue('version-mismatch');

      await expect(service.performUndo()).resolves.toBe(false);

      expect(mockToastService.warning).toHaveBeenCalledWith('撤销失败', expect.any(String));
    });

    it('should apply snapshot on successful undo', async () => {
      const snapshot = { tasks: [createTask()], connections: [] };
      const action = {
        type: 'task-update',
        projectId: 'proj-1',
        data: { before: snapshot, after: {} },
      };
      mockUndoService.prepareUndo.mockReturnValue(action);

      await expect(service.performUndo()).resolves.toBe(true);

      expect(mockProjectState.updateProjects).toHaveBeenCalled();
      expect(mockSyncCoordinator.markLocalChanges).toHaveBeenCalledWith('structure');
      expect(mockSyncCoordinator.schedulePersist).toHaveBeenCalled();
      expect(mockUndoService.commitPreparedUndo).toHaveBeenCalledWith(action);
      expect(mockUndoService.notifyReplayApplied).toHaveBeenCalledWith('undo', 'proj-1', snapshot, {});
    });

    it('should durably enqueue undo replay before exposing the snapshot to local UI', async () => {
      const queueWrite = createDeferred<string>();
      const beforeTask = createTask({
        id: 'task-undo-durable',
        title: 'Before undo',
        updatedAt: '2026-06-13T00:00:00.000Z',
      });
      const currentTask = createTask({
        id: 'task-undo-durable',
        title: 'Current',
        updatedAt: '2026-06-13T01:00:00.000Z',
      });
      const currentProject = createProject({ tasks: [currentTask] });
      const undoSnapshot = { tasks: [beforeTask], connections: [] };
      mockProjectState.activeProject.mockReturnValue(currentProject);
      mockProjectState.updateProjects.mockImplementation((fn: (projects: Project[]) => Project[]) =>
        fn([currentProject]));
      mockActionQueue.enqueueDurably.mockReturnValueOnce(queueWrite.promise);
      mockUndoService.prepareUndo.mockReturnValue({
        type: 'task-update',
        projectId: 'proj-1',
        data: { before: undoSnapshot, after: { tasks: [currentTask], connections: [] } },
      });

      const resultPromise = service.performUndo();

      expect(mockActionQueue.enqueueDurably).toHaveBeenCalledWith(expect.objectContaining({
        type: 'update',
        entityType: 'task',
        entityId: 'task-undo-durable',
      }));
      expect(mockProjectState.updateProjects).not.toHaveBeenCalled();
      expect(mockUndoService.notifyReplayApplied).not.toHaveBeenCalled();

      queueWrite.resolve('queued-undo-replay');
      await expect(resultPromise).resolves.toBe(true);

      expect(mockProjectState.updateProjects).toHaveBeenCalledOnce();
      const updater = mockProjectState.updateProjects.mock.calls[0][0] as (projects: Project[]) => Project[];
      expect(updater([currentProject])[0].tasks[0]).toEqual(expect.objectContaining({
        id: 'task-undo-durable',
        title: 'Before undo',
      }));
      expect(mockUndoService.recordAction).not.toHaveBeenCalled();
      expect(mockUndoService.recordActionDebounced).not.toHaveBeenCalled();
      expect(mockUndoService.commitPreparedUndo).toHaveBeenCalledWith(expect.objectContaining({
        projectId: 'proj-1',
      }));
      expect(mockUndoService.notifyReplayApplied).toHaveBeenCalledWith(
        'undo',
        'proj-1',
        undoSnapshot,
        { tasks: [currentTask], connections: [] },
      );
    });

    it('should leave local UI unchanged when durable undo replay enqueue fails', async () => {
      const beforeTask = createTask({
        id: 'task-undo-fails',
        title: 'Before undo',
        updatedAt: '2026-06-13T00:00:00.000Z',
      });
      const currentTask = createTask({
        id: 'task-undo-fails',
        title: 'Current',
        updatedAt: '2026-06-13T01:00:00.000Z',
      });
      const currentProject = createProject({ tasks: [currentTask] });
      mockProjectState.activeProject.mockReturnValue(currentProject);
      mockActionQueue.enqueueDurably.mockResolvedValueOnce('');
      mockUndoService.prepareUndo.mockReturnValue({
        type: 'task-update',
        projectId: 'proj-1',
        data: { before: { tasks: [beforeTask], connections: [] }, after: { tasks: [currentTask], connections: [] } },
      });

      await expect(service.performUndo()).resolves.toBe(false);

      expect(mockActionQueue.enqueueDurably).toHaveBeenCalledOnce();
      expect(mockProjectState.updateProjects).not.toHaveBeenCalled();
      expect(mockUndoService.commitPreparedUndo).not.toHaveBeenCalled();
      expect(mockUndoService.notifyReplayApplied).not.toHaveBeenCalled();
    });

    it('should handle version-mismatch-forceable result', async () => {
      const snapshot = { tasks: [], connections: [] };
      const action = {
        type: 'task-update',
        projectId: 'proj-1',
        data: { before: snapshot, after: {} },
      };
      mockUndoService.prepareUndo.mockReturnValue({
        type: 'version-mismatch-forceable',
        action,
        versionDiff: 2,
      });

      await expect(service.performUndo()).resolves.toBe(true);

      expect(mockToastService.warning).toHaveBeenCalledWith('撤销注意', expect.any(String));
      expect(mockUndoService.forceUndo).not.toHaveBeenCalled();
      expect(mockUndoService.commitPreparedUndo).toHaveBeenCalledWith(action);
    });
  });

  // ==================== performRedo ====================

  describe('performRedo', () => {
    it('should do nothing when there is nothing to redo', async () => {
      mockUndoService.prepareRedo.mockReturnValue(null);

      await expect(service.performRedo()).resolves.toBe(false);

      expect(mockLoggerCategory.debug).toHaveBeenCalled();
      expect(mockProjectState.updateProjects).not.toHaveBeenCalled();
    });

    it('should show warning on version-mismatch', async () => {
      mockUndoService.prepareRedo.mockReturnValue('version-mismatch');

      await expect(service.performRedo()).resolves.toBe(false);

      expect(mockToastService.warning).toHaveBeenCalledWith('重做失败', expect.any(String));
    });

    it('should apply after-snapshot on successful redo', async () => {
      const snapshot = { tasks: [createTask()], connections: [] };
      const action = {
        type: 'task-update',
        projectId: 'proj-1',
        data: { before: {}, after: snapshot },
      };
      mockUndoService.prepareRedo.mockReturnValue(action);

      await expect(service.performRedo()).resolves.toBe(true);

      expect(mockProjectState.updateProjects).toHaveBeenCalled();
      expect(mockSyncCoordinator.markLocalChanges).toHaveBeenCalledWith('structure');
      expect(mockUndoService.commitPreparedRedo).toHaveBeenCalledWith(action);
      expect(mockUndoService.notifyReplayApplied).toHaveBeenCalledWith('redo', 'proj-1', snapshot, {});
    });

    it('should durably enqueue redo replay before exposing the snapshot to local UI', async () => {
      const queueWrite = createDeferred<string>();
      const beforeTask = createTask({
        id: 'task-redo-durable',
        title: 'Before redo',
        updatedAt: '2026-06-13T00:00:00.000Z',
      });
      const afterTask = createTask({
        id: 'task-redo-durable',
        title: 'After redo',
        updatedAt: '2026-06-13T01:00:00.000Z',
      });
      const currentProject = createProject({ tasks: [beforeTask] });
      const afterSnapshot = { tasks: [afterTask], connections: [] };
      mockProjectState.activeProject.mockReturnValue(currentProject);
      mockProjectState.updateProjects.mockImplementation((fn: (projects: Project[]) => Project[]) =>
        fn([currentProject]));
      mockActionQueue.enqueueDurably.mockReturnValueOnce(queueWrite.promise);
      mockUndoService.prepareRedo.mockReturnValue({
        type: 'task-update',
        projectId: 'proj-1',
        data: { before: { tasks: [beforeTask], connections: [] }, after: afterSnapshot },
      });

      const resultPromise = service.performRedo();

      expect(mockActionQueue.enqueueDurably).toHaveBeenCalledWith(expect.objectContaining({
        type: 'update',
        entityType: 'task',
        entityId: 'task-redo-durable',
      }));
      expect(mockProjectState.updateProjects).not.toHaveBeenCalled();

      queueWrite.resolve('queued-redo-replay');
      await expect(resultPromise).resolves.toBe(true);

      expect(mockProjectState.updateProjects).toHaveBeenCalledOnce();
      expect(mockUndoService.recordAction).not.toHaveBeenCalled();
      expect(mockUndoService.recordActionDebounced).not.toHaveBeenCalled();
      expect(mockUndoService.commitPreparedRedo).toHaveBeenCalledWith(expect.objectContaining({
        projectId: 'proj-1',
      }));
      expect(mockUndoService.notifyReplayApplied).toHaveBeenCalledWith(
        'redo',
        'proj-1',
        afterSnapshot,
        { tasks: [beforeTask], connections: [] },
      );
    });
  });

  // ==================== undo/redo 事务并发锁 ====================

  describe('undo/redo transaction in-flight lock', () => {
    it('并发第二次 performUndo 应被忽略且只 prepare 一次', async () => {
      const snapshot = { tasks: [createTask()], connections: [] };
      mockUndoService.prepareUndo.mockReturnValue({
        type: 'task-update',
        projectId: 'proj-1',
        data: { before: snapshot, after: {} },
      });

      const first = service.performUndo();
      const second = service.performUndo();

      await expect(second).resolves.toBe(false);
      await expect(first).resolves.toBe(true);
      expect(mockUndoService.prepareUndo).toHaveBeenCalledTimes(1);
      expect(mockUndoService.commitPreparedUndo).toHaveBeenCalledTimes(1);

      // 事务结束后锁应释放：再次 undo 允许重新 prepare
      await expect(service.performUndo()).resolves.toBe(true);
      expect(mockUndoService.prepareUndo).toHaveBeenCalledTimes(2);
    });

    it('并发第二次 performRedo 应被忽略且只 prepare 一次', async () => {
      const snapshot = { tasks: [createTask()], connections: [] };
      mockUndoService.prepareRedo.mockReturnValue({
        type: 'task-update',
        projectId: 'proj-1',
        data: { before: {}, after: snapshot },
      });

      const first = service.performRedo();
      const second = service.performRedo();

      await expect(second).resolves.toBe(false);
      await expect(first).resolves.toBe(true);
      expect(mockUndoService.prepareRedo).toHaveBeenCalledTimes(1);
      expect(mockUndoService.commitPreparedRedo).toHaveBeenCalledTimes(1);
    });

    it('undo 事务进行中时并发 performRedo 也应被忽略', async () => {
      const snapshot = { tasks: [createTask()], connections: [] };
      mockUndoService.prepareUndo.mockReturnValue({
        type: 'task-update',
        projectId: 'proj-1',
        data: { before: snapshot, after: {} },
      });

      const undoPromise = service.performUndo();
      const redoPromise = service.performRedo();

      await expect(redoPromise).resolves.toBe(false);
      await expect(undoPromise).resolves.toBe(true);
      expect(mockUndoService.prepareRedo).not.toHaveBeenCalled();
    });
  });

  // ==================== recordAndUpdate ====================

  describe('recordAndUpdate', () => {
    it('explicit A durable work commits to A but returns false after A→B→A ownership drift', async () => {
      const queueWrite = createDeferred<string>();
      const projectA = createProject({
        id: 'proj-1',
        tasks: [createTask({ id: 'shared-task', title: 'A before' })],
      });
      mockProjectState.activeProject.mockReturnValue(projectA);
      mockProjectState.getProjectWithCurrentData.mockImplementation((projectId: string) =>
        projectId === projectA.id ? projectA : undefined);
      mockActionQueue.enqueueDurably.mockReturnValueOnce(queueWrite.promise);

      const pending = service.recordAndUpdateProjectDurably('proj-1', project => ({
        ...project,
        tasks: project.tasks.map(task => task.id === 'shared-task'
          ? { ...task, title: 'A after', updatedAt: '2026-07-31T00:00:00.000Z' }
          : task),
      }), { updateType: 'content' });
      mockProjectState.setActiveProjectOwner('proj-2');
      mockProjectState.setActiveProjectOwner('proj-1');
      queueWrite.resolve('queued-a');

      await expect(pending).resolves.toBe(false);
      expect(mockProjectState.updateProjects).toHaveBeenCalledOnce();
      expect(mockToastService.error).not.toHaveBeenCalled();
    });

    it('should apply mutator and record undo action', async () => {
      const mutator = vi.fn((p: Project) => ({ ...p, name: 'Updated' }));

      await expect(service.recordAndUpdate(mutator)).resolves.toBe(true);

      expect(mockProjectState.updateProjects).toHaveBeenCalled();
      expect(mockUndoService.recordAction).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'task-update', projectId: 'proj-1' }),
        expect.any(Number)
      );
      expect(mockSyncCoordinator.markLocalChanges).toHaveBeenCalledWith('structure');
      expect(mockSyncCoordinator.schedulePersist).toHaveBeenCalled();
    });

    it('should durably enqueue structure mutations before exposing them through the default API', async () => {
      const queueWrite = createDeferred<string>();
      const project = createProject({
        tasks: [
          createTask({
            id: 'task-default-durable',
            title: 'Before',
            updatedAt: '2026-06-15T00:00:00.000Z',
          }),
        ],
      });
      mockProjectState.activeProject.mockReturnValue(project);
      mockProjectState.updateProjects.mockImplementation((fn: (projects: Project[]) => Project[]) =>
        fn([project]));
      mockActionQueue.enqueueDurably.mockReturnValueOnce(queueWrite.promise);

      const resultPromise = service.recordAndUpdate((currentProject) => ({
        ...currentProject,
        tasks: currentProject.tasks.map(task =>
          task.id === 'task-default-durable'
            ? { ...task, title: 'After', updatedAt: '2026-06-15T01:00:00.000Z' }
            : task,
        ),
      }));

      expect(mockActionQueue.enqueueDurably).toHaveBeenCalledWith(expect.objectContaining({
        type: 'update',
        entityType: 'task',
        entityId: 'task-default-durable',
      }));
      expect(mockProjectState.updateProjects).not.toHaveBeenCalled();
      expect(mockUndoService.recordAction).not.toHaveBeenCalled();
      expect(mockChangeTracker.trackTaskUpdate).not.toHaveBeenCalled();

      queueWrite.resolve('queued-default-action');
      await expect(resultPromise).resolves.toBe(true);

      expect(mockProjectState.updateProjects).toHaveBeenCalledOnce();
      expect(mockUndoService.recordAction).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'task-update', projectId: 'proj-1' }),
        expect.any(Number),
      );
      expect(mockChangeTracker.trackTaskUpdate).toHaveBeenCalledWith(
        'proj-1',
        expect.objectContaining({ id: 'task-default-durable', title: 'After' }),
        expect.arrayContaining(['title']),
      );
    });

    it('should serialize rapid default updates instead of dropping the second mutation', async () => {
      const firstQueueWrite = createDeferred<string>();
      const project = createProject({
        tasks: [
          createTask({
            id: 'task-default-serial',
            title: 'Initial',
            updatedAt: '2026-06-15T00:00:00.000Z',
          }),
        ],
      });
      const committedProjects: Project[] = [project];
      mockProjectState.activeProject.mockImplementation(() => committedProjects[0]);
      mockProjectState.updateProjects.mockImplementation((fn: (projects: Project[]) => Project[]) => {
        const nextProjects = fn(committedProjects);
        committedProjects.splice(0, committedProjects.length, ...nextProjects);
        return nextProjects;
      });
      mockActionQueue.enqueueDurably
        .mockReturnValueOnce(firstQueueWrite.promise)
        .mockResolvedValueOnce('queued-second-action');

      const firstResult = service.recordAndUpdate((currentProject) => ({
        ...currentProject,
        tasks: currentProject.tasks.map(task =>
          task.id === 'task-default-serial'
            ? { ...task, title: 'First', updatedAt: '2026-06-15T01:00:00.000Z' }
            : task,
        ),
      }));
      const secondResult = service.recordAndUpdate((currentProject) => ({
        ...currentProject,
        tasks: currentProject.tasks.map(task =>
          task.id === 'task-default-serial'
            ? { ...task, title: 'Second', updatedAt: '2026-06-15T02:00:00.000Z' }
            : task,
        ),
      }));

      expect(mockActionQueue.enqueueDurably).toHaveBeenCalledTimes(1);
      expect(mockProjectState.updateProjects).not.toHaveBeenCalled();

      firstQueueWrite.resolve('queued-first-action');
      await expect(firstResult).resolves.toBe(true);
      await expect(secondResult).resolves.toBe(true);

      expect(mockActionQueue.enqueueDurably).toHaveBeenCalledTimes(2);
      expect(committedProjects[0].tasks[0]).toEqual(expect.objectContaining({
        id: 'task-default-serial',
        title: 'Second',
      }));
    });

    registerTaskRecordTrackingQueuedContextSpecs(() => harness);

    it('should skip when no active project', async () => {
      mockProjectState.activeProject.mockReturnValue(null);
      const mutator = vi.fn();

      await expect(service.recordAndUpdate(mutator)).resolves.toBe(false);

      expect(mutator).not.toHaveBeenCalled();
    });

    it('should set lastUpdateType to structure', () => {
      service.recordAndUpdate((p) => p);
      expect(service.lastUpdateType).toBe('structure');
    });

    it('should enqueue durable outbox entry when creating a task', async () => {
      const project = createProject({ tasks: [] });
      mockProjectState.activeProject.mockReturnValue(project);
      mockProjectState.updateProjects.mockImplementation((fn: (projects: Project[]) => Project[]) => {
        fn([project]);
      });

      await expect(service.recordAndUpdate((currentProject) => ({
        ...currentProject,
        tasks: [
          createTask({
            id: 'task-created',
            title: 'Created task',
            updatedAt: '2026-06-13T01:00:00.000Z',
          }),
        ],
      }))).resolves.toBe(true);

      expect(mockChangeTracker.trackTaskCreate).toHaveBeenCalledWith(
        'proj-1',
        expect.objectContaining({ id: 'task-created' }),
      );
      expect(mockActionQueue.enqueueDurably).toHaveBeenCalledWith(expect.objectContaining({
        type: 'create',
        entityType: 'task',
        entityId: 'task-created',
        payload: expect.objectContaining({
          projectId: 'proj-1',
          sourceUserId: 'test-user',
          task: expect.objectContaining({ id: 'task-created', title: 'Created task' }),
        }),
      }));
    });

    it('should leave the local task mutation uncommitted when durable outbox write fails', async () => {
      mockActionQueue.enqueueDurably.mockResolvedValueOnce('');
      const beforeTask = createTask({
        id: 'task-before',
        title: 'Before',
        updatedAt: '2026-06-13T00:00:00.000Z',
      });
      const project = createProject({ tasks: [beforeTask] });
      const updateFns: Array<(projects: Project[]) => Project[]> = [];
      mockProjectState.activeProject.mockReturnValue(project);
      mockProjectState.updateProjects.mockImplementation((fn: (projects: Project[]) => Project[]) => {
        updateFns.push(fn);
        return fn([project]);
      });

      await expect(service.recordAndUpdate((currentProject) => ({
        ...currentProject,
        tasks: [
          ...currentProject.tasks,
          createTask({
            id: 'task-durable-failed',
            title: 'Will rollback',
            updatedAt: '2026-06-13T01:00:00.000Z',
          }),
        ],
      }))).resolves.toBe(false);

      expect(mockActionQueue.enqueueDurably).toHaveBeenCalledWith(expect.objectContaining({
        type: 'create',
        entityType: 'task',
        entityId: 'task-durable-failed',
      }));
      expect(updateFns).toEqual([]);
      expect(mockToastService.error).toHaveBeenCalledWith(
        '本地保存失败',
        expect.stringContaining('离线同步队列未能写入'),
      );
    });

    it('should persist local-only snapshots before exposing task mutations to UI', async () => {
      const localOnlyTask = createTask({
        id: 'task-local-only',
        title: 'Before local save',
        updatedAt: '2026-06-13T00:00:00.000Z',
      });
      const project = createProject({
        syncSource: 'local-only',
        tasks: [localOnlyTask],
      });
      const committedProjects: Project[] = [];
      mockProjectState.activeProject.mockReturnValue(project);
      mockProjectState.getProjectsWithCurrentData.mockReturnValue([project]);
      mockProjectState.updateProjects.mockImplementation((fn: (projects: Project[]) => Project[]) => {
        const nextProjects = fn([project]);
        committedProjects.push(...nextProjects);
        return nextProjects;
      });

      await expect(service.recordAndUpdate((currentProject) => ({
        ...currentProject,
        tasks: currentProject.tasks.map(task => task.id === 'task-local-only'
          ? {
              ...task,
              title: 'After local save',
              updatedAt: '2026-06-13T01:00:00.000Z',
            }
          : task),
      }))).resolves.toBe(true);

      expect(mockActionQueue.enqueueDurably).not.toHaveBeenCalled();
      expect(mockSyncCoordinator.saveOfflineSnapshotAndWait).toHaveBeenCalledBefore(
        mockProjectState.updateProjects,
      );
      expect(mockSyncCoordinator.saveOfflineSnapshotAndWait).toHaveBeenCalledWith(
        [expect.objectContaining({
          id: 'proj-1',
          tasks: [expect.objectContaining({
            id: 'task-local-only',
            title: 'After local save',
          })],
        })],
        'test-user',
      );
      expect(committedProjects[0]).toEqual(expect.objectContaining({
        id: 'proj-1',
        tasks: [expect.objectContaining({
          id: 'task-local-only',
          title: 'After local save',
        })],
      }));
      expect(mockSyncCoordinator.markLocalChanges).toHaveBeenCalledWith('structure');
      expect(mockSyncCoordinator.schedulePersist).toHaveBeenCalled();
    });

    it('should track deleted tasks with the pre-delete snapshot for delete CAS', async () => {
      const taskBeforeDelete = createTask({
        id: 'task-delete-cas',
        updatedAt: '2026-05-14T09:30:00.000Z',
      });
      const project = createProject({ tasks: [taskBeforeDelete] });
      mockProjectState.activeProject.mockReturnValue(project);
      mockProjectState.updateProjects.mockImplementation((fn: (projects: Project[]) => Project[]) => {
        fn([project]);
      });

      await expect(service.recordAndUpdate((currentProject) => ({
        ...currentProject,
        tasks: [],
      }))).resolves.toBe(true);

      expect(mockChangeTracker.trackTaskDelete).toHaveBeenCalledWith(
        'proj-1',
        'task-delete-cas',
        expect.objectContaining({
          id: 'task-delete-cas',
          updatedAt: '2026-05-14T09:30:00.000Z',
        }),
      );
      expect(mockActionQueue.enqueueDurably).toHaveBeenCalledWith(expect.objectContaining({
        type: 'delete',
        entityType: 'task',
        entityId: 'task-delete-cas',
        payload: expect.objectContaining({
          taskId: 'task-delete-cas',
          projectId: 'proj-1',
          sourceUserId: 'test-user',
          baseUpdatedAt: '2026-05-14T09:30:00.000Z',
        }),
      }));
    });

    it('should soft-delete shadow connections that duplicate parentId edges', async () => {
      const project = createProject({
        tasks: [
          createTask({ id: 'task-1', parentId: null }),
          createTask({ id: 'task-2', parentId: 'task-1' }),
        ],
        connections: [createConnection({ id: 'conn-shadow', source: 'task-1', target: 'task-2' })],
      });

      mockProjectState.activeProject.mockReturnValue(project);
      mockProjectState.updateProjects.mockImplementation((fn: (projects: Project[]) => Project[]) => {
        const [updatedProject] = fn([project]);
        project.tasks = updatedProject.tasks;
        project.connections = updatedProject.connections;
        return [updatedProject];
      });

      await expect(service.recordAndUpdate((currentProject) => ({ ...currentProject }))).resolves.toBe(true);

      expect(project.connections[0]).toEqual(
        expect.objectContaining({
          id: 'conn-shadow',
          deletedAt: expect.any(String),
          updatedAt: expect.any(String),
        })
      );
    });
  });

  registerTaskRecordTrackingDurableSpecs({
    service: () => service,
    mockProjectState: () => mockProjectState,
    mockUndoService: () => mockUndoService,
    mockSyncCoordinator: () => mockSyncCoordinator,
    mockChangeTracker: () => mockChangeTracker,
    mockActionQueue: () => mockActionQueue,
    mockAuthService: () => harness.mockAuthService,
    mockLoggerCategory: () => mockLoggerCategory,
    mockToastService: () => mockToastService,
  });
  registerTaskRecordTrackingSyncResultSpecs({
    service: () => service,
    destroyHarness: () => harness.destroy(),
    mockOptimisticState: () => mockOptimisticState,
    mockSyncCoordinator: () => mockSyncCoordinator,
    mockAuthService: () => harness.mockAuthService,
  });

});
