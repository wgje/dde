import type { DestroyRef } from '@angular/core';
import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SimpleSyncRuntimeController,
  type SimpleSyncRuntimeControllerDeps,
} from './simple-sync-runtime.controller';
import { FEATURE_FLAGS } from '../../../config/feature-flags.config';

describe('SimpleSyncRuntimeController', () => {
  let controller: SimpleSyncRuntimeController;
  let deps: SimpleSyncRuntimeControllerDeps;
  const originalLifecycleRecovery = FEATURE_FLAGS.LIFECYCLE_RECOVERY_V1;

  const flushMicrotasks = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
  };

  const createDeps = (): SimpleSyncRuntimeControllerDeps => ({
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    },
    eventBus: {
      onSessionRestored$: new Subject<void>(),
    },
    destroyRef: {
      onDestroy: vi.fn(),
    } as unknown as DestroyRef,
    supabase: {
      isConfigured: false,
      isOfflineMode: vi.fn().mockReturnValue(false),
      onConnectivityChange: vi.fn().mockReturnValue(vi.fn()),
    },
    realtimePollingService: {
      initializeRuntime: vi.fn(),
      teardownRuntime: vi.fn(),
      suspendTransport: vi.fn().mockResolvedValue(undefined),
      resetRealtimeCircuit: vi.fn().mockResolvedValue(undefined),
    },
    retryQueueService: {
      length: 0,
      add: vi.fn().mockReturnValue(true),
      startLoop: vi.fn(),
      stopLoop: vi.fn(),
      setOperationHandler: vi.fn(),
      hasSuccessfulDrainFlag: vi.fn().mockReturnValue(false),
      clearSuccessfulDrainFlag: vi.fn(),
    },
    syncStateService: {
      setOnline: vi.fn(),
      setOfflineMode: vi.fn(),
      registerIdleChecker: vi.fn(),
      registerSyncErrorListener: vi.fn(),
      update: vi.fn(),
    },
    connectivityRecovery: {
      startRuntime: vi.fn(),
      stopRuntime: vi.fn(),
      cancelScheduledRecovery: vi.fn(),
      scheduleConnectivityRecovery: vi.fn(),
      restoreRemoteConnectivity: vi.fn().mockResolvedValue(undefined),
      handleSupabaseConnectivityChange: vi.fn(),
    },
    blackBoxSync: {
      setRetryQueueHandler: vi.fn(),
      markEntrySyncConflict: vi.fn().mockResolvedValue(undefined),
      pushToServer: vi.fn().mockResolvedValue(true),
    },
    getActionQueue: vi.fn().mockReturnValue(null),
    syncState: vi.fn().mockReturnValue({ isOnline: true, sessionExpired: false }),
    state: vi.fn().mockReturnValue({ isOnline: true, sessionExpired: false }),
    pushTask: vi.fn().mockResolvedValue(true),
    deleteTask: vi.fn().mockResolvedValue(true),
    pushConnection: vi.fn().mockResolvedValue(true),
    addToRetryQueueDurably: vi.fn().mockResolvedValue(true),
    markSyncRecoveredIfIdle: vi.fn().mockReturnValue(true),
    resetSessionExpired: vi.fn(),
  } as unknown as SimpleSyncRuntimeControllerDeps);

  beforeEach(() => {
    deps = createDeps();
    controller = new SimpleSyncRuntimeController(deps);
  });

  afterEach(() => {
    controller.stopRuntime();
    (FEATURE_FLAGS as unknown as Record<string, boolean>).LIFECYCLE_RECOVERY_V1 = originalLifecycleRecovery;
    vi.clearAllMocks();
  });

  it('online 事件触发的恢复拒绝时应隔离并记录', async () => {
    (FEATURE_FLAGS as unknown as Record<string, boolean>).LIFECYCLE_RECOVERY_V1 = false;
    controller.startRuntime();
    const restoreError = new Error('restore failed');
    vi.mocked(deps.connectivityRecovery.restoreRemoteConnectivity).mockRejectedValueOnce(restoreError);

    window.dispatchEvent(new Event('online'));
    await flushMicrotasks();

    expect(deps.logger.warn).toHaveBeenCalledWith(
      '网络恢复后的远端连接恢复失败',
      expect.objectContaining({ reason: 'online-event', error: restoreError }),
    );
  });

  it('lifecycle recovery 接管 online 恢复时 runtime 不应重复触发远端连接恢复', async () => {
    (FEATURE_FLAGS as unknown as Record<string, boolean>).LIFECYCLE_RECOVERY_V1 = true;
    controller.startRuntime();

    window.dispatchEvent(new Event('online'));
    await flushMicrotasks();

    expect(deps.syncStateService.setOnline).toHaveBeenCalledWith(true);
    expect(deps.connectivityRecovery.restoreRemoteConnectivity).not.toHaveBeenCalled();
  });

  it('在线启动时也应调度一次连接恢复以回放崩溃前留下的本地 outbox', () => {
    Object.defineProperty(deps.supabase, 'isConfigured', {
      value: true,
      configurable: true,
    });
    vi.mocked(deps.supabase.isOfflineMode).mockReturnValue(false);

    controller.startRuntime();

    expect(deps.connectivityRecovery.scheduleConnectivityRecovery).toHaveBeenCalledWith(
      'runtime-start-online',
      0,
    );
  });

  it('offline 事件触发的传输挂起拒绝时应隔离并记录', async () => {
    controller.startRuntime();
    const suspendError = new Error('suspend failed');
    vi.mocked(deps.realtimePollingService.suspendTransport).mockRejectedValueOnce(suspendError);

    window.dispatchEvent(new Event('offline'));
    await flushMicrotasks();

    expect(deps.logger.warn).toHaveBeenCalledWith(
      '网络断开后的 Realtime 传输挂起失败',
      expect.objectContaining({ reason: 'offline-event', error: suspendError }),
    );
  });

  it('offline 事件应作废已排队或在途的连接恢复', async () => {
    controller.startRuntime();

    window.dispatchEvent(new Event('offline'));
    await flushMicrotasks();

    expect(deps.connectivityRecovery.cancelScheduledRecovery).toHaveBeenCalledTimes(1);
  });

  it('stopRuntime 后迟到的 Supabase connectivity 回调不应再改写同步状态或恢复链', () => {
    type ConnectivityCallback = (change: { offline: boolean; source: 'request' | 'realtime' }) => void;
    let connectivityCallback: ConnectivityCallback | null = null;
    vi.mocked(deps.supabase.onConnectivityChange).mockImplementationOnce((callback) => {
      connectivityCallback = callback as ConnectivityCallback;
      return vi.fn();
    });

    controller.setupLifecycleListeners(vi.fn());
    controller.startRuntime();
    controller.stopRuntime();

    expect(connectivityCallback).not.toBeNull();
    connectivityCallback!({ offline: false, source: 'request' });

    expect(deps.syncStateService.setOfflineMode).not.toHaveBeenCalledWith(false);
    expect(deps.connectivityRecovery.handleSupabaseConnectivityChange).not.toHaveBeenCalled();
  });

  it('stopRuntime 后迟到的 session restored 事件不应触发会话重置或 realtime 熔断恢复', () => {
    const sessionRestored$ = deps.eventBus.onSessionRestored$ as unknown as Subject<void>;

    controller.setupSyncStateListeners();
    controller.startRuntime();
    controller.stopRuntime();

    sessionRestored$.next();

    expect(deps.resetSessionExpired).not.toHaveBeenCalled();
    expect(deps.realtimePollingService.resetRealtimeCircuit).not.toHaveBeenCalled();
  });

  it('setupSyncStateListeners 重复调用不应叠加 session restored 监听或状态回调', () => {
    const sessionRestored$ = deps.eventBus.onSessionRestored$ as unknown as Subject<void>;

    controller.setupSyncStateListeners();
    controller.setupSyncStateListeners();
    controller.startRuntime();

    sessionRestored$.next();

    expect(deps.syncStateService.registerIdleChecker).toHaveBeenCalledTimes(1);
    expect(deps.syncStateService.registerSyncErrorListener).toHaveBeenCalledTimes(1);
    expect(deps.resetSessionExpired).toHaveBeenCalledTimes(1);
    expect(deps.realtimePollingService.resetRealtimeCircuit).toHaveBeenCalledTimes(1);
  });

  it('stopRuntime 清理网络监听失败时仍应停止重试循环和 realtime runtime', () => {
    const cleanupError = new Error('remove listener failed');
    const originalRemoveEventListener = window.removeEventListener.bind(window);
    vi.spyOn(window, 'removeEventListener').mockImplementationOnce((...args: Parameters<typeof window.removeEventListener>) => {
      originalRemoveEventListener(...args);
      throw cleanupError;
    });

    controller.startRuntime();

    expect(() => controller.stopRuntime()).not.toThrow();

    expect(deps.connectivityRecovery.stopRuntime).toHaveBeenCalledTimes(1);
    expect(deps.retryQueueService.stopLoop).toHaveBeenCalledTimes(1);
    expect(deps.realtimePollingService.teardownRuntime).toHaveBeenCalledTimes(1);
    expect(deps.logger.warn).toHaveBeenCalledWith(
      '同步运行时网络监听清理失败，已继续停止其他运行时资源',
      cleanupError,
    );

    vi.mocked(deps.syncStateService.setOnline).mockClear();
    vi.mocked(deps.connectivityRecovery.cancelScheduledRecovery).mockClear();
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new Event('offline'));

    expect(deps.syncStateService.setOnline).not.toHaveBeenCalledWith(true);
    expect(deps.syncStateService.setOnline).not.toHaveBeenCalledWith(false);
    expect(deps.connectivityRecovery.cancelScheduledRecovery).not.toHaveBeenCalled();
    expect(deps.connectivityRecovery.restoreRemoteConnectivity).not.toHaveBeenCalled();
  });

  it('rolls back partial runtime startup after initialization fails so startup can be retried', () => {
    const startupError = new Error('realtime runtime failed');
    vi.mocked(deps.realtimePollingService.initializeRuntime)
      .mockImplementationOnce(() => {
        throw startupError;
      });

    expect(() => controller.startRuntime()).toThrow(startupError);
    controller.startRuntime();

    expect(deps.connectivityRecovery.startRuntime).toHaveBeenCalledTimes(2);
    expect(deps.connectivityRecovery.stopRuntime).toHaveBeenCalledTimes(1);
    expect(deps.realtimePollingService.initializeRuntime).toHaveBeenCalledTimes(2);
    expect(deps.retryQueueService.startLoop).toHaveBeenCalledTimes(1);
  });

  it('rolls back partially attached network listeners when runtime startup fails during listener setup', () => {
    const startupError = new Error('offline listener unavailable');
    const originalAddEventListener = window.addEventListener.bind(window);
    const originalRemoveEventListener = window.removeEventListener.bind(window);
    vi.spyOn(window, 'addEventListener')
      .mockImplementationOnce((...args: Parameters<typeof window.addEventListener>) => {
        originalAddEventListener(...args);
      })
      .mockImplementationOnce(() => {
        throw startupError;
      });
    vi.spyOn(window, 'removeEventListener').mockImplementation((...args: Parameters<typeof window.removeEventListener>) => {
      originalRemoveEventListener(...args);
    });

    expect(() => controller.startRuntime()).toThrow(startupError);

    expect(deps.connectivityRecovery.stopRuntime).toHaveBeenCalledTimes(1);
    expect(deps.realtimePollingService.teardownRuntime).toHaveBeenCalledTimes(1);

    vi.mocked(deps.syncStateService.setOnline).mockClear();
    vi.mocked(deps.connectivityRecovery.restoreRemoteConnectivity).mockClear();
    window.dispatchEvent(new Event('online'));

    expect(deps.syncStateService.setOnline).not.toHaveBeenCalledWith(true);
    expect(deps.connectivityRecovery.restoreRemoteConnectivity).not.toHaveBeenCalled();

    controller.startRuntime();

    expect(deps.retryQueueService.startLoop).toHaveBeenCalledTimes(1);
  });

  it('connection retry handler should require sync RPC to preserve operationId idempotency', async () => {
    controller.setupRetryQueueHandler();
    const handler = vi.mocked(deps.retryQueueService.setOperationHandler).mock.calls[0]?.[0] as
      | {
          pushConnection: (
            connection: { id: string; source: string; target: string },
            projectId: string,
            sourceUserId?: string,
            operationId?: string,
          ) => Promise<boolean>;
        }
      | undefined;
    const connection = {
      id: 'connection-retry-requires-sync-rpc',
      source: 'task-a',
      target: 'task-b',
    };
    const operationId = '00000000-0000-4000-8000-000000000303';

    expect(handler).toBeDefined();
    await handler!.pushConnection(connection, 'project-1', 'user-1', operationId);

    expect(deps.pushConnection).toHaveBeenCalledWith(
      connection,
      'project-1',
      false,
      false,
      true,
      'user-1',
      operationId,
      true,
    );
  });

  it('blackbox retry handler should persist through the durable retry facade before acknowledging', async () => {
    controller.setupBlackBoxRetryHandler();
    const handler = vi.mocked(deps.blackBoxSync.setRetryQueueHandler).mock.calls[0]?.[0] as
      | ((entry: {
          id: string;
          projectId?: string | null;
          userId?: string | null;
          content: string;
          updatedAt: string;
          syncStatus: 'pending';
        }) => Promise<boolean>)
      | undefined;
    const entry = {
      id: 'blackbox-durable-entry',
      projectId: 'project-1',
      userId: 'user-1',
      content: 'pending thought',
      updatedAt: '2026-06-27T00:00:00.000Z',
      syncStatus: 'pending' as const,
    };

    expect(handler).toBeDefined();
    const result = await handler!(entry);
    expect(result).toBe(true);

    expect(deps.addToRetryQueueDurably).toHaveBeenCalledWith(
      'blackbox',
      'upsert',
      entry,
      'project-1',
      'user-1',
    );
    expect(deps.retryQueueService.add).not.toHaveBeenCalled();
  });
});
