import { DestroyRef, Injector, type Signal } from '@angular/core';
import { describe, expect, it, vi, type Mock } from 'vitest';

import { mockSentryLazyLoaderService } from '../test-setup.mocks';
import type { Project, Task } from '../models';
import type { DeadLetterItem, QueuedAction } from './action-queue.types';
import { ActionQueueService } from './action-queue.service';
import { ActionQueueEnqueueMutationService } from './action-queue-enqueue-mutation.service';
import { ActionQueueSyncWriterLeaseService } from './action-queue-sync-writer-lease.service';
import { ActionQueueViewStateService } from './action-queue-view-state.service';
import { ActionQueueStorageService } from './action-queue-storage.service';
import { createMockAction } from './action-queue-storage.spec-helpers';
import { ActionQueueOwnerStorageService } from './action-queue-owner-storage.service';
import {
  LocalBackupUiRestorePreActionQueueFenceService,
  type LocalBackupUiRestorePreActionQueueFenceInput,
  type LocalBackupUiRestorePreActionQueueFenceResult,
} from './local-backup-ui-restore-pre-actionqueue-fence.service';
import { ActionQueueSchedulerService } from './action-queue-scheduler.service';
import { ActionQueueOwnerStorageLoadController } from './action-queue-retry-supersession.controller';
import { AuthService } from './auth.service';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { SentryAlertService } from './sentry-alert.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { NetworkAwarenessService } from './network-awareness.service';
import {
  QUEUE_BACKUP_NO_WRITE,
  QueueBackupService,
  type QueueBackupStrictUpdateResult,
  type QueueBackupUpdateContext,
} from './queue-backup.service';
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

interface MockQueueBackupOwnerState {
  queue: QueuedAction[];
  deadLetters: DeadLetterItem[];
  recordFound: boolean;
  deadLetterRecordFound: boolean;
}

const mockQueueBackupOwnerStates = new Map<string, MockQueueBackupOwnerState>();

function getMockQueueBackupOwnerState(ownerUserId = 'test-user'): MockQueueBackupOwnerState {
  const existing = mockQueueBackupOwnerStates.get(ownerUserId);
  if (existing) return existing;
  const created = { queue: [], deadLetters: [], recordFound: false, deadLetterRecordFound: false };
  mockQueueBackupOwnerStates.set(ownerUserId, created);
  return created;
}

export const mockQueueBackupState = {
  get persistedQueue(): QueuedAction[] { return getMockQueueBackupOwnerState().queue; },
  set persistedQueue(queue: QueuedAction[]) { getMockQueueBackupOwnerState().queue = queue; },
  get persistedDeadLetters(): DeadLetterItem[] { return getMockQueueBackupOwnerState().deadLetters; },
  set persistedDeadLetters(deadLetters: DeadLetterItem[]) {
    getMockQueueBackupOwnerState().deadLetters = deadLetters;
  },
  get recordFound(): boolean { return getMockQueueBackupOwnerState().recordFound; },
  set recordFound(found: boolean) { getMockQueueBackupOwnerState().recordFound = found; },
  get deadLetterRecordFound(): boolean {
    return getMockQueueBackupOwnerState().deadLetterRecordFound;
  },
  set deadLetterRecordFound(found: boolean) {
    getMockQueueBackupOwnerState().deadLetterRecordFound = found;
  },
};

type MockQueueBackupStrictUpdate = (
  ownerUserId: string,
  updater: (queue: QueuedAction[], context: QueueBackupUpdateContext) => QueuedAction[],
) => Promise<QueueBackupStrictUpdateResult>;

function createMockQueueBackupStrictUpdate(): Mock<MockQueueBackupStrictUpdate> {
  return vi.fn<MockQueueBackupStrictUpdate>(async (
    ownerUserId: string,
    updater: (queue: QueuedAction[], context: QueueBackupUpdateContext) => QueuedAction[],
  ) => {
    const ownerState = getMockQueueBackupOwnerState(ownerUserId);
    const currentQueue = ownerState.queue;
    const nextQueue = updater(currentQueue, {
      recordFound: ownerState.recordFound,
    });
    if (Reflect.has(nextQueue, QUEUE_BACKUP_NO_WRITE)) {
      Reflect.deleteProperty(nextQueue, QUEUE_BACKUP_NO_WRITE);
      return { status: 'no-write' as const, queue: currentQueue };
    }
    ownerState.queue = nextQueue;
    ownerState.recordFound = true;
    return { status: 'committed' as const, queue: nextQueue };
  });
}

let mockQueueBackupStrictUpdate = createMockQueueBackupStrictUpdate();

export function installMockQueueBackupStrictUpdate(): Mock<MockQueueBackupStrictUpdate> {
  const strictUpdate = createMockQueueBackupStrictUpdate();
  mockQueueBackupStrictUpdate = strictUpdate;
  return strictUpdate;
}

async function backupMockQueue(queue: QueuedAction[], ownerUserId = 'test-user'): Promise<boolean> {
  const ownerState = getMockQueueBackupOwnerState(ownerUserId);
  ownerState.queue = queue;
  ownerState.recordFound = true;
  return true;
}

async function restoreMockQueue(ownerUserId = 'test-user'): Promise<QueuedAction[] | null> {
  const ownerState = getMockQueueBackupOwnerState(ownerUserId);
  return ownerState.recordFound ? ownerState.queue : null;
}

async function restoreMockQueueSnapshot(ownerUserId = 'test-user') {
  const ownerState = getMockQueueBackupOwnerState(ownerUserId);
  return { recordFound: ownerState.recordFound, actions: ownerState.queue, savedAt: null };
}

async function restoreMockDeadLetters(ownerUserId = 'test-user'): Promise<DeadLetterItem[] | null> {
  const ownerState = getMockQueueBackupOwnerState(ownerUserId);
  return ownerState.deadLetterRecordFound ? ownerState.deadLetters : null;
}

export const mockQueueBackupService = {
  backupQueue: vi.fn(backupMockQueue),
  restoreQueue: vi.fn(restoreMockQueue),
  backupDeadLetters: vi.fn(async (deadLetters: DeadLetterItem[], ownerUserId = 'test-user') => {
    const ownerState = getMockQueueBackupOwnerState(ownerUserId);
    ownerState.deadLetters = deadLetters;
    ownerState.deadLetterRecordFound = true;
    return true;
  }),
  restoreDeadLetters: vi.fn(restoreMockDeadLetters),
  updateQueue: vi.fn(async (
    ownerUserId: string,
    updater: (queue: QueuedAction[], context: QueueBackupUpdateContext) => QueuedAction[],
  ) => {
    const result = await mockQueueBackupStrictUpdate(ownerUserId, updater);
    return result.status === 'committed' || result.status === 'no-write'
      ? result.queue
      : null;
  }),
  get updateQueueStrictly() {
    return mockQueueBackupStrictUpdate;
  },
  restoreQueueSnapshot: vi.fn(restoreMockQueueSnapshot),
};

export const mockRetryQueueService = {
  hasEntity: vi.fn().mockReturnValue(false),
  removeByEntity: vi.fn().mockReturnValue(false),
  getItems: vi.fn().mockReturnValue([]),
  add: vi.fn(),
  clear: vi.fn(),
  configureActionQueueSupersessionBridge: vi.fn(),
};

export const mockLocalBackupUiRestorePreActionQueueFence = {
  run: vi.fn<(
    input: LocalBackupUiRestorePreActionQueueFenceInput,
  ) => Promise<LocalBackupUiRestorePreActionQueueFenceResult>>(async input => ({
    status: 'CLEAR' as const,
    ownerUserId: input.ownerUserId,
    recovered: false,
    terminalResultDigest: null,
  })),
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
  mockQueueBackupOwnerStates.clear();
  installMockQueueBackupStrictUpdate();
  mockQueueBackupService.backupQueue.mockReset();
  mockQueueBackupService.backupQueue.mockImplementation(backupMockQueue);
  mockQueueBackupService.restoreQueue.mockReset();
  mockQueueBackupService.restoreQueue.mockImplementation(restoreMockQueue);
  mockQueueBackupService.restoreQueueSnapshot.mockReset();
  mockQueueBackupService.restoreQueueSnapshot.mockImplementation(restoreMockQueueSnapshot);
  mockQueueBackupService.restoreDeadLetters.mockReset();
  mockQueueBackupService.restoreDeadLetters.mockImplementation(restoreMockDeadLetters);
  mockRetryQueueService.configureActionQueueSupersessionBridge.mockReset();
  mockLocalBackupUiRestorePreActionQueueFence.run.mockReset();
  mockLocalBackupUiRestorePreActionQueueFence.run.mockImplementation(async input => ({
    status: 'CLEAR' as const,
    ownerUserId: input.ownerUserId,
    recovered: false,
    terminalResultDigest: null,
  }));
  mockWriteGuardService.assertWritable.mockReturnValue(true);
  mockSyncWriterLeaseService.isFeatureEnabled.mockReturnValue(true);
  mockSyncWriterLeaseService.requestLease.mockReset();
  mockSyncWriterLeaseService.requestLease.mockImplementation(async () => ({
    tabId: 'tab-action',
    lockName: 'nanoflow-sync:test:test-user:__global__',
    mode: 'idb-lease' as const,
    signal: new AbortController().signal,
    release: mockLeaseRelease,
  }));
  mockLeaseRelease.mockClear();
}

export function markActionQueueCurrentOwnerStorageLoadedForTests(service: ActionQueueService): void {
  const load = (service as unknown as {
    ownerStorageLoad: ActionQueueOwnerStorageLoadController;
  }).ownerStorageLoad;
  const token = load.begin();
  load.complete(token, 'ready');
}

export function registerActionQueueStorageAdmissionSpecs(
  getService: () => ActionQueueService,
  setCurrentOwnerUserId: (ownerUserId: string) => void,
): void {
  const markUnknown = (service: ActionQueueService) => (service as unknown as {
    ownerStorageLoad: ActionQueueOwnerStorageLoadController;
  }).ownerStorageLoad.markCurrentOwnerUnknown();
  const installQueuePreimage = (service: ActionQueueService, action: QueuedAction) => {
    service.pendingActions.set([action]); service.queueSize.set(1);
    mockQueueBackupState.persistedQueue = [action]; mockQueueBackupState.recordFound = true;
    localStorage.setItem('nanoflow.action-queue.test-user', JSON.stringify([action]));
  };

  describe('owner storage direct-port admission', () => {
    it('blocks a current-owner direct removal while storage is unknown without any durable or visible write', async () => {
      const service = getService();
      const action = createMockAction({ id: 'attachment-current-unknown', entityType: 'attachment' });
      installQueuePreimage(service, action);
      localStorage.setItem('nanoflow.dead-letter.test-user', 'dead-letter-preimage');
      const strictUpdate = installMockQueueBackupStrictUpdate();
      markUnknown(service);

      const result = await service.storage.persistQueueMutationForOwner(
        'test-user', queue => queue.filter(candidate => candidate.id !== action.id),
      );

      expect(result).toBeNull();
      expect(strictUpdate).not.toHaveBeenCalled();
      expect(service.pendingActions()).toEqual([action]);
      expect(localStorage.getItem('nanoflow.action-queue.test-user')).toBe(JSON.stringify([action]));
      expect(localStorage.getItem('nanoflow.dead-letter.test-user')).toBe('dead-letter-preimage');
    });

    it('publishes one loaded current-owner removal without a second full-snapshot write', async () => {
      const service = getService();
      const action = createMockAction({ id: 'attachment-current-loaded', entityType: 'attachment' });
      installQueuePreimage(service, action);
      const strictUpdate = installMockQueueBackupStrictUpdate();
      mockQueueBackupService.backupQueue.mockClear();

      const result = await service.storage.persistQueueMutationForOwner(
        'test-user', queue => queue.filter(candidate => candidate.id !== action.id),
      );
      if (result !== null) {
        const current = service.pendingActions().find(candidate => candidate.id === action.id);
        if (current) service.dequeue(current.id);
      }

      expect(result).toEqual([]);
      expect(strictUpdate).toHaveBeenCalledOnce();
      expect(mockQueueBackupService.backupQueue).not.toHaveBeenCalled();
      expect(service.pendingActions()).toEqual([]);
      expect(service.queueSize()).toBe(0);
    });

    it('preserves an explicitly identified foreign-owner mutation while current storage is unknown', async () => {
      const service = getService();
      const currentAction = createMockAction({ id: 'current-owner-action' });
      const foreignAction = createMockAction({ id: 'foreign-owner-action', entityType: 'attachment' });
      service.pendingActions.set([currentAction]); service.queueSize.set(1);
      await mockQueueBackupService.backupQueue([foreignAction], 'foreign-user');
      const strictUpdate = installMockQueueBackupStrictUpdate();
      markUnknown(service);

      const result = await service.storage.persistQueueMutationForOwner(
        'foreign-user', queue => queue.filter(candidate => candidate.id !== foreignAction.id),
      );

      expect(result).toEqual([]);
      expect(strictUpdate).toHaveBeenCalledOnce();
      expect(service.pendingActions()).toEqual([currentAction]);
    });

    it('holds a committed result from an obsolete same-owner load generation', async () => {
      const service = getService();
      const action = createMockAction({ id: 'attachment-generation-a', entityType: 'attachment' });
      installQueuePreimage(service, action);
      const strictUpdate = installMockQueueBackupStrictUpdate();
      let release!: () => void;
      strictUpdate.mockImplementationOnce(async (_owner, updater) => {
        await new Promise<void>(resolve => { release = resolve; });
        return { status: 'committed', queue: updater([action], { recordFound: true }) };
      });

      const pending = service.storage.persistQueueMutationForOwner(
        'test-user', queue => queue.filter(candidate => candidate.id !== action.id),
      );
      await vi.waitFor(() => expect(release).toBeTypeOf('function'));
      markUnknown(service);
      markActionQueueCurrentOwnerStorageLoadedForTests(service);
      release();

      expect(await pending).toBeNull();
      expect(service.pendingActions()).toEqual([action]);
    });

    describe('exact direct-port settlement', () => {
      it('rejects UNKNOWN before the updater or durable transaction runs', async () => {
        const service = getService();
        const action = createMockAction({ id: 'attachment-exact-unknown', entityType: 'attachment' });
        installQueuePreimage(service, action);
        const strictUpdate = installMockQueueBackupStrictUpdate();
        const updater = vi.fn((queue: QueuedAction[]) => queue.filter(item => item.id !== action.id));
        markUnknown(service);

        const result = await service.storage.persistExactQueueMutationForOwner('test-user', updater);

        expect(result).toEqual({ status: 'REJECTED_NO_COMMIT' });
        expect(updater).not.toHaveBeenCalled();
        expect(strictUpdate).not.toHaveBeenCalled();
        expect(mockQueueBackupState.persistedQueue).toEqual([action]);
        expect(service.pendingActions()).toEqual([action]);
      });

      it('publishes a stable loaded-owner commit exactly once', async () => {
        const service = getService();
        const action = createMockAction({ id: 'attachment-exact-published', entityType: 'attachment' });
        installQueuePreimage(service, action);
        const strictUpdate = installMockQueueBackupStrictUpdate();

        const result = await service.storage.persistExactQueueMutationForOwner(
          'test-user', queue => queue.filter(item => item.id !== action.id),
        );

        expect(result).toEqual({ status: 'COMMITTED_PUBLISHED', queue: [] });
        expect(strictUpdate).toHaveBeenCalledOnce();
        expect(service.pendingActions()).toEqual([]);
        expect(service.queueSize()).toBe(0);
      });

      it('rejects same-owner transaction-local ABA before invoking the caller updater', async () => {
        const service = getService();
        const action = createMockAction({ id: 'attachment-exact-transaction-aba', entityType: 'attachment' });
        installQueuePreimage(service, action);
        const strictUpdate = installMockQueueBackupStrictUpdate();
        const updater = vi.fn((queue: QueuedAction[]) => queue.filter(item => item.id !== action.id));
        let release!: () => void;
        strictUpdate.mockImplementationOnce(async (_owner, applyUpdate) => {
          await new Promise<void>(resolve => { release = resolve; });
          const queue = applyUpdate([action], { recordFound: true });
          mockQueueBackupState.persistedQueue = queue;
          return { status: 'committed', queue };
        });

        const pending = service.storage.persistExactQueueMutationForOwner('test-user', updater);
        await vi.waitFor(() => expect(release).toBeTypeOf('function'));
        markUnknown(service);
        markActionQueueCurrentOwnerStorageLoadedForTests(service);
        release();

        expect(await pending).toEqual({ status: 'REJECTED_NO_COMMIT' });
        expect(updater).not.toHaveBeenCalled();
        expect(mockQueueBackupState.persistedQueue).toEqual([action]);
        expect(service.pendingActions()).toEqual([action]);
      });

      it.each([
        ['A to B', ['other-user']],
        ['A to B to A', ['other-user', 'test-user']],
      ])('holds a post-commit owner transition for %s', async (_label, owners) => {
        const service = getService();
        const action = createMockAction({ id: `attachment-exact-${owners.length}`, entityType: 'attachment' });
        installQueuePreimage(service, action);
        const strictUpdate = installMockQueueBackupStrictUpdate();
        let release!: () => void;
        let committed!: () => void;
        const didCommit = new Promise<void>(resolve => { committed = resolve; });
        strictUpdate.mockImplementationOnce(async (_owner, applyUpdate) => {
          const queue = applyUpdate([action], { recordFound: true });
          mockQueueBackupState.persistedQueue = queue;
          committed();
          await new Promise<void>(resolve => { release = resolve; });
          return { status: 'committed', queue };
        });

        const pending = service.storage.persistExactQueueMutationForOwner(
          'test-user', queue => queue.filter(item => item.id !== action.id),
        );
        await didCommit;
        for (const owner of owners) {
          setCurrentOwnerUserId(owner);
          markUnknown(service);
          markActionQueueCurrentOwnerStorageLoadedForTests(service);
        }
        release();

        expect(await pending).toEqual({ status: 'COMMITTED_HELD', queue: [] });
        expect(service.pendingActions()).toEqual([action]);
      });

      it('holds an explicitly identified foreign-owner commit without current-view publication', async () => {
        const service = getService();
        const current = createMockAction({ id: 'attachment-exact-current' });
        const foreign = createMockAction({ id: 'attachment-exact-foreign', entityType: 'attachment' });
        service.pendingActions.set([current]); service.queueSize.set(1);
        await mockQueueBackupService.backupQueue([foreign], 'foreign-user');
        markUnknown(service);

        const result = await service.storage.persistExactQueueMutationForOwner(
          'foreign-user', queue => queue.filter(item => item.id !== foreign.id),
        );

        expect(result).toEqual({ status: 'COMMITTED_HELD', queue: [] });
        expect(service.pendingActions()).toEqual([current]);
      });
    });
  });
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
      {
        provide: LocalBackupUiRestorePreActionQueueFenceService,
        useValue: mockLocalBackupUiRestorePreActionQueueFence,
      },
      { provide: WriteGuardService, useValue: mockWriteGuardService },
      { provide: SyncWriterLeaseService, useValue: mockSyncWriterLeaseService },
      { provide: AuthService, useValue: { currentUserId: currentUserIdSignal } },
      { provide: DestroyRef, useValue: destroyRef },
    ],
  });
}
