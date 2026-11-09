import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';

import { FocusConsoleSyncService } from '../core-bridge';
import type { DockSnapshot } from '../models/parking-dock';
import {
  ensureBrowserNetworkSuspensionTracking,
  resetBrowserNetworkSuspensionTrackingForTests,
} from '../utils/browser-network-suspension';
import { ActionQueueService } from './action-queue.service';
import {
  DockCloudSyncService,
  type CloudSyncEngineCallbacks,
} from './dock-cloud-sync.service';
import { DockSnapshotPersistenceService } from './dock-snapshot-persistence.service';
import { DockDirectWidgetNotifyOutboxService } from './dock-direct-widget-notify-outbox.service';
import { LoggerService } from './logger.service';
import { SupabaseClientService } from './supabase-client.service';

export const mockLoggerCategory = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

export const mockLogger = {
  category: vi.fn(() => mockLoggerCategory),
};

export const mockSyncService = {
  loadFocusSession: vi.fn().mockResolvedValue(null),
  listRoutineTasks: vi.fn().mockResolvedValue([]),
  importLegacyDockSnapshot: vi.fn().mockResolvedValue(null),
};

export const mockActionQueue = {
  enqueue: vi.fn((): string => crypto.randomUUID()),
  enqueueForOwner: vi.fn((): Promise<string> => Promise.resolve(crypto.randomUUID())),
  enqueueDurablyForOwner: vi.fn((): Promise<string> => Promise.resolve(crypto.randomUUID())),
};

export const mockSnapshotPersistence = {
  normalizeSnapshot: vi.fn(),
  isSnapshotNewer: vi.fn(),
};

export const mockFunctionsInvoke = vi.fn().mockResolvedValue({ data: null, error: null });

export const mockDirectWidgetNotifyOutbox = {
  enqueueLatest: vi.fn(async (input: { focusSessionId: string; focusActive: boolean; updatedAt: string }) => ({
    operationId: `direct-widget-notify-${input.focusSessionId}`,
    webhookId: `pwa-direct-direct-widget-notify-${input.focusSessionId}`,
    focusSessionId: input.focusSessionId,
    focusActive: input.focusActive,
    updatedAt: input.updatedAt,
    createdAt: input.updatedAt,
    queuedAt: input.updatedAt,
    attemptCount: 0,
  })),
  removeRecord: vi.fn().mockResolvedValue(undefined),
  buildInvokeBody: vi.fn((record: { webhookId: string; focusSessionId: string; focusActive: boolean; updatedAt: string }) => ({
    directNotify: true,
    webhookId: record.webhookId,
    focusActive: record.focusActive,
    focusSessionId: record.focusSessionId,
    updatedAt: record.updatedAt,
  })),
};

export function createActiveSessionResult() {
  return {
    data: {
      session: {
        access_token: 'token',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      },
    },
    error: null,
  };
}

export const mockSupabaseClient = {
  clientAsync: vi.fn().mockResolvedValue({
    functions: {
      invoke: mockFunctionsInvoke,
    },
  }),
  getSession: vi.fn().mockResolvedValue(createActiveSessionResult()),
};

export function setVisibilityState(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: state,
  });
}

export function makeSnapshot(overrides?: Partial<DockSnapshot>): DockSnapshot {
  return {
    version: 1,
    entries: [],
    focusMode: false,
    isDockExpanded: false,
    muteWaitTone: false,
    session: {
      firstDragIntervened: false,
      focusBlurOn: false,
      focusScrimOn: false,
      mainTaskId: null,
      comboSelectIds: [],
      backupIds: [],
    },
    dailySlots: [],
    suspendChainRootTaskId: null,
    suspendRecommendationLocked: false,
    pendingDecision: null,
    dailyResetDate: '2025-01-01',
    savedAt: new Date().toISOString(),
    ...overrides,
  };
}

export function makeCallbacks(
  overrides?: Partial<CloudSyncEngineCallbacks>,
): CloudSyncEngineCallbacks {
  return {
    exportSnapshot: vi.fn(() => makeSnapshot()),
    restoreSnapshot: vi.fn(),
    scheduleLocalPersist: vi.fn(),
    persistLocalSnapshotImmediately: vi.fn(() => Promise.resolve(true)),
    updateDailySlots: vi.fn(),
    getNonCriticalHoldDelay: vi.fn(() => 0),
    getFocusSessionContext: vi.fn(() => ({ id: 'session-1', startedAt: Date.now() })),
    setFocusSessionContext: vi.fn(),
    buildNormalizeContext: vi.fn(() => ({
      muteWaitTone: false,
      todayDateKey: '2025-01-01',
      buildOverflowMeta: () => ({ comboSelectOverflow: 0, backupOverflow: 0 }),
    })),
    getCurrentSnapshotUserId: vi.fn(() => 'user-1'),
    ...overrides,
  };
}

export function setupDockCloudSyncTestBed(): DockCloudSyncService {
  vi.useFakeTimers();
  resetBrowserNetworkSuspensionTrackingForTests();
  ensureBrowserNetworkSuspensionTracking();
  setVisibilityState('visible');

  mockActionQueue.enqueue.mockClear();
  mockActionQueue.enqueueForOwner.mockClear();
  mockActionQueue.enqueueDurablyForOwner.mockClear();
  mockSyncService.loadFocusSession.mockClear();
  mockSyncService.listRoutineTasks.mockClear();
  mockSyncService.importLegacyDockSnapshot.mockClear();
  mockSnapshotPersistence.normalizeSnapshot.mockClear();
  mockSnapshotPersistence.isSnapshotNewer.mockClear();
  mockLoggerCategory.info.mockClear();
  mockLoggerCategory.warn.mockClear();
  mockLoggerCategory.error.mockClear();
  mockLoggerCategory.debug.mockClear();
  mockSupabaseClient.clientAsync.mockClear();
  mockSupabaseClient.getSession.mockClear();
  mockSupabaseClient.getSession.mockResolvedValue(createActiveSessionResult());
  mockFunctionsInvoke.mockClear();
  mockFunctionsInvoke.mockResolvedValue({ data: null, error: null });
  mockDirectWidgetNotifyOutbox.enqueueLatest.mockClear();
  mockDirectWidgetNotifyOutbox.removeRecord.mockClear();
  mockDirectWidgetNotifyOutbox.removeRecord.mockResolvedValue(undefined);
  mockDirectWidgetNotifyOutbox.buildInvokeBody.mockClear();

  TestBed.configureTestingModule({
    providers: [
      DockCloudSyncService,
      { provide: FocusConsoleSyncService, useValue: mockSyncService },
      { provide: ActionQueueService, useValue: mockActionQueue },
      { provide: DockSnapshotPersistenceService, useValue: mockSnapshotPersistence },
      { provide: LoggerService, useValue: mockLogger },
      { provide: SupabaseClientService, useValue: mockSupabaseClient },
      { provide: DockDirectWidgetNotifyOutboxService, useValue: mockDirectWidgetNotifyOutbox },
    ],
  });

  return TestBed.inject(DockCloudSyncService);
}

export function teardownDockCloudSyncTestBed(service: DockCloudSyncService): void {
  service.cancelTimers();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  resetBrowserNetworkSuspensionTrackingForTests();
  setVisibilityState('visible');
}
