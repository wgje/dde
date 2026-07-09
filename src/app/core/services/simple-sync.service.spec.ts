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
import { Injector, runInInjectionContext, DestroyRef, signal } from '@angular/core';
import { disablePollutionGuard, enablePollutionGuard, mockSentryLazyLoaderService } from '../../../test-setup.mocks';
import { SimpleSyncService } from './simple-sync.service';
import { registerSimpleSyncSuiteSpecs } from './simple-sync-suite.spec-helpers';
import { SupabaseClientService } from '../../../services/supabase-client.service';
import { LoggerService } from '../../../services/logger.service';
import { ToastService } from '../../../services/toast.service';
import { ActionQueueService } from '../../../services/action-queue.service';
import { RequestThrottleService } from '../../../services/request-throttle.service';
import { ClockSyncService } from '../../../services/clock-sync.service';
import { EventBusService } from '../../../services/event-bus.service';
import { ChangeTrackerService } from '../../../services/change-tracker.service';
import { SentryLazyLoaderService } from '../../../services/sentry-lazy-loader.service';
import { SyncRpcClientService } from '../../../services/sync-rpc-client.service';
import type { TaskWriteIntent } from '../../../services/sync-rpc-client.service';
import { BlackBoxSyncService } from '../../../services/black-box-sync.service';
import { WidgetBindingService } from '../../../services/widget-binding.service';
import { AttachmentCleanupOutboxService } from '../../../services/attachment-cleanup-outbox.service';
import { DockDirectWidgetNotifyOutboxService } from '../../../services/dock-direct-widget-notify-outbox.service';
import {
  ensureBrowserNetworkSuspensionTracking,
  resetBrowserNetworkSuspensionTrackingForTests,
} from '../../../utils/browser-network-suspension';
import { SyncCursorPersistenceService } from '../state/persistence';
import {
  TombstoneService,
  RealtimePollingService,
  SessionManagerService,
  SyncOperationHelperService,
  UserPreferencesSyncService,
  ProjectDataService,
  BatchSyncService,
  TaskSyncOperationsService,
  ConnectionSyncOperationsService,
  RetryQueueService,
  SyncStateService,
  ConnectivityRecoveryService,
} from './sync';
import { ProjectSaveFlightCoordinatorService } from './sync/project-save-flight-coordinator.service';
import { SyncResumeCoordinatorService } from './sync/sync-resume-coordinator.service';
import { ProjectPushService } from './sync/project-push.service';
import { ProjectPushRpcResultHandlerService } from './sync/project-push-rpc-result-handler.service';
import { ProjectDeleteCoordinatorService } from './sync/project-delete-coordinator.service';
import { ProjectSyncCursorService } from './sync/project-sync-cursor.service';
import { RetryQueueEnqueueService } from './sync/retry-queue-enqueue.service';
import type { Task, Project, Connection } from '../../../models';
import type { BlackBoxEntry } from '../../../models/focus';
import { PermanentFailureError } from '../../../utils/permanent-failure-error';
import { ProjectStore } from '../state/stores';
import {
  createMockConnection,
  createMockProject,
  createMockTask,
  expectDeferredCallback,
  readRetryQueueFromIdb,
  setVisibilityState,
  type MockFn,
  type RetryQueueItem,
} from './simple-sync.test-harness';

// 使用 SentryLazyLoaderService mock（来自 test-setup.mocks.ts）
// 注意：现在服务使用 this.sentryLazyLoader 而非直接的 Sentry
// 测试应验证 mockSentryLazyLoaderService 的调用

describe('SimpleSyncService', () => {
  let service: SimpleSyncService;
  let mockSupabase: any;
  let mockLogger: any;
  let mockLoggerCategory: any; // The category logger instance
  let mockToast: any;
  let mockActionQueue: any;
  let mockThrottle: any;
  let mockClient: any;
  let windowAddEventListenerSpy: ReturnType<typeof vi.spyOn>;
  let windowRemoveEventListenerSpy: ReturnType<typeof vi.spyOn>;
  
  // Sprint 9 子服务 Mock - 提升到 describe 级别以便测试用例访问
  let mockRealtimePolling: any;
  let mockSessionManager: any;
  let mockRealtimeEnabledState = false;
  let mockProjectData: any;
  let mockSyncRpcClient: any;
  let mockBlackBoxSync: {
    setRetryQueueHandler: ReturnType<typeof vi.fn>;
    pushToServer: ReturnType<typeof vi.fn>;
    pullChanges: ReturnType<typeof vi.fn>;
    markEntrySyncConflict: ReturnType<typeof vi.fn>;
  };
  let mockProjectStore: any;
  let mockSyncCursorPersistence: any;
  let mockChangeTracker: any;
  let mockSupabaseOfflineMode = signal(false);
  let connectivityListener: ((change: { offline: boolean; source: 'probe' | 'request' | 'manual' }) => void) | null = null;
  let testInjector: Injector;
  
  // 【技术债务重构】RetryQueueService Mock - 提升到 describe 级别方便测试用例访问队列状态
  let mockRetryQueueService: {
    queue: RetryQueueItem[];
    MAX_RETRIES: number;
    WARNING_COOLDOWN: number;
    lastWarningTime: number;
    lastWarningPercent: number;
    isProcessingQueue: boolean;
    length: number;
    add: MockFn;
    addDurably: MockFn;
    persistNow: MockFn;
    hasEntity?: MockFn;
    removeByEntities?: MockFn;
    removeProjectRetriesForOwner?: MockFn;
    removeByProjectIdForOwner?: MockFn;
    getItems: MockFn;
    setOperationHandler: MockFn;
    startLoop: MockFn;
    stopLoop: MockFn;
    flushSync: MockFn;
    processQueue: MockFn;
    processQueueSlice: MockFn;
    clear: MockFn;
    checkCircuitBreaker: MockFn;
    recordCircuitSuccess: MockFn;
    recordCircuitFailure: MockFn;
    checkCapacityWarning: MockFn;
    getTypeBreakdown: MockFn;
  };
  
  // Sentry Mock 变量（从 mockSentryLazyLoaderService 提取）
  const mockCaptureException = mockSentryLazyLoaderService.captureException;
  const mockCaptureMessage = mockSentryLazyLoaderService.captureMessage;
  
  beforeEach(() => {
    disablePollutionGuard();
    resetBrowserNetworkSuspensionTrackingForTests();
    ensureBrowserNetworkSuspensionTracking();
    setVisibilityState('visible');
    mockSupabaseOfflineMode = signal(false);
    connectivityListener = null;
    windowAddEventListenerSpy = vi.spyOn(window, 'addEventListener');
    windowRemoveEventListenerSpy = vi.spyOn(window, 'removeEventListener');
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
      isOfflineMode: mockSupabaseOfflineMode,
      clearOfflineMode: vi.fn().mockImplementation(() => {
        mockSupabaseOfflineMode.set(false);
      }),
      probeReachability: vi.fn().mockImplementation(async () => {
        mockSupabaseOfflineMode.set(false);
        return true;
      }),
      onConnectivityChange: vi.fn().mockImplementation((listener: (change: { offline: boolean; source: 'probe' | 'request' | 'manual' }) => void) => {
        connectivityListener = listener;
        return () => {
          if (connectivityListener === listener) {
            connectivityListener = null;
          }
        };
      }),
      client: vi.fn().mockReturnValue(null),
      clientAsync: vi.fn().mockResolvedValue(mockClient)
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

    mockActionQueue = {
      enqueue: vi.fn().mockReturnValue('action-1'),
      enqueueDurably: vi.fn().mockResolvedValue('action-1'),
      enqueueDurablyForOwner: vi.fn().mockResolvedValue('action-1'),
    };
    
    // Mock RequestThrottleService - 直接执行传入的函数
    mockThrottle = {
      execute: vi.fn().mockImplementation(async (_key: string, fn: () => Promise<unknown>) => {
        return await fn();
      })
    };
    
    // Mock ClockSyncService
    const mockClockSync = {
      getServerTime: vi.fn().mockReturnValue(new Date()),
      getClockOffset: vi.fn().mockReturnValue(0),
      sync: vi.fn().mockResolvedValue(undefined),
      checkClockDrift: vi.fn().mockResolvedValue({ status: 'synced', offset: 0, reliable: true }),
      currentDriftMs: vi.fn().mockReturnValue(0),
      correctTimestamp: vi.fn().mockImplementation((ts: unknown) => typeof ts === 'string' ? ts : new Date().toISOString()),
      getEstimatedServerTime: vi.fn().mockReturnValue(new Date()),
      ensureSynced: vi.fn().mockResolvedValue({ reliable: true }),
      isLocalNewer: vi.fn((left: string, right: string) => new Date(left).getTime() > new Date(right).getTime()),
      compareTimestamps: vi.fn((left: string, right: string) => new Date(left).getTime() - new Date(right).getTime()),
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
      initializeRuntime: vi.fn(),
      teardownRuntime: vi.fn(),
      isRealtimeEnabled: vi.fn().mockImplementation(() => mockRealtimeEnabledState),
      setOnRemoteChange: vi.fn(),
      hasRemoteChangeCallback: vi.fn().mockReturnValue(true),
      setUserPreferencesChangeCallback: vi.fn(),
      setRealtimeEnabled: vi.fn().mockImplementation((enabled: boolean) => {
        mockRealtimeEnabledState = enabled;
      }),
      subscribeToProject: vi.fn().mockResolvedValue(undefined),
      unsubscribeFromProject: vi.fn().mockResolvedValue(undefined),
      suspendTransport: vi.fn().mockResolvedValue(undefined),
      resumeTransport: vi.fn().mockResolvedValue(undefined),
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
            service['syncStateService'].update({ sessionExpired: true });
            // 模拟真实行为：首次过期时显示 Toast
            mockToast.warning('登录已过期', '请重新登录以继续同步数据');
          }
        }
        throw new Error('Session expired');
      }),
      tryRefreshSession: vi.fn().mockResolvedValue(false),
      handleAuthErrorWithRefresh: vi.fn().mockResolvedValue(false),
      resetSessionExpired: vi.fn(),
      validateOrRefreshOnResume: vi.fn().mockResolvedValue({
        ok: true,
        refreshed: false,
        deferred: false,
      }),
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
    
    mockProjectData = {
      loadFullProjectOptimized: vi.fn().mockResolvedValue(null),
      loadFullProject: vi.fn().mockResolvedValue(null),
      loadProjectsFromCloud: vi.fn().mockResolvedValue([]),
      pullProjects: vi.fn().mockResolvedValue([]),
      loadSingleProject: vi.fn().mockResolvedValue(null),
      saveOfflineSnapshot: vi.fn(),
      saveOfflineSnapshotAndWait: vi.fn().mockResolvedValue(undefined),
      loadOfflineSnapshot: vi.fn().mockReturnValue(null),
      loadStartupOfflineSnapshot: vi.fn().mockResolvedValue({
        source: 'none' as const,
        projectCount: 0,
        bytes: 0,
        migratedLegacy: false,
        projects: [],
      }),
      clearOfflineSnapshot: vi.fn(),
      addLocalTombstones: vi.fn(),
      invalidateTombstoneCache: vi.fn(),
      rowToTask: vi.fn().mockImplementation((row: any) => ({
        id: row.id,
        title: row.title ?? '',
        content: row.content ?? '',
        stage: row.stage ?? 1,
        parentId: row.parent_id ?? null,
        order: row.order ?? 0,
        rank: row.rank ?? 0,
        status: row.status ?? 'active',
        x: row.x ?? 0,
        y: row.y ?? 0,
        createdDate: row.created_date ?? row.createdAt ?? row.updated_at,
        updatedAt: row.updated_at,
        deletedAt: row.deleted_at ?? null,
      })),
      rowToConnection: vi.fn().mockImplementation((row: any) => ({
        id: row.id,
        source: row.source_id,
        target: row.target_id,
        title: row.title ?? '',
        description: row.description ?? '',
        updatedAt: row.updated_at,
        deletedAt: row.deleted_at ?? null,
      })),
      rowToProject: vi.fn().mockImplementation((row: any) => createMockProject({
        id: row.id,
        name: row.title ?? row.name ?? '',
        description: row.description ?? '',
        createdDate: row.created_date ?? row.createdAt ?? row.updated_at,
        updatedAt: row.updated_at,
        version: row.version,
      })),
      isLoadingRemote: { set: vi.fn() }
    };

    mockSyncRpcClient = {
      isFeatureEnabled: vi.fn(() => false),
      isClientRejected: vi.fn(() => false),
      checkProtocol: vi.fn().mockResolvedValue(null),
      upsertProject: vi.fn().mockResolvedValue({
        status: 'applied',
        entityId: 'project-1',
        serverUpdatedAt: '2026-04-30T06:00:00.000Z',
        raw: {},
      }),
      deleteProject: vi.fn().mockResolvedValue({
        status: 'applied',
        entityId: 'project-1',
        serverUpdatedAt: '2026-04-30T06:00:00.000Z',
        raw: {},
      }),
    };
    mockProjectStore = {
      getProject: vi.fn(() => undefined),
      setProject: vi.fn(),
    };

    mockSyncCursorPersistence = {
      loadProjectCursor: vi.fn().mockResolvedValue(null),
      commitProjectCursor: vi.fn().mockImplementation(async (_projectId: string, _userId: string | null, cursor: unknown) => cursor),
      clearProjectCursor: vi.fn().mockResolvedValue(undefined),
    };

    mockChangeTracker = {
      getProjectChanges: vi.fn().mockImplementation((projectId: string) => ({
        projectId,
        tasksToCreate: [],
        tasksToUpdate: [],
        taskIdsToDelete: [],
        connectionsToCreate: [],
        connectionsToUpdate: [],
        connectionsToDelete: [],
        hasChanges: false,
        totalChanges: 0,
        taskUpdateFieldsById: {},
      })),
    };
    
    // Sprint 9 新增：BatchSyncService Mock
    const mockBatchSync = {
      setCallbacks: vi.fn(),
      saveProjectToCloud: vi.fn().mockResolvedValue({ success: true, newVersion: 1 })
    };

    mockBlackBoxSync = {
      setRetryQueueHandler: vi.fn(),
      pushToServer: vi.fn().mockResolvedValue(true),
      pullChanges: vi.fn().mockResolvedValue(undefined),
      markEntrySyncConflict: vi.fn().mockResolvedValue(undefined),
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
      add: vi.fn().mockImplementation(function(
        this: { queue: RetryQueueItem[] },
        type: RetryQueueItem['type'],
        operation: RetryQueueItem['operation'],
        data: RetryQueueItem['data'],
        projectId?: string,
        sourceUserId?: string,
        taskIdsToDelete?: string[],
      ) {
        this.queue.push({
          id: crypto.randomUUID(),
          type,
          operation,
          data,
          projectId,
          retryCount: 0,
          createdAt: Date.now(),
          sourceUserId,
          operationId: `test-retry-${type}-${operation}-${data.id}-${crypto.randomUUID()}`,
          taskIdsToDelete,
        });
        return true;
      }),
      addDurably: vi.fn().mockImplementation(async function(
        this: { add: (...args: unknown[]) => boolean; persistNow: () => Promise<boolean> },
        ...args: unknown[]
      ) {
        const accepted = this.add(...args);
        if (!accepted) {
          return false;
        }
        return this.persistNow();
      }),
      persistNow: vi.fn().mockResolvedValue(true),
      hasEntity: vi.fn().mockImplementation(function(
        this: { queue: RetryQueueItem[] },
        type: RetryQueueItem['type'],
        entityId: string,
      ) {
        return this.queue.some((item) => item.type === type && item.data.id === entityId);
      }),
      removeByEntities: vi.fn().mockImplementation(function(
        this: { queue: RetryQueueItem[] },
        type: RetryQueueItem['type'],
        entityIds: string[],
      ) {
        const targets = new Set(entityIds);
        const removed = this.queue
          .filter((item) => item.type === type && targets.has(item.data.id))
          .map((item) => item.data.id);
        this.queue = this.queue.filter((item) => !(item.type === type && targets.has(item.data.id)));
        return [...new Set(removed)];
      }),
      removeProjectRetriesForOwner: vi.fn().mockImplementation(function(
        this: { queue: RetryQueueItem[] },
        projectId: string,
        sourceUserId?: string,
      ) {
        const originalLength = this.queue.length;
        this.queue = this.queue.filter((item) => !(
          item.type === 'project'
          && item.data.id === projectId
          && item.sourceUserId === sourceUserId
        ));
        return originalLength - this.queue.length;
      }),
      removeByProjectIdForOwner: vi.fn().mockImplementation(function(
        this: { queue: RetryQueueItem[] },
        projectId: string,
        sourceUserId?: string,
      ) {
        const originalLength = this.queue.length;
        this.queue = this.queue.filter((item) => !(
          (item.projectId === projectId || (item.type === 'project' && item.data.id === projectId))
          && item.sourceUserId === sourceUserId
        ));
        return originalLength - this.queue.length;
      }),
      getItems: vi.fn().mockImplementation(function(this: { queue: RetryQueueItem[] }) {
        return [...this.queue];
      }),
      setOperationHandler: vi.fn() as MockFn,
      startLoop: vi.fn() as MockFn,
      stopLoop: vi.fn() as MockFn,
      flushSync: vi.fn() as MockFn,
      processQueue: vi.fn() as MockFn,
      processQueueSlice: vi.fn().mockResolvedValue({
        processed: 0,
        remaining: 0,
        durationMs: 0,
        completed: true
      }) as MockFn,
      clear: vi.fn().mockImplementation(function(this: { queue: RetryQueueItem[] }) {
        this.queue = [];
      }) as MockFn,
      checkCircuitBreaker: vi.fn().mockReturnValue(true) as MockFn,
      recordCircuitSuccess: vi.fn() as MockFn,
      recordCircuitFailure: vi.fn() as MockFn,
      checkCapacityWarning: vi.fn() as MockFn,
      getTypeBreakdown: vi.fn().mockReturnValue({ task: 0, project: 0, connection: 0 }) as MockFn,
    };

    const injector = Injector.create({
      providers: [
        { provide: SupabaseClientService, useValue: mockSupabase },
        { provide: LoggerService, useValue: mockLogger },
        { provide: ToastService, useValue: mockToast },
        { provide: ActionQueueService, useValue: mockActionQueue },
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
        { provide: SyncRpcClientService, useValue: mockSyncRpcClient },
        { provide: ProjectStore, useValue: mockProjectStore },
        { provide: SyncCursorPersistenceService, useValue: mockSyncCursorPersistence },
        { provide: ChangeTrackerService, useValue: mockChangeTracker },
        { provide: BatchSyncService, useValue: mockBatchSync },
        // 【技术债务重构】新增的子服务
        { provide: TaskSyncOperationsService, useValue: mockTaskSyncOps },
        { provide: ConnectionSyncOperationsService, useValue: mockConnectionSyncOps },
        { provide: RetryQueueService, useValue: mockRetryQueueService },
        { provide: SyncStateService, useClass: SyncStateService },
        { provide: ProjectSaveFlightCoordinatorService, useClass: ProjectSaveFlightCoordinatorService },
        { provide: SyncResumeCoordinatorService, useClass: SyncResumeCoordinatorService },
        { provide: ProjectPushService, useClass: ProjectPushService },
        { provide: ProjectPushRpcResultHandlerService, useClass: ProjectPushRpcResultHandlerService },
        { provide: ProjectDeleteCoordinatorService, useClass: ProjectDeleteCoordinatorService },
        { provide: ProjectSyncCursorService, useClass: ProjectSyncCursorService },
        { provide: RetryQueueEnqueueService, useClass: RetryQueueEnqueueService },
        { provide: BlackBoxSyncService, useValue: mockBlackBoxSync },
        {
          provide: WidgetBindingService,
          useValue: {
            flushPendingRevokeAllBindings: vi.fn().mockResolvedValue({ ok: true }),
          },
        },
        {
          provide: AttachmentCleanupOutboxService,
          useValue: {
            flushPendingCleanups: vi.fn().mockResolvedValue({
              ok: true,
              deletedCount: 0,
              remainingCount: 0,
              errors: [],
            }),
          },
        },
        {
          provide: DockDirectWidgetNotifyOutboxService,
          useValue: {
            flushPendingNotifications: vi.fn().mockResolvedValue({
              ok: true,
              sentCount: 0,
              remainingCount: 0,
              errors: [],
            }),
          },
        },
        { provide: ConnectivityRecoveryService, useClass: ConnectivityRecoveryService },
        // Sentry 懒加载服务 mock
        { provide: SentryLazyLoaderService, useValue: mockSentryLazyLoaderService }
      ]
    });
    testInjector = injector;
    
    service = runInInjectionContext(injector, () => new SimpleSyncService());
  });
  
  afterEach(() => {
    // 清理定时器
    vi.clearAllTimers();
    resetBrowserNetworkSuspensionTrackingForTests();
    setVisibilityState('visible');
    windowAddEventListenerSpy.mockRestore();
    windowRemoveEventListenerSpy.mockRestore();
    enablePollutionGuard();
  });

  registerSimpleSyncSuiteSpecs({
    service: () => service,
    windowAddEventListenerSpy: () => windowAddEventListenerSpy,
    windowRemoveEventListenerSpy: () => windowRemoveEventListenerSpy,
    mockSupabase: () => mockSupabase,
    mockClient: () => mockClient,
    mockProjectData: () => mockProjectData,
    mockChangeTracker: () => mockChangeTracker,
    mockSyncRpcClient: () => mockSyncRpcClient,
    mockBlackBoxSync: () => mockBlackBoxSync,
    mockProjectStore: () => mockProjectStore,
    mockSyncCursorPersistence: () => mockSyncCursorPersistence,
    mockSessionManager: () => mockSessionManager,
    mockRetryQueueService: () => mockRetryQueueService,
    mockRealtimePolling: () => mockRealtimePolling,
    mockActionQueue: () => mockActionQueue,
    mockToast: () => mockToast,
    mockLoggerCategory: () => mockLoggerCategory,
    mockCaptureMessage: () => mockCaptureMessage,
    mockCaptureException: () => mockCaptureException,
    mockThrottle: () => mockThrottle,
    mockSupabaseOfflineMode: () => mockSupabaseOfflineMode,
    mockSentryLazyLoader: () => mockSentryLazyLoaderService,
    connectivityRecovery: () => testInjector.get(ConnectivityRecoveryService),
    emitConnectivityChange: change => connectivityListener?.(change),
  });
});
