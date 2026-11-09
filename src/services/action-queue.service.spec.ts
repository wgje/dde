/** ActionQueueService 单元测试（Vitest + Injector 隔离模式）。 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Injector, runInInjectionContext, signal } from '@angular/core';
import { ActionQueueService, EnqueueParams } from './action-queue.service';
import type { PreferencePayload, QueuedAction } from './action-queue.types';
import { createMockDestroyRef } from '../test-setup.mocks';
import { mockSentryLazyLoaderService } from '../test-setup.mocks';
import { resetBrowserNetworkSuspensionTrackingForTests } from '../utils/browser-network-suspension';
import { AuthService } from './auth.service';
import { UserSessionService } from './user-session.service';
import { registerActionQueueBasicOperationSpecs } from './action-queue-basic-operations.spec-helpers';
import { registerActionQueueDependentPauseSpecs } from './action-queue-dependent-pause.spec-helpers';
import { installWindowEventBridge } from './action-queue-dom-event-bridge.spec-helpers';
import { registerActionQueueOutboxStateSpecs } from './action-queue-outbox-state.spec-helpers';
import { registerActionQueueProcessingNetworkRetrySpecs } from './action-queue-processing-network-retry.spec-helpers';
import { registerActionQueueProcessingRetrySpecs } from './action-queue-processing-retry.spec-helpers';
import { registerActionQueuePersistenceSpecs } from './action-queue-persistence.spec-helpers';
import {
  createActionQueueServiceTestInjector,
  createMockProject,
  createMockTask,
  installMockQueueBackupStrictUpdate,
  markActionQueueCurrentOwnerStorageLoadedForTests,
  mockLoggerCategory,
  mockLeaseRelease,
  mockQueueBackupService,
  mockQueueBackupState,
  mockSentryAlertService,
  mockSyncWriterLeaseService,
  mockToastService,
  registerActionQueueStorageAdmissionSpecs,
  resetActionQueueServiceMocks,
} from './action-queue-service-test-harness.spec-helpers';
describe('ActionQueueService', () => {
  let service: ActionQueueService;
  let currentUserIdSignal = signal<string | null>('test-user');
  let consoleWarnSpy: ReturnType<typeof vi.spyOn> | undefined;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn> | undefined;
  let destroyRefCleanup: (() => void) | undefined;
  let restoreWindowEvents: (() => void) | undefined;
  // 辅助函数：模拟网络状态（不触发事件）
  function setNetworkStatus(online: boolean) {
    Object.defineProperty(navigator, 'onLine', {
      value: online,
      writable: true,
      configurable: true,
    });
    // 直接修改存储服务内部状态，避免竞态条件
    service.storage.isOnline = online;
  }

  // 辅助函数：模拟网络状态变化并触发事件
  function triggerNetworkEvent(online: boolean) {
    Object.defineProperty(navigator, 'onLine', {
      value: online,
      writable: true,
      configurable: true,
    });

    if (online) {
      window.dispatchEvent(new Event('online'));
    } else {
      window.dispatchEvent(new Event('offline'));
    }
  }

  function setVisibilityState(state: 'visible' | 'hidden') {
    Object.defineProperty(document, 'visibilityState', {
      value: state,
      writable: true,
      configurable: true,
    });
  }

  // 辅助函数：创建测试操作
  function createTestProjectAction(): EnqueueParams {
    return {
      type: 'update',
      entityType: 'project',
      entityId: `proj-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      payload: {
        project: createMockProject({
          id: `proj-${Date.now()}`,
        }),
      },
    };
  }

  function createTestTaskAction(): EnqueueParams {
    return {
      type: 'update',
      entityType: 'task',
      entityId: `task-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      payload: {
        task: createMockTask({
          id: `task-${Date.now()}`,
        }),
        projectId: 'proj-1',
      },
    };
  }

  function createTestAttachmentReplayAction(): EnqueueParams {
    return {
      type: 'create',
      entityType: 'attachment',
      entityId: 'attachment-1',
      payload: {
        attachment: {
          id: 'attachment-1',
          type: 'document',
          name: 'attachment.txt',
          url: 'nanoflow-local-attachment://attachment-1',
          createdAt: '2026-06-15T01:00:00.000Z',
        },
        blobKey: 'attachment-1',
        fileName: 'attachment.txt',
        mimeType: 'text/plain',
        projectId: 'project-1',
        taskId: 'task-1',
        userId: 'test-user',
        sourceUserId: 'test-user',
      },
    };
  }
  beforeEach(async () => {
    resetBrowserNetworkSuspensionTrackingForTests();
    // 重置 localStorage
    localStorage.clear();
    vi.clearAllMocks();
    resetActionQueueServiceMocks();
    // 测试默认静默：避免业务错误分支写入 stderr。
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    
    // 设置初始网络状态为 true（在服务初始化之前）
    Object.defineProperty(navigator, 'onLine', {
      value: true,
      writable: true,
      configurable: true,
    });
    setVisibilityState('visible');

    currentUserIdSignal = signal<string | null>('test-user');

    restoreWindowEvents = installWindowEventBridge();

    const { destroyRef, destroy } = createMockDestroyRef();
    destroyRefCleanup = destroy;

    const baseInjector = createActionQueueServiceTestInjector(
      currentUserIdSignal,
      destroyRef,
    );
    const injector = Injector.create({ parent: baseInjector, providers: [
      ActionQueueService,
      { provide: AuthService, useValue: {
        currentUserId: currentUserIdSignal,
        captureAuthIdentityFence: () => `auth:${currentUserIdSignal()}`,
      } },
      { provide: UserSessionService, useValue: {
        getCurrentSessionGeneration: () => 0,
        isSessionContextCurrent: (generation: number, owner: string) =>
          generation === 0 && owner === currentUserIdSignal(),
      } },
    ] });

    runInInjectionContext(injector, () => {
      service = injector.get(ActionQueueService);
    });
    await service.reloadFromStorageForCurrentOwner();
    const clearCurrentView = service.clearCurrentView.bind(service);
    vi.spyOn(service, 'clearCurrentView').mockImplementation(() => {
      clearCurrentView();
      markActionQueueCurrentOwnerStorageLoadedForTests(service);
    });
    vi.clearAllMocks();
  });

  afterEach(() => {
    service.reset();
    destroyRefCleanup?.();
    restoreWindowEvents?.();
    resetBrowserNetworkSuspensionTrackingForTests();
    vi.useRealTimers();

    consoleWarnSpy?.mockRestore();
    consoleErrorSpy?.mockRestore();
  });

  registerActionQueueBasicOperationSpecs({
    service: () => service,
    setNetworkStatus,
    createTestProjectAction,
    createMockProject,
    mockToastService,
  });
  registerActionQueueStorageAdmissionSpecs(() => service, owner => currentUserIdSignal.set(owner));

  describe('Sentry context 边界', () => {
    it('enqueue breadcrumb 和告警日志都失败时仍保留已入队 action', () => {
      const breadcrumbError = new Error('breadcrumb failed');
      setNetworkStatus(false);
      mockSentryLazyLoaderService.addBreadcrumb.mockImplementationOnce(() => {
        throw breadcrumbError;
      });
      mockLoggerCategory.warn.mockImplementationOnce(() => {
        throw new Error('logger unavailable');
      });

      let actionId = '';
      expect(() => {
        actionId = service.enqueue(createTestProjectAction());
      }).not.toThrow();

      expect(actionId).not.toBe('');
      expect(service.queueSize()).toBe(1);
      expect(service.hasPendingActions()).toBe(true);
      expect(mockSentryLazyLoaderService.addBreadcrumb).toHaveBeenCalled();
      expect(mockLoggerCategory.warn).toHaveBeenCalledWith(
        'ActionQueue enqueue breadcrumb failed',
        breadcrumbError,
      );
    });

    it('clearQueue 应隔离 Sentry context 更新异常并保留队列状态变更', () => {
      const sentryContextError = new Error('sentry context failed');
      setNetworkStatus(false);
      service.enqueue(createTestProjectAction());
      mockSentryAlertService.updateSyncContext.mockImplementationOnce(() => {
        throw sentryContextError;
      });

      expect(() => service.clearQueue()).not.toThrow();

      expect(service.queueSize()).toBe(0);
      expect(service.hasPendingActions()).toBe(false);
      expect(mockSentryAlertService.updateSyncContext).toHaveBeenCalled();
    });
  });

  describe('discardActions 边界', () => {
    it('discardActions 在队列持久化抛错时应回滚内存视图并返回 0', () => {
      const persistError = new Error('queue persistence failed');
      setNetworkStatus(false);
      service.enqueue({
        ...createTestProjectAction(),
        entityId: 'discard-rollback-target',
      });
      service.enqueue({
        ...createTestProjectAction(),
        entityId: 'discard-rollback-keep',
      });
      const beforeIds = service.pendingActions().map(action => action.entityId);
      vi.spyOn(service.storage, 'saveQueueToStorage').mockImplementationOnce(() => {
        throw persistError;
      });

      let discarded = -1;
      expect(() => {
        discarded = service.discardActions(action => action.entityId === 'discard-rollback-target');
      }).not.toThrow();

      expect(discarded).toBe(0);
      expect(service.queueSize()).toBe(2);
      expect(service.pendingActions().map(action => action.entityId)).toEqual(beforeIds);
      expect(mockLoggerCategory.warn).toHaveBeenCalledWith(
        'ActionQueue discardActions 持久化失败，已回滚内存队列',
        expect.objectContaining({ error: persistError, discardedCount: 1 }),
      );
    });
  });

  describe('reloadFromStorageForCurrentOwner 边界', () => {
    it('主队列加载抛错时应继续尝试加载死信队列并保留已清空视图', async () => {
      const loadError = new Error('queue load failed');
      setNetworkStatus(false);
      service.enqueue(createTestProjectAction());
      const stageSpy = vi.spyOn(service.storage, 'stageCurrentOwnerStorage')
        .mockRejectedValueOnce(loadError);

      await expect(service.reloadFromStorageForCurrentOwner()).resolves.toBeUndefined();

      expect(stageSpy).toHaveBeenCalledOnce();
      expect(service.queueSize()).toBe(1);
      expect(service.hasPendingActions()).toBe(true);
      expect((service as unknown as {
        getProjectPendingWriteState?: (projectId: string, ownerUserId: string) => string;
      }).getProjectPendingWriteState?.('project-load-failed', 'test-user')).toBe('unknown');
      expect(mockLoggerCategory.warn).toHaveBeenCalledWith(
        'ActionQueue owner storage staging failed',
        expect.objectContaining({ phase: 'staging', error: loadError }),
      );
    });

    it('只有 owner 队列权威加载完成后空视图才可判定为 clear', async () => {
      const storage = service.storage as unknown as {
        loadQueueFromStorage: () => Promise<'ready' | 'failed' | 'stale'>;
      };
      vi.spyOn(storage, 'loadQueueFromStorage').mockResolvedValueOnce('ready');
      const readPendingState = () => (service as unknown as {
        getProjectPendingWriteState?: (projectId: string, ownerUserId: string) => string;
      }).getProjectPendingWriteState?.('project-empty', 'test-user');

      service.reloadFromStorageForCurrentOwner();

      expect(readPendingState()).toBe('unknown');
      await vi.waitFor(() => expect(readPendingState()).toBe('clear'));
    });
  });

  describe('自动处理异常隔离', () => {
    it('在线 enqueue 自动处理失败不应产生未处理 rejection', async () => {
      const processError = new Error('auto process failed');
      const unhandledRejection = vi.fn();
      const processQueueSpy = vi
        .spyOn(service, 'processQueue')
        .mockRejectedValueOnce(processError);
      window.addEventListener('unhandledrejection', unhandledRejection);

      setNetworkStatus(true);
      service.enqueue(createTestProjectAction());
      await Promise.resolve();
      await Promise.resolve();

      expect(processQueueSpy).toHaveBeenCalledTimes(1);
      expect(unhandledRejection).not.toHaveBeenCalled();
      expect(mockLoggerCategory.warn).toHaveBeenCalledWith(
        'ActionQueue 自动处理失败',
        processError,
      );

      window.removeEventListener('unhandledrejection', unhandledRejection);
    });
  });

  // ==================== 处理器注册和执行 ====================

  const processingRetrySpecContext = {
    service: () => service,
    setNetworkStatus,
    triggerNetworkEvent,
    setVisibilityState,
    createTestProjectAction,
    createTestTaskAction,
    setCurrentUserId: (userId: string | null) => currentUserIdSignal.set(userId),
    mockSyncWriterLeaseService,
    mockLoggerDebug: mockLoggerCategory.debug,
    mockLoggerWarn: mockLoggerCategory.warn,
    mockToastWarning: mockToastService.warning,
    mockLeaseRelease,
    mockSentryAddBreadcrumb: mockSentryLazyLoaderService.addBreadcrumb,
  };

  registerActionQueueProcessingRetrySpecs(processingRetrySpecContext);
  registerActionQueueProcessingNetworkRetrySpecs(processingRetrySpecContext);

  registerActionQueueDependentPauseSpecs({
    service: () => service,
    setNetworkStatus,
    createMockTask,
    createMockProject,
  });

  // ==================== 业务错误 vs 网络错误 ====================
  
  describe('错误类型区分', () => {
    const businessErrors = [
      'not found',
      'permission denied',
      'unauthorized',
      'forbidden',
      'row level security',
      'violates constraint',
      'duplicate key',
      'unique constraint',
      'invalid input',
    ];
    
    it.each(businessErrors)('业务错误 "%s" 应该直接移入死信队列不重试', async (errorPattern) => {
      const processor = vi.fn().mockRejectedValue(new Error(`Error: ${errorPattern}`));
      service.registerProcessor('task:create', processor);
      
      setNetworkStatus(false);
      service.enqueue({
        type: 'create',
        entityType: 'task',
        entityId: `task-${Date.now()}`,
        payload: { task: createMockTask({ id: 'task-1' }), projectId: 'proj-1' },
      });
      
      setNetworkStatus(true);
      await service.processQueue();
      
      // 业务错误应该只调用一次就进入死信队列
      expect(processor).toHaveBeenCalledTimes(1);
      expect(service.hasDeadLetters()).toBe(true);
      expect(service.queueSize()).toBe(0);
    });
  });

  // ==================== 死信队列管理 ====================
  
  describe('死信队列管理', () => {
    it('应该能够从死信队列重试操作', async () => {
      const processor = vi.fn()
        .mockRejectedValueOnce(new Error('RLS violation'))
        .mockResolvedValueOnce(true);
      
      service.registerProcessor('task:update', processor);
      
      setNetworkStatus(false);
      service.enqueue(createTestTaskAction());
      
      setNetworkStatus(true);
      await service.processQueue();
      expect(service.hasDeadLetters()).toBe(true);
      
      const deadLetters = service.deadLetterQueue();
      expect(deadLetters.length).toBe(1);
      
      // 重试操作会自动触发 processQueue，等待处理完成
      await service.retryDeadLetter(deadLetters[0].action.id);
      
      // 等待自动处理完成（使用短超时提高测试速度）
      await vi.waitFor(() => {
        expect(service.queueSize()).toBe(0);
      }, { timeout: 100, interval: 10 });
      
      expect(service.deadLetterSize()).toBe(0);
    });
    
    it('应该能够放弃死信队列中的操作', async () => {
      const processor = vi.fn().mockRejectedValue(new Error('not found'));
      service.registerProcessor('task:delete', processor);
      
      setNetworkStatus(false);
      service.enqueue({
        type: 'delete',
        entityType: 'task',
        entityId: `task-${Date.now()}`,
        payload: { taskId: 'task-1', projectId: 'proj-1' },
      });
      
      setNetworkStatus(true);
      await service.processQueue();
      
      const deadLetters = service.deadLetterQueue();
      service.dismissDeadLetter(deadLetters[0].action.id);
      
      expect(service.deadLetterSize()).toBe(0);
    });
    
    it('应该能够清空死信队列', async () => {
      const processor = vi.fn().mockRejectedValue(new Error('forbidden'));
      service.registerProcessor('project:delete', processor);
      
      setNetworkStatus(false);
      service.enqueue({
        type: 'delete',
        entityType: 'project',
        entityId: `proj-${Date.now()}`,
        payload: { projectId: 'proj-1', userId: 'user-1' },
      });
      
      setNetworkStatus(true);
      await service.processQueue();
      expect(service.hasDeadLetters()).toBe(true);
      
      service.clearDeadLetterQueue();
      
      expect(service.deadLetterSize()).toBe(0);
      expect(service.hasDeadLetters()).toBe(false);
    });
  });

  registerActionQueuePersistenceSpecs({
    service: () => service,
    setNetworkStatus,
    createTestProjectAction,
    createTestTaskAction,
    createMockTask,
    mockQueueBackupService,
    getMockQueueBackupPersistedQueue: () => mockQueueBackupState.persistedQueue,
    setMockQueueBackupPersistedQueue: queue => {
      mockQueueBackupState.persistedQueue = queue;
    },
    setMockQueueBackupRecordFound: recordFound => {
      mockQueueBackupState.recordFound = recordFound;
    },
  });

  registerActionQueueOutboxStateSpecs({
    service: () => {
      service.reloadFromStorageForCurrentOwner = () => (
        service.storage.loadQueueFromStorage().then(() => undefined)
      );
      return service;
    },
    setNetworkStatus,
    createTestTaskAction,
    createMockTask,
  });

  // ==================== 失败通知回调 ====================
  
  describe('失败通知回调', () => {
    it('应该在操作进入死信队列时触发回调', async () => {
      const callback = vi.fn();
      service.onFailure(callback);
      
      const processor = vi.fn().mockRejectedValue(new Error('violates foreign key constraint'));
      service.registerProcessor('task:create', processor);
      
      setNetworkStatus(false);
      service.enqueue({
        type: 'create',
        entityType: 'task',
        entityId: `task-${Date.now()}`,
        payload: { task: createMockTask({ id: 'task-1' }), projectId: 'proj-1' },
      });
      
      setNetworkStatus(true);
      await service.processQueue();
      
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(expect.objectContaining({
        action: expect.objectContaining({
          entityType: 'task',
        }),
        reason: expect.stringContaining('业务错误'),
      }));
    });
  });

  // ==================== 队列处理生命周期回调 ====================
  
  describe('队列处理生命周期回调', () => {
    it('处理队列时应该调用开始和结束回调', async () => {
      const onStart = vi.fn();
      const onEnd = vi.fn();
      
      service.setQueueProcessCallbacks(onStart, onEnd);
      
      const processor = vi.fn().mockResolvedValue(true);
      service.registerProcessor('project:update', processor);
      
      setNetworkStatus(false);
      service.enqueue(createTestProjectAction());
      
      setNetworkStatus(true);
      await service.processQueue();
      
      expect(onStart).toHaveBeenCalledTimes(1);
      expect(onEnd).toHaveBeenCalledTimes(1);
    });
  });

  // ==================== 实体查询 ====================
  
  describe('实体相关操作查询', () => {
    it('应该能够获取特定实体的待处理操作', () => {
      setNetworkStatus(false);
      
      service.enqueue({
        type: 'update',
        entityType: 'task',
        entityId: 'task-1',
        payload: { task: createMockTask({ id: 'task-1' }), projectId: 'proj-1' },
      });
      service.enqueue({
        type: 'update',
        entityType: 'task',
        entityId: 'task-2',
        payload: { task: createMockTask({ id: 'task-2' }), projectId: 'proj-1' },
      });
      service.enqueue({
        type: 'update',
        entityType: 'task',
        entityId: 'task-1',
        payload: { task: createMockTask({ id: 'task-1', title: 'Updated' }), projectId: 'proj-1' },
      });
      
      const actions = service.getActionsForEntity('task', 'task-1');
      
      // 由于智能合并，同一实体的多个 update 操作会合并为一个
      expect(actions).toHaveLength(1);
      expect(actions.every(a => a.entityId === 'task-1')).toBe(true);
    });

    it('应该将 connection 待处理操作纳入项目待同步查询', () => {
      setNetworkStatus(false);
      service.enqueue({
        type: 'update',
        entityType: 'connection',
        entityId: 'connection-project-pending',
        payload: {
          connection: { id: 'connection-project-pending', source: 'task-a', target: 'task-b' },
          projectId: 'project-pending',
        },
      });

      expect(service.getPendingActionsForProject('project-pending').map(action => action.entityId))
        .toEqual(['connection-project-pending']);
    });

    it('连续 preference:update 应字段级合并，避免后续偏好覆盖前一字段', async () => {
      setNetworkStatus(false);

      const firstId = await service.enqueueDurably({
        type: 'update',
        entityType: 'preference',
        entityId: 'test-user',
        payload: {
          userId: 'test-user',
          sourceUserId: 'test-user',
          preferences: { theme: 'default' },
        },
      });
      const secondId = await service.enqueueDurably({
        type: 'update',
        entityType: 'preference',
        entityId: 'test-user',
        payload: {
          userId: 'test-user',
          sourceUserId: 'test-user',
          preferences: { localBackupEnabled: true },
        },
      });

      expect(secondId).toBe(firstId);
      expect(service.pendingActions()).toHaveLength(1);
      expect((service.pendingActions()[0].payload as PreferencePayload).preferences).toEqual({
        theme: 'default',
        localBackupEnabled: true,
      });
    });
  });

  describe('attachment replay exact settlement', () => {
    it.each([
      ['current result', false],
      ['stale result', true],
    ])('bypasses generic syncing and action-ID dequeue for a %s', async (_label, makeStale) => {
      const markSyncing = vi.spyOn(service.storage, 'markActionSyncState');
      const strictUpdate = installMockQueueBackupStrictUpdate();
      service.registerProcessor('attachment:create', async action => {
        const settled = await service.settleAttachmentReplayActionForOwner(
          'test-user',
          {
            mode: 'remove-attachment-create',
            actionId: action.id,
            operationId: action.operationId,
            entityType: 'attachment',
            type: 'create',
            entityId: action.entityId,
            payload: action.payload,
            signal: new AbortController().signal,
            isCurrent: () => true,
          },
        );
        expect(settled).toEqual({ status: 'committed' });
        if (makeStale) service.clearCurrentView();
        return true;
      });
      setNetworkStatus(false);
      service.enqueue(createTestAttachmentReplayAction());
      mockQueueBackupState.persistedQueue = [...service.pendingActions()];
      mockQueueBackupState.recordFound = true;

      setNetworkStatus(true);
      await service.processQueue();

      expect(markSyncing).not.toHaveBeenCalled();
      expect(strictUpdate).toHaveBeenCalledOnce();
      expect(mockQueueBackupService.updateQueue).not.toHaveBeenCalled();
      expect(service.queueSize()).toBe(0);
    });
  });

  // ==================== 并发处理保护 ====================
  
  describe('并发处理保护', () => {
    it('persists syncing before RPC and preserves a preference update enqueued during replay', async () => {
      const strictUpdate = installMockQueueBackupStrictUpdate();
      const leaseController = new AbortController();
      mockSyncWriterLeaseService.isFeatureEnabled.mockReturnValue(true);
      mockSyncWriterLeaseService.requestLease.mockImplementation(async () => ({
        tabId: 'tab-preference-replay',
        lockName: 'nanoflow-sync:test:test-user:__global__',
        mode: 'idb-lease' as const,
        signal: leaseController.signal,
        release: mockLeaseRelease,
      }));
      setNetworkStatus(false);
      const actionId = await service.enqueueDurably({
        operationId: '10000000-0000-4000-8000-000000000101',
        type: 'update', entityType: 'preference', entityId: 'test-user',
        payload: { sourceUserId: 'test-user', userId: 'test-user', preferences: { theme: 'default' } },
      });
      mockSyncWriterLeaseService.requestLease.mockClear();
      mockQueueBackupService.backupQueue.mockResolvedValueOnce(false);
      service.registerProcessor('preference:update', async action => {
        expect(mockQueueBackupState.persistedQueue.find(current => current.id === actionId)?.syncState)
          .toBe('syncing');
        setNetworkStatus(false);
        await service.enqueueDurably({
          operationId: '10000000-0000-4000-8000-000000000102',
          type: 'update', entityType: 'preference', entityId: 'test-user',
          payload: { sourceUserId: 'test-user', userId: 'test-user', preferences: { theme: 'ocean' } },
        });
        setNetworkStatus(true);
        return true;
      });

      setNetworkStatus(true);
      await service.processQueue();

      expect(strictUpdate).toHaveBeenCalled();
      expect(mockSyncWriterLeaseService.requestLease).toHaveBeenCalledOnce();
      expect(service.pendingActions()).toEqual([
        expect.objectContaining({
          operationId: '10000000-0000-4000-8000-000000000102',
          payload: expect.objectContaining({ preferences: { theme: 'ocean' } }),
        }),
      ]);
    });

    it('正在处理时不应该重复处理', async () => {
      await vi.waitFor(() => {
        expect(service.getCurrentOwnerStorageLoadState()).toBe('loaded');
      });
      vi.useFakeTimers();

      const processor = vi.fn().mockImplementation(async () => {
        await new Promise(r => setTimeout(r, 100));
        return true;
      });
      
      service.registerProcessor('project:update', processor);
      
      setNetworkStatus(false);
      service.enqueue(createTestProjectAction());
      
      setNetworkStatus(true);
      
      const promise1 = service.processQueue();
      const promise2 = service.processQueue();

      await vi.waitFor(() => {
        expect(processor).toHaveBeenCalledTimes(1);
      });
      await vi.advanceTimersByTimeAsync(100);
      
      await Promise.all([promise1, promise2]);
      
      expect(processor).toHaveBeenCalledTimes(1);
    });

    it('处理进行中新增 action 时应在当前批次结束后自动续跑', async () => {
      vi.useFakeTimers();

      const processor = vi.fn().mockImplementation(async () => {
        if (processor.mock.calls.length === 1) {
          service.enqueue(createTestProjectAction());
        }
        await new Promise(r => setTimeout(r, 100));
        return true;
      });

      service.registerProcessor('project:update', processor);

      setNetworkStatus(false);
      service.enqueue(createTestProjectAction());

      setNetworkStatus(true);

      const processing = service.processQueue();

      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(100);
      await processing;

      expect(processor).toHaveBeenCalledTimes(2);
      expect(service.queueSize()).toBe(0);
    });
  });

});
