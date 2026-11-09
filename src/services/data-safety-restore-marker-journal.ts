import {
  claimDataSafetyRestoreMarkerLease,
  hasSameDataSafetyRestoreMarkerIdentity,
  isDataSafetyRestoreMarkerActive,
  renewDataSafetyRestoreMarkerLeaseIdentity,
  type DataSafetyRestoreMarkerLeaseIdentity,
} from './data-safety-indexeddb-restore-marker-lease';

const RESTORE_MARKER_JOURNAL_DB_NAME = 'nanoflow-data-safety-restore-journal';
const RESTORE_MARKER_JOURNAL_DB_VERSION = 1;
const RESTORE_MARKER_JOURNAL_STORE_NAME = 'restore_markers';
const RESTORE_MARKER_JOURNAL_OPEN_TIMEOUT_MS = 5000;
const RESTORE_MARKER_SENTINEL_SCHEMA_VERSION = 2;

export type DataSafetyRestoreMarkerKind = 'full-restore' | 'metadata-restore';

export interface DataSafetyRestoreMarkerJournalOptions<
  T extends DataSafetyRestoreMarkerLeaseIdentity,
> {
  markerKind: DataSafetyRestoreMarkerKind;
  ownerUserId: string;
  legacyStorageKey: string;
  normalize: (value: unknown) => T | null;
}

export interface DataSafetyRestoreMarkerJournal<
  T extends DataSafetyRestoreMarkerLeaseIdentity,
> {
  create(marker: T): Promise<void>;
  read(): Promise<T | null>;
  replace(expectedMarker: T, nextMarker: T): Promise<T | null>;
  claimExpired(marker: T): Promise<T | null>;
  renew(marker: T): Promise<T | null>;
  hasSentinelOwnership(marker: T): boolean;
  owns(marker: T): Promise<boolean>;
  clear(marker: T): Promise<boolean>;
}

interface RestoreMarkerJournalRecord {
  key: string;
  markerKind: DataSafetyRestoreMarkerKind;
  ownerUserId: string;
  marker: unknown;
}

interface JournalTransactionContext<T> {
  fail(error: unknown): void;
  setResult(result: T): void;
  store: IDBObjectStore;
}

type LegacyMarkerRead<T> =
  | { kind: 'none' }
  | { kind: 'sentinel'; value: Record<string, unknown> }
  | { kind: 'marker'; marker: T };

type OwnedMarkerMutation<T, TResult> =
  | { kind: 'no-match' }
  | { kind: 'put'; marker: T; result: TResult }
  | { kind: 'delete'; result: TResult };

interface OwnedMarkerMutationInput<T extends DataSafetyRestoreMarkerLeaseIdentity, TResult> {
  key: string;
  options: DataSafetyRestoreMarkerJournalOptions<T>;
  expectedMarker: T;
  noMatchResult: TResult;
  mutate: (currentMarker: T) => OwnedMarkerMutation<T, TResult>;
}

export function createDataSafetyRestoreMarkerJournal<
  T extends DataSafetyRestoreMarkerLeaseIdentity,
>(
  options: DataSafetyRestoreMarkerJournalOptions<T>,
): DataSafetyRestoreMarkerJournal<T> {
  const key = `${options.markerKind}:${options.ownerUserId}`;
  return {
    create: marker => createJournalMarker(key, options, marker),
    read: () => readJournalMarker(key, options),
    replace: (expectedMarker, nextMarker) => replaceJournalMarker(
      key, options, expectedMarker, nextMarker,
    ),
    claimExpired: marker => claimExpiredJournalMarker(key, options, marker),
    renew: marker => renewJournalMarker(key, options, marker),
    hasSentinelOwnership: marker => hasJournalSentinelOwnership(options, marker),
    owns: marker => ownsJournalMarker(key, options, marker),
    clear: marker => clearJournalMarker(key, options, marker),
  };
}

async function replaceJournalMarker<T extends DataSafetyRestoreMarkerLeaseIdentity>(
  key: string,
  options: DataSafetyRestoreMarkerJournalOptions<T>,
  expectedMarker: T,
  nextMarker: T,
): Promise<T | null> {
  assertMarkerOwner(expectedMarker, options.ownerUserId);
  assertMarkerOwner(nextMarker, options.ownerUserId);
  if (!hasSameDataSafetyRestoreMarkerIdentity(expectedMarker, nextMarker)) {
    throw new Error('restore marker replacement identity mismatch');
  }
  const replaced = await mutateOwnedMarker<T, T | null>({
    key,
    options,
    expectedMarker,
    noMatchResult: null,
    mutate: currentMarker => markersEqual(currentMarker, expectedMarker)
      ? { kind: 'put', marker: nextMarker, result: nextMarker }
      : { kind: 'no-match' },
  });
  if (!replaced) return null;
  try {
    writeLegacySentinel(options, replaced);
    return replaced;
  } catch (error) {
    const restored = await mutateOwnedMarker<T, boolean>({
      key,
      options,
      expectedMarker: nextMarker,
      noMatchResult: false,
      mutate: currentMarker => markersEqual(currentMarker, nextMarker)
        ? { kind: 'put', marker: expectedMarker, result: true }
        : { kind: 'no-match' },
    }).catch(() => false);
    if (restored) {
      try {
        writeLegacySentinel(options, expectedMarker);
      } catch {
        // The durable marker remains authoritative; callers fail closed.
      }
    }
    throw error;
  }
}

async function createJournalMarker<T extends DataSafetyRestoreMarkerLeaseIdentity>(
  key: string,
  options: DataSafetyRestoreMarkerJournalOptions<T>,
  marker: T,
): Promise<void> {
  assertMarkerOwner(marker, options.ownerUserId);
  await runJournalTransaction<void>('readwrite', ({ store, fail, setResult }) => {
    const request = store.get(key);
    request.onerror = () => fail(request.error ?? new Error('restore marker journal read failed'));
    request.onsuccess = () => {
      if (request.result !== undefined) {
        fail(new Error('data-safety restore marker already exists for this owner'));
        return;
      }
      const putRequest = store.add(buildJournalRecord(key, options, marker));
      putRequest.onerror = () => fail(
        putRequest.error ?? new Error('restore marker journal write failed'),
      );
      putRequest.onsuccess = () => setResult(undefined);
    };
  });
  try {
    writeLegacySentinel(options, marker);
  } catch (error) {
    const removed = await deleteOwnedMarkerRecord(key, options, marker);
    if (!removed) {
      throw new AggregateError(
        [error],
        'restore marker sentinel write failed and the committed marker could not be removed',
      );
    }
    throw error;
  }
}

async function readJournalMarker<T extends DataSafetyRestoreMarkerLeaseIdentity>(
  key: string,
  options: DataSafetyRestoreMarkerJournalOptions<T>,
): Promise<T | null> {
  const indexedDbMarker = await readJournalRecord(key, options, 'restore marker journal read failed');
  if (indexedDbMarker) {
    if (!reconcileLegacySentinel(options, indexedDbMarker)) {
      throw new Error('restore marker compatibility sentinel conflicts with the durable marker');
    }
    return indexedDbMarker;
  }
  const legacy = readLegacyMarker(options);
  if (legacy.kind === 'none') return null;
  if (legacy.kind === 'sentinel') {
    throw new Error('restore marker journal sentinel exists without a durable marker');
  }
  const migratedMarker = await importLegacyMarker(key, options, legacy.marker);
  writeLegacySentinel(options, migratedMarker);
  return migratedMarker;
}

async function claimExpiredJournalMarker<T extends DataSafetyRestoreMarkerLeaseIdentity>(
  key: string,
  options: DataSafetyRestoreMarkerJournalOptions<T>,
  marker: T,
): Promise<T | null> {
  assertMarkerOwner(marker, options.ownerUserId);
  const claimedMarker = await mutateOwnedMarker<T, T | null>({
    key, options, expectedMarker: marker, noMatchResult: null,
    mutate: currentMarker => {
      if (!hasCompatibleLegacyMarker(options, currentMarker)
        || isDataSafetyRestoreMarkerActive(currentMarker)) return { kind: 'no-match' };
      const claimed = claimDataSafetyRestoreMarkerLease(currentMarker);
      return { kind: 'put', marker: claimed, result: claimed };
    },
  });
  if (!claimedMarker) return null;
  if (!hasCompatibleLegacyMarker(options, marker)) return null;
  writeLegacySentinel(options, claimedMarker);
  return claimedMarker;
}

async function renewJournalMarker<T extends DataSafetyRestoreMarkerLeaseIdentity>(
  key: string,
  options: DataSafetyRestoreMarkerJournalOptions<T>,
  marker: T,
): Promise<T | null> {
  assertMarkerOwner(marker, options.ownerUserId);
  const renewedMarker = await mutateOwnedMarker<T, T | null>({
    key, options, expectedMarker: marker, noMatchResult: null,
    mutate: currentMarker => {
      if (!hasCompatibleLegacyMarker(options, currentMarker)) return { kind: 'no-match' };
      const renewed = renewDataSafetyRestoreMarkerLeaseIdentity(currentMarker);
      return { kind: 'put', marker: renewed, result: renewed };
    },
  });
  if (!renewedMarker) return null;
  if (!hasCompatibleLegacyMarker(options, marker)) return null;
  writeLegacySentinel(options, renewedMarker);
  return renewedMarker;
}

function hasJournalSentinelOwnership<T extends DataSafetyRestoreMarkerLeaseIdentity>(
  options: DataSafetyRestoreMarkerJournalOptions<T>,
  marker: T,
): boolean {
  assertMarkerOwner(marker, options.ownerUserId);
  return hasCompatibleLegacyMarker(options, marker);
}

async function ownsJournalMarker<T extends DataSafetyRestoreMarkerLeaseIdentity>(
  key: string,
  options: DataSafetyRestoreMarkerJournalOptions<T>,
  marker: T,
): Promise<boolean> {
  assertMarkerOwner(marker, options.ownerUserId);
  const currentMarker = await readJournalRecord(
    key,
    options,
    'restore marker journal ownership read failed',
  );
  return currentMarker !== null
    && hasSameDataSafetyRestoreMarkerIdentity(currentMarker, marker)
    && reconcileLegacySentinel(options, currentMarker);
}

async function clearJournalMarker<T extends DataSafetyRestoreMarkerLeaseIdentity>(
  key: string,
  options: DataSafetyRestoreMarkerJournalOptions<T>,
  marker: T,
): Promise<boolean> {
  assertMarkerOwner(marker, options.ownerUserId);
  const cleared = await mutateOwnedMarker<T, boolean>({
    key, options, expectedMarker: marker, noMatchResult: false,
    mutate: currentMarker => hasCompatibleLegacyMarker(options, currentMarker)
      ? { kind: 'delete', result: true }
      : { kind: 'no-match' },
  });
  if (cleared) removeLegacySentinel(options, marker);
  return cleared;
}

export async function deleteDataSafetyRestoreMarkerJournalDatabaseForTests(): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(RESTORE_MARKER_JOURNAL_DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('restore marker journal delete failed'));
    request.onblocked = () => reject(new Error('restore marker journal delete blocked'));
  });
}

async function readJournalRecord<T extends DataSafetyRestoreMarkerLeaseIdentity>(
  key: string,
  options: DataSafetyRestoreMarkerJournalOptions<T>,
  errorMessage: string,
): Promise<T | null> {
  return await runJournalTransaction<T | null>('readonly', ({ store, fail, setResult }) => {
    const request = store.get(key);
    request.onerror = () => fail(request.error ?? new Error(errorMessage));
    request.onsuccess = () => {
      if (request.result === undefined) {
        setResult(null);
        return;
      }
      try {
        setResult(normalizeJournalRecord(request.result, key, options));
      } catch (error) {
        fail(error);
      }
    };
  });
}

function assertMarkerOwner(
  marker: DataSafetyRestoreMarkerLeaseIdentity,
  ownerUserId: string,
): void {
  if (marker.ownerUserId !== ownerUserId) {
    throw new Error('restore marker owner does not match journal owner');
  }
}

function markersEqual<T extends DataSafetyRestoreMarkerLeaseIdentity>(left: T, right: T): boolean {
  return hasSameDataSafetyRestoreMarkerIdentity(left, right)
    && stableStringify(left) === stableStringify(right);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => (
      `${JSON.stringify(key)}:${stableStringify(record[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function normalizeJournalRecord<T extends DataSafetyRestoreMarkerLeaseIdentity>(
  value: unknown,
  expectedKey: string,
  options: DataSafetyRestoreMarkerJournalOptions<T>,
): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('restore marker journal record failed schema validation');
  }
  const record = value as Partial<RestoreMarkerJournalRecord>;
  if (
    record.key !== expectedKey
    || record.markerKind !== options.markerKind
    || record.ownerUserId !== options.ownerUserId
  ) {
    throw new Error('restore marker journal record identity mismatch');
  }
  const marker = options.normalize(record.marker);
  if (!marker) {
    throw new Error('restore marker journal payload failed schema validation');
  }
  assertMarkerOwner(marker, options.ownerUserId);
  return marker;
}

function buildJournalRecord<T extends DataSafetyRestoreMarkerLeaseIdentity>(
  key: string,
  options: DataSafetyRestoreMarkerJournalOptions<T>,
  marker: T,
): RestoreMarkerJournalRecord {
  return {
    key,
    markerKind: options.markerKind,
    ownerUserId: options.ownerUserId,
    marker,
  };
}

function readLegacyMarker<T extends DataSafetyRestoreMarkerLeaseIdentity>(
  options: DataSafetyRestoreMarkerJournalOptions<T>,
): LegacyMarkerRead<T> {
  if (typeof localStorage === 'undefined') return { kind: 'none' };
  const raw = localStorage.getItem(options.legacyStorageKey);
  if (!raw) return { kind: 'none' };

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error('legacy restore marker is not valid JSON', { cause: error });
  }
  if (
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value as Record<string, unknown>)['storage'] === 'indexeddb-journal'
  ) {
    return { kind: 'sentinel', value: value as Record<string, unknown> };
  }
  const marker = options.normalize(value);
  if (!marker) {
    throw new Error('legacy restore marker failed schema validation');
  }
  assertMarkerOwner(marker, options.ownerUserId);
  return { kind: 'marker', marker };
}

function reconcileLegacySentinel<T extends DataSafetyRestoreMarkerLeaseIdentity>(
  options: DataSafetyRestoreMarkerJournalOptions<T>,
  marker: T,
): boolean {
  if (typeof localStorage === 'undefined') return true;
  let legacy: LegacyMarkerRead<T>;
  try {
    legacy = readLegacyMarker(options);
  } catch {
    return false;
  }
  if (legacy.kind === 'none') {
    try {
      writeLegacySentinel(options, marker);
      return true;
    } catch {
      return false;
    }
  }
  if (!isCompatibleLegacyMarker(legacy, options, marker)) return false;
  if (legacy.kind === 'marker') {
    try {
      writeLegacySentinel(options, marker);
    } catch {
      return false;
    }
  }
  return true;
}

function hasCompatibleLegacyMarker<T extends DataSafetyRestoreMarkerLeaseIdentity>(
  options: DataSafetyRestoreMarkerJournalOptions<T>,
  marker: T,
): boolean {
  if (typeof localStorage === 'undefined') return true;
  try {
    const legacy = readLegacyMarker(options);
    return legacy.kind !== 'none' && isCompatibleLegacyMarker(legacy, options, marker);
  } catch {
    return false;
  }
}

function isCompatibleLegacyMarker<T extends DataSafetyRestoreMarkerLeaseIdentity>(
  legacy: Exclude<LegacyMarkerRead<T>, { kind: 'none' }>,
  options: DataSafetyRestoreMarkerJournalOptions<T>,
  marker: T,
): boolean {
  if (legacy.kind === 'marker') {
    return hasSameDataSafetyRestoreMarkerIdentity(legacy.marker, marker);
  }
  return legacy.value['schemaVersion'] === RESTORE_MARKER_SENTINEL_SCHEMA_VERSION
    && legacy.value['markerKind'] === options.markerKind
    && legacy.value['ownerUserId'] === options.ownerUserId
    && legacy.value['runId'] === marker.runId;
}

async function importLegacyMarker<T extends DataSafetyRestoreMarkerLeaseIdentity>(
  key: string,
  options: DataSafetyRestoreMarkerJournalOptions<T>,
  legacyMarker: T,
): Promise<T> {
  return await runJournalTransaction<T>('readwrite', ({ store, fail, setResult }) => {
    const getRequest = store.get(key);
    getRequest.onerror = () => fail(
      getRequest.error ?? new Error('restore marker legacy import read failed'),
    );
    getRequest.onsuccess = () => {
      if (getRequest.result !== undefined) {
        try {
          setResult(normalizeJournalRecord(getRequest.result, key, options));
        } catch (error) {
          fail(error);
        }
        return;
      }
      const putRequest = store.add(buildJournalRecord(key, options, legacyMarker));
      putRequest.onerror = () => fail(
        putRequest.error ?? new Error('restore marker legacy import write failed'),
      );
      putRequest.onsuccess = () => setResult(legacyMarker);
    };
  });
}

async function mutateOwnedMarker<
  T extends DataSafetyRestoreMarkerLeaseIdentity,
  TResult,
>(input: OwnedMarkerMutationInput<T, TResult>): Promise<TResult> {
  return await runJournalTransaction<TResult>(
    'readwrite',
    ({ store, fail, setResult }) => {
      const getRequest = store.get(input.key);
      getRequest.onerror = () => fail(
        getRequest.error ?? new Error('restore marker journal mutation read failed'),
      );
      getRequest.onsuccess = () => {
        if (getRequest.result === undefined) {
          setResult(input.noMatchResult);
          return;
        }
        let currentMarker: T;
        try {
          currentMarker = normalizeJournalRecord(
            getRequest.result,
            input.key,
            input.options,
          );
        } catch (error) {
          fail(error);
          return;
        }
        if (!hasSameDataSafetyRestoreMarkerIdentity(currentMarker, input.expectedMarker)) {
          setResult(input.noMatchResult);
          return;
        }
        completeOwnedMarkerMutation(input, currentMarker, store, fail, setResult);
      };
    },
  );
}

function completeOwnedMarkerMutation<
  T extends DataSafetyRestoreMarkerLeaseIdentity,
  TResult,
>(
  input: OwnedMarkerMutationInput<T, TResult>,
  currentMarker: T,
  store: IDBObjectStore,
  fail: (error: unknown) => void,
  setResult: (result: TResult) => void,
): void {
  const mutation = input.mutate(currentMarker);
  if (mutation.kind === 'no-match') {
    setResult(input.noMatchResult);
    return;
  }
  const request = mutation.kind === 'delete'
    ? store.delete(input.key)
    : store.put(buildJournalRecord(input.key, input.options, mutation.marker));
  request.onerror = () => fail(
    request.error ?? new Error('restore marker journal mutation write failed'),
  );
  request.onsuccess = () => setResult(mutation.result);
}

async function deleteOwnedMarkerRecord<T extends DataSafetyRestoreMarkerLeaseIdentity>(
  key: string,
  options: DataSafetyRestoreMarkerJournalOptions<T>,
  marker: T,
): Promise<boolean> {
  const result = await mutateOwnedMarker<T, boolean>({
    key,
    options,
    expectedMarker: marker,
    noMatchResult: false,
    mutate: () => ({ kind: 'delete', result: true }),
  });
  return result;
}

function writeLegacySentinel<T extends DataSafetyRestoreMarkerLeaseIdentity>(
  options: DataSafetyRestoreMarkerJournalOptions<T>,
  marker: T,
): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(options.legacyStorageKey, JSON.stringify({
    schemaVersion: RESTORE_MARKER_SENTINEL_SCHEMA_VERSION,
    storage: 'indexeddb-journal',
    markerKind: options.markerKind,
    ownerUserId: options.ownerUserId,
    runId: marker.runId,
  }));
}

function removeLegacySentinel<T extends DataSafetyRestoreMarkerLeaseIdentity>(
  options: DataSafetyRestoreMarkerJournalOptions<T>,
  marker: T,
): void {
  if (typeof localStorage === 'undefined') return;
  const raw = localStorage.getItem(options.legacyStorageKey);
  if (!raw) return;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (
      value['storage'] === 'indexeddb-journal'
      && value['markerKind'] === options.markerKind
      && value['ownerUserId'] === options.ownerUserId
      && value['runId'] === marker.runId
    ) {
      localStorage.removeItem(options.legacyStorageKey);
    }
  } catch {
    // A malformed legacy value is not owned by this journal run.
  }
}

async function runJournalTransaction<T>(
  mode: IDBTransactionMode,
  execute: (context: JournalTransactionContext<T>) => void,
): Promise<T> {
  const db = await openJournalDatabase();
  try {
    return await executeJournalTransaction(db, mode, execute);
  } finally {
    db.close();
  }
}

function executeJournalTransaction<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  execute: (context: JournalTransactionContext<T>) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let result: T;
    let operationError: unknown;
    let resultAssigned = false;
    const transaction = createJournalTransaction(db, mode);
    const fail = (error: unknown): void => {
      operationError ??= error;
      try {
        transaction.abort();
      } catch {
        reject(operationError);
      }
    };
    transaction.oncomplete = () => {
      if (operationError !== undefined) return reject(operationError);
      if (!resultAssigned) {
        reject(new Error('restore marker journal transaction completed without a result'));
        return;
      }
      resolve(result);
    };
    transaction.onerror = () => reject(
      operationError ?? transaction.error ?? new Error('restore marker journal transaction failed'),
    );
    transaction.onabort = () => reject(
      operationError
      ?? transaction.error
      ?? new DOMException('Restore marker journal transaction aborted', 'AbortError'),
    );
    execute({
      store: transaction.objectStore(RESTORE_MARKER_JOURNAL_STORE_NAME),
      fail,
      setResult: (nextResult: T) => {
        result = nextResult;
        resultAssigned = true;
      },
    });
  });
}

function createJournalTransaction(
  db: IDBDatabase,
  mode: IDBTransactionMode,
): IDBTransaction {
  if (mode !== 'readwrite') {
    return db.transaction(RESTORE_MARKER_JOURNAL_STORE_NAME, mode);
  }
  try {
    return db.transaction(
      RESTORE_MARKER_JOURNAL_STORE_NAME,
      mode,
      { durability: 'strict' },
    );
  } catch {
    return db.transaction(RESTORE_MARKER_JOURNAL_STORE_NAME, mode);
  }
}

function openJournalDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable for data-safety restore marker journal'));
      return;
    }
    const request = indexedDB.open(
      RESTORE_MARKER_JOURNAL_DB_NAME,
      RESTORE_MARKER_JOURNAL_DB_VERSION,
    );
    let settled = false;
    const timeoutId = setTimeout(() => rejectOnce(new DOMException(
      'Restore marker journal IndexedDB open timed out',
      'TimeoutError',
    )), RESTORE_MARKER_JOURNAL_OPEN_TIMEOUT_MS);
    const rejectOnce = (error: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      reject(error);
    };
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(RESTORE_MARKER_JOURNAL_STORE_NAME)) {
        request.result.createObjectStore(RESTORE_MARKER_JOURNAL_STORE_NAME, { keyPath: 'key' });
      }
    };
    request.onerror = () => rejectOnce(
      request.error ?? new Error('restore marker journal IndexedDB open failed'),
    );
    request.onblocked = () => rejectOnce(new DOMException(
      'Restore marker journal IndexedDB open blocked',
      'InvalidStateError',
    ));
    request.onsuccess = () => {
      if (settled) {
        request.result.close();
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}
