import { describe, expect, it, beforeEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import {
  IndexedDbOfflineCommandStore,
  LocalStorageOfflineCommandStore,
  createOfflineProjectionKey,
  type OfflineCommandStoreWrite,
} from './offline-command-store';

const write: OfflineCommandStoreWrite<{ type: string }, { name: string }> = {
  ownerUserId: 'user-1',
  projection: {
    ownerUserId: 'user-1', entityType: 'task', entityId: 'task-1', value: { name: 'offline' }, version: 1, updatedAt: '2026-11-13T00:00:00.000Z',
  },
  command: {
    ownerUserId: 'user-1', operationId: 'op-1', entityType: 'task', entityId: 'task-1', command: { type: 'updateTask' }, status: 'pending', createdAt: '2026-11-13T00:00:00.000Z', updatedAt: '2026-11-13T00:00:00.000Z',
  },
  audit: {
    ownerUserId: 'user-1', operationId: 'op-1', entityType: 'task', entityId: 'task-1', operation: 'updateTask', localTimestamp: '2026-11-13T00:00:00.000Z',
  },
};

describe('offline command stores', () => {
  let indexedDb: IDBFactory;
  beforeEach(() => { indexedDb = new IDBFactory(); });

  it('commits projection, command and audit in one transaction', async () => {
    const store = new IndexedDbOfflineCommandStore({ indexedDb, dbName: `test-${Math.random()}` });
    await store.commitLocalChange(write);
    const projection = await store.getProjection('user-1', createOfflineProjectionKey('user-1', 'task', 'task-1'));
    expect(projection?.value).toEqual({ name: 'offline' });
    await expect(store.listCommands('user-1')).resolves.toHaveLength(1);
    await expect(store.getAudit('user-1', 'op-1')).resolves.toMatchObject({ operation: 'updateTask' });
  });

  it('enforces owner fences for reads and atomic writes', async () => {
    const store = new IndexedDbOfflineCommandStore({ indexedDb, dbName: `test-${Math.random()}` });
    await store.commitLocalChange(write);

    await expect(store.getProjection('user-2', createOfflineProjectionKey('user-1', 'task', 'task-1'))).resolves.toBeNull();
    await expect(store.commitLocalChange({
      ...write,
      projection: { ...write.projection, ownerUserId: 'user-2' },
    })).rejects.toThrow('owner mismatch');
  });

  it('exports only owner-scoped records and quarantines unknown data', async () => {
    const store = new IndexedDbOfflineCommandStore({ indexedDb, dbName: `test-${Math.random()}`, idFactory: () => 'q-1' });
    await store.commitLocalChange(write);
    await store.quarantine({ ownerUserId: 'user-1', reason: 'unknown-schema', raw: { x: 1 }, quarantinedAt: '2026-11-13T00:00:00.000Z' });
    const exported = await store.exportOwner('user-1');
    expect(exported.schemaVersion).toBe(1);
    expect(exported.projections).toHaveLength(1);
    expect(exported.quarantine[0]?.reason).toBe('unknown-schema');
  });

  it('restores an owner export atomically without touching another owner', async () => {
    const indexedDb = new IDBFactory();
    const source = new IndexedDbOfflineCommandStore({ indexedDb, dbName: 'restore-test' });
    await source.commitLocalChange(write);
    const exported = await source.exportOwner<{ type: string }, { name: string }>('user-1');

    const target = new IndexedDbOfflineCommandStore({ indexedDb, dbName: 'restore-target-test' });
    await target.restoreOwner(exported);
    const restored = await target.exportOwner<{ type: string }, { name: string }>('user-1');

    expect(restored.projections).toHaveLength(1);
    expect(restored.commands[0]?.operationId).toBe('op-1');
    await expect(target.restoreOwner({ ...exported, ownerUserId: 'user-2' })).rejects.toThrow('owner mismatch');
  });

  it('commits, lists, exports, and restores full conflict evidence with the owner data', async () => {
    const indexedDb = new IDBFactory();
    const source = new IndexedDbOfflineCommandStore({ indexedDb, dbName: 'conflict-evidence-store' });
    const evidence = {
      reason: 'older-field-write',
      losingOperationId: 'op-loser',
      winningOperationId: 'op-winner',
      losingCommand: { command: 'task.update', intent: { source: 'device-a' }, normalizedResultPatch: { content: 'lost' } },
      winningCommand: { command: 'task.update', intent: { source: 'device-b' }, normalizedResultPatch: { content: 'won' } },
      losingValue: 'lost',
      winningValue: 'won',
    };
    await source.commitLocalChange({
      ...write,
      conflictEvidence: [{
        ownerUserId: 'user-1', conflictId: 'conflict-1', entityType: 'task', entityId: 'task-1',
        losingOperationId: 'op-loser', winningOperationId: 'op-winner', evidence,
        capturedAt: '2026-11-14T00:00:00.000Z',
      }],
    });

    const records = await source.listConflictEvidence('user-1');
    expect(records).toHaveLength(1);
    expect(records[0]?.evidence).toEqual(evidence);
    const exported = await source.exportOwner('user-1');
    const target = new IndexedDbOfflineCommandStore({ indexedDb, dbName: 'conflict-evidence-restore' });
    await target.restoreOwner(exported);
    await expect(target.listConflictEvidence('user-1')).resolves.toEqual(exported.conflictEvidence);
    await expect(source.commitLocalChange({
      ...write,
      conflictEvidence: [{
        ownerUserId: 'user-2', conflictId: 'conflict-2', entityType: 'task', entityId: 'task-1',
        losingOperationId: 'op-loser', winningOperationId: 'op-winner', evidence,
        capturedAt: '2026-11-14T00:00:00.000Z',
      }],
    })).rejects.toThrow('owner mismatch');
  });

  it('upgrades a v1 database by adding the conflict evidence store without deleting old records', async () => {
    const indexedDb = new IDBFactory();
    const dbName = 'conflict-evidence-v1-upgrade';
    const oldDb = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDb.open(dbName, 1);
      request.onupgradeneeded = () => {
        for (const name of ['projections', 'commands', 'audits', 'quarantine']) {
          request.result.createObjectStore(name, { keyPath: 'key' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const oldTx = oldDb.transaction('projections', 'readwrite');
    oldTx.objectStore('projections').put({
      key: createOfflineProjectionKey('user-1', 'task', 'task-1'), ownerUserId: 'user-1',
      entityType: 'task', entityId: 'task-1', value: { name: 'legacy' }, version: 1,
      updatedAt: '2026-11-13T00:00:00.000Z', schemaVersion: 1,
    });
    await new Promise<void>((resolve, reject) => {
      oldTx.oncomplete = () => resolve();
      oldTx.onerror = () => reject(oldTx.error);
    });
    oldDb.close();

    const upgraded = new IndexedDbOfflineCommandStore({ indexedDb, dbName });
    await upgraded.init();
    await expect(upgraded.getProjection('user-1', createOfflineProjectionKey('user-1', 'task', 'task-1')))
      .resolves.toMatchObject({ value: { name: 'legacy' } });
    await expect(upgraded.listConflictEvidence('user-1')).resolves.toEqual([]);
  });

  it('upgrades an existing v1 IndexedDB database without losing legacy rows', async () => {
    const indexedDb = new IDBFactory();
    const dbName = 'offline-command-store-v1-upgrade';
    const legacyDb = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDb.open(dbName, 1);
      request.onupgradeneeded = () => {
        for (const name of ['projections', 'commands', 'audits', 'quarantine']) {
          request.result.createObjectStore(name, { keyPath: 'key' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const legacyTransaction = legacyDb.transaction('projections', 'readwrite');
    legacyTransaction.objectStore('projections').put({
      key: createOfflineProjectionKey('user-1', 'task', 'task-1'),
      ownerUserId: 'user-1', entityType: 'task', entityId: 'task-1', value: { name: 'legacy' },
      version: 1, updatedAt: '2026-11-13T00:00:00.000Z', schemaVersion: 1,
    });
    await new Promise<void>((resolve, reject) => {
      legacyTransaction.oncomplete = () => resolve();
      legacyTransaction.onerror = () => reject(legacyTransaction.error);
    });
    legacyDb.close();

    const upgraded = new IndexedDbOfflineCommandStore({ indexedDb, dbName });
    await upgraded.init();
    await expect(upgraded.getProjection('user-1', createOfflineProjectionKey('user-1', 'task', 'task-1')))
      .resolves.toMatchObject({ value: { name: 'legacy' } });
    await expect(upgraded.listConflictEvidence('user-1')).resolves.toEqual([]);
  });

  it('preserves ownerless quarantine diagnostics in every owner export without exposing business records', async () => {
    const indexedDb = new IDBFactory();
    const store = new IndexedDbOfflineCommandStore({ indexedDb, dbName: 'ownerless-quarantine-test' });
    await store.commitLocalChange(write);
    await store.quarantine({ ownerUserId: null, reason: 'unknown-command', raw: { command: 'future.v2' }, quarantinedAt: '2026-11-14T00:00:00.000Z' });

    const userExport = await store.exportOwner('user-1');
    const otherExport = await store.exportOwner('user-2');
    expect(userExport.projections).toHaveLength(1);
    expect(userExport.commands).toHaveLength(1);
    expect(userExport.quarantine).toEqual([expect.objectContaining({ ownerUserId: null, reason: 'unknown-command' })]);
    expect(otherExport.projections).toHaveLength(0);
    expect(otherExport.commands).toHaveLength(0);
    expect(otherExport.quarantine).toEqual([expect.objectContaining({ ownerUserId: null, reason: 'unknown-command' })]);

    const restored = new IndexedDbOfflineCommandStore({ indexedDb, dbName: 'ownerless-quarantine-restore-test' });
    await restored.restoreOwner(userExport);
    await expect(restored.exportOwner('user-1')).resolves.toMatchObject({ projections: [{ ownerUserId: 'user-1' }], commands: [{ ownerUserId: 'user-1' }], quarantine: [expect.objectContaining({ ownerUserId: null })] });
  });

  it('writes an owner-scoped remote projection without creating a local command', async () => {
    const indexedDb = new IDBFactory();
    const store = new IndexedDbOfflineCommandStore({ indexedDb, dbName: 'remote-projection-write' });
    await store.putProjection({
      key: 'user-1:projection:task:task-1', ownerUserId: 'user-1', entityType: 'task', entityId: 'task-1',
      value: { content: 'remote' }, version: 3, updatedAt: '2026-11-14T00:00:00.000Z',
    });
    await expect(store.getProjection('user-1', 'user-1:projection:task:task-1')).resolves.toMatchObject({ value: { content: 'remote' }, version: 3 });
    await expect(store.listCommands('user-1')).resolves.toEqual([]);
    await expect(store.putProjection({
      key: 'user-2:projection:task:task-1', ownerUserId: 'user-1', entityType: 'task', entityId: 'task-1',
      value: {}, version: 1, updatedAt: '2026-11-14T00:00:00.000Z',
    })).rejects.toThrow('owner mismatch');
  });

  it('rejects LocalStorage owner mismatch before writing any business record', async () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: () => undefined, clear: () => undefined, key: () => null, length: 0 } as unknown as Storage;
    const store = new LocalStorageOfflineCommandStore({ storage });
    await store.commitLocalChange(write);
    const before = values.get('nanoflow-offline-command-store:local-storage') ?? '';
    await expect(store.commitLocalChange({ ...write, projection: { ...write.projection, ownerUserId: 'user-2' } })).rejects.toThrow('owner mismatch');
    expect(values.get('nanoflow-offline-command-store:local-storage')).toBe(before);
    await expect(store.listCommands('user-1')).resolves.toHaveLength(1);
  });

  it('accepts duplicate idempotent writes and rejects conflicting operation collisions', async () => {
    const store = new IndexedDbOfflineCommandStore({ indexedDb, dbName: 'idempotent-' + Math.random() });
    await store.commitLocalChange(write);
    await expect(store.commitLocalChange(write)).resolves.toBeUndefined();
    await expect(store.commitLocalChange({ ...write, command: { ...write.command, command: { type: 'different' } } })).rejects.toThrow('operationId collision');
  });
  it('rejects concurrent operation collisions across connections without overwriting committed evidence', async () => {
    const dbName = 'concurrent-command-collision';
    const first = new IndexedDbOfflineCommandStore({ indexedDb, dbName });
    const second = new IndexedDbOfflineCommandStore({ indexedDb, dbName });
    await Promise.all([first.init(), second.init()]);
    const conflictingWrite: OfflineCommandStoreWrite<{ type: string }, { name: string }> = {
      ...write,
      projection: { ...write.projection, value: { name: 'overwritten' }, version: 2 },
      command: { ...write.command, command: { type: 'different' } },
      audit: { ...write.audit, operation: 'different', localTimestamp: '2026-11-14T00:00:00.000Z' },
      conflictEvidence: [{
        ownerUserId: 'user-1', conflictId: 'rejected-conflict', entityType: 'task', entityId: 'task-1',
        losingOperationId: 'op-1', winningOperationId: 'op-other', evidence: { rejected: true },
        capturedAt: '2026-11-14T00:00:00.000Z',
      }],
    };

    const outcomes = await Promise.allSettled([
      first.commitLocalChange(write),
      second.commitLocalChange(conflictingWrite),
    ]);

    expect(outcomes[0]).toEqual({ status: 'fulfilled', value: undefined });
    expect(outcomes[1]).toEqual({ status: 'rejected', reason: expect.objectContaining({ message: 'Offline command operationId collision' }) });
    const exported = await second.exportOwner('user-1');
    expect(exported.projections).toEqual([expect.objectContaining({ value: { name: 'offline' }, version: 1 })]);
    expect(exported.commands).toEqual([expect.objectContaining({ command: write.command.command })]);
    expect(exported.audits).toEqual([expect.objectContaining({ operation: 'updateTask', localTimestamp: write.audit.localTimestamp })]);
    expect(exported.conflictEvidence).toEqual([]);
  });

  it('rolls back every record if a later write fails after the identity check', async () => {
    const store = new IndexedDbOfflineCommandStore({ indexedDb, dbName: 'atomic-command-write-failure' });
    await store.commitLocalChange(write);
    const before = await store.exportOwner('user-1');

    await expect(store.commitLocalChange({
      ...write,
      projection: { ...write.projection, value: { name: 'must roll back' }, version: 2 },
      command: { ...write.command, operationId: 'op-2', command: { type: 'updateTask', uncloneable: () => undefined } },
      audit: { ...write.audit, operationId: 'op-2' },
    })).rejects.toThrow();

    await expect(store.exportOwner('user-1')).resolves.toEqual(before);
  });

  it('accepts concurrent identical commands across connections as idempotent writes', async () => {
    const dbName = 'concurrent-idempotent-command';
    const first = new IndexedDbOfflineCommandStore({ indexedDb, dbName });
    const second = new IndexedDbOfflineCommandStore({ indexedDb, dbName });
    await Promise.all([first.init(), second.init()]);

    await expect(Promise.all([
      first.commitLocalChange(write),
      second.commitLocalChange(write),
    ])).resolves.toEqual([undefined, undefined]);

    const exported = await first.exportOwner('user-1');
    expect(exported.projections).toHaveLength(1);
    expect(exported.commands).toHaveLength(1);
    expect(exported.audits).toHaveLength(1);
  });

  it('supports localStorage fallback with a versioned envelope', async () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: () => undefined, clear: () => undefined, key: () => null, length: 0 } as unknown as Storage;
    const store = new LocalStorageOfflineCommandStore({ storage });
    await store.commitLocalChange(write);
    await expect(store.listCommands('user-1')).resolves.toHaveLength(1);
    expect(JSON.parse(values.values().next().value ?? '{}').schemaVersion).toBe(1);
  });
});
