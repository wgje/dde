import type { WritableSignal } from '@angular/core';

import { registerSimpleSyncResumeBackgroundFallbackSpecs } from './simple-sync-resume-background-fallback.spec-helpers';
import { registerSimpleSyncResumeProjectDeleteSpecs } from './simple-sync-resume-project-delete.spec-helpers';
import { registerSimpleSyncBatchRetrySpecs } from './simple-sync-batch-retry.spec-helpers';
import { registerSimpleSyncCoreSpecs } from './simple-sync-core.spec-helpers';
import { registerSimpleSyncCoreRpcSpecs } from './simple-sync-core-rpc.spec-helpers';
import { registerSimpleSyncLegacyOfflineOnlineSpecs } from './simple-sync-legacy-offline-online.spec-helpers';
import { registerSimpleSyncRuntimeSessionSpecs } from './simple-sync-runtime-session.spec-helpers';
import type { SimpleSyncService } from './simple-sync.service';
import type { ConnectivityRecoveryService } from './sync/connectivity-recovery.service';

interface ConnectivityChange {
  offline: boolean;
  source: 'probe' | 'request' | 'manual';
}

export interface SimpleSyncSuiteSpecContext {
  service(): SimpleSyncService;
  windowAddEventListenerSpy(): any;
  windowRemoveEventListenerSpy(): any;
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
  mockChangeTracker(): any;
  mockActionQueue(): any;
  mockSupabaseOfflineMode(): WritableSignal<boolean>;
  mockSentryLazyLoader(): any;
  connectivityRecovery(): ConnectivityRecoveryService;
  emitConnectivityChange(change: ConnectivityChange): void;
}

function createRemoteSyncSpecContext(context: SimpleSyncSuiteSpecContext) {
  return {
    service: context.service,
    windowAddEventListenerSpy: context.windowAddEventListenerSpy,
    windowRemoveEventListenerSpy: context.windowRemoveEventListenerSpy,
    mockSupabase: context.mockSupabase,
    mockClient: context.mockClient,
    mockProjectData: context.mockProjectData,
    mockSyncRpcClient: context.mockSyncRpcClient,
    mockBlackBoxSync: context.mockBlackBoxSync,
    mockProjectStore: context.mockProjectStore,
    mockSyncCursorPersistence: context.mockSyncCursorPersistence,
    mockSessionManager: context.mockSessionManager,
    mockRetryQueueService: context.mockRetryQueueService,
    mockRealtimePolling: context.mockRealtimePolling,
    mockToast: context.mockToast,
    mockLoggerCategory: context.mockLoggerCategory,
    mockCaptureMessage: context.mockCaptureMessage,
    mockCaptureException: context.mockCaptureException,
    mockThrottle: context.mockThrottle,
  };
}

export function registerSimpleSyncSuiteSpecs(context: SimpleSyncSuiteSpecContext): void {
  registerSimpleSyncCoreRpcSpecs(createRemoteSyncSpecContext(context));
  registerSimpleSyncCoreSpecs({
    service: context.service,
    mockRetryQueueService: context.mockRetryQueueService,
  });

  registerSimpleSyncLegacyOfflineOnlineSpecs(createRemoteSyncSpecContext(context));
  registerSimpleSyncRuntimeSessionSpecs(createRemoteSyncSpecContext(context));

  registerSimpleSyncBatchRetrySpecs({
    service: context.service,
    mockSupabase: context.mockSupabase,
    mockClient: context.mockClient,
    mockProjectData: context.mockProjectData,
    mockChangeTracker: context.mockChangeTracker,
    mockRetryQueueService: context.mockRetryQueueService,
    mockActionQueue: context.mockActionQueue,
    mockLoggerCategory: context.mockLoggerCategory,
    mockToast: context.mockToast,
    mockCaptureException: context.mockCaptureException,
    mockCaptureMessage: context.mockCaptureMessage,
  });
  registerSimpleSyncResumeProjectDeleteSpecs({
    service: context.service,
    mockRetryQueueService: context.mockRetryQueueService,
    mockRealtimePolling: context.mockRealtimePolling,
    mockSupabase: context.mockSupabase,
    mockSupabaseOfflineMode: context.mockSupabaseOfflineMode,
    mockSessionManager: context.mockSessionManager,
    mockClient: context.mockClient,
    mockSyncRpcClient: context.mockSyncRpcClient,
    mockProjectStore: context.mockProjectStore,
    mockSentryLazyLoader: context.mockSentryLazyLoader,
    emitConnectivityChange: context.emitConnectivityChange,
  });
  registerSimpleSyncResumeBackgroundFallbackSpecs({
    service: context.service,
    mockRetryQueueService: context.mockRetryQueueService,
    mockRealtimePolling: context.mockRealtimePolling,
    mockSessionManager: context.mockSessionManager,
    mockProjectData: context.mockProjectData,
    mockLoggerCategory: context.mockLoggerCategory,
    connectivityRecovery: context.connectivityRecovery,
  });
}
