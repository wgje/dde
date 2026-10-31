import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LoggerService } from './logger.service';
import type { QueuedAction } from './action-queue.types';
import {
  createQueueBackupPersonalRestoreIdentity,
  digestQueueBackupPersonalRestoreActions,
} from './queue-backup-personal-restore-transition.helpers';
import {
  QUEUE_BACKUP_DB_NAME,
  QUEUE_BACKUP_DB_VERSION,
  QUEUE_BACKUP_STORE_NAME,
  QueueBackupService,
} from './queue-backup.service';

const SOURCE_DIGEST = `sha256:${'0'.repeat(64)}`;

export function registerQueueBackupPersonalRestoreTransitionSpecs(): void {
  describe('QueueBackup personal restore V2 wire contract', () => {
    it('freezes the framed identity vector and derived IDs', async () => {
      const identity = await createQueueBackupPersonalRestoreIdentity({
        ownerUserId: 'user-1',
        restoreRunId: 'restore-1',
        participant: 'action-queue',
        sourceDigest: SOURCE_DIGEST,
        token: 'token-1',
      });

      expect(identity).toEqual({
        ownerUserId: 'user-1',
        restoreRunId: 'restore-1',
        participant: 'action-queue',
        sourceDigest: SOURCE_DIGEST,
        token: 'token-1',
        recordId: 'queue-backup:user-1',
        identityDigest: 'sha256:8cb5b1970f01552b963a2c410bb7235ce480f132f4e7e441e0d8ac8411ec30e5',
        receiptId: 'queue-backup-personal-restore-receipt:v2:8cb5b1970f01552b963a2c410bb7235ce480f132f4e7e441e0d8ac8411ec30e5',
      });
      expect(Object.isFrozen(identity)).toBe(true);
    });

    it('freezes all four domain-separated action digest vectors', async () => {
      const actions = [makeFrozenProjectDeleteAction()];

      await expect(digestQueueBackupPersonalRestoreActions('preimage', actions))
        .resolves.toBe('sha256:3b1741cf4a073c5142a9a0a508ad72d8552e33a40d9627b29468d0051921343c');
      await expect(digestQueueBackupPersonalRestoreActions('restored', actions))
        .resolves.toBe('sha256:8d5615611179993028ddf9e2c4e5f4c63eeba89f13bc97cb31eb81e4ef6dc18f');
      await expect(digestQueueBackupPersonalRestoreActions('prepared', actions))
        .resolves.toBe('sha256:a6fcecee69231e91ee867578de87938c3e937290a627bd412dbb905c14d4cba9');
      await expect(digestQueueBackupPersonalRestoreActions('result', actions))
        .resolves.toBe('sha256:aa9cb2f3a80db6692f6fd9e661d164076580b9dede96c71e44f181ccf4a6c211');
    });

    it.each([
      ['empty owner', { ownerUserId: '' }],
      ['non-NFC run', { restoreRunId: 'e\u0301' }],
      ['NUL token', { token: 'bad\u0000token' }],
      ['unpaired surrogate', { token: '\ud800' }],
      ['uppercase digest', { sourceDigest: `sha256:${'A'.repeat(64)}` }],
      ['wrong participant', { participant: 'retry-queue' }],
      ['oversized field', { token: 'x'.repeat(513) }],
    ])('rejects %s before producing an identity', async (_label, override) => {
      await expect(createQueueBackupPersonalRestoreIdentity({
        ownerUserId: 'user-1',
        restoreRunId: 'restore-1',
        participant: 'action-queue',
        sourceDigest: SOURCE_DIGEST,
        token: 'token-1',
        ...override,
      } as never)).rejects.toThrow();
    });
  });

  describe('QueueBackup personal restore V2 active authority', () => {
    let service: QueueBackupService;

    beforeEach(async () => {
      await deleteDatabase();
      TestBed.configureTestingModule({
        providers: [
          QueueBackupService,
          { provide: LoggerService, useValue: { category: vi.fn(() => testLogger) } },
        ],
      });
      service = TestBed.inject(QueueBackupService);
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      TestBed.resetTestingModule();
      await deleteDatabase();
    });

    it.each(activeQueueDriftCases)(
      'rejects %s protected membership drift at inspection, repeat prepare, and strict update',
      async (_label, drift) => {
        const identity = await makeIdentity(`drift-${_label}`);
        const incumbent = makeAction(`a-${_label}`);
        const restored = makeAction(`b-${_label}`);
        await service.backupQueue([incumbent], 'user-1');
        await service.applyPersonalBackupRestoreTransitionV2({
          kind: 'prepare', identity, expectedActions: [incumbent], restoredActions: [restored],
        }, 'user-1');
        const record = await readRaw(identity.recordId) as Record<string, unknown>;
        await putRaw({ ...record, actions: drift(incumbent, restored) });
        const before = JSON.stringify(await readRaw(identity.recordId));

        await expect(service.readPersonalRestoreIdentityState(identity, 'user-1'))
          .resolves.toEqual({ status: 'unknown', reason: 'malformed-evidence' });
        await expect(service.applyPersonalBackupRestoreTransitionV2({
          kind: 'prepare', identity, expectedActions: [incumbent], restoredActions: [restored],
        }, 'user-1')).resolves.toEqual({ status: 'rejected', reason: 'malformed-evidence' });
        await expect(service.updateQueueStrictly('user-1', queue => [...queue, makeAction('blocked-c')]))
          .resolves.toEqual({ status: 'protected-restore' });
        expect(JSON.stringify(await readRaw(identity.recordId))).toBe(before);
      },
    );

    it('allows unrelated successor C to be added and removed around exact active A+B', async () => {
      const identity = await makeIdentity('successor-c');
      const incumbent = makeAction('successor-a');
      const restored = makeAction('successor-b');
      const successor = makeAction('successor-c');
      await service.backupQueue([incumbent], 'user-1');
      await service.applyPersonalBackupRestoreTransitionV2({
        kind: 'prepare', identity, expectedActions: [incumbent], restoredActions: [restored],
      }, 'user-1');

      await expect(service.updateQueueStrictly('user-1', queue => [...queue, successor]))
        .resolves.toMatchObject({ status: 'committed' });
      await expect(service.updateQueueStrictly('user-1', queue => queue.filter(action => action.id !== successor.id)))
        .resolves.toMatchObject({ status: 'committed' });
      await expect(service.readPersonalRestoreIdentityState(identity, 'user-1'))
        .resolves.toMatchObject({ status: 'active' });
    });

    it('preserves exact queue bytes when structurally malformed V2 evidence blocks strict update', async () => {
      const identity = await makeIdentity('malformed-current-actions');
      const incumbent = makeAction('malformed-a');
      const restored = makeAction('malformed-b');
      await service.backupQueue([incumbent], 'user-1');
      await service.applyPersonalBackupRestoreTransitionV2({
        kind: 'prepare', identity, expectedActions: [incumbent], restoredActions: [restored],
      }, 'user-1');
      const record = await readRaw(identity.recordId) as Record<string, unknown>;
      const transition = record['personalRestoreTransition'] as Record<string, unknown>;
      await putRaw({ ...record, personalRestoreTransition: {
        ...transition, preparedReceipt: {
          ...(transition['preparedReceipt'] as object), preparedAt: '2026-99-99T99:99:99.999Z',
        },
      } });
      const before = JSON.stringify(await readRaw(identity.recordId));

      await expect(service.updateQueueStrictly('user-1', queue => [...queue, makeAction('malformed-c')]))
        .resolves.toEqual({ status: 'protected-restore' });
      expect(JSON.stringify(await readRaw(identity.recordId))).toBe(before);
    });

    it.each(activeReadwriteRaceCases)(
      'fails closed when readonly V2 authority races with %s before readwrite',
      async (_label, race) => {
        const identity = await makeIdentity(`race-${_label}`);
        const incumbent = makeAction(`race-a-${_label}`);
        const restored = makeAction(`race-b-${_label}`);
        await service.backupQueue([incumbent], 'user-1');
        await service.applyPersonalBackupRestoreTransitionV2({
          kind: 'prepare', identity, expectedActions: [incumbent], restoredActions: [restored],
        }, 'user-1');
        const pause = pauseNextV2Validation();
        const update = service.updateQueueStrictly('user-1', () => [incumbent, restored]);
        await pause.entered;
        const record = await readRaw(identity.recordId) as Record<string, unknown>;
        await putRaw(race(record));
        const racedBytes = JSON.stringify(await readRaw(identity.recordId));
        pause.release();

        await expect(update).resolves.toEqual({ status: 'protected-restore' });
        pause.restore();
        expect(JSON.stringify(await readRaw(identity.recordId))).toBe(racedBytes);
      },
    );

    it('closes the opened database when asynchronous V2 preflight validation throws', async () => {
      const identity = await makeIdentity('preflight-close');
      const incumbent = makeAction('preflight-a');
      await service.backupQueue([incumbent], 'user-1');
      await service.applyPersonalBackupRestoreTransitionV2({
        kind: 'prepare', identity, expectedActions: [incumbent], restoredActions: [],
      }, 'user-1');
      const open = vi.spyOn(indexedDB, 'open');
      const close = vi.spyOn(IDBDatabase.prototype, 'close');
      const digest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
      vi.spyOn(globalThis.crypto.subtle, 'digest')
        .mockImplementationOnce((...args) => digest(...args))
        .mockRejectedValueOnce(new Error('forced digest failure'));

      const result = await service.updateQueueStrictly('user-1', queue => queue);
      const closeCount = close.mock.calls.length;
      const opened = open.mock.results.at(-1)?.value.result;
      if (closeCount === 0) opened?.close();

      expect(result).toEqual({ status: 'storage-failed' });
      expect(closeCount).toBe(1);
    });
  });
}

const testLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const activeQueueDriftCases: Array<[
  string,
  (incumbent: QueuedAction, restored: QueuedAction) => QueuedAction[],
]> = [
  ['missing-a', (_incumbent, restored) => [restored]],
  ['missing-b', (incumbent) => [incumbent]],
  ['duplicate-b', (incumbent, restored) => [incumbent, restored, structuredClone(restored)]],
  ['replaced-b', (incumbent, restored) => [incumbent, replaceProtectedAction(restored)]],
];
const activeReadwriteRaceCases: Array<[
  string,
  (record: Record<string, unknown>) => Record<string, unknown>,
]> = [
  ['transition removal', (record) => {
    const next = structuredClone(record);
    delete next['personalRestoreTransition'];
    return next;
  }],
  ['valid legacy replacement', (record) => ({ ...record, personalRestoreTransition: {
    schemaVersion: 1, state: 'prepared', ownerUserId: 'user-1', token: 'legacy-token',
    preimage: [], preimageDigest: SOURCE_DIGEST, restoredActions: [], restoredDigest: SOURCE_DIGEST,
    preparedActionsDigest: SOURCE_DIGEST, preparedAt: '2026-08-02T00:00:00.000Z',
  } })],
  ['protected A removal', (record) => ({ ...record, actions: recordActions(record).slice(1) })],
  ['protected B removal', (record) => ({ ...record, actions: recordActions(record).slice(0, 1) })],
  ['protected B duplicate', (record) => ({
    ...record, actions: [...recordActions(record), structuredClone(recordActions(record)[1])],
  })],
  ['protected B replacement', (record) => ({
    ...record, actions: [recordActions(record)[0], replaceProtectedAction(recordActions(record)[1])],
  })],
];

async function makeIdentity(suffix: string) {
  return createQueueBackupPersonalRestoreIdentity({
    ownerUserId: 'user-1', restoreRunId: `restore-${suffix}`, participant: 'action-queue',
    sourceDigest: SOURCE_DIGEST, token: `token-${suffix}`,
  });
}

function makeAction(id: string): QueuedAction {
  const action = structuredClone(makeFrozenProjectDeleteAction());
  return { ...action, id, operationId: `op-${id}`, entityId: `project-${id}` };
}

function replaceProtectedAction(action: QueuedAction): QueuedAction {
  return { ...action, payload: { ...action.payload, projectId: 'replacement-project' } } as QueuedAction;
}

function recordActions(record: Record<string, unknown>): QueuedAction[] {
  return record['actions'] as QueuedAction[];
}

function pauseNextV2Validation() {
  const digest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
  let calls = 0;
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const spy = vi.spyOn(globalThis.crypto.subtle, 'digest').mockImplementation(async (algorithm, data) => {
    calls += 1;
    if (calls === 2) { enter(); await gate; }
    return digest(algorithm, data);
  });
  return { entered, release, restore: () => spy.mockRestore() };
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

function makeFrozenProjectDeleteAction(): QueuedAction {
  return {
    id: 'a1',
    operationId: 'o1',
    type: 'delete',
    entityType: 'project',
    entityId: 'p1',
    payload: {
      projectId: 'p1',
      userId: 'user-1',
      sourceUserId: 'user-1',
      baseUpdatedAt: null,
    },
    timestamp: 1,
    localCommittedAt: 1,
    retryCount: 0,
    syncState: 'pending_sync',
    priority: 'normal',
  };
}
