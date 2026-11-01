import { expect, it, vi } from 'vitest';

import type { Connection } from '../../../../models';
import type { ConnectionSyncOperationsService } from './connection-sync-operations.service';
import { combineConnectionReplayAbortSignals } from './connection-sync-operations.helpers';
import type {
  EndpointDedupResponse,
  MockSyncRpcClient,
} from './connection-sync-operations.test-harness';
import {
  createRetryQueueServiceSpecHarness,
  type RetryQueueServiceSpecHarness,
} from './retry-queue-service.spec-fixture';
import type { RetryQueueService } from './retry-queue.service';
import type { PersistedRetryQueueItem } from './retry-queue.types';
import { buildConnectionReplayPayloadSignature } from './connection-sync-operations.helpers';

type ConnectionReplayCommitInput = {
  actionId: string;
  actionOperationId: string;
  connection: Connection;
  projectId: string;
  sourceUserId: string;
  payloadSignature: string;
  leaseSignal: AbortSignal;
  isFenceCurrent: () => boolean;
};

type ConnectionReplayRetryQueue = RetryQueueService & {
  commitConnectionReplay(input: ConnectionReplayCommitInput): Promise<{
    status: 'current' | 'committed' | 'deferred';
  }>;
};

type ConnectionReplaySpecContext = {
  service: ConnectionSyncOperationsService;
  mockClient: { auth: { getSession: ReturnType<typeof vi.fn> } };
  mockRetryQueue: { commitConnectionReplay: ReturnType<typeof vi.fn> };
  mockSessionManager: { tryRefreshSession: ReturnType<typeof vi.fn> };
  mockSyncState: { setSessionExpired: ReturnType<typeof vi.fn> };
  mockSyncRpcClient: Pick<MockSyncRpcClient, 'isFeatureEnabled' | 'upsertConnection'>;
  setEndpointDedupResponses: (responses: EndpointDedupResponse[]) => void;
};

export function registerConnectionSyncActionQueueReplaySpecs(
  getContext: () => ConnectionReplaySpecContext,
): void {
  it('defers when addDurably would retain a different newer incumbent', async () => {
    await deleteRetryQueueDatabase();
    const harness = await createRealRetryQueueHarness();
    const incumbent = createConnection(
      '11111111-1111-4111-8111-111111111111',
      '2026-07-30T02:00:00.000Z',
      'incumbent',
    );
    const incoming = createConnection(
      incumbent.id,
      '2026-07-30T01:00:00.000Z',
      'incoming',
    );
    const incumbentOperationId = '22222222-2222-4222-8222-222222222222';
    const incomingOperationId = '33333333-3333-4333-8333-333333333333';
    configureCurrentActionQueueBridge(harness.service);
    harness.service.add(
      'connection',
      'upsert',
      incumbent,
      'project-1',
      'test-user',
      undefined,
      undefined,
      undefined,
      incumbentOperationId,
    );
    await expect(harness.service.persistNow()).resolves.toBe(true);

    try {
      const result = await asConnectionReplayRetryQueue(harness.service).commitConnectionReplay(
        createCommitInput(incoming, incomingOperationId),
      );

      expect(result).toEqual({ status: 'deferred' });
      const persisted = await reopenRetryQueueHarness(harness);
      expect(persisted.service.findItemForOwner('connection', incoming.id, 'test-user'))
        .toEqual(expect.objectContaining({
          operationId: incumbentOperationId,
          data: incumbent,
        }));
      await persisted.teardown();
    } finally {
      await harness.teardown();
      await deleteRetryQueueDatabase();
    }
  });

  it('returns current only after an authoritative exact IDB read without another write', async () => {
    await deleteRetryQueueDatabase();
    const harness = await createRealRetryQueueHarness();
    const connection = createConnection(
      '44444444-4444-4444-8444-444444444444',
      '2026-07-30T03:00:00.000Z',
      'exact-current',
    );
    const operationId = '55555555-5555-4555-8555-555555555555';
    configureCurrentActionQueueBridge(harness.service);
    harness.service.add(
      'connection',
      'upsert',
      connection,
      'project-1',
      'test-user',
      undefined,
      undefined,
      undefined,
      operationId,
    );
    await expect(harness.service.persistNow()).resolves.toBe(true);
    const persistSpy = vi.spyOn(harness.service, 'persistNow');

    try {
      const result = await asConnectionReplayRetryQueue(harness.service).commitConnectionReplay(
        createCommitInput(connection, operationId),
      );

      expect(result).toEqual({ status: 'current' });
      expect(persistSpy).not.toHaveBeenCalled();
    } finally {
      persistSpy.mockRestore();
      await harness.teardown();
      await deleteRetryQueueDatabase();
    }
  });

  it('reports committed only after exact IDB write completion and readback', async () => {
    await deleteRetryQueueDatabase();
    const harness = await createRealRetryQueueHarness();
    const connection = createConnection(
      '66666666-6666-4666-8666-666666666666',
      '2026-07-30T04:00:00.000Z',
      'new-commit',
    );
    const operationId = '77777777-7777-4777-8777-777777777777';
    configureCurrentActionQueueBridge(harness.service);

    try {
      const result = await asConnectionReplayRetryQueue(harness.service).commitConnectionReplay(
        createCommitInput(connection, operationId),
      );

      expect(result).toEqual({ status: 'committed' });
      const reopened = await reopenRetryQueueHarness(harness);
      expect(reopened.service.findItemForOwner('connection', connection.id, 'test-user'))
        .toEqual(expect.objectContaining({ operationId, data: connection }));
      await reopened.teardown();
    } finally {
      await harness.teardown();
      await deleteRetryQueueDatabase();
    }
  });

  it('defers when persistence reports fallback-only success without an authoritative IDB record', async () => {
    await deleteRetryQueueDatabase();
    const harness = await createRealRetryQueueHarness();
    const connection = createConnection(
      '78787878-7878-4787-8787-787878787878',
      '2026-07-30T04:30:00.000Z',
      'fallback-only',
    );
    const operationId = '79797979-7979-4797-8797-797979797979';
    configureCurrentActionQueueBridge(harness.service);
    const persistSpy = vi.spyOn(harness.service, 'persistNow').mockResolvedValue(true);

    try {
      const result = await asConnectionReplayRetryQueue(harness.service).commitConnectionReplay(
        createCommitInput(connection, operationId),
      );

      expect(result).toEqual({ status: 'deferred' });
      expect(persistSpy).toHaveBeenCalledOnce();
      const reopened = await reopenRetryQueueHarness(harness);
      try {
        expect(reopened.service.findItemForOwner('connection', connection.id, 'test-user')).toBeUndefined();
      } finally {
        await reopened.service.closeStorageConnections();
        await reopened.teardown();
      }
    } finally {
      persistSpy.mockRestore();
      await harness.teardown();
      await deleteRetryQueueDatabase();
    }
  });

  it('defers when an authoritative pre-read request succeeds but its transaction aborts', async () => {
    await deleteRetryQueueDatabase();
    const harness = await createRealRetryQueueHarness();
    const connection = createConnection(
      '81818181-8181-4818-8181-818181818181',
      '2026-07-30T04:40:00.000Z',
      'pre-read-abort',
    );
    const operationId = '82828282-8282-4828-8282-828282828282';
    configureCurrentActionQueueBridge(harness.service);
    const persistSpy = vi.spyOn(harness.service, 'persistNow');
    const getAllSpy = abortRetryQueueGetAllTransactionOnCall(1);

    try {
      const result = await asConnectionReplayRetryQueue(harness.service).commitConnectionReplay(
        createCommitInput(connection, operationId),
      );

      expect(result).toEqual({ status: 'deferred' });
      expect(persistSpy).not.toHaveBeenCalled();
      expect(await readPersistedRetryQueueItems()).toEqual([]);
    } finally {
      getAllSpy.mockRestore();
      persistSpy.mockRestore();
      await harness.teardown();
      await deleteRetryQueueDatabase();
    }
  });

  it('defers after commit when the exact post-read transaction aborts and retains the handoff', async () => {
    await deleteRetryQueueDatabase();
    const harness = await createRealRetryQueueHarness();
    const connection = createConnection(
      '83838383-8383-4838-8383-838383838383',
      '2026-07-30T04:50:00.000Z',
      'post-read-abort',
    );
    const operationId = '84848484-8484-4848-8484-848484848484';
    configureCurrentActionQueueBridge(harness.service);
    const getAllSpy = abortRetryQueueGetAllTransactionOnCall(2);

    try {
      const result = await asConnectionReplayRetryQueue(harness.service).commitConnectionReplay(
        createCommitInput(connection, operationId),
      );

      expect(result).toEqual({ status: 'deferred' });
      getAllSpy.mockRestore();
      const reopened = await reopenRetryQueueHarness(harness);
      try {
        expect(reopened.service.findItemForOwner('connection', connection.id, 'test-user'))
          .toEqual(expect.objectContaining({ operationId, data: connection }));
      } finally {
        await reopened.service.closeStorageConnections();
        await reopened.teardown();
      }
    } finally {
      getAllSpy.mockRestore();
      await harness.teardown();
      await deleteRetryQueueDatabase();
    }
  });

  it('defers when authoritative IDB contains duplicate exact replay records', async () => {
    await deleteRetryQueueDatabase();
    const harness = await createRealRetryQueueHarness();
    const connection = createConnection(
      '85858585-8585-4858-8585-858585858585',
      '2026-07-30T05:00:00.000Z',
      'duplicate-exact',
    );
    const operationId = '86868686-8686-4868-8686-868686868686';
    configureCurrentActionQueueBridge(harness.service);
    await writePersistedRetryQueueItems([
      createPersistedConnectionItem('retry-duplicate-a', connection, operationId),
      createPersistedConnectionItem('retry-duplicate-b', connection, operationId),
    ]);
    const persistSpy = vi.spyOn(harness.service, 'persistNow');

    try {
      const result = await asConnectionReplayRetryQueue(harness.service).commitConnectionReplay(
        createCommitInput(connection, operationId),
      );

      expect(result).toEqual({ status: 'deferred' });
      expect(persistSpy).not.toHaveBeenCalled();
      expect(await readPersistedRetryQueueItems()).toHaveLength(2);
    } finally {
      persistSpy.mockRestore();
      await harness.teardown();
      await deleteRetryQueueDatabase();
    }
  });

  it.each([
    ['after initial IDB open', 2, false],
    ['after the authoritative pre-read', 3, false],
    ['after the IDB commit', 6, true],
    ['after the readback IDB open', 7, true],
    ['after the authoritative post-read', 8, true],
  ])('defers when the full replay fence drifts %s', async (_phase, failAtCheck, persisted) => {
    await deleteRetryQueueDatabase();
    const harness = await createRealRetryQueueHarness();
    const connection = createConnection(
      `87878787-8787-4878-8787-87878787878${failAtCheck}`,
      '2026-07-30T05:10:00.000Z',
      `fence-drift-${failAtCheck}`,
    );
    const operationId = `88888888-8888-4888-8888-88888888888${failAtCheck}`;
    configureCurrentActionQueueBridge(harness.service);
    let checks = 0;
    const input = {
      ...createCommitInput(connection, operationId),
      isFenceCurrent: () => ++checks < failAtCheck,
    };

    try {
      const result = await asConnectionReplayRetryQueue(harness.service).commitConnectionReplay(input);

      expect(result).toEqual({ status: 'deferred' });
      const reopened = await reopenRetryQueueHarness(harness);
      try {
        const item = reopened.service.findItemForOwner('connection', connection.id, 'test-user');
        if (persisted) {
          expect(item).toEqual(expect.objectContaining({ operationId, data: connection }));
        } else {
          expect(item).toBeUndefined();
        }
      } finally {
        await reopened.service.closeStorageConnections();
        await reopened.teardown();
      }
    } finally {
      await harness.teardown();
      await deleteRetryQueueDatabase();
    }
  });

  it.each([
    ['before the authoritative pre-read', 2, false],
    ['after the IDB commit', 6, true],
  ])('defers when the writer lease aborts %s', async (_phase, abortAtCheck, persisted) => {
    await deleteRetryQueueDatabase();
    const harness = await createRealRetryQueueHarness();
    const connection = createConnection(
      `89898989-8989-4898-8989-89898989898${abortAtCheck}`,
      '2026-07-30T05:20:00.000Z',
      `lease-abort-${abortAtCheck}`,
    );
    const operationId = `90909090-9090-4090-8090-90909090909${abortAtCheck}`;
    configureCurrentActionQueueBridge(harness.service);
    const lease = new AbortController();
    let checks = 0;
    const input = {
      ...createCommitInput(connection, operationId),
      leaseSignal: lease.signal,
      isFenceCurrent: () => {
        if (++checks === abortAtCheck) lease.abort();
        return true;
      },
    };

    try {
      const result = await asConnectionReplayRetryQueue(harness.service).commitConnectionReplay(input);

      expect(result).toEqual({ status: 'deferred' });
      const reopened = await reopenRetryQueueHarness(harness);
      try {
        const item = reopened.service.findItemForOwner('connection', connection.id, 'test-user');
        if (persisted) {
          expect(item).toEqual(expect.objectContaining({ operationId, data: connection }));
        } else {
          expect(item).toBeUndefined();
        }
      } finally {
        await reopened.service.closeStorageConnections();
        await reopened.teardown();
      }
    } finally {
      await harness.teardown();
      await deleteRetryQueueDatabase();
    }
  });

  it('ActionQueue replay defers when the real RetryQueue retains a newer incumbent', async () => {
    await deleteRetryQueueDatabase();
    const harness = await createRealRetryQueueHarness();
    const context = getContext();
    const incumbent = createConnection(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '2026-07-30T06:00:00.000Z',
      'newer-incumbent',
    );
    const incoming = createConnection(
      incumbent.id,
      '2026-07-30T05:00:00.000Z',
      'older-action',
    );
    configureCurrentActionQueueBridge(harness.service);
    harness.service.add(
      'connection', 'upsert', incumbent, 'project-1', 'test-user',
      undefined, undefined, undefined, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    );
    await harness.service.persistNow();
    context.mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'test-user' } } },
    });
    context.mockSyncRpcClient.isFeatureEnabled.mockReturnValue(false);
    context.mockRetryQueue.commitConnectionReplay.mockImplementation(
      input => asConnectionReplayRetryQueue(harness.service).commitConnectionReplay(input),
    );

    try {
      await expect(context.service.pushConnectionFromActionQueue(
        createActionQueueReplayInput(incoming, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
      )).resolves.toEqual({ outcome: 'deferred' });
      const reopened = await reopenRetryQueueHarness(harness);
      expect(reopened.service.findItemForOwner('connection', incumbent.id, 'test-user'))
        .toEqual(expect.objectContaining({ data: incumbent }));
      await reopened.teardown();
    } finally {
      await harness.teardown();
      await deleteRetryQueueDatabase();
    }
  });

  it('commit then fence drift retains the exact handoff and defers ActionQueue settlement', async () => {
    await deleteRetryQueueDatabase();
    const harness = await createRealRetryQueueHarness();
    const context = getContext();
    const connection = createConnection(
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      '2026-07-30T07:00:00.000Z',
      'commit-before-drift',
    );
    const operationId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    let current = true;
    configureCurrentActionQueueBridge(harness.service);
    context.mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'test-user' } } },
    });
    context.mockSyncRpcClient.isFeatureEnabled.mockReturnValue(false);
    context.mockRetryQueue.commitConnectionReplay.mockImplementation(async input => {
      const result = await asConnectionReplayRetryQueue(harness.service).commitConnectionReplay(input);
      current = false;
      return result;
    });

    try {
      await expect(context.service.pushConnectionFromActionQueue({
        ...createActionQueueReplayInput(connection, operationId),
        isFenceCurrent: () => current,
      })).resolves.toEqual({ outcome: 'deferred' });
      const reopened = await reopenRetryQueueHarness(harness);
      expect(reopened.service.findItemForOwner('connection', connection.id, 'test-user'))
        .toEqual(expect.objectContaining({ operationId, data: connection }));
      await reopened.teardown();
    } finally {
      await harness.teardown();
      await deleteRetryQueueDatabase();
    }
  });

  it('combined throttle and lease abort listeners are disposed', () => {
    const throttle = new AbortController();
    const lease = new AbortController();
    const throttleRemove = vi.spyOn(throttle.signal, 'removeEventListener');
    const leaseRemove = vi.spyOn(lease.signal, 'removeEventListener');

    const combined = combineConnectionReplayAbortSignals(throttle.signal, lease.signal);
    lease.abort();
    expect(combined.signal?.aborted).toBe(true);
    combined.dispose();

    expect(throttleRemove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(leaseRemove).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('fenced replay canonicalizes a detached copy without mutating durable A', async () => {
    const context = getContext();
    const connection: Connection = {
      id: '10101010-1010-4010-8010-101010101010',
      source: 'task-a',
      target: 'task-b',
      title: 'durable-action-title',
    };
    const canonicalId = '20202020-2020-4020-8020-202020202020';
    context.mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'test-user' } } },
    });
    context.setEndpointDedupResponses([{
      data: [{
        id: canonicalId,
        deleted_at: null,
        updated_at: '2026-07-30T08:00:00.000Z',
        title: 'canonical-title',
        description: null,
      }],
      error: null,
    }]);
    context.mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);

    const result = await context.service.pushConnectionFromActionQueue(
      createActionQueueReplayInput(
        connection,
        '30303030-3030-4030-8030-303030303030',
      ),
    );

    expect(result).toEqual({ outcome: 'applied' });
    expect(connection).toEqual({
      id: '10101010-1010-4010-8010-101010101010',
      source: 'task-a',
      target: 'task-b',
      title: 'durable-action-title',
    });
    expect(context.mockSyncRpcClient.upsertConnection).toHaveBeenCalledWith(
      expect.objectContaining({ connection: expect.objectContaining({ id: canonicalId }) }),
    );
  });

  it('fenced replay does not refresh a missing session or mark global session state', async () => {
    const context = getContext();
    const connection = createConnection(
      '40404040-4040-4040-8040-404040404040',
      '2026-07-30T09:00:00.000Z',
      'missing-session',
    );
    context.mockClient.auth.getSession.mockResolvedValue({ data: { session: null } });
    context.mockRetryQueue.commitConnectionReplay.mockResolvedValue({ status: 'committed' });

    const result = await context.service.pushConnectionFromActionQueue(
      createActionQueueReplayInput(
        connection,
        '50505050-5050-4050-8050-505050505050',
      ),
    );

    expect(result).toEqual({ outcome: 'handoff' });
    expect(context.mockSessionManager.tryRefreshSession).not.toHaveBeenCalled();
    expect(context.mockSyncState.setSessionExpired).not.toHaveBeenCalled();
  });
}

function asConnectionReplayRetryQueue(service: RetryQueueService): ConnectionReplayRetryQueue {
  return service as ConnectionReplayRetryQueue;
}

function createCommitInput(
  connection: Connection,
  actionOperationId: string,
): ConnectionReplayCommitInput {
  const lease = new AbortController();
  return {
    actionId: `action-${connection.id}`,
    actionOperationId,
    connection,
    projectId: 'project-1',
    sourceUserId: 'test-user',
    payloadSignature: buildConnectionReplayPayloadSignature(
      connection,
      'project-1',
      'test-user',
    ),
    leaseSignal: lease.signal,
    isFenceCurrent: () => true,
  };
}

function createActionQueueReplayInput(connection: Connection, actionOperationId: string) {
  const lease = new AbortController();
  return {
    actionId: `action-${connection.id}`,
    actionOperationId,
    connection,
    projectId: 'project-1',
    sourceUserId: 'test-user',
    leaseSignal: lease.signal,
    isFenceCurrent: () => true,
  };
}

function createConnection(id: string, updatedAt: string, title: string): Connection {
  return {
    id,
    source: '88888888-8888-4888-8888-888888888888',
    target: '99999999-9999-4999-8999-999999999999',
    updatedAt,
    title,
  };
}

function configureCurrentActionQueueBridge(service: RetryQueueService): void {
  service.configureActionQueueSupersessionBridge({
    captureContext: ownerUserId => ({
      ownerUserId,
      queueGeneration: 1,
      sessionGeneration: 1,
      authFence: 'auth-fence',
    }),
    isContextCurrent: () => true,
    isOwnerStorageLoaded: () => true,
    restoreQueueSnapshot: async () => ({ recordFound: true, actions: [], savedAt: null }),
  });
}

async function createRealRetryQueueHarness(): Promise<RetryQueueServiceSpecHarness> {
  const harness = createRetryQueueServiceSpecHarness({ clearLocalStorage: false });
  harness.loadFromStorageSpy.mockRestore();
  harness.initDbSpy.mockRestore();
  await harness.service.reloadFromStorageForCurrentOwner();
  return harness;
}

async function reopenRetryQueueHarness(
  previous: RetryQueueServiceSpecHarness,
): Promise<RetryQueueServiceSpecHarness> {
  await previous.service.closeStorageConnections();
  return await createRealRetryQueueHarness();
}

function createPersistedConnectionItem(
  id: string,
  connection: Connection,
  operationId: string,
): PersistedRetryQueueItem {
  return {
    id,
    type: 'connection',
    operation: 'upsert',
    data: connection,
    projectId: 'project-1',
    retryCount: 0,
    createdAt: Date.now(),
    sourceUserId: 'test-user',
    operationId,
  };
}

function abortRetryQueueGetAllTransactionOnCall(callNumber: number) {
  const originalGetAll = IDBObjectStore.prototype.getAll;
  let calls = 0;
  return vi.spyOn(IDBObjectStore.prototype, 'getAll').mockImplementation(function (
    this: IDBObjectStore,
  ) {
    const request = originalGetAll.call(this);
    if (++calls === callNumber) {
      request.addEventListener('success', () => request.transaction?.abort(), { once: true });
    }
    return request;
  });
}

async function writePersistedRetryQueueItems(items: PersistedRetryQueueItem[]): Promise<void> {
  const db = await openRetryQueueDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('offline_mutation_queue', 'readwrite');
    const store = transaction.objectStore('offline_mutation_queue');
    for (const item of items) store.put(item);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('RetryQueue write failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('RetryQueue write aborted'));
  }).finally(() => db.close());
}

async function readPersistedRetryQueueItems(): Promise<PersistedRetryQueueItem[]> {
  const db = await openRetryQueueDatabase();
  return await new Promise<PersistedRetryQueueItem[]>((resolve, reject) => {
    const transaction = db.transaction('offline_mutation_queue', 'readonly');
    const request = transaction.objectStore('offline_mutation_queue').getAll();
    let items: PersistedRetryQueueItem[] = [];
    request.onsuccess = () => {
      items = request.result;
    };
    transaction.oncomplete = () => resolve(items);
    transaction.onerror = () => reject(transaction.error ?? new Error('RetryQueue read failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('RetryQueue read aborted'));
  }).finally(() => db.close());
}

function openRetryQueueDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('nanoflow-retry-queue');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('RetryQueue database open failed'));
  });
}

function deleteRetryQueueDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase('nanoflow-retry-queue');
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('Failed to delete RetryQueue database'));
    request.onblocked = () => reject(new Error('RetryQueue database deletion blocked'));
  });
}
