import { beforeEach, describe, expect, it } from 'vitest';
import { UserPreferencesBaselineStore } from './user-preferences-baseline.store';

describe('UserPreferencesBaselineStore', () => {
  let store: UserPreferencesBaselineStore;

  beforeEach(async () => {
    store = new UserPreferencesBaselineStore();
    await store.clearForTests();
    localStorage.clear();
  });

  it('persists a confirmed row updated_at across store instances', async () => {
    await store.save('user-1', '2026-07-14T01:00:00.000Z');

    const restored = new UserPreferencesBaselineStore();

    await expect(restored.read('user-1')).resolves.toBe('2026-07-14T01:00:00.000Z');
  });

  it('does not regress the confirmed baseline when an older snapshot arrives later', async () => {
    await store.save('user-1', '2026-07-14T02:00:00.000Z');
    await store.save('user-1', '2026-07-14T01:00:00.000Z');

    await expect(store.read('user-1')).resolves.toBe('2026-07-14T02:00:00.000Z');
  });
});
