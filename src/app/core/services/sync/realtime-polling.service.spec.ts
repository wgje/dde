import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  Injector,
  runInInjectionContext,
  DestroyRef,
  signal,
  ɵChangeDetectionScheduler as ChangeDetectionScheduler,
  ɵEffectScheduler as EffectScheduler,
} from '@angular/core';
import { RealtimePollingService } from './realtime-polling.service';
import { SupabaseClientService } from '../../../../services/supabase-client.service';
import { LoggerService } from '../../../../services/logger.service';
import { ToastService } from '../../../../services/toast.service';
import { MobileSyncStrategyService } from '../../../../services/mobile-sync-strategy.service';
import { SyncStateService } from './sync-state.service';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import { resetBrowserNetworkSuspensionTrackingForTests } from '../../../../utils/browser-network-suspension';

const REALTIME_CIRCUIT_STORAGE_KEY = 'nanoflow.realtime-transport-circuit';
const strategySignal = signal({ enableRealtime: true } as { enableRealtime: boolean });

const mockChannel = {
  on: vi.fn().mockReturnThis(),
  subscribe: vi.fn().mockReturnThis(),
};

const mockClient = {
  channel: vi.fn(() => mockChannel),
  removeChannel: vi.fn().mockResolvedValue(undefined),
};

const mockSupabase = {
  isConfigured: true,
  client: vi.fn(() => mockClient),
};

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
};

const mockLoggerService = {
  category: vi.fn(() => mockLogger),
};

const mockToastService = {
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
};

const mockMobileSyncStrategy = {
  currentStrategy: strategySignal,
};

const mockSyncStateService = {
  syncState: signal({ isOnline: true, offlineMode: false }),
  setSyncError: vi.fn(),
};

const mockSentryLazyLoaderService = {
  captureMessage: vi.fn(),
};

const mockChangeDetectionScheduler: ChangeDetectionScheduler = {
  notify: vi.fn(),
  runningTick: false,
};

const mockEffectScheduler: EffectScheduler = {
  schedule: (effect: { run: () => void }) => {
    queueMicrotask(() => effect.run());
  },
  flush: vi.fn(),
  remove: vi.fn(),
};

const destroyCallbacks: Array<() => void> = [];
const mockDestroyRef: Pick<DestroyRef, 'onDestroy'> = {
  onDestroy: (callback: () => void) => {
    destroyCallbacks.push(callback);
    return () => {};
  },
};

function setVisibilityState(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: state,
  });
}

describe('RealtimePollingService', () => {
  let service: RealtimePollingService;
  let injector: Injector;

  beforeEach(() => {
    vi.clearAllMocks();
    destroyCallbacks.length = 0;
    sessionStorage.clear();
    strategySignal.set({ enableRealtime: true });
    setVisibilityState('visible');

    injector = Injector.create({
      providers: [
        { provide: SupabaseClientService, useValue: mockSupabase },
        { provide: LoggerService, useValue: mockLoggerService },
        { provide: ToastService, useValue: mockToastService },
        { provide: MobileSyncStrategyService, useValue: mockMobileSyncStrategy },
        { provide: SyncStateService, useValue: mockSyncStateService },
        { provide: SentryLazyLoaderService, useValue: mockSentryLazyLoaderService },
        { provide: ChangeDetectionScheduler, useValue: mockChangeDetectionScheduler },
        { provide: EffectScheduler, useValue: mockEffectScheduler },
        { provide: DestroyRef, useValue: mockDestroyRef },
      ],
    });

    service = runInInjectionContext(injector, () => new RealtimePollingService());
  });

  afterEach(() => {
    resetBrowserNetworkSuspensionTrackingForTests();
    setVisibilityState('visible');
  });

  it('应跟随移动端同步策略切换 Realtime 开关', async () => {
    expect(service.isRealtimeEnabled()).toBe(true);

    strategySignal.set({ enableRealtime: false });
    await vi.waitFor(() => {
      expect(service.isRealtimeEnabled()).toBe(false);
    });

    strategySignal.set({ enableRealtime: true });
    await vi.waitFor(() => {
      expect(service.isRealtimeEnabled()).toBe(true);
    });
  });

  it('策略变化时应重新配置当前项目的传输方式', async () => {
    const startPollingSpy = vi.spyOn(
      service as unknown as { startPolling: (projectId: string, userId: string | null, transportGeneration: number) => void },
      'startPolling'
    );

    await service.subscribeToProject('project-1', 'user-123');
    expect(service.getCurrentProjectId()).toBe('project-1');

    strategySignal.set({ enableRealtime: false });

    await vi.waitFor(() => {
      expect(service.isRealtimeEnabled()).toBe(false);
      expect(mockClient.removeChannel).toHaveBeenCalled();
      expect(startPollingSpy).toHaveBeenCalled();
      expect(service.getCurrentProjectId()).toBe('project-1');
    });
  });

  it('传输切换期间若旧订阅已 teardown，不应重新挂回旧项目', async () => {
    const startPollingSpy = vi.spyOn(
      service as unknown as { startPolling: (projectId: string, userId: string | null, transportGeneration: number) => void },
      'startPolling'
    );

    await service.subscribeToProject('project-1', 'user-123');

    let resolveRemoveChannel: (() => void) | null = null;
    mockClient.removeChannel.mockImplementationOnce(() => new Promise<void>(resolve => {
      resolveRemoveChannel = resolve;
    }));

    service.setRealtimeEnabled(false);
    await Promise.resolve();

    await service.unsubscribeFromProject();
    resolveRemoveChannel!();
    await Promise.resolve();
    await Promise.resolve();

    expect(startPollingSpy).not.toHaveBeenCalled();
    expect(service.getCurrentProjectId()).toBeNull();
  });

  it('挂起传输后应保留项目上下文，并在恢复时重新激活', async () => {
    await service.subscribeToProject('project-1', 'user-123');
    expect(service.getCurrentProjectId()).toBe('project-1');
    expect(mockClient.channel).toHaveBeenCalledTimes(1);

    await service.suspendTransport();
    expect(mockClient.removeChannel).toHaveBeenCalledTimes(1);
    expect(service.getCurrentProjectId()).toBe('project-1');

    await service.resumeTransport();
    expect(mockClient.channel).toHaveBeenCalledTimes(2);
    expect(service.getCurrentProjectId()).toBe('project-1');
  });

  it('离线态订阅后恢复时应自动重新激活传输', async () => {
    mockSyncStateService.syncState.set({ isOnline: true, offlineMode: true });

    await service.subscribeToProject('project-2', 'user-456');

    expect(service.getCurrentProjectId()).toBe('project-2');
    expect(mockClient.channel).not.toHaveBeenCalled();

    mockSyncStateService.syncState.set({ isOnline: true, offlineMode: false });
    await service.resumeTransport();

    expect(mockClient.channel).toHaveBeenCalledTimes(1);
    expect(service.getCurrentProjectId()).toBe('project-2');
  });

  it('挂起窗口内的 Realtime 通道错误不应上报 Sentry', async () => {
    await service.subscribeToProject('project-3', 'user-789');
    const statusCallback = mockChannel.subscribe.mock.calls.at(-1)?.[0] as
      | ((status: string, err?: { message?: string }) => void)
      | undefined;

    expect(statusCallback).toBeTypeOf('function');

    setVisibilityState('hidden');
    statusCallback?.('CHANNEL_ERROR', { message: 'network suspended' });

    expect(mockSentryLazyLoaderService.captureMessage).not.toHaveBeenCalled();
  });

  it('应仅在连续失败达到阈值后上报 Sentry 并降级到轮询', async () => {
    const fallbackSpy = vi.spyOn(
      service as unknown as { fallbackToPolling: (projectId: string, userId: string, transportGeneration: number) => void },
      'fallbackToPolling'
    );

    await service.subscribeToProject('project-4', 'user-321');
    const statusCallback = mockChannel.subscribe.mock.calls.at(-1)?.[0] as
      | ((status: string, err?: { message?: string }) => void)
      | undefined;

    statusCallback?.('CHANNEL_ERROR', { message: 'first transient failure' });
    statusCallback?.('TIMED_OUT', { message: 'second transient failure' });

    expect(mockSentryLazyLoaderService.captureMessage).not.toHaveBeenCalled();

    statusCallback?.('CHANNEL_ERROR', { message: 'third failure' });

    expect(mockSentryLazyLoaderService.captureMessage).toHaveBeenCalledTimes(1);
    expect(mockSentryLazyLoaderService.captureMessage).toHaveBeenCalledWith(
      'Realtime 订阅错误',
      expect.objectContaining({
        extra: expect.objectContaining({
          consecutiveErrors: 3,
          degradedToPolling: true,
        })
      })
    );
    expect(fallbackSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(sessionStorage.getItem(REALTIME_CIRCUIT_STORAGE_KEY) ?? '{}')).toEqual(
      expect.objectContaining({
        failures: 3,
        lastError: 'third failure',
      })
    );
  });

  it('SUBSCRIBED 应重置连续失败计数', async () => {
    const fallbackSpy = vi.spyOn(
      service as unknown as { fallbackToPolling: (projectId: string, userId: string, transportGeneration: number) => void },
      'fallbackToPolling'
    );

    await service.subscribeToProject('project-5', 'user-654');
    const statusCallback = mockChannel.subscribe.mock.calls.at(-1)?.[0] as
      | ((status: string, err?: { message?: string }) => void)
      | undefined;

    statusCallback?.('CHANNEL_ERROR', { message: 'first failure' });
    statusCallback?.('SUBSCRIBED');
    statusCallback?.('CHANNEL_ERROR', { message: 'second first failure' });
    statusCallback?.('CHANNEL_ERROR', { message: 'second second failure' });

    expect(mockSentryLazyLoaderService.captureMessage).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
  });

  it('Realtime 禁用时的通道错误不应上报或降级', async () => {
    await service.subscribeToProject('project-6', 'user-987');
    const fallbackSpy = vi.spyOn(
      service as unknown as { fallbackToPolling: (projectId: string, userId: string, transportGeneration: number) => void },
      'fallbackToPolling'
    );
    const statusCallback = mockChannel.subscribe.mock.calls.at(-1)?.[0] as
      | ((status: string, err?: { message?: string }) => void)
      | undefined;

    service.setRealtimeEnabled(false);
    statusCallback?.('CHANNEL_ERROR', { message: 'teardown failure' });

    expect(mockSentryLazyLoaderService.captureMessage).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
  });

  it('降级后的冷却期内重新订阅应继续使用轮询', async () => {
    const startPollingSpy = vi.spyOn(
      service as unknown as { startPolling: (projectId: string, userId: string | null, transportGeneration: number) => void },
      'startPolling'
    );

    await service.subscribeToProject('project-7', 'user-741');
    const statusCallback = mockChannel.subscribe.mock.calls.at(-1)?.[0] as
      | ((status: string, err?: { message?: string }) => void)
      | undefined;

    statusCallback?.('CHANNEL_ERROR', { message: 'failure 1' });
    statusCallback?.('CHANNEL_ERROR', { message: 'failure 2' });
    statusCallback?.('CHANNEL_ERROR', { message: 'failure 3' });

    expect(mockClient.channel).toHaveBeenCalledTimes(1);

    await service.subscribeToProject('project-7', 'user-741');

    expect(mockClient.channel).toHaveBeenCalledTimes(1);
    expect(startPollingSpy).toHaveBeenCalled();
  });

  it('旧通道迟到的 SUBSCRIBED 不应清掉降级冷却期', async () => {
    const startPollingSpy = vi.spyOn(
      service as unknown as { startPolling: (projectId: string, userId: string | null, transportGeneration: number) => void },
      'startPolling'
    );

    await service.subscribeToProject('project-8', 'user-852');
    const statusCallback = mockChannel.subscribe.mock.calls.at(-1)?.[0] as
      | ((status: string, err?: { message?: string }) => void)
      | undefined;

    statusCallback?.('CHANNEL_ERROR', { message: 'failure 1' });
    statusCallback?.('CHANNEL_ERROR', { message: 'failure 2' });
    statusCallback?.('CHANNEL_ERROR', { message: 'failure 3' });
    statusCallback?.('SUBSCRIBED');

    await service.subscribeToProject('project-8', 'user-852');

    expect(mockClient.channel).toHaveBeenCalledTimes(1);
    expect(startPollingSpy).toHaveBeenCalled();
  });

  it('会在熔断窗口内直接跳过 Realtime 尝试', async () => {
    sessionStorage.setItem(REALTIME_CIRCUIT_STORAGE_KEY, JSON.stringify({
      until: Date.now() + 60_000,
      ownerUserId: 'user-111',
      failures: 3,
      lastError: 'websocket blocked',
      lastToastAt: 0,
    }));

    service = runInInjectionContext(injector, () => new RealtimePollingService());
    const startPollingSpy = vi.spyOn(
      service as unknown as { startPolling: (projectId: string, userId: string | null, transportGeneration: number) => void },
      'startPolling'
    );

    await service.subscribeToProject('project-9', 'user-111');

    expect(mockClient.channel).not.toHaveBeenCalled();
    expect(startPollingSpy).toHaveBeenCalled();
  });

  it('不同 userId 订阅时应清理旧会话的 Realtime 熔断状态', async () => {
    sessionStorage.setItem(REALTIME_CIRCUIT_STORAGE_KEY, JSON.stringify({
      until: Date.now() + 60_000,
      ownerUserId: 'user-old',
      failures: 3,
      lastError: 'stale token',
      lastToastAt: 0,
    }));

    service = runInInjectionContext(injector, () => new RealtimePollingService());

    await service.subscribeToProject('project-11', 'user-new');

    expect(mockClient.channel).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(REALTIME_CIRCUIT_STORAGE_KEY)).toBeNull();
  });

  it('SUBSCRIBED 后应清理会话级 Realtime 熔断状态', async () => {
    await service.subscribeToProject('project-10', 'user-222');
    const statusCallback = mockChannel.subscribe.mock.calls.at(-1)?.[0] as
      | ((status: string, err?: { message?: string }) => void)
      | undefined;

    sessionStorage.setItem(REALTIME_CIRCUIT_STORAGE_KEY, JSON.stringify({
      until: Date.now() + 60_000,
      ownerUserId: 'user-222',
      failures: 3,
      lastError: 'websocket blocked',
      lastToastAt: 0,
    }));

    (service as unknown as { loadRealtimeCircuitState: () => void }).loadRealtimeCircuitState();
    statusCallback?.('SUBSCRIBED');

    expect(sessionStorage.getItem(REALTIME_CIRCUIT_STORAGE_KEY)).toBeNull();
  });

  it('轮询模式在熔断窗口结束后应主动尝试恢复 Realtime', async () => {
    (service as unknown as {
      currentProjectId: string | null;
      currentUserId: string | null;
      transportGeneration: number;
      realtimeCircuitUntil: number;
      realtimeCircuitOwnerUserId: string | null;
      realtimeCircuitFailures: number;
      realtimeCircuitLastError: string | null;
      realtimeChannel: unknown;
      maybeReenterRealtimeFromPolling: (projectId: string, userId: string | null, transportGeneration: number) => Promise<boolean>;
    }).currentProjectId = 'project-12';
    (service as unknown as {
      currentProjectId: string | null;
      currentUserId: string | null;
      transportGeneration: number;
      realtimeCircuitUntil: number;
      realtimeCircuitOwnerUserId: string | null;
      realtimeCircuitFailures: number;
      realtimeCircuitLastError: string | null;
      realtimeChannel: unknown;
      maybeReenterRealtimeFromPolling: (projectId: string, userId: string | null, transportGeneration: number) => Promise<boolean>;
    }).currentUserId = 'user-333';
    (service as unknown as {
      currentProjectId: string | null;
      currentUserId: string | null;
      transportGeneration: number;
      realtimeCircuitUntil: number;
      realtimeCircuitOwnerUserId: string | null;
      realtimeCircuitFailures: number;
      realtimeCircuitLastError: string | null;
      realtimeChannel: unknown;
      maybeReenterRealtimeFromPolling: (projectId: string, userId: string | null, transportGeneration: number) => Promise<boolean>;
    }).transportGeneration = 1;
    (service as unknown as {
      currentProjectId: string | null;
      currentUserId: string | null;
      transportGeneration: number;
      realtimeCircuitUntil: number;
      realtimeCircuitOwnerUserId: string | null;
      realtimeCircuitFailures: number;
      realtimeCircuitLastError: string | null;
      realtimeChannel: unknown;
      maybeReenterRealtimeFromPolling: (projectId: string, userId: string | null, transportGeneration: number) => Promise<boolean>;
    }).realtimeCircuitUntil = Date.now() - 1;
    (service as unknown as {
      currentProjectId: string | null;
      currentUserId: string | null;
      transportGeneration: number;
      realtimeCircuitUntil: number;
      realtimeCircuitOwnerUserId: string | null;
      realtimeCircuitFailures: number;
      realtimeCircuitLastError: string | null;
      realtimeChannel: unknown;
      maybeReenterRealtimeFromPolling: (projectId: string, userId: string | null, transportGeneration: number) => Promise<boolean>;
    }).realtimeCircuitOwnerUserId = 'user-333';
    (service as unknown as {
      currentProjectId: string | null;
      currentUserId: string | null;
      transportGeneration: number;
      realtimeCircuitUntil: number;
      realtimeCircuitOwnerUserId: string | null;
      realtimeCircuitFailures: number;
      realtimeCircuitLastError: string | null;
      realtimeChannel: unknown;
      maybeReenterRealtimeFromPolling: (projectId: string, userId: string | null, transportGeneration: number) => Promise<boolean>;
    }).realtimeCircuitFailures = 3;
    (service as unknown as {
      currentProjectId: string | null;
      currentUserId: string | null;
      transportGeneration: number;
      realtimeCircuitUntil: number;
      realtimeCircuitOwnerUserId: string | null;
      realtimeCircuitFailures: number;
      realtimeCircuitLastError: string | null;
      realtimeChannel: unknown;
      maybeReenterRealtimeFromPolling: (projectId: string, userId: string | null, transportGeneration: number) => Promise<boolean>;
    }).realtimeCircuitLastError = 'websocket blocked';

    const activateSpy = vi.spyOn(
      service as unknown as {
        activateProjectTransport: (projectId: string, userId: string | null, transportGeneration: number) => Promise<void>;
        realtimeChannel: unknown;
      },
      'activateProjectTransport',
    ).mockImplementation(async () => {
      (service as unknown as { realtimeChannel: unknown }).realtimeChannel = mockChannel;
    });

    const reentered = await (
      service as unknown as {
        maybeReenterRealtimeFromPolling: (projectId: string, userId: string | null, transportGeneration: number) => Promise<boolean>;
      }
    ).maybeReenterRealtimeFromPolling('project-12', 'user-333', 1);

    expect(reentered).toBe(true);
    expect(activateSpy).toHaveBeenCalledWith('project-12', 'user-333', 1);
  });
});
