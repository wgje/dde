import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DB_CONFIG } from '../app/core/state/persistence/indexeddb.service';
import {
  recoverInterruptedDataSafetyRestoreFromIndexedDb,
  restoreDataSafetyPackageToIndexedDb,
} from './data-safety-indexeddb-adapter';
import { buildDataSafetyExportPackage, type DataSafetyExportPackage } from './data-safety-package';
import {
  DATA_SAFETY_RESTORE_MARKER_STORAGE_KEY_PREFIX,
  cleanupDataSafetyAdapterStorage,
  connection,
  cursor,
  getOfflineSnapshotRecord,
  meta,
  project,
  putOfflineSnapshotRecord,
  putStoreValue,
  resetDataSafetyAdapterStorage,
  task,
} from './data-safety-indexeddb-adapter.spec-helpers';

export function registerDataSafetyOfflineSnapshotRestoreSpecs(): void {
  describe('data-safety IndexedDB adapter offline snapshot restore', () => {
    let db: IDBDatabase;

    beforeEach(async () => {
      db = await resetDataSafetyAdapterStorage();
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      await cleanupDataSafetyAdapterStorage(db, null, null);
    });

    it('restores deterministic owner-scoped offline snapshot mirrors and preserves other owners', async () => {
      const incomingRaw = createOfflineSnapshotRaw('user-1', 'incoming');
      const foreignRaw = createOfflineSnapshotRaw('user-2', 'foreign');
      localStorage.setItem('nanoflow.offline-cache-v2.user-1', createOfflineSnapshotRaw('user-1', 'old'));
      localStorage.setItem('nanoflow.offline-cache-v2.user-2', foreignRaw);
      await putOfflineSnapshotRecord({ id: 'offline-snapshot:user-1', ownerUserId: 'user-1', data: 'old-idb' });
      await putOfflineSnapshotRecord({ id: 'offline-snapshot:user-2', ownerUserId: 'user-2', data: foreignRaw });

      const result = await restoreDataSafetyPackageToIndexedDb(
        db,
        buildPackage('user-1', { localStorage: incomingRaw, indexedDb: incomingRaw }),
      );

      expect(result.success).toBe(true);
      expect(localStorage.getItem('nanoflow.offline-cache-v2.user-1')).toBe(incomingRaw);
      expect(localStorage.getItem('nanoflow.offline-cache-v2.user-2')).toBe(foreignRaw);
      await expect(getOfflineSnapshotRecord('offline-snapshot:user-1')).resolves.toEqual({
        id: 'offline-snapshot:user-1',
        ownerUserId: 'user-1',
        data: incomingRaw,
      });
      await expect(getOfflineSnapshotRecord('offline-snapshot:user-2')).resolves.toEqual({
        id: 'offline-snapshot:user-2',
        ownerUserId: 'user-2',
        data: foreignRaw,
      });
    });

    it('uses one available offline snapshot mirror as the canonical source for both mirrors', async () => {
      const incomingRaw = createOfflineSnapshotRaw('user-1', 'single-mirror');

      const result = await restoreDataSafetyPackageToIndexedDb(
        db,
        buildPackage('user-1', { indexedDb: incomingRaw }),
      );

      expect(result.success).toBe(true);
      expect(localStorage.getItem('nanoflow.offline-cache-v2.user-1')).toBe(incomingRaw);
      await expect(getOfflineSnapshotRecord('offline-snapshot:user-1')).resolves.toEqual({
        id: 'offline-snapshot:user-1',
        ownerUserId: 'user-1',
        data: incomingRaw,
      });
    });

    it('rejects offline snapshot tasks missing content before any mutation', async () => {
      const oldProject = { ...project, name: 'old project before malformed offline snapshot' };
      await putStoreValue(db, DB_CONFIG.stores.projects, oldProject);
      const malformedRaw = JSON.stringify({
        projects: [{ ...project, tasks: [{ id: 'task-without-content' }], connections: [] }],
        version: 2,
        ownerUserId: 'user-1',
        savedAt: '2026-06-16T00:00:00.000Z',
      });

      const result = await restoreDataSafetyPackageToIndexedDb(
        db,
        buildPackage('user-1', { localStorage: malformedRaw }),
      );

      expect(result.success).toBe(false);
      expect(result.errors.join('\n')).toContain(
        'localState.offlineSnapshots.projects[0].tasks[0].content must be a string',
      );
      await expect(readPrimaryProjects(db)).resolves.toEqual([oldProject]);
      expect(localStorage.getItem(`${DATA_SAFETY_RESTORE_MARKER_STORAGE_KEY_PREFIX}.user-1`)).toBeNull();
    });

    it('restores local-mode scoped and legacy mirrors after a later audit failure', async () => {
      const oldScopedRaw = createOfflineSnapshotRaw('local-user', 'old-scoped');
      const oldLegacyRaw = JSON.stringify({
        projects: [{ ...project, name: 'old legacy', tasks: [task], connections: [connection] }],
        version: 2,
        savedAt: '2026-06-15T00:00:00.000Z',
      });
      const incomingRaw = createOfflineSnapshotRaw('local-user', 'incoming');
      localStorage.setItem('nanoflow.offline-cache-v2.local-user', oldScopedRaw);
      localStorage.setItem('nanoflow.offline-cache-v2', oldLegacyRaw);
      await putOfflineSnapshotRecord({
        id: 'offline-snapshot:local-user',
        ownerUserId: 'local-user',
        data: oldScopedRaw,
      });
      await putOfflineSnapshotRecord({ id: 'offline-snapshot', data: oldLegacyRaw });
      const originalSetItem = localStorage.setItem.bind(localStorage);
      vi.spyOn(localStorage, 'setItem').mockImplementation(function (
        this: typeof localStorage,
        key: string,
        value: string,
      ) {
        if (key === 'nanoflow.data-safety-audit.local-user') {
          throw new Error('simulated audit persistence failure after offline snapshot restore');
        }
        return originalSetItem(key, value);
      });

      const result = await restoreDataSafetyPackageToIndexedDb(
        db,
        buildPackage('local-user', { localStorage: incomingRaw, indexedDb: incomingRaw }),
      );

      expect(result.success).toBe(false);
      expect(result.errors.join('\n')).toContain('data-safety audit persistence failed');
      expect(localStorage.getItem('nanoflow.offline-cache-v2.local-user')).toBe(oldScopedRaw);
      expect(localStorage.getItem('nanoflow.offline-cache-v2')).toBe(oldLegacyRaw);
      await expect(getOfflineSnapshotRecord('offline-snapshot:local-user')).resolves.toEqual({
        id: 'offline-snapshot:local-user',
        ownerUserId: 'local-user',
        data: oldScopedRaw,
      });
      await expect(getOfflineSnapshotRecord('offline-snapshot')).resolves.toEqual({
        id: 'offline-snapshot',
        data: oldLegacyRaw,
      });
    });

    it('recovers offline snapshot mirrors from an interrupted restore marker', async () => {
      const oldRaw = createOfflineSnapshotRaw('user-1', 'old-from-marker');
      const incomingRaw = createOfflineSnapshotRaw('user-1', 'incoming-left-by-crash');
      const foreignRaw = createOfflineSnapshotRaw('user-2', 'foreign-left-untouched');
      await putStoreValue(db, DB_CONFIG.stores.projects, { ...project, name: 'incoming project left by crash' });
      localStorage.setItem('nanoflow.offline-cache-v2.user-1', incomingRaw);
      localStorage.setItem('nanoflow.offline-cache-v2.user-2', foreignRaw);
      await putOfflineSnapshotRecord({
        id: 'offline-snapshot:user-1',
        ownerUserId: 'user-1',
        data: incomingRaw,
      });
      await putOfflineSnapshotRecord({
        id: 'offline-snapshot:user-2',
        ownerUserId: 'user-2',
        data: foreignRaw,
      });
      localStorage.setItem(`${DATA_SAFETY_RESTORE_MARKER_STORAGE_KEY_PREFIX}.user-1`, JSON.stringify({
        schemaVersion: 1,
        ownerUserId: 'user-1',
        createdAt: '2026-06-16T00:00:00.000Z',
        primaryStoreSnapshot: {
          projects: [project],
          tasks: [task],
          connections: [connection],
          syncCursors: [cursor],
          meta,
        },
        localStateSnapshot: {
          retryQueueIndexedDbItems: [],
          retryQueueLocalStorageValue: null,
          actionQueueBackupRecord: null,
          actionQueueLocalStorageValue: null,
          deadLetterBackupRecord: null,
          deadLetterLocalStorageValue: null,
          auditLocalStorageValue: null,
          offlineSnapshotRestoreSnapshot: {
            scopedLocalStorageValue: oldRaw,
            scopedIndexedDbRecord: {
              id: 'offline-snapshot:user-1',
              ownerUserId: 'user-1',
              data: oldRaw,
            },
          },
        },
      }));

      const result = await recoverInterruptedDataSafetyRestoreFromIndexedDb(db, 'user-1');

      expect(result).toEqual({ recovered: true, errors: [] });
      expect(localStorage.getItem('nanoflow.offline-cache-v2.user-1')).toBe(oldRaw);
      expect(localStorage.getItem('nanoflow.offline-cache-v2.user-2')).toBe(foreignRaw);
      await expect(getOfflineSnapshotRecord('offline-snapshot:user-1')).resolves.toEqual({
        id: 'offline-snapshot:user-1',
        ownerUserId: 'user-1',
        data: oldRaw,
      });
      await expect(getOfflineSnapshotRecord('offline-snapshot:user-2')).resolves.toEqual({
        id: 'offline-snapshot:user-2',
        ownerUserId: 'user-2',
        data: foreignRaw,
      });
      expect(localStorage.getItem(`${DATA_SAFETY_RESTORE_MARKER_STORAGE_KEY_PREFIX}.user-1`)).toBeNull();
    });
  });
}

function buildPackage(
  ownerUserId: string,
  offlineSnapshots: NonNullable<DataSafetyExportPackage['localState']['offlineSnapshots']>,
) {
  return buildDataSafetyExportPackage({
    exportedAt: '2026-06-16T00:00:00.000Z',
    ownerUserId,
    app: { appVersion: '1.0.0', syncProtocolVersion: 1, deploymentEpoch: 0 },
    localData: {
      projects: [project],
      tasks: [task],
      connections: [connection],
      syncCursors: [cursor],
      meta,
    },
    localState: {
      retryQueue: [],
      actionQueue: [],
      deadLetters: [],
      conflicts: [],
      taskTombstones: {},
      connectionTombstones: [],
      offlineSnapshots,
    },
    syncSnapshot: {
      syncState: { lastSyncTime: meta.lastSyncTime, pendingCount: 0 },
      projectCursors: [{ projectId: 'project-1', userId: ownerUserId, cursor: cursor.cursor }],
      queueCounts: { retryQueue: 0, actionQueue: 0, deadLetters: 0 },
    },
    replayLog: [],
    lastWriteExplain: null,
  });
}

function createOfflineSnapshotRaw(ownerUserId: string, label: string): string {
  return JSON.stringify({
    projects: [{
      ...project,
      name: label,
      tasks: [{ ...task, content: `${label} content` }],
      connections: [connection],
    }],
    version: 2,
    ownerUserId,
    savedAt: '2026-06-16T00:00:00.000Z',
  });
}

async function readPrimaryProjects(db: IDBDatabase): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_CONFIG.stores.projects, 'readonly');
    const request = tx.objectStore(DB_CONFIG.stores.projects).getAll();
    request.onsuccess = () => resolve(request.result ?? []);
    request.onerror = () => reject(request.error);
  });
}
