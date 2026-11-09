import { TestBed } from '@angular/core/testing';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import type {
  DeadLetterItem,
  QueuedAction,
  QueueBackupPersonalRestoreIdentityV2,
} from './action-queue.types';
import { canonicalizePersistedValue } from './action-queue-identity.helpers';
import {
  projectQueueBackupRestoreProviderEvidence,
  type QueueBackupRestoreProviderRawSnapshot,
} from './queue-backup-restore-provider.helpers';
import {
  createQueueBackupPersonalRestoreIdentity,
  digestQueueBackupPersonalRestoreActions,
  getQueueBackupPersonalRestoreCatalogId,
} from './queue-backup-personal-restore-transition.helpers';
import {
  QUEUE_BACKUP_DB_NAME,
  QUEUE_BACKUP_DB_VERSION,
  QUEUE_BACKUP_STORE_NAME,
  QueueBackupService,
  type DeadLetterBackupRecord,
  type QueueBackupRecord,
} from './queue-backup.service';

const OWNER = 'provider-owner';
const OTHER_OWNER = 'provider-other-owner';
const SOURCE_DIGEST = `sha256:${'8'.repeat(64)}`;
type RawKind = 'PRESENT_VALID' | 'ABSENT' | 'MALFORMED';

export function registerQueueBackupRestoreProviderSpecs(): void {
  describe('QueueBackup restore provider', () => {
    let startupOpen: ReturnType<typeof vi.spyOn>;
    beforeAll(() => { startupOpen = vi.spyOn(indexedDB, 'open'); });

    it('is startup inert when the open spy precedes service injection', () => {
      expect(TestBed.inject(QueueBackupService)).toBeTruthy();
      expect(startupOpen).not.toHaveBeenCalled();
    });

    it('rejects unavailable auth, owner mismatch, and malformed identity before opening IndexedDB', async () => {
      const service = TestBed.inject(QueueBackupService);
      const identity = await makeIdentity('auth');
      const open = vi.spyOn(indexedDB, 'open');

      await expect(service.readPersonalRestoreProviderEvidence(identity, null)).resolves.toEqual({
        status: 'REJECTED', reason: 'AUTH_UNAVAILABLE',
      });
      await expect(service.readPersonalRestoreProviderEvidence(identity, OTHER_OWNER)).resolves.toEqual({
        status: 'REJECTED', reason: 'OWNER_MISMATCH',
      });
      await expect(service.readPersonalRestoreProviderEvidence({
        ...identity, receiptId: `${identity.receiptId}-forged`,
      }, OWNER)).resolves.toEqual({ status: 'REJECTED', reason: 'MALFORMED_IDENTITY' });
      expect(open).not.toHaveBeenCalled();
    });

    it('rejects unavailable crypto before opening IndexedDB', async () => {
      const service = TestBed.inject(QueueBackupService);
      const identity = await makeIdentity('crypto-unavailable');
      const open = vi.spyOn(indexedDB, 'open');
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
      Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
      try {
        await expect(service.readPersonalRestoreProviderEvidence(identity, OWNER)).resolves.toEqual({
          status: 'REJECTED', reason: 'CRYPTO_UNAVAILABLE',
        });
        expect(open).not.toHaveBeenCalled();
      } finally {
        if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
      }
    });

    it('uses one frozen identity snapshot after access validation', async () => {
      const service = TestBed.inject(QueueBackupService);
      const original = await makeIdentity('immutable-access');
      const mutable = { ...original };
      await replaceStoreRecords([makeQueueRecord(original, [makeAction('immutable-access')])]);
      const openDatabaseRequest = indexedDB.open.bind(indexedDB);
      vi.spyOn(indexedDB, 'open').mockImplementation((...args) => {
        Object.assign(mutable, {
          ownerUserId: OTHER_OWNER,
          restoreRunId: 'substituted-run',
          participant: 'substituted-participant',
          sourceDigest: `sha256:${'9'.repeat(64)}`,
          token: 'substituted-token',
          recordId: `queue-backup:${OTHER_OWNER}`,
          identityDigest: `sha256:${'7'.repeat(64)}`,
          receiptId: `queue-backup-personal-restore-receipt:v2:${'7'.repeat(64)}`,
        });
        return openDatabaseRequest(...args);
      });

      const evidence = await service.readPersonalRestoreProviderEvidence(mutable, OWNER);

      expect(evidence).toMatchObject({
        status: 'READABLE', identity: original, queue: { status: 'PRESENT_VALID' },
      });
      if (evidence.status === 'READABLE') expect(Object.isFrozen(evidence.identity)).toBe(true);
    });

    it.each(allRawPairs())(
      'classifies queue $queueKind and dead letters $deadLetterKind independently',
      async ({ queueKind, deadLetterKind }) => {
        const service = TestBed.inject(QueueBackupService);
        const identity = await makeIdentity(`matrix-${queueKind}-${deadLetterKind}`);
        await replaceStoreRecords([
          ...rawQueueRecords(identity, queueKind),
          ...rawDeadLetterRecords(identity, deadLetterKind),
        ]);

        const evidence = await service.readPersonalRestoreProviderEvidence(identity, OWNER);

        expect(evidence.status).toBe('READABLE');
        if (evidence.status !== 'READABLE') return;
        expect(evidence.queue.status).toBe(queueKind);
        expect(evidence.deadLetters.status).toBe(deadLetterKind);
        expect(evidence.catalog.status).toBe('ABSENT');
        expect(evidence.receipt.status).toBe('ABSENT');
        expect(evidence.terminal.status).toBe(
          queueKind === 'MALFORMED' ? 'UNVERIFIABLE' : 'NOT_TERMINAL',
        );
      },
    );

    it('treats an oldVersion zero upgrade as confirmed empty without creating a store', async () => {
      const service = TestBed.inject(QueueBackupService);
      const identity = await makeIdentity('confirmed-empty');

      const evidence = await service.readPersonalRestoreProviderEvidence(identity, OWNER);

      expect(evidence).toMatchObject({
        status: 'READABLE', storage: 'CONFIRMED_EMPTY',
        queue: { status: 'ABSENT' }, deadLetters: { status: 'ABSENT' },
        catalog: { status: 'ABSENT' }, receipt: { status: 'ABSENT' },
        terminal: { status: 'NOT_TERMINAL' },
      });
    });

    it('reads queue, dead letters, catalog, and receipt in one readonly transaction', async () => {
      const service = TestBed.inject(QueueBackupService);
      const identity = await makeIdentity('one-transaction');
      await replaceStoreRecords([makeQueueRecord(identity, [makeAction('one-transaction')])]);
      const transaction = vi.spyOn(IDBDatabase.prototype, 'transaction');
      const get = vi.spyOn(IDBObjectStore.prototype, 'get');

      const evidence = await service.readPersonalRestoreProviderEvidence(identity, OWNER);

      expect(evidence.status).toBe('READABLE');
      expect(transaction).toHaveBeenCalledTimes(1);
      expect(transaction.mock.calls[0]?.[1]).toBe('readonly');
      expect(get).toHaveBeenCalledTimes(4);
      expect(get.mock.calls.map(call => call[0])).toEqual([
        identity.recordId,
        `dead-letter-backup:${OWNER}`,
        getQueueBackupPersonalRestoreCatalogId(OWNER),
        identity.receiptId,
      ]);
    });

    it('returns one all-unreadable projection for missing stores and transaction aborts', async () => {
      const service = TestBed.inject(QueueBackupService);
      const identity = await makeIdentity('unreadable');
      await createDatabaseWithoutQueueStore();
      const missingStore = await service.readPersonalRestoreProviderEvidence(identity, OWNER);
      expectUnreadablePair(missingStore);

      await replaceStoreRecords([makeQueueRecord(identity, [makeAction('unreadable')])]);
      const original = IDBDatabase.prototype.transaction;
      vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementationOnce(function (this: IDBDatabase, ...args) {
        const transaction = original.apply(this, args as Parameters<IDBDatabase['transaction']>);
        queueMicrotask(() => transaction.abort());
        return transaction;
      });
      const aborted = await service.readPersonalRestoreProviderEvidence(identity, OWNER);
      expectUnreadablePair(aborted);
    });

    it('returns all-unreadable evidence for open, version, and storage failures', async () => {
      const service = TestBed.inject(QueueBackupService);
      const identity = await makeIdentity('open-failures');
      vi.spyOn(indexedDB, 'open').mockImplementationOnce(() => {
        const request = { error: new DOMException('blocked', 'SecurityError') } as IDBOpenDBRequest;
        queueMicrotask(() => request.onerror?.(new Event('error', { cancelable: true })));
        return request;
      });
      const expectedError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      expectUnreadablePair(await service.readPersonalRestoreProviderEvidence(identity, OWNER));
      expectedError.mockRestore();

      await replaceStoreRecords([], 2);
      expectUnreadablePair(await service.readPersonalRestoreProviderEvidence(identity, OWNER));

      const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
      Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: undefined });
      try {
        expectUnreadablePair(await service.readPersonalRestoreProviderEvidence(identity, OWNER));
      } finally {
        if (descriptor) Object.defineProperty(globalThis, 'indexedDB', descriptor);
      }
    });

    it('closes one late successful open after blocked rejection', async () => {
      const service = TestBed.inject(QueueBackupService);
      const identity = await makeIdentity('blocked-late-success');
      const close = vi.fn();
      const database = {
        version: QUEUE_BACKUP_DB_VERSION,
        objectStoreNames: { contains: () => true },
        close,
      } as unknown as IDBDatabase;
      const request = { result: database } as IDBOpenDBRequest;
      let resolveOpened!: () => void;
      const opened = new Promise<void>(resolve => { resolveOpened = resolve; });
      vi.spyOn(indexedDB, 'open').mockImplementation(() => {
        resolveOpened();
        return request;
      });

      const pending = service.readPersonalRestoreProviderEvidence(identity, OWNER);
      await opened;
      request.onblocked?.(new Event('blocked') as IDBVersionChangeEvent);
      expectUnreadablePair(await pending);
      request.onsuccess?.(new Event('success'));
      expect(close).toHaveBeenCalledTimes(1);
    });

    it('confirms an exact terminal receipt and detects current result digest drift', async () => {
      const service = TestBed.inject(QueueBackupService);
      const identity = await makeIdentity('terminal');
      const incumbent = makeAction('incumbent');
      const restored = makeAction('restored');
      await service.backupQueue([incumbent], OWNER);
      await service.applyPersonalBackupRestoreTransitionV2({
        kind: 'prepare', identity, expectedActions: [incumbent], restoredActions: [restored],
      }, OWNER);
      await service.applyPersonalBackupRestoreTransitionV2({ kind: 'finalize', identity }, OWNER);

      const confirmed = await service.readPersonalRestoreProviderEvidence(identity, OWNER);
      expect(confirmed).toMatchObject({
        status: 'READABLE',
        catalog: { status: 'PRESENT_VALID' }, receipt: { status: 'PRESENT_VALID' },
        terminal: { status: 'TERMINAL_CONFIRMED' },
      });

      await service.backupQueue([makeAction('successor')], OWNER);
      const drifted = await service.readPersonalRestoreProviderEvidence(identity, OWNER);
      expect(drifted).toMatchObject({
        status: 'READABLE', terminal: { status: 'RESULT_DIGEST_DRIFT' },
      });
    });

    it('uses an absent queue as the current empty result and ignores historical recordPresent', async () => {
      const identity = await makeIdentity('absent-result');
      const resultDigest = await digestQueueBackupPersonalRestoreActions('result', []);
      const receipt = makeTerminalReceipt(identity, resultDigest, true);
      const catalog = makeCatalog(identity, receipt);
      await replaceStoreRecords([catalog, receipt]);

      const evidence = await TestBed.inject(QueueBackupService)
        .readPersonalRestoreProviderEvidence(identity, OWNER);

      expect(evidence).toMatchObject({
        status: 'READABLE', queue: { status: 'ABSENT' },
        terminal: { status: 'TERMINAL_CONFIRMED' },
      });
    });

    it('holds active, divergent, colliding, and malformed terminal evidence as unverifiable', async () => {
      const service = TestBed.inject(QueueBackupService);
      const identity = await makeIdentity('holds');
      const incumbent = makeAction('hold-a');
      const restored = makeAction('hold-b');
      await service.backupQueue([incumbent], OWNER);
      await service.applyPersonalBackupRestoreTransitionV2({
        kind: 'prepare', identity, expectedActions: [incumbent], restoredActions: [restored],
      }, OWNER);
      expect(await service.readPersonalRestoreProviderEvidence(identity, OWNER)).toMatchObject({
        terminal: { status: 'UNVERIFIABLE', reason: 'ACTIVE_TRANSITION' },
      });

      const resultDigest = await digestQueueBackupPersonalRestoreActions('result', [restored]);
      const receipt = makeTerminalReceipt(identity, resultDigest, true);
      await replaceStoreRecords([makeQueueRecord(identity, [restored]), makeCatalog(identity, receipt)]);
      expect(await service.readPersonalRestoreProviderEvidence(identity, OWNER)).toMatchObject({
        receipt: { status: 'ABSENT' }, terminal: { status: 'UNVERIFIABLE' },
      });

      await replaceStoreRecords([
        makeQueueRecord(identity, [restored]),
        makeCatalog(identity, receipt),
        { ...receipt, token: 'collision-token' },
      ]);
      expect(await service.readPersonalRestoreProviderEvidence(identity, OWNER)).toMatchObject({
        terminal: { status: 'UNVERIFIABLE' },
      });

      await replaceStoreRecords([
        makeQueueRecord(identity, [restored]),
        { ...makeCatalog(identity, receipt), receipts: { [receipt.id]: { malformed: true } } },
        receipt,
      ]);
      expect(await service.readPersonalRestoreProviderEvidence(identity, OWNER)).toMatchObject({
        catalog: { status: 'MALFORMED' }, terminal: { status: 'UNVERIFIABLE' },
      });
    });

    it('invalidates the whole catalog when a non-selected receipt identity is corrupt', async () => {
      const identity = await makeIdentity('selected-receipt');
      const otherIdentity = await makeIdentity('non-selected-receipt');
      const digest = await digestQueueBackupPersonalRestoreActions('result', []);
      const selected = makeTerminalReceipt(identity, digest, false);
      const other = makeTerminalReceipt(otherIdentity, digest, false);
      const catalog = {
        ...makeCatalog(identity, selected),
        receiptIds: [selected.receiptId, other.receiptId],
        receipts: {
          [selected.receiptId]: selected,
          [other.receiptId]: { ...other, token: 'corrupted-non-selected-token' },
        },
      };
      await replaceStoreRecords([catalog, selected]);

      const evidence = await TestBed.inject(QueueBackupService)
        .readPersonalRestoreProviderEvidence(identity, OWNER);

      expect(evidence).toMatchObject({
        catalog: { status: 'MALFORMED' },
        terminal: { status: 'UNVERIFIABLE', reason: 'MALFORMED_EVIDENCE' },
      });
    });

    it.each(strictActionRejections())('rejects non-plain or non-exact action evidence: $name', async ({ action }) => {
      const identity = await makeIdentity('strict-action');
      const evidence = await projectQueueBackupRestoreProviderEvidence(
        identity,
        rawSnapshot({ ...makeQueueRecord(identity, []), actions: [action] }),
      );
      expect(evidence.queue.status).toBe('MALFORMED');
    });

    it('requires canonical round-trip timestamps for all four persisted fields', async () => {
      const identity = await makeIdentity('timestamps');
      const digest = await digestQueueBackupPersonalRestoreActions('result', []);
      const receipt = makeTerminalReceipt(identity, digest, false);
      const invalid = '2026-02-30T00:00:00.000Z';
      const cases = [
        { slot: 'queue', raw: rawSnapshot({ ...makeQueueRecord(identity, []), savedAt: invalid }) },
        {
          slot: 'deadLetters',
          raw: rawSnapshot(undefined, { ...makeDeadLetterRecord(identity), savedAt: invalid }),
        },
        {
          slot: 'deadLetters',
          raw: rawSnapshot(undefined, {
            ...makeDeadLetterRecord(identity),
            deadLetters: [{ ...makeDeadLetterRecord(identity).deadLetters[0], failedAt: invalid }],
          }),
        },
        { slot: 'receipt', raw: rawSnapshot(undefined, undefined, undefined, { ...receipt, completedAt: invalid }) },
      ] as const;

      for (const current of cases) {
        const evidence = await projectQueueBackupRestoreProviderEvidence(identity, current.raw);
        expect(evidence[current.slot].status, current.slot).toBe('MALFORMED');
      }
    });

    it('makes authenticated result-digest failure unverifiable in the service path', async () => {
      const identity = await makeIdentity('digest-unavailable');
      const action = makeAction('digest-action');
      const resultDigest = await digestQueueBackupPersonalRestoreActions('result', [action]);
      const receipt = makeTerminalReceipt(identity, resultDigest, true);
      await replaceStoreRecords([makeQueueRecord(identity, [action]), makeCatalog(identity, receipt), receipt]);
      const digest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
      vi.spyOn(globalThis.crypto.subtle, 'digest').mockImplementation((algorithm, data) => {
        const domain = new TextDecoder().decode(data as ArrayBufferView<ArrayBuffer>);
        return domain.startsWith('nanoflow.queue-backup.personal-restore.action-digest.result\0v2\0')
          ? Promise.reject(new Error('result digest unavailable'))
          : digest(algorithm, data);
      });

      const evidence = await TestBed.inject(QueueBackupService)
        .readPersonalRestoreProviderEvidence(identity, OWNER);

      expect(evidence).toMatchObject({
        status: 'READABLE',
        terminal: { status: 'UNVERIFIABLE', reason: 'RESULT_DIGEST_UNAVAILABLE', recordPresent: true },
      });
    });

    it('defensively clones and freezes values while retaining canonical raw signatures', async () => {
      const identity = await makeIdentity('immutable');
      const record = makeQueueRecord(identity, [makeAction('immutable-action')]);
      const raw = rawSnapshot(record);
      const expectedSignature = canonicalizePersistedValue(raw.queue.status === 'PRESENT' ? raw.queue.value : undefined);
      const evidence = await projectQueueBackupRestoreProviderEvidence(identity, raw);
      record.actions[0].retryCount = 9;

      expect(evidence.queue.status).toBe('PRESENT_VALID');
      if (evidence.queue.status !== 'PRESENT_VALID') return;
      expect(evidence.queue.value.actions[0].retryCount).toBe(0);
      expect(evidence.queue.rawSignature).toBe(expectedSignature);
      expect(Object.isFrozen(evidence)).toBe(true);
      expect(Object.isFrozen(evidence.queue.value.actions[0].payload)).toBe(true);
    });

  });
}

function allRawPairs(): Array<{ queueKind: RawKind; deadLetterKind: RawKind }> {
  const kinds: RawKind[] = ['PRESENT_VALID', 'ABSENT', 'MALFORMED'];
  return kinds.flatMap(queueKind => kinds.map(deadLetterKind => ({ queueKind, deadLetterKind })));
}

async function makeIdentity(suffix: string): Promise<QueueBackupPersonalRestoreIdentityV2> {
  return createQueueBackupPersonalRestoreIdentity({
    ownerUserId: OWNER,
    restoreRunId: `provider-${suffix}`,
    participant: 'action-queue',
    sourceDigest: SOURCE_DIGEST,
    token: `provider-token-${suffix}`,
  });
}

function makeAction(id: string): QueuedAction {
  return {
    id, operationId: `operation-${id}`, type: 'update', entityType: 'task', entityId: id,
    payload: { task: { id, title: id }, projectId: 'provider-project' } as QueuedAction['payload'],
    timestamp: 1, retryCount: 0,
  };
}

function strictActionRejections(): Array<{ name: string; action: unknown }> {
  const action = makeAction('strict');
  class Payload { readonly value = 'class-instance'; }
  return [
    { name: 'unknown key', action: { ...action, unexpected: true } },
    { name: 'invalid sync state', action: { ...action, syncState: 'bogus' } },
    { name: 'invalid priority', action: { ...action, priority: 'urgent' } },
    { name: 'invalid error type', action: { ...action, errorType: 'bogus' } },
    { name: 'invalid local commit timestamp', action: { ...action, localCommittedAt: Number.NaN } },
    { name: 'class payload', action: { ...action, payload: new Payload() } },
    { name: 'date payload', action: { ...action, payload: { value: new Date(0) } } },
    { name: 'map payload', action: { ...action, payload: { value: new Map([['key', 'value']]) } } },
    { name: 'invalid local handoff', action: { ...action, localHandoff: { kind: 'wrong' } } },
    { name: 'invalid retry supersession', action: { ...action, retryQueueSupersessions: [{ token: 'partial' }] } },
  ];
}

function makeQueueRecord(
  identity: QueueBackupPersonalRestoreIdentityV2,
  actions: QueuedAction[],
): QueueBackupRecord {
  return { id: identity.recordId, ownerUserId: OWNER, actions, savedAt: '2026-08-02T00:00:00.000Z' };
}

function makeDeadLetterRecord(identity: QueueBackupPersonalRestoreIdentityV2): DeadLetterBackupRecord {
  const deadLetter: DeadLetterItem = {
    action: makeAction('dead-letter'), failedAt: '2026-08-02T00:00:00.000Z', reason: 'terminal',
  };
  return {
    id: `dead-letter-backup:${identity.ownerUserId}`,
    ownerUserId: identity.ownerUserId,
    deadLetters: [deadLetter],
    savedAt: '2026-08-02T00:00:00.000Z',
  };
}

function rawQueueRecords(identity: QueueBackupPersonalRestoreIdentityV2, kind: RawKind): unknown[] {
  if (kind === 'ABSENT') return [];
  if (kind === 'MALFORMED') return [{ id: identity.recordId, ownerUserId: OWNER, actions: 'bad' }];
  return [makeQueueRecord(identity, [makeAction('matrix-queue')])];
}

function rawDeadLetterRecords(identity: QueueBackupPersonalRestoreIdentityV2, kind: RawKind): unknown[] {
  if (kind === 'ABSENT') return [];
  if (kind === 'MALFORMED') {
    return [{ id: `dead-letter-backup:${OWNER}`, ownerUserId: OWNER, deadLetters: 'bad' }];
  }
  return [makeDeadLetterRecord(identity)];
}

function makeTerminalReceipt(
  identity: QueueBackupPersonalRestoreIdentityV2,
  resultDigest: string,
  recordPresent: boolean,
) {
  return {
    ...identity,
    id: identity.receiptId,
    kind: 'queue-backup-personal-restore-receipt' as const,
    schemaVersion: 2 as const,
    outcome: 'abandoned-before-prepare' as const,
    abandonReason: 'marker-committed-before-queue-prepare' as const,
    recordPresent,
    resultDigest,
    completedAt: '2026-08-02T00:00:00.000Z',
  };
}

function makeCatalog(identity: QueueBackupPersonalRestoreIdentityV2, receipt: ReturnType<typeof makeTerminalReceipt>) {
  return {
    id: getQueueBackupPersonalRestoreCatalogId(identity.ownerUserId),
    kind: 'queue-backup-personal-restore-receipt-catalog' as const,
    schemaVersion: 2 as const,
    ownerUserId: identity.ownerUserId,
    receiptIds: [receipt.receiptId],
    receipts: { [receipt.receiptId]: receipt },
  };
}

function rawSnapshot(
  queue?: unknown,
  deadLetters?: unknown,
  catalog?: unknown,
  receipt?: unknown,
): QueueBackupRestoreProviderRawSnapshot {
  return {
    queue: queue === undefined ? { status: 'ABSENT' } : { status: 'PRESENT', value: queue },
    deadLetters: deadLetters === undefined ? { status: 'ABSENT' } : { status: 'PRESENT', value: deadLetters },
    catalog: catalog === undefined ? { status: 'ABSENT' } : { status: 'PRESENT', value: catalog },
    receipt: receipt === undefined ? { status: 'ABSENT' } : { status: 'PRESENT', value: receipt },
  };
}

async function replaceStoreRecords(records: unknown[], version = QUEUE_BACKUP_DB_VERSION): Promise<void> {
  await deleteDatabase();
  const db = await openDatabase(version, true);
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(QUEUE_BACKUP_STORE_NAME, 'readwrite');
    const store = transaction.objectStore(QUEUE_BACKUP_STORE_NAME);
    records.forEach(record => store.put(record));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error('fixture transaction aborted'));
  });
  db.close();
}

async function createDatabaseWithoutQueueStore(): Promise<void> {
  await deleteDatabase();
  const db = await openDatabase(QUEUE_BACKUP_DB_VERSION, false);
  db.close();
}

function openDatabase(version: number, createQueueStore: boolean): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(QUEUE_BACKUP_DB_NAME, version);
    request.onupgradeneeded = () => {
      if (createQueueStore) request.result.createObjectStore(QUEUE_BACKUP_STORE_NAME, { keyPath: 'id' });
      else request.result.createObjectStore('unrelated', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function deleteDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(QUEUE_BACKUP_DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('fixture delete blocked'));
  });
}

function expectUnreadablePair(value: unknown): void {
  expect(value).toMatchObject({
    status: 'UNREADABLE',
    queue: { status: 'UNREADABLE' },
    deadLetters: { status: 'UNREADABLE' },
    catalog: { status: 'UNREADABLE' },
    receipt: { status: 'UNREADABLE' },
    terminal: { status: 'UNVERIFIABLE' },
  });
}
