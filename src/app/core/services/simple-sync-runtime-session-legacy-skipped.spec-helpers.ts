import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
  createMockConnection,
  createMockTask,
} from './simple-sync.service.spec-context';
import type { RetryQueueItem } from './simple-sync.service.spec-context';
import type { SimpleSyncRuntimeSessionSpecContext } from './simple-sync-runtime-session.spec-helpers';

export function registerSimpleSyncRuntimeSessionLegacySkippedSpecs(
  context: SimpleSyncRuntimeSessionSpecContext,
): void {
  let service: any;
  let mockSupabase: any;
  let mockClient: any;
  let mockCaptureException: any;
  let mockRetryQueueService: any;

  function loadContext(): void {
    service = context.service();
    mockSupabase = context.mockSupabase();
    mockClient = context.mockClient();
    mockCaptureException = context.mockCaptureException();
    mockRetryQueueService = context.mockRetryQueueService();
  }

  beforeEach(loadContext);

  // 【技术债务重构】此测试组应迁移至 task-sync-operations.service.spec.ts
  // 因为 Sentry 错误上报逻辑现在在子服务中
  describe.skip('Sentry 错误上报守卫测试', () => {
    /**
     * Phase 0 Sentry 守卫测试
     * 验证同步失败时 Sentry.captureException 被正确调用
     * 这是重构前的安全网，确保错误上报逻辑不会被意外删除
     */

    beforeEach(() => {
      // 清除之前的调用记录
      mockCaptureException.mockClear();

      // 配置为在线模式
      mockSupabase.isConfigured = true;
      mockSupabase.client = vi.fn().mockReturnValue(mockClient);
    });

    it('pushTask 失败时应该调用 Sentry.captureException 并包含正确的 tags', async () => {
      const task = createMockTask({ id: 'fail-task' });
      const networkError = new Error('Network error');

      // 模拟 pushTask 过程中发生错误
      mockClient.from = vi.fn().mockImplementation((table: string) => {
        if (table === 'task_tombstones') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
              }),
            }),
          };
        }
        // tasks 表的 upsert 失败
        return {
          upsert: vi.fn().mockRejectedValue(networkError),
        };
      });

      const result = await service.pushTask(task, 'project-1');

      // 验证返回失败
      expect(result).toBe(false);

      // 验证 Sentry 被调用
      expect(mockCaptureException).toHaveBeenCalled();

      // 验证调用参数包含正确的 tags
      const callArgs = mockCaptureException.mock.calls[0];
      expect(callArgs[1]).toMatchObject({
        tags: expect.objectContaining({
          operation: 'pushTask',
        }),
      });
    });

    it('pushTask 失败时应该将任务加入 RetryQueue', async () => {
      const task = createMockTask({ id: 'retry-task' });
      const networkError = new Error('Network error');

      mockClient.from = vi.fn().mockImplementation((table: string) => {
        if (table === 'task_tombstones') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
              }),
            }),
          };
        }
        return {
          upsert: vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({
              single: vi.fn().mockRejectedValue(networkError),
            }),
          }),
        };
      });

      await service.pushTask(task, 'project-1');

      // 验证 pendingCount 增加（任务被加入重试队列）
      expect(service.state().pendingCount).toBeGreaterThan(0);
    });

    it('deleteTask 失败时应该调用 Sentry.captureException', async () => {
      const deleteError = new Error('Delete failed');

      // 正确模拟 deleteTask 的调用链: from('tasks').delete().eq('id', taskId)
      mockClient.from = vi.fn().mockReturnValue({
        delete: vi.fn().mockReturnValue({
          eq: vi.fn().mockRejectedValue(deleteError),
        }),
      });

      await service.deleteTask('task-to-delete', 'project-1');

      expect(mockCaptureException).toHaveBeenCalled();
      const callArgs = mockCaptureException.mock.calls[0];
      expect(callArgs[1]).toMatchObject({
        tags: expect.objectContaining({
          operation: 'deleteTask',
        }),
      });
    });

    it('Sentry 上报应该区分可重试和不可重试错误', async () => {
      const task = createMockTask({ id: 'level-test-task' });

      // 模拟一个可重试的网络错误
      const retryableError = new Error('fetch failed');
      Object.assign(retryableError, { code: 'NETWORK_ERROR' });

      mockClient.from = vi.fn().mockImplementation((table: string) => {
        if (table === 'task_tombstones') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
              }),
            }),
          };
        }
        return {
          upsert: vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({
              single: vi.fn().mockRejectedValue(retryableError),
            }),
          }),
        };
      });

      await service.pushTask(task, 'project-1');

      expect(mockCaptureException).toHaveBeenCalled();
      // 验证包含 operation 标签
      const callArgs = mockCaptureException.mock.calls[0];
      expect((callArgs[1] as { tags?: Record<string, string> })?.tags).toHaveProperty('operation', 'pushTask');
    });

    it('deleteTask 遇到不可重试错误时不应加入重试队列', async () => {
      // 模拟一个不可重试的验证错误（类似数据库约束）
      const validationError = {
        code: '23503', // Postgres 外键约束错误
        message: 'Foreign key constraint violation',
      };

      mockClient.from = vi.fn().mockReturnValue({
        delete: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({
            data: null,
            error: validationError,
          }),
        }),
      });

      const initialPendingCount = service.state().pendingCount;
      await service.deleteTask('task-to-delete', 'project-1');

      // 验证不加入重试队列
      expect(service.state().pendingCount).toBe(initialPendingCount);

      // 验证 Sentry 仍然被调用
      expect(mockCaptureException).toHaveBeenCalled();
      const callArgs = mockCaptureException.mock.calls[0];
      expect((callArgs[1] as { tags?: { operation?: string } })?.tags?.operation).toBe('deleteTask');
    });

    it('deleteTask 遇到可重试错误时应加入重试队列', async () => {
      // 模拟一个可重试的网络错误
      const networkError = {
        code: '504', // Gateway timeout
        message: 'Network timeout',
      };

      mockClient.from = vi.fn().mockReturnValue({
        delete: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({
            data: null,
            error: networkError,
          }),
        }),
      });

      const initialPendingCount = service.state().pendingCount;
      await service.deleteTask('task-to-delete', 'project-1');

      // 验证加入重试队列
      expect(service.state().pendingCount).toBe(initialPendingCount + 1);

      // 验证 Sentry 被调用
      expect(mockCaptureException).toHaveBeenCalled();
      const callArgs = mockCaptureException.mock.calls[0];
      expect((callArgs[1] as { tags?: { operation?: string } })?.tags?.operation).toBe('deleteTask');
    });
  });

  // 【技术债务重构】此测试组应迁移至独立的 retry-queue.service.spec.ts
  // 因为重试队列依赖逻辑在重构后需要单独测试
  describe.skip('RetryQueue Dependency Logic', () => {
    beforeEach(() => {
      mockSupabase.isConfigured = true;
      mockSupabase.client = vi.fn().mockReturnValue(mockClient);
    });

    it('should skip connection if source task fails to sync in the same batch', async () => {
      const task1 = createMockTask({ id: 'task-1' }); // Will fail
      const task2 = createMockTask({ id: 'task-2' }); // Will succeed
      const conn = createMockConnection({ id: 'conn-1', source: 'task-1', target: 'task-2' });

      // Mock task-1 failure
      mockClient.from = vi.fn().mockImplementation((table: string) => {
        if (table === 'task_tombstones') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
              }),
            }),
          };
        }
        if (table === 'tasks') {
          return {
            upsert: vi.fn().mockImplementation((data) => {
              if (data.id === 'task-1') {
                return Promise.resolve({ error: new Error('Sync failed') });
              }
              return Promise.resolve({ error: null });
            }),
          };
        }
        return {
          upsert: vi.fn().mockResolvedValue({ error: null }),
          delete: vi.fn().mockResolvedValue({ error: null }),
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              gt: vi.fn().mockResolvedValue({ data: [], error: null }),
            }),
          }),
        };
      });

      // Add to retry queue manually
      service.addToRetryQueue('task', 'upsert', task1, 'project-1');
      service.addToRetryQueue('task', 'upsert', task2, 'project-1');
      service.addToRetryQueue('connection', 'upsert', conn, 'project-1');

      // Trigger processing
      await mockRetryQueueService.processQueue();

      // Verify task-1 failed, task-2 succeeded
      // Verify connection was NOT attempted (because source task-1 failed)
      const calls = mockClient.from.mock.calls;
      const connectionCalls = calls.filter((call: unknown[]) => call[0] === 'connections');
      expect(connectionCalls.length).toBe(0);

      // Verify connection remains in queue
      expect(mockRetryQueueService.queue.length).toBeGreaterThan(0);
      const queuedConn = mockRetryQueueService.queue.find((item: RetryQueueItem) => item.type === 'connection');
      expect(queuedConn).toBeDefined();
      expect(queuedConn!.data.id).toBe('conn-1');
    });

    it('should sync connection if both tasks succeed', async () => {
      const task1 = createMockTask({ id: 'task-1' });
      const task2 = createMockTask({ id: 'task-2' });
      const conn = createMockConnection({ id: 'conn-1', source: 'task-1', target: 'task-2' });

      // 使用更通用的 mock，所有 select 查询都返回任务存在
      mockClient.from = vi.fn().mockImplementation((table: string) => {
        if (table === 'task_tombstones') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
              }),
            }),
          };
        }
        if (table === 'connection_tombstones') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
              }),
            }),
          };
        }
        if (table === 'tasks') {
          return {
            upsert: vi.fn().mockReturnValue({
              select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: { updated_at: new Date().toISOString() },
                  error: null,
                }),
              }),
            }),
            select: vi.fn().mockReturnValue({
              in: vi.fn().mockReturnValue({
                eq: vi.fn().mockResolvedValue({
                  data: [{ id: 'task-1' }, { id: 'task-2' }],
                  error: null,
                }),
                // 也处理没有 eq 的情况（批量查询）
                then: (resolve: Function) => resolve({
                  data: [{ id: 'task-1' }, { id: 'task-2' }],
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === 'connections') {
          return {
            upsert: vi.fn().mockResolvedValue({ error: null }),
          };
        }
        return {
          upsert: vi.fn().mockResolvedValue({ error: null }),
          select: vi.fn().mockReturnValue({
            in: vi.fn().mockResolvedValue({ data: [], error: null }),
          }),
        };
      });

      service.addToRetryQueue('task', 'upsert', task1, 'project-1');
      service.addToRetryQueue('task', 'upsert', task2, 'project-1');
      service.addToRetryQueue('connection', 'upsert', conn, 'project-1');

      await mockRetryQueueService.processQueue();

      const calls = mockClient.from.mock.calls;
      const connectionCalls = calls.filter((call: unknown[]) => call[0] === 'connections');
      expect(connectionCalls.length).toBe(1);
      expect(mockRetryQueueService.queue.length).toBe(0);
    });
  });

  // ==================== 熔断层测试 ====================

  // 【技术债务重构】此测试组应迁移至 task-sync-operations.service.spec.ts
  // 因为 softDeleteTasksBatch 逻辑现在在 TaskSyncOperationsService 中
  describe.skip('softDeleteTasksBatch（服务端批量删除防护）', () => {
    it('离线模式时应返回任务数量并跳过服务端调用', async () => {
      // 离线模式：mockSupabase.isConfigured = false 是默认值

      const result = await service.softDeleteTasksBatch('project-1', ['task-1', 'task-2']);

      // 离线模式返回任务数量（将由本地处理）
      expect(result).toBe(2);
    });

    it('应成功调用 safe_delete_tasks RPC', async () => {
      // 启用在线模式
      mockSupabase.isConfigured = true;
      mockClient.rpc = vi.fn().mockResolvedValue({ data: 2, error: null });
      mockSupabase.client = vi.fn().mockReturnValue(mockClient);

      const result = await service.softDeleteTasksBatch('project-1', ['task-1', 'task-2']);

      expect(result).toBe(2);
      expect(mockClient.rpc).toHaveBeenCalledWith('safe_delete_tasks', {
        p_task_ids: ['task-1', 'task-2'],
        p_project_id: 'project-1',
      });
    });

    it('空任务列表应返回 0', async () => {
      const result = await service.softDeleteTasksBatch('project-1', []);

      expect(result).toBe(0);
    });

    it('服务端熔断阻止时应返回 -1', async () => {
      mockSupabase.isConfigured = true;
      mockClient.rpc = vi.fn().mockResolvedValue({
        data: null,
        error: { message: 'Bulk delete blocked: attempting to delete 60 tasks (60% of total 100)' },
      });
      mockSupabase.client = vi.fn().mockReturnValue(mockClient);

      const result = await service.softDeleteTasksBatch('project-1', ['task-1', 'task-2']);

      expect(result).toBe(-1);
    });

    it('RPC 失败时应降级为逐个软删除', async () => {
      mockSupabase.isConfigured = true;

      // 模拟 RPC 失败但非熔断
      mockClient.rpc = vi.fn().mockResolvedValue({
        data: null,
        error: { message: 'Function does not exist', code: '42883' },
      });

      // 模拟降级更新成功
      mockClient.from = vi.fn().mockReturnValue({
        update: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            in: vi.fn().mockResolvedValue({ error: null }),
          }),
        }),
      });
      mockSupabase.client = vi.fn().mockReturnValue(mockClient);

      const result = await service.softDeleteTasksBatch('project-1', ['task-1', 'task-2']);

      expect(result).toBe(2);
      expect(mockClient.from).toHaveBeenCalledWith('tasks');
    });
  });
}
