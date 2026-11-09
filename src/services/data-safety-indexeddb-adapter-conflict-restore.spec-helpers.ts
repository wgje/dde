import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DB_CONFIG } from '../app/core/state/persistence/indexeddb.service';
import type { Project } from '../models';
import { toStoredConflictRecord, type ConflictRecord } from './conflict-storage.helpers';
import {
  recoverInterruptedDataSafetyRestoreFromIndexedDb,
  restoreDataSafetyPackageToIndexedDb,
} from './data-safety-indexeddb-adapter';
import { buildDataSafetyExportPackage } from './data-safety-package';
import {
  DATA_SAFETY_RESTORE_MARKER_STORAGE_KEY_PREFIX,
  cleanupDataSafetyAdapterStorage,
  connection,
  cursor,
  getConflictStorageRecords,
  meta,
  project,
  putConflictStorageRecords,
  putStoreValue,
  resetDataSafetyAdapterStorage,
  task,
} from './data-safety-indexeddb-adapter.spec-helpers';

export function registerDataSafetyConflictRestoreSpecs(): void {
  describe('data-safety IndexedDB adapter conflict restore', () => {
    let db: IDBDatabase;

    beforeEach(async () => {
      db = await resetDataSafetyAdapterStorage();
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      await cleanupDataSafetyAdapterStorage(db, null, null);
    });

    it('exact-replaces only the restore owner conflicts and preserves other owners', async () => {
      const oldOwnerConflict = createConflict('user-1', 'project-1', 'old-owner');
      const foreignConflict = createConflict('user-2', 'project-2', 'foreign-owner');
      const incomingConflict = createConflict('user-1', 'project-1', 'incoming-owner');
      await putConflictStorageRecords([
        toStoredConflictRecord(oldOwnerConflict, 'user-1'),
        toStoredConflictRecord(foreignConflict, 'user-2'),
      ]);
      localStorage.setItem(conflictFallbackKey(oldOwnerConflict), JSON.stringify(oldOwnerConflict));
      localStorage.setItem(conflictFallbackKey(foreignConflict), JSON.stringify(foreignConflict));

      const result = await restoreDataSafetyPackageToIndexedDb(db, buildPackage([incomingConflict]));

      expect(result.success).toBe(true);
      const records = await getConflictStorageRecords<ReturnType<typeof toStoredConflictRecord>>();
      expect(records).toEqual(expect.arrayContaining([
        toStoredConflictRecord(incomingConflict, 'user-1'),
        toStoredConflictRecord(foreignConflict, 'user-2'),
      ]));
      expect(records).toHaveLength(2);
      expect(localStorage.getItem(conflictFallbackKey(oldOwnerConflict))).toBeNull();
      expect(localStorage.getItem(conflictFallbackKey(foreignConflict))).toBe(JSON.stringify(foreignConflict));
    });

    it('rolls conflicts back exactly when a later audit write fails', async () => {
      const oldOwnerConflict = createConflict('user-1', 'project-1', 'old-before-audit-failure');
      const foreignConflict = createConflict('user-2', 'project-2', 'foreign-before-audit-failure');
      const incomingConflict = createConflict('user-1', 'project-1', 'incoming-before-audit-failure');
      await putConflictStorageRecords([
        toStoredConflictRecord(oldOwnerConflict, 'user-1'),
        toStoredConflictRecord(foreignConflict, 'user-2'),
      ]);
      localStorage.setItem(conflictFallbackKey(oldOwnerConflict), JSON.stringify(oldOwnerConflict));
      localStorage.setItem(conflictFallbackKey(foreignConflict), JSON.stringify(foreignConflict));
      const originalSetItem = localStorage.setItem.bind(localStorage);
      vi.spyOn(localStorage, 'setItem').mockImplementation(function (
        this: typeof localStorage,
        key: string,
        value: string,
      ) {
        if (key === 'nanoflow.data-safety-audit.user-1') {
          throw new Error('simulated audit persistence failure after conflict restore');
        }
        return originalSetItem(key, value);
      });

      const result = await restoreDataSafetyPackageToIndexedDb(db, buildPackage([incomingConflict]));

      expect(result.success).toBe(false);
      expect(result.errors.join('\n')).toContain('data-safety audit persistence failed');
      const records = await getConflictStorageRecords<ReturnType<typeof toStoredConflictRecord>>();
      expect(records).toEqual(expect.arrayContaining([
        toStoredConflictRecord(oldOwnerConflict, 'user-1'),
        toStoredConflictRecord(foreignConflict, 'user-2'),
      ]));
      expect(records).toHaveLength(2);
      expect(localStorage.getItem(conflictFallbackKey(oldOwnerConflict))).toBe(JSON.stringify(oldOwnerConflict));
      expect(localStorage.getItem(conflictFallbackKey(foreignConflict))).toBe(JSON.stringify(foreignConflict));
    });

    it('recovers owner-scoped conflicts from an interrupted restore marker', async () => {
      const oldOwnerConflict = createConflict('user-1', 'project-1', 'old-from-marker');
      const incomingConflict = createConflict('user-1', 'project-1', 'incoming-left-by-crash');
      const foreignConflict = createConflict('user-2', 'project-2', 'foreign-left-untouched');
      await putStoreValue(db, DB_CONFIG.stores.projects, { ...project, name: 'incoming project left by crash' });
      await putConflictStorageRecords([
        toStoredConflictRecord(incomingConflict, 'user-1'),
        toStoredConflictRecord(foreignConflict, 'user-2'),
      ]);
      localStorage.setItem(conflictFallbackKey(incomingConflict), JSON.stringify(incomingConflict));
      localStorage.setItem(conflictFallbackKey(foreignConflict), JSON.stringify(foreignConflict));
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
          conflictRestoreSnapshot: {
            indexedDbRecords: [toStoredConflictRecord(oldOwnerConflict, 'user-1')],
            fallbackLocalStorageEntries: {
              [conflictFallbackKey(oldOwnerConflict)]: JSON.stringify(oldOwnerConflict),
            },
          },
        },
      }));

      const result = await recoverInterruptedDataSafetyRestoreFromIndexedDb(db, 'user-1');

      expect(result).toEqual({ recovered: true, errors: [] });
      const records = await getConflictStorageRecords<ReturnType<typeof toStoredConflictRecord>>();
      expect(records).toEqual(expect.arrayContaining([
        toStoredConflictRecord(oldOwnerConflict, 'user-1'),
        toStoredConflictRecord(foreignConflict, 'user-2'),
      ]));
      expect(records).toHaveLength(2);
      expect(localStorage.getItem(conflictFallbackKey(oldOwnerConflict))).toBe(JSON.stringify(oldOwnerConflict));
      expect(localStorage.getItem(conflictFallbackKey(foreignConflict))).toBe(JSON.stringify(foreignConflict));
      expect(localStorage.getItem(`${DATA_SAFETY_RESTORE_MARKER_STORAGE_KEY_PREFIX}.user-1`)).toBeNull();
    });
  });
}

function createConflict(ownerUserId: string, projectId: string, label: string): ConflictRecord {
  const { projectId: _, ...taskTemplate } = task;
  const localTask = {
    ...taskTemplate,
    id: `${label}-task`,
    content: `${label} content`,
  };
  const localProject: Project = {
    ...project,
    id: projectId,
    name: label,
    tasks: [localTask],
    connections: [],
  };
  return {
    projectId,
    ownerUserId,
    localProject,
    conflictedAt: '2026-06-16T00:00:00.000Z',
    localVersion: 1,
    reason: 'field_conflict',
  };
}

function conflictFallbackKey(conflict: ConflictRecord): string {
  return `nanoflow.conflict.${conflict.ownerUserId}.${conflict.projectId}`;
}

function buildPackage(conflicts: ConflictRecord[]) {
  return buildDataSafetyExportPackage({
    exportedAt: '2026-06-16T00:00:00.000Z',
    ownerUserId: 'user-1',
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
      conflicts,
      taskTombstones: {},
      connectionTombstones: [],
    },
    syncSnapshot: {
      syncState: { lastSyncTime: meta.lastSyncTime, pendingCount: 0 },
      projectCursors: [{ projectId: 'project-1', userId: 'user-1', cursor: cursor.cursor }],
      queueCounts: { retryQueue: 0, actionQueue: 0, deadLetters: 0 },
    },
    replayLog: [],
    lastWriteExplain: null,
  });
}
