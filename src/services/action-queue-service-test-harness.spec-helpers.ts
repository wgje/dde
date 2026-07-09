import { DestroyRef, Injector, type Signal } from '@angular/core';
import { vi } from 'vitest';

import { mockSentryLazyLoaderService } from '../test-setup.mocks';
import type { Project, Task } from '../models';
import type { DeadLetterItem, QueuedAction } from './action-queue.types';
import { ActionQueueService } from './action-queue.service';
import { ActionQueueEnqueueMutationService } from './action-queue-enqueue-mutation.service';
import { ActionQueueSyncWriterLeaseService } from './action-queue-sync-writer-lease.service';
import { ActionQueueViewStateService } from './action-queue-view-state.service';
import { ActionQueueStorageService } from './action-queue-storage.service';
import { ActionQueueOwnerStorageService } from './action-queue-owner-storage.service';
import { ActionQueueSchedulerService } from './action-queue-scheduler.service';
import { AuthService } from './auth.service';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { SentryAlertService } from './sentry-alert.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { NetworkAwarenessService } from './network-awareness.service';
import { QueueBackupService } from './queue-backup.service';
import { RetryQueueService } from '../app/core/services/sync/retry-queue.service';
import { WriteGuardService } from './write-guard.service';
import { SyncWriterLeaseService } from './sync-writer-lease.service';

export const mockLoggerCategory = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

export const mockLoggerService = {
  category: vi.fn(() => mockLoggerCategory),
};

export const mockToastService = {
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
};

export const mockSentryAlertService = {
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  setContext: vi.fn(),
  updateSyncContext: vi.fn(),
};

export const mockNetworkAwarenessService = {
  setStoragePressure: vi.fn(),
};

export const mockQueueBackupState = {
  persistedQueue: [] as QueuedAction[],
  persistedDeadLetters: [] as DeadLetterItem[],
  recordFound: false,
  deadLetterRecordFound: false,
};

export const mockQueueBackupService = {
  backupQueue: vi.fn(async (queue: QueuedAction[]) => {
    mockQueueBackupState.persistedQueue = queue;
    mockQueueBackupState.recordFound = true;
    return true;
  }),
  restoreQueue: vi.fn(async () => (
    mockQueueBackupState.recordFound
      ? mockQueueBackupState.persistedQueue
      : null
  )),
  backupDeadLetters: vi.fn(async (deadLetters: DeadLetterItem[]) => {
    mockQueueBackupState.persistedDeadLetters = deadLetters;
    mockQueueBackupState.deadLetterRecordFound = true;
    return true;
  }),
  restoreDeadLetters: vi.fn(async () => (
    mockQueueBackupState.deadLetterRecordFound
      ? mockQueueBackupState.persistedDeadLetters
      : null
  )),
  updateQueue: vi.fn(async (
    _ownerUserId: string,
    updater: (
      queue: QueuedAction[],
      context?: { recordFound: boolean },
    ) => QueuedAction[],
  ) => {
    const recordFound = (
      mockQueueBackupState.recordFound ||
      mockQueueBackupState.persistedQueue.length > 0
    );
    mockQueueBackupState.persistedQueue = updater(
      mockQueueBackupState.persistedQueue,
      { recordFound },
    );
    mockQueueBackupState.recordFound = true;
    return mockQueueBackupState.persistedQueue;
  }),
};

export const mockRetryQueueService = {
  hasEntity: vi.fn().mockReturnValue(false),
  removeByEntity: vi.fn().mockReturnValue(false),
  getItems: vi.fn().mockReturnValue([]),
  add: vi.fn(),
  clear: vi.fn(),
};

export const mockWriteGuardService = {
  assertWritable: vi.fn(() => true),
};

export const mockLeaseRelease = vi.fn(async () => undefined);

export const mockSyncWriterLeaseService = {
  isFeatureEnabled: vi.fn(() => false),
  requestLease: vi.fn(async () => ({
    tabId: 'tab-action',
    lockName: 'nanoflow-sync:test:test-user:__global__',
    mode: 'idb-lease' as const,
    release: mockLeaseRelease,
  })),
};

export function resetActionQueueServiceMocks(): void {
  mockQueueBackupState.persistedQueue = [];
  mockQueueBackupState.persistedDeadLetters = [];
  mockQueueBackupState.recordFound = false;
  mockQueueBackupState.deadLetterRecordFound = false;
  mockWriteGuardService.assertWritable.mockReturnValue(true);
  mockSyncWriterLeaseService.isFeatureEnabled.mockReturnValue(false);
  mockSyncWriterLeaseService.requestLease.mockClear();
  mockLeaseRelease.mockClear();
}

export function createMockTask(overrides: Partial<Task> = {}): Task {
  return {
    id: crypto.randomUUID(),
    title: 'Test Task',
    content: '',
    stage: 1,
    parentId: null,
    order: 0,
    rank: 500,
    status: 'active',
    x: 0, y: 0,
    createdDate: new Date().toISOString(),
    displayId: '1',
    ...overrides,
  };
}

export function createMockProject(overrides: Partial<Project> = {}): Project {
  return {
    id: crypto.randomUUID(),
    name: 'Test Project',
    description: '',
    createdDate: new Date().toISOString(),
    tasks: [],
    connections: [],
    ...overrides,
  };
}

export function createActionQueueServiceTestInjector(
  currentUserIdSignal: Signal<string | null>,
  destroyRef: DestroyRef,
): Injector {
  return Injector.create({
    providers: [
      ActionQueueService,
      ActionQueueEnqueueMutationService,
      ActionQueueSyncWriterLeaseService,
      ActionQueueViewStateService,
      ActionQueueStorageService,
      ActionQueueOwnerStorageService,
      ActionQueueSchedulerService,
      { provide: LoggerService, useValue: mockLoggerService },
      { provide: ToastService, useValue: mockToastService },
      { provide: SentryAlertService, useValue: mockSentryAlertService },
      { provide: SentryLazyLoaderService, useValue: mockSentryLazyLoaderService },
      { provide: NetworkAwarenessService, useValue: mockNetworkAwarenessService },
      { provide: QueueBackupService, useValue: mockQueueBackupService },
      { provide: RetryQueueService, useValue: mockRetryQueueService },
      { provide: WriteGuardService, useValue: mockWriteGuardService },
      { provide: SyncWriterLeaseService, useValue: mockSyncWriterLeaseService },
      { provide: AuthService, useValue: { currentUserId: currentUserIdSignal } },
      { provide: DestroyRef, useValue: destroyRef },
    ],
  });
}
