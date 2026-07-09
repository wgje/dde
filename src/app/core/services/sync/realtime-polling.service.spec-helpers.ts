import {
  DestroyRef,
  Injector,
  runInInjectionContext,
  signal,
  ɵChangeDetectionScheduler as ChangeDetectionScheduler,
  ɵEffectScheduler as EffectScheduler,
} from '@angular/core';
import { vi } from 'vitest';
import { LoggerService } from '../../../../services/logger.service';
import { MobileSyncStrategyService } from '../../../../services/mobile-sync-strategy.service';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import { SupabaseClientService } from '../../../../services/supabase-client.service';
import { ToastService } from '../../../../services/toast.service';
import { resetBrowserNetworkSuspensionTrackingForTests } from '../../../../utils/browser-network-suspension';
import { RealtimePollingService } from './realtime-polling.service';
import { RealtimeTransportCircuitService } from './realtime-transport-circuit.service';
import { SyncStateService } from './sync-state.service';

export const REALTIME_CIRCUIT_STORAGE_KEY = 'nanoflow.realtime-transport-circuit';

export type RealtimePollingStatusCallback = (
  status: string,
  err?: { message?: string },
) => void;

export type RealtimePollingHarness = {
  currentProjectId: string | null;
  currentUserId: string | null;
  transportGeneration: number;
  transportSuspended: boolean;
  realtimeChannel: unknown;
  activateProjectTransport: (
    projectId: string,
    userId: string | null,
    transportGeneration: number,
  ) => Promise<void>;
  maybeReenterRealtimeFromPolling: (
    projectId: string,
    userId: string | null,
    transportGeneration: number,
  ) => Promise<boolean>;
  stopPolling: () => void;
  startPolling: (projectId: string, userId: string | null, transportGeneration: number) => void;
  hasRealtimeTransportSupport: () => boolean;
};

export interface RealtimePollingSpecSetup {
  service: RealtimePollingService;
  injector: Injector;
}

type SubscribeMock = {
  mock: {
    calls: Array<readonly unknown[]>;
  };
};

export function createRealtimePollingDestroyHarness(): {
  destroyCallbacks: Array<() => void>;
  destroyRealtimePollingService: (injector?: Injector) => void;
  mockDestroyRef: Pick<DestroyRef, 'onDestroy'>;
} {
  const destroyCallbacks: Array<() => void> = [];
  const destroyedInjectors = new WeakSet<Injector>();
  const mockDestroyRef: Pick<DestroyRef, 'onDestroy'> = {
    onDestroy: (callback: () => void) => {
      destroyCallbacks.push(callback);
      return () => {};
    },
  };

  return {
    destroyCallbacks,
    destroyRealtimePollingService: injector => {
      if (injector && !destroyedInjectors.has(injector)) {
        (injector as { destroy?: () => void } | undefined)?.destroy?.();
        destroyedInjectors.add(injector);
      }
      for (const callback of destroyCallbacks.splice(0)) {
        callback();
      }
    },
    mockDestroyRef,
  };
}

export function createRealtimePollingSpecEnvironment() {
  const strategySignal = signal({ enableRealtime: true } as { enableRealtime: boolean });
  const mockChannel = {
    on: vi.fn().mockReturnThis(),
    subscribe: vi.fn().mockReturnThis(),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
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
    addBreadcrumb: vi.fn(),
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
  const {
    destroyCallbacks,
    destroyRealtimePollingService,
    mockDestroyRef,
  } = createRealtimePollingDestroyHarness();
  let currentInjector: Injector | undefined;
  const createService = (): RealtimePollingService => {
    if (!currentInjector) {
      throw new Error('Realtime polling spec injector has not been initialized');
    }

    return runInInjectionContext(currentInjector, () => new RealtimePollingService());
  };

  return {
    strategySignal,
    mockChannel,
    mockClient,
    mockSupabase,
    mockLogger,
    mockSyncStateService,
    mockSentryLazyLoaderService,
    destroyRealtimePollingService,
    createService,
    setup(): RealtimePollingSpecSetup {
      vi.clearAllMocks();
      mockChannel.on.mockReturnThis();
      mockChannel.subscribe.mockReturnThis();
      mockChannel.unsubscribe.mockResolvedValue(undefined);
      mockClient.channel.mockImplementation(() => mockChannel);
      mockClient.removeChannel.mockResolvedValue(undefined);
      mockSupabase.client.mockImplementation(() => mockClient);
      destroyCallbacks.length = 0;
      sessionStorage.clear();
      mockSyncStateService.syncState.set({ isOnline: true, offlineMode: false });
      strategySignal.set({ enableRealtime: true });
      setVisibilityState('visible');

      currentInjector = Injector.create({
        providers: [
          { provide: SupabaseClientService, useValue: mockSupabase },
          { provide: LoggerService, useValue: mockLoggerService },
          { provide: ToastService, useValue: mockToastService },
          RealtimeTransportCircuitService,
          { provide: MobileSyncStrategyService, useValue: mockMobileSyncStrategy },
          { provide: SyncStateService, useValue: mockSyncStateService },
          { provide: SentryLazyLoaderService, useValue: mockSentryLazyLoaderService },
          { provide: ChangeDetectionScheduler, useValue: mockChangeDetectionScheduler },
          { provide: EffectScheduler, useValue: mockEffectScheduler },
          { provide: DestroyRef, useValue: mockDestroyRef },
        ],
      });

      return {
        injector: currentInjector,
        service: createService(),
      };
    },
    teardown(): void {
      destroyRealtimePollingService(currentInjector);
      currentInjector = undefined;
      resetBrowserNetworkSuspensionTrackingForTests();
      setVisibilityState('visible');
    },
  };
}

export function readLatestRealtimeStatusCallback(
  channel: { subscribe: SubscribeMock },
): RealtimePollingStatusCallback | undefined {
  return channel.subscribe.mock.calls.at(-1)?.[0] as RealtimePollingStatusCallback | undefined;
}

export function setVisibilityState(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: state,
  });
}
