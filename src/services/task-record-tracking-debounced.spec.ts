import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Project } from '../models';
import {
  createConnection,
  createProject,
  createTask,
  createTaskRecordTrackingSpecHarness,
  type TaskRecordTrackingSpecHarness,
} from './task-record-tracking.service.spec-helpers';

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

describe('TaskRecordTrackingService debounced record tracking', () => {
  let harness: TaskRecordTrackingSpecHarness;
  let service: TaskRecordTrackingSpecHarness['service'];
  let mockProjectState: TaskRecordTrackingSpecHarness['mockProjectState'];
  let mockUndoService: TaskRecordTrackingSpecHarness['mockUndoService'];
  let mockSyncCoordinator: TaskRecordTrackingSpecHarness['mockSyncCoordinator'];
  let mockChangeTracker: TaskRecordTrackingSpecHarness['mockChangeTracker'];
  let mockActionQueue: TaskRecordTrackingSpecHarness['mockActionQueue'];
  let mockLoggerCategory: TaskRecordTrackingSpecHarness['mockLoggerCategory'];

  beforeEach(() => {
    harness = createTaskRecordTrackingSpecHarness();
    service = harness.service;
    mockProjectState = harness.mockProjectState;
    mockUndoService = harness.mockUndoService;
    mockSyncCoordinator = harness.mockSyncCoordinator;
    mockChangeTracker = harness.mockChangeTracker;
    mockActionQueue = harness.mockActionQueue;
    mockLoggerCategory = harness.mockLoggerCategory;
  });

  afterEach(() => {
    harness.restoreConsole();
  });

  // ==================== recordAndUpdateDebounced ====================

  describe('recordAndUpdateDebounced', () => {
    it('should apply mutator with debounced undo recording', async () => {
      const mutator = vi.fn((p: Project) => ({ ...p, name: 'Updated' }));

      await expect(service.recordAndUpdateDebounced(mutator)).resolves.toBe(true);

      expect(mockProjectState.updateProjects).toHaveBeenCalled();
      expect(mockUndoService.recordActionDebounced).toHaveBeenCalled();
      expect(mockSyncCoordinator.markLocalChanges).toHaveBeenCalledWith('content');
    });

    it('should durably enqueue content mutations before exposing them through the default debounced API', async () => {
      const queueWrite = createDeferred<string>();
      const project = createProject({
        tasks: [
          createTask({
            id: 'task-default-debounced-durable',
            title: 'Before',
            updatedAt: '2026-06-15T00:00:00.000Z',
          }),
        ],
      });
      mockProjectState.activeProject.mockReturnValue(project);
      mockProjectState.updateProjects.mockImplementation((fn: (projects: Project[]) => Project[]) =>
        fn([project]));
      mockActionQueue.enqueueDurably.mockReturnValueOnce(queueWrite.promise);

      const resultPromise = service.recordAndUpdateDebounced((currentProject) => ({
        ...currentProject,
        tasks: currentProject.tasks.map(task =>
          task.id === 'task-default-debounced-durable'
            ? { ...task, title: 'After', updatedAt: '2026-06-15T01:00:00.000Z' }
            : task,
        ),
      }));

      expect(mockActionQueue.enqueueDurably).toHaveBeenCalledWith(expect.objectContaining({
        type: 'update',
        entityType: 'task',
        entityId: 'task-default-debounced-durable',
      }));
      expect(mockProjectState.updateProjects).not.toHaveBeenCalled();
      expect(mockUndoService.recordActionDebounced).not.toHaveBeenCalled();
      expect(mockChangeTracker.trackTaskUpdate).not.toHaveBeenCalled();

      queueWrite.resolve('queued-default-debounced-action');
      await expect(resultPromise).resolves.toBe(true);

      expect(mockProjectState.updateProjects).toHaveBeenCalledOnce();
      expect(mockUndoService.recordActionDebounced).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'task-update', projectId: 'proj-1' }),
      );
      expect(mockChangeTracker.trackTaskUpdate).toHaveBeenCalledWith(
        'proj-1',
        expect.objectContaining({ id: 'task-default-debounced-durable', title: 'After' }),
        expect.arrayContaining(['title']),
      );
    });

    it('should set lastUpdateType to content', () => {
      service.recordAndUpdateDebounced((p) => p);
      expect(service.lastUpdateType).toBe('content');
    });

    it('should soft-delete shadow connections during debounced updates', async () => {
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

      await expect(service.recordAndUpdateDebounced((currentProject) => ({ ...currentProject }))).resolves.toBe(true);

      expect(project.connections[0]).toEqual(
        expect.objectContaining({
          id: 'conn-shadow',
          deletedAt: expect.any(String),
          updatedAt: expect.any(String),
        })
      );
    });

    it('should track connection update when only title changes', async () => {
      const project = createProject({
        connections: [createConnection()],
      });
      mockProjectState.activeProject.mockReturnValue(project);
      mockProjectState.updateProjects.mockImplementation((fn: (projects: Project[]) => Project[]) => {
        fn([project]);
      });

      await expect(service.recordAndUpdateDebounced((p) => ({
        ...p,
        connections: p.connections.map(conn => ({
          ...conn,
          title: '新标题',
        })),
      }))).resolves.toBe(true);

      expect(mockChangeTracker.trackConnectionUpdate).toHaveBeenCalledWith(
        'proj-1',
        expect.objectContaining({ title: '新标题', description: '旧描述' })
      );
      expect(mockActionQueue.enqueueDurably).toHaveBeenCalledWith(expect.objectContaining({
        type: 'update',
        entityType: 'connection',
        entityId: 'conn-1',
        payload: expect.objectContaining({
          projectId: 'proj-1',
          sourceUserId: 'test-user',
          connection: expect.objectContaining({ id: 'conn-1', title: '新标题' }),
        }),
      }));
    });

    it('should enqueue durable outbox entry when creating a connection', async () => {
      const project = createProject({
        connections: [],
      });
      mockProjectState.activeProject.mockReturnValue(project);
      mockProjectState.updateProjects.mockImplementation((fn: (projects: Project[]) => Project[]) => {
        fn([project]);
      });

      await expect(service.recordAndUpdate((p) => ({
        ...p,
        connections: [
          createConnection({
            id: 'conn-created',
            source: 'task-1',
            target: 'task-2',
            updatedAt: '2026-06-13T00:00:00.000Z',
          }),
        ],
      }))).resolves.toBe(true);

      expect(mockChangeTracker.trackConnectionCreate).toHaveBeenCalledWith(
        'proj-1',
        expect.objectContaining({ id: 'conn-created' }),
      );
      expect(mockActionQueue.enqueueDurably).toHaveBeenCalledWith(expect.objectContaining({
        type: 'create',
        entityType: 'connection',
        entityId: 'conn-created',
        payload: expect.objectContaining({
          projectId: 'proj-1',
          sourceUserId: 'test-user',
          connection: expect.objectContaining({ id: 'conn-created' }),
        }),
      }));
    });

    it('should enqueue connection soft delete as a durable delete operation', async () => {
      const project = createProject({
        connections: [createConnection({ id: 'conn-delete', deletedAt: null })],
      });
      mockProjectState.activeProject.mockReturnValue(project);
      mockProjectState.updateProjects.mockImplementation((fn: (projects: Project[]) => Project[]) => {
        fn([project]);
      });

      await expect(service.recordAndUpdate((p) => ({
        ...p,
        connections: p.connections.map(connection => ({
          ...connection,
          deletedAt: '2026-06-13T00:10:00.000Z',
          updatedAt: '2026-06-13T00:10:00.000Z',
        })),
      }))).resolves.toBe(true);

      expect(mockChangeTracker.trackConnectionUpdate).toHaveBeenCalledWith(
        'proj-1',
        expect.objectContaining({ id: 'conn-delete', deletedAt: '2026-06-13T00:10:00.000Z' }),
      );
      expect(mockActionQueue.enqueueDurably).toHaveBeenCalledWith(expect.objectContaining({
        type: 'delete',
        entityType: 'connection',
        entityId: 'conn-delete',
        payload: expect.objectContaining({
          projectId: 'proj-1',
          sourceUserId: 'test-user',
          connection: expect.objectContaining({
            id: 'conn-delete',
            deletedAt: '2026-06-13T00:10:00.000Z',
          }),
        }),
      }));
    });

    it('should track active connection update by id even when deleted history shares the same endpoints', async () => {
      const activeConnection = createConnection({
        id: 'conn-active',
        title: '活跃标题',
        description: '活跃描述',
      });
      const deletedHistory = createConnection({
        id: 'conn-deleted',
        title: '历史标题',
        description: '历史描述',
        deletedAt: '2026-04-19T00:00:00.000Z',
        updatedAt: '2026-04-19T00:00:00.000Z',
      });
      const project = createProject({
        connections: [activeConnection, deletedHistory],
      });
      mockProjectState.activeProject.mockReturnValue(project);
      mockProjectState.updateProjects.mockImplementation((fn: (projects: Project[]) => Project[]) => {
        fn([project]);
      });

      await expect(service.recordAndUpdateDebounced((p) => ({
        ...p,
        connections: p.connections.map(conn => (
          conn.id === 'conn-active'
            ? { ...conn, title: '已更新标题' }
            : conn
        )),
      }))).resolves.toBe(true);

      expect(mockChangeTracker.trackConnectionUpdate).toHaveBeenCalledWith(
        'proj-1',
        expect.objectContaining({
          id: 'conn-active',
          title: '已更新标题',
          description: '活跃描述',
        })
      );
    });

    it('should ignore malformed connections without ids instead of throwing', async () => {
      const project = createProject({
        connections: [createConnection({ id: '' as unknown as string })],
      });
      mockProjectState.activeProject.mockReturnValue(project);
      mockProjectState.updateProjects.mockImplementation((fn: (projects: Project[]) => Project[]) => {
        fn([project]);
      });

      const resultPromise = service.recordAndUpdateDebounced((p) => ({
          ...p,
          name: 'Updated project name',
      }));
      await expect(resultPromise).resolves.toBe(true);

      expect(mockLoggerCategory.error).toHaveBeenCalled();
    });

    it('should track connection update when endpoints change but id stays the same', async () => {
      const project = createProject({
        connections: [createConnection({ id: 'conn-relink', source: 'task-1', target: 'task-2' })],
      });
      mockProjectState.activeProject.mockReturnValue(project);
      mockProjectState.updateProjects.mockImplementation((fn: (projects: Project[]) => Project[]) => {
        fn([project]);
      });

      await expect(service.recordAndUpdateDebounced((p) => ({
        ...p,
        connections: p.connections.map(conn => (
          conn.id === 'conn-relink'
            ? { ...conn, target: 'task-3' }
            : conn
        )),
      }))).resolves.toBe(true);

      expect(mockChangeTracker.trackConnectionUpdate).toHaveBeenCalledWith(
        'proj-1',
        expect.objectContaining({
          id: 'conn-relink',
          source: 'task-1',
          target: 'task-3',
        })
      );
    });

    it('should track attentionMeta changes as dirty task fields', async () => {
      const beforeTask = createTask({
        attentionMeta: null,
        updatedAt: '2026-06-05T00:00:00.000Z',
      });
      const project = createProject({ tasks: [beforeTask] });
      mockProjectState.activeProject.mockReturnValue(project);
      mockProjectState.updateProjects.mockImplementation((fn: (projects: Project[]) => Project[]) => {
        fn([project]);
      });

      await expect(service.recordAndUpdateDebounced((p) => ({
        ...p,
        tasks: p.tasks.map(task => ({
          ...task,
          attentionMeta: {
            items: [{
              id: 'attention-1',
              text: '接口字段未冻结',
              level: 'blocker' as const,
              done: false,
              createdAt: '2026-06-05T00:00:00.000Z',
              updatedAt: '2026-06-05T01:00:00.000Z',
            }],
            updatedAt: '2026-06-05T01:00:00.000Z',
          },
          updatedAt: '2026-06-05T01:00:00.000Z',
        })),
      }))).resolves.toBe(true);

      expect(mockChangeTracker.trackTaskUpdate).toHaveBeenCalledWith(
        'proj-1',
        expect.objectContaining({ id: 'task-1' }),
        expect.arrayContaining(['attentionMeta']),
      );
      expect(mockActionQueue.enqueueDurably).toHaveBeenCalledWith(expect.objectContaining({
        type: 'update',
        entityType: 'task',
        entityId: 'task-1',
        payload: expect.objectContaining({
          projectId: 'proj-1',
          sourceUserId: 'test-user',
          task: expect.objectContaining({
            id: 'task-1',
            attentionMeta: expect.objectContaining({
              updatedAt: '2026-06-05T01:00:00.000Z',
            }),
          }),
        }),
      }));
    });
  });


});
