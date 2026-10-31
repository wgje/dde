import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createDataSafetyRestoreMarkerJournal,
  deleteDataSafetyRestoreMarkerJournalDatabaseForTests,
} from './data-safety-restore-marker-journal';
import type { DataSafetyRestoreMarkerLeaseIdentity } from './data-safety-indexeddb-restore-marker-lease';

interface TestRestoreMarker extends DataSafetyRestoreMarkerLeaseIdentity {
  schemaVersion: 1;
  rollbackPayload: string;
}

const ownerUserId = 'user-1';
const legacyStorageKey = `nanoflow.data-safety-restore-marker.${ownerUserId}`;
const journalDbName = 'nanoflow-data-safety-restore-journal';
const journalStoreName = 'restore_markers';

function normalizeTestMarker(value: unknown): TestRestoreMarker | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const marker = value as Partial<TestRestoreMarker>;
  return marker.schemaVersion === 1
    && marker.ownerUserId === ownerUserId
    && typeof marker.runId === 'string'
    && typeof marker.createdAt === 'string'
    && typeof marker.leaseExpiresAt === 'string'
    && typeof marker.rollbackPayload === 'string'
    ? marker as TestRestoreMarker
    : null;
}

function buildMarker(runId = 'restore-run-a'): TestRestoreMarker {
  return {
    schemaVersion: 1,
    ownerUserId,
    runId,
    createdAt: '2026-07-27T00:00:00.000Z',
    leaseExpiresAt: '2026-07-27T00:05:00.000Z',
    rollbackPayload: 'large rollback payload that must not stay in localStorage',
  };
}

function createJournal() {
  return createDataSafetyRestoreMarkerJournal<TestRestoreMarker>({
    markerKind: 'full-restore',
    ownerUserId,
    legacyStorageKey,
    normalize: normalizeTestMarker,
  });
}

describe('DataSafetyRestoreMarkerJournal', () => {
  beforeEach(async () => {
    localStorage.clear();
    await deleteDataSafetyRestoreMarkerJournalDatabaseForTests();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    localStorage.clear();
    await deleteDataSafetyRestoreMarkerJournalDatabaseForTests();
  });

  it('persists the marker in IndexedDB without retaining its rollback payload in localStorage', async () => {
    const marker = buildMarker();
    const journal = createJournal();

    await journal.create(marker);

    await expect(journal.read()).resolves.toEqual(marker);
    const sentinelRaw = localStorage.getItem(legacyStorageKey);
    expect(sentinelRaw).not.toBeNull();
    expect(sentinelRaw).not.toContain(marker.rollbackPayload);
    expect(JSON.parse(sentinelRaw ?? '{}')).toMatchObject({
      storage: 'indexeddb-journal',
      markerKind: 'full-restore',
      ownerUserId,
      runId: marker.runId,
    });
  });

  it('claims an expired marker atomically and rejects stale renew or clear attempts', async () => {
    const marker = buildMarker();
    const journal = createJournal();
    await journal.create(marker);
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-07-27T00:06:00.000Z'));

    const claimed = await journal.claimExpired(marker);

    expect(claimed).not.toBeNull();
    expect(claimed?.runId).not.toBe(marker.runId);
    await expect(journal.renew(marker)).resolves.toBeNull();
    await expect(journal.clear(marker)).resolves.toBe(false);
    await expect(journal.owns(claimed!)).resolves.toBe(true);
    await expect(journal.clear(claimed!)).resolves.toBe(true);
    await expect(journal.read()).resolves.toBeNull();
    expect(localStorage.getItem(legacyStorageKey)).toBeNull();
  });

  it('replaces only the exact durable marker value without accepting stale stage state', async () => {
    const marker = buildMarker();
    const journal = createJournal();
    await journal.create(marker);
    const next = { ...marker, rollbackPayload: 'stage projects completed' };

    await expect(journal.replace(marker, next)).resolves.toEqual(next);
    await expect(journal.replace(marker, { ...marker, rollbackPayload: 'stale overwrite' }))
      .resolves.toBeNull();
    await expect(journal.read()).resolves.toEqual(next);
  });

  it('restores the expected durable marker and sentinel when replace sentinel write fails', async () => {
    const marker = buildMarker('replace-sentinel-write-failure');
    const next = { ...marker, rollbackPayload: 'stage projects completed' };
    const journal = createJournal();
    await journal.create(marker);
    const originalSentinel = localStorage.getItem(legacyStorageKey);
    const originalSetItem = localStorage.setItem.bind(localStorage);
    let failedNextSentinelWrite = false;
    vi.spyOn(localStorage, 'setItem').mockImplementation((key: string, value: string) => {
      if (!failedNextSentinelWrite && key === legacyStorageKey) {
        failedNextSentinelWrite = true;
        throw new DOMException('quota exhausted', 'QuotaExceededError');
      }
      originalSetItem(key, value);
    });

    await expect(journal.replace(marker, next)).rejects.toThrow('quota exhausted');
    await expect(journal.read()).resolves.toEqual(marker);
    await expect(readJournalRecord()).resolves.toEqual(journalRecordFor(marker));
    expect(localStorage.getItem(legacyStorageKey)).toBe(originalSentinel);
  });

  it('keeps fail-closed evidence without overwriting another run when replace compensation cannot restore', async () => {
    const marker = buildMarker('replace-compensation-failure');
    const next = { ...marker, rollbackPayload: 'stage projects completed' };
    const foreign = buildMarker('replace-foreign-run');
    const journal = createJournal();
    await journal.create(marker);
    const originalSetItem = localStorage.setItem.bind(localStorage);
    const originalPut = IDBObjectStore.prototype.put;
    let failCompensationWrite = false;
    vi.spyOn(localStorage, 'setItem').mockImplementation((key: string, value: string) => {
      if (key === legacyStorageKey && !failCompensationWrite) {
        failCompensationWrite = true;
        originalSetItem(key, JSON.stringify(sentinelFor(foreign)));
        throw new DOMException('quota exhausted', 'QuotaExceededError');
      }
      originalSetItem(key, value);
    });
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey,
    ) {
      const request = key === undefined
        ? originalPut.call(this, value)
        : originalPut.call(this, value, key);
      if (failCompensationWrite && isJournalRecordForMarker(value, marker)) {
        request.addEventListener('success', () => this.transaction.abort());
      }
      return request;
    });

    await expect(journal.replace(marker, next)).rejects.toThrow('quota exhausted');
    await expect(readJournalRecord()).resolves.toEqual(journalRecordFor(next));
    expect(localStorage.getItem(legacyStorageKey)).toBe(JSON.stringify(sentinelFor(foreign)));
    await expect(journal.read()).rejects.toThrow('conflicts with the durable marker');
  });

  it('fails closed when a stale build replaces the sentinel with another run', async () => {
    const marker = buildMarker();
    const newerMarker = buildMarker('restore-run-b');
    const journal = createJournal();
    await journal.create(marker);
    localStorage.setItem(legacyStorageKey, JSON.stringify(newerMarker));

    expect(journal.hasSentinelOwnership(marker)).toBe(false);
    await expect(journal.owns(marker)).resolves.toBe(false);
    await expect(journal.renew(marker)).resolves.toBeNull();
    await expect(journal.clear(marker)).resolves.toBe(false);
    await expect(journal.read()).rejects.toThrow('conflicts with the durable marker');
  });

  it('imports a legacy localStorage marker before returning recovery state', async () => {
    const marker = buildMarker('legacy-restore-run');
    localStorage.setItem(legacyStorageKey, JSON.stringify(marker));
    const journal = createJournal();

    await expect(journal.read()).resolves.toEqual(marker);

    const sentinelRaw = localStorage.getItem(legacyStorageKey);
    expect(sentinelRaw).not.toContain(marker.rollbackPayload);
    localStorage.removeItem(legacyStorageKey);
    await expect(createJournal().read()).resolves.toEqual(marker);
  });

  it('removes a newly committed marker when the compatibility sentinel cannot be written', async () => {
    const marker = buildMarker('sentinel-write-failure');
    const journal = createJournal();
    const originalSetItem = localStorage.setItem.bind(localStorage);
    vi.spyOn(localStorage, 'setItem').mockImplementation((key: string, value: string) => {
      if (key === legacyStorageKey) throw new DOMException('quota exhausted', 'QuotaExceededError');
      originalSetItem(key, value);
    });

    await expect(journal.create(marker)).rejects.toThrow('quota exhausted');
    await expect(journal.read()).resolves.toBeNull();
  });

  it('does not report marker durability when the write transaction aborts after request success', async () => {
    const marker = buildMarker('aborted-write');
    const journal = createJournal();
    const originalAdd = IDBObjectStore.prototype.add;
    vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey,
    ) {
      const request = key === undefined
        ? originalAdd.call(this, value)
        : originalAdd.call(this, value, key);
      request.addEventListener('success', () => this.transaction.abort());
      return request;
    });

    await expect(journal.create(marker)).rejects.toThrow(/abort/i);
    expect(localStorage.getItem(legacyStorageKey)).toBeNull();
    await expect(journal.read()).resolves.toBeNull();
  });
});

function sentinelFor(marker: TestRestoreMarker): Record<string, unknown> {
  return {
    schemaVersion: 2,
    storage: 'indexeddb-journal',
    markerKind: 'full-restore',
    ownerUserId,
    runId: marker.runId,
  };
}

function journalRecordFor(marker: TestRestoreMarker): Record<string, unknown> {
  return {
    key: 'full-restore:user-1',
    markerKind: 'full-restore',
    ownerUserId,
    marker,
  };
}

function isJournalRecordForMarker(value: unknown, marker: TestRestoreMarker): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as {
    key?: unknown;
    markerKind?: unknown;
    ownerUserId?: unknown;
    marker?: Partial<TestRestoreMarker>;
  };
  return record.key === 'full-restore:user-1'
    && record.markerKind === 'full-restore'
    && record.ownerUserId === ownerUserId
    && record.marker?.runId === marker.runId
    && record.marker?.rollbackPayload === marker.rollbackPayload;
}

async function readJournalRecord(): Promise<unknown> {
  const db = await openJournalDatabase();
  try {
    return await requestResult(
      db.transaction(journalStoreName, 'readonly')
        .objectStore(journalStoreName)
        .get('full-restore:user-1'),
    );
  } finally {
    db.close();
  }
}

function openJournalDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(journalDbName, 1);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(journalStoreName)) {
        request.result.createObjectStore(journalStoreName, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
