import { describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { runInInjectionContext } from '@angular/core';

import { createMockDestroyRef } from '../../../../test-setup.mocks';
import { ActionQueueService } from '../../../../services/action-queue.service';
import type {
  EnqueueParams,
  QueuedAction,
  RetryQueueSupersessionReservation,
} from '../../../../services/action-queue.types';
import {
  ActionQueueRetrySupersessionController,
  type ActionQueueRetrySupersessionControllerOptions,
} from '../../../../services/action-queue-retry-supersession.controller';
import {
  mockQueueBackupService,
  mockQueueBackupState,
  mockRetryQueueService,
  mockSyncWriterLeaseService,
  resetActionQueueServiceMocks,
} from '../../../../services/action-queue-service-test-harness.spec-helpers';
import {
  RetryQueueActionQueueSupersessionController,
} from './retry-queue-action-queue-supersession.controller';
import {
  createRetryQueueActionQueueSupersessionBridge,
  createSupersessionActionQueueTestInjector,
  createSupersessionLease,
  currentSupersessionIdentity,
  registerEmptyRetrySelectionSupersessionSpecs,
} from './retry-queue-operation-id-replay.spec-helpers';
import type { RetryQueueItem } from './retry-queue.types';
import { createTask } from './retry-queue-test-data.spec-helpers';
import { createRetryQueueServiceSpecHarness } from './retry-queue-service.spec-fixture';

const OWNER = 'owner-a';
const ENTITY_ID = '10000000-0000-4000-8000-000000000001';
const ACTION_ID = '10000000-0000-4000-8000-000000000002';
const ACTION_OPERATION_ID = '10000000-0000-4000-8000-000000000003';
const RETRY_ID = '10000000-0000-4000-8000-000000000004';
const RETRY_OPERATION_ID = '10000000-0000-4000-8000-000000000005';
const TOKEN = '10000000-0000-4000-8000-000000000006';

function reservation(): RetryQueueSupersessionReservation {
  return {
    token: TOKEN,
    ownerUserId: OWNER,
    entityType: 'task',
    entityId: ENTITY_ID,
    actionId: ACTION_ID,
    actionOperationId: ACTION_OPERATION_ID,
    retryItems: [{ id: RETRY_ID, operationId: RETRY_OPERATION_ID }],
  };
}

function retryItem(): RetryQueueItem {
  return {
    id: RETRY_ID,
    type: 'task',
    operation: 'upsert',
    data: { id: ENTITY_ID } as RetryQueueItem['data'],
    projectId: 'project-a',
    retryCount: 0,
    createdAt: 1,
    sourceUserId: OWNER,
    operationId: RETRY_OPERATION_ID,
    actionQueueSupersessions: [reservation()],
  };
}

function reservationForItem(item: Pick<RetryQueueItem, 'id' | 'operationId'>): RetryQueueSupersessionReservation {
  return { ...reservation(), retryItems: [{ id: item.id, operationId: item.operationId }] };
}

function action(): QueuedAction {
  return {
    id: ACTION_ID,
    operationId: ACTION_OPERATION_ID,
    type: 'update',
    entityType: 'task',
    entityId: ENTITY_ID,
    payload: { task: { id: ENTITY_ID }, projectId: 'project-a' } as QueuedAction['payload'],
    timestamp: 1,
    retryCount: 0,
    retryQueueSupersessions: [reservation()],
  };
}

async function createLoadedRetryQueueHarness(clearLocalStorage = true) {
  vi.restoreAllMocks();
  const harness = createRetryQueueServiceSpecHarness({ clearLocalStorage, useRealLoadFromStorage: true });
  harness.initDbSpy.mockRestore();
  harness.loadFromStorageSpy.mockRestore();
  harness.authServiceMock.currentUserId.mockReturnValue(OWNER);
  await (harness.service as unknown as { loadFromStorage(): Promise<void> }).loadFromStorage();
  return harness;
}

async function runRegisteredProcessorCase(actionCount: number): Promise<string[]> {
  localStorage.clear();
  vi.clearAllMocks();
  resetActionQueueServiceMocks();
  Object.defineProperty(navigator, 'onLine', {
    value: false,
    writable: true,
    configurable: true,
  });
  mockQueueBackupState.recordFound = true;
  const retryQueueMethods = mockRetryQueueService as unknown as Record<string, unknown>;
  const queueBackupMethods = mockQueueBackupService as unknown as Record<string, unknown>;
  const previousRetrySupersessionMethods = {
    configureActionQueueSupersessionBridge:
      retryQueueMethods.configureActionQueueSupersessionBridge,
    inspectActionQueueSupersessionTargets:
      retryQueueMethods.inspectActionQueueSupersessionTargets,
    reserveActionQueueSupersession: retryQueueMethods.reserveActionQueueSupersession,
    settleActionQueueSupersessions: retryQueueMethods.settleActionQueueSupersessions,
  };
  const previousRestoreQueueSnapshot = queueBackupMethods.restoreQueueSnapshot;
  const events: string[] = [];
  let leaseSequence = 0;
  const updateQueueStrictly = vi.fn(async (
    _ownerUserId: string,
    updater: (queue: QueuedAction[]) => QueuedAction[],
  ) => {
    const previous = mockQueueBackupState.persistedQueue;
    const next = updater(previous);
    const previousTokens = previous.flatMap(current => current.retryQueueSupersessions ?? []);
    const nextTokens = next.flatMap(current => current.retryQueueSupersessions ?? []);
    if (nextTokens.length > previousTokens.length) {
      events.push('b-reserved');
    } else if (nextTokens.length < previousTokens.length) {
      const settled = previous.find(current =>
        current.retryQueueSupersessions?.length
        && !next.find(candidate => candidate.id === current.id)?.retryQueueSupersessions?.length);
      events.push(`b-settled:${settled?.entityId}`);
    }
    mockQueueBackupState.persistedQueue = next;
    mockQueueBackupState.recordFound = true;
    return { status: 'committed' as const, queue: next };
  });
  const strictUpdateDescriptor = Object.getOwnPropertyDescriptor(
    mockQueueBackupService,
    'updateQueueStrictly',
  );
  Object.defineProperty(mockQueueBackupService, 'updateQueueStrictly', {
    configurable: true,
    get: () => updateQueueStrictly,
  });
  Object.assign(mockQueueBackupService, {
    restoreQueueSnapshot: vi.fn(async () => ({
      recordFound: true,
      actions: mockQueueBackupState.persistedQueue,
      savedAt: 'now',
    })),
  });
  Object.assign(mockRetryQueueService, {
    configureActionQueueSupersessionBridge: vi.fn(),
    inspectActionQueueSupersessionTargets: vi.fn((current: QueuedAction) => ({
      status: 'ready',
      retryItems: [{ id: current.entityId, operationId: RETRY_OPERATION_ID }],
    })),
    reserveActionQueueSupersession: vi.fn(async (current: RetryQueueSupersessionReservation) => {
      events.push(`reserve:${current.entityId}`);
      return true;
    }),
    settleActionQueueSupersessions: vi.fn(async (current: QueuedAction) => {
      events.push(`settle:${current.entityId}`);
      return true;
    }),
  });
  mockSyncWriterLeaseService.isFeatureEnabled.mockReturnValue(true);
  mockSyncWriterLeaseService.requestLease.mockImplementation(async () => {
    leaseSequence += 1;
    const sequence = leaseSequence;
    events.push(`lease-acquire:${sequence}`);
    return {
      tabId: `tab-${sequence}`,
      lockName: `global-${sequence}`,
      mode: 'idb-lease' as const,
      signal: new AbortController().signal,
      release: vi.fn(async () => { events.push(`lease-release:${sequence}`); }),
    };
  });
  const { destroyRef, destroy } = createMockDestroyRef();
  const injector = createSupersessionActionQueueTestInjector(OWNER, destroyRef);
  const service = runInInjectionContext(injector, () => injector.get(ActionQueueService));
  try {
    await service.reloadFromStorageForCurrentOwner();
    await vi.waitFor(() => expect(service.getCurrentOwnerStorageLoadState()).toBe('loaded'));
    events.length = 0;
    leaseSequence = 0;
    mockSyncWriterLeaseService.requestLease.mockClear();
    service.storage.isOnline = false;
    const actions: EnqueueParams[] = Array.from({ length: actionCount }, (_value, index) => {
      const task = createTask(`registered-${actionCount}-${index}`);
      return {
        type: 'update',
        entityType: 'task',
        entityId: task.id,
        operationId: `10000000-0000-4000-8000-00000000002${index}`,
        payload: { task, projectId: 'project-a' },
      };
    });
    if (actionCount === 1) {
      await service.enqueueDurably(actions[0]);
    } else {
      await service.enqueueManyDurably(actions);
    }
    service.registerProcessor('task:update', async current => {
      events.push(`processor:${current.entityId}`);
      return true;
    });
    service.storage.isOnline = true;
    await service.processQueue();
    for (const current of actions) {
      expect(events.indexOf(`settle:${current.entityId}`))
        .toBeLessThan(events.indexOf(`b-settled:${current.entityId}`));
      expect(events.indexOf(`b-settled:${current.entityId}`))
        .toBeLessThan(events.indexOf(`processor:${current.entityId}`));
    }
    expect(events.indexOf('lease-release:1')).toBeLessThan(events.indexOf('lease-acquire:2'));
    return events;
  } finally {
    service.reset();
    destroy();
    Object.assign(mockRetryQueueService, previousRetrySupersessionMethods);
    Object.assign(mockQueueBackupService, {
      restoreQueueSnapshot: previousRestoreQueueSnapshot,
    });
    if (strictUpdateDescriptor) {
      Object.defineProperty(mockQueueBackupService, 'updateQueueStrictly', strictUpdateDescriptor);
    }
  }
}

describe('registered ActionQueue processor supersession ordering', () => {
  it.each([
    ['single', 1],
    ['batch', 2],
  ] as const)('orders %s reservation and settlement before processor dispatch', async (_label, count) => {
    const events = await runRegisteredProcessorCase(count);
    const reservations = events.filter(event => event.startsWith('reserve:'));

    expect(reservations).toHaveLength(count);
    expect(events.indexOf(reservations.at(-1) ?? '')).toBeLessThan(events.indexOf('b-reserved'));
  });
});

describe('RetryQueue / ActionQueue supersession boundary', () => {
  it('defers a reserved retry item when the exact B token is durable', async () => {
    const clearOrphans = vi.fn().mockResolvedValue(true);
    const controller = new RetryQueueActionQueueSupersessionController({
      getBridge: () => createRetryQueueActionQueueSupersessionBridge(OWNER, [action()]),
      clearOrphanReservations: clearOrphans,
    });

    await expect(controller.beforeReplay(retryItem(), createSupersessionLease())).resolves.toBe('defer');
    const untagged = retryItem();
    delete untagged.actionQueueSupersessions;
    await expect(controller.beforeReplay(untagged, createSupersessionLease())).resolves.toBe('defer');
    expect(clearOrphans).not.toHaveBeenCalled();
  });

  it('clears an orphan only after authoritative absence under the live lease', async () => {
    const clearOrphans = vi.fn().mockResolvedValue(true);
    const controller = new RetryQueueActionQueueSupersessionController({
      getBridge: () => createRetryQueueActionQueueSupersessionBridge(OWNER, []),
      clearOrphanReservations: clearOrphans,
    });
    const handle = createSupersessionLease();
    const successor = {
      ...retryItem(),
      id: '10000000-0000-4000-8000-000000000008',
      operationId: '10000000-0000-4000-8000-000000000007',
    };

    await expect(controller.beforeReplay(successor, handle)).resolves.toBe('proceed-after-clear');
    expect(clearOrphans).toHaveBeenCalledWith(successor, [TOKEN], handle.signal);
  });

  it('treats unavailable or unloaded ActionQueue storage as unknown', async () => {
    const unavailable = createRetryQueueActionQueueSupersessionBridge(OWNER, null);
    unavailable.isOwnerStorageLoaded = vi.fn(() => false);
    const clearOrphans = vi.fn().mockResolvedValue(true);
    const controller = new RetryQueueActionQueueSupersessionController({
      getBridge: () => unavailable,
      clearOrphanReservations: clearOrphans,
    });

    await expect(controller.beforeReplay(retryItem(), createSupersessionLease())).resolves.toBe('defer');
    expect(clearOrphans).not.toHaveBeenCalled();
  });

  it('fails closed on memory-only or aborted leases', async () => {
    const clearOrphans = vi.fn().mockResolvedValue(true);
    const controller = new RetryQueueActionQueueSupersessionController({
      getBridge: () => createRetryQueueActionQueueSupersessionBridge(OWNER, []),
      clearOrphanReservations: clearOrphans,
    });
    const memoryOnly = { ...createSupersessionLease(), mode: 'memory-only' as const };
    const aborted = new AbortController();
    aborted.abort();

    await expect(controller.beforeReplay(retryItem(), memoryOnly)).resolves.toBe('defer');
    await expect(controller.beforeReplay(
      retryItem(), createSupersessionLease(aborted.signal),
    )).resolves.toBe('defer');
    expect(clearOrphans).not.toHaveBeenCalled();
  });

  it('uses authoritative IDB selection while excluding the same operationId', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    const harness = await createLoadedRetryQueueHarness();
    try {
      const task = createTask('same-operation');
      task.id = ENTITY_ID;
      harness.service.add(
        'task',
        'upsert',
        task,
        'project-a',
        OWNER,
        undefined,
        'task_full_upsert',
        undefined,
        RETRY_OPERATION_ID,
      );
      expect(await harness.service.persistNow()).toBe(true);

      expect(await harness.service.inspectActionQueueSupersessionTargets({
        entityType: 'task',
        entityId: ENTITY_ID,
        operationId: RETRY_OPERATION_ID,
      }, OWNER, new AbortController().signal)).toEqual({ status: 'ready', retryItems: [] });
      const retryIdentity = { id: harness.service.getItems()[0].id, operationId: RETRY_OPERATION_ID };
      (harness.service as unknown as { queue: RetryQueueItem[] }).queue = [];
      expect(await harness.service.inspectActionQueueSupersessionTargets({
        entityType: 'task', entityId: ENTITY_ID, operationId: ACTION_OPERATION_ID,
      }, OWNER, new AbortController().signal))
        .toEqual({ status: 'ready', retryItems: [retryIdentity] });
      let identityChecks = 0;
      harness.service.configureActionQueueSupersessionBridge(
        createRetryQueueActionQueueSupersessionBridge(OWNER, [], () => ++identityChecks === 1),
      );
      expect(await harness.service.inspectActionQueueSupersessionTargets({
        entityType: 'task', entityId: ENTITY_ID, operationId: ACTION_OPERATION_ID,
      }, OWNER, new AbortController().signal)).toEqual({ status: 'unknown' });
    } finally {
      await harness.teardown();
      vi.unstubAllGlobals();
    }
  });

  it('restores a durable reservation, defers for B, then clears an orphan before replay', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    const first = await createLoadedRetryQueueHarness();
    const task = createTask('supersession-restart');
    task.id = ENTITY_ID;
    first.service.add(
      'task',
      'upsert',
      task,
      'project-a',
      OWNER,
      undefined,
      'task_full_upsert',
      undefined,
      RETRY_OPERATION_ID,
    );
    expect(await first.service.persistNow()).toBe(true);
    const durableReservation = reservationForItem(first.service.getItems()[0]);
    expect(await first.service.reserveActionQueueSupersession(
      durableReservation,
      new AbortController().signal,
    )).toBe(true);
    await first.teardown();

    const restarted = await createLoadedRetryQueueHarness(false);
    restarted.syncWriterLeaseMock.isFeatureEnabled.mockReturnValue(true);
    restarted.syncWriterLeaseMock.requestLease.mockResolvedValue({
      tabId: 'tab-restart',
      lockName: 'global-owner-a',
      mode: 'idb-lease',
      signal: new AbortController().signal,
      release: restarted.releaseLeaseMock,
    });
    restarted.setOnline(true);
    const durableAction = action();
    durableAction.retryQueueSupersessions = [durableReservation];
    restarted.service.configureActionQueueSupersessionBridge(
      createRetryQueueActionQueueSupersessionBridge(OWNER, [durableAction]),
    );

    expect(restarted.service.getItems()[0]?.actionQueueSupersessions).toEqual([durableReservation]);
    await restarted.service.processQueueSlice({ maxItems: 1, maxDurationMs: 1000 });
    expect(restarted.handler.pushTask).not.toHaveBeenCalled();
    expect(restarted.service.getItems()[0]?.retryCount).toBe(0);

    restarted.service.configureActionQueueSupersessionBridge(
      createRetryQueueActionQueueSupersessionBridge(OWNER, []),
    );
    const orphanReplay = await restarted.service.processQueueSlice({ maxItems: 1, maxDurationMs: 1000 });
    expect(orphanReplay.processed).toBe(1);
    expect(restarted.service.getItems()[0]?.actionQueueSupersessions).toBeUndefined();
    expect(restarted.handler.pushTask).toHaveBeenCalledOnce();
    const { displayId: _displayId, ...persistedTask } = task;
    expect(restarted.handler.pushTask).toHaveBeenCalledWith(
      persistedTask,
      'project-a',
      OWNER,
      'task_full_upsert',
      RETRY_OPERATION_ID,
    );
    await restarted.teardown();
    vi.unstubAllGlobals();
  });

  it('retains a refreshed successor until B settles its historical reservation', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    const harness = await createLoadedRetryQueueHarness();
    try {
      const task = createTask('supersession-refresh');
      task.id = ENTITY_ID;
      harness.service.add(
        'task', 'upsert', task, 'project-a', OWNER, undefined,
        'task_full_upsert', undefined, RETRY_OPERATION_ID,
      );
      expect(await harness.service.persistNow()).toBe(true);
      const original = harness.service.getItems()[0];
      const durableReservation = reservationForItem(original);
      expect(await harness.service.reserveActionQueueSupersession(
        durableReservation,
        new AbortController().signal,
      )).toBe(true);

      const selectWinner = harness.service as unknown as {
        selectRetryQueueEntityWinner(left: RetryQueueItem, right: RetryQueueItem): RetryQueueItem;
      };
      const deleteSuccessor = {
        ...harness.service.getItems()[0],
        id: '10000000-0000-4000-8000-000000000008',
        operation: 'delete' as const,
        operationId: '10000000-0000-4000-8000-000000000007',
        actionQueueSupersessions: undefined,
        createdAt: Date.now() + 1,
      };
      expect(selectWinner.selectRetryQueueEntityWinner(harness.service.getItems()[0], deleteSuccessor))
        .toEqual(expect.objectContaining({ id: deleteSuccessor.id, actionQueueSupersessions: [durableReservation] }));

      const refreshedOperationId = '10000000-0000-4000-8000-000000000007';
      const refreshedTask = { ...task, title: 'Task supersession refresh successor' };
      expect(harness.service.add(
        'task', 'upsert', refreshedTask, 'project-a', OWNER, undefined,
        'task_full_upsert', undefined, refreshedOperationId,
      )).toBe(true);
      expect(await harness.service.persistNow()).toBe(true);
      expect(harness.service.getItems()[0]).toEqual(expect.objectContaining({
        id: original.id,
        operationId: refreshedOperationId,
        actionQueueSupersessions: [durableReservation],
      }));

      const durableAction = action();
      durableAction.retryQueueSupersessions = [durableReservation];
      harness.service.configureActionQueueSupersessionBridge(
        createRetryQueueActionQueueSupersessionBridge(OWNER, [durableAction]),
      );
      harness.syncWriterLeaseMock.isFeatureEnabled.mockReturnValue(true);
      harness.syncWriterLeaseMock.requestLease.mockResolvedValue(createSupersessionLease());
      harness.setOnline(true);
      await harness.service.processQueueSlice({ maxItems: 1, maxDurationMs: 1000 });
      expect(harness.handler.pushTask).not.toHaveBeenCalled();

      const persistNow = vi.spyOn(harness.service, 'persistNow').mockResolvedValueOnce(false);
      expect(await harness.service.settleActionQueueSupersessions(
        durableAction,
        new AbortController().signal,
      )).toBe(false);
      expect(harness.service.getItems()[0]?.actionQueueSupersessions).toEqual([durableReservation]);
      persistNow.mockRestore();
      expect(await harness.service.settleActionQueueSupersessions(
        durableAction,
        new AbortController().signal,
      )).toBe(true);
      expect(harness.service.getItems()[0]?.operationId).toBe(refreshedOperationId);
      expect(harness.service.getItems()[0]?.actionQueueSupersessions).toBeUndefined();
      harness.service.configureActionQueueSupersessionBridge(
        createRetryQueueActionQueueSupersessionBridge(OWNER, []),
      );
      await harness.service.processQueueSlice({ maxItems: 1, maxDurationMs: 1000 });
      expect(harness.handler.pushTask).toHaveBeenCalledWith(
        expect.objectContaining({ title: refreshedTask.title }),
        'project-a', OWNER, 'task_full_upsert', refreshedOperationId,
      );
    } finally {
      await harness.teardown();
      vi.unstubAllGlobals();
    }
  });
});

describe('ActionQueue cross-queue supersession orchestration', () => {
  registerEmptyRetrySelectionSupersessionSpecs(OWNER, action);
  registerEmptyRetrySelectionSupersessionSpecs(OWNER, () => ({
    ...action(),
    entityType: 'preference',
    entityId: OWNER,
    payload: { sourceUserId: OWNER, userId: OWNER, preferences: { theme: 'ocean' } },
  }));

  it('rejects same-token RetryQueue identity drift after B commit and releases after readback', async () => {
    const events: string[] = [];
    const handle = createSupersessionLease();
    handle.release = vi.fn(async () => { events.push('release'); });
    let storedQueue: QueuedAction[] = [];
    const controller = new ActionQueueRetrySupersessionController({ ...currentSupersessionIdentity,
      getCurrentOwnerUserId: () => OWNER,
      getQueueGeneration: () => 3,
      isQueueContextCurrent: () => true,
      isOwnerStorageLoaded: () => true,
      acquireWriterLease: vi.fn(async () => handle),
      restoreQueueSnapshot: vi.fn(async () => {
        events.push('readback');
        return { recordFound: true, actions: storedQueue, savedAt: 'now' };
      }),
      persistQueueMutationStrictlyForOwner: vi.fn<
        ActionQueueRetrySupersessionControllerOptions['persistQueueMutationStrictlyForOwner']
      >(async (_owner, updater) => {
        storedQueue = updater(storedQueue).map(current => ({
          ...current,
          retryQueueSupersessions: current.retryQueueSupersessions?.map(value => ({
            ...value,
            retryItems: [{ id: RETRY_ID, operationId: ACTION_OPERATION_ID }],
          })),
        }));
        events.push('b-commit');
        return { status: 'committed', queue: storedQueue };
      }),
      inspectRetryTargets: () => ({
        status: 'ready',
        retryItems: [{ id: RETRY_ID, operationId: RETRY_OPERATION_ID }],
      }),
      reserveRetrySupersession: vi.fn(async () => {
        events.push('reservation-commit');
        return true;
      }),
      settleRetrySupersessions: vi.fn().mockResolvedValue(true),
      applyPersistedCurrentOwnerQueue: vi.fn(),
      warn: vi.fn(),
    });
    const queued = action();
    delete queued.retryQueueSupersessions;
    let candidateIds: string[] = [];

    const result = await controller.persistMutation({
      ownerUserId: OWNER,
      mutateQueue: queue => {
        candidateIds = [queued.id];
        return [...queue.filter(current => current.id !== queued.id), queued];
      },
      getCandidateActionIds: () => candidateIds,
      persistWithoutSupersession: vi.fn().mockResolvedValue(null),
    });

    expect(events.indexOf('reservation-commit')).toBeLessThan(events.indexOf('b-commit'));
    expect(events.indexOf('b-commit')).toBeLessThan(events.lastIndexOf('readback'));
    expect(events.lastIndexOf('readback')).toBeLessThan(events.indexOf('release'));
    expect(result).toBeNull();
  });

  it('reserves every batch retry identity before the single B commit', async () => {
    const events: string[] = [];
    const handle = createSupersessionLease();
    handle.release = vi.fn(async () => { events.push('release'); });
    const first = action();
    delete first.retryQueueSupersessions;
    const second: QueuedAction = {
      ...action(),
      id: '10000000-0000-4000-8000-000000000012',
      entityId: '10000000-0000-4000-8000-000000000011',
      operationId: '10000000-0000-4000-8000-000000000013',
    };
    delete second.retryQueueSupersessions;
    let storedQueue: QueuedAction[] = [];
    const controller = new ActionQueueRetrySupersessionController({ ...currentSupersessionIdentity,
      getCurrentOwnerUserId: () => OWNER,
      getQueueGeneration: () => 5,
      isQueueContextCurrent: () => true,
      isOwnerStorageLoaded: () => true,
      acquireWriterLease: vi.fn(async () => handle),
      restoreQueueSnapshot: vi.fn(async () => ({
        recordFound: true,
        actions: storedQueue,
        savedAt: 'now',
      })),
      persistQueueMutationStrictlyForOwner: vi.fn<
        ActionQueueRetrySupersessionControllerOptions['persistQueueMutationStrictlyForOwner']
      >(async (_owner, updater) => {
        storedQueue = updater(storedQueue);
        events.push('b-commit');
        return { status: 'committed', queue: storedQueue };
      }),
      inspectRetryTargets: current => ({
        status: 'ready',
        retryItems: [{
          id: current.id === first.id ? RETRY_ID : '10000000-0000-4000-8000-000000000014',
          operationId: current.id === first.id
            ? RETRY_OPERATION_ID
            : '10000000-0000-4000-8000-000000000015',
        }],
      }),
      reserveRetrySupersession: vi.fn(async current => {
        events.push(`reserve:${current.actionId}`);
        return true;
      }),
      settleRetrySupersessions: vi.fn(),
      applyPersistedCurrentOwnerQueue: vi.fn(),
      warn: vi.fn(),
    });

    const result = await controller.persistMutation({
      ownerUserId: OWNER,
      mutateQueue: () => [first, second],
      getCandidateActionIds: () => [first.id, second.id],
      persistWithoutSupersession: vi.fn(),
    });

    expect(events).toEqual([
      `reserve:${first.id}`,
      `reserve:${second.id}`,
      'b-commit',
      'release',
    ]);
    expect(result?.every(current => current.retryQueueSupersessions?.length === 1)).toBe(true);
  });

  it('retains reservations and returns null when B persistence fails', async () => {
    const handle = createSupersessionLease();
    const queued = action();
    delete queued.retryQueueSupersessions;
    const reserveRetrySupersession = vi.fn().mockResolvedValue(true);
    const persistQueueMutationStrictlyForOwner = vi.fn()
      .mockResolvedValue({ status: 'storage-failed' });
    const controller = new ActionQueueRetrySupersessionController({ ...currentSupersessionIdentity,
      getCurrentOwnerUserId: () => OWNER,
      getQueueGeneration: () => 6,
      isQueueContextCurrent: () => true,
      isOwnerStorageLoaded: () => true,
      acquireWriterLease: vi.fn(async () => handle),
      restoreQueueSnapshot: vi.fn(async () => ({
        recordFound: true,
        actions: [],
        savedAt: 'now',
      })),
      persistQueueMutationStrictlyForOwner,
      inspectRetryTargets: () => ({
        status: 'ready',
        retryItems: [{ id: RETRY_ID, operationId: RETRY_OPERATION_ID }],
      }),
      reserveRetrySupersession,
      settleRetrySupersessions: vi.fn(),
      applyPersistedCurrentOwnerQueue: vi.fn(),
      warn: vi.fn(),
    });

    await expect(controller.persistMutation({
      ownerUserId: OWNER,
      mutateQueue: () => [queued],
      getCandidateActionIds: () => [queued.id],
      persistWithoutSupersession: vi.fn(),
    })).resolves.toBeNull();
    expect(reserveRetrySupersession).toHaveBeenCalledOnce();
    expect(persistQueueMutationStrictlyForOwner).toHaveBeenCalledOnce();
    expect(handle.release).toHaveBeenCalledOnce();
  });

  it.each(['queue', 'session', 'auth'] as const)(
    'does not commit B after %s drift across reservation', async drift => {
    const handle = createSupersessionLease();
    let queueCurrent = true;
    let sessionGeneration = 1;
    let authFence = 'auth-a';
    const persistQueueMutationStrictlyForOwner = vi.fn();
    const queued = action();
    delete queued.retryQueueSupersessions;
    const controller = new ActionQueueRetrySupersessionController({ ...currentSupersessionIdentity,
      getCurrentOwnerUserId: () => OWNER,
      getQueueGeneration: () => 7,
      isQueueContextCurrent: () => queueCurrent,
      getSessionGeneration: () => sessionGeneration,
      captureAuthFence: () => authFence,
      isSessionContextCurrent: generation => generation === sessionGeneration,
      isOwnerStorageLoaded: () => true,
      acquireWriterLease: vi.fn(async () => handle),
      restoreQueueSnapshot: vi.fn(async () => ({
        recordFound: true,
        actions: [],
        savedAt: 'now',
      })),
      persistQueueMutationStrictlyForOwner,
      inspectRetryTargets: () => ({
        status: 'ready',
        retryItems: [{ id: RETRY_ID, operationId: RETRY_OPERATION_ID }],
      }),
      reserveRetrySupersession: vi.fn(async () => {
        if (drift === 'queue') queueCurrent = false;
        if (drift === 'session') sessionGeneration += 1;
        if (drift === 'auth') authFence = 'auth-b';
        return true;
      }),
      settleRetrySupersessions: vi.fn(),
      applyPersistedCurrentOwnerQueue: vi.fn(),
      warn: vi.fn(),
    });

    await expect(controller.persistMutation({
      ownerUserId: OWNER,
      mutateQueue: () => [queued],
      getCandidateActionIds: () => [queued.id],
      persistWithoutSupersession: vi.fn(),
    })).resolves.toBeNull();
    expect(persistQueueMutationStrictlyForOwner).not.toHaveBeenCalled();
    expect(handle.release).toHaveBeenCalledOnce();
  });

  it('settles RetryQueue evidence before clearing B for processor dispatch', async () => {
    const events: string[] = [];
    let storedQueue = [action()];
    const applyPersistedCurrentOwnerQueue = vi.fn();
    const controller = new ActionQueueRetrySupersessionController({ ...currentSupersessionIdentity,
      getCurrentOwnerUserId: () => OWNER,
      getQueueGeneration: () => 4,
      isQueueContextCurrent: () => true,
      isOwnerStorageLoaded: () => true,
      acquireWriterLease: vi.fn(),
      restoreQueueSnapshot: vi.fn(async () => ({
        recordFound: true,
        actions: storedQueue,
        savedAt: 'now',
      })),
      persistQueueMutationStrictlyForOwner: vi.fn<
        ActionQueueRetrySupersessionControllerOptions['persistQueueMutationStrictlyForOwner']
      >(async (_owner, updater) => {
        storedQueue = updater(storedQueue);
        events.push('b-settled');
        return { status: 'committed', queue: storedQueue };
      }),
      inspectRetryTargets: vi.fn(),
      reserveRetrySupersession: vi.fn(),
      settleRetrySupersessions: vi.fn(async () => {
        events.push('retry-settled');
        return true;
      }),
      applyPersistedCurrentOwnerQueue,
      warn: vi.fn(),
    });

    const settled = await controller.settleBeforeProcessing(
      action(),
      OWNER,
      4,
      new AbortController().signal,
    );

    expect(events).toEqual(['retry-settled', 'b-settled']);
    expect(settled?.retryQueueSupersessions).toBeUndefined();
    expect(applyPersistedCurrentOwnerQueue).toHaveBeenCalledWith(storedQueue);
  });

  it('does not clear B when RetryQueue settlement is not durable', async () => {
    const persistQueueMutationStrictlyForOwner = vi.fn();
    const controller = new ActionQueueRetrySupersessionController({ ...currentSupersessionIdentity,
      getCurrentOwnerUserId: () => OWNER,
      getQueueGeneration: () => 8,
      isQueueContextCurrent: () => true,
      isOwnerStorageLoaded: () => true,
      acquireWriterLease: vi.fn(),
      restoreQueueSnapshot: vi.fn(),
      persistQueueMutationStrictlyForOwner,
      inspectRetryTargets: vi.fn(),
      reserveRetrySupersession: vi.fn(),
      settleRetrySupersessions: vi.fn().mockResolvedValue(false),
      applyPersistedCurrentOwnerQueue: vi.fn(),
      warn: vi.fn(),
    });

    await expect(controller.settleBeforeProcessing(
      action(),
      OWNER,
      8,
      new AbortController().signal,
    )).resolves.toBeNull();
    expect(persistQueueMutationStrictlyForOwner).not.toHaveBeenCalled();
  });
});
