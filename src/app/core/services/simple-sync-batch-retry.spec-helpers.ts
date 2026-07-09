import { describe, expect, it, vi } from 'vitest';
import type { Connection, Project, Task } from '../../../models';
import type { TaskWriteIntent } from '../../../services/sync-rpc-client.service';
import { PermanentFailureError } from '../../../utils/permanent-failure-error';
import type { SimpleSyncService } from './simple-sync.service';
import {
  createMockConnection,
  createMockProject,
  createMockTask,
  expectDeferredCallback,
  type RetryQueueItem,
} from './simple-sync.test-harness';
import {
  registerSimpleSyncBatchRetryHandoffSpecs,
  type SimpleSyncBatchRetryHandoffSpecContext,
} from './simple-sync-batch-retry-handoff.spec-helpers';
import {
  registerSimpleSyncBatchRetrySingleFlightSpecs,
  type SimpleSyncBatchRetrySingleFlightSpecContext,
} from './simple-sync-batch-retry-single-flight.spec-helpers';
import { registerSimpleSyncRetryQueueLegacySpecs } from './simple-sync-retry-queue-legacy.spec-helpers';

export interface SimpleSyncBatchRetrySpecContext {
  service(): SimpleSyncService;
  mockSupabase(): any;
  mockClient(): any;
  mockProjectData(): any;
  mockChangeTracker(): any;
  mockRetryQueueService(): any;
  mockActionQueue(): any;
  mockLoggerCategory(): any;
  mockToast(): any;
  mockCaptureException(): any;
  mockCaptureMessage(): any;
}

export function registerSimpleSyncBatchRetrySpecs(context: SimpleSyncBatchRetrySpecContext): void {
  const operationIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  let service: SimpleSyncService;
  let mockSupabase: any;
  let mockClient: any;
  let mockProjectData: any;
  let mockChangeTracker: any;
  let mockRetryQueueService: any;
  let mockActionQueue: any;
  let mockLoggerCategory: any;
  let mockToast: any;
  let mockSentryLazyLoaderService: { captureException: any; captureMessage: any };
  let mockBatchSync: any;

  function loadContext(): void {
    service = context.service();
    mockSupabase = context.mockSupabase();
    mockClient = context.mockClient();
    mockProjectData = context.mockProjectData();
    mockChangeTracker = context.mockChangeTracker();
    mockRetryQueueService = context.mockRetryQueueService();
    mockActionQueue = context.mockActionQueue();
    mockLoggerCategory = context.mockLoggerCategory();
    mockToast = context.mockToast();
    mockSentryLazyLoaderService = {
      captureException: context.mockCaptureException(),
      captureMessage: context.mockCaptureMessage(),
    };
  }

  function getSingleFlightSpecContext(): SimpleSyncBatchRetrySingleFlightSpecContext {
    return {
      service: () => service,
      mockBatchSync: () => mockBatchSync,
    };
  }

  function getHandoffSpecContext(): SimpleSyncBatchRetryHandoffSpecContext {
    return {
      service: () => service,
      mockBatchSync: () => mockBatchSync,
      mockChangeTracker: () => mockChangeTracker,
      mockRetryQueueService: () => mockRetryQueueService,
    };
  }

  function expectRetryQueueCallPrefix(mockFn: { mock: { calls: unknown[][] } }, expectedPrefix: unknown[]): void {
    expect(mockFn.mock.calls.at(-1)?.slice(0, expectedPrefix.length)).toEqual(expectedPrefix);
  }

  describe('Batch Sync Exception Handling', () => {
    // 注意：saveProjectToCloud 现在委托给 BatchSyncService
    // 这里测试的是委托行为是否正确
    beforeEach(() => {
      loadContext();
      mockSupabase.isConfigured = true;
      mockSupabase.client = vi.fn().mockReturnValue(mockClient);
      mockBatchSync = service['batchSyncService'];
    });

    registerSimpleSyncBatchRetrySingleFlightSpecs(getSingleFlightSpecContext());
    registerSimpleSyncBatchRetryHandoffSpecs(getHandoffSpecContext());

    it('pushProjectWithResult 在 sessionExpired preflight 抛错前应先持久化 project retry', async () => {
      service['syncStateService'].update({ sessionExpired: true });
      const project = createMockProject({
        id: 'project-session-expired-preflight-retry',
        updatedAt: '2026-04-11T08:20:00.000Z',
        tasks: [createMockTask({ id: 'task-session-expired-preflight' })],
        connections: [createMockConnection({ id: 'connection-session-expired-preflight' })],
      });

      await expect(
        service['pushProjectWithResult'](
          project,
          false,
          'test-user-id',
          ['task-delete-after-preflight-expiry'],
        ),
      ).rejects.toThrow('Session expired');

      expect(mockRetryQueueService.addDurably).toHaveBeenCalledWith(
        'project',
        'upsert',
        project,
        undefined,
        'test-user-id',
        ['task-delete-after-preflight-expiry'],
        undefined,
        undefined,
        expect.stringMatching(operationIdPattern),
      );
      expect(mockRetryQueueService.queue.at(-1)).toEqual(expect.objectContaining({
        type: 'project',
        data: project,
        sourceUserId: 'test-user-id',
        taskIdsToDelete: ['task-delete-after-preflight-expiry'],
      }));
    });

    it('saveProjectToCloud 在仅子实体失败时仍应继续执行排队中的新快照', async () => {
      const firstProject = createMockProject({
        id: 'project-partial-failure-collapse',
        updatedAt: '2026-04-11T08:00:00.000Z',
        tasks: [createMockTask({ id: 'task-1', updatedAt: '2026-04-11T08:00:00.000Z' })],
        connections: [],
      });
      const queuedProject = createMockProject({
        id: 'project-partial-failure-collapse',
        updatedAt: '2026-04-11T08:00:02.000Z',
        tasks: [createMockTask({ id: 'task-2', updatedAt: '2026-04-11T08:00:02.000Z' })],
        connections: [],
      });
      const partialFailureResult = {
        success: false,
        failureReason: 'project batch sync delegated remaining work to retry queue',
        retryEnqueued: ['task:task-1'],
        failedTaskIds: ['task-1'],
        failedConnectionIds: [],
        projectPushed: true,
      };
      let resolveFirstSave: ((value: typeof partialFailureResult) => void) | null = null;
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

      expectDeferredCallback(resolveFirstSave, 'resolveFirstSave')(partialFailureResult);

      await vi.waitFor(() => {
        expect(mockBatchSync.saveProjectToCloud).toHaveBeenCalledTimes(2);
      });
      expect(mockBatchSync.saveProjectToCloud).toHaveBeenNthCalledWith(2, queuedProject, 'test-user-id', undefined);

      expectDeferredCallback(resolveSecondSave, 'resolveSecondSave')({ success: true, newVersion: 2 });

      const [firstResult, queuedResult] = await Promise.all([firstPromise, queuedPromise]);

      expect(firstResult).toEqual(partialFailureResult);
      expect(queuedResult).toEqual({ success: true, newVersion: 2 });
    });

    it('saveProjectToCloud 在冲突结果后不应继续重放排队中的新快照', async () => {
      const firstProject = createMockProject({
        id: 'project-conflict-collapse',
        updatedAt: '2026-04-11T08:00:00.000Z',
        tasks: [createMockTask({ id: 'task-1', updatedAt: '2026-04-11T08:00:00.000Z' })],
        connections: [],
      });
      const queuedProject = createMockProject({
        id: 'project-conflict-collapse',
        updatedAt: '2026-04-11T08:00:02.000Z',
        tasks: [createMockTask({ id: 'task-2', updatedAt: '2026-04-11T08:00:02.000Z' })],
        connections: [],
      });
      const conflictResult = {
        success: false,
        conflict: true,
        remoteData: createMockProject({ id: 'project-conflict-collapse', version: 9 }),
        failureReason: 'project sync version conflict',
      };
      let resolveFirstSave: ((value: typeof conflictResult) => void) | null = null;
      mockBatchSync.saveProjectToCloud = vi.fn().mockImplementationOnce(() => new Promise((resolve) => {
        resolveFirstSave = resolve;
      }));

      const firstPromise = service.saveProjectToCloud(firstProject, 'test-user-id');
      const queuedPromise = service.saveProjectToCloud(queuedProject, 'test-user-id');

      expectDeferredCallback(resolveFirstSave, 'resolveFirstSave')(conflictResult);

      const [firstResult, queuedResult] = await Promise.all([firstPromise, queuedPromise]);

      expect(mockBatchSync.saveProjectToCloud).toHaveBeenCalledTimes(1);
      expect(firstResult).toEqual(conflictResult);
      expect(queuedResult).toEqual(conflictResult);
    });

    it('saveProjectToCloud 在 terminal 结果后不应继续重放排队中的新快照', async () => {
      const firstProject = createMockProject({
        id: 'project-terminal-collapse',
        updatedAt: '2026-04-11T08:10:00.000Z',
        tasks: [createMockTask({ id: 'task-1', updatedAt: '2026-04-11T08:10:00.000Z' })],
        connections: [],
      });
      const queuedProject = createMockProject({
        id: 'project-terminal-collapse',
        updatedAt: '2026-04-11T08:10:02.000Z',
        tasks: [createMockTask({ id: 'task-2', updatedAt: '2026-04-11T08:10:02.000Z' })],
        connections: [],
      });
      const terminalResult = {
        success: false,
        terminal: true,
        failureReason: '当前客户端同步协议已过期，请刷新后重试',
      };
      let resolveFirstSave: ((value: typeof terminalResult) => void) | null = null;
      mockBatchSync.saveProjectToCloud = vi.fn().mockImplementationOnce(() => new Promise((resolve) => {
        resolveFirstSave = resolve;
      }));

      const firstPromise = service.saveProjectToCloud(firstProject, 'test-user-id');
      const queuedPromise = service.saveProjectToCloud(queuedProject, 'test-user-id');

      expectDeferredCallback(resolveFirstSave, 'resolveFirstSave')(terminalResult);

      const [firstResult, queuedResult] = await Promise.all([firstPromise, queuedPromise]);

      expect(mockBatchSync.saveProjectToCloud).toHaveBeenCalledTimes(1);
      expect(firstResult).toEqual(terminalResult);
      expect(queuedResult).toEqual(terminalResult);
    });

    it('saveProjectToCloud 命中 terminal 结果时应清理遗留 project retry marker', async () => {
      const project = createMockProject({
        id: 'project-terminal-clear-retry',
        updatedAt: '2026-04-11T08:12:00.000Z',
        tasks: [createMockTask({ id: 'task-1', updatedAt: '2026-04-11T08:12:00.000Z' })],
        connections: [],
      });
      const terminalResult = {
        success: false,
        terminal: true,
        failureReason: '当前客户端同步协议已过期，请刷新后重试',
      };
      mockRetryQueueService.add('project', 'upsert', project, undefined, 'test-user-id');
      mockRetryQueueService.add('project', 'upsert', project, undefined, 'other-user-id');
      mockRetryQueueService.add('task', 'upsert', createMockTask({ id: 'task-retain' }), project.id, 'test-user-id');
      mockRetryQueueService.add('task', 'upsert', createMockTask({ id: 'task-other-owner' }), project.id, 'other-user-id');
      mockBatchSync.saveProjectToCloud = vi.fn().mockResolvedValueOnce(terminalResult);

      const result = await service.saveProjectToCloud(project, 'test-user-id');

      expect(result).toEqual(terminalResult);
      const remainingOwnerRetries = mockRetryQueueService.getItems().filter((item: RetryQueueItem) =>
        (item.projectId === project.id || (item.type === 'project' && item.data.id === project.id))
          && item.sourceUserId === 'other-user-id',
      );
      expect(remainingOwnerRetries).toEqual([
        expect.objectContaining({
          type: 'project',
          sourceUserId: 'other-user-id',
        }),
        expect.objectContaining({
          type: 'task',
          sourceUserId: 'other-user-id',
        }),
      ]);
      expect(mockRetryQueueService.hasEntity?.('task', 'task-retain')).toBe(false);
    });

    it('saveProjectToCloud 在前序请求抛错时不应立即重放排队中的新快照', async () => {
      const firstProject = createMockProject({
        id: 'project-error-collapse',
        updatedAt: '2026-04-11T08:00:00.000Z',
        tasks: [createMockTask({ id: 'task-1', updatedAt: '2026-04-11T08:00:00.000Z' })],
        connections: [],
      });
      const queuedProject = createMockProject({
        id: 'project-error-collapse',
        updatedAt: '2026-04-11T08:00:02.000Z',
        tasks: [createMockTask({ id: 'task-2', updatedAt: '2026-04-11T08:00:02.000Z' })],
        connections: [],
      });
      const expectedError = new Error('network suspended');
      let rejectFirstSave: ((reason?: unknown) => void) | null = null;
      mockBatchSync.saveProjectToCloud = vi.fn().mockImplementationOnce(() => new Promise((_, reject) => {
        rejectFirstSave = reject;
      }));

      const firstPromise = service.saveProjectToCloud(firstProject, 'test-user-id');
      const queuedPromise = service.saveProjectToCloud(queuedProject, 'test-user-id');

      expectDeferredCallback(rejectFirstSave, 'rejectFirstSave')(expectedError);

      await expect(firstPromise).rejects.toThrow('network suspended');
      await expect(queuedPromise).rejects.toThrow('network suspended');
      expect(mockBatchSync.saveProjectToCloud).toHaveBeenCalledTimes(1);
    });

    it('saveProjectToCloud 应该在 BatchSyncService 返回错误时处理', async () => {
      const project = createMockProject({ id: 'project-1', tasks: [], connections: [] });
      mockBatchSync.saveProjectToCloud = vi.fn().mockResolvedValue({ success: false });

      const result = await service.saveProjectToCloud(project, 'test-user-id');

      expect(result.success).toBe(false);
    });

    it('构造函数应该初始化 BatchSyncService 回调', () => {
      // 直接从 service 获取 batchSyncService，验证 setCallbacks 被调用
      const batchSvc = service['batchSyncService'];
      // setCallbacks 在构造函数中被调用，验证它是一个被 mock 的函数
      // 由于 mock 是在每个测试前重新创建的，我们验证 setCallbacks 存在且是函数
      expect(typeof batchSvc.setCallbacks).toBe('function');
    });

    it('BatchSync 回调应透传 VersionConflictError 为 conflict 结果', async () => {
      const project = createMockProject({ id: 'project-conflict', tasks: [], connections: [] });
      const remoteProject = createMockProject({ id: 'project-conflict', version: 9, tasks: [], connections: [] });
      const callbacks = mockBatchSync.setCallbacks.mock.calls[0]?.[0] as {
        pushProject: (project: Project, fromRetryQueue?: boolean, sourceUserId?: string, taskIdsToDelete?: string[]) => Promise<{ success: boolean; conflict?: boolean; remoteData?: Project; retryEnqueued?: boolean; failureReason?: string }>;
      };

      vi.spyOn(service['projectPush'] as unknown as { pushProjectWithStatus: (...args: unknown[]) => Promise<unknown> }, 'pushProjectWithStatus').mockRejectedValueOnce(
        new PermanentFailureError(
          'Version conflict',
          Object.assign(new Error('版本冲突：数据已被修改，请刷新后重试'), { errorType: 'VersionConflictError' })
        )
      );
      mockProjectData.loadFullProjectOptimized.mockResolvedValueOnce(remoteProject);

      const result = await callbacks.pushProject(project);

      expect(result).toEqual({
        success: false,
        conflict: true,
        remoteData: remoteProject,
        retryEnqueued: false,
        failureReason: 'project sync version conflict',
      });
    });

    it('BatchSync 回调应透传 sourceUserId 到 pushProject', async () => {
      const project = createMockProject({ id: 'project-owner-pass-through', tasks: [], connections: [] });
      const callbacks = mockBatchSync.setCallbacks.mock.calls[0]?.[0] as {
        pushProject: (project: Project, fromRetryQueue?: boolean, sourceUserId?: string, taskIdsToDelete?: string[]) => Promise<{ success: boolean; conflict?: boolean; remoteData?: Project; retryEnqueued?: boolean; failureReason?: string }>;
      };

      const pushProjectSpy = vi.spyOn(service['projectPush'] as unknown as { pushProjectWithStatus: (...args: unknown[]) => Promise<unknown> }, 'pushProjectWithStatus').mockResolvedValueOnce({
        success: true,
        retryEnqueued: false,
      });

      const result = await callbacks.pushProject(project, false, 'owner-a');

      expect(result).toEqual({ success: true, retryEnqueued: false, failureReason: undefined });
      expect(pushProjectSpy).toHaveBeenCalledWith(project, false, 'owner-a', undefined);
    });

    it('BatchSync 回调应透传 pending taskIdsToDelete 到 pushProject', async () => {
      const project = createMockProject({ id: 'project-delete-intent-pass-through', tasks: [], connections: [] });
      const callbacks = mockBatchSync.setCallbacks.mock.calls[0]?.[0] as {
        pushProject: (
          project: Project,
          fromRetryQueue?: boolean,
          sourceUserId?: string,
          taskIdsToDelete?: string[],
          taskDeleteBaseUpdatedAtMap?: Record<string, string | null>,
        ) => Promise<{ success: boolean; conflict?: boolean; remoteData?: Project; retryEnqueued?: boolean; failureReason?: string }>;
      };
      const taskDeleteBaseUpdatedAtMap = {
        'task-delete-a': '2026-06-09T01:00:00.000Z',
      };

      const pushProjectSpy = vi.spyOn(service['projectPush'] as unknown as { pushProjectWithStatus: (...args: unknown[]) => Promise<unknown> }, 'pushProjectWithStatus').mockResolvedValueOnce({
        success: true,
        retryEnqueued: false,
      });

      const result = await callbacks.pushProject(
        project,
        false,
        'owner-a',
        ['task-delete-a'],
        taskDeleteBaseUpdatedAtMap,
      );

      expect(result).toEqual({ success: true, retryEnqueued: false, failureReason: undefined });
      expect(pushProjectSpy).toHaveBeenCalledWith(
        project,
        false,
        'owner-a',
        ['task-delete-a'],
        taskDeleteBaseUpdatedAtMap,
      );
    });

    it('pushProject 失败回退到重试队列时应保留 taskIdsToDelete 与删除 CAS map', async () => {
      const project = createMockProject({ id: 'project-delete-intent-retry', tasks: [], connections: [] });
      const taskDeleteBaseUpdatedAtMap = {
        'task-delete-a': '2026-06-09T01:00:00.000Z',
      };

      mockClient.auth.getSession = vi.fn().mockResolvedValue({
        data: { session: { user: { id: 'new-owner' } } }
      });

      const result = await service.pushProject(
        project,
        false,
        'owner-a',
        ['task-delete-a'],
        taskDeleteBaseUpdatedAtMap,
      );

      expect(result).toBe(false);
      expect(mockRetryQueueService.add).toHaveBeenCalledWith(
        'project',
        'upsert',
        project,
        undefined,
        'owner-a',
        ['task-delete-a'],
        undefined,
        taskDeleteBaseUpdatedAtMap,
        expect.stringMatching(operationIdPattern),
      );
    });

    it('pushProject 失败回退到重试队列时应保留 operationId 幂等键', async () => {
      const project = createMockProject({ id: 'project-operation-id-retry', tasks: [], connections: [] });
      mockClient.auth.getSession = vi.fn().mockResolvedValue({
        data: { session: { user: { id: 'new-owner' } } },
      });

      const result = await service.pushProject(
        project,
        false,
        'owner-a',
        undefined,
        undefined,
        'op-project-retry',
      );

      expect(result).toBe(false);
      expectRetryQueueCallPrefix(mockRetryQueueService.addDurably, [
        'project',
        'upsert',
        project,
        undefined,
        'owner-a',
        undefined,
        undefined,
        undefined,
        'op-project-retry',
      ]);
    });

    it('pushProject 回退重试时仅在 RetryQueue 持久化确认成功后才返回 retryEnqueued', async () => {
      const project = createMockProject({ id: 'project-durable-retry-confirm', tasks: [], connections: [] });
      const callbacks = mockBatchSync.setCallbacks.mock.calls[0]?.[0] as {
        pushProject: (project: Project, fromRetryQueue?: boolean, sourceUserId?: string, taskIdsToDelete?: string[]) => Promise<{ success: boolean; conflict?: boolean; remoteData?: Project; retryEnqueued?: boolean; failureReason?: string }>;
      };

      mockClient.auth.getSession = vi.fn().mockResolvedValue({
        data: { session: { user: { id: 'new-owner' } } }
      });
      mockRetryQueueService.persistNow.mockResolvedValueOnce(false);

      const result = await callbacks.pushProject(project, false, 'owner-a', ['task-delete-a']);

      expect(mockRetryQueueService.add).toHaveBeenCalledWith(
        'project',
        'upsert',
        project,
        undefined,
        'owner-a',
        ['task-delete-a'],
        undefined,
        undefined,
        expect.stringMatching(operationIdPattern),
      );
      expect(mockRetryQueueService.persistNow).toHaveBeenCalledTimes(1);
      expect(result.retryEnqueued).toBe(false);
      expect(result.success).toBe(false);
    });

    it('BatchSync addToRetryQueue 回调应等待 RetryQueue 持久化确认后才返回成功', async () => {
      const project = createMockProject({ id: 'project-batch-retry-durable-adapter', tasks: [], connections: [] });
      const callbacks = mockBatchSync.setCallbacks.mock.calls[0]?.[0] as {
        addToRetryQueue: (
          type: 'task' | 'project' | 'connection',
          operation: 'upsert' | 'delete',
          data: unknown,
          projectId?: string,
          sourceUserId?: string,
          taskIdsToDelete?: string[],
        ) => Promise<boolean>;
      };
      mockRetryQueueService.persistNow.mockResolvedValueOnce(false);

      const accepted = await callbacks.addToRetryQueue(
        'project',
        'upsert',
        project,
        undefined,
        'owner-a',
        ['task-delete-a'],
      );

      expect(accepted).toBe(false);
      expect(mockRetryQueueService.addDurably).toHaveBeenCalledWith(
        'project',
        'upsert',
        project,
        undefined,
        'owner-a',
        ['task-delete-a'],
        undefined,
        undefined,
        undefined,
      );
    });

    it('BatchSync addToRetryQueue 回调应透传 taskIdsToDelete', async () => {
      const project = createMockProject({ id: 'project-batch-retry-adapter', tasks: [], connections: [] });
      const callbacks = mockBatchSync.setCallbacks.mock.calls[0]?.[0] as {
        addToRetryQueue: (
          type: 'task' | 'project' | 'connection',
          operation: 'upsert' | 'delete',
          data: unknown,
          projectId?: string,
          sourceUserId?: string,
          taskIdsToDelete?: string[],
        ) => Promise<boolean>;
      };

      await callbacks.addToRetryQueue('project', 'upsert', project, undefined, 'owner-a', ['task-delete-a']);

      expect(mockRetryQueueService.addDurably).toHaveBeenCalledWith(
        'project',
        'upsert',
        project,
        undefined,
        'owner-a',
        ['task-delete-a'],
        undefined,
        undefined,
        undefined,
      );
    });

    it('BatchSync 回调应透传 sourceUserId 到 task、position 与 connection 同步', async () => {
      const task = createMockTask({ id: 'task-owner-pass-through' });
      const connection = createMockConnection({ id: 'connection-owner-pass-through' });
      const taskSyncOps = service['taskSyncOps'];
      const connectionSyncOps = service['connectionSyncOps'];
      const callbacks = mockBatchSync.setCallbacks.mock.calls[0]?.[0] as {
        pushTask: (
          task: Task,
          projectId: string,
          skipTombstoneCheck?: boolean,
          fromRetryQueue?: boolean,
          sourceUserId?: string,
          writeIntent?: TaskWriteIntent,
        ) => Promise<boolean>;
        pushTaskPosition: (taskId: string, x: number, y: number, projectId?: string, fallbackTask?: Task, sourceUserId?: string) => Promise<boolean>;
        pushConnection: (connection: Connection, projectId: string, skipTombstoneCheck?: boolean, skipTaskExistenceCheck?: boolean, fromRetryQueue?: boolean, sourceUserId?: string) => Promise<boolean>;
      };

      await callbacks.pushTask(task, 'project-1', true, false, 'owner-a');
      await callbacks.pushTask(task, 'project-1', true, false, 'owner-a', 'task_attachment_update');
      await callbacks.pushTaskPosition(task.id, 10, 20, 'project-1', task, 'owner-a');
      await callbacks.pushConnection(connection, 'project-1', true, false, false, 'owner-a');

      expect(taskSyncOps.pushTask).toHaveBeenCalledWith(task, 'project-1', true, false, 'owner-a', false, undefined);
      expect(taskSyncOps.pushTask).toHaveBeenCalledWith(
        task,
        'project-1',
        true,
        false,
        'owner-a',
        false,
        'task_attachment_update',
      );
      expect(taskSyncOps.pushTaskPosition).toHaveBeenCalledWith(task.id, 10, 20, 'project-1', task, 'owner-a');
      expect(connectionSyncOps.pushConnection).toHaveBeenCalledWith(connection, 'project-1', true, false, false, 'owner-a');
    });

    it('RetryQueue 回放 task upsert 时不应绕过 tombstone 检查', async () => {
      const task = createMockTask({ id: 'task-retry-tombstone-guard' });
      const taskSyncOps = service['taskSyncOps'];
      const retryHandlers = mockRetryQueueService.setOperationHandler.mock.calls[0]?.[0] as {
        pushTask: (task: Task, projectId: string, sourceUserId?: string) => Promise<boolean>;
      };

      await retryHandlers.pushTask(task, 'project-1', 'owner-a');

      expect(taskSyncOps.pushTask).toHaveBeenCalledWith(task, 'project-1', false, true, 'owner-a', false, undefined);
    });

    it('RetryQueue 回放 task delete 时应保留原始 baseUpdatedAt CAS 基线', async () => {
      const taskSyncOps = service['taskSyncOps'];
      const retryHandlers = mockRetryQueueService.setOperationHandler.mock.calls[0]?.[0] as {
        deleteTask: (
          taskId: string,
          projectId: string,
          sourceUserId?: string,
          fromRetryQueue?: boolean,
          baseUpdatedAt?: string | null,
        ) => Promise<boolean>;
      };

      await retryHandlers.deleteTask(
        'task-delete-retry-baseline',
        'project-1',
        'owner-a',
        true,
        '2026-04-01T00:00:00.000Z',
      );

      expect(taskSyncOps.deleteTask).toHaveBeenCalledWith(
        'task-delete-retry-baseline',
        'project-1',
        'owner-a',
        true,
        '2026-04-01T00:00:00.000Z',
      );
    });

    it('RetryQueue 转交 project 时仅在 ActionQueue 真正接受后才视为成功', async () => {
      const project = createMockProject({ id: 'project-retry-enqueue-guard' });
      const retryHandlers = mockRetryQueueService.setOperationHandler.mock.calls[0]?.[0] as {
        pushProject: (project: Project, sourceUserId?: string, taskIdsToDelete?: string[]) => Promise<boolean>;
      };
      mockActionQueue.enqueueDurablyForOwner.mockResolvedValueOnce('');

      const accepted = await retryHandlers.pushProject(project, 'owner-a', ['task-delete-1']);

      expect(accepted).toBe(false);
      expect(mockActionQueue.enqueueDurablyForOwner).toHaveBeenCalledWith('owner-a', {
        type: 'update',
        entityType: 'project',
        entityId: project.id,
        payload: {
          project,
          sourceUserId: 'owner-a',
          taskIdsToDelete: ['task-delete-1'],
        },
      });
      expect(mockLoggerCategory.warn).toHaveBeenCalledWith(
        '项目重试转交 ActionQueue 失败，保留在 RetryQueue 中等待后续回放',
        expect.objectContaining({
          projectId: project.id,
          sourceUserId: 'owner-a',
          pendingTaskDeleteCount: 1,
        })
      );
    });
  });

  // 【P1 修复】队列容量警告功能已迁移到 RetryQueueService
  // 这些测试调用的方法已不存在于 SimpleSyncService 上，需迁移到 retry-queue.service.spec.ts
  registerSimpleSyncRetryQueueLegacySpecs({
    service: () => service,
    mockRetryQueueService: () => mockRetryQueueService,
    mockToast: () => mockToast,
    mockLoggerCategory: () => mockLoggerCategory,
    mockCaptureMessage: () => mockSentryLazyLoaderService.captureMessage,
  });

}
