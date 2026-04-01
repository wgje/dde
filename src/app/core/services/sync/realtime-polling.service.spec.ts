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
  syncState: signal({ isOnline: true }),
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
  },
};

describe('RealtimePollingService', () => {
  let service: RealtimePollingService;
  let injector: Injector;

  beforeEach(() => {
    vi.clearAllMocks();
    destroyCallbacks.length = 0;
    strategySignal.set({ enableRealtime: true });

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
    resolveRemoveChannel?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(startPollingSpy).not.toHaveBeenCalled();
    expect(service.getCurrentProjectId()).toBeNull();
  });
});