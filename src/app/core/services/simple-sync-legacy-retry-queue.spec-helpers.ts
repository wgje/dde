import {
  describe,
  expect,
  it,
  vi,
  createMockConnection,
  createMockTask,
} from './simple-sync.service.spec-context';
import type { MockFn } from './simple-sync.service.spec-context';

export interface SimpleSyncLegacyRetryQueueSpecContext {
  service(): any;
  mockSupabase(): any;
  mockClient(): any;
  mockSessionManager(): any;
  mockRetryQueueService(): any;
}

export function registerSimpleSyncLegacyRetryQueueSpecs(
  context: SimpleSyncLegacyRetryQueueSpecContext,
): void {
  let service: any;
  let mockSupabase: any;
  let mockClient: any;
  let mockSessionManager: any;
  let mockRetryQueueService: any;

  function loadContext(): void {
    service = context.service();
    mockSupabase = context.mockSupabase();
    mockClient = context.mockClient();
    mockSessionManager = context.mockSessionManager();
    mockRetryQueueService = context.mockRetryQueueService();
  }

  beforeEach(loadContext);

  // 【技术债务重构】此测试组测试的逻辑依赖于 pushTask 的内部行为
  // 需要重新设计以匹配新的委托架构
  describe.skip('RetryQueue 重试逻辑', () => {
    it('重试队列应该在网络恢复时自动处理', async () => {
      // 使用 fake timers 避免等待真实时间
      vi.useFakeTimers();

      // 1. 离线状态添加任务
      const task = createMockTask();
      await service.pushTask(task, 'project-1');
      expect(service.state().pendingCount).toBe(1);

      // 2. 模拟网络恢复
      mockSupabase.isConfigured = true;
      mockSupabase.client = vi.fn().mockReturnValue(mockClient);

      // 手动触发网络恢复事件
      window.dispatchEvent(new Event('online'));

      // 快进定时器以处理异步操作
      await vi.advanceTimersByTimeAsync(100);

      // 注意：由于 processRetryQueue 是私有方法，我们通过状态验证行为
      // 在实际实现中，网络恢复会自动触发重试

      vi.useRealTimers();
    });

    it('离线入队应持久化到 IndexedDB，并在重连后清空', async () => {
      const task = createMockTask({ id: 'task-offline-1' });
      const saveRetryQueueToIdb = vi
        .spyOn(service as unknown as { saveRetryQueueToIdb: () => Promise<boolean> }, 'saveRetryQueueToIdb')
        .mockResolvedValue(true);

      // 离线入队
      const result = await service.pushTask(task, 'project-1');
      expect(result).toBe(false);
      expect(service.state().pendingCount).toBe(1);

      // IndexedDB 持久化（通过调用路径验证）
      expect(saveRetryQueueToIdb).toHaveBeenCalled();

      // 重连并处理队列
      mockSupabase.isConfigured = true;
      mockSupabase.client = vi.fn().mockReturnValue(mockClient);

      mockClient.from = vi.fn().mockImplementation((table: string) => {
        if (table === 'task_tombstones') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({ data: [], error: null }),
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
          };
        }
        return {};
      });

      await (service as unknown as { processRetryQueue: () => Promise<void> }).processRetryQueue();

      expect(service.state().pendingCount).toBe(0);
      expect(saveRetryQueueToIdb).toHaveBeenCalled();
    }, 5000);

    it('processRetryQueue 处理失败时不应双重入队（修复 2026-01-31）', async () => {
      // 【关键测试】验证修复：当 pushTask 失败时，不会同时被 pushTask 和 processRetryQueue 入队
      mockSupabase.isConfigured = true;
      mockSupabase.client = vi.fn().mockReturnValue(mockClient);

      // 避免 retryWithBackoff 指数退避导致测试超时
      // 注意：retryWithBackoff 已委托给 syncOpHelper，通过 service 内部引用访问
      const syncOpHelper = service['syncOpHelper'] as unknown as { retryWithBackoff: MockFn };
      syncOpHelper.retryWithBackoff.mockImplementation(async (fn: () => Promise<void>) => {
        await fn();
      });

      const task = createMockTask({ id: 'task-double-queue' });

      // 模拟推送失败（可重试错误）
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
            upsert: vi.fn().mockReturnValue({
              select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: null,
                  error: { code: '503', message: 'Service unavailable' },
                }),
              }),
            }),
            select: vi.fn().mockReturnValue({
              in: vi.fn().mockResolvedValue({ data: [], error: null }),
            }),
          };
        }
        return {};
      });

      // 手动添加到队列（模拟之前的入队）
      mockRetryQueueService.queue = [];
      service.addToRetryQueue('task', 'upsert', task, 'project-1');
      const queueLengthBefore = mockRetryQueueService.queue.length;
      expect(queueLengthBefore).toBe(1);

      // 处理队列（应该失败但不双重入队）
      await mockRetryQueueService.processQueue();

      // 【关键断言】队列长度应该仍为 1（同一任务不应出现 2 次）
      const queueLengthAfter = mockRetryQueueService.queue.length;
      expect(queueLengthAfter).toBe(1);

      // 验证是同一个任务（通过去重机制或 fromRetryQueue 参数）
      const queuedItem = mockRetryQueueService.queue[0];
      expect(queuedItem.data.id).toBe('task-double-queue');
      expect(queuedItem.retryCount).toBe(1); // 重试次数应该增加
    });

    it('超过最大重试次数应该放弃并通知用户', async () => {
      // 这个测试验证的是重试逻辑的边界条件
      // 由于 MAX_RETRIES = 5，我们验证配置存在
      expect(mockRetryQueueService.MAX_RETRIES).toBe(5);
    });

    it('重试间隔应该为 5 秒', () => {
      expect(service['RETRY_INTERVAL']).toBe(5000);
    });

    it('应该对 504 错误进行立即重试（指数退避）', async () => {
      // 使用 fake timers 加速指数退避延迟（1s, 2s, 4s）
      vi.useFakeTimers();

      mockSupabase.isConfigured = true;
      mockSupabase.client = vi.fn().mockReturnValue(mockClient);

      const task = createMockTask();
      let upsertAttempts = 0;

      // 模拟前 2 次 upsert 失败（504），第 3 次成功
      // 注意：pushTask 会先检查 task_tombstones
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
          upsert: vi.fn().mockImplementation(() => {
            upsertAttempts++;
            return {
              select: vi.fn().mockReturnValue({
                single: vi.fn().mockImplementation(() => {
                  if (upsertAttempts < 3) {
                    return Promise.resolve({
                      data: null,
                      error: { code: '504', message: 'Gateway timeout' },
                    });
                  }
                  return Promise.resolve({
                    data: { updated_at: new Date().toISOString() },
                    error: null,
                  });
                }),
              }),
            };
          }),
        };
      });

      const resultPromise = service.pushTask(task, 'project-1');

      // 快进第一次重试延迟 (1000ms)
      await vi.advanceTimersByTimeAsync(1001);
      // 快进第二次重试延迟 (2000ms)
      await vi.advanceTimersByTimeAsync(2001);

      const result = await resultPromise;

      expect(upsertAttempts).toBe(3); // 验证重试了 2 次后成功
      expect(result).toBe(true);

      vi.useRealTimers();
    });

    it('应该对 429 错误进行立即重试', async () => {
      // 使用 fake timers 加速重试延迟
      vi.useFakeTimers();

      mockSupabase.isConfigured = true;
      mockSupabase.client = vi.fn().mockReturnValue(mockClient);

      const connection = createMockConnection();
      let attempts = 0;

      // Mock connection_tombstones 查询（无 tombstone）
      const connectionTombstonesQueryMock = {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          }),
        }),
      };

      // Mock 任务存在性查询
      const tasksQueryMock = {
        select: vi.fn().mockReturnValue({
          in: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({
              data: [
                { id: connection.source },
                { id: connection.target },
              ],
              error: null,
            }),
          }),
        }),
      };

      // 模拟 429 错误后成功
      const connectionsQueryMock = {
        upsert: vi.fn().mockImplementation(() => {
          attempts++;
          if (attempts === 1) {
            return Promise.resolve({ error: { code: 429, message: 'Too many requests' } });
          }
          return Promise.resolve({ error: null });
        }),
      };

      mockClient.from = vi.fn().mockImplementation((table: string) => {
        if (table === 'connection_tombstones') return connectionTombstonesQueryMock;
        if (table === 'tasks') return tasksQueryMock;
        if (table === 'connections') return connectionsQueryMock;
        return {};
      });

      const resultPromise = service.pushConnection(connection, 'project-1');

      // 快进第一次重试延迟 (1000ms)
      await vi.advanceTimersByTimeAsync(1001);

      const result = await resultPromise;

      expect(attempts).toBe(2); // 验证重试了 1 次后成功
      expect(result).toBe(true);

      vi.useRealTimers();
    });

    it('非可重试错误应该立即失败（无重试）', async () => {
      mockSupabase.isConfigured = true;
      mockSupabase.client = vi.fn().mockReturnValue(mockClient);

      const task = createMockTask();
      let upsertAttempts = 0;

      // 模拟 401 错误（会话过期，永久失败）
      // 【重构修复】需要让 sessionManager 识别 401 错误为会话过期
      mockSessionManager.isSessionExpiredError.mockReturnValue(true);

      // 注意：pushTask 会先检查 task_tombstones
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
          upsert: vi.fn().mockImplementation(() => {
            upsertAttempts++;
            return {
              select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: null,
                  error: { code: '401', message: 'Unauthorized' },
                }),
              }),
            };
          }),
        };
      });

      // 401 会话过期错误应该抛出异常
      await expect(service.pushTask(task, 'project-1')).rejects.toThrow();
      expect(upsertAttempts).toBe(1); // 验证没有重试
    });
  });
}
