import { createClientUuid } from './offline-sync-command-envelope';

export const OFFLINE_SYNC_IDENTITY_SCHEMA_VERSION = 1 as const;
export const OFFLINE_SYNC_IDENTITY_STORAGE_KEY = 'nanoflow.offline-sync.identity.v1';

export interface OfflineSyncDeviceIdentity {
  readonly schemaVersion: typeof OFFLINE_SYNC_IDENTITY_SCHEMA_VERSION;
  readonly installationId: string;
  readonly deviceId: string;
}

export interface OfflineSyncIdentityStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function loadOrCreateOfflineSyncDeviceIdentity(
  storage: OfflineSyncIdentityStorage,
  key = OFFLINE_SYNC_IDENTITY_STORAGE_KEY,
): OfflineSyncDeviceIdentity {
  const existing = readIdentity(storage.getItem(key));
  if (existing) return existing;
  const identity: OfflineSyncDeviceIdentity = {
    schemaVersion: OFFLINE_SYNC_IDENTITY_SCHEMA_VERSION,
    installationId: createClientUuid(),
    deviceId: createClientUuid(),
  };
  storage.setItem(key, JSON.stringify(identity));
  return identity;
}

function readIdentity(raw: string | null): OfflineSyncDeviceIdentity | null {
  if (!raw) return null;
  let value: Partial<OfflineSyncDeviceIdentity> | null = null;
  try {
    value = JSON.parse(raw) as Partial<OfflineSyncDeviceIdentity>;
  } catch {
    value = null;
  }
  if (!value || value.schemaVersion !== OFFLINE_SYNC_IDENTITY_SCHEMA_VERSION
    || typeof value.installationId !== 'string'
    || value.installationId.length === 0
    || typeof value.deviceId !== 'string'
    || value.deviceId.length === 0) return null;
  return value as OfflineSyncDeviceIdentity;
}