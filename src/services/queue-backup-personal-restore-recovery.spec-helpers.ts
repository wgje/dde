import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LoggerService } from './logger.service';
import {
  QUEUE_BACKUP_DB_NAME,
  QUEUE_BACKUP_DB_VERSION,
  QUEUE_BACKUP_STORE_NAME,
  QueueBackupService,
} from './queue-backup.service';
import type { QueuedAction } from './action-queue.types';
import {
  createQueueBackupPersonalRestoreIdentity,
  digestQueueBackupPersonalRestoreActions,
  getQueueBackupPersonalRestoreCatalogId,
} from './queue-backup-personal-restore-transition.helpers';

const OWNER = 'user-1';
const SOURCE_DIGEST = `sha256:${'1'.repeat(64)}`;
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

export function registerQueueBackupPersonalRestoreRecoverySpecs(): void {
  describe('QueueBackup personal restore V2 recovery provider', () => {
    let service: QueueBackupService;

    beforeEach(async () => {
      await deleteDatabase();
      TestBed.configureTestingModule({
        providers: [
          QueueBackupService,
          { provide: LoggerService, useValue: { category: vi.fn(() => logger) } },
        ],
      });
      service = TestBed.inject(QueueBackupService);
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      TestBed.resetTestingModule();
      await deleteDatabase();
    });

    it('appends an immutable abandonment receipt while an absent owner remains absent', async () => {
      const identity = await makeIdentity('absent');
      const state = await service.readPersonalRestoreIdentityState(identity, OWNER);
      expect(state.status).toBe('absent-for-identity');
      if (state.status !== 'absent-for-identity') return;

      const result = await service.abandonPersonalRestoreBeforePrepare({
        kind: 'abandon-before-prepare', identity, absenceProof: state.absenceProof,
      }, OWNER);

      expect(result.status).toBe('abandoned-before-prepare');
      expect(await readRaw(identity.recordId)).toBeUndefined();
      expect(await readRaw(identity.receiptId)).toMatchObject({
        id: identity.receiptId,
        receiptId: identity.receiptId,
        identityDigest: identity.identityDigest,
        outcome: 'abandoned-before-prepare',
        abandonReason: 'marker-committed-before-queue-prepare',
        recordPresent: false,
        resultDigest: await digestQueueBackupPersonalRestoreActions('result', []),
      });
    });

    it('isolates proofs per service instance and consumes an aborted fresh append proof', async () => {
      const first = await makeIdentity('proof-first');
      const otherService = TestBed.runInInjectionContext(() => new QueueBackupService());
      const firstState = await service.readPersonalRestoreIdentityState(first, OWNER);
      if (firstState.status !== 'absent-for-identity') throw new Error('missing first proof');
      const emptyBytes = JSON.stringify(await readAllRaw());

      await expect(otherService.abandonPersonalRestoreBeforePrepare({
        kind: 'abandon-before-prepare', identity: first, absenceProof: firstState.absenceProof,
      }, OWNER)).resolves.toEqual({ status: 'rejected', reason: 'state-changed' });
      expect(JSON.stringify(await readAllRaw())).toBe(emptyBytes);
      await expect(service.abandonPersonalRestoreBeforePrepare({
        kind: 'abandon-before-prepare', identity: first, absenceProof: firstState.absenceProof,
      }, OWNER)).resolves.toMatchObject({ status: 'abandoned-before-prepare' });

      const second = await makeIdentity('proof-second');
      const secondState = await service.readPersonalRestoreIdentityState(second, OWNER);
      if (secondState.status !== 'absent-for-identity') throw new Error('missing second proof');
      const beforeAbort = JSON.stringify(await readAllRaw());
      const add = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementationOnce(() => {
        throw new DOMException('forced receipt abort', 'AbortError');
      });
      await expect(service.abandonPersonalRestoreBeforePrepare({
        kind: 'abandon-before-prepare', identity: second, absenceProof: secondState.absenceProof,
      }, OWNER)).resolves.toEqual({ status: 'aborted', reason: 'transaction-aborted' });
      add.mockRestore();
      await expect(service.abandonPersonalRestoreBeforePrepare({
        kind: 'abandon-before-prepare', identity: second, absenceProof: secondState.absenceProof,
      }, OWNER)).resolves.toEqual({ status: 'rejected', reason: 'state-changed' });
      expect(JSON.stringify(await readAllRaw())).toBe(beforeAbort);
      expect(await readRaw(first.receiptId)).toMatchObject({ outcome: 'abandoned-before-prepare' });
      expect(await readRaw(second.receiptId)).toBeUndefined();
      const renewedState = await service.readPersonalRestoreIdentityState(second, OWNER);
      if (renewedState.status !== 'absent-for-identity') throw new Error('missing renewed proof');
      expect(renewedState.absenceProof).not.toBe(secondState.absenceProof);
      await expect(service.abandonPersonalRestoreBeforePrepare({
        kind: 'abandon-before-prepare', identity: second, absenceProof: renewedState.absenceProof,
      }, OWNER)).resolves.toMatchObject({ status: 'abandoned-before-prepare' });
      expect(await readRaw(second.receiptId)).toMatchObject({ outcome: 'abandoned-before-prepare' });
    });
    it('replays a verified receipt after service recreation without a runtime proof', async () => {
      const identity = await makeIdentity('restart');
      const state = await service.readPersonalRestoreIdentityState(identity, OWNER);
      if (state.status !== 'absent-for-identity') throw new Error('missing absence proof');
      await service.abandonPersonalRestoreBeforePrepare({
        kind: 'abandon-before-prepare', identity, absenceProof: state.absenceProof,
      }, OWNER);
      const bytes = JSON.stringify(await readRaw(identity.receiptId));
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [
          QueueBackupService,
          { provide: LoggerService, useValue: { category: vi.fn(() => logger) } },
        ],
      });

      const recreated = TestBed.inject(QueueBackupService);
      const result = await recreated.abandonPersonalRestoreBeforePrepare({
        kind: 'abandon-before-prepare', identity, absenceProof: Object.freeze({}),
      }, OWNER);

      expect(result.status).toBe('already-abandoned-before-prepare');
      expect(JSON.stringify(await readRaw(identity.receiptId))).toBe(bytes);
    });

    it('fails auth loss before opening IndexedDB and performs zero writes', async () => {
      const identity = await makeIdentity('auth-loss');
      const open = vi.spyOn(indexedDB, 'open');

      const result = await service.abandonPersonalRestoreBeforePrepare({
        kind: 'abandon-before-prepare', identity, absenceProof: Object.freeze({}),
      }, null);

      expect(result).toEqual({ status: 'aborted', reason: 'auth-unavailable' });
      expect(open).not.toHaveBeenCalled();
    });

    it('rejects a successor change after proof but preserves current bytes at linearization', async () => {
      const identity = await makeIdentity('successor-drift');
      const c1 = makeAction('successor-1');
      const c2 = makeAction('successor-2');
      await service.backupQueue([c1], OWNER);
      const state = await service.readPersonalRestoreIdentityState(identity, OWNER);
      if (state.status !== 'absent-for-identity') throw new Error('missing absence proof');
      await service.backupQueue([c1, c2], OWNER);
      const before = JSON.stringify(await readRaw(identity.recordId));

      const stale = await service.abandonPersonalRestoreBeforePrepare({
        kind: 'abandon-before-prepare', identity, absenceProof: state.absenceProof,
      }, OWNER);

      expect(stale).toEqual({ status: 'rejected', reason: 'state-changed' });
      expect(JSON.stringify(await readRaw(identity.recordId))).toBe(before);
      expect(await readRaw(identity.receiptId)).toBeUndefined();

      const current = await service.readPersonalRestoreIdentityState(identity, OWNER);
      if (current.status !== 'absent-for-identity') throw new Error('missing current proof');
      await expect(service.abandonPersonalRestoreBeforePrepare({
        kind: 'abandon-before-prepare', identity, absenceProof: current.absenceProof,
      }, OWNER)).resolves.toMatchObject({ status: 'abandoned-before-prepare' });
      expect(JSON.stringify(await readRaw(identity.recordId))).toBe(before);
    });

    it('finalizes V2 A+B+C to B+C and replays the immutable terminal receipt', async () => {
      const identity = await makeIdentity('finalize');
      const incumbent = makeAction('finalize-a');
      const restored = makeAction('finalize-b');
      const successor = makeAction('finalize-c');
      await service.backupQueue([incumbent], OWNER);

      await expect(service.applyPersonalBackupRestoreTransitionV2({
        kind: 'prepare', identity, expectedActions: [incumbent], restoredActions: [restored],
      }, OWNER)).resolves.toEqual({ status: 'prepared' });
      await expect(service.updateQueueStrictly(OWNER, queue => [...queue, successor]))
        .resolves.toMatchObject({ status: 'committed' });
      const finalized = await service.applyPersonalBackupRestoreTransitionV2({
        kind: 'finalize', identity,
      }, OWNER);
      const receiptBytes = JSON.stringify(await readRaw(identity.receiptId));
      const replay = await service.applyPersonalBackupRestoreTransitionV2({
        kind: 'finalize', identity,
      }, OWNER);

      expect(finalized.status).toBe('finalized');
      expect(replay.status).toBe('already-finalized');
      await expect(service.restoreQueue(OWNER)).resolves.toEqual([restored, successor]);
      expect(JSON.stringify(await readRaw(identity.receiptId))).toBe(receiptBytes);
    });

    it('rolls back only restored B and invalidates a later prepared identity', async () => {
      const incumbent = makeAction('rollback-a');
      const restored = makeAction('rollback-b');
      const successor = makeAction('rollback-c');
      const rollbackIdentity = await makeIdentity('rollback-v2');
      await service.backupQueue([incumbent], OWNER);
      await service.applyPersonalBackupRestoreTransitionV2({
        kind: 'prepare', identity: rollbackIdentity,
        expectedActions: [incumbent], restoredActions: [restored],
      }, OWNER);
      await service.updateQueueStrictly(OWNER, queue => [...queue, successor]);

      await expect(service.applyPersonalBackupRestoreTransitionV2({
        kind: 'rollback', identity: rollbackIdentity,
      }, OWNER)).resolves.toMatchObject({ status: 'rolled-back' });
      await expect(service.restoreQueue(OWNER)).resolves.toEqual([incumbent, successor]);

      const invalidateIdentity = await makeIdentity('invalidate-v2');
      await service.applyPersonalBackupRestoreTransitionV2({
        kind: 'prepare', identity: invalidateIdentity,
        expectedActions: [incumbent, successor], restoredActions: [makeAction('invalidate-b')],
      }, OWNER);
      await expect(service.applyPersonalBackupRestoreTransitionV2({
        kind: 'invalidate', identity: invalidateIdentity, invalidationReason: 'explicit-full-wipe',
      }, OWNER)).resolves.toMatchObject({ status: 'invalidated' });
      await expect(service.restoreQueue(OWNER)).resolves.toEqual([]);
    });

    it('classifies an unrelated active transition and preserves it', async () => {
      const activeIdentity = await makeIdentity('active');
      const otherIdentity = await makeIdentity('other');
      const action = makeAction('active-a');
      await service.backupQueue([action], OWNER);
      await expect(service.applyPersonalBackupRestoreTransitionV2({
        kind: 'prepare', identity: activeIdentity, expectedActions: [action], restoredActions: [],
      }, OWNER)).resolves.toMatchObject({ status: 'prepared' });
      const before = JSON.stringify(await readRaw(activeIdentity.recordId));

      const result = await service.abandonPersonalRestoreBeforePrepare({
        kind: 'abandon-before-prepare', identity: otherIdentity, absenceProof: Object.freeze({}),
      }, OWNER);

      expect(result).toEqual({ status: 'rejected', reason: 'active-transition' });
      expect(JSON.stringify(await readRaw(activeIdentity.recordId))).toBe(before);
    });

    it('keeps queue and catalog byte-identical when the append transaction aborts', async () => {
      const identity = await makeIdentity('abort');
      const action = makeAction('abort-c');
      await service.backupQueue([action], OWNER);
      const state = await service.readPersonalRestoreIdentityState(identity, OWNER);
      if (state.status !== 'absent-for-identity') throw new Error('missing absence proof');
      const before = JSON.stringify(await readAllRaw());
      vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementationOnce(() => {
        throw new DOMException('forced receipt abort', 'AbortError');
      });

      const result = await service.abandonPersonalRestoreBeforePrepare({
        kind: 'abandon-before-prepare', identity, absenceProof: state.absenceProof,
      }, OWNER);

      expect(result).toEqual({ status: 'aborted', reason: 'transaction-aborted' });
      expect(JSON.stringify(await readAllRaw())).toBe(before);
    });

    it('returns ambiguous after commit when independent readback fails, then replays', async () => {
      const identity = await makeIdentity('ambiguous');
      const state = await service.readPersonalRestoreIdentityState(identity, OWNER);
      if (state.status !== 'absent-for-identity') throw new Error('missing absence proof');
      failNextReadonlyAfterReadwrite();

      const first = await service.abandonPersonalRestoreBeforePrepare({
        kind: 'abandon-before-prepare', identity, absenceProof: state.absenceProof,
      }, OWNER);
      vi.restoreAllMocks();
      const retry = await service.abandonPersonalRestoreBeforePrepare({
        kind: 'abandon-before-prepare', identity, absenceProof: Object.freeze({}),
      }, OWNER);

      expect(first).toEqual({ status: 'ambiguous' });
      expect(retry.status).toBe('already-abandoned-before-prepare');
    });

    it('returns malformed evidence for active plus terminal contradiction', async () => {
      const identity = await makeIdentity('contradiction');
      const absence = await service.readPersonalRestoreIdentityState(identity, OWNER);
      if (absence.status !== 'absent-for-identity') throw new Error('missing absence proof');
      await service.abandonPersonalRestoreBeforePrepare({
        kind: 'abandon-before-prepare', identity, absenceProof: absence.absenceProof,
      }, OWNER);
      await putRaw({
        id: identity.recordId, ownerUserId: OWNER, actions: [],
        savedAt: '2026-08-02T00:00:00.000Z',
        personalRestoreTransition: {
          kind: 'queue-backup-personal-restore-transition', schemaVersion: 2,
          state: 'prepared', id: identity.identityDigest,
          preparedReceipt: {}, preimage: [], restoredActions: [],
        },
      });

      await expect(service.abandonPersonalRestoreBeforePrepare({
        kind: 'abandon-before-prepare', identity, absenceProof: Object.freeze({}),
      }, OWNER)).resolves.toEqual({ status: 'rejected', reason: 'malformed-evidence' });
    });

    it('classifies an impossible prepared timestamp as malformed evidence', async () => {
      const identity = await makeIdentity('bad-time');
      const action = makeAction('bad-time-a');
      await service.backupQueue([action], OWNER);
      await service.applyPersonalBackupRestoreTransitionV2({
        kind: 'prepare', identity, expectedActions: [action], restoredActions: [],
      }, OWNER);
      const record = await readRaw(identity.recordId) as Record<string, unknown>;
      const transition = record['personalRestoreTransition'] as Record<string, unknown>;
      await putRaw({ ...record, personalRestoreTransition: {
        ...transition, preparedReceipt: {
          ...(transition['preparedReceipt'] as object), preparedAt: '2026-99-99T99:99:99.999Z',
        },
      } });

      await expect(service.readPersonalRestoreIdentityState(identity, OWNER))
        .resolves.toEqual({ status: 'unknown', reason: 'malformed-evidence' });
    });

    it('replays an existing receipt even when the catalog is at retention capacity', async () => {
      const identities = [];
      for (let index = 0; index < 64; index += 1) {
        const identity = await makeIdentity(`retention-${index}`);
        identities.push(identity);
        const state = await service.readPersonalRestoreIdentityState(identity, OWNER);
        if (state.status !== 'absent-for-identity') throw new Error('missing absence proof');
        await service.abandonPersonalRestoreBeforePrepare({
          kind: 'abandon-before-prepare', identity, absenceProof: state.absenceProof,
        }, OWNER);
      }
      const first = identities[0];
      const fresh = await makeIdentity('retention-overflow');
      const freshState = await service.readPersonalRestoreIdentityState(fresh, OWNER);
      if (freshState.status !== 'absent-for-identity') throw new Error('missing fresh proof');

      await expect(service.abandonPersonalRestoreBeforePrepare({
        kind: 'abandon-before-prepare', identity: first, absenceProof: Object.freeze({}),
      }, OWNER)).resolves.toMatchObject({ status: 'already-abandoned-before-prepare' });
      await expect(service.abandonPersonalRestoreBeforePrepare({
        kind: 'abandon-before-prepare', identity: fresh, absenceProof: freshState.absenceProof,
      }, OWNER)).resolves.toEqual({ status: 'rejected', reason: 'retention-full' });
      expect(await readRaw(fresh.receiptId)).toBeUndefined();
    });
  });
}

async function makeIdentity(suffix: string) {
  return createQueueBackupPersonalRestoreIdentity({
    ownerUserId: OWNER,
    restoreRunId: `restore-${suffix}`,
    participant: 'action-queue',
    sourceDigest: SOURCE_DIGEST,
    token: `token-${suffix}`,
  });
}

function makeAction(id: string): QueuedAction {
  return {
    id, operationId: `op-${id}`, type: 'update', entityType: 'task', entityId: id,
    payload: { task: { id, title: id, content: '', stage: 1, parentId: null, order: 0,
      rank: 10000, status: 'active', x: 0, y: 0, displayId: id,
      createdDate: '2026-08-02T00:00:00.000Z' }, projectId: 'project-1' },
    timestamp: 1, retryCount: 0,
  };
}

async function readRaw(id: string): Promise<Record<string, unknown> | undefined> {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      let value: Record<string, unknown> | undefined;
      const tx = db.transaction(QUEUE_BACKUP_STORE_NAME, 'readonly');
      const request = tx.objectStore(QUEUE_BACKUP_STORE_NAME).get(id);
      request.onsuccess = () => { value = request.result; };
      tx.oncomplete = () => resolve(value);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('read aborted'));
    });
  } finally { db.close(); }
}

async function readAllRaw(): Promise<Record<string, unknown>[]> {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      let value: Record<string, unknown>[] = [];
      const tx = db.transaction(QUEUE_BACKUP_STORE_NAME, 'readonly');
      const request = tx.objectStore(QUEUE_BACKUP_STORE_NAME).getAll();
      request.onsuccess = () => { value = request.result; };
      tx.oncomplete = () => resolve(value);
      tx.onerror = () => reject(tx.error);
    });
  } finally { db.close(); }
}

async function putRaw(value: Record<string, unknown>): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(QUEUE_BACKUP_STORE_NAME, 'readwrite');
      tx.objectStore(QUEUE_BACKUP_STORE_NAME).put(value);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally { db.close(); }
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(QUEUE_BACKUP_DB_NAME, QUEUE_BACKUP_DB_VERSION);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function deleteDatabase(): Promise<void> {
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(QUEUE_BACKUP_DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
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
