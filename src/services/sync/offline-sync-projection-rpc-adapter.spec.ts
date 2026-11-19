import { describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { IndexedDbOfflineCommandStore } from './offline-command-store';
import { pullAndApplyOfflineSyncProjections } from './offline-sync-projection-rpc-adapter';

describe('offline-sync-projection-rpc-adapter', () => {
  it('normalizes server row names and applies only valid projection records', async () => {
    const store = new IndexedDbOfflineCommandStore({ indexedDb: new IDBFactory(), dbName: 'projection-rpc-adapter' });
    const result = await pullAndApplyOfflineSyncProjections({
      ownerUserId: 'owner-1',
      store,
      transport: {
        fetchProjections: async () => [
          {
            entity_type: 'task', entity_id: 'task-1', fields: { content: 'remote' },
            field_versions: { content: { physicalMs: 10 } }, updated_at: '2026-11-14T00:00:10.000Z', version: 4,
          },
          { entity_type: 'task', entity_id: 'task-2', fields: null, field_versions: {}, updated_at: 'bad' },
        ],
      },
    });
    expect(result).toEqual({ applied: 1, skipped: 0 });
    await expect(store.getProjection('owner-1', 'owner-1:projection:task:task-1'))
      .resolves.toMatchObject({ value: { fields: { content: 'remote' } }, version: 4 });
  });

  it('fails closed on a non-array transport response', async () => {
    const store = new IndexedDbOfflineCommandStore({ indexedDb: new IDBFactory(), dbName: 'projection-rpc-invalid' });
    await expect(pullAndApplyOfflineSyncProjections({
      ownerUserId: 'owner-1', store,
      transport: { fetchProjections: async () => ({ data: [] }) },
    })).resolves.toEqual({ applied: 0, skipped: 0 });
  });
});
