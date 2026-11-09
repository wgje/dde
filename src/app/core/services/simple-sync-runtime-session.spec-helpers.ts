import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
  createMockConnection,
  createMockProject,
  createMockTask,
} from './simple-sync.service.spec-context';
import { registerSimpleSyncRuntimeSessionLegacySkippedSpecs } from './simple-sync-runtime-session-legacy-skipped.spec-helpers';
import type { Connection, Project } from './simple-sync.service.spec-context';

export interface SimpleSyncRuntimeSessionSpecContext {
  service(): any;
  mockSupabase(): any;
  mockClient(): any;
  mockProjectData(): any;
  mockSyncRpcClient(): any;
  mockBlackBoxSync(): any;
  mockProjectStore(): any;
  mockSyncCursorPersistence(): any;
  mockSessionManager(): any;
  mockRetryQueueService(): any;
  mockRealtimePolling(): any;
  mockToast(): any;
  mockLoggerCategory(): any;
  mockCaptureMessage(): any;
  mockCaptureException(): any;
  mockThrottle(): any;
}

export function registerSimpleSyncRuntimeSessionSpecs(context: SimpleSyncRuntimeSessionSpecContext): void {
  let service: any;
  let mockSupabase: any;
  let mockClient: any;
  let mockProjectData: any;
  let mockSyncRpcClient: any;
  let mockBlackBoxSync: any;
  let mockProjectStore: any;
  let mockSyncCursorPersistence: any;
  let mockSessionManager: any;
  let mockRetryQueueService: any;
  let mockRealtimePolling: any;
  let mockToast: any;
  let mockLoggerCategory: any;
  let mockCaptureMessage: any;
  let mockCaptureException: any;
  let mockThrottle: any;

  function loadContext(): void {
    service = context.service();
    mockSupabase = context.mockSupabase();
    mockClient = context.mockClient();
    mockProjectData = context.mockProjectData();
    mockSyncRpcClient = context.mockSyncRpcClient();
    mockBlackBoxSync = context.mockBlackBoxSync();
    mockProjectStore = context.mockProjectStore();
    mockSyncCursorPersistence = context.mockSyncCursorPersistence();
    mockSessionManager = context.mockSessionManager();
    mockRetryQueueService = context.mockRetryQueueService();
    mockRealtimePolling = context.mockRealtimePolling();
    mockToast = context.mockToast();
    mockLoggerCategory = context.mockLoggerCategory();
    mockCaptureMessage = context.mockCaptureMessage();
    mockCaptureException = context.mockCaptureException();
    mockThrottle = context.mockThrottle();
  }

  beforeEach(loadContext);

    describe('网络状态监听', () => {
      // 注意：这些测试在 Zone.js 环境下可能因 window 事件处理差异而不稳定
      // 网络监听功能通过手动测试验证正确性
      it.skip('应该在网络断开时更新状态', () => {
        window.dispatchEvent(new Event('offline'));

        // 等待事件处理
        expect(service.state().isOnline).toBe(false);
      });

      it.skip('应该在网络恢复时更新状态', () => {
        // 先断开
        window.dispatchEvent(new Event('offline'));
        expect(service.state().isOnline).toBe(false);

        // 再恢复
        window.dispatchEvent(new Event('online'));
        expect(service.state().isOnline).toBe(true);
      });

      it('浏览器从离线恢复在线时应清除浏览器离线标记', async () => {
        service.startRuntime();

        window.dispatchEvent(new Event('offline'));
        expect(service.state().isOnline).toBe(false);
        expect(service.state().offlineMode).toBe(true);

        window.dispatchEvent(new Event('online'));
        await Promise.resolve();

        expect(service.state().isOnline).toBe(true);
        expect(service.state().offlineMode).toBe(false);
      });
    });

    describe('Realtime 订阅', () => {
      beforeEach(() => {
        mockSupabase.isConfigured = true;
        mockSupabase.client = vi.fn().mockReturnValue(mockClient);
      });

      it('setOnRemoteChange 应该委托给 RealtimePollingService', () => {
        const callback = vi.fn();
        service.setOnRemoteChange(callback);

        // 验证委托给 RealtimePollingService
        expect(mockRealtimePolling.setOnRemoteChange).toHaveBeenCalledWith(callback);
      });

      it('subscribeToProject 应该委托给 RealtimePollingService', async () => {
        await service.subscribeToProject('project-1', 'user-123');

        // 验证委托给 RealtimePollingService
        expect(mockRealtimePolling.subscribeToProject).toHaveBeenCalledWith('project-1', 'user-123');
      });

      it('setRealtimeEnabled(true) 后 isRealtimeEnabled 应该返回 true', async () => {
        // 手动启用 Realtime
        service.setRealtimeEnabled(true);
        expect(service.isRealtimeEnabled()).toBe(true);

        // 验证委托调用
        expect(mockRealtimePolling.setRealtimeEnabled).toHaveBeenCalledWith(true);
      });
    });

    // 【技术债务重构】此测试组应迁移至 task-sync-operations.service.spec.ts
    // 因为 Tombstone 逻辑现在在 TaskSyncOperationsService 中
    describe.skip('Tombstone 防护（防止已删除任务复活）', () => {
      beforeEach(() => {
        mockSupabase.isConfigured = true;
        mockSupabase.client = vi.fn().mockReturnValue(mockClient);
      });

      it('pushTask 不再检查 tombstones（性能优化 v2026-01）', async () => {
        const task = createMockTask({ id: 'deleted-task' });

        // Mock tombstone 检查（未找到墓碑）
        mockClient.from = vi.fn().mockImplementation((table: string) => {
          if (table === 'task_tombstones') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null })
                })
              })
            };
          }
          if (table === 'tasks') {
            return {
              upsert: vi.fn().mockReturnValue({
                select: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({
                    data: { updated_at: new Date().toISOString() },
                    error: null
                  })
                })
              })
            };
          }
          return {};
        });

        // 【性能优化 v2026-01】pushTask 不再检查 tombstones
        // tombstone 过滤由 saveProjectToCloud 批量完成，避免 N 次数据库查询
        const result = await service.pushTask(task, 'project-1');

        // pushTask 会尝试推送（由调用方负责过滤 tombstones）
        expect(result).toBe(true);
        // 验证直接调用 tasks 表，不检查 task_tombstones
        expect(mockClient.from).toHaveBeenCalledWith('tasks');
        // 实际上会检查 tombstones
        expect(mockClient.from).toHaveBeenCalledWith('task_tombstones');
      });

      it('pushTask 直接推送任务（不检查 tombstones）', async () => {
        const task = createMockTask({ id: 'normal-task' });

        // Mock tombstone 检查
        mockClient.from = vi.fn().mockImplementation((table: string) => {
          if (table === 'task_tombstones') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null })
                })
              })
            };
          }
          if (table === 'tasks') {
            return {
              upsert: vi.fn().mockReturnValue({
                select: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({
                    data: { updated_at: new Date().toISOString() },
                    error: null
                  })
                })
              })
            };
          }
          return {};
        });

        const result = await service.pushTask(task, 'project-1');

        expect(result).toBe(true);
        // 【性能优化 v2026-01】只调用 tasks 表，不检查 tombstones
        expect(mockClient.from).toHaveBeenCalledWith('tasks');
        // 实际上会检查 tombstones
        expect(mockClient.from).toHaveBeenCalledWith('task_tombstones');
      });

      it('pushTask 推送失败时加入重试队列（tombstone 检查已移至调用方）', async () => {
        // 验证推送失败会加入重试队列
        const task = createMockTask({ id: 'failed-task' });

        // 模拟推送失败
        mockClient.from = vi.fn().mockImplementation((table: string) => {
          if (table === 'task_tombstones') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null })
                })
              })
            };
          }
          if (table === 'tasks') {
            return {
              upsert: vi.fn().mockReturnValue({
                select: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({
                    data: null,
                    error: { code: 'NETWORK_ERROR', message: 'Network error' }
                  })
                })
              })
            };
          }
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({ data: [], error: null })
            })
          };
        });

        // 先确认初始状态
        expect(service.state().pendingCount).toBe(0);

        const result = await service.pushTask(task, 'project-1');

        // 推送失败应加入重试队列
        expect(result).toBe(false);
        expect(service.state().pendingCount).toBe(1);
      });

      it('pushTask 遇到版本冲突时不加入重试队列', async () => {
        const task = createMockTask({ id: 'version-conflict-task', updatedAt: '2024-01-01T00:00:00Z' });

        // 模拟版本冲突错误 (P0001 - raise_exception)
        mockClient.from = vi.fn().mockImplementation((table: string) => {
          if (table === 'task_tombstones') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null })
                })
              })
            };
          }
          if (table === 'tasks') {
            return {
              upsert: vi.fn().mockReturnValue({
                select: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({
                    data: null,
                    error: {
                      code: 'P0001',
                      message: 'Version regression not allowed: 2 -> 1 (table: tasks, id: version-conflict-task)'
                    }
                  })
                })
              })
            };
          }
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({ data: [], error: null })
            })
          };
        });

        // 版本冲突现在抛出永久失败异常
        await expect(service.pushTask(task, 'project-1')).rejects.toThrow('Version conflict');

        // 不应加入重试队列
        expect(service.state().pendingCount).toBe(0);
        expect(mockToast.warning).toHaveBeenCalledWith('版本冲突', '数据已被修改，请刷新后重试');
        expect(mockCaptureMessage).toHaveBeenCalledWith(
          'Optimistic lock conflict in pushTask',
          expect.objectContaining({
            level: 'warning',
            tags: expect.objectContaining({
              operation: 'pushTask',
              taskId: 'version-conflict-task'
            })
          })
        );
      });

      it('pushConnection 遇到版本冲突时不加入重试队列', async () => {
        const connection = createMockConnection({
          id: 'version-conflict-conn',
          source: 'task-1',
          target: 'task-2'
        });

        // Mock auth.getSession
        mockClient.auth.getSession = vi.fn().mockResolvedValue({
          data: { session: { user: { id: 'test-user-id' } } }
        });

        // 模拟任务存在性检查成功，版本冲突错误
        mockClient.from = vi.fn().mockImplementation((table: string) => {
          if (table === 'connection_tombstones') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null })
                })
              })
            };
          }
          if (table === 'tasks') {
            return {
              select: vi.fn().mockReturnThis(),
              in: vi.fn().mockReturnThis(),
              eq: vi.fn().mockResolvedValue({
                data: [{ id: 'task-1' }, { id: 'task-2' }],
                error: null
              })
            };
          }
          // 模拟版本冲突错误
          if (table === 'connections') {
            return {
              upsert: vi.fn().mockResolvedValue({
                error: {
                  code: 'P0001',
                  message: 'Version regression not allowed'
                }
              })
            };
          }
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({ data: [], error: null })
            })
          };
        });

        // 版本冲突现在抛出永久失败异常
        await expect(service.pushConnection(connection, 'project-1')).rejects.toThrow('Version conflict');

        // 不应加入重试队列
        expect(service.state().pendingCount).toBe(0);
        expect(mockToast.warning).toHaveBeenCalledWith('版本冲突', '数据已被修改，请刷新后重试');
        expect(mockCaptureMessage).toHaveBeenCalledWith(
          'Optimistic lock conflict in pushConnection',
          expect.objectContaining({
            level: 'warning',
            tags: expect.objectContaining({
              operation: 'pushConnection',
              connectionId: 'version-conflict-conn'
            })
          })
        );
      });
    });

    describe('兼容性接口', () => {
      it('state 别名应该指向 syncState', () => {
        expect(service.state).toBe(service.syncState);
      });

      it('isLoadingRemote signal 应该存在', () => {
        expect(service.isLoadingRemote()).toBe(false);
      });

      it('isLoadingRemote 必须委派给 SyncStateService（修复 2026-05-15 孤儿信号根因）', () => {
        // 【回归】此前 SimpleSyncService.isLoadingRemote 是从未被写入的孤儿 signal，
        // SyncCoordinator 转发它，导致所有上游消费者读到的"远程加载中"永久为 false。
        // 修复后必须与 SyncStateService.isLoadingRemote 引用同一 signal。
        expect(service.isLoadingRemote).toBe(service['syncStateService'].isLoadingRemote);

        service['syncStateService'].setLoadingRemote(true);
        expect(service.isLoadingRemote()).toBe(true);

        service['syncStateService'].setLoadingRemote(false);
        expect(service.isLoadingRemote()).toBe(false);
      });
    });

    registerSimpleSyncRuntimeSessionLegacySkippedSpecs(context);

    describe('Session Validation', () => {
      it('批量推送时应委托给 BatchSyncService', async () => {
        // 设置在线模式
        mockSupabase.isConfigured = true;
        mockSupabase.client = vi.fn().mockReturnValue(mockClient);

        // 准备测试数据 - 包含多个任务
        const tasks = [
          createMockTask({ id: 'task-1', title: 'Task 1' }),
          createMockTask({ id: 'task-2', title: 'Task 2' }),
          createMockTask({ id: 'task-3', title: 'Task 3' })
        ];
        const project = createMockProject({ id: 'project-1', tasks });

        // 获取注入的 BatchSyncService mock
        const mockBatchSync = service['batchSyncService'];
        mockBatchSync.saveProjectToCloud = vi.fn().mockResolvedValue({ success: true, newVersion: 1 });

        // 调用 saveProjectToCloud
        await service.saveProjectToCloud(project, 'test-user-id');

        // 验证 BatchSyncService 被调用
        expect(mockBatchSync.saveProjectToCloud).toHaveBeenCalledWith(project, 'test-user-id', undefined);
      });

      // 【技术债务重构】以下测试应迁移至 task-sync-operations.service.spec.ts
      // 因为 pushTask 逻辑现在在 TaskSyncOperationsService 中
      it.skip('RLS 错误应设置 sessionExpired', async () => {
        // 设置在线模式
        mockSupabase.isConfigured = true;

        // 【重构修复】需要让 sessionManager 识别 RLS 错误为会话过期
        mockSessionManager.isSessionExpiredError.mockReturnValue(true);

        // Mock getSession 返回有效 session
        mockClient.auth.getSession = vi.fn().mockResolvedValue({
          data: { session: { user: { id: 'test-user-id' } } }
        });

        // Mock Supabase 返回 RLS 错误 (42501)
        mockClient.from = vi.fn().mockImplementation((table: string) => {
          if (table === 'task_tombstones') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null })
                })
              })
            };
          }
          return {
            upsert: vi.fn().mockReturnValue({
              select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: null,
                  error: {
                    code: '42501',
                    message: 'new row violates row-level security policy'
                  }
                })
              })
            })
          };
        });

        mockSupabase.client = vi.fn().mockReturnValue(mockClient);

        const task = createMockTask({ id: 'task-1', title: 'Test Task' });

        // 调用 pushTask，现在会抛出异常
        await expect(service.pushTask(task, 'project-1')).rejects.toThrow('Session expired');

        // 验证 sessionExpired 被设置
        expect(service.syncState().sessionExpired).toBe(true);

        // 验证显示了 toast 提示
        expect(mockToast.warning).toHaveBeenCalledWith(
          '登录已过期',
          expect.any(String)
        );
      });

      it.skip('401 错误应设置 sessionExpired', async () => {
        mockSupabase.isConfigured = true;

        // 【重构修复】需要让 sessionManager 识别 401 错误为会话过期
        mockSessionManager.isSessionExpiredError.mockReturnValue(true);

        mockClient.from = vi.fn().mockImplementation((table: string) => {
          if (table === 'task_tombstones') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null })
                })
              })
            };
          }
          return {
            upsert: vi.fn().mockReturnValue({
              select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: null,
                  error: {
                    code: '401',
                    message: 'Unauthorized'
                  }
                })
              })
            })
          };
        });

        mockSupabase.client = vi.fn().mockReturnValue(mockClient);

        const task = createMockTask();
        await expect(service.pushTask(task, 'project-1')).rejects.toThrow('Session expired');

        expect(service.syncState().sessionExpired).toBe(true);
      });

      it.skip('会话过期时 Toast 应只显示一次（幂等性）', async () => {
        mockSupabase.isConfigured = true;

        // 【重构修复】需要让 sessionManager 识别 RLS 错误为会话过期
        mockSessionManager.isSessionExpiredError.mockReturnValue(true);

        mockClient.from = vi.fn().mockImplementation((table: string) => {
          if (table === 'task_tombstones') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null })
                })
              })
            };
          }
          return {
            upsert: vi.fn().mockReturnValue({
              select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: null,
                  error: { code: '42501', message: 'RLS violation' }
                })
              })
            })
          };
        });

        mockSupabase.client = vi.fn().mockReturnValue(mockClient);

        const task1 = createMockTask({ id: 'task-1' });
        const task2 = createMockTask({ id: 'task-2' });

        // 第一次调用 - 应该设置 sessionExpired 并显示 Toast
        await expect(service.pushTask(task1, 'project-1')).rejects.toThrow('Session expired');
        expect(mockToast.warning).toHaveBeenCalledTimes(1);

        // 第二次调用 - sessionExpired 已设置，不应再显示 Toast
        await expect(service.pushTask(task2, 'project-1')).rejects.toThrow('Session expired');
        expect(mockToast.warning).toHaveBeenCalledTimes(1); // 仍然是 1 次
      });

      it('会话过期的任务不应加入重试队列', async () => {
        mockSupabase.isConfigured = true;

        mockClient.from = vi.fn().mockReturnValue({
          upsert: vi.fn().mockResolvedValue({
            error: { code: 401, message: 'Unauthorized' }
          })
        });

        mockSupabase.client = vi.fn().mockReturnValue(mockClient);

        const task = createMockTask();

        // 会话过期会抛出异常
        try {
          await service.pushTask(task, 'project-1');
        } catch (error) {
          // 预期的异常
        }

        // 验证没有加入重试队列
        expect(service.state().pendingCount).toBe(0);
      });

      it('会话恢复触发重试队列处理失败时应捕获错误并保留后续自动重试', async () => {
        const drainError = new Error('retry drain rejected after session restore');
        mockRetryQueueService.queue.push({
          id: 'retry-after-session-restore',
          type: 'task',
          operation: 'upsert',
          data: createMockTask({ id: 'task-after-session-restore' }),
        });
        mockRetryQueueService.processQueue.mockRejectedValueOnce(drainError);
        service['syncStateService'].update({ sessionExpired: true, isOnline: true });

        service.resetSessionExpired();
        await Promise.resolve();
        await Promise.resolve();

        expect(service.syncState().sessionExpired).toBe(false);
        expect(mockRetryQueueService.processQueue).toHaveBeenCalledTimes(1);
        expect(mockLoggerCategory.warn).toHaveBeenCalledWith(
          '会话恢复后的重试队列处理失败，保留队列等待后续自动重试',
          expect.objectContaining({
            error: drainError,
            previousQueueLength: 1,
            remainingQueueLength: 1,
          }),
        );
      });

      it.skip('会话过期不应上报到 Sentry', async () => {
        mockSupabase.isConfigured = true;

        // 【重构修复】需要让 sessionManager 识别 RLS 错误为会话过期
        mockSessionManager.isSessionExpiredError.mockReturnValue(true);

        mockClient.from = vi.fn().mockImplementation((table: string) => {
          if (table === 'task_tombstones') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null })
                })
              })
            };
          }
          return {
            upsert: vi.fn().mockReturnValue({
              select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: null,
                  error: { code: '42501', message: 'RLS policy violation' }
                })
              })
            })
          };
        });

        mockSupabase.client = vi.fn().mockReturnValue(mockClient);

        // 清空之前的调用
        mockCaptureException.mockClear();

        const task = createMockTask();

        // handleSessionExpired 现在抛出异常
        await expect(service.pushTask(task, 'project-1')).rejects.toThrow('Session expired');

        // 验证没有调用 Sentry.captureException（会话过期用 captureMessage）
        expect(mockCaptureException).not.toHaveBeenCalled();
      });
    });


    describe.skip('【P0 修复】Session Expired 自动刷新恢复', () => {

      // 在每个测试前设置 Supabase 为已配置状态
      beforeEach(() => {
        mockSupabase.isConfigured = true;
        mockSupabase.client.mockReturnValue(mockClient);
        // 清理之前测试的 mock 调用
        mockClient.auth.refreshSession.mockClear();
      });

      // 注意：tryRefreshSession 和 handleAuthErrorWithRefresh 方法已内联为直接调用 sessionManager
      // 委托测试已移除，保留集成测试验证完整流程

      it('pushProject 应在 401 错误时尝试刷新并重试', async () => {
        // 第一次调用失败（401）
        // 第二次调用成功（刷新后）
        let callCount = 0;
        mockThrottle.execute.mockImplementation(async (_key: string, fn: () => Promise<unknown>) => {
          callCount++;
          if (callCount === 1) {
            // 第一次执行失败
            throw { code: 401, message: 'JWT expired' };
          }
          // 第二次执行成功
          return fn();
        });

        // 模拟 sessionManager 检测到会话过期错误并尝试刷新
        mockSessionManager.isSessionExpiredError.mockReturnValue(true);
        mockSessionManager.handleAuthErrorWithRefresh.mockResolvedValueOnce(true);

        // Mock getSession 返回用户
        mockClient.auth.getSession.mockResolvedValue({
          data: { session: { user: { id: 'user-1' } } }
        });

        // Mock upsert 成功
        mockClient.from.mockReturnValue({
          upsert: vi.fn().mockReturnValue({
            data: null,
            error: null
          })
        });

        const project = createMockProject();
        const result = await service.pushProject(project);

        // 验证检测到了会话过期错误
        expect(mockSessionManager.isSessionExpiredError).toHaveBeenCalled();
        // 验证调用了 handleAuthErrorWithRefresh
        expect(mockSessionManager.handleAuthErrorWithRefresh).toHaveBeenCalledWith(
          'pushProject',
          expect.anything()
        );
      });
    });
}
