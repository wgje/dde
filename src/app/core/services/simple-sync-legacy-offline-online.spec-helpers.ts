import {
  describe,
  expect,
  it,
  vi,
  createMockConnection,
  createMockProject,
  createMockTask,
} from './simple-sync.service.spec-context';
import { registerSimpleSyncLegacyRetryQueueSpecs } from './simple-sync-legacy-retry-queue.spec-helpers';
import type { Project } from './simple-sync.service.spec-context';

export interface SimpleSyncLegacyOfflineOnlineSpecContext {
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
  mockCaptureMessage(): any;
  mockCaptureException(): any;
  mockThrottle(): any;
}

export function registerSimpleSyncLegacyOfflineOnlineSpecs(context: SimpleSyncLegacyOfflineOnlineSpecContext): void {
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
    mockCaptureMessage = context.mockCaptureMessage();
    mockCaptureException = context.mockCaptureException();
    mockThrottle = context.mockThrottle();
  }

  beforeEach(loadContext);

    // 【技术债务重构】此测试组应迁移至 task-sync-operations.service.spec.ts
    // 因为 pushTask/pullTasks 逻辑现在在 TaskSyncOperationsService 中
    describe.skip('离线模式', () => {
      it('pushTask 应该添加到重试队列（离线时）', async () => {
        const task = createMockTask();

        const result = await service.pushTask(task, 'project-1');

        expect(result).toBe(false);
        expect(service.state().pendingCount).toBe(1);
      });

      it('pullTasks 应该返回空数组（离线时）', async () => {
        const tasks = await service.pullTasks('project-1');
        expect(tasks).toEqual([]);
      });

      it('pushProject 应该添加到重试队列（离线时）', async () => {
        const project = createMockProject();

        const result = await service.pushProject(project);

        expect(result).toBe(false);
        expect(service.state().pendingCount).toBe(1);
      });

      it('pushConnection 应该添加到重试队列（离线时）', async () => {
        const connection = createMockConnection();

        const result = await service.pushConnection(connection, 'project-1');

        expect(result).toBe(false);
        expect(service.state().pendingCount).toBe(1);
      });

      it('多个操作应该累积到重试队列', async () => {
        const task1 = createMockTask({ id: 'task-1' });
        const task2 = createMockTask({ id: 'task-2' });
        const project = createMockProject();

        await service.pushTask(task1, 'project-1');
        await service.pushTask(task2, 'project-1');
        await service.pushProject(project);

        expect(service.state().pendingCount).toBe(3);
      });
    });

    // 【技术债务重构】此测试组应迁移至 task-sync-operations.service.spec.ts 和 connection-sync-operations.service.spec.ts
    // 因为 pushTask/pullTasks/pushConnection 逻辑现在在子服务中
    describe.skip('在线模式', () => {
      beforeEach(() => {
        // 模拟在线状态
        mockSupabase.isConfigured = true;
        mockSupabase.client = vi.fn().mockReturnValue(mockClient);

        // 确保 auth.getSession 在在线模式下也有正确的返回值
        mockClient.auth.getSession = vi.fn().mockResolvedValue({
          data: { session: { user: { id: 'test-user-id' } } }
        });
      });

      it('pushTask 应该成功推送', async () => {
        const task = createMockTask();

        // Mock upsert 返回 select().single() 链
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
        expect(service.state().lastSyncTime).not.toBeNull();
        expect(mockClient.from).toHaveBeenCalledWith('tasks');
      });

      it('pushTask 失败时应该加入重试队列', async () => {
        const task = createMockTask();
        // 保留 auth mock，只修改 from 的返回值
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
          // 其他表的默认行为
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({ data: [], error: null })
            })
          };
        });

        const result = await service.pushTask(task, 'project-1');

        expect(result).toBe(false);
        expect(service.state().pendingCount).toBe(1);
      });

      it('pullTasks 应该返回任务列表', async () => {
        const tasks = await service.pullTasks('project-1', '2025-01-01');
        expect(tasks).toEqual([]);
        expect(mockClient.from).toHaveBeenCalledWith('tasks');
      });

      it('pushProject 应该成功推送', async () => {
        const project = createMockProject();

        const result = await service.pushProject(project);

        expect(result).toBe(true);
        expect(mockClient.from).toHaveBeenCalledWith('projects');
      });

      it('pushProject 不应上传客户端 updated_at（由服务端时间统一生成）', async () => {
        const project = createMockProject({
          updatedAt: '2000-01-01T00:00:00.000Z'
        });

        const projectsQueryMock = {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                maybeSingle: vi.fn(async () => ({ data: null, error: null })),
              })),
            })),
          })),
          upsert: vi.fn().mockResolvedValue({ error: null })
        };

        mockClient.from = vi.fn().mockImplementation((table: string) => {
          if (table === 'projects') return projectsQueryMock;
          return {
            upsert: vi.fn().mockResolvedValue({ error: null }),
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                gt: vi.fn().mockResolvedValue({ data: [], error: null })
              })
            }),
            delete: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({ error: null })
            })
          };
        });

        const result = await service.pushProject(project);
        expect(result).toBe(true);

        const payload = projectsQueryMock.upsert.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(payload).toBeTruthy();
        expect(payload['updated_at']).toBeUndefined();
        expect(payload['id']).toBe(project.id);
        expect(payload['owner_id']).toBe('test-user-id');
      });

      it('pushProject 从重试队列回放时若会话 owner 已切换，不应写入云端', async () => {
        const project = createMockProject({ id: 'project-owner-mismatch' });

        const projectsQueryMock = {
          upsert: vi.fn().mockResolvedValue({ error: null })
        };

        mockClient.auth.getSession = vi.fn().mockResolvedValue({
          data: { session: { user: { id: 'new-owner' } } }
        });
        mockClient.from = vi.fn().mockImplementation((table: string) => {
          if (table === 'projects') return projectsQueryMock;
          return {
            upsert: vi.fn().mockResolvedValue({ error: null }),
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                gt: vi.fn().mockResolvedValue({ data: [], error: null })
              })
            }),
            delete: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({ error: null })
            })
          };
        });

        const result = await service.pushProject(project, true, 'old-owner');

        expect(result).toBe(false);
        expect(projectsQueryMock.upsert).not.toHaveBeenCalled();
      });

      it('pushProjectWithResult 在 non-RPC 权限拒绝时应标记为 terminal 结果', async () => {
        const project = createMockProject({ id: 'project-non-rpc-terminal' });
        mockSyncRpcClient.isFeatureEnabled.mockReturnValue(false);
        mockSessionManager.isSessionExpiredError.mockReturnValue(false);

        mockClient.from = vi.fn().mockImplementation((table: string) => {
          if (table === 'projects') {
            return {
              select: vi.fn(() => ({
                eq: vi.fn(() => ({
                  eq: vi.fn(() => ({
                    maybeSingle: vi.fn(async () => ({ data: null, error: null })),
                  })),
                })),
              })),
              upsert: vi.fn().mockReturnValue({
                select: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({
                    data: null,
                    error: { code: '42501', message: 'row-level security policy violation' },
                  }),
                }),
              }),
            };
          }

          return {
            upsert: vi.fn().mockResolvedValue({ error: null }),
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                gt: vi.fn().mockResolvedValue({ data: [], error: null }),
              }),
            }),
            delete: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({ error: null }),
            }),
          };
        });

        const result = await (service as unknown as {
          pushProjectWithResult: (project: Project, fromRetryQueue?: boolean, sourceUserId?: string, taskIdsToDelete?: string[]) => Promise<{ success: boolean; conflict?: boolean; remoteData?: Project; retryEnqueued?: boolean; failureReason?: string; terminal?: boolean }>;
        }).pushProjectWithResult(project, false, 'test-user-id');

        expect(result).toEqual({
          success: false,
          retryEnqueued: false,
          failureReason: '项目同步权限校验失败，请重新登录后重试',
          terminal: true,
        });
        expect(mockRetryQueueService.addDurably).not.toHaveBeenCalled();
      });

      it('pushConnection 应该成功推送', async () => {
        const connection = createMockConnection();

        // Mock auth.getSession
        mockClient.auth.getSession = vi.fn().mockResolvedValue({
          data: { session: { user: { id: 'test-user-id' } } }
        });

        // Mock connection_tombstones 检查
        const tombstonesQueryMock = {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null })
            })
          })
        };

        // Mock 任务存在性查询（.select().in().eq() 链式调用）
        const tasksQueryMock = {
          select: vi.fn().mockReturnThis(),
          in: vi.fn().mockReturnThis(),
          eq: vi.fn().mockResolvedValue({
            data: [
              { id: connection.source },
              { id: connection.target }
            ],
            error: null
          })
        };

        // Mock connections upsert
        const connectionsQueryMock = {
          upsert: vi.fn().mockResolvedValue({ error: null })
        };

        mockClient.from = vi.fn().mockImplementation((table: string) => {
          if (table === 'connection_tombstones') return tombstonesQueryMock;
          if (table === 'tasks') return tasksQueryMock;
          if (table === 'connections') return connectionsQueryMock;
          return {};
        });
        const result = await service.pushConnection(connection, 'project-1');

        expect(result).toBe(true);
        expect(mockClient.from).toHaveBeenCalledWith('tasks');
        expect(mockClient.from).toHaveBeenCalledWith('connections');
      });

      it('pushConnection 应该在任务不存在时跳过推送', async () => {
        const connection = createMockConnection();

        // Mock auth.getSession
        mockClient.auth.getSession = vi.fn().mockResolvedValue({
          data: { session: { user: { id: 'test-user-id' } } }
        });

        // Mock connection_tombstones 检查
        const tombstonesQueryMock = {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null })
            })
          })
        };

        // Mock 任务查询返回空（任务不存在）- .select().in().eq() 链式调用
        const tasksQueryMock = {
          select: vi.fn().mockReturnThis(),
          in: vi.fn().mockReturnThis(),
          eq: vi.fn().mockResolvedValue({
            data: [], // 任务不存在
            error: null
          })
        };

        mockClient.from = vi.fn().mockImplementation((table: string) => {
          if (table === 'connection_tombstones') return tombstonesQueryMock;
          if (table === 'tasks') return tasksQueryMock;
          return {};
        });

        const result = await service.pushConnection(connection, 'project-1');

        expect(result).toBe(false);
        expect(mockClient.from).toHaveBeenCalledWith('tasks');
        expect(mockClient.from).not.toHaveBeenCalledWith('connections');
      });

      it('pushConnection 应该在外键约束错误时不加入重试队列', async () => {
        const connection = createMockConnection();

        // Mock 任务查询通过（假装任务存在）
        const tasksQueryMock = {
          select: vi.fn().mockReturnValue({
            in: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({
                data: [
                  { id: connection.source },
                  { id: connection.target }
                ],
                error: null
              })
            })
          })
        };

        // Mock connections upsert 返回外键错误
        const connectionsQueryMock = {
          upsert: vi.fn().mockResolvedValue({
            error: {
              code: '23503',
              message: 'insert or update on table "connections" violates foreign key constraint "connections_source_id_fkey"'
            }
          })
        };

        mockClient.from = vi.fn().mockImplementation((table: string) => {
          if (table === 'tasks') return tasksQueryMock;
          if (table === 'connections') return connectionsQueryMock;
          return {};
        });

        const initialQueueSize = mockRetryQueueService.queue.length;
        const result = await service.pushConnection(connection, 'project-1');

        expect(result).toBe(false);
        // 外键错误不应该加入重试队列
        expect(mockRetryQueueService.queue.length).toBe(initialQueueSize);
      });

      it('pushConnection 应该在任务查询超时时跳过推送', async () => {
        // 使用 fake timers 加速超时测试
        vi.useFakeTimers();

        const connection = createMockConnection();

        // Mock auth.getSession
        mockClient.auth.getSession = vi.fn().mockResolvedValue({
          data: { session: { user: { id: 'test-user-id' } } }
        });

        // Mock connection_tombstones 检查
        const tombstonesQueryMock = {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null })
            })
          })
        };

        // Mock 任务查询超时（Promise 永不 resolve，让超时生效）- .select().in().eq() 链式调用
        const tasksQueryMock = {
          select: vi.fn().mockReturnThis(),
          in: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnValue(
            new Promise(() => {}) // 永不 resolve，等待超时
          )
        };

        mockClient.from = vi.fn().mockImplementation((table: string) => {
          if (table === 'connection_tombstones') return tombstonesQueryMock;
          if (table === 'tasks') return tasksQueryMock;
          return {};
        });

        // 启动 pushConnection（不 await，让超时先触发）
        const resultPromise = service.pushConnection(connection, 'project-1');

        // 快进 10001ms 触发超时（STANDARD 超时为 10 秒）
        await vi.advanceTimersByTimeAsync(10001);

        const result = await resultPromise;

        // 超时应该导致推送失败（因为无法验证任务存在）
        expect(result).toBe(false);
        expect(mockClient.from).toHaveBeenCalledWith('tasks');
        expect(mockClient.from).not.toHaveBeenCalledWith('connections');

        vi.useRealTimers();
      });
    });

    // 【技术债务重构】此测试组应迁移至 task-sync-operations.service.spec.ts
    // 因为 LWW 策略在 pushTask/pullTasks 实现中，现在在子服务中
    describe.skip('LWW (Last-Write-Wins) 冲突策略', () => {
      beforeEach(() => {
        mockSupabase.isConfigured = true;
        mockSupabase.client = vi.fn().mockReturnValue(mockClient);
      });

      it('推送任务时应该使用 upsert 实现 LWW', async () => {
        const task = createMockTask({ updatedAt: '2025-12-21T10:00:00Z' });

        await service.pushTask(task, 'project-1');

        // 验证调用了 tasks 表进行 upsert
        expect(mockClient.from).toHaveBeenCalledWith('tasks');
        // 【性能优化 v2026-01】不再检查 tombstones，由调用方批量过滤
        expect(mockClient.from.mock.calls.length).toBeGreaterThanOrEqual(1);
      });

      it('拉取任务时应该支持增量同步（since 参数）', async () => {
        const since = '2025-12-20T00:00:00Z';

        await service.pullTasks('project-1', since);

        // 验证查询使用了 since 时间戳
        expect(mockClient.from).toHaveBeenCalledWith('tasks');
      });

      it('本地新/远程旧场景：本地数据应该通过 upsert 覆盖远程', async () => {
        const localTask = createMockTask({
          id: 'task-conflict',
          title: 'Local Version',
          updatedAt: '2025-12-21T12:00:00Z' // 更新的时间戳
        });

        // Mock upsert 成功
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

        const result = await service.pushTask(localTask, 'project-1');

        expect(result).toBe(true);
        // LWW：本地更新的数据会覆盖远程旧数据
      });
    });

    registerSimpleSyncLegacyRetryQueueSpecs(context);
}
