import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ActionQueueEnqueueMutationService } from './action-queue-enqueue-mutation.service';
import {
  ActionQueueHeldActionController,
  authorizeDeadLetterHandoff,
  inspectLocalHandoffProtection,
  isDeadLetterHandoffAuthorized,
} from './action-queue-held-action.controller';
import type { EnqueueParams, ProjectPayload, QueuedAction } from './action-queue.types';
import { LoggerService } from './logger.service';
import {
  QUEUE_BACKUP_DB_NAME,
  QUEUE_BACKUP_STORE_NAME,
  QueueBackupService,
  type QueueBackupRecord,
} from './queue-backup.service';
import {
  createProjectConflictHandoffReservationId,
  ProjectOperationConflictRetrySettlementController,
  type ProjectConflictRetrySettlementInput,
} from './project-operation-conflict-retry-settlement.controller';

const RESERVATION_ID = createProjectConflictHandoffReservationId(
  'operation-a', 'payload-digest', 'conflict-fingerprint',
);

describe('ActionQueueHeldActionController', () => {
  it('returns the canonical persisted action and operation identity without scheduling processing', async () => {
    const persisted: QueuedAction[] = [];
    const applyCurrentQueue = vi.fn();
    const controller = createController(persisted, applyCurrentQueue);

    const receipt = await controller.enqueueHeldDurablyForOwner('owner-a', projectAction());

    expect(receipt).toEqual({ actionId: 'action-a', operationId: 'operation-a' });
    expect(persisted).toEqual([
      expect.objectContaining({
        id: 'action-a',
        operationId: 'operation-a',
        syncState: 'held',
      }),
    ]);
    expect(applyCurrentQueue).toHaveBeenCalledWith(persisted);
  });

  it('persists required local-handoff identity in the canonical held action', async () => {
    const persisted: QueuedAction[] = [];
    const controller = createController(persisted, vi.fn());

    const receipt = await controller.enqueueHeldDurablyForOwner(
      'owner-a',
      projectAction(),
      {
        projectId: 'project-1', payloadDigest: 'payload-digest',
        conflictFingerprint: 'conflict-fingerprint',
      },
    );

    expect(receipt).toEqual({ actionId: 'action-a', operationId: 'operation-a' });
    expect(persisted[0]?.localHandoff).toEqual({
      kind: 'resolved-project-conflict', state: 'required', ownerUserId: 'owner-a',
      projectId: 'project-1', actionId: 'action-a', operationId: 'operation-a',
      payloadDigest: 'payload-digest', conflictFingerprint: 'conflict-fingerprint',
    });
  });

  it('keeps an existing same-entity action distinct from held A', async () => {
    const existing = queuedProjectAction({ id: 'action-b', operationId: 'operation-b' });
    const persisted = [existing];
    const controller = createController(persisted, vi.fn());

    const receipt = await controller.enqueueHeldDurablyForOwner('owner-a', projectAction());

    expect(receipt).toEqual({ actionId: 'action-a', operationId: 'operation-a' });
    expect(persisted).toEqual([
      existing,
      expect.objectContaining({ id: 'action-a', operationId: 'operation-a', syncState: 'held' }),
    ]);
  });

  it.each(['required', 'reserved', 'effects-applied'] as const)(
    'rejects %s handoff dead-letter authorization',
    state => {
      const action = protectedAction(state);

      expect(authorizeDeadLetterHandoff(action, '2026-07-29T00:00:00.000Z')).toEqual({
        status: 'protected-handoff',
        reason: state,
        actionIds: [action.id],
      });
    },
  );

  it('rejects malformed handoff distinctly', () => {
    const action = {
      ...protectedAction('required'),
      localHandoff: { kind: 'resolved-project-conflict', state: 'required' },
    } as unknown as QueuedAction;

    expect(inspectLocalHandoffProtection(action)).toEqual({
      status: 'protected-handoff',
      reason: 'malformed',
      actionIds: [action.id],
    });
  });

  it('authorizes a complete handoff with exact action and operation identity', () => {
    const action = protectedAction('complete');

    const result = authorizeDeadLetterHandoff(action, '2026-07-29T00:00:00.000Z');

    expect(result).toEqual({
      status: 'authorized',
      action: expect.objectContaining({
        localHandoff: expect.objectContaining({
          removalAuthorization: {
            kind: 'dead-letter',
            actionId: action.id,
            operationId: action.operationId,
            authorizedAt: '2026-07-29T00:00:00.000Z',
          },
        }),
      }),
    });
    expect(result.status === 'authorized' && isDeadLetterHandoffAuthorized(result.action)).toBe(true);
  });

  it('advances only the exact held action through the strict owner queue', async () => {
    const action = protectedAction('required');
    const concurrent = queuedProjectAction({ id: 'action-b', operationId: 'operation-b' });
    const persisted = [action, concurrent];
    const controller = createController(persisted, vi.fn());

    const result = await controller.transitionLocalHandoffStrictlyForOwner({
      ownerUserId: 'owner-a', actionId: action.id, operationId: action.operationId,
      projectId: 'project-1', payloadDigest: 'payload-digest',
      conflictFingerprint: 'conflict-fingerprint', expectedState: 'required',
      nextState: 'reserved', reservationId: RESERVATION_ID,
      transitionedAt: '2026-07-29T00:01:00.000Z',
    });

    expect(result).toEqual(expect.objectContaining({ status: 'committed' }));
    expect(persisted).toEqual([
      expect.objectContaining({
        id: action.id,
        localHandoff: expect.objectContaining({
          state: 'reserved', reservationId: RESERVATION_ID,
        }),
      }),
      concurrent,
    ]);
  });

  it('rejects a stale handoff identity without changing the strict owner queue', async () => {
    const action = protectedAction('reserved');
    action.localHandoff = { ...action.localHandoff!, reservationId: RESERVATION_ID };
    const persisted = [action];
    const controller = createController(persisted, vi.fn());

    const result = await controller.transitionLocalHandoffStrictlyForOwner({
      ownerUserId: 'owner-a', actionId: action.id, operationId: 'stale-operation',
      projectId: 'project-1', payloadDigest: 'payload-digest',
      conflictFingerprint: 'conflict-fingerprint', expectedState: 'reserved',
      nextState: 'effects-applied', reservationId: RESERVATION_ID,
      transitionedAt: '2026-07-29T00:02:00.000Z',
    });

    expect(result).toEqual({ status: 'identity-mismatch' });
    expect(persisted).toEqual([action]);
  });

  it('removes only completed A and retains concurrent B', async () => {
    const action = protectedAction('complete');
    action.localHandoff = { ...action.localHandoff!, reservationId: RESERVATION_ID };
    const concurrent = queuedProjectAction({ id: 'action-b', operationId: 'operation-b' });
    const persisted = [action, concurrent];
    const controller = createController(persisted, vi.fn());

    const result = await controller.removeCompletedLocalHandoffStrictlyForOwner({
      ownerUserId: 'owner-a', actionId: action.id, operationId: action.operationId,
      projectId: 'project-1', payloadDigest: 'payload-digest',
      conflictFingerprint: 'conflict-fingerprint', reservationId: RESERVATION_ID,
    });

    expect(result).toEqual({ status: 'committed' });
    expect(persisted).toEqual([concurrent]);
  });

  it('treats an already-reached later handoff phase as an idempotent resume', async () => {
    const action = protectedAction('effects-applied');
    action.localHandoff = { ...action.localHandoff!, reservationId: RESERVATION_ID };
    const persisted = [action];
    const controller = createController(persisted, vi.fn());

    const result = await controller.transitionLocalHandoffStrictlyForOwner({
      ownerUserId: 'owner-a', actionId: action.id, operationId: action.operationId,
      projectId: 'project-1', payloadDigest: 'payload-digest',
      conflictFingerprint: 'conflict-fingerprint', expectedState: 'required',
      nextState: 'reserved', reservationId: RESERVATION_ID,
      transitionedAt: '2026-07-29T00:03:00.000Z',
    });

    expect(result).toEqual({ status: 'committed', action });
    expect(persisted).toEqual([action]);
  });

  it('activates exact held A without changing its handoff or concurrent B', async () => {
    const action = protectedAction('reserved');
    action.localHandoff = { ...action.localHandoff!, reservationId: RESERVATION_ID };
    const concurrent = queuedProjectAction({ id: 'action-b', operationId: 'operation-b' });
    const persisted = [action, concurrent];
    const controller = createController(persisted, vi.fn());

    const result = await controller.activateLocalHandoffStrictlyForOwner({
      ownerUserId: 'owner-a', actionId: action.id, operationId: action.operationId,
      projectId: 'project-1', payloadDigest: 'payload-digest',
      conflictFingerprint: 'conflict-fingerprint', reservationId: RESERVATION_ID,
    });

    expect(result).toEqual(expect.objectContaining({ status: 'committed' }));
    expect(persisted).toEqual([
      expect.objectContaining({ id: action.id, syncState: 'pending_sync', localHandoff: action.localHandoff }),
      concurrent,
    ]);
  });

  it('does not synthesize a noncanonical reservation into required A', async () => {
    const action = protectedAction('required');
    const persisted = [action];
    const applyCurrentQueue = vi.fn();
    const controller = createController(persisted, applyCurrentQueue);

    const result = await controller.transitionLocalHandoffStrictlyForOwner({
      ownerUserId: 'owner-a', actionId: action.id, operationId: action.operationId,
      projectId: 'project-1', payloadDigest: 'payload-digest',
      conflictFingerprint: 'conflict-fingerprint', expectedState: 'required',
      nextState: 'reserved', reservationId: 'noncanonical',
      transitionedAt: '2026-07-29T00:04:00.000Z',
    });

    expect(result).toEqual({ status: 'identity-mismatch' });
    expect(persisted).toEqual([action]);
    expect(applyCurrentQueue).not.toHaveBeenCalled();
  });

  it('does not activate required A before its canonical reservation is durable', async () => {
    const action = protectedAction('required');
    const persisted = [action];
    const applyCurrentQueue = vi.fn();
    const controller = createController(persisted, applyCurrentQueue);

    const result = await controller.activateLocalHandoffStrictlyForOwner({
      ownerUserId: 'owner-a', actionId: action.id, operationId: action.operationId,
      projectId: 'project-1', payloadDigest: 'payload-digest',
      conflictFingerprint: 'conflict-fingerprint', reservationId: RESERVATION_ID,
    });

    expect(result).toEqual({ status: 'state-mismatch' });
    expect(persisted).toEqual([action]);
    expect(applyCurrentQueue).not.toHaveBeenCalled();
  });
});

describe('ActionQueueHeldActionController strict IndexedDB mutations', () => {
  let queueBackup: QueueBackupService;

  beforeEach(async () => {
    await deleteQueueBackupDatabase().catch(() => undefined);
    TestBed.configureTestingModule({ providers: [
      QueueBackupService,
      { provide: LoggerService, useValue: { category: () => ({
        debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
      }) } },
    ] });
    queueBackup = TestBed.inject(QueueBackupService);
  });

  afterEach(async () => {
    await deleteQueueBackupDatabase().catch(() => undefined);
    TestBed.resetTestingModule();
  });

  it('publishes a canonical forward transition only after latest-IDB commit', async () => {
    const action = protectedAction('required');
    await putQueueBackupRecord([action], 'seed-forward');
    const applyCurrentQueue = vi.fn();
    const controller = createPersistentController(queueBackup, applyCurrentQueue);

    const result = await controller.transitionLocalHandoffStrictlyForOwner({
      ...identity(action), expectedState: 'required', nextState: 'reserved',
      transitionedAt: '2026-07-29T00:05:00.000Z',
    });
    const snapshot = await queueBackup.restoreQueueSnapshot('owner-a');

    expect(result).toEqual(expect.objectContaining({ status: 'committed' }));
    expect(snapshot?.actions[0]?.localHandoff).toEqual(expect.objectContaining({
      state: 'reserved', reservationId: RESERVATION_ID,
    }));
    expect(snapshot?.savedAt).not.toBe('seed-forward');
    expect(applyCurrentQueue).toHaveBeenCalledOnce();
  });

  it('keeps reopened IDB bytes and savedAt unchanged for canonical idempotent resume', async () => {
    const action = protectedAction('effects-applied');
    action.localHandoff = { ...action.localHandoff!, reservationId: RESERVATION_ID };
    await putQueueBackupRecord([action], 'seed-idempotent');
    const applyCurrentQueue = vi.fn();
    const controller = createPersistentController(queueBackup, applyCurrentQueue);
    const before = await readQueueBackupRecord();

    const result = await controller.transitionLocalHandoffStrictlyForOwner({
      ...identity(action), expectedState: 'required', nextState: 'reserved',
      transitionedAt: '2026-07-29T00:06:00.000Z',
    });
    const after = await readQueueBackupRecord();

    expect(result).toEqual({ status: 'committed', action });
    expect(after).toEqual(before);
    expect(applyCurrentQueue).not.toHaveBeenCalled();
  });

  it('keeps malformed reservation bytes unchanged without mirror publication', async () => {
    const action = protectedAction('reserved');
    action.localHandoff = { ...action.localHandoff!, reservationId: '' };
    await putQueueBackupRecord([action], 'seed-malformed');
    const applyCurrentQueue = vi.fn();
    const controller = createPersistentController(queueBackup, applyCurrentQueue);
    const before = await readQueueBackupRecord();

    const result = await controller.activateLocalHandoffStrictlyForOwner(identity(action));
    const after = await readQueueBackupRecord();

    expect(result).toEqual({ status: 'identity-mismatch' });
    expect(after).toEqual(before);
    expect(applyCurrentQueue).not.toHaveBeenCalled();
  });

  it('keeps required queue bytes unchanged when the conflict reservation is missing', async () => {
    const action = protectedAction('required');
    await putQueueBackupRecord([action], 'seed-required-missing');
    const applyCurrentQueue = vi.fn();
    const controller = createPersistentController(queueBackup, applyCurrentQueue);
    const harness = createMissingReservationSettlement(controller);
    const before = await readQueueBackupRecord();

    const result = await harness.settlement.settle(settlementInput(action));
    const after = await readQueueBackupRecord();

    expect(result).toBe('retry');
    expect(harness.transition).not.toHaveBeenCalled();
    expect(harness.remove).toHaveBeenCalledOnce();
    expect(harness.persistSnapshot).not.toHaveBeenCalled();
    expect(harness.publish).not.toHaveBeenCalled();
    expect(after).toEqual(before);
    expect(applyCurrentQueue).not.toHaveBeenCalled();
  });

  it('removes exact complete A once when the conflict reservation is missing', async () => {
    const action = protectedAction('complete');
    action.localHandoff = { ...action.localHandoff!, reservationId: RESERVATION_ID };
    await putQueueBackupRecord([action], 'seed-complete-missing');
    const controller = createPersistentController(queueBackup, vi.fn());
    const harness = createMissingReservationSettlement(controller);

    const result = await harness.settlement.settle(settlementInput(action));
    const after = await readQueueBackupRecord();

    expect(result).toBe('complete');
    expect(harness.transition).not.toHaveBeenCalled();
    expect(harness.remove).toHaveBeenCalledOnce();
    expect(after?.actions).toEqual([]);
    expect(after?.savedAt).not.toBe('seed-complete-missing');
  });

  it('keeps complete bytes and savedAt unchanged when strict removal identity mismatches', async () => {
    const action = protectedAction('complete');
    action.localHandoff = { ...action.localHandoff!, reservationId: RESERVATION_ID };
    await putQueueBackupRecord([action], 'seed-remove-mismatch');
    const applyCurrentQueue = vi.fn();
    const controller = createPersistentController(queueBackup, applyCurrentQueue);
    const before = await readQueueBackupRecord();

    const result = await controller.removeCompletedLocalHandoffStrictlyForOwner({
      ...identity(action), operationId: 'stale-operation',
    });
    const after = await readQueueBackupRecord();

    expect(result).toEqual({ status: 'identity-mismatch' });
    expect(after).toEqual(before);
    expect(applyCurrentQueue).not.toHaveBeenCalled();
  });

  it('keeps real strict removal transaction abort classified as storage-failed', async () => {
    const action = protectedAction('complete');
    action.localHandoff = { ...action.localHandoff!, reservationId: RESERVATION_ID };
    await putQueueBackupRecord([action], 'seed-remove-abort');
    const controller = createPersistentController(queueBackup, vi.fn());
    const originalPut = IDBObjectStore.prototype.put;
    const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
      const request = originalPut.apply(this, args as Parameters<IDBObjectStore['put']>);
      this.transaction.abort();
      return request;
    });

    const result = await controller.removeCompletedLocalHandoffStrictlyForOwner(identity(action));
    put.mockRestore();

    expect(result).toEqual({ status: 'storage-failed' });
    expect(await readQueueBackupRecord()).toEqual(expect.objectContaining({
      savedAt: 'seed-remove-abort', actions: [action],
    }));
  });

  it('does not translate a real transaction abort into intentional idempotence', async () => {
    const action = protectedAction('required');
    await putQueueBackupRecord([action], 'seed-abort');
    const controller = createPersistentController(queueBackup, vi.fn());
    const originalPut = IDBObjectStore.prototype.put;
    const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
      const request = originalPut.apply(this, args as Parameters<IDBObjectStore['put']>);
      this.transaction.abort();
      return request;
    });

    const result = await controller.transitionLocalHandoffStrictlyForOwner({
      ...identity(action), expectedState: 'required', nextState: 'reserved',
      transitionedAt: '2026-07-29T00:07:00.000Z',
    });
    put.mockRestore();

    expect(result).toEqual({ status: 'storage-failed' });
    expect(await readQueueBackupRecord()).toEqual(expect.objectContaining({
      savedAt: 'seed-abort', actions: [action],
    }));
  });
});

function createMissingReservationSettlement(controller: ActionQueueHeldActionController) {
  const transition = vi.spyOn(controller, 'transitionLocalHandoffStrictlyForOwner');
  const remove = vi.spyOn(controller, 'removeCompletedLocalHandoffStrictlyForOwner');
  const persistSnapshot = vi.fn(async () => true);
  const publish = vi.fn();
  const settlement = new ProjectOperationConflictRetrySettlementController({
    isFenceCurrent: () => true,
    reserveConflictLocalHandoff: async () => ({ status: 'missing' }),
    transitionActionLocalHandoff: input => controller.transitionLocalHandoffStrictlyForOwner(input),
    verifyConflictReservation: async () => ({ status: 'missing' }),
    advanceConflictLocalHandoff: async () => ({ status: 'missing' }),
    persistOwnerSnapshot: persistSnapshot,
    publishResolvedProject: publish,
    clearCompletedConflict: async () => false,
    removeCompletedAction: input => controller.removeCompletedLocalHandoffStrictlyForOwner(input),
    now: () => '2026-07-29T00:10:00.000Z',
  });
  return { settlement, transition, remove, persistSnapshot, publish };
}

function settlementInput(action: QueuedAction): ProjectConflictRetrySettlementInput {
  const payload = projectAction().payload as ProjectPayload;
  return {
    ...identity(action), sessionGeneration: 7, authFence: 'opaque-fence-a',
    resolvedProject: payload.project,
  };
}

function createController(persisted: QueuedAction[], applyCurrentQueue: (queue: QueuedAction[]) => void) {
  const mutations = {
    buildCurrentOwnerEnqueueMutation: (
      queue: QueuedAction[],
      _action: EnqueueParams,
      queuedAction: QueuedAction,
    ) => ({
      nextQueue: [...queue, queuedAction],
      resolvedActionId: queuedAction.id,
      wasEnqueued: true,
      wasMergeShrunk: false,
    }),
  } as ActionQueueEnqueueMutationService;
  return new ActionQueueHeldActionController({
    createQueuedAction: () => queuedProjectAction(),
    getCurrentOwnerUserId: () => 'owner-a',
    persistQueueMutationStrictlyForOwner: async (_ownerUserId, updater) => {
      try {
        persisted.splice(0, persisted.length, ...updater(persisted));
        return { status: 'committed', queue: persisted } as const;
      } catch {
        return { status: 'storage-failed' } as const;
      }
    },
    buildCurrentOwnerEnqueueMutation: (queue, action, queuedAction) =>
      mutations.buildCurrentOwnerEnqueueMutation(queue, action, queuedAction),
    buildForeignOwnerEnqueueMutation: (queue, action, queuedAction) =>
      mutations.buildCurrentOwnerEnqueueMutation(queue, action, queuedAction),
    applyPersistedCurrentOwnerQueue: applyCurrentQueue,
  });
}

function createPersistentController(
  queueBackup: QueueBackupService,
  applyCurrentQueue: (queue: QueuedAction[]) => void,
): ActionQueueHeldActionController {
  const mutations = {
    buildCurrentOwnerEnqueueMutation: (
      queue: QueuedAction[], _action: EnqueueParams, queuedAction: QueuedAction,
    ) => ({
      nextQueue: [...queue, queuedAction], resolvedActionId: queuedAction.id,
      wasEnqueued: true, wasMergeShrunk: false,
    }),
  } as ActionQueueEnqueueMutationService;
  return new ActionQueueHeldActionController({
    createQueuedAction: () => queuedProjectAction(),
    getCurrentOwnerUserId: () => 'owner-a',
    persistQueueMutationStrictlyForOwner: (ownerUserId, updater) =>
      queueBackup.updateQueueStrictly(ownerUserId, updater),
    buildCurrentOwnerEnqueueMutation: (queue, action, queuedAction) =>
      mutations.buildCurrentOwnerEnqueueMutation(queue, action, queuedAction),
    buildForeignOwnerEnqueueMutation: (queue, action, queuedAction) =>
      mutations.buildCurrentOwnerEnqueueMutation(queue, action, queuedAction),
    applyPersistedCurrentOwnerQueue: applyCurrentQueue,
  });
}

function identity(action: QueuedAction) {
  return {
    ownerUserId: 'owner-a', projectId: 'project-1', actionId: action.id,
    operationId: action.operationId, payloadDigest: 'payload-digest',
    conflictFingerprint: 'conflict-fingerprint', reservationId: RESERVATION_ID,
  };
}

function deleteQueueBackupDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(QUEUE_BACKUP_DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('queue backup delete failed'));
    request.onblocked = () => reject(new Error('queue backup delete blocked'));
  });
}

function putQueueBackupRecord(actions: QueuedAction[], savedAt: string): Promise<void> {
  return withQueueBackupStore('readwrite', store => {
    store.put({
      id: 'queue-backup:owner-a', ownerUserId: 'owner-a', actions, savedAt,
    } satisfies QueueBackupRecord);
  });
}

function readQueueBackupRecord(): Promise<QueueBackupRecord | undefined> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(QUEUE_BACKUP_DB_NAME, 1);
    request.onerror = () => reject(request.error ?? new Error('queue backup open failed'));
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction([QUEUE_BACKUP_STORE_NAME], 'readonly');
      const get = transaction.objectStore(QUEUE_BACKUP_STORE_NAME).get('queue-backup:owner-a');
      let record: QueueBackupRecord | undefined;
      get.onsuccess = () => { record = get.result as QueueBackupRecord | undefined; };
      get.onerror = () => reject(get.error ?? new Error('queue backup read failed'));
      transaction.oncomplete = () => { db.close(); resolve(record); };
    };
  });
}

function withQueueBackupStore(
  mode: IDBTransactionMode,
  mutate: (store: IDBObjectStore) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(QUEUE_BACKUP_DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(
      QUEUE_BACKUP_STORE_NAME, { keyPath: 'id' },
    );
    request.onerror = () => reject(request.error ?? new Error('queue backup open failed'));
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction([QUEUE_BACKUP_STORE_NAME], mode);
      mutate(transaction.objectStore(QUEUE_BACKUP_STORE_NAME));
      transaction.oncomplete = () => { db.close(); resolve(); };
      transaction.onerror = () => { db.close(); reject(transaction.error); };
      transaction.onabort = () => { db.close(); reject(transaction.error); };
    };
  });
}

function projectAction(): EnqueueParams {
  return {
    type: 'update',
    entityType: 'project',
    entityId: 'project-1',
    operationId: 'operation-a',
    payload: {
      project: {
        id: 'project-1',
        name: 'Project',
        description: '',
        createdDate: '2026-07-29T00:00:00.000Z',
        tasks: [],
        connections: [],
      },
      sourceUserId: 'owner-a',
    },
  };
}

function queuedProjectAction(overrides: Partial<QueuedAction> = {}): QueuedAction {
  return {
    id: 'action-a',
    operationId: 'operation-a',
    type: 'update',
    entityType: 'project',
    entityId: 'project-1',
    payload: projectAction().payload,
    timestamp: 1,
    localCommittedAt: 1,
    syncState: 'pending_sync',
    retryCount: 0,
    priority: 'critical',
    ...overrides,
  } as QueuedAction;
}

function protectedAction(
  state: 'required' | 'reserved' | 'effects-applied' | 'complete',
): QueuedAction {
  const action = queuedProjectAction({ syncState: 'held' });
  return {
    ...action,
    localHandoff: {
      kind: 'resolved-project-conflict',
      state,
      ownerUserId: 'owner-a',
      projectId: 'project-1',
      actionId: action.id,
      operationId: action.operationId,
      payloadDigest: 'payload-digest',
      conflictFingerprint: 'conflict-fingerprint',
    },
  };
}
