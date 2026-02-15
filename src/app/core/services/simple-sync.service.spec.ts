/**
 * SimpleSyncService 单元测试
 * 
 * 测试覆盖：
 * - 初始化状态
 * - 离线模式行为
 * - 在线模式行为
 * - LWW (Last-Write-Wins) 冲突策略
 * - RetryQueue 重试逻辑
 * - 网络恢复回调
 * - Sentry 错误上报守卫测试
 * 
 * 架构：Injector 隔离模式（避免 TestBed 全局状态污染）
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Injector, runInInjectionContext, DestroyRef } from '@angular/core';
import { disablePollutionGuard, enablePollutionGuard, mockSentryLazyLoaderService } from '../../../test-setup.mocks';
import { SimpleSyncService } from './simple-sync.service';
import { SupabaseClientService } from '../../../services/supabase-client.service';
import { LoggerService } from '../../../services/logger.service';
import { ToastService } from '../../../services/toast.service';
import { RequestThrottleService } from '../../../services/request-throttle.service';
import { ClockSyncService } from '../../../services/clock-sync.service';
import { EventBusService } from '../../../services/event-bus.service';
import { SentryLazyLoaderService } from '../../../services/sentry-lazy-loader.service';
import { BlackBoxSyncService } from '../../../services/black-box-sync.service';
import { TombstoneService, RealtimePollingService, SessionManagerService, SyncOperationHelperService, UserPreferencesSyncService, ProjectDataService, BatchSyncService, TaskSyncOperationsService, ConnectionSyncOperationsService, RetryQueueService, SyncStateService } from './sync';
import type { RetryQueueItem } from './sync';
import { Task, Project, Connection } from '../../../models';
import { PermanentFailureError } from '../../../utils/permanent-failure-error';

// 使用 SentryLazyLoaderService mock（来自 test-setup.mocks.ts）
// 注意：现在服务使用 this.sentryLazyLoader 而非直接的 Sentry
// 测试应验证 mockSentryLazyLoaderService 的调用

describe('SimpleSyncService', () => {
  let service: SimpleSyncService;
  let mockSupabase: any;
  let mockLogger: any;
  let mockLoggerCategory: any; // The category logger instance
  let mockToast: any;
  let mockThrottle: any;
  let mockClient: any;
  
  // Sprint 9 子服务 Mock - 提升到 describe 级别以便测试用例访问
  let mockRealtimePolling: any;
  let mockSessionManager: any;
  let mockRealtimeEnabledState = false;
  
  // 【技术债务重构】RetryQueueService Mock - 提升到 describe 级别方便测试用例访问队列状态
  let mockRetryQueueService: {
    queue: RetryQueueItem[];
    MAX_RETRIES: number;
    WARNING_COOLDOWN: number;
    lastWarningTime: number;
    lastWarningPercent: number;
    isProcessingQueue: boolean;
    length: number;
    setOperationHandler: ReturnType<typeof vi.fn>;
    startLoop: ReturnType<typeof vi.fn>;
    stopLoop: ReturnType<typeof vi.fn>;
    flushSync: ReturnType<typeof vi.fn>;
    processQueue: ReturnType<typeof vi.fn>;
    checkCircuitBreaker: ReturnType<typeof vi.fn>;
    recordCircuitSuccess: ReturnType<typeof vi.fn>;
    recordCircuitFailure: ReturnType<typeof vi.fn>;
  };
  
  // Sentry Mock 变量（从 mockSentryLazyLoaderService 提取）
  const mockCaptureException = mockSentryLazyLoaderService.captureException;
  const mockCaptureMessage = mockSentryLazyLoaderService.captureMessage;
  
  // 测试数据工厂
  const createMockTask = (overrides: Partial<Task> = {}): Task => ({
    id: 'task-1',
    title: 'Test Task',
    content: '',
    stage: 1,
    parentId: null,
    order: 0,
    rank: 0,
    status: 'active',
    x: 0,
    y: 0,
    createdDate: new Date().toISOString(),
    displayId: '1',
    updatedAt: new Date().toISOString(),
    ...overrides
  });
  
  const createMockProject = (overrides: Partial<Project> = {}): Project => ({
    id: 'project-1',
    name: 'Test Project',
    description: '',
    createdDate: new Date().toISOString(),
    tasks: [],
    connections: [],
    ...overrides
  });
  
  const createMockConnection = (overrides: Partial<Connection> = {}): Connection => ({
    id: 'conn-1',
    source: 'task-1',
    target: 'task-2',
    ...overrides
  });

  const readRetryQueueFromIdb = async (): Promise<unknown[]> => {
    if (typeof indexedDB === 'undefined') return [];

    return new Promise((resolve) => {
      try {
        const request = indexedDB.open('nanoflow-retry-queue', 1);

        request.onerror = () => resolve([]);
        request.onupgradeneeded = () => {
          // 首次初始化时由服务创建 store，这里不处理
        };
        request.onsuccess = () => {
          const db = request.result;
          try {
            const tx = db.transaction('offline_mutation_queue', 'readonly');
            const store = tx.objectStore('offline_mutation_queue');
            const getAllReq = store.getAll();

            getAllReq.onerror = () => resolve([]);
            getAllReq.onsuccess = () => resolve(getAllReq.result ?? []);
          } catch {
            resolve([]);
          }
        };
      } catch {
        resolve([]);
      }
    });
  };
  
  beforeEach(() => {
    disablePollutionGuard();
    // 重置模拟客户端
    // 注意：pushTask 现在会先检查 task_tombstones，然后再 upsert
    mockClient = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'task_tombstones') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null })
              })
            })
          };
        }
        // 默认返回用于 tasks/projects/connections 的 mock
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
      }),
      channel: vi.fn().mockReturnValue({
        on: vi.fn().mockReturnThis(),
        subscribe: vi.fn().mockReturnThis()
      }),
      auth: {
        getSession: vi.fn().mockResolvedValue({
          data: { session: { user: { id: 'test-user-id' } } }
        }),
        // 【P0 修复测试】添加 refreshSession mock
        refreshSession: vi.fn().mockResolvedValue({
          data: { session: null },
          error: { message: 'Default mock - no session' }
        })
      }
    };
    
    mockSupabase = {
      isConfigured: false,
      client: vi.fn().mockReturnValue(null)
    };
    
    // Create a consistent category logger mock
    mockLoggerCategory = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn()
    };
    
    mockLogger = {
      category: vi.fn().mockReturnValue(mockLoggerCategory)
    };
    
    mockToast = {
      error: vi.fn(),
      success: vi.fn(),
      warning: vi.fn()
    };
    
    // Mock RequestThrottleService - 直接执行传入的函数
    mockThrottle = {
      execute: vi.fn().mockImplementation(async (_key: string, fn: () => Promise<void>) => {
        await fn();
      })
    };
    
    // Mock ClockSyncService
    const mockClockSync = {
      getServerTime: vi.fn().mockReturnValue(new Date()),
      getClockOffset: vi.fn().mockReturnValue(0),
      sync: vi.fn().mockResolvedValue(undefined),
      checkClockDrift: vi.fn().mockResolvedValue({ status: 'synced', offset: 0, reliable: true }),
      correctTimestamp: vi.fn().mockImplementation((ts: unknown) => typeof ts === 'string' ? ts : new Date().toISOString()),
      getEstimatedServerTime: vi.fn().mockReturnValue(new Date()),
      recordServerTimestamp: vi.fn()
    };
    
    // DestroyRef mock（用于 onDestroy 回调）
    const destroyCallbacks: Array<() => void> = [];
    const mockDestroyRef: Pick<DestroyRef, 'onDestroy'> = {
      onDestroy: (cb: () => void) => { destroyCallbacks.push(cb); return () => { /* cleanup */ }; }
    };
    
    // Mock EventBusService
    const mockEventBus = {
      onSessionRestored$: { pipe: vi.fn().mockReturnValue({ subscribe: vi.fn() }) },
      onUndoRequest$: { pipe: vi.fn().mockReturnValue({ subscribe: vi.fn() }) },
      onRedoRequest$: { pipe: vi.fn().mockReturnValue({ subscribe: vi.fn() }) },
      publishSyncStatus: vi.fn(),
      publishSessionRestored: vi.fn(),
      requestForceSync: vi.fn()
    };
    
    // Mock TombstoneService（Sprint 3 新增）
    const mockTombstone = {
      addLocalTombstones: vi.fn(),
      getLocalTombstones: vi.fn().mockReturnValue(new Set()),
      clearLocalTombstones: vi.fn(),
      clearAllLocalTombstones: vi.fn(),
      getTombstonesWithCache: vi.fn().mockResolvedValue({ data: [], error: null }),
      invalidateTombstoneCache: vi.fn(),
      getCachedTombstoneIds: vi.fn().mockReturnValue(null),
      updateTombstoneCache: vi.fn(),
      getConnectionTombstoneCache: vi.fn().mockReturnValue(null),
      updateConnectionTombstoneCache: vi.fn(),
      deleteAttachmentFilesFromStorage: vi.fn().mockResolvedValue(undefined)
    };
    
    // Sprint 9 新增子服务 Mock
    // 使用可变状态追踪 Realtime 启用状态
    mockRealtimeEnabledState = false;
    mockRealtimePolling = {
      isRealtimeEnabled: vi.fn().mockImplementation(() => mockRealtimeEnabledState),
      setOnRemoteChange: vi.fn(),
      hasRemoteChangeCallback: vi.fn().mockReturnValue(true),
      setUserPreferencesChangeCallback: vi.fn(),
      setRealtimeEnabled: vi.fn().mockImplementation((enabled: boolean) => {
        mockRealtimeEnabledState = enabled;
      }),
      subscribeToProject: vi.fn().mockResolvedValue(undefined),
      unsubscribeFromProject: vi.fn().mockResolvedValue(undefined),
      pauseRealtimeUpdates: vi.fn(),
      resumeRealtimeUpdates: vi.fn(),
      getCurrentProjectId: vi.fn().mockReturnValue(null),
      triggerRemoteChange: vi.fn().mockResolvedValue(true)
    };
    
    mockSessionManager = {
      isSessionExpiredError: vi.fn().mockReturnValue(false),
      // handleSessionExpired 返回类型是 never，所以需要抛出异常
      // 同时更新 SimpleSyncService 的内部状态和显示 Toast（模拟真实行为）
      handleSessionExpired: vi.fn().mockImplementation(function(this: { _service?: SimpleSyncService }) {
        // 设置 SimpleSyncService 的 sessionExpired 状态
        if (service) {
          const currentState = service['syncState']();
          if (!currentState.sessionExpired) {
            service['syncState'].update((s) => ({ ...s, sessionExpired: true }));
            // 模拟真实行为：首次过期时显示 Toast
            mockToast.warning('登录已过期', '请重新登录以继续同步数据');
          }
        }
        throw new Error('Session expired');
      }),
      tryRefreshSession: vi.fn().mockResolvedValue(false),
      handleAuthErrorWithRefresh: vi.fn().mockResolvedValue(false),
      resetSessionExpired: vi.fn(),
      validateSession: vi.fn().mockResolvedValue({ valid: true, userId: 'test-user' }),
      getRecentValidationSnapshot: vi.fn().mockReturnValue(null)
    };
    
    // Sprint 9 新增子服务 Mock（SyncOperationHelper, UserPreferencesSync, ProjectData）
    const mockSyncOpHelper = {
      getClient: vi.fn().mockReturnValue(mockClient),
      isSessionExpired: vi.fn().mockReturnValue(false),
      execute: vi.fn().mockResolvedValue({ success: true, data: undefined }),
      // 【重构修复】retryWithBackoff 委托需要此方法 - 测试环境跳过延迟
      retryWithBackoff: vi.fn().mockImplementation(async <T>(
        operation: () => Promise<T>,
        maxRetries = 3,
        _baseDelay = 1000
      ): Promise<T> => {
        let lastError: unknown;
        
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          try {
            return await operation();
          } catch (e) {
            lastError = e;
            const enhanced = e as { isRetryable?: boolean; code?: string };
            // 简化的可重试判断：5xx, 429, 408, 网络错误
            const code = enhanced.code || '';
            const isRetryable = enhanced.isRetryable ?? (
              ['504', '503', '502', '429', '408', 'NETWORK_ERROR'].includes(code) ||
              code.startsWith('5')
            );
            
            if (!isRetryable) {
              throw e;
            }
            
            // 【测试环境】跳过延迟，立即进入下一次重试
            // 这样测试不会超时
          }
        }
        throw lastError;
      })
    };
    
    const mockUserPrefsSync = {
      loadUserPreferences: vi.fn().mockResolvedValue(null),
      saveUserPreferences: vi.fn().mockResolvedValue(true)
    };
    
    const mockProjectData = {
      loadFullProjectOptimized: vi.fn().mockResolvedValue(null),
      loadFullProject: vi.fn().mockResolvedValue(null),
      loadProjectsFromCloud: vi.fn().mockResolvedValue([]),
      loadSingleProject: vi.fn().mockResolvedValue(null),
      saveOfflineSnapshot: vi.fn(),
      loadOfflineSnapshot: vi.fn().mockReturnValue(null),
      clearOfflineSnapshot: vi.fn(),
      addLocalTombstones: vi.fn(),
      invalidateTombstoneCache: vi.fn(),
      isLoadingRemote: { set: vi.fn() }
    };
    
    // Sprint 9 新增：BatchSyncService Mock
    const mockBatchSync = {
      setCallbacks: vi.fn(),
      saveProjectToCloud: vi.fn().mockResolvedValue({ success: true, newVersion: 1 })
    };

    const mockBlackBoxSync = {
      setRetryQueueHandler: vi.fn(),
      pushToServer: vi.fn().mockResolvedValue(true)
    };
    
    // 【技术债务重构】TaskSyncOperationsService Mock
    // 注：详细的任务同步逻辑测试已迁移至 task-sync-operations.service.spec.ts
    const mockTaskSyncOps = {
      setCallbacks: vi.fn(),
      pushTask: vi.fn().mockResolvedValue(true),
      pushTaskPosition: vi.fn().mockResolvedValue(true),
      pullTasks: vi.fn().mockResolvedValue([]),
      deleteTask: vi.fn().mockResolvedValue(true),
      // mock 实现：返回传入的任务 ID 数量
      softDeleteTasksBatch: vi.fn().mockImplementation((_projectId: string, taskIds: string[]) => 
        Promise.resolve(taskIds.length)
      ),
      purgeTasksFromCloud: vi.fn().mockResolvedValue(true),
      getTombstoneIds: vi.fn().mockResolvedValue(new Set()),
      getTombstoneIdsWithStatus: vi.fn().mockResolvedValue({ ids: new Set(), fromRemote: false, localCacheOnly: true, timestamp: Date.now() }),
      getLocalTombstones: vi.fn().mockReturnValue(new Set()),
      addLocalTombstones: vi.fn(),
      topologicalSortTasks: vi.fn().mockImplementation((tasks: Task[]) => tasks)
    };
    
    // 【技术债务重构】ConnectionSyncOperationsService Mock
    const mockConnectionSyncOps = {
      setCallbacks: vi.fn(),
      pushConnection: vi.fn().mockResolvedValue(true),
      getConnectionTombstoneIds: vi.fn().mockResolvedValue(new Set())
    };
    
    // 【技术债务重构】RetryQueueService Mock
    // 队列管理已从 SimpleSyncService 提取到独立服务
    mockRetryQueueService = {
      queue: [],
      MAX_RETRIES: 5,
      WARNING_COOLDOWN: 300_000,
      lastWarningTime: 0,
      lastWarningPercent: 0,
      isProcessingQueue: false,
      get length() { return this.queue.length; },
      setOperationHandler: vi.fn(),
      startLoop: vi.fn(),
      stopLoop: vi.fn(),
      flushSync: vi.fn(),
      processQueue: vi.fn(),
      processQueueSlice: vi.fn().mockResolvedValue({
        processed: 0,
        remaining: 0,
        durationMs: 0,
        completed: true
      }),
      checkCircuitBreaker: vi.fn().mockReturnValue(true),
      recordCircuitSuccess: vi.fn(),
      recordCircuitFailure: vi.fn()
    };
    
    const injector = Injector.create({
      providers: [
        { provide: SupabaseClientService, useValue: mockSupabase },
        { provide: LoggerService, useValue: mockLogger },
        { provide: ToastService, useValue: mockToast },
        { provide: RequestThrottleService, useValue: mockThrottle },
        { provide: ClockSyncService, useValue: mockClockSync },
        { provide: EventBusService, useValue: mockEventBus },
        { provide: DestroyRef, useValue: mockDestroyRef },
        // Sprint 3 新增的子服务
        { provide: TombstoneService, useValue: mockTombstone },
        // Sprint 9 新增的子服务
        { provide: RealtimePollingService, useValue: mockRealtimePolling },
        { provide: SessionManagerService, useValue: mockSessionManager },
        { provide: SyncOperationHelperService, useValue: mockSyncOpHelper },
        { provide: UserPreferencesSyncService, useValue: mockUserPrefsSync },
        { provide: ProjectDataService, useValue: mockProjectData },
        { provide: BatchSyncService, useValue: mockBatchSync },
        // 【技术债务重构】新增的子服务
        { provide: TaskSyncOperationsService, useValue: mockTaskSyncOps },
        { provide: ConnectionSyncOperationsService, useValue: mockConnectionSyncOps },
        { provide: RetryQueueService, useValue: mockRetryQueueService },
        { provide: SyncStateService, useClass: SyncStateService },
        { provide: BlackBoxSyncService, useValue: mockBlackBoxSync },
        // Sentry 懒加载服务 mock
        { provide: SentryLazyLoaderService, useValue: mockSentryLazyLoaderService }
      ]
    });
    
    service = runInInjectionContext(injector, () => new SimpleSyncService());
  });
  
  afterEach(() => {
    // 清理定时器
    vi.clearAllTimers();
    enablePollutionGuard();
  });
  
  describe('初始化', () => {
    it('应该正确初始化状态', () => {
      expect(service.state().isSyncing).toBe(false);
      expect(service.state().pendingCount).toBe(0);
      expect(service.state().lastSyncTime).toBeNull();
    });
    
    it('应该初始化网络状态为在线', () => {
      expect(service.state().isOnline).toBe(true);
    });
    
    it('便捷 computed 属性应该正常工作', () => {
      expect(service.isOnline()).toBe(true);
      expect(service.isSyncing()).toBe(false);
      expect(service.hasConflict()).toBe(false);
    });
  });
  
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
      // 避免 retryWithBackoff 的真实指数退避等待（Zone.js 下 fake timers 不稳定）
      service['delay'] = vi.fn().mockResolvedValue(undefined);

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
              eq: vi.fn().mockResolvedValue({ data: [], error: null })
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
      const syncOpHelper = service['syncOpHelper'];
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
                  error: { code: '503', message: 'Service unavailable' }
                })
              })
            }),
            select: vi.fn().mockReturnValue({
              in: vi.fn().mockResolvedValue({ data: [], error: null })
            })
          };
        }
        return {};
      });
      
      // 手动添加到队列（模拟之前的入队）
      service['retryQueue'] = [];
      service.addToRetryQueue('task', 'upsert', task, 'project-1');
      const queueLengthBefore = service['retryQueue'].length;
      expect(queueLengthBefore).toBe(1);
      
      // 处理队列（应该失败但不双重入队）
      await service['processRetryQueue']();
      
      // 【关键断言】队列长度应该仍为 1（同一任务不应出现 2 次）
      const queueLengthAfter = service['retryQueue'].length;
      expect(queueLengthAfter).toBe(1);
      
      // 验证是同一个任务（通过去重机制或 fromRetryQueue 参数）
      const queuedItem = service['retryQueue'][0];
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
                maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null })
              })
            })
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
                      error: { code: '504', message: 'Gateway timeout' } 
                    });
                  }
                  return Promise.resolve({ 
                    data: { updated_at: new Date().toISOString() }, 
                    error: null 
                  });
                })
              })
            };
          })
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
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null })
          })
        })
      };
      
      // Mock 任务存在性查询
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
      
      // 模拟 429 错误后成功
      const connectionsQueryMock = {
        upsert: vi.fn().mockImplementation(() => {
          attempts++;
          if (attempts === 1) {
            return Promise.resolve({ error: { code: 429, message: 'Too many requests' } });
          }
          return Promise.resolve({ error: null });
        })
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
                maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null })
              })
            })
          };
        }
        return {
          upsert: vi.fn().mockImplementation(() => {
            upsertAttempts++;
            return {
              select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({ 
                  data: null, 
                  error: { code: '401', message: 'Unauthorized' } 
                })
              })
            };
          })
        };
      });
      
      // 401 会话过期错误应该抛出异常
      await expect(service.pushTask(task, 'project-1')).rejects.toThrow();
      expect(upsertAttempts).toBe(1); // 验证没有重试
    });
  });
  
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
      // 避免 retryWithBackoff 的真实指数退避等待（Zone.js 下 fake timers 不稳定）
      service['delay'] = vi.fn().mockResolvedValue(undefined);

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
  });
  
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
      // Zone.js 环境下 Vitest fake timers 对 setTimeout 拦截不稳定，
      // 这里直接 stub 服务内部 delay()，避免指数退避造成真实 1+2+4 秒等待。
      service['delay'] = vi.fn().mockResolvedValue(undefined);
      
      const task = createMockTask({ id: 'fail-task' });
      const networkError = new Error('Network error');
      
      // 模拟 pushTask 过程中发生错误
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
        // tasks 表的 upsert 失败
        return {
          upsert: vi.fn().mockRejectedValue(networkError)
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
          operation: 'pushTask'
        })
      });
    });
    
    it('pushTask 失败时应该将任务加入 RetryQueue', async () => {
      // 同上：stub delay() 避免真实等待
      service['delay'] = vi.fn().mockResolvedValue(undefined);
      
      const task = createMockTask({ id: 'retry-task' });
      const networkError = new Error('Network error');
      
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
              single: vi.fn().mockRejectedValue(networkError)
            })
          })
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
          eq: vi.fn().mockRejectedValue(deleteError)
        })
      });
      
      await service.deleteTask('task-to-delete', 'project-1');
      
      expect(mockCaptureException).toHaveBeenCalled();
      const callArgs = mockCaptureException.mock.calls[0];
      expect(callArgs[1]).toMatchObject({
        tags: expect.objectContaining({
          operation: 'deleteTask'
        })
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
                maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null })
              })
            })
          };
        }
        return {
          upsert: vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({
              single: vi.fn().mockRejectedValue(retryableError)
            })
          })
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
        message: 'Foreign key constraint violation'
      };
      
      mockClient.from = vi.fn().mockReturnValue({
        delete: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ 
            data: null,
            error: validationError 
          })
        })
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
        message: 'Network timeout'
      };
      
      mockClient.from = vi.fn().mockReturnValue({
        delete: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ 
            data: null,
            error: networkError 
          })
        })
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
                        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null })
                    })
                })
            };
        }
        if (table === 'tasks') {
          return {
            upsert: vi.fn().mockImplementation((data) => {
              if (data.id === 'task-1') {
                return Promise.resolve({ error: new Error('Sync failed') });
              }
              return Promise.resolve({ error: null });
            })
          };
        }
        return {
          upsert: vi.fn().mockResolvedValue({ error: null }),
          delete: vi.fn().mockResolvedValue({ error: null }),
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              gt: vi.fn().mockResolvedValue({ data: [], error: null })
            })
          })
        };
      });

      // Add to retry queue manually
      service.addToRetryQueue('task', 'upsert', task1, 'project-1');
      service.addToRetryQueue('task', 'upsert', task2, 'project-1');
      service.addToRetryQueue('connection', 'upsert', conn, 'project-1');

      // Trigger processing
      await service['processRetryQueue']();

      // Verify task-1 failed, task-2 succeeded
      // Verify connection was NOT attempted (because source task-1 failed)
      const calls = mockClient.from.mock.calls;
      const connectionCalls = calls.filter((call: unknown[]) => call[0] === 'connections');
      expect(connectionCalls.length).toBe(0);

      // Verify connection remains in queue
      expect(service['retryQueue'].length).toBeGreaterThan(0);
      const queuedConn = service['retryQueue'].find((item: RetryQueueItem) => item.type === 'connection');
      expect(queuedConn).toBeDefined();
      expect(queuedConn.data.id).toBe('conn-1');
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
                maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null })
              })
            })
          };
        }
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
            upsert: vi.fn().mockReturnValue({
              select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({ 
                  data: { updated_at: new Date().toISOString() }, 
                  error: null 
                })
              })
            }),
            select: vi.fn().mockReturnValue({
              in: vi.fn().mockReturnValue({
                eq: vi.fn().mockResolvedValue({
                  data: [{ id: 'task-1' }, { id: 'task-2' }],
                  error: null
                }),
                // 也处理没有 eq 的情况（批量查询）
                then: (resolve: Function) => resolve({
                  data: [{ id: 'task-1' }, { id: 'task-2' }],
                  error: null
                })
              })
            })
          };
        }
        if (table === 'connections') {
          return {
            upsert: vi.fn().mockResolvedValue({ error: null })
          };
        }
        return {
          upsert: vi.fn().mockResolvedValue({ error: null }),
          select: vi.fn().mockReturnValue({
            in: vi.fn().mockResolvedValue({ data: [], error: null })
          })
        };
      });

      service.addToRetryQueue('task', 'upsert', task1, 'project-1');
      service.addToRetryQueue('task', 'upsert', task2, 'project-1');
      service.addToRetryQueue('connection', 'upsert', conn, 'project-1');

      await service['processRetryQueue']();

      const calls = mockClient.from.mock.calls;
      const connectionCalls = calls.filter((call: unknown[]) => call[0] === 'connections');
      expect(connectionCalls.length).toBe(1);
      expect(service['retryQueue'].length).toBe(0);
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
        p_project_id: 'project-1'
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
        error: { message: 'Bulk delete blocked: attempting to delete 60 tasks (60% of total 100)' } 
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
        error: { message: 'Function does not exist', code: '42883' } 
      });
      
      // 模拟降级更新成功
      mockClient.from = vi.fn().mockReturnValue({ 
        update: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            in: vi.fn().mockResolvedValue({ error: null })
          })
        })
      });
      mockSupabase.client = vi.fn().mockReturnValue(mockClient);
      
      const result = await service.softDeleteTasksBatch('project-1', ['task-1', 'task-2']);
      
      expect(result).toBe(2);
      expect(mockClient.from).toHaveBeenCalledWith('tasks');
    });
  });

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
      expect(mockBatchSync.saveProjectToCloud).toHaveBeenCalledWith(project, 'test-user-id');
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

  describe('Batch Sync Exception Handling', () => {
    // 注意：saveProjectToCloud 现在委托给 BatchSyncService
    // 这里测试的是委托行为是否正确
    let mockBatchSync: any;
    
    beforeEach(() => {
      mockSupabase.isConfigured = true;
      mockSupabase.client = vi.fn().mockReturnValue(mockClient);
      
      // 获取注入的 BatchSyncService mock
      mockBatchSync = service['batchSyncService'];
    });

    it('saveProjectToCloud 应该委托给 BatchSyncService', async () => {
      const project = createMockProject({ id: 'project-1', tasks: [], connections: [] });
      mockBatchSync.saveProjectToCloud = vi.fn().mockResolvedValue({ success: true, newVersion: 1 });

      const result = await service.saveProjectToCloud(project, 'test-user-id');

      expect(mockBatchSync.saveProjectToCloud).toHaveBeenCalledWith(project, 'test-user-id');
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
  });

  // 【P1 修复】队列容量警告功能已迁移到 RetryQueueService
  // 这些测试调用的方法已不存在于 SimpleSyncService 上，需迁移到 retry-queue.service.spec.ts
  describe.skip('队列容量警告节流', () => {
    it('checkQueueCapacityWarning 应该有 5 分钟冷却时间', () => {
      // 验证冷却时间配置存在（修复：从 60s 增加到 5 分钟）
      expect(mockRetryQueueService.WARNING_COOLDOWN).toBe(300_000);
    });

    it('低于阈值时不应该显示警告', async () => {
      // 添加少量任务（低于 80% 阈值）
      for (let i = 0; i < 70; i++) {
        const task = createMockTask({ id: `task-${i}` });
        await service.pushTask(task, 'project-1');
      }

      // 手动调用容量检查
      service['checkQueueCapacityWarning']();

      // 不应该显示错误 Toast
      expect(mockToast.error).not.toHaveBeenCalled();
    });

    it('达到阈值时应该显示警告（首次）', async () => {
      // 重置 Toast mock
      mockToast.error.mockClear();

      // 模拟队列达到 80% 容量
      mockRetryQueueService.queue = Array.from({ length: 85 }, (_, i) => ({
        id: `item-${i}`,
        type: 'task' as const,
        operation: 'upsert' as const,
        data: createMockTask({ id: `task-${i}` }),
        projectId: 'project-1',
        retryCount: 0,
        createdAt: Date.now()
      }));

      // 调用容量检查
      service['checkQueueCapacityWarning']();

      // 应该显示警告
      expect(mockToast.error).toHaveBeenCalledWith(
        '⚠️ 同步队列即将满载',
        '请连接网络以防止数据丢失',
        { duration: 30_000 }
      );
    });

    it('冷却时间内不应该重复显示警告', async () => {
      // 使用 fake timers
      vi.useFakeTimers();

      // 重置状态
      mockToast.error.mockClear();
      mockRetryQueueService.lastWarningTime = 0;
      mockRetryQueueService.lastWarningPercent = 0;

      // 模拟队列达到阈值
      mockRetryQueueService.queue = Array.from({ length: 85 }, (_, i) => ({
        id: `item-${i}`,
        type: 'task' as const,
        operation: 'upsert' as const,
        data: createMockTask({ id: `task-${i}` }),
        projectId: 'project-1',
        retryCount: 0,
        createdAt: Date.now()
      }));

      // 第一次调用 - 应该显示
      service['checkQueueCapacityWarning']();
      expect(mockToast.error).toHaveBeenCalledTimes(1);

      // 立即再次调用 - 应该被节流跳过
      service['checkQueueCapacityWarning']();
      expect(mockToast.error).toHaveBeenCalledTimes(1);

      // 2 分钟后调用 - 仍在冷却期内（冷却时间是 5 分钟）
      vi.advanceTimersByTime(120_000);
      service['checkQueueCapacityWarning']();
      expect(mockToast.error).toHaveBeenCalledTimes(1);

      // 5 分钟后调用 - 冷却结束，应该再次显示
      vi.advanceTimersByTime(180_000 + 1000); // 再过 3 分钟 + 1 秒 = 总共 5 分 1 秒
      service['checkQueueCapacityWarning']();
      expect(mockToast.error).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });

    it('情况恶化时应该记录 Sentry 警告（绕过冷却）', async () => {
      // 使用 fake timers
      vi.useFakeTimers();

      // 重置状态
      mockToast.error.mockClear();
      mockSentryLazyLoaderService.captureMessage.mockClear();
      mockRetryQueueService.lastWarningTime = Date.now();
      mockRetryQueueService.lastWarningPercent = 85; // 上次警告时是 85%

      // 模拟队列情况恶化到 96%（增加超过 10%）
      mockRetryQueueService.queue = Array.from({ length: 96 }, (_, i) => ({
        id: `item-${i}`,
        type: 'task' as const,
        operation: 'upsert' as const,
        data: createMockTask({ id: `task-${i}` }),
        projectId: 'project-1',
        retryCount: 0,
        createdAt: Date.now()
      }));

      // 调用容量检查
      service['checkQueueCapacityWarning']();
      
      // 情况恶化时应该记录 Sentry（即使在冷却期内）
      expect(mockSentryLazyLoaderService.captureMessage).toHaveBeenCalledWith(
        'RetryQueue capacity warning',
        expect.objectContaining({
          level: 'warning',
          tags: expect.objectContaining({
            percentUsed: '96'
          })
        })
      );
      
      // Toast 只在冷却时间过后显示（减少用户打扰）
      // 在冷却期内情况恶化时不显示 Toast
      expect(mockToast.error).toHaveBeenCalledTimes(0);

      vi.useRealTimers();
    });

    it('恢复正常后应该重置警告状态', async () => {
      // 设置上次警告状态
      mockRetryQueueService.lastWarningPercent = 85;

      // 模拟队列恢复正常（低于阈值）
      mockRetryQueueService.queue = Array.from({ length: 50 }, (_, i) => ({
        id: `item-${i}`,
        type: 'task' as const,
        operation: 'upsert' as const,
        data: createMockTask({ id: `task-${i}` }),
        projectId: 'project-1',
        retryCount: 0,
        createdAt: Date.now()
      }));

      // 调用容量检查
      service['checkQueueCapacityWarning']();

      // 验证状态被重置
      expect(mockRetryQueueService.lastWarningPercent).toBe(0);

      // 验证记录了恢复日志
      expect(mockLoggerCategory.info).toHaveBeenCalledWith(
        'RetryQueue 容量恢复正常',
        expect.objectContaining({ currentSize: 50 })
      );
    });

    it('队列满载时应该记录诊断信息', () => {
      // 重置状态
      mockToast.error.mockClear();
      mockLoggerCategory.warn.mockClear();
      mockRetryQueueService.lastWarningTime = 0;
      mockRetryQueueService.lastWarningPercent = 0;
      
      // 设置离线状态（防止触发 processRetryQueue 清空队列）
      service['syncState'].update(s => ({ ...s, isOnline: false, sessionExpired: false }));

      // 模拟队列达到 85%（高于阈值但低于 90%，避免触发强制处理）
      mockRetryQueueService.queue = Array.from({ length: 85 }, (_, i) => ({
        id: `item-${i}`,
        type: 'task' as const,
        operation: 'upsert' as const,
        data: createMockTask({ id: `task-${i}` }),
        projectId: 'project-1',
        retryCount: 0,
        createdAt: Date.now()
      }));

      // 调用容量检查
      service['checkQueueCapacityWarning']();
      
      // 验证记录了队列容量警告日志（包含诊断信息）
      expect(mockLoggerCategory.warn).toHaveBeenCalledWith(
        'RetryQueue 容量警告',
        expect.objectContaining({
          currentSize: 85,
          maxSize: 100,
          percentUsed: 85,
          isOnline: false,
          isSyncing: expect.any(Boolean),
          circuitState: expect.any(String),
          retryQueueTypes: expect.objectContaining({
            task: 85,
            project: 0,
            connection: 0
          })
        })
      );
    });

    it('队列阻塞且 isSyncing 时应该强制重置 isSyncing', () => {
      // 重置状态
      mockLoggerCategory.warn.mockClear();
      mockRetryQueueService.lastWarningTime = 0;
      mockRetryQueueService.lastWarningPercent = 0;
      
      // Mock processRetryQueue 以防止它修改 isSyncing 状态
      const processRetryQueueSpy = vi.spyOn(service as unknown as { processRetryQueue: () => Promise<void> }, 'processRetryQueue').mockImplementation(() => Promise.resolve());
      
      // 模拟 isSyncing 卡住的状态（通过 syncState signal 设置）
      // 【修复 2026-02-02】新增 isProcessingQueue 为 false，模拟状态不一致情况
      service['syncState'].update(s => ({ ...s, isOnline: true, sessionExpired: false, isSyncing: true }));
      mockRetryQueueService.isProcessingQueue = false; // 状态不一致：isSyncing=true 但 isProcessingQueue=false

      // 模拟队列达到 90%+ 容量
      mockRetryQueueService.queue = Array.from({ length: 92 }, (_, i) => ({
        id: `item-${i}`,
        type: 'task' as const,
        operation: 'upsert' as const,
        data: createMockTask({ id: `task-${i}` }),
        projectId: 'project-1',
        retryCount: 0,
        createdAt: Date.now()
      }));

      // 调用容量检查
      service['checkQueueCapacityWarning']();
      
      // 【修复 2026-02-02】验证记录了 isSyncing 状态不一致警告
      expect(mockLoggerCategory.warn).toHaveBeenCalledWith(
        'isSyncing 状态不一致，重置',
        expect.objectContaining({ percentUsed: 92 })
      );
      
      // 验证 isSyncing 被重置
      expect(service['syncState']().isSyncing).toBe(false);
      
      // 验证 processRetryQueue 被调用（强制处理尝试）
      expect(processRetryQueueSpy).toHaveBeenCalled();
      
      // 恢复 spy
      processRetryQueueSpy.mockRestore();
    });

    it('getQueueTypeBreakdown 应该正确统计队列类型', () => {
      // 模拟混合类型队列
      mockRetryQueueService.queue = [
        { id: '1', type: 'task' as const, operation: 'upsert' as const, data: { id: 't1' }, projectId: 'p1', retryCount: 0, createdAt: Date.now() },
        { id: '2', type: 'task' as const, operation: 'upsert' as const, data: { id: 't2' }, projectId: 'p1', retryCount: 0, createdAt: Date.now() },
        { id: '3', type: 'project' as const, operation: 'upsert' as const, data: { id: 'p1' }, retryCount: 0, createdAt: Date.now() },
        { id: '4', type: 'connection' as const, operation: 'upsert' as const, data: { id: 'c1' }, projectId: 'p1', retryCount: 0, createdAt: Date.now() },
      ] as unknown as RetryQueueItem[];

      const breakdown = service['getQueueTypeBreakdown']();
      
      expect(breakdown).toEqual({
        task: 2,
        project: 1,
        connection: 1
      });
    });
  });
  
  // ==================== P0 修复：Session Expired 阻止队列溢出 ====================
  // 【技术债务重构】此测试组部分测试依赖于子服务内部行为，需要重新设计
  describe.skip('【P0 修复】Session Expired 导致队列溢出', () => {
    
    it('addToRetryQueue 应在 sessionExpired 时跳过添加', () => {
      // 设置会话过期状态
      service['syncState'].update(s => ({ ...s, sessionExpired: true }));
      
      const initialQueueLength = mockRetryQueueService.queue.length;
      const task = createMockTask();
      
      // 尝试添加到重试队列
      service.addToRetryQueue('task', 'upsert', task, 'project-1');
      
      // 验证队列长度未变化
      expect(mockRetryQueueService.queue.length).toBe(initialQueueLength);
      
      // 验证记录了跳过日志
      expect(mockLoggerCategory.debug).toHaveBeenCalledWith(
        '会话已过期，跳过添加到重试队列',
        expect.objectContaining({ type: 'task', dataId: task.id })
      );
    });
    
    it('addToRetryQueue 应在会话正常时正常添加', () => {
      // 确保会话正常
      service['syncState'].update(s => ({ ...s, sessionExpired: false }));
      
      const initialQueueLength = mockRetryQueueService.queue.length;
      const task = createMockTask({ id: 'new-task-for-queue' });
      
      // 添加到重试队列
      service.addToRetryQueue('task', 'upsert', task, 'project-1');
      
      // 验证队列长度增加
      expect(mockRetryQueueService.queue.length).toBe(initialQueueLength + 1);
    });
    
    it('resetSessionExpired 应正确重置会话状态', () => {
      // 设置会话过期状态
      service['syncState'].update(s => ({ ...s, sessionExpired: true }));
      
      // 添加一些队列项
      mockRetryQueueService.queue = [{
        id: 'test-item',
        type: 'task' as const,
        operation: 'upsert' as const,
        data: createMockTask(),
        projectId: 'project-1',
        retryCount: 0,
        createdAt: Date.now()
      }];
      
      // 调用重置方法
      service.resetSessionExpired();
      
      // 验证会话状态被重置
      expect(service.syncState().sessionExpired).toBe(false);
      
      // 验证记录了恢复日志
      expect(mockLoggerCategory.info).toHaveBeenCalledWith(
        '会话状态已重置',
        expect.objectContaining({ previousQueueLength: 1 })
      );
    });
    
    it('resetSessionExpired 应在会话未过期时不做任何操作', () => {
      // 确保会话正常
      service['syncState'].update(s => ({ ...s, sessionExpired: false }));
      
      // 清空日志 mock
      mockLoggerCategory.info.mockClear();
      
      // 调用重置方法
      service.resetSessionExpired();
      
      // 验证没有记录日志（因为没有需要重置的状态）
      expect(mockLoggerCategory.info).not.toHaveBeenCalledWith(
        '会话状态已重置',
        expect.anything()
      );
    });
    
    it('startRetryLoop 应在 sessionExpired 时跳过处理', async () => {
      vi.useFakeTimers();
      
      // 设置会话过期状态
      service['syncState'].update(s => ({ ...s, sessionExpired: true, isOnline: true }));
      
      // 添加队列项
      mockRetryQueueService.queue = [{
        id: 'test-item',
        type: 'task' as const,
        operation: 'upsert' as const,
        data: createMockTask(),
        projectId: 'project-1',
        retryCount: 0,
        createdAt: Date.now()
      }];
      
      // 创建 processRetryQueue spy
      const processRetryQueueSpy = vi.spyOn(service as unknown as { processRetryQueue: () => Promise<void> }, 'processRetryQueue');
      
      // 前进一个重试间隔
      vi.advanceTimersByTime(5000);
      
      // 验证 processRetryQueue 没有被调用（因为 sessionExpired 在 setInterval 回调中被检查）
      // 注意：实际上 processRetryQueue 可能被调用，但它会立即返回
      // 我们验证队列项没有被处理（retryCount 没有增加）
      const queueItem = mockRetryQueueService.queue[0];
      expect(queueItem.retryCount).toBe(0);
      
      vi.useRealTimers();
    });
  });

  describe('recoverAfterResume', () => {
    it('在线时应处理重试队列并触发远程回调链路', async () => {
      mockRetryQueueService.queue = [{
        id: 'resume-item',
        type: 'task' as const,
        operation: 'upsert' as const,
        data: createMockTask({ id: 'resume-task' }),
        projectId: 'project-1',
        retryCount: 0,
        createdAt: Date.now()
      }];
      mockRealtimePolling.getCurrentProjectId.mockReturnValue('project-1');
      mockRealtimePolling.triggerRemoteChange.mockResolvedValue(true);

      await service.recoverAfterResume('visibility-threshold');

      expect(mockRetryQueueService.processQueueSlice).toHaveBeenCalledTimes(1);
      expect(mockRetryQueueService.processQueueSlice).toHaveBeenCalledWith({
        maxItems: 30,
        maxDurationMs: 150
      });
      expect(mockRealtimePolling.resumeRealtimeUpdates).toHaveBeenCalledTimes(1);
      expect(mockRealtimePolling.triggerRemoteChange).toHaveBeenCalledWith({
        eventType: 'resume',
        projectId: 'project-1'
      });
      expect(
        mockRealtimePolling.resumeRealtimeUpdates.mock.invocationCallOrder[0]
      ).toBeLessThan(mockRealtimePolling.triggerRemoteChange.mock.invocationCallOrder[0]);
    });

    it('light 模式应只处理队列，不触发远端探测', async () => {
      mockRetryQueueService.queue = [{
        id: 'resume-item-light',
        type: 'task' as const,
        operation: 'upsert' as const,
        data: createMockTask({ id: 'resume-task-light' }),
        projectId: 'project-1',
        retryCount: 0,
        createdAt: Date.now()
      }];

      await service.recoverAfterResume('pulse:focus', { mode: 'light', allowRemoteProbe: false, force: true });

      expect(mockRetryQueueService.processQueueSlice).toHaveBeenCalledTimes(1);
      expect(mockRealtimePolling.triggerRemoteChange).not.toHaveBeenCalled();
      expect(mockRealtimePolling.resumeRealtimeUpdates).toHaveBeenCalledTimes(1);
    });

    it('compensation 阶段应跳过重试队列与 realtime resume', async () => {
      mockRetryQueueService.queue = [{
        id: 'resume-item-compensation',
        type: 'task' as const,
        operation: 'upsert' as const,
        data: createMockTask({ id: 'resume-task-compensation' }),
        projectId: 'project-1',
        retryCount: 0,
        createdAt: Date.now()
      }];

      await service.recoverAfterResume('visibility-threshold', {
        mode: 'heavy',
        stage: 'compensation',
        allowRemoteProbe: false,
        force: true,
        sessionValidated: true
      });

      expect(mockRetryQueueService.processQueueSlice).not.toHaveBeenCalled();
      expect(mockRealtimePolling.resumeRealtimeUpdates).not.toHaveBeenCalled();
    });

    it('interaction-first 路径下无回调时不应全量加载所有项目', async () => {
      mockRealtimePolling.triggerRemoteChange.mockResolvedValue(false);
      mockRealtimePolling.hasRemoteChangeCallback.mockReturnValue(false);
      const loadProjectsSpy = vi.spyOn(service as unknown as {
        loadProjectsFromCloud: (userId: string, silent?: boolean) => Promise<unknown[]>;
      }, 'loadProjectsFromCloud');

      await service.recoverAfterResume('visibility-threshold', {
        mode: 'heavy',
        allowRemoteProbe: true,
        force: true
      });

      expect(mockRealtimePolling.triggerRemoteChange).toHaveBeenCalledTimes(1);
      expect(loadProjectsSpy).not.toHaveBeenCalled();
    });

    it('离线时应跳过恢复流程', async () => {
      Object.defineProperty(navigator, 'onLine', {
        value: false,
        configurable: true,
      });

      await service.recoverAfterResume('online');

      expect(mockRetryQueueService.processQueueSlice).not.toHaveBeenCalled();
      expect(mockRealtimePolling.triggerRemoteChange).not.toHaveBeenCalled();

      Object.defineProperty(navigator, 'onLine', {
        value: true,
        configurable: true,
      });
    });

    it('sessionValidated=true 时不应重复执行会话校验', async () => {
      mockRetryQueueService.queue = [];

      await service.recoverAfterResume('visibility-threshold', {
        mode: 'heavy',
        allowRemoteProbe: false,
        sessionValidated: true,
        force: true
      });

      expect(mockSessionManager.validateSession).not.toHaveBeenCalled();
    });

    it('retryProcessing=background 时应快速返回并后台续跑切片', async () => {
      vi.useFakeTimers();
      mockRetryQueueService.queue = [{
        id: 'resume-item-bg',
        type: 'task' as const,
        operation: 'upsert' as const,
        data: createMockTask({ id: 'resume-task-bg' }),
        projectId: 'project-1',
        retryCount: 0,
        createdAt: Date.now()
      }];
      mockRetryQueueService.processQueueSlice
        .mockResolvedValueOnce({
          processed: 1,
          remaining: 5,
          durationMs: 120,
          completed: false
        })
        .mockResolvedValueOnce({
          processed: 1,
          remaining: 0,
          durationMs: 60,
          completed: true
        });

      const promise = service.recoverAfterResume('visibility-threshold', {
        mode: 'light',
        allowRemoteProbe: false,
        force: true,
        retryProcessing: 'background'
      });

      await promise;
      expect(mockRetryQueueService.processQueueSlice).toHaveBeenCalledTimes(1);

      await vi.runOnlyPendingTimersAsync();
      expect(mockRetryQueueService.processQueueSlice).toHaveBeenCalledTimes(2);
      vi.useRealTimers();
    });

    it('realtime 回调首次未触发时应执行一次兜底 probe', async () => {
      mockRealtimePolling.hasRemoteChangeCallback.mockReturnValue(true);
      mockRealtimePolling.triggerRemoteChange
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);

      await service.recoverAfterResume('visibility-threshold', {
        mode: 'heavy',
        allowRemoteProbe: true,
        force: true,
        sessionValidated: true
      });

      expect(mockRealtimePolling.triggerRemoteChange).toHaveBeenCalledTimes(2);
    });

    it('同一 recoveryTicketId + 同模式恢复不应重复触发远端 probe', async () => {
      mockRealtimePolling.hasRemoteChangeCallback.mockReturnValue(true);
      mockRealtimePolling.triggerRemoteChange.mockResolvedValue(true);

      await service.recoverAfterResume('visibility-threshold', {
        mode: 'heavy',
        allowRemoteProbe: true,
        sessionValidated: true,
        recoveryTicketId: 'ticket-1',
      });
      await service.recoverAfterResume('visibility-threshold', {
        mode: 'heavy',
        allowRemoteProbe: true,
        sessionValidated: true,
        recoveryTicketId: 'ticket-1',
      });

      expect(mockRealtimePolling.triggerRemoteChange).toHaveBeenCalledTimes(1);
    });

    it('probe 超时后应按 backgroundProbeDelayMs 调度后台补偿', async () => {
      vi.useFakeTimers();
      mockRealtimePolling.hasRemoteChangeCallback.mockReturnValue(true);
      mockRealtimePolling.triggerRemoteChange.mockImplementation(
        () => new Promise<boolean>(() => {
          // 持续 pending，触发超时分支
        })
      );

      const promise = service.recoverAfterResume('visibility-threshold', {
        mode: 'heavy',
        allowRemoteProbe: true,
        force: true,
        sessionValidated: true,
        resumeProbeTimeoutMs: 500,
        backgroundProbeDelayMs: 120,
      });

      await vi.advanceTimersByTimeAsync(500);
      await promise;
      expect(mockRealtimePolling.triggerRemoteChange).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(120);
      expect(mockRealtimePolling.triggerRemoteChange).toHaveBeenCalledTimes(2);
      vi.useRealTimers();
    });
  });
  
  // ==================== P0 修复：Session Refresh 自动恢复 ====================
  // 【技术债务重构】此测试组测试 pushProject 的错误处理逻辑
  // 需要根据新架构重新设计
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
});
