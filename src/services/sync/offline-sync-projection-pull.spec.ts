import { describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { IndexedDbOfflineCommandStore } from './offline-command-store';
import { applyOfflineSyncProjectionPull } from './offline-sync-projection-pull';

describe('offline-sync-projection-pull', () => {
  it('applies owner-scoped projections in deterministic order without creating commands', async () => {
    const store = new IndexedDbOfflineCommandStore({ indexedDb: new IDBFactory(), dbName: 'projection-pull' });
    const result = await applyOfflineSyncProjectionPull({
      ownerUserId: 'owner-1',
      store,
      rows: [
        {
          ownerUserId: 'owner-1', entityType: 'task', entityId: 'task-2',
          fields: { content: 'b' }, fieldVersions: { content: { physicalMs: 2 } },
          updatedAt: '2026-11-14T00:00:02.000Z', version: 2,
        },
        {
          ownerUserId: 'owner-1', entityType: 'task', entityId: 'task-1',
          fields: { content: 'a' }, fieldVersions: { content: { physicalMs: 1 } },
          updatedAt: '2026-11-14T00:00:01.000Z', version: 1,
        },
      ],
    });
    expect(result).toEqual({ applied: 2, skipped: 0 });
    expect(await store.listCommands('owner-1')).toEqual([]);
    expect(await store.listProjections('owner-1')).toHaveLength(2);
  });

  it('rejects foreign or malformed rows and preserves newer local projections', async () => {
    const store = new IndexedDbOfflineCommandStore({ indexedDb: new IDBFactory(), dbName: 'projection-pull-fences' });
    await applyOfflineSyncProjectionPull({
      ownerUserId: 'owner-1', store, rows: [{
        ownerUserId: 'owner-1', entityType: 'task', entityId: 'task-1', fields: { content: 'new' },
        fieldVersions: {}, updatedAt: '2026-11-14T00:00:02.000Z', version: 2,
      }],
    });
    const result = await applyOfflineSyncProjectionPull({
      ownerUserId: 'owner-1', store, rows: [
        {
          ownerUserId: 'owner-2', entityType: 'task', entityId: 'task-2', fields: {}, fieldVersions: {},
          updatedAt: '2026-11-14T00:00:03.000Z', version: 3,
        },
        {
          ownerUserId: 'owner-1', entityType: 'task', entityId: 'task-1', fields: { content: 'old' },
          fieldVersions: {}, updatedAt: '2026-11-14T00:00:01.000Z', version: 1,
        },
        {
          ownerUserId: 'owner-1', entityType: 'task', entityId: 'task-3', fields: {}, fieldVersions: {},
          updatedAt: 'not-a-date', version: 1,
        },
      ],
    });
    expect(result).toEqual({ applied: 0, skipped: 3 });
    await expect(store.getProjection('owner-1', 'owner-1:projection:task:task-1'))
      .resolves.toMatchObject({ value: { fields: { content: 'new' } }, version: 2 });
  });
});
