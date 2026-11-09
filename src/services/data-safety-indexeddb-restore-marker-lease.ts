import { createSyncOperationId } from '../utils/sync-operation-id';

const DATA_SAFETY_RESTORE_MARKER_LEASE_MS = 5 * 60 * 1000;
const DATA_SAFETY_RESTORE_MARKER_STORAGE_KEY_PREFIX = 'nanoflow.data-safety-restore-marker';
export const DATA_SAFETY_RESTORE_MARKER_HEARTBEAT_MS = Math.floor(
  DATA_SAFETY_RESTORE_MARKER_LEASE_MS / 3,
);

export interface DataSafetyRestoreMarkerLeaseIdentity {
  ownerUserId: string;
  runId: string | null;
  createdAt: string;
  leaseExpiresAt: string | null;
}

export function getDataSafetyRestoreMarkerStorageKey(ownerUserId: string): string {
  return `${DATA_SAFETY_RESTORE_MARKER_STORAGE_KEY_PREFIX}.${ownerUserId}`;
}

export function createDataSafetyRestoreMarkerLease(
  ownerUserId: string,
  now = Date.now(),
): DataSafetyRestoreMarkerLeaseIdentity {
  return {
    ownerUserId,
    runId: createSyncOperationId(),
    createdAt: new Date(now).toISOString(),
    leaseExpiresAt: new Date(now + DATA_SAFETY_RESTORE_MARKER_LEASE_MS).toISOString(),
  };
}

export function claimDataSafetyRestoreMarkerLease<T extends DataSafetyRestoreMarkerLeaseIdentity>(
  marker: T,
  now = Date.now(),
): T {
  return {
    ...marker,
    runId: createSyncOperationId(),
    leaseExpiresAt: new Date(now + DATA_SAFETY_RESTORE_MARKER_LEASE_MS).toISOString(),
  };
}

export function renewDataSafetyRestoreMarkerLeaseIdentity<
  T extends DataSafetyRestoreMarkerLeaseIdentity,
>(marker: T, now = Date.now()): T {
  return {
    ...marker,
    leaseExpiresAt: new Date(now + DATA_SAFETY_RESTORE_MARKER_LEASE_MS).toISOString(),
  };
}

export function isDataSafetyRestoreMarkerActive(
  marker: DataSafetyRestoreMarkerLeaseIdentity,
  now = Date.now(),
): boolean {
  return marker.runId !== null
    && marker.leaseExpiresAt !== null
    && Date.parse(marker.leaseExpiresAt) > now;
}

export function hasSameDataSafetyRestoreMarkerIdentity(
  first: DataSafetyRestoreMarkerLeaseIdentity,
  second: DataSafetyRestoreMarkerLeaseIdentity,
): boolean {
  if (first.ownerUserId !== second.ownerUserId) return false;
  if (first.runId !== null || second.runId !== null) {
    return first.runId !== null && first.runId === second.runId;
  }
  return first.createdAt === second.createdAt;
}
