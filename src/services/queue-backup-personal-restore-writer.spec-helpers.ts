import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';

import {
  normalizeQueueBackupRecord,
  restoreActionQueue,
  restoreQueueBackupRecord,
} from './data-safety-indexeddb-action-queue-local-state';
import {
  QUEUE_BACKUP_DB_NAME,
  QUEUE_BACKUP_DB_VERSION,
  QUEUE_BACKUP_STORE_NAME,
  QueueBackupService,
  type QueueBackupRecord,
} from './queue-backup.service';
import type { QueuedAction } from './action-queue.types';
import type { DataSafetyQueuedAction } from './data-safety-package';
import { createQueueBackupPersonalRestoreIdentity } from './queue-backup-personal-restore-transition.helpers';

const OWNER = 'user-1';
const TOKEN = 'restore-token-1';

export function registerQueueBackupPersonalRestoreWriterSpecs(): void {
  describe('personal restore transition writer', () => {
    it('prepares A+B, protects it from ordinary writers, and finalizes B+C', async () => {
      const service = TestBed.inject(QueueBackupService);
      const incumbent = makeAction('incumbent');
      const restored = makeAction('restored');
      const successor = makeAction('successor');
      await service.backupQueue([incumbent], OWNER);

      const prepared = await service.applyPersonalBackupRestoreTransition(OWNER, {
        kind: 'prepare',
        token: TOKEN,
        expectedActions: [incumbent],
        restoredActions: [restored],
      });
      const protectedWrite = await service.updateQueueStrictly(OWNER, () => [restored]);
      const added = await service.updateQueueStrictly(OWNER, queue => [...queue, successor]);
      const finalized = await service.applyPersonalBackupRestoreTransition(OWNER, {
        kind: 'finalize',
        token: TOKEN,
      });

      expect(prepared.status).toBe('prepared');
      expect(protectedWrite.status).toBe('protected-restore');
      expect(added.status).toBe('committed');
      expect(finalized.status).toBe('finalized');
      await expect(service.restoreQueue(OWNER)).resolves.toEqual([restored, successor]);

      const terminalRecord = await findTerminalReceipt(TOKEN);
      expect(terminalRecord).toMatchObject({
        kind: 'queue-backup-personal-restore-receipt',
        ownerUserId: OWNER,
        token: TOKEN,
        outcome: 'finalized',
      });
      expect(terminalRecord?.['resultDigest']).toMatch(/^sha256:[a-f0-9]{64}$/);
    });

    it('protects exact V2 A+B and rejects the opposite terminal command', async () => {
      const service = TestBed.inject(QueueBackupService);
      const incumbent = makeAction('v2-protected-a');
      const restored = makeAction('v2-protected-b');
      const successor = makeAction('v2-successor-c');
      const identity = await createQueueBackupPersonalRestoreIdentity({
        ownerUserId: OWNER, restoreRunId: 'v2-protected-run', participant: 'action-queue',
        sourceDigest: `sha256:${'2'.repeat(64)}`, token: 'v2-protected-token',
      });
      await service.backupQueue([incumbent], OWNER);
      await service.applyPersonalBackupRestoreTransitionV2({
        kind: 'prepare', identity, expectedActions: [incumbent], restoredActions: [restored],
      }, OWNER);

      const removedA = await service.updateQueueStrictly(OWNER, queue =>
        queue.filter(action => action.id !== incumbent.id));
      const replacedB = await service.updateQueueStrictly(OWNER, queue => queue.map(action =>
        action.id === restored.id ? { ...action, retryCount: action.retryCount + 1 } : action));
      const addedC = await service.updateQueueStrictly(OWNER, queue => [...queue, successor]);
      const removedC = await service.updateQueueStrictly(OWNER, queue =>
        queue.filter(action => action.id !== successor.id));
      await service.applyPersonalBackupRestoreTransitionV2({ kind: 'finalize', identity }, OWNER);
      const opposite = await service.applyPersonalBackupRestoreTransitionV2({ kind: 'rollback', identity }, OWNER);

      expect(removedA.status).toBe('protected-restore');
      expect(replacedB.status).toBe('protected-restore');
      expect(addedC.status).toBe('committed');
      expect(removedC.status).toBe('committed');
      expect(opposite).toEqual({ status: 'rejected', reason: 'opposite-terminal' });
      await expect(service.restoreQueue(OWNER)).resolves.toEqual([restored]);
    });

    it('rolls back to A+C and returns the immutable receipt on a lost acknowledgement retry', async () => {
      const service = TestBed.inject(QueueBackupService);
      const incumbent = makeAction('rollback-incumbent');
      const restored = makeAction('rollback-restored');
      const successor = makeAction('rollback-successor');
      await service.backupQueue([incumbent], OWNER);
      await service.applyPersonalBackupRestoreTransition(OWNER, {
        kind: 'prepare', token: TOKEN, expectedActions: [incumbent], restoredActions: [restored],
      });
      await service.updateQueueStrictly(OWNER, queue => [...queue, successor]);

      const rolledBack = await service.applyPersonalBackupRestoreTransition(OWNER, {
        kind: 'rollback', token: TOKEN,
      });
      const receiptBeforeRetry = JSON.stringify(await findTerminalReceipt(TOKEN));
      const retried = await service.applyPersonalBackupRestoreTransition(OWNER, {
        kind: 'rollback', token: TOKEN,
      });

      expect(rolledBack.status).toBe('rolled-back');
      expect(retried.status).toBe('already-rolled-back');
      await expect(service.restoreQueue(OWNER)).resolves.toEqual([incumbent, successor]);
      expect(JSON.stringify(await findTerminalReceipt(TOKEN))).toBe(receiptBeforeRetry);
    });

    it('rejects a divergent complete persisted action and leaves raw bytes unchanged', async () => {
      const service = TestBed.inject(QueueBackupService);
      const incumbent = makeAction('identity-incumbent');
      await service.backupQueue([incumbent], OWNER);
      const before = JSON.stringify(await readStoreValue(`queue-backup:${OWNER}`));

      const result = await service.applyPersonalBackupRestoreTransition(OWNER, {
        kind: 'prepare',
        token: TOKEN,
        expectedActions: [{ ...incumbent, retryCount: incumbent.retryCount + 1 }],
        restoredActions: [makeAction('identity-restored')],
      });

      expect(result).toEqual({ status: 'rejected', reason: 'identity-mismatch' });
      expect(JSON.stringify(await readStoreValue(`queue-backup:${OWNER}`))).toBe(before);
      expect(await findTerminalReceipt(TOKEN)).toBeNull();
    });

    it('rejects a divergent same operation identity without replacing the incumbent', async () => {
      const service = TestBed.inject(QueueBackupService);
      const incumbent = makeAction('same-operation-incumbent');
      const divergent = {
        ...incumbent,
        id: 'replacement-id',
        payload: { ...incumbent.payload, projectId: 'project-2' },
      } as QueuedAction;
      await service.backupQueue([incumbent], OWNER);

      const result = await service.applyPersonalBackupRestoreTransition(OWNER, {
        kind: 'prepare', token: TOKEN, expectedActions: [incumbent], restoredActions: [divergent],
      });

      expect(result).toEqual({ status: 'rejected', reason: 'identity-conflict' });
      await expect(service.restoreQueue(OWNER)).resolves.toEqual([incumbent]);
    });

    it('keeps PREPARED durable when commit succeeds but authoritative readback fails', async () => {
      const service = TestBed.inject(QueueBackupService);
      const incumbent = makeAction('readback-incumbent');
      const restored = makeAction('readback-restored');
      await service.backupQueue([incumbent], OWNER);
      const transaction = IDBDatabase.prototype.transaction;
      let readwriteObserved = false;
      vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (
        this: IDBDatabase,
        storeNames: string | Iterable<string>,
        mode?: IDBTransactionMode,
        options?: IDBTransactionOptions,
      ) {
        if (mode === 'readwrite') readwriteObserved = true;
        if (mode === 'readonly' && readwriteObserved) {
          throw new DOMException('forced postcommit readback failure', 'AbortError');
        }
        return transaction.call(this, storeNames, mode, options);
      });

      const result = await service.applyPersonalBackupRestoreTransition(OWNER, {
        kind: 'prepare', token: TOKEN, expectedActions: [incumbent], restoredActions: [restored],
      });
      vi.restoreAllMocks();
      const retried = await service.applyPersonalBackupRestoreTransition(OWNER, {
        kind: 'prepare', token: TOKEN, expectedActions: [incumbent], restoredActions: [restored],
      });

      expect(result.status).toBe('storage-failed');
      expect(retried.status).toBe('already-prepared');
      await expect(service.restoreQueue(OWNER)).resolves.toEqual([incumbent, restored]);
    });

    it('leaves A and terminal evidence unchanged when the readwrite transaction aborts', async () => {
      const service = TestBed.inject(QueueBackupService);
      const incumbent = makeAction('abort-incumbent');
      await service.backupQueue([incumbent], OWNER);
      const before = JSON.stringify(await readAllStoreValues());
      vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(() => {
        throw new DOMException('forced prepare abort', 'AbortError');
      });

      const result = await service.applyPersonalBackupRestoreTransition(OWNER, {
        kind: 'prepare',
        token: TOKEN,
        expectedActions: [incumbent],
        restoredActions: [makeAction('abort-restored')],
      });

      expect(result.status).toBe('storage-failed');
      expect(JSON.stringify(await readAllStoreValues())).toBe(before);
    });

    it('rejects the opposite terminal command and preserves the first terminal receipt', async () => {
      const service = TestBed.inject(QueueBackupService);
      const incumbent = makeAction('terminal-incumbent');
      const restored = makeAction('terminal-restored');
      await service.backupQueue([incumbent], OWNER);
      await service.applyPersonalBackupRestoreTransition(OWNER, {
        kind: 'prepare', token: TOKEN, expectedActions: [incumbent], restoredActions: [restored],
      });
      await service.applyPersonalBackupRestoreTransition(OWNER, { kind: 'finalize', token: TOKEN });
      const receipt = JSON.stringify(await findTerminalReceipt(TOKEN));

      const result = await service.applyPersonalBackupRestoreTransition(OWNER, {
        kind: 'rollback', token: TOKEN,
      });

      expect(result).toEqual({ status: 'rejected', reason: 'terminal-conflict' });
      expect(JSON.stringify(await findTerminalReceipt(TOKEN))).toBe(receipt);
      await expect(service.restoreQueue(OWNER)).resolves.toEqual([restored]);
    });

    it.each(['preimageDigest', 'restoredDigest', 'preparedActionsDigest'] as const)(
      'rejects terminal settlement when persisted %s is not content-bound',
      async (digestField) => {
        const service = TestBed.inject(QueueBackupService);
        const incumbent = makeAction(`tampered-${digestField}-incumbent`);
        const restored = makeAction(`tampered-${digestField}-restored`);
        await service.backupQueue([incumbent], OWNER);
        await service.applyPersonalBackupRestoreTransition(OWNER, {
          kind: 'prepare', token: TOKEN, expectedActions: [incumbent], restoredActions: [restored],
        });
        const recordId = `queue-backup:${OWNER}`;
        const raw = await readStoreValue(recordId) as unknown as QueueBackupRecord;
        Reflect.set(raw.personalRestoreTransition!, digestField, `sha256:${'f'.repeat(64)}`);
        await putRawStoreValue(raw);

        const result = await service.applyPersonalBackupRestoreTransition(OWNER, {
          kind: 'finalize', token: TOKEN,
        });

        expect(result).toEqual({ status: 'rejected', reason: 'identity-mismatch' });
        expect(await findTerminalReceipt(TOKEN)).toBeNull();
        await expect(service.restoreQueue(OWNER)).resolves.toEqual([incumbent, restored]);
      },
    );

    it('fails closed when DataSafety restore would overwrite a PREPARED A+B record', async () => {
      const service = TestBed.inject(QueueBackupService);
      const incumbent = makeAction('data-safety-incumbent');
      const restored = makeAction('data-safety-restored');
      await service.backupQueue([incumbent], OWNER);
      await service.applyPersonalBackupRestoreTransition(OWNER, {
        kind: 'prepare', token: TOKEN, expectedActions: [incumbent], restoredActions: [restored],
      });
      const before = JSON.stringify(await readAllStoreValues());

      await expect(restoreActionQueue(OWNER, [makeAction('data-safety-replacement')]))
        .rejects.toThrow('prepared personal restore');

      expect(JSON.stringify(await readAllStoreValues())).toBe(before);
      await expect(service.restoreQueue(OWNER)).resolves.toEqual([incumbent, restored]);
    });

    it('rejects a stale queue-backup rollback while a newer PREPARED record is current', async () => {
      const service = TestBed.inject(QueueBackupService);
      const incumbent = makeAction('stale-rollback-incumbent');
      await service.backupQueue([incumbent], OWNER);
      const recordId = `queue-backup:${OWNER}`;
      const stale = await readStoreValue(recordId) as unknown as QueueBackupRecord;
      await service.applyPersonalBackupRestoreTransition(OWNER, {
        kind: 'prepare', token: TOKEN, expectedActions: [incumbent],
        restoredActions: [makeAction('stale-rollback-restored')],
      });
      const before = JSON.stringify(await readStoreValue(recordId));

      await expect(restoreQueueBackupRecord(recordId, stale))
        .rejects.toThrow('prepared personal restore');

      expect(JSON.stringify(await readStoreValue(recordId))).toBe(before);
    });

    it('rejects a null queue-backup rollback while a PREPARED record is current', async () => {
      const service = TestBed.inject(QueueBackupService);
      const incumbent = makeAction('null-rollback-incumbent');
      await service.backupQueue([incumbent], OWNER);
      const recordId = `queue-backup:${OWNER}`;
      await service.applyPersonalBackupRestoreTransition(OWNER, {
        kind: 'prepare', token: TOKEN, expectedActions: [incumbent],
        restoredActions: [makeAction('null-rollback-restored')],
      });
      const before = JSON.stringify(await readStoreValue(recordId));

      await expect(restoreQueueBackupRecord(recordId, null))
        .rejects.toThrow('prepared personal restore');

      expect(JSON.stringify(await readStoreValue(recordId))).toBe(before);
    });

    it('rejects explicit full wipe while a personal restore remains PREPARED', async () => {
      const service = TestBed.inject(QueueBackupService);
      const incumbent = makeAction('full-wipe-incumbent');
      const restored = makeAction('full-wipe-restored');
      await service.backupQueue([incumbent], OWNER);
      await service.applyPersonalBackupRestoreTransition(OWNER, {
        kind: 'prepare', token: TOKEN, expectedActions: [incumbent], restoredActions: [restored],
      });
      const before = JSON.stringify(await readAllStoreValues());

      await expect(service.clearQueueForFullWipe(OWNER)).resolves.toBe(false);

      expect(JSON.stringify(await readAllStoreValues())).toBe(before);
      await expect(service.restoreQueue(OWNER)).resolves.toEqual([incumbent, restored]);
    });

    it('recovers a terminal lost acknowledgement from its immutable receipt', async () => {
      const service = TestBed.inject(QueueBackupService);
      const incumbent = makeAction('terminal-readback-incumbent');
      const restored = makeAction('terminal-readback-restored');
      await service.backupQueue([incumbent], OWNER);
      await service.applyPersonalBackupRestoreTransition(OWNER, {
        kind: 'prepare', token: TOKEN, expectedActions: [incumbent], restoredActions: [restored],
      });
      failNextReadonlyAfterReadwrite();

      const first = await service.applyPersonalBackupRestoreTransition(OWNER, {
        kind: 'finalize', token: TOKEN,
      });
      vi.restoreAllMocks();
      const retry = await service.applyPersonalBackupRestoreTransition(OWNER, {
        kind: 'finalize', token: TOKEN,
      });

      expect(first).toEqual({ status: 'storage-failed' });
      expect(retry).toEqual({ status: 'already-finalized' });
      await expect(service.restoreQueue(OWNER)).resolves.toEqual([restored]);
    });

    it('aborts terminal settlement atomically when receipt insertion fails', async () => {
      const service = TestBed.inject(QueueBackupService);
      const incumbent = makeAction('receipt-abort-incumbent');
      const restored = makeAction('receipt-abort-restored');
      await service.backupQueue([incumbent], OWNER);
      await service.applyPersonalBackupRestoreTransition(OWNER, {
        kind: 'prepare', token: TOKEN, expectedActions: [incumbent], restoredActions: [restored],
      });
      const before = JSON.stringify(await readAllStoreValues());
      vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementationOnce(() => {
        throw new DOMException('forced receipt insertion abort', 'AbortError');
      });

      const result = await service.applyPersonalBackupRestoreTransition(OWNER, {
        kind: 'finalize', token: TOKEN,
      });

      expect(result).toEqual({ status: 'storage-failed' });
      expect(JSON.stringify(await readAllStoreValues())).toBe(before);
      expect(await findTerminalReceipt(TOKEN)).toBeNull();
    });

    it('rejects a stale terminal CAS and preserves concurrently added C for retry', async () => {
      const service = TestBed.inject(QueueBackupService);
      const incumbent = makeAction('stale-cas-incumbent');
      const restored = makeAction('stale-cas-restored');
      const successor = makeAction('stale-cas-successor');
      await service.backupQueue([incumbent], OWNER);
      await service.applyPersonalBackupRestoreTransition(OWNER, {
        kind: 'prepare', token: TOKEN, expectedActions: [incumbent], restoredActions: [restored],
      });
      const digest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
      let injected = false;
      vi.spyOn(globalThis.crypto.subtle, 'digest').mockImplementation(async (algorithm, data) => {
        if (!injected) {
          injected = true;
          await service.updateQueueStrictly(OWNER, queue => [...queue, successor]);
        }
        return digest(algorithm, data);
      });

      const stale = await service.applyPersonalBackupRestoreTransition(OWNER, {
        kind: 'finalize', token: TOKEN,
      });
      vi.restoreAllMocks();
      const retried = await service.applyPersonalBackupRestoreTransition(OWNER, {
        kind: 'finalize', token: TOKEN,
      });

      expect(stale).toEqual({ status: 'storage-failed' });
      expect(retried).toEqual({ status: 'finalized' });
      await expect(service.restoreQueue(OWNER)).resolves.toEqual([restored, successor]);
    });

    it('reports DataSafety commit-before-readback as failed without erasing durable bytes', async () => {
      const service = TestBed.inject(QueueBackupService);
      const restored = makeAction('data-safety-readback');
      abortNextReadonlyAfterReadwrite();

      await expect(restoreActionQueue(OWNER, [restored]))
        .rejects.toMatchObject({ name: 'AbortError' });
      vi.restoreAllMocks();

      await expect(service.restoreQueue(OWNER)).resolves.toEqual([restored]);
    });
  });
}

export function registerQueueBackupPersonalRestoreDataSafetySpecs(): void {
  describe('queue backup transition normalization', () => {
    it('preserves a valid raw PREPARED transition and forward-compatible fields', () => {
      const incumbent = makeAction('normalized-incumbent');
      const restored = makeAction('normalized-restored');
      const transition = makePreparedTransition(incumbent, restored);
      const raw = {
        id: `queue-backup:${OWNER}`,
        ownerUserId: OWNER,
        actions: [incumbent, restored],
        savedAt: '2026-08-02T00:00:00.000Z',
        personalRestoreTransition: transition,
        futureQueueBackupField: { retained: true },
      };

      const normalized = normalizeQueueBackupRecord(raw);

      expect(normalized?.personalRestoreTransition).toBe(transition);
      expect(Reflect.get(normalized ?? {}, 'futureQueueBackupField')).toEqual({ retained: true });
      expect(normalized?.actions).toBe(raw.actions);
    });

    it('rejects malformed transition metadata without filtering or reconstruction', () => {
      const incumbent = makeAction('malformed-incumbent');
      const raw = {
        id: `queue-backup:${OWNER}`,
        ownerUserId: OWNER,
        actions: [incumbent],
        savedAt: '2026-08-02T00:00:00.000Z',
        personalRestoreTransition: {
          ...makePreparedTransition(incumbent, makeAction('malformed-restored')),
          preimageDigest: 'not-a-canonical-digest',
        },
      };

      expect(normalizeQueueBackupRecord(raw)).toBeNull();
      expect(raw.actions).toEqual([incumbent]);
    });

    it('rejects a PREPARED record whose persisted actions omit protected B', () => {
      const incumbent = makeAction('missing-b-incumbent');
      const restored = makeAction('missing-b-restored');
      const raw = {
        id: `queue-backup:${OWNER}`,
        ownerUserId: OWNER,
        actions: [incumbent],
        savedAt: '2026-08-02T00:00:00.000Z',
        personalRestoreTransition: makePreparedTransition(incumbent, restored),
      };

      expect(normalizeQueueBackupRecord(raw)).toBeNull();
    });

    it.each(['id', 'operationId'] as const)(
      'rejects duplicate protected %s identity across A+B',
      (identityField) => {
        const incumbent = makeAction(`duplicate-${identityField}-incumbent`);
        const restored = makeAction(`duplicate-${identityField}-restored`);
        Reflect.set(restored, identityField, incumbent[identityField]);
        const raw = {
          id: `queue-backup:${OWNER}`,
          ownerUserId: OWNER,
          actions: [incumbent, restored],
          savedAt: '2026-08-02T00:00:00.000Z',
          personalRestoreTransition: makePreparedTransition(incumbent, restored),
        };

        expect(normalizeQueueBackupRecord(raw)).toBeNull();
      },
    );
  });
}

function makeAction(id: string): QueuedAction & DataSafetyQueuedAction {
  return {
    id,
    operationId: `op-${id}`,
    type: 'update',
    entityType: 'task',
    entityId: id,
    payload: {
      task: {
        id, title: id, content: '', stage: 1, parentId: null, order: 0, rank: 10000,
        status: 'active', x: 0, y: 0, displayId: id, createdDate: '2026-08-02T00:00:00.000Z',
      },
      projectId: 'project-1',
    },
    timestamp: 1,
    retryCount: 0,
  } as QueuedAction & DataSafetyQueuedAction;
}

function makePreparedTransition(incumbent: QueuedAction, restored: QueuedAction) {
  return {
    schemaVersion: 1 as const,
    state: 'prepared' as const,
    ownerUserId: OWNER,
    token: TOKEN,
    preimage: [incumbent],
    preimageDigest: `sha256:${'a'.repeat(64)}`,
    restoredActions: [restored],
    restoredDigest: `sha256:${'b'.repeat(64)}`,
    preparedActionsDigest: `sha256:${'c'.repeat(64)}`,
    preparedAt: '2026-08-02T00:00:00.000Z',
  };
}

async function findTerminalReceipt(token: string): Promise<Record<string, unknown> | null> {
  const values = await readAllStoreValues();
  return values.find(value => value['kind'] === 'queue-backup-personal-restore-receipt'
    && value['token'] === token) ?? null;
}

async function readStoreValue(id: string): Promise<Record<string, unknown> | null> {
  const db = await openQueueBackupDb();
  try {
    return await new Promise((resolve, reject) => {
      let value: Record<string, unknown> | null = null;
      const tx = db.transaction(QUEUE_BACKUP_STORE_NAME, 'readonly');
      const request = tx.objectStore(QUEUE_BACKUP_STORE_NAME).get(id);
      request.onsuccess = () => { value = request.result ?? null; };
      request.onerror = () => reject(request.error);
      tx.oncomplete = () => resolve(value);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('read transaction aborted'));
    });
  } finally {
    db.close();
  }
}

async function readAllStoreValues(): Promise<Record<string, unknown>[]> {
  const db = await openQueueBackupDb();
  try {
    return await new Promise((resolve, reject) => {
      let values: Record<string, unknown>[] = [];
      const tx = db.transaction(QUEUE_BACKUP_STORE_NAME, 'readonly');
      const request = tx.objectStore(QUEUE_BACKUP_STORE_NAME).getAll();
      request.onsuccess = () => { values = request.result ?? []; };
      request.onerror = () => reject(request.error);
      tx.oncomplete = () => resolve(values);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('read transaction aborted'));
    });
  } finally {
    db.close();
  }
}

async function putRawStoreValue(record: QueueBackupRecord): Promise<void> {
  const db = await openQueueBackupDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(QUEUE_BACKUP_STORE_NAME, 'readwrite');
      tx.objectStore(QUEUE_BACKUP_STORE_NAME).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('write transaction aborted'));
    });
  } finally {
    db.close();
  }
}

function openQueueBackupDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(QUEUE_BACKUP_DB_NAME, QUEUE_BACKUP_DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

function failNextReadonlyAfterReadwrite(): void {
  const transaction = IDBDatabase.prototype.transaction;
  let readwriteObserved = false;
  vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (
    this: IDBDatabase,
    storeNames: string | Iterable<string>,
    mode?: IDBTransactionMode,
    options?: IDBTransactionOptions,
  ) {
    if (mode === 'readwrite') readwriteObserved = true;
    if (mode === 'readonly' && readwriteObserved) {
      throw new DOMException('forced postcommit readback failure', 'AbortError');
    }
    return transaction.call(this, storeNames, mode, options);
  });
}

function abortNextReadonlyAfterReadwrite(): void {
  const transaction = IDBDatabase.prototype.transaction;
  let readwriteObserved = false;
  vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (
    this: IDBDatabase,
    storeNames: string | Iterable<string>,
    mode?: IDBTransactionMode,
    options?: IDBTransactionOptions,
  ) {
    const tx = transaction.call(this, storeNames, mode, options);
    if (mode === 'readwrite') readwriteObserved = true;
    if (mode === 'readonly' && readwriteObserved) queueMicrotask(() => tx.abort());
    return tx;
  });
}
