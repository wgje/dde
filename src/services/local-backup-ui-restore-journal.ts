import {
  DATA_SAFETY_RESTORE_MARKER_HEARTBEAT_MS,
  hasSameDataSafetyRestoreMarkerIdentity,
  isDataSafetyRestoreMarkerActive,
} from './data-safety-indexeddb-restore-marker-lease';
import {
  createDataSafetyRestoreMarkerJournal,
  type DataSafetyRestoreMarkerKind,
  type DataSafetyRestoreMarkerJournal,
} from './data-safety-restore-marker-journal';
import {
  validateLocalBackupUiRestoreMarker,
  type LocalBackupUiRestoreMarker,
} from './local-backup-ui-restore-types';

export const LOCAL_BACKUP_UI_RESTORE_MARKER_KIND = 'local-backup-ui-restore' as const;
export const LOCAL_BACKUP_UI_RESTORE_SENTINEL_SCHEMA_VERSION = 2 as const;

const LOCAL_BACKUP_UI_RESTORE_SENTINEL_STORAGE_KEY_PREFIX =
  'nanoflow.local-backup-ui-restore-marker';
const LOCAL_BACKUP_UI_RESTORE_SENTINEL_KEYS = [
  'schemaVersion',
  'storage',
  'markerKind',
  'ownerUserId',
  'runId',
  'createdAt',
  'leaseExpiresAt',
] as const;

export interface LocalBackupUiRestoreJournal {
  create(marker: LocalBackupUiRestoreMarker): Promise<void>;
  read(): Promise<LocalBackupUiRestoreMarker | null>;
  replace(
    expectedMarker: LocalBackupUiRestoreMarker,
    nextMarker: LocalBackupUiRestoreMarker,
  ): Promise<LocalBackupUiRestoreMarker | null>;
  claimExpired(marker: LocalBackupUiRestoreMarker): Promise<LocalBackupUiRestoreMarker | null>;
  renew(marker: LocalBackupUiRestoreMarker): Promise<LocalBackupUiRestoreMarker | null>;
  verifyOwnership(marker: LocalBackupUiRestoreMarker): Promise<boolean>;
  clear(marker: LocalBackupUiRestoreMarker): Promise<boolean>;
}

export interface LocalBackupUiRestoreMarkerHeartbeat {
  marker(): LocalBackupUiRestoreMarker;
  hasOwnership(): boolean;
  verifyOwnership(): Promise<boolean>;
  stop(): Promise<void>;
}

export function getLocalBackupUiRestoreSentinelStorageKey(ownerUserId: string): string {
  return `${LOCAL_BACKUP_UI_RESTORE_SENTINEL_STORAGE_KEY_PREFIX}.${ownerUserId}`;
}

export function isLocalBackupUiRestoreMarkerActive(
  marker: LocalBackupUiRestoreMarker,
  now = Date.now(),
): boolean {
  return isDataSafetyRestoreMarkerActive(marker, now);
}

export function createLocalBackupUiRestoreJournal(
  ownerUserId: string,
): LocalBackupUiRestoreJournal {
  if (ownerUserId.length === 0) {
    throw new Error('local backup UI restore journal owner is required');
  }
  const durableJournal = createDurableJournal(ownerUserId);
  return {
    create: marker => createMarker(durableJournal, ownerUserId, marker),
    read: () => readMarker(durableJournal, ownerUserId),
    replace: (expectedMarker, nextMarker) => replaceMarker(
      durableJournal, ownerUserId, expectedMarker, nextMarker,
    ),
    claimExpired: marker => mutateLease(durableJournal, ownerUserId, marker, 'claim'),
    renew: marker => mutateLease(durableJournal, ownerUserId, marker, 'renew'),
    verifyOwnership: marker => verifyMarkerOwnership(durableJournal, ownerUserId, marker),
    clear: marker => clearMarker(durableJournal, ownerUserId, marker),
  };
}

async function replaceMarker(
  journal: DataSafetyRestoreMarkerJournal<LocalBackupUiRestoreMarker>,
  ownerUserId: string,
  expectedMarker: LocalBackupUiRestoreMarker,
  nextMarker: LocalBackupUiRestoreMarker,
): Promise<LocalBackupUiRestoreMarker | null> {
  assertMarker(expectedMarker, ownerUserId);
  assertMarker(nextMarker, ownerUserId);
  assertSentinelValidOrAbsent(ownerUserId);
  const previousSentinel = readSentinelRaw(ownerUserId);
  const replaced = await journal.replace(expectedMarker, nextMarker);
  if (!replaced) return null;
  try {
    writeSentinel(replaced);
    const readBack = await readMarker(journal, ownerUserId);
    if (!readBack || !markersEqual(readBack, replaced)) {
      throw new Error('local backup UI restore marker replacement read-back failed');
    }
    return readBack;
  } catch (error) {
    await rollbackMarkerReplacement(
      journal,
      ownerUserId,
      expectedMarker,
      replaced,
      previousSentinel,
      error,
    );
    throw error;
  }
}

export function startLocalBackupUiRestoreMarkerHeartbeat(
  journal: LocalBackupUiRestoreJournal,
  marker: LocalBackupUiRestoreMarker,
  intervalMs = DATA_SAFETY_RESTORE_MARKER_HEARTBEAT_MS,
): LocalBackupUiRestoreMarkerHeartbeat {
  let currentMarker = marker;
  let ownershipLost = false;
  let refreshInFlight: Promise<boolean> | null = null;
  const refresh = (): Promise<boolean> => {
    if (ownershipLost) return Promise.resolve(false);
    if (refreshInFlight) return refreshInFlight;
    const activeRefresh = (async () => {
      try {
        const renewedMarker = await journal.renew(currentMarker);
        if (!renewedMarker) {
          ownershipLost = true;
          return false;
        }
        currentMarker = renewedMarker;
        ownershipLost = !await journal.verifyOwnership(currentMarker);
      } catch {
        ownershipLost = true;
      }
      return !ownershipLost;
    })();
    refreshInFlight = activeRefresh;
    void activeRefresh.finally(() => {
      if (refreshInFlight === activeRefresh) refreshInFlight = null;
    });
    return activeRefresh;
  };
  const timer = setInterval(() => void refresh(), intervalMs);
  return {
    marker: () => ({ ...currentMarker }),
    hasOwnership: () => !ownershipLost && hasSentinelIdentity(currentMarker),
    verifyOwnership: refresh,
    stop: async () => {
      clearInterval(timer);
      await refreshInFlight;
    },
  };
}

function createDurableJournal(
  ownerUserId: string,
): DataSafetyRestoreMarkerJournal<LocalBackupUiRestoreMarker> {
  return createDataSafetyRestoreMarkerJournal<LocalBackupUiRestoreMarker>({
    // The shared kind union is frozen in Phase 2A; runtime storage supports namespaced kinds.
    markerKind: LOCAL_BACKUP_UI_RESTORE_MARKER_KIND as unknown as DataSafetyRestoreMarkerKind,
    ownerUserId,
    legacyStorageKey: getLocalBackupUiRestoreSentinelStorageKey(ownerUserId),
    normalize: value => validateLocalBackupUiRestoreMarker(value, ownerUserId) ? value : null,
  });
}

async function createMarker(
  journal: DataSafetyRestoreMarkerJournal<LocalBackupUiRestoreMarker>,
  ownerUserId: string,
  marker: LocalBackupUiRestoreMarker,
): Promise<void> {
  assertMarker(marker, ownerUserId);
  assertSentinelValidOrAbsent(ownerUserId);
  const existingMarker = await journal.read();
  if (existingMarker) throw new Error('local backup UI restore marker already exists for this owner');
  await journal.create(marker);
  try {
    writeSentinel(marker);
    const persistedMarker = await journal.read();
    if (!persistedMarker || !markersEqual(persistedMarker, marker)) {
      throw new Error('local backup UI restore marker durable read-back verification failed');
    }
    writeSentinel(persistedMarker);
  } catch (error) {
    let cleanupError: unknown;
    const removed = await journal.clear(marker).catch(error => {
      cleanupError = error;
      return false;
    });
    if (!removed) {
      throw new AggregateError(
        cleanupError === undefined ? [error] : [error, cleanupError],
        'local backup UI restore marker verification failed and the owned marker could not be removed',
      );
    }
    throw error;
  }
}

async function readMarker(
  journal: DataSafetyRestoreMarkerJournal<LocalBackupUiRestoreMarker>,
  ownerUserId: string,
): Promise<LocalBackupUiRestoreMarker | null> {
  assertSentinelValidOrAbsent(ownerUserId);
  const marker = await journal.read();
  if (!marker) return null;
  assertMarker(marker, ownerUserId);
  writeSentinel(marker);
  return marker;
}

async function mutateLease(
  journal: DataSafetyRestoreMarkerJournal<LocalBackupUiRestoreMarker>,
  ownerUserId: string,
  marker: LocalBackupUiRestoreMarker,
  operation: 'claim' | 'renew',
): Promise<LocalBackupUiRestoreMarker | null> {
  assertMarker(marker, ownerUserId);
  assertSentinelValidOrAbsent(ownerUserId);
  const updatedMarker = operation === 'claim'
    ? await journal.claimExpired(marker)
    : await journal.renew(marker);
  if (!updatedMarker) return null;
  assertMarker(updatedMarker, ownerUserId);
  writeSentinel(updatedMarker);
  return updatedMarker;
}

async function verifyMarkerOwnership(
  journal: DataSafetyRestoreMarkerJournal<LocalBackupUiRestoreMarker>,
  ownerUserId: string,
  marker: LocalBackupUiRestoreMarker,
): Promise<boolean> {
  assertMarker(marker, ownerUserId);
  assertSentinelValidOrAbsent(ownerUserId);
  return await journal.owns(marker) && hasSentinelIdentity(marker);
}

async function clearMarker(
  journal: DataSafetyRestoreMarkerJournal<LocalBackupUiRestoreMarker>,
  ownerUserId: string,
  marker: LocalBackupUiRestoreMarker,
): Promise<boolean> {
  assertMarker(marker, ownerUserId);
  assertSentinelValidOrAbsent(ownerUserId);
  return await journal.clear(marker);
}

async function rollbackMarkerReplacement(
  journal: DataSafetyRestoreMarkerJournal<LocalBackupUiRestoreMarker>,
  ownerUserId: string,
  expectedMarker: LocalBackupUiRestoreMarker,
  replacedMarker: LocalBackupUiRestoreMarker,
  previousSentinel: string | null,
  cause: unknown,
): Promise<void> {
  const restored = await journal.replace(replacedMarker, expectedMarker).catch(error => {
    throw createReplaceRollbackError(cause, error);
  });
  if (!restored || !markersEqual(restored, expectedMarker)) {
    throw createReplaceRollbackError(cause);
  }
  try {
    restoreSentinelRaw(ownerUserId, previousSentinel);
  } catch (error) {
    throw createReplaceRollbackError(cause, error);
  }
  const readBack = await readMarker(journal, ownerUserId).catch(error => {
    throw createReplaceRollbackError(cause, error);
  });
  if (!readBack || !markersEqual(readBack, expectedMarker)) {
    throw createReplaceRollbackError(cause);
  }
}

function createReplaceRollbackError(cause: unknown, rollbackError?: unknown): AggregateError {
  return new AggregateError(
    rollbackError === undefined ? [cause] : [cause, rollbackError],
    'local backup UI restore marker replacement rollback failed',
  );
}

function assertMarker(marker: unknown, ownerUserId: string): asserts marker is LocalBackupUiRestoreMarker {
  if (!validateLocalBackupUiRestoreMarker(marker, ownerUserId)) {
    throw new Error('local backup UI restore marker failed schema validation');
  }
}

function assertSentinelValidOrAbsent(ownerUserId: string): void {
  const raw = readSentinelRaw(ownerUserId);
  if (raw === null) return;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error('local backup UI restore sentinel is not valid JSON', { cause: error });
  }
  if (!validateSentinel(value, ownerUserId)) {
    throw new Error('local backup UI restore sentinel failed schema validation');
  }
}

function validateSentinel(value: unknown, ownerUserId: string): boolean {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length === LOCAL_BACKUP_UI_RESTORE_SENTINEL_KEYS.length
    && LOCAL_BACKUP_UI_RESTORE_SENTINEL_KEYS.every(key => Object.hasOwn(value, key))
    && value['schemaVersion'] === LOCAL_BACKUP_UI_RESTORE_SENTINEL_SCHEMA_VERSION
    && value['storage'] === 'indexeddb-journal'
    && value['markerKind'] === LOCAL_BACKUP_UI_RESTORE_MARKER_KIND
    && value['ownerUserId'] === ownerUserId
    && typeof value['runId'] === 'string'
    && value['runId'].length > 0
    && isIsoTimestamp(value['createdAt'])
    && isIsoTimestamp(value['leaseExpiresAt']);
}

function readSentinelRaw(ownerUserId: string): string | null {
  if (typeof localStorage === 'undefined') return null;
  return localStorage.getItem(getLocalBackupUiRestoreSentinelStorageKey(ownerUserId));
}

function restoreSentinelRaw(ownerUserId: string, raw: string | null): void {
  if (typeof localStorage === 'undefined') return;
  const key = getLocalBackupUiRestoreSentinelStorageKey(ownerUserId);
  if (raw === null) {
    localStorage.removeItem(key);
    return;
  }
  localStorage.setItem(key, raw);
}

function writeSentinel(marker: LocalBackupUiRestoreMarker): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(
    getLocalBackupUiRestoreSentinelStorageKey(marker.ownerUserId),
    JSON.stringify({
      schemaVersion: LOCAL_BACKUP_UI_RESTORE_SENTINEL_SCHEMA_VERSION,
      storage: 'indexeddb-journal',
      markerKind: LOCAL_BACKUP_UI_RESTORE_MARKER_KIND,
      ownerUserId: marker.ownerUserId,
      runId: marker.runId,
      createdAt: marker.createdAt,
      leaseExpiresAt: marker.leaseExpiresAt,
    }),
  );
}

function hasSentinelIdentity(marker: LocalBackupUiRestoreMarker): boolean {
  const raw = readSentinelRaw(marker.ownerUserId);
  if (typeof localStorage === 'undefined') return true;
  if (raw === null) return false;
  try {
    const value = JSON.parse(raw) as unknown;
    return validateSentinel(value, marker.ownerUserId)
      && isRecord(value)
      && value['runId'] === marker.runId;
  } catch {
    return false;
  }
}

function markersEqual(first: LocalBackupUiRestoreMarker, second: LocalBackupUiRestoreMarker): boolean {
  return hasSameDataSafetyRestoreMarkerIdentity(first, second)
    && stableStringify(first) === stableStringify(second);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isRecord(value)) {
    const entries = Object.keys(value).sort().map(key => (
      `${JSON.stringify(key)}:${stableStringify(value[key])}`
    ));
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value));
}
