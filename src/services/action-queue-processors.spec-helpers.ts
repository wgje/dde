import { Injector, runInInjectionContext } from '@angular/core';
import { expect, it, vi } from 'vitest';

import {
  createRetryQueueServiceSpecHarness,
  type RetryQueueServiceSpecHarness,
} from '../app/core/services/sync/retry-queue-service.spec-fixture';
import type { RetryQueueItem } from '../app/core/services/sync/retry-queue.service';
import { buildConnectionReplayPayloadSignature } from '../app/core/services/sync/connection-sync-operations.helpers';

import {
  ConnectionSyncOperationsService,
  FocusConsoleSyncService,
  ProjectDataService,
  ProjectDeleteCoordinatorService,
  ProjectSaveFlightCoordinatorService,
  RealtimePollingService,
  RetryQueueEnqueueService,
  RetryQueueService,
  TaskSyncOperationsService,
  UserPreferencesSyncService,
} from '../core-bridge';
import { ActionQueueConnectionProcessorsService } from './action-queue-connection-processors.service';
import { ActionQueueAttachmentProcessorsService } from './action-queue-attachment-processors.service';
import {
  ActionQueueDurableRemovalController,
  type ActionQueueDurableRemovalControllerOptions,
} from './action-queue-durable-removal.controller';
import { ActionQueueProcessorsService } from './action-queue-processors.service';
import { ActionQueueProjectProcessorsService } from './action-queue-project-processors.service';
import { ActionQueueTaskFocusProcessorsService } from './action-queue-task-focus-processors.service';
import type { QueueProcessorContext } from './action-queue-processing.types';
import { ActionQueueService, type ActionQueueProcessorResult } from './action-queue.service';
import type { QueuedAction as QueuedActionModel } from './action-queue.types';
import { AuthService } from './auth.service';
import { ConflictStorageService } from './conflict-storage.service';
import { LoggerService } from './logger.service';
import { ProjectStateService } from './project-state.service';
import { QUEUE_BACKUP_DB_NAME, QueueBackupService } from './queue-backup.service';
import type { TaskWriteIntent } from './sync-rpc-client.service';
import { ToastService } from './toast.service';
import { UserSessionService } from './user-session.service';

export type QueuedAction = Omit<Partial<QueuedActionModel>, 'payload'> & { payload: unknown };
type RegisteredProcessor = (
  action: QueuedActionModel,
  context?: QueueProcessorContext,
) => Promise<ActionQueueProcessorResult>;
export type QueueSettlementSummary = {
  processed: number;
  failed: number;
  movedToDeadLetter: number;
  remaining: number;
  remoteSuccessCount: number;
  resolvedNoOpCount: number;
};
type MockRetryQueueItem = {
  type: 'project' | 'task' | 'connection';
  operation?: 'upsert' | 'delete';
  data: { id: string; syncSource?: string; name?: string; title?: string; source?: string; target?: string };
  sourceUserId: string;
  projectId?: string;
  taskIdsToDelete?: string[];
  writeIntent?: TaskWriteIntent;
  operationId?: string;
};

export const mockLoggerCategory = {
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
};
const mockLoggerService = { category: vi.fn(() => mockLoggerCategory) };

export const mockActionQueueService = {
  registerProcessor: vi.fn(),
  setQueueProcessCallbacks: vi.fn(),
  markActionSyncedRemotely: vi.fn(),
  markActionResolvedWithoutRemote: vi.fn(),
  moveToDeadLetter: vi.fn(),
  deferRetry: vi.fn((error) => ({ outcome: 'defer-retry', error })),
  failRetry: vi.fn((error) => ({ outcome: 'failed', error })),
  discardActions: vi.fn(),
  settleProjectDeleteSuccessForOwner: vi.fn().mockResolvedValue(1),
  settleExactCurrentProjectDeleteSuccess: vi.fn().mockResolvedValue({ status: 'current', removedCount: 0 }),
  enqueueForOwner: vi.fn().mockResolvedValue('queued-owner-action'),
  getCurrentQueueViewGeneration: vi.fn(() => 1),
  getProjectMutationViewGeneration: vi.fn(() => 0),
  isQueueViewCurrent: vi.fn(() => true),
  subscribeToOwnerStorageLoadStateChanges: vi.fn(() => vi.fn()),
  getCurrentOwnerStorageLoadState: vi.fn(() => 'loading' as const),
};

const mockAttachmentProcessors = {
  setupProcessors: vi.fn(() => {
    mockActionQueueService.registerProcessor('attachment:create', vi.fn().mockResolvedValue(true));
  }),
};

export const mockRetryQueueService = {
  removeByProjectIdDurablyForOwner: vi.fn().mockResolvedValue(true),
  getItems: vi.fn(() => []),
  findItemForOwner: vi.fn<(...args: unknown[]) => MockRetryQueueItem | undefined>(() => undefined),
};

// saveProjectSmart 已重命名为 ProjectSaveFlightCoordinatorService.save；二者共享同一 spy 以维持既有断言
const saveProjectResultFn = vi.fn().mockResolvedValue({ success: true, newVersion: 2 });
export const mockSyncService = {
  pauseRealtimeUpdates: vi.fn(),
  resumeRealtimeUpdates: vi.fn(),
  hasPendingRetryRecovery: vi.fn(() => false),
  markSyncRecoveredIfIdle: vi.fn(),
  save: saveProjectResultFn,
  saveProjectSmart: saveProjectResultFn,
  loadFullProjectOptimized: vi.fn().mockResolvedValue(null),
  deleteProjectFromCloud: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
  pushTask: vi.fn().mockResolvedValue(true),
  pushConnection: vi.fn().mockResolvedValue(true),
  buildActionQueueReplayPayloadSignature: vi.fn(buildConnectionReplayPayloadSignature),
  pushConnectionFromActionQueue: vi.fn().mockResolvedValue({ outcome: 'applied' }),
  deleteTask: vi.fn().mockResolvedValue(true),
  saveUserPreferences: vi.fn().mockResolvedValue(true),
  saveFocusSession: vi.fn().mockResolvedValue({ ok: true }),
  upsertRoutineTask: vi.fn().mockResolvedValue({ ok: true }),
  incrementRoutineCompletion: vi.fn().mockResolvedValue({ ok: true }),
};

export const mockProjectStateService = {
  updateProjects: vi.fn(),
  getProject: vi.fn<(projectId: string) => { id: string; syncSource?: string } | undefined>(() => undefined),
  getProjectWithCurrentData: vi.fn<ProjectStateService['getProjectWithCurrentData']>(() => undefined),
};
export const mockAuthService = {
  currentUserId: vi.fn<() => string | null>(() => 'test-user'),
  captureAuthIdentityFence: vi.fn(() => 'auth-fence'),
};
export const mockUserSessionService = {
  getCurrentSessionGeneration: vi.fn(() => 1),
  isSessionContextCurrent: vi.fn(() => true),
};
export const mockConflictStorageService = { saveConflict: vi.fn().mockResolvedValue(true) };
export const mockToastService = { warning: vi.fn(), info: vi.fn(), error: vi.fn(), success: vi.fn() };

/** Retrieve the handler registered for a given action type */
export function getProcessor(type: string): (
  action: QueuedAction,
  context?: QueueProcessorContext,
) => Promise<ActionQueueProcessorResult> {
  const call = mockActionQueueService.registerProcessor.mock.calls.find(
    (c: unknown[]) => c[0] === type,
  ) as [string, RegisteredProcessor] | undefined;
  if (!call) throw new Error(`No processor registered for "${type}"`);
  return call[1] as unknown as (
    action: QueuedAction,
    context?: QueueProcessorContext,
  ) => Promise<ActionQueueProcessorResult>;
}

export function getSettledCallback(): (summary: QueueSettlementSummary) => void {
  const settledCallback = mockActionQueueService.setQueueProcessCallbacks.mock.calls[0]?.[2] as
    | ((summary: QueueSettlementSummary) => void)
    | undefined;

  expect(settledCallback).toBeTypeOf('function');
  if (!settledCallback) {
    throw new Error('Expected queue settled callback to be registered');
  }

  return settledCallback;
}

function resetProcessorHarnessMocks(): void {
  mockAuthService.currentUserId.mockReturnValue('test-user');
  mockAuthService.captureAuthIdentityFence.mockReturnValue('auth-fence');
  mockUserSessionService.getCurrentSessionGeneration.mockReturnValue(1);
  mockUserSessionService.isSessionContextCurrent.mockReturnValue(true);
  mockProjectStateService.getProject.mockReturnValue(undefined);
  mockProjectStateService.getProjectWithCurrentData.mockReturnValue(undefined);
  mockSyncService.saveProjectSmart.mockResolvedValue({ success: true, newVersion: 2 });
  mockSyncService.loadFullProjectOptimized.mockResolvedValue(null);
  mockSyncService.deleteProjectFromCloud.mockResolvedValue({ ok: true, value: undefined });
  mockSyncService.pushTask.mockResolvedValue(true);
  mockSyncService.pushConnection.mockResolvedValue(true);
  mockSyncService.pushConnectionFromActionQueue.mockReset();
  mockSyncService.pushConnectionFromActionQueue.mockResolvedValue({ outcome: 'applied' });
  mockSyncService.deleteTask.mockResolvedValue(true);
  mockSyncService.saveUserPreferences.mockResolvedValue(true);
  mockSyncService.saveFocusSession.mockResolvedValue({ ok: true });
  mockSyncService.upsertRoutineTask.mockResolvedValue({ ok: true });
  mockSyncService.incrementRoutineCompletion.mockResolvedValue({ ok: true });
  mockSyncService.hasPendingRetryRecovery.mockReset();
  mockSyncService.hasPendingRetryRecovery.mockReturnValue(false);
  mockSyncService.markSyncRecoveredIfIdle.mockReset();
  mockRetryQueueService.removeByProjectIdDurablyForOwner.mockReset();
  mockRetryQueueService.removeByProjectIdDurablyForOwner.mockResolvedValue(true);
  mockRetryQueueService.findItemForOwner.mockReset();
  mockRetryQueueService.findItemForOwner.mockReturnValue(undefined);
  mockConflictStorageService.saveConflict.mockResolvedValue(true);
  mockActionQueueService.getCurrentQueueViewGeneration.mockReturnValue(1);
  mockActionQueueService.getProjectMutationViewGeneration.mockReset();
  mockActionQueueService.getProjectMutationViewGeneration.mockReturnValue(0);
  mockActionQueueService.isQueueViewCurrent.mockReset();
  mockActionQueueService.isQueueViewCurrent.mockReturnValue(true);
  mockActionQueueService.getCurrentOwnerStorageLoadState.mockReset();
  mockActionQueueService.getCurrentOwnerStorageLoadState.mockReturnValue('loading');
  mockActionQueueService.settleProjectDeleteSuccessForOwner.mockReset();
  mockActionQueueService.settleProjectDeleteSuccessForOwner.mockResolvedValue(1);
  mockActionQueueService.settleExactCurrentProjectDeleteSuccess.mockReset();
  mockActionQueueService.settleExactCurrentProjectDeleteSuccess.mockResolvedValue({ status: 'current', removedCount: 0 });
}

function createActionQueueProcessorsInjector(): Injector {
  return Injector.create({
    providers: [
      { provide: ActionQueueProcessorsService, useClass: ActionQueueProcessorsService },
      { provide: ActionQueueProjectProcessorsService, useClass: ActionQueueProjectProcessorsService },
      { provide: ActionQueueConnectionProcessorsService, useClass: ActionQueueConnectionProcessorsService },
      { provide: ActionQueueTaskFocusProcessorsService, useClass: ActionQueueTaskFocusProcessorsService },
      { provide: ActionQueueAttachmentProcessorsService, useValue: mockAttachmentProcessors },
      { provide: LoggerService, useValue: mockLoggerService },
      { provide: ActionQueueService, useValue: mockActionQueueService },
      { provide: TaskSyncOperationsService, useValue: mockSyncService },
      { provide: ConnectionSyncOperationsService, useValue: mockSyncService },
      { provide: RealtimePollingService, useValue: mockSyncService },
      { provide: RetryQueueEnqueueService, useValue: mockSyncService },
      { provide: ProjectSaveFlightCoordinatorService, useValue: mockSyncService },
      { provide: ProjectDeleteCoordinatorService, useValue: mockSyncService },
      { provide: ProjectDataService, useValue: mockSyncService },
      { provide: UserPreferencesSyncService, useValue: mockSyncService },
      { provide: FocusConsoleSyncService, useValue: mockSyncService },
      { provide: RetryQueueService, useValue: mockRetryQueueService },
      { provide: ProjectStateService, useValue: mockProjectStateService },
      { provide: AuthService, useValue: mockAuthService },
      { provide: UserSessionService, useValue: mockUserSessionService },
      { provide: ConflictStorageService, useValue: mockConflictStorageService },
      { provide: ToastService, useValue: mockToastService },
    ],
  });
}

export function setupActionQueueProcessorsHarness(): {
  service: ActionQueueProcessorsService;
  injector: Injector;
} {
  vi.clearAllMocks();
  resetProcessorHarnessMocks();

  const injector = createActionQueueProcessorsInjector();
  const service = runInInjectionContext(injector, () => injector.get(ActionQueueProcessorsService));
  service.setProjectConflictHandler(vi.fn());
  service.setupProcessors();

  return { service, injector };
}

export function createRealExactProjectDeleteSettlementHarness(ownerUserId: string): {
  controller: ActionQueueDurableRemovalController;
  queueBackup: QueueBackupService;
  destroy: () => void;
} {
  const injector = Injector.create({
    providers: [
      QueueBackupService,
      { provide: LoggerService, useValue: { category: () => mockLoggerCategory } },
    ],
  });
  const queueBackup = runInInjectionContext(injector, () => injector.get(QueueBackupService));
  let pendingActions: QueuedActionModel[] = [];
  const options: ActionQueueDurableRemovalControllerOptions = {
    getPendingActions: () => pendingActions,
    setPendingActions: queue => { pendingActions = queue; },
    filterPendingActions: predicate => {
      const previousLength = pendingActions.length;
      pendingActions = pendingActions.filter(predicate);
      return previousLength - pendingActions.length;
    },
    mapPendingActions: () => false,
    saveQueueToStorage: vi.fn(),
    persistQueueMutationForOwner: async (owner, updater) => {
      const result = await queueBackup.updateQueueStrictly(owner, updater);
      return result.status === 'committed' || result.status === 'no-write'
        ? result.queue
        : null;
    },
    persistQueueMutationStrictlyForOwner: (owner, updater) =>
      queueBackup.updateQueueStrictly(owner, updater),
    settleProjectDeleteSuccessForOwner: vi.fn().mockResolvedValue(0),
    getCurrentOwnerUserId: () => ownerUserId,
    isQueueViewCurrent: () => true,
    isStaleProcess: () => false,
    getStaleProcessPolicy: () => 'settle-owner',
    applyPersistedCurrentOwnerQueue: queue => { pendingActions = queue; },
    syncSentryContext: vi.fn(),
    warn: vi.fn(),
    warnSafely: vi.fn(),
    traceQueueTransitionReason: vi.fn(),
  };
  return {
    controller: new ActionQueueDurableRemovalController(options),
    queueBackup,
    destroy: () => (injector as Injector & { destroy?: () => void }).destroy?.(),
  };
}

export function deleteProcessorQueueBackupDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(QUEUE_BACKUP_DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('Failed to delete QueueBackup database'));
    request.onblocked = () => reject(new Error('QueueBackup database deletion blocked'));
  });
}

export function registerActionQueueProjectDeleteDurabilitySpecs(): void {
  it('project:delete exact-only settlement uses the real durable no-write path', async () => {
    await deleteProcessorQueueBackupDatabase().catch(() => undefined);
    const harness = createRealExactProjectDeleteSettlementHarness('test-user');
    const action = createProjectDeleteAction(
      'action-project-delete-exact-only', 'project-exact-only', 'operation-project-delete-exact-only',
    );
    await harness.queueBackup.backupQueue([action], 'test-user');
    mockActionQueueService.settleExactCurrentProjectDeleteSuccess.mockImplementationOnce(
      (owner, projectId, actionId, operationId) =>
        harness.controller.settleExactCurrentProjectDeleteSuccess(
          owner,
          projectId,
          actionId,
          operationId,
        ),
    );
    try {
      const result = await getProcessor('project:delete')(action);
      expect(result).toBe(true);
      await expect(harness.queueBackup.restoreQueue('test-user')).resolves.toEqual([action]);
      expect(mockActionQueueService.markActionSyncedRemotely).toHaveBeenCalledWith(action.id);
      expect(mockActionQueueService.settleProjectDeleteSuccessForOwner).not.toHaveBeenCalled();
    } finally {
      harness.destroy();
      await deleteProcessorQueueBackupDatabase().catch(() => undefined);
    }
  });

  it('project:delete defers when fallback-empty cannot prove the retained IDB item absent', async () => {
    await deleteRetryQueueDatabase();
    localStorage.clear();
    const projectId = '55555555-5555-4555-8555-555555555555';
    const ownerUserId = 'test-user';
    const operationId = '11111111-1111-4111-8111-111111111111';
    const action = createProjectDeleteAction(
      'action-project-delete-fallback-empty', projectId, operationId,
    );
    let seedHarness: RetryQueueServiceSpecHarness | null = null;
    let fallbackHarness: RetryQueueServiceSpecHarness | null = null;
    let reopenHarness: RetryQueueServiceSpecHarness | null = null;
    let finalHarness: RetryQueueServiceSpecHarness | null = null;
    try {
      seedHarness = await createRealRetryQueueHarness();
      seedHarness.service.add(
        'project', 'delete', { id: projectId }, projectId, ownerUserId,
        undefined, undefined, undefined, operationId,
      );
      seedHarness.service.add(
        'project', 'delete', { id: projectId }, projectId, 'other-user',
        undefined, undefined, undefined, '22222222-2222-4222-8222-222222222222',
      );
      await expect(seedHarness.service.persistNow()).resolves.toBe(true);
      await destroyRetryQueueHarness(seedHarness);
      seedHarness = null;
      fallbackHarness = await createFallbackLoadedRetryQueueHarness();
      delegateRetryQueueCleanup(fallbackHarness);
      const firstResult = await getProcessor('project:delete')(action);
      expect(firstResult).toEqual(expect.objectContaining({ outcome: 'defer-retry' }));
      expect(mockActionQueueService.settleExactCurrentProjectDeleteSuccess).not.toHaveBeenCalled();
      expect(mockActionQueueService.markActionSyncedRemotely).not.toHaveBeenCalled();
      expect(mockActionQueueService.failRetry).not.toHaveBeenCalled();
      expect(mockActionQueueService.moveToDeadLetter).not.toHaveBeenCalled();
      expect(action.retryCount).toBe(4);
      await destroyRetryQueueHarness(fallbackHarness);
      fallbackHarness = null;
      reopenHarness = await createRealRetryQueueHarness();
      expect(reopenHarness.service.findItemForOwner('project', projectId, ownerUserId))
        .toEqual(expect.objectContaining({ operationId }));
      mockActionQueueService.settleExactCurrentProjectDeleteSuccess.mockClear();
      mockActionQueueService.markActionSyncedRemotely.mockClear();
      delegateRetryQueueCleanup(reopenHarness);
      await expect(getProcessor('project:delete')(action)).resolves.toBe(true);
      expect(mockActionQueueService.settleExactCurrentProjectDeleteSuccess).toHaveBeenCalledOnce();
      expect(mockActionQueueService.markActionSyncedRemotely).toHaveBeenCalledOnce();
      await destroyRetryQueueHarness(reopenHarness);
      reopenHarness = null;
      finalHarness = await createRealRetryQueueHarness();
      expect(finalHarness.service.findItemForOwner('project', projectId, ownerUserId)).toBeUndefined();
      expect(finalHarness.service.findItemForOwner('project', projectId, 'other-user')).toBeTruthy();
    } finally {
      await destroyRetryQueueHarness(finalHarness);
      await destroyRetryQueueHarness(reopenHarness);
      await destroyRetryQueueHarness(fallbackHarness);
      await destroyRetryQueueHarness(seedHarness);
      await deleteRetryQueueDatabase();
    }
  });

  it('post-commit cleanup read rejects a new exact semantic match', async () => {
    const harness = await createFallbackLoadedRetryQueueHarness();
    const initial = createProjectDeleteRetryItem(
      'retry-initial', 'project-semantic-readback', 'test-user',
      '33333333-3333-4333-8333-333333333333',
    );
    const concurrent = createProjectDeleteRetryItem(
      'retry-concurrent', 'project-semantic-readback', 'test-user',
      '44444444-4444-4444-8444-444444444444',
    );
    harness.initDbSpy.mockClear().mockResolvedValue(createRetryQueueReadDb([
      { items: [initial] },
      { items: [concurrent] },
    ]));
    const persistNowSpy = vi.spyOn(harness.service, 'persistNow').mockResolvedValue(true);
    try {
      await expect(harness.service.removeByProjectIdDurablyForOwner(
        'project-semantic-readback',
        'test-user',
      )).resolves.toBe(false);
      expect(persistNowSpy).toHaveBeenCalledOnce();
    } finally {
      await destroyRetryQueueHarness(harness);
    }
  });
}

type RetryQueueReadStep = { items: RetryQueueItem[] };
async function createFallbackLoadedRetryQueueHarness(): Promise<RetryQueueServiceSpecHarness> {
  const harness = createRetryQueueServiceSpecHarness({
    clearLocalStorage: false,
    initDb: async () => null,
    useRealLoadFromStorage: true,
  });
  await flushRetryQueueMicrotasks();
  await harness.service.reloadFromStorageForCurrentOwner();
  return harness;
}
async function createRealRetryQueueHarness(): Promise<RetryQueueServiceSpecHarness> {
  const harness = createRetryQueueServiceSpecHarness({ clearLocalStorage: false });
  await flushRetryQueueMicrotasks();
  harness.loadFromStorageSpy.mockRestore();
  harness.initDbSpy.mockRestore();
  await harness.service.reloadFromStorageForCurrentOwner();
  return harness;
}
async function destroyRetryQueueHarness(harness: RetryQueueServiceSpecHarness | null): Promise<void> {
  if (!harness) return;
  await harness.teardown();
  harness.loadFromStorageSpy.mockRestore();
  harness.initDbSpy.mockRestore();
}
async function flushRetryQueueMicrotasks(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await Promise.resolve();
  }
}

function createRetryQueueReadDb(steps: RetryQueueReadStep[]): IDBDatabase {
  let stepIndex = 0;
  return {
    transaction: () => {
      const step = steps[stepIndex++] ?? { items: [] };
      const request = { result: step.items } as IDBRequest<RetryQueueItem[]>;
      const transaction = {
        objectStore: () => ({
          getAll: () => {
            queueMicrotask(() => {
              request.onsuccess?.call(request, new Event('success'));
              transaction.oncomplete?.call(transaction, new Event('complete'));
            });
            return request;
          },
        }),
      } as unknown as IDBTransaction;
      return transaction;
    },
  } as unknown as IDBDatabase;
}

function createProjectDeleteRetryItem(
  id: string, projectId: string, sourceUserId: string, operationId: string,
): RetryQueueItem {
  return {
    id,
    type: 'project',
    operation: 'delete',
    data: { id: projectId },
    projectId,
    retryCount: 0,
    createdAt: 1,
    sourceUserId,
    operationId,
  };
}

function createProjectDeleteAction(
  id: string, projectId: string, operationId: string,
): QueuedActionModel {
  return {
    id,
    operationId,
    type: 'delete',
    entityType: 'project',
    entityId: projectId,
    payload: { projectId, userId: 'test-user', sourceUserId: 'test-user' },
    timestamp: 1,
    retryCount: 4,
  };
}

function delegateRetryQueueCleanup(harness: RetryQueueServiceSpecHarness): void {
  mockRetryQueueService.removeByProjectIdDurablyForOwner.mockImplementation(
    (projectId, ownerUserId) =>
      harness.service.removeByProjectIdDurablyForOwner(projectId, ownerUserId),
  );
}

function deleteRetryQueueDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase('nanoflow-retry-queue');
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('Failed to delete RetryQueue database'));
    request.onblocked = () => reject(new Error('RetryQueue database deletion blocked'));
  });
}
