import { describe, expect, it, vi } from 'vitest';
import { loadOrCreateOfflineSyncDeviceIdentity } from './offline-sync-device-identity';

describe('offline-sync-device-identity', () => {
  it('persists stable installation and device identities', () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) };
    vi.stubGlobal('crypto', { randomUUID: vi.fn()
      .mockReturnValueOnce('installation-1')
      .mockReturnValueOnce('device-1') });

    const first = loadOrCreateOfflineSyncDeviceIdentity(storage);
    const second = loadOrCreateOfflineSyncDeviceIdentity(storage);

    expect(first).toEqual({ schemaVersion: 1, installationId: 'installation-1', deviceId: 'device-1' });
    expect(second).toEqual(first);
  });

  it('replaces malformed persisted identity instead of reusing it', () => {
    const values = new Map([['key', '{bad-json']]);
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) };
    vi.stubGlobal('crypto', { randomUUID: vi.fn()
      .mockReturnValueOnce('installation-2')
      .mockReturnValueOnce('device-2') });

    expect(loadOrCreateOfflineSyncDeviceIdentity(storage, 'key').deviceId).toBe('device-2');
  });
});
