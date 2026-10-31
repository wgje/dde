import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoggerService } from './logger.service';
import {
  ActionQueueDurableRemovalController,
  type ActionQueueDurableRemovalControllerOptions,
} from './action-queue-durable-removal.controller';
import { ActionQueueService } from './action-queue.service';
import {
  QUEUE_BACKUP_NO_WRITE,
  preserveQueueBackupWithoutWrite,
  QueueBackupService,
  type LegacyQueueReviewItem,
  type QueueBackupRecord,
} from './queue-backup.service';
import type { PreferencePayload, QueuedAction } from './action-queue.types';
import { registerQueueBackupPersonalRestoreWriterSpecs } from './queue-backup-personal-restore-writer.spec-helpers';
import { registerQueueBackupRestoreProviderSpecs } from './queue-backup-restore-provider.spec-helpers';

const DB_NAME = 'nanoflow-queue-backup';
const STORE_NAME = 'queue-backup';
const LEGACY_RECORD_ID = 'nanoflow-queue-backup-v1';
const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function deleteQueueBackupDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error(`Failed to delete ${DB_NAME}`));
    request.onblocked = () => reject(new Error(`Delete blocked for ${DB_NAME}`));
  });
}

function makeAction(id: string): QueuedAction {
  return {
    id,
    operationId: `op-${id}`,
    type: 'update',
    entityType: 'task',
    entityId: id,
    payload: {
      task: {
        id,
        title: id,
        content: '',
        stage: 1,
        parentId: null,
        order: 0,
        rank: 10000,
        status: 'active',
        x: 0,
        y: 0,
        displayId: id,
        createdDate: '2026-06-08T00:00:00.000Z',
      },
      projectId: 'project-1',
    },
    timestamp: 1,
    retryCount: 0,
  };
}

function makePreferenceAction(
  id: string,
  theme: NonNullable<PreferencePayload['preferences']['theme']>,
): QueuedAction {
  return {
    id,
    operationId: `op-${id}`,
    type: 'update',
    entityType: 'preference',
    entityId: 'user-1',
    payload: {
      sourceUserId: 'user-1',
      userId: 'user-1',
      preferences: { theme },
    },
    timestamp: 1,
    syncState: 'pending_sync',
    retryCount: 0,
  };
}

function makeProjectDeleteAction(projectId: string): QueuedAction {
  return {
    id: `delete-${projectId}`,
    operationId: `op-delete-${projectId}`,
    type: 'delete',
    entityType: 'project',
    entityId: projectId,
    payload: {
      projectId,
      sourceUserId: 'user-1',
      userId: 'user-1',
    },
    timestamp: 1,
    retryCount: 0,
  };
}

function makeAttachmentCreateAction(): QueuedAction {
  return {
    id: 'attachment-action',
    operationId: 'attachment-operation',
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
      userId: 'user-1',
      sourceUserId: 'user-1',
    },
    timestamp: 1,
    retryCount: 0,
  };
}

function makeAttachmentTaskUpdateAction(): QueuedAction {
  return {
    ...makeAction('task-1'),
    id: 'attachment-task-update',
    operationId: 'attachment-task-operation',
    payload: {
      ...makeAction('task-1').payload,
      sourceUserId: 'user-1',
      writeIntent: 'task_attachment_update',
    },
  };
}

function makeBlockedByAuthTaskAction(): QueuedAction {
  const base = makeAction('task-auth-resume');
  return {
    ...base,
    operationId: 'op-task-auth-resume',
    payload: {
      ...base.payload,
      sourceUserId: 'user-1',
      writeIntent: 'task_text_update' as const,
    },
    syncState: 'blocked_by_auth',
  };
}

function makeAttachmentSettlementInput(
  action: QueuedAction,
  mode: 'verify-task-update' | 'remove-attachment-create',
) {
  return {
    mode,
    actionId: action.id,
    operationId: action.operationId,
    entityType: action.entityType === 'task' ? 'task' as const : 'attachment' as const,
    type: action.type === 'update' ? 'update' as const : 'create' as const,
    entityId: action.entityId,
    payload: action.payload,
    signal: new AbortController().signal,
    isCurrent: () => true,
  };
}

function createExactSettlementHarness(
  queueBackup: QueueBackupService,
  ownerUserId = 'user-1',
  afterStrictPersistence?: () => void,
): {
  controller: ActionQueueDurableRemovalController;
  applyPersistedCurrentOwnerQueue: ReturnType<typeof vi.fn>;
  traceQueueTransitionReason: ReturnType<typeof vi.fn>;
} {
  let pendingActions: QueuedAction[] = [];
  const applyPersistedCurrentOwnerQueue = vi.fn((queue: QueuedAction[]) => {
    pendingActions = queue;
  });
  const traceQueueTransitionReason = vi.fn();
  const options: ActionQueueDurableRemovalControllerOptions = {
    getPendingActions: () => pendingActions,
    setPendingActions: (queue) => {
      pendingActions = queue;
    },
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
    persistQueueMutationStrictlyForOwner: async (owner, updater) => {
      const result = await queueBackup.updateQueueStrictly(owner, updater);
      afterStrictPersistence?.();
      return result;
    },
    updateQueueBackupStrictlyForOwner: (owner, updater) => queueBackup.updateQueueStrictly(owner, updater),
    settleProjectDeleteSuccessForOwner: vi.fn().mockResolvedValue(0),
    getCurrentOwnerUserId: () => ownerUserId,
    isQueueViewCurrent: () => true,
    isStaleProcess: () => false,
    getStaleProcessPolicy: () => 'settle-owner',
    applyPersistedCurrentOwnerQueue,
    syncSentryContext: vi.fn(),
    warn: vi.fn(),
    warnSafely: vi.fn(),
    traceQueueTransitionReason,
  };
  return {
    controller: new ActionQueueDurableRemovalController(options),
    applyPersistedCurrentOwnerQueue,
    traceQueueTransitionReason,
  };
}

function putQueueBackupRecord(record: QueueBackupRecord): Promise<void> {
  return new Promise((resolve, reject) => {
    const openRequest = indexedDB.open(DB_NAME, 1);
    openRequest.onupgradeneeded = () => {
      const db = openRequest.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    openRequest.onerror = () => reject(openRequest.error ?? new Error('Failed to open queue backup DB'));
    openRequest.onsuccess = () => {
      const db = openRequest.result;
      const transaction = db.transaction([STORE_NAME], 'readwrite');
      transaction.objectStore(STORE_NAME).put(record);
      transaction.oncomplete = () => {
        db.close();
        resolve();
      };
      transaction.onerror = () => {
        db.close();
        reject(transaction.error ?? new Error('Failed to write queue backup record'));
      };
    };
  });
}

describe('QueueBackupService', () => {
  let service: QueueBackupService;

  beforeEach(async () => {
    await deleteQueueBackupDatabase().catch(() => undefined);
    vi.clearAllMocks();

    TestBed.configureTestingModule({
      providers: [
        QueueBackupService,
        {
          provide: LoggerService,
          useValue: {
            category: vi.fn(() => logger),
          },
        },
      ],
    });

    service = TestBed.inject(QueueBackupService);
  });

  afterEach(async () => {
    await deleteQueueBackupDatabase().catch(() => undefined);
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  it('restores the current owner queue backup when it exists', async () => {
    const action = makeAction('task-1');
    await service.backupQueue([action], 'user-1');

    await expect(service.restoreQueue('user-1')).resolves.toEqual([action]);
  });

  it('preserves empty-record metadata when restoring an owner queue snapshot', async () => {
    await service.backupQueue([], 'user-1');

    const snapshot = await service.restoreQueueSnapshot('user-1');

    expect(snapshot).toEqual({
      recordFound: true,
      actions: [],
      savedAt: expect.any(String),
    });
  });

  it('atomically updates an owner queue without dropping concurrent writes', async () => {
    await Promise.all([
      service.updateQueue('user-1', queue => [...queue, makeAction('task-a')]),
      service.updateQueue('user-1', queue => [...queue, makeAction('task-b')]),
    ]);

    const restored = await service.restoreQueue('user-1');

    expect(restored?.map(action => action.id).sort()).toEqual(['task-a', 'task-b']);
  });

  it('exposes an explicit no-write decision for verified current queue state', async () => {
    const queueBackupModule = await import('./queue-backup.service');

    expect(Reflect.get(queueBackupModule, 'QUEUE_BACKUP_NO_WRITE')).toBeTypeOf('symbol');
  });

  it('exposes a distinct exact-current project delete settlement controller API', () => {
    expect(Reflect.get(
      ActionQueueDurableRemovalController.prototype,
      'settleExactCurrentProjectDeleteSuccess',
    )).toBeTypeOf('function');
  });

  it('exposes the exact-current project delete settlement through ActionQueueService', () => {
    expect(Reflect.get(
      ActionQueueService.prototype,
      'settleExactCurrentProjectDeleteSuccess',
    )).toBeTypeOf('function');
  });

  it('completes an explicit no-write decision without put, savedAt drift, or error logging', async () => {
    const action = makeAction('verified-current');
    await service.backupQueue([action], 'user-1');
    const before = await service.restoreQueueSnapshot('user-1');
    const putSpy = vi.spyOn(IDBObjectStore.prototype, 'put');
    logger.error.mockClear();

    const result = await service.updateQueueStrictly(
      'user-1',
      queue => preserveQueueBackupWithoutWrite(queue),
    );
    const after = await service.restoreQueueSnapshot('user-1');

    expect(result).toEqual({ status: 'no-write', queue: [action] });
    expect(putSpy).not.toHaveBeenCalled();
    expect(after).toEqual(before);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it.each(['pending_sync', 'retry_scheduled'] as const)(
    'commits syncing from %s after reopen and later removes only exact A while retaining B',
    async (syncState) => {
    const actionA = { ...makePreferenceAction('preference-a', 'default'), syncState };
    const actionB = makePreferenceAction('preference-b', 'ocean');
    await service.backupQueue([actionA], 'user-1');
    const reopenedService = TestBed.runInInjectionContext(() => new QueueBackupService());
    const harness = createExactSettlementHarness(reopenedService);
    const signal = new AbortController().signal;

    const syncingA = await harness.controller.transitionExactActionToSyncingForOwner(
      'user-1', actionA, signal, () => true,
    );
    if (!syncingA) throw new Error('expected exact syncing commit');
    const afterTransition = await reopenedService.restoreQueueSnapshot('user-1');
    expect(afterTransition?.actions).toEqual([{ ...actionA, syncState: 'syncing' }]);

    await reopenedService.updateQueueStrictly('user-1', queue => [...queue, actionB]);
    await expect(harness.controller.settleExactProcessedActionForOwner(
      'user-1', syncingA, signal, () => true,
    )).resolves.toBe(true);
    const afterSettlement = await reopenedService.restoreQueueSnapshot('user-1');
    expect(afterSettlement?.actions).toEqual([actionB]);
    expect(JSON.parse(localStorage.getItem('nanoflow.action-queue.user-1') ?? '[]')).toEqual([actionB]);
  });

  it('commits syncing from blocked_by_auth after reopen and later removes only exact A', async () => {
    const actionA = makeBlockedByAuthTaskAction();
    const actionB = makePreferenceAction('preference-b', 'ocean');
    await service.backupQueue([actionA], 'user-1');
    const reopenedService = TestBed.runInInjectionContext(() => new QueueBackupService());
    const harness = createExactSettlementHarness(reopenedService);
    const signal = new AbortController().signal;

    const syncingA = await harness.controller.transitionExactActionToSyncingForOwner(
      'user-1', actionA, signal, () => true,
    );
    if (!syncingA) throw new Error('expected blocked_by_auth exact syncing commit');
    const afterTransition = await reopenedService.restoreQueueSnapshot('user-1');
    expect(afterTransition?.actions).toEqual([{ ...actionA, syncState: 'syncing' }]);

    await reopenedService.updateQueueStrictly('user-1', queue => [...queue, actionB]);
    await expect(harness.controller.settleExactProcessedActionForOwner(
      'user-1', syncingA, signal, () => true,
    )).resolves.toBe(true);
    const afterSettlement = await reopenedService.restoreQueueSnapshot('user-1');
    expect(afterSettlement?.actions).toEqual([actionB]);
    expect(JSON.parse(localStorage.getItem('nanoflow.action-queue.user-1') ?? '[]')).toEqual([actionB]);
  });

  it('does not transition blocked_by_auth when the passed exact action is not blocked_by_auth', async () => {
    const latest = makeBlockedByAuthTaskAction();
    const passed = { ...latest, syncState: 'pending_sync' as const };
    await service.backupQueue([latest], 'user-1');
    const before = await service.restoreQueueSnapshot('user-1');
    const putSpy = vi.spyOn(IDBObjectStore.prototype, 'put');
    const harness = createExactSettlementHarness(service);

    await expect(harness.controller.transitionExactActionToSyncingForOwner(
      'user-1', passed, new AbortController().signal, () => true,
    )).resolves.toBeNull();
    expect(putSpy).not.toHaveBeenCalled();
    expect(await service.restoreQueueSnapshot('user-1')).toEqual(before);
    expect(harness.applyPersistedCurrentOwnerQueue).not.toHaveBeenCalled();
  });

  it('does not transition a passed blocked_by_auth action when latest is not blocked_by_auth', async () => {
    const latest = { ...makeBlockedByAuthTaskAction(), syncState: 'pending_sync' as const };
    const passed = { ...latest, syncState: 'blocked_by_auth' as const };
    await service.backupQueue([latest], 'user-1');
    const before = await service.restoreQueueSnapshot('user-1');
    const putSpy = vi.spyOn(IDBObjectStore.prototype, 'put');
    const harness = createExactSettlementHarness(service);

    await expect(harness.controller.transitionExactActionToSyncingForOwner(
      'user-1', passed, new AbortController().signal, () => true,
    )).resolves.toBeNull();
    expect(putSpy).not.toHaveBeenCalled();
    expect(await service.restoreQueueSnapshot('user-1')).toEqual(before);
    expect(harness.applyPersistedCurrentOwnerQueue).not.toHaveBeenCalled();
  });

  it('keeps blocked_by_auth exact identity mismatch and stale fence fail closed without writes', async () => {
    const stored = makeBlockedByAuthTaskAction();
    const replaced = {
      ...stored,
      operationId: 'op-task-auth-resume-replacement',
      payload: {
        ...stored.payload,
        writeIntent: 'task_full_upsert' as const,
      },
    };
    await service.backupQueue([replaced], 'user-1');
    const before = await service.restoreQueueSnapshot('user-1');
    const putSpy = vi.spyOn(IDBObjectStore.prototype, 'put');
    const harness = createExactSettlementHarness(service);

    await expect(harness.controller.transitionExactActionToSyncingForOwner(
      'user-1', stored, new AbortController().signal, () => false,
    )).resolves.toBeNull();
    expect(putSpy).not.toHaveBeenCalled();
    expect(await service.restoreQueueSnapshot('user-1')).toEqual(before);
    expect(harness.applyPersistedCurrentOwnerQueue).not.toHaveBeenCalled();
  });

  it('preserves a same-ID preference replacement without put, savedAt, mirror, or publication drift', async () => {
    const staleAction = makePreferenceAction('preference-same-id', 'default');
    const replacement = {
      ...makePreferenceAction('preference-same-id', 'ocean'),
      operationId: 'op-preference-replacement',
    };
    await service.backupQueue([replacement], 'user-1');
    localStorage.setItem('nanoflow.action-queue.user-1', JSON.stringify([replacement]));
    const before = await service.restoreQueueSnapshot('user-1');
    const beforeMirror = localStorage.getItem('nanoflow.action-queue.user-1');
    const putSpy = vi.spyOn(IDBObjectStore.prototype, 'put');
    const harness = createExactSettlementHarness(service);

    await expect(harness.controller.settleExactProcessedActionForOwner(
      'user-1', { ...staleAction, syncState: 'syncing' },
      new AbortController().signal, () => true,
    )).resolves.toBe(false);
    expect(putSpy).not.toHaveBeenCalled();
    expect(await service.restoreQueueSnapshot('user-1')).toEqual(before);
    expect(localStorage.getItem('nanoflow.action-queue.user-1')).toBe(beforeMirror);
    expect(harness.applyPersistedCurrentOwnerQueue).not.toHaveBeenCalled();
  });

  it('keeps a real syncing transaction failure distinct from intentional no-write', async () => {
    const action = makePreferenceAction('preference-storage-failure', 'default');
    await service.backupQueue([action], 'user-1');
    const before = await service.restoreQueueSnapshot('user-1');
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(() => {
      throw new DOMException('forced syncing failure', 'AbortError');
    });
    const harness = createExactSettlementHarness(service);

    await expect(harness.controller.transitionExactActionToSyncingForOwner(
      'user-1', action, new AbortController().signal, () => true,
    )).resolves.toBeNull();
    expect(await service.restoreQueueSnapshot('user-1')).toEqual(before);
    expect(harness.applyPersistedCurrentOwnerQueue).not.toHaveBeenCalled();
  });

  it.each([
    ['missing-signal', undefined, (): boolean => true, makePreferenceAction('reason-missing-signal', 'default')],
    ['aborted', (() => { const c = new AbortController(); c.abort(); return c.signal; })(), (): boolean => true, makePreferenceAction('reason-aborted', 'default')],
    ['stale-current', new AbortController().signal, (): boolean => false, makePreferenceAction('reason-stale-current', 'default')],
  ])('traces null reason %s exactly once for transition-exact-action-to-syncing-for-owner', async (reason, signal, isCurrent, action) => {
    const runtime = createExactSettlementHarness(service);
    await expect(runtime.controller.transitionExactActionToSyncingForOwner(
      'user-1', action, signal, isCurrent,
    )).resolves.toBeNull();
    expect(runtime.traceQueueTransitionReason).toHaveBeenCalledTimes(1);
    expect(runtime.traceQueueTransitionReason).toHaveBeenCalledWith({
      source: 'transition-exact-action-to-syncing-for-owner',
      reason,
    });
  });

  it.each([
    ['missing action', makePreferenceAction('reason-missing', 'default'), []],
    ['identity mismatch', makeBlockedByAuthTaskAction(), [{
      ...makeBlockedByAuthTaskAction(),
      id: 'reason-identity-mismatch',
      operationId: 'op-reason-identity-mismatch',
    }]],
    ['duplicate action', makePreferenceAction('reason-duplicate', 'default'), [
      makePreferenceAction('reason-duplicate', 'default'),
      { ...makePreferenceAction('reason-duplicate', 'default'), operationId: 'duplicate-operation' },
    ]],
  ])('traces identity-mismatch exactly once without a write for %s', async (_case, stored, persisted) => {
    await service.backupQueue(persisted, 'user-1');
    const before = await service.restoreQueueSnapshot('user-1');
    const runtime = createExactSettlementHarness(service);

    await expect(runtime.controller.transitionExactActionToSyncingForOwner(
      'user-1', stored, new AbortController().signal, () => true,
    )).resolves.toBeNull();
    expect(runtime.traceQueueTransitionReason).toHaveBeenCalledTimes(1);
    expect(runtime.traceQueueTransitionReason).toHaveBeenCalledWith({
      source: 'transition-exact-action-to-syncing-for-owner',
      reason: 'identity-mismatch',
    });
    expect(await service.restoreQueueSnapshot('user-1')).toEqual(before);
    expect(runtime.applyPersistedCurrentOwnerQueue).not.toHaveBeenCalled();
  });

  it('traces already-syncing exactly once without rewriting the persisted action', async () => {
    const action = makeBlockedByAuthTaskAction();
    const syncing = { ...action, syncState: 'syncing' as const };
    await service.backupQueue([syncing], 'user-1');
    const before = await service.restoreQueueSnapshot('user-1');
    const runtime = createExactSettlementHarness(service);

    await expect(runtime.controller.transitionExactActionToSyncingForOwner(
      'user-1', action, new AbortController().signal, () => true,
    )).resolves.toStrictEqual(syncing);
    expect(runtime.traceQueueTransitionReason).toHaveBeenCalledTimes(1);
    expect(runtime.traceQueueTransitionReason).toHaveBeenCalledWith({
      source: 'transition-exact-action-to-syncing-for-owner',
      reason: 'already-syncing',
    });
    expect(await service.restoreQueueSnapshot('user-1')).toEqual(before);
    expect(runtime.applyPersistedCurrentOwnerQueue).not.toHaveBeenCalled();
  });

  it.each([
    ['blocked auth latest mismatch', makeBlockedByAuthTaskAction(), {
      ...makeBlockedByAuthTaskAction(),
      syncState: 'pending_sync' as const,
    }],
    ['ordinary state mismatch', makePreferenceAction('reason-state-not-transitionable', 'default'), {
      ...makePreferenceAction('reason-state-not-transitionable', 'default'),
      syncState: 'held' as never,
    }],
  ])('traces state-not-transitionable exactly once without a write for %s', async (_case, action, persisted) => {
    await service.backupQueue([persisted], 'user-1');
    const before = await service.restoreQueueSnapshot('user-1');
    const runtime = createExactSettlementHarness(service);

    await expect(runtime.controller.transitionExactActionToSyncingForOwner(
      'user-1', action, new AbortController().signal, () => true,
    )).resolves.toBeNull();
    expect(runtime.traceQueueTransitionReason).toHaveBeenCalledTimes(1);
    expect(runtime.traceQueueTransitionReason).toHaveBeenCalledWith({
      source: 'transition-exact-action-to-syncing-for-owner',
      reason: 'state-not-transitionable',
    });
    expect(await service.restoreQueueSnapshot('user-1')).toEqual(before);
    expect(runtime.applyPersistedCurrentOwnerQueue).not.toHaveBeenCalled();
  });

  it('traces persistence-failed exactly once after a real storage failure', async () => {
    const action = makePreferenceAction('reason-persistence-failed', 'default');
    await service.backupQueue([action], 'user-1');
    const before = await service.restoreQueueSnapshot('user-1');
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(() => {
      throw new DOMException('forced transition failure', 'AbortError');
    });
    const runtime = createExactSettlementHarness(service);

    await expect(runtime.controller.transitionExactActionToSyncingForOwner(
      'user-1', action, new AbortController().signal, () => true,
    )).resolves.toBeNull();
    expect(runtime.traceQueueTransitionReason).toHaveBeenCalledTimes(1);
    expect(runtime.traceQueueTransitionReason).toHaveBeenCalledWith({
      source: 'transition-exact-action-to-syncing-for-owner',
      reason: 'persistence-failed',
    });
    expect(await service.restoreQueueSnapshot('user-1')).toEqual(before);
    expect(runtime.applyPersistedCurrentOwnerQueue).not.toHaveBeenCalled();
  });

  it('traces missing-owner-strict-update exactly once without a write', async () => {
    const action = makePreferenceAction('reason-missing-update', 'default');
    await service.backupQueue([action], 'user-1');
    const before = await service.restoreQueueSnapshot('user-1');
    const runtime = createExactSettlementHarness(service);
    const options = {
      ...(runtime.controller as unknown as { options: ActionQueueDurableRemovalControllerOptions }).options,
      updateQueueBackupStrictlyForOwner: undefined,
    };
    const controller = new ActionQueueDurableRemovalController(options);
    const trace = runtime.traceQueueTransitionReason;
    await expect(controller.transitionExactActionToSyncingForOwner(
      'user-1', action, new AbortController().signal, () => true,
    )).resolves.toBeNull();
    expect(trace).toHaveBeenCalledTimes(1);
    expect(trace).toHaveBeenCalledWith({
      source: 'transition-exact-action-to-syncing-for-owner',
      reason: 'missing-owner-strict-update',
    });
    expect(await service.restoreQueueSnapshot('user-1')).toEqual(before);
  });

  it('traces throwing trace sink fail-open without changing transition behavior', async () => {
    const action = makePreferenceAction('reason-sink-throw', 'default');
    await service.backupQueue([action], 'user-1');
    const runtime = createExactSettlementHarness(service);
    runtime.traceQueueTransitionReason.mockImplementation(() => { throw new Error('forced trace sink failure'); });
    await expect(runtime.controller.transitionExactActionToSyncingForOwner(
      'user-1', action, undefined, () => true,
    )).resolves.toBeNull();
  });

  it('verifies an exact-only current project delete without rewriting or publishing the queue', async () => {
    const action = makeProjectDeleteAction('project-exact-only');
    await service.backupQueue([action], 'user-1');
    const before = await service.restoreQueueSnapshot('user-1');
    const harness = createExactSettlementHarness(service);

    const result = await harness.controller.settleExactCurrentProjectDeleteSuccess(
      'user-1', action.entityId, action.id, action.operationId,
    );
    const after = await service.restoreQueueSnapshot('user-1');

    expect(result).toEqual({ status: 'current', removedCount: 0 });
    expect(after).toEqual(before);
    expect(harness.applyPersistedCurrentOwnerQueue).not.toHaveBeenCalled();
  });

  it('commits matching project dependents while retaining the exact delete action', async () => {
    const action = makeProjectDeleteAction('project-1');
    const dependentTask = makeAction('task-dependent');
    const unrelatedTask = {
      ...makeAction('task-unrelated'),
      payload: {
        ...makeAction('task-unrelated').payload,
        projectId: 'project-2',
      },
    };
    await service.backupQueue([action, dependentTask, unrelatedTask], 'user-1');
    const harness = createExactSettlementHarness(service);

    const result = await harness.controller.settleExactCurrentProjectDeleteSuccess(
      'user-1', action.entityId, action.id, action.operationId,
    );
    const after = await service.restoreQueueSnapshot('user-1');

    expect(result).toEqual({ status: 'committed', removedCount: 1 });
    expect(after?.actions).toEqual([action, unrelatedTask]);
    expect(harness.applyPersistedCurrentOwnerQueue).toHaveBeenCalledOnce();
    expect(harness.applyPersistedCurrentOwnerQueue).toHaveBeenCalledWith([action, unrelatedTask]);
  });

  it('reports a missing exact delete without rewriting the owner record', async () => {
    const unrelated = makeAction('task-unrelated');
    await service.backupQueue([unrelated], 'user-1');
    const before = await service.restoreQueueSnapshot('user-1');
    const putSpy = vi.spyOn(IDBObjectStore.prototype, 'put');
    const harness = createExactSettlementHarness(service);

    const result = await harness.controller.settleExactCurrentProjectDeleteSuccess(
      'user-1', 'project-1', 'delete-missing', 'op-delete-missing',
    );
    const after = await service.restoreQueueSnapshot('user-1');

    expect(result).toEqual({ status: 'missing' });
    expect(putSpy).not.toHaveBeenCalled();
    expect(after).toEqual(before);
    expect(harness.applyPersistedCurrentOwnerQueue).not.toHaveBeenCalled();
  });

  it.each([
    {
      reason: 'operation mismatch',
      mutate: (action: QueuedAction) => action,
      operationId: 'wrong-operation',
    },
    {
      reason: 'payload project mismatch',
      mutate: (action: QueuedAction) => ({
        ...action,
        payload: { ...action.payload, projectId: 'project-other' },
      }),
      operationId: 'op-delete-project-1',
    },
  ])('reports $reason without rewriting the owner record', async ({ mutate, operationId }) => {
    const action = mutate(makeProjectDeleteAction('project-1'));
    await service.backupQueue([action], 'user-1');
    const before = await service.restoreQueueSnapshot('user-1');
    const putSpy = vi.spyOn(IDBObjectStore.prototype, 'put');
    const harness = createExactSettlementHarness(service);

    const result = await harness.controller.settleExactCurrentProjectDeleteSuccess(
      'user-1', 'project-1', action.id, operationId,
    );
    const after = await service.restoreQueueSnapshot('user-1');

    expect(result).toEqual({ status: 'identity-mismatch' });
    expect(putSpy).not.toHaveBeenCalled();
    expect(after).toEqual(before);
    expect(harness.applyPersistedCurrentOwnerQueue).not.toHaveBeenCalled();
  });

  it('requires a unique exact action ID without rewriting duplicate evidence', async () => {
    const action = makeProjectDeleteAction('project-1');
    const duplicate = { ...makeAction('duplicate'), id: action.id };
    await service.backupQueue([action, duplicate], 'user-1');
    const before = await service.restoreQueueSnapshot('user-1');
    const putSpy = vi.spyOn(IDBObjectStore.prototype, 'put');
    const harness = createExactSettlementHarness(service);

    const result = await harness.controller.settleExactCurrentProjectDeleteSuccess(
      'user-1', action.entityId, action.id, action.operationId,
    );
    const after = await service.restoreQueueSnapshot('user-1');

    expect(result).toEqual({ status: 'identity-mismatch' });
    expect(putSpy).not.toHaveBeenCalled();
    expect(after).toEqual(before);
  });

  it('preserves protected dependent handoff evidence and reports it distinctly', async () => {
    const action = makeProjectDeleteAction('project-1');
    const protectedDependent = createProtectedAction('held-dependent', 'required');
    await service.backupQueue([action, protectedDependent], 'user-1');
    const before = await service.restoreQueueSnapshot('user-1');
    const harness = createExactSettlementHarness(service);

    const result = await harness.controller.settleExactCurrentProjectDeleteSuccess(
      'user-1', action.entityId, action.id, action.operationId,
    );
    const after = await service.restoreQueueSnapshot('user-1');

    expect(result).toEqual({ status: 'protected-handoff' });
    expect(after).toEqual(before);
    expect(harness.applyPersistedCurrentOwnerQueue).not.toHaveBeenCalled();
  });

  it('keeps a real transaction failure distinct from native no-write', async () => {
    const action = makeProjectDeleteAction('project-1');
    const dependentTask = makeAction('task-dependent');
    await service.backupQueue([action, dependentTask], 'user-1');
    const before = await service.restoreQueueSnapshot('user-1');
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(() => {
      throw new DOMException('forced write failure', 'AbortError');
    });
    const harness = createExactSettlementHarness(service);

    const result = await harness.controller.settleExactCurrentProjectDeleteSuccess(
      'user-1', action.entityId, action.id, action.operationId,
    );
    const after = await service.restoreQueueSnapshot('user-1');

    expect(result).toEqual({ status: 'persistence-failed' });
    expect(after).toEqual(before);
    expect(harness.applyPersistedCurrentOwnerQueue).not.toHaveBeenCalled();
  });

  it('verifies exact attachment task handoff B without rewriting the latest owner queue', async () => {
    const action = makeAttachmentTaskUpdateAction();
    await service.backupQueue([action], 'user-1');
    const before = await service.restoreQueueSnapshot('user-1');
    const putSpy = vi.spyOn(IDBObjectStore.prototype, 'put');
    const harness = createExactSettlementHarness(service);

    const result = await harness.controller.settleAttachmentReplayActionForOwner(
      'user-1',
      makeAttachmentSettlementInput(action, 'verify-task-update'),
    );
    const after = await service.restoreQueueSnapshot('user-1');

    expect(result).toEqual({ status: 'current' });
    expect(putSpy).not.toHaveBeenCalled();
    expect(after).toEqual(before);
    expect(harness.applyPersistedCurrentOwnerQueue).not.toHaveBeenCalled();
  });

  it('reports a stale fence when exact B verification loses its signal after persistence', async () => {
    const action = makeAttachmentTaskUpdateAction();
    await service.backupQueue([action], 'user-1');
    const before = await service.restoreQueueSnapshot('user-1');
    const controller = new AbortController();
    const harness = createExactSettlementHarness(service, 'user-1', () => controller.abort());

    const result = await harness.controller.settleAttachmentReplayActionForOwner(
      'user-1',
      {
        ...makeAttachmentSettlementInput(action, 'verify-task-update'),
        signal: controller.signal,
      },
    );
    const after = await service.restoreQueueSnapshot('user-1');

    expect(result).toEqual({ status: 'fence-stale' });
    expect(after).toEqual(before);
    expect(harness.applyPersistedCurrentOwnerQueue).not.toHaveBeenCalled();
  });

  it('removes only the exact attachment replay A after Blob cleanup', async () => {
    const action = makeAttachmentCreateAction();
    const unrelated = makeAction('unrelated-task');
    await service.backupQueue([action, unrelated], 'user-1');
    const harness = createExactSettlementHarness(service);

    const result = await harness.controller.settleAttachmentReplayActionForOwner(
      'user-1',
      makeAttachmentSettlementInput(action, 'remove-attachment-create'),
    );
    const after = await service.restoreQueueSnapshot('user-1');

    expect(result).toEqual({ status: 'committed' });
    expect(after?.actions).toEqual([unrelated]);
    expect(harness.applyPersistedCurrentOwnerQueue).toHaveBeenCalledWith([unrelated]);
  });

  it('preserves a same-ID attachment replacement when exact replay identity changed', async () => {
    const action = makeAttachmentCreateAction();
    const replacement = {
      ...action,
      operationId: 'replacement-operation',
      payload: {
        ...action.payload,
        fileName: 'replacement.txt',
      },
    };
    await service.backupQueue([replacement], 'user-1');
    const before = await service.restoreQueueSnapshot('user-1');
    const putSpy = vi.spyOn(IDBObjectStore.prototype, 'put');
    const harness = createExactSettlementHarness(service);

    const result = await harness.controller.settleAttachmentReplayActionForOwner(
      'user-1',
      makeAttachmentSettlementInput(action, 'remove-attachment-create'),
    );
    const after = await service.restoreQueueSnapshot('user-1');

    expect(result).toEqual({ status: 'identity-mismatch' });
    expect(putSpy).not.toHaveBeenCalled();
    expect(after).toEqual(before);
  });

  it('classifies an invalid attachment settlement shape as identity mismatch', async () => {
    const action = makeAttachmentCreateAction();
    await service.backupQueue([action], 'user-1');
    const harness = createExactSettlementHarness(service);

    const result = await harness.controller.settleAttachmentReplayActionForOwner(
      'user-1',
      {
        ...makeAttachmentSettlementInput(action, 'remove-attachment-create'),
        mode: 'verify-task-update',
      },
    );

    expect(result).toEqual({ status: 'identity-mismatch' });
  });

  it('keeps attachment A when its exact removal transaction fails', async () => {
    const action = makeAttachmentCreateAction();
    await service.backupQueue([action], 'user-1');
    const before = await service.restoreQueueSnapshot('user-1');
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(() => {
      throw new DOMException('forced attachment settlement failure', 'AbortError');
    });
    const harness = createExactSettlementHarness(service);

    const result = await harness.controller.settleAttachmentReplayActionForOwner(
      'user-1',
      makeAttachmentSettlementInput(action, 'remove-attachment-create'),
    );
    const after = await service.restoreQueueSnapshot('user-1');

    expect(result).toEqual({ status: 'persistence-failed' });
    expect(after).toEqual(before);
    expect(harness.applyPersistedCurrentOwnerQueue).not.toHaveBeenCalled();
  });

  it('reports an existing empty IndexedDB record to queue updaters', async () => {
    const recordFoundFlags: boolean[] = [];

    await service.updateQueue('user-1', (_queue, context) => {
      recordFoundFlags.push(context.recordFound);
      return [];
    });
    await service.updateQueue('user-1', (queue, context) => {
      recordFoundFlags.push(context.recordFound);
      expect(queue).toEqual([]);
      return [makeAction('task-after-empty-record')];
    });

    expect(recordFoundFlags).toEqual([false, true]);
    await expect(service.restoreQueue('user-1')).resolves.toEqual([
      makeAction('task-after-empty-record'),
    ]);
  });

  it('isolates legacy backup actions for review instead of restoring them directly', async () => {
    const action = makeAction('legacy-task');
    await putQueueBackupRecord({
      id: LEGACY_RECORD_ID,
      ownerUserId: '__legacy_unknown__',
      actions: [action],
      savedAt: '2026-06-08T00:00:00.000Z',
    });
    const legacyItems: LegacyQueueReviewItem[] = [];

    const restored = await service.restoreQueue('user-1', items => legacyItems.push(...items));

    expect(restored).toBeNull();
    expect(legacyItems).toEqual([{
      action,
      source: 'legacy-idb-backup',
      capturedAt: '2026-06-08T00:00:00.000Z',
      ownerUserId: '__legacy_unknown__',
    }]);
  });

  it.each([
    ['required', createProtectedAction('protected-required', 'required')],
    ['malformed', createMalformedProtectedAction('protected-malformed')],
  ])('returns a distinct %s result and preserves protected handoff evidence', async (
    reason,
    action,
  ) => {
    await service.backupQueue([action], 'user-1');

    const result = await service.updateQueueStrictly('user-1', () => []);

    expect(result).toEqual({
      status: 'protected-handoff',
      reason,
      actionIds: [action.id],
    });
    await expect(service.restoreQueue('user-1')).resolves.toEqual([action]);
  });

  it('allows only the named full-wipe boundary to bypass protected handoff removal', async () => {
    const action = createProtectedAction('protected-full-wipe', 'required');
    await service.backupQueue([action], 'user-1');

    await expect(service.backupQueue([], 'user-1')).resolves.toBe(false);
    await expect(service.restoreQueue('user-1')).resolves.toEqual([action]);

    await expect(service.clearQueueForFullWipe('user-1')).resolves.toBe(true);
    await expect(service.restoreQueue('user-1')).resolves.toEqual([]);
  });

  registerQueueBackupPersonalRestoreWriterSpecs();
  registerQueueBackupRestoreProviderSpecs();
});

function createProtectedAction(
  id: string,
  state: 'required' | 'reserved' | 'effects-applied' | 'complete',
): QueuedAction {
  const action = makeAction(id);
  return {
    ...action,
    entityType: 'project',
    entityId: 'project-1',
    syncState: 'held' as never,
    localHandoff: {
      kind: 'resolved-project-conflict',
      state,
      ownerUserId: 'user-1',
      projectId: 'project-1',
      actionId: id,
      operationId: action.operationId,
      payloadDigest: 'payload-digest',
      conflictFingerprint: 'conflict-fingerprint',
    },
  } as unknown as QueuedAction;
}

function createMalformedProtectedAction(id: string): QueuedAction {
  return {
    ...createProtectedAction(id, 'required'),
    localHandoff: {
      kind: 'resolved-project-conflict',
      state: 'required',
      actionId: id,
    },
  } as unknown as QueuedAction;
}
