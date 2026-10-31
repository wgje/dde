import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { restoreDataSafetyPackageToIndexedDb } from './data-safety-indexeddb-adapter';
import { readDataSafetyRestoreMarker } from './data-safety-indexeddb-local-state';
import { deleteDataSafetyRestoreMarkerJournalDatabaseForTests } from './data-safety-restore-marker-journal';
import {
  buildDataSafetyExportPackage,
  type DataSafetyEntityRecord,
} from './data-safety-package';
import {
  DATA_SAFETY_RESTORE_MARKER_STORAGE_KEY_PREFIX,
  cleanupDataSafetyAdapterStorage,
  project,
  resetDataSafetyAdapterStorage,
} from './data-safety-indexeddb-adapter.spec-helpers';

function buildMinimalRestorePackage(projectToRestore: DataSafetyEntityRecord) {
  return buildDataSafetyExportPackage({
    exportedAt: '2026-06-16T00:00:00.000Z',
    ownerUserId: 'user-1',
    app: { appVersion: '1.0.0', syncProtocolVersion: 1, deploymentEpoch: 0 },
    localData: {
      projects: [projectToRestore], tasks: [], connections: [], syncCursors: [], meta: null,
    },
    localState: {
      retryQueue: [], actionQueue: [], deadLetters: [], conflicts: [],
      taskTombstones: {}, connectionTombstones: [],
    },
    syncSnapshot: {
      syncState: { lastSyncTime: null, pendingCount: 0 },
      projectCursors: [],
      queueCounts: { retryQueue: 0, actionQueue: 0, deadLetters: 0 },
    },
    replayLog: [],
    lastWriteExplain: null,
  });
}

export function registerDataSafetyRestoreMarkerRaceSpecs(): void {
  describe('data-safety IndexedDB restore marker races', () => {
    let db: IDBDatabase;

    beforeEach(async () => {
      await deleteDataSafetyRestoreMarkerJournalDatabaseForTests();
      db = await resetDataSafetyAdapterStorage();
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      await cleanupDataSafetyAdapterStorage(db, null, null);
      await deleteDataSafetyRestoreMarkerJournalDatabaseForTests();
    });

    it('does not roll back when another run acquires the marker before mutation starts', async () => {
      const markerKey = `${DATA_SAFETY_RESTORE_MARKER_STORAGE_KEY_PREFIX}.user-1`;
      const auditKey = 'nanoflow.data-safety-audit.user-1';
      const oldAuditRaw = JSON.stringify({ replayLog: [{ operationId: 'old' }], lastWriteExplain: null });
      const newerAuditRaw = JSON.stringify({ replayLog: [{ operationId: 'newer' }], lastWriteExplain: null });
      localStorage.setItem(auditKey, oldAuditRaw);
      const pkg = buildMinimalRestorePackage({ ...project, name: 'restore that loses marker acquisition' });
      const newerMarkerRaw = JSON.stringify({
        schemaVersion: 1,
        ownerUserId: 'user-1',
        runId: 'restore-run-b',
        createdAt: new Date().toISOString(),
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        primaryStoreSnapshot: {
          projects: [project], tasks: [], connections: [], syncCursors: [], meta: null,
        },
        localStateSnapshot: {
          retryQueueIndexedDbItems: null,
          retryQueueLocalStorageValue: null,
          actionQueueBackupRecord: null,
          actionQueueLocalStorageValue: null,
          deadLetterBackupRecord: null,
          deadLetterLocalStorageValue: null,
          auditLocalStorageValue: newerAuditRaw,
        },
      });
      const originalGetItem = localStorage.getItem.bind(localStorage);
      const originalSetItem = localStorage.setItem.bind(localStorage);
      let markerReadCount = 0;
      vi.spyOn(localStorage, 'getItem').mockImplementation(function (
        this: typeof localStorage,
        key: string,
      ) {
        if (key === markerKey && ++markerReadCount === 2) {
          originalSetItem(markerKey, newerMarkerRaw);
          originalSetItem(auditKey, newerAuditRaw);
        }
        return originalGetItem(key);
      });

      const result = await restoreDataSafetyPackageToIndexedDb(db, pkg);

      expect(result.success).toBe(false);
      expect(result.errors).toEqual([expect.stringContaining('restore already in progress')]);
      expect(localStorage.getItem(auditKey)).toBe(newerAuditRaw);
      expect(JSON.parse(localStorage.getItem(markerKey) ?? 'null')).toEqual(expect.objectContaining({
        storage: 'indexeddb-journal',
        markerKind: 'full-restore',
        ownerUserId: 'user-1',
        runId: 'restore-run-b',
      }));
      await expect(readDataSafetyRestoreMarker('user-1')).resolves.toEqual(expect.objectContaining({
        ...JSON.parse(newerMarkerRaw),
        runId: 'restore-run-b',
      }));
    });

    it('renews the restore marker lease while a restore remains in progress', async () => {
      let now = Date.parse('2026-06-16T00:00:00.000Z');
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      let heartbeat: (() => void) | null = null;
      vi.spyOn(globalThis, 'setInterval').mockImplementation(((handler: TimerHandler) => {
        if (typeof handler === 'function') heartbeat = () => handler();
        return 1;
      }) as typeof setInterval);
      const auditKey = 'nanoflow.data-safety-audit.user-1';
      const pkg = buildMinimalRestorePackage({ ...project, name: 'long running restore' });
      const journalLeaseWrites: string[] = [];
      captureJournalLeaseWrites(journalLeaseWrites);
      const originalSetItem = localStorage.setItem.bind(localStorage);
      vi.spyOn(localStorage, 'setItem').mockImplementation(function (
        this: typeof localStorage,
        key: string,
        value: string,
      ) {
        originalSetItem(key, value);
        if (key !== auditKey) return;

        now += 4 * 60 * 1000;
        heartbeat?.();
      });

      const result = await restoreDataSafetyPackageToIndexedDb(db, pkg);

      expect(result.success).toBe(true);
      expect(journalLeaseWrites.length).toBeGreaterThan(1);
      expect(Date.parse(journalLeaseWrites.at(-1) ?? '')).toBeGreaterThan(
        Date.parse(journalLeaseWrites[0] ?? ''),
      );
    });

    it('keeps rollback snapshots out of the legacy localStorage marker key', async () => {
      const markerKey = `${DATA_SAFETY_RESTORE_MARKER_STORAGE_KEY_PREFIX}.user-1`;
      const markerWrites: string[] = [];
      const originalSetItem = localStorage.setItem.bind(localStorage);
      vi.spyOn(localStorage, 'setItem').mockImplementation((key: string, value: string) => {
        if (key === markerKey) markerWrites.push(value);
        originalSetItem(key, value);
      });

      const result = await restoreDataSafetyPackageToIndexedDb(
        db,
        buildMinimalRestorePackage({ ...project, name: 'journal-backed restore' }),
      );

      expect(result.success).toBe(true);
      expect(markerWrites.length).toBeGreaterThan(0);
      expect(markerWrites.every(value => !value.includes('primaryStoreSnapshot'))).toBe(true);
      expect(markerWrites.every(value => !value.includes('localStateSnapshot'))).toBe(true);
      expect(markerWrites.map(value => JSON.parse(value))).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            storage: 'indexeddb-journal',
            markerKind: 'full-restore',
            ownerUserId: 'user-1',
          }),
        ]),
      );
    });
  });
}

function captureJournalLeaseWrites(target: string[]): void {
  const originalAdd = IDBObjectStore.prototype.add;
  const originalPut = IDBObjectStore.prototype.put;
  vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (
    this: IDBObjectStore,
    value: unknown,
    key?: IDBValidKey,
  ) {
    captureJournalLease(this, value, target);
    return Reflect.apply(originalAdd, this, key === undefined ? [value] : [value, key]);
  });
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
    this: IDBObjectStore,
    value: unknown,
    key?: IDBValidKey,
  ) {
    captureJournalLease(this, value, target);
    return Reflect.apply(originalPut, this, key === undefined ? [value] : [value, key]);
  });
}

function captureJournalLease(
  store: IDBObjectStore,
  value: unknown,
  target: string[],
): void {
  if (store.name !== 'restore_markers' || !value || typeof value !== 'object') return;
  const marker = (value as { marker?: unknown }).marker;
  if (!marker || typeof marker !== 'object') return;
  const leaseExpiresAt = (marker as { leaseExpiresAt?: unknown }).leaseExpiresAt;
  if (typeof leaseExpiresAt === 'string') target.push(leaseExpiresAt);
}
