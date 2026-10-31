import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Project, Task } from '../models';
import { DB_CONFIG } from '../app/core/state/persistence/indexeddb.service';
import {
  recoverInterruptedDataSafetyRestoreFromIndexedDb,
  restoreDataSafetyPackageToIndexedDb,
} from './data-safety-indexeddb-adapter';
import {
  buildDataSafetyExportPackage,
  type DataSafetyExportPackage,
} from './data-safety-package';
import { createDerivedSyncOperationId } from '../utils/sync-operation-id';
import {
  DATA_SAFETY_RESTORE_MARKER_STORAGE_KEY_PREFIX,
  LEGACY_ACTION_QUEUE_OPERATION_ID_PURPOSE,
  LEGACY_RETRY_QUEUE_OPERATION_ID_PURPOSE,
  cleanupDataSafetyAdapterStorage,
  connection,
  cursor,
  getAllStoreValues,
  getStoreValue,
  meta,
  openQueueBackupDatabase,
  openRetryQueueDatabase,
  project,
  putStoreValue,
  resetDataSafetyAdapterStorage,
  task,
} from './data-safety-indexeddb-adapter.spec-helpers';
import { registerQueueBackupPersonalRestoreDataSafetySpecs } from './queue-backup-personal-restore-writer.spec-helpers';
import { registerQueueBackupPersonalRestoreTransitionSpecs } from './queue-backup-personal-restore-transition.spec-helpers';
import { registerQueueBackupPersonalRestoreRecoverySpecs } from './queue-backup-personal-restore-recovery.spec-helpers';

export function registerDataSafetyMalformedRestoreSpecs(): void {
  registerQueueBackupPersonalRestoreDataSafetySpecs();
  registerQueueBackupPersonalRestoreTransitionSpecs();
  registerQueueBackupPersonalRestoreRecoverySpecs();
  describe('data-safety IndexedDB adapter', () => {
    let db: IDBDatabase;
    let retryDb: IDBDatabase | null = null;
    let queueBackupDb: IDBDatabase | null = null;

    beforeEach(async () => {
      db = await resetDataSafetyAdapterStorage();
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      await cleanupDataSafetyAdapterStorage(db, retryDb, queueBackupDb);
      retryDb = null;
      queueBackupDb = null;
    });

  it('fails closed and preserves an invalid JSON restore marker without mutating local data', async () => {
    const currentProject = { ...project, name: 'current project before corrupt marker recovery' };
    const markerKey = `${DATA_SAFETY_RESTORE_MARKER_STORAGE_KEY_PREFIX}.user-1`;
    await putStoreValue(db, DB_CONFIG.stores.projects, currentProject);
    localStorage.setItem(markerKey, '{"schemaVersion":1');

    const result = await recoverInterruptedDataSafetyRestoreFromIndexedDb(db, 'user-1');

    expect(result.recovered).toBe(false);
    expect(result.errors).toEqual([
      expect.stringContaining('restore marker validation failed'),
    ]);
    await expect(getAllStoreValues<Project>(db, DB_CONFIG.stores.projects)).resolves.toEqual([
      currentProject,
    ]);
    expect(localStorage.getItem(markerKey)).toBe('{"schemaVersion":1');
  });

  it('fails closed instead of silently filtering malformed primary-store marker records', async () => {
    const currentProject = { ...project, name: 'current project before malformed marker snapshot' };
    const markerKey = `${DATA_SAFETY_RESTORE_MARKER_STORAGE_KEY_PREFIX}.user-1`;
    const marker = buildRestoreMarker({ ...project, name: 'rollback project from marker' });
    const primaryStoreSnapshot = marker['primaryStoreSnapshot'] as Record<string, unknown>;
    primaryStoreSnapshot['projects'] = [project, null];
    await putStoreValue(db, DB_CONFIG.stores.projects, currentProject);
    localStorage.setItem(markerKey, JSON.stringify(marker));

    const result = await recoverInterruptedDataSafetyRestoreFromIndexedDb(db, 'user-1');

    expect(result.recovered).toBe(false);
    expect(result.errors).toEqual([
      expect.stringContaining('restore marker validation failed'),
    ]);
    await expect(getAllStoreValues<Project>(db, DB_CONFIG.stores.projects)).resolves.toEqual([
      currentProject,
    ]);
    expect(localStorage.getItem(markerKey)).toBe(JSON.stringify(marker));
  });

  it('fails closed instead of silently filtering malformed queue backup marker items', async () => {
    const currentProject = { ...project, name: 'current project before malformed queue marker' };
    const markerKey = `${DATA_SAFETY_RESTORE_MARKER_STORAGE_KEY_PREFIX}.user-1`;
    const marker = buildRestoreMarker({ ...project, name: 'rollback project from queue marker' });
    const localStateSnapshot = marker['localStateSnapshot'] as Record<string, unknown>;
    localStateSnapshot['actionQueueBackupRecord'] = {
      id: 'queue-backup:user-1',
      ownerUserId: 'user-1',
      actions: [{ id: 'malformed-action-that-must-not-disappear' }],
      savedAt: '2026-06-15T00:00:00.000Z',
    };
    await putStoreValue(db, DB_CONFIG.stores.projects, currentProject);
    localStorage.setItem(markerKey, JSON.stringify(marker));

    const result = await recoverInterruptedDataSafetyRestoreFromIndexedDb(db, 'user-1');

    expect(result.recovered).toBe(false);
    expect(result.errors).toEqual([
      expect.stringContaining('restore marker validation failed'),
    ]);
    await expect(getAllStoreValues<Project>(db, DB_CONFIG.stores.projects)).resolves.toEqual([
      currentProject,
    ]);
    expect(localStorage.getItem(markerKey)).toBe(JSON.stringify(marker));
  });

  it('rejects project-orphaned task and connection records before mutation', async () => {
    const oldProject = { ...project, name: 'old local project before orphaned restore' };
    const oldTask = { ...task, title: 'old local task before orphaned restore' };
    const oldConnection = {
      ...connection,
      id: 'old-connection',
      source: oldTask.id,
      target: oldTask.id,
      fromTaskId: oldTask.id,
      toTaskId: oldTask.id,
    };
    await putStoreValue(db, DB_CONFIG.stores.projects, oldProject);
    await putStoreValue(db, DB_CONFIG.stores.tasks, oldTask);
    await putStoreValue(db, DB_CONFIG.stores.connections, oldConnection);

    const pkg = buildDataSafetyExportPackage({
      exportedAt: '2026-06-16T00:00:00.000Z',
      ownerUserId: 'user-1',
      app: { appVersion: '1.0.0', syncProtocolVersion: 1, deploymentEpoch: 0 },
      localData: {
        projects: [{ ...project, name: 'incoming project' }],
        tasks: [{ ...task, projectId: 'missing-project' }],
        connections: [{ ...connection, projectId: 'missing-project' }],
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
      },
      syncSnapshot: {
        syncState: { lastSyncTime: meta.lastSyncTime, pendingCount: 0 },
        projectCursors: [{ projectId: 'project-1', userId: 'user-1', cursor: cursor.cursor }],
        queueCounts: { retryQueue: 0, actionQueue: 0, deadLetters: 0 },
      },
      replayLog: [],
      lastWriteExplain: null,
    });

    const result = await restoreDataSafetyPackageToIndexedDb(db, pkg);

    expect(result.success).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      'localData.tasks[0].projectId must reference localData.projects',
      'localData.connections[0].projectId must reference localData.projects',
    ]));
    await expect(getAllStoreValues<Project>(db, DB_CONFIG.stores.projects)).resolves.toEqual([oldProject]);
    await expect(getAllStoreValues<Task>(db, DB_CONFIG.stores.tasks)).resolves.toEqual([oldTask]);
    await expect(getAllStoreValues<typeof oldConnection>(db, DB_CONFIG.stores.connections)).resolves.toEqual([
      oldConnection,
    ]);
    expect(localStorage.getItem(`${DATA_SAFETY_RESTORE_MARKER_STORAGE_KEY_PREFIX}.user-1`)).toBeNull();
  });

  it('rejects malformed ActionQueue items before mutation', async () => {
    const oldProject = { ...project, name: 'old local project before malformed action restore' };
    const oldTask = { ...task, title: 'old local task before malformed action restore' };
    const incomingProject = { ...project, name: 'incoming project with malformed action' };
    const incomingTask = { ...task, title: 'incoming task with malformed action' };
    const oldActionQueueItem = {
      id: 'old-action-before-malformed-restore',
      operationId: createDerivedSyncOperationId(
        'old-action-before-malformed-restore',
        LEGACY_ACTION_QUEUE_OPERATION_ID_PURPOSE,
      ),
      entityType: 'task',
      entityId: 'old-task',
      type: 'update',
      payload: { taskId: 'old-task', projectId: 'project-1' },
      retryCount: 1,
      timestamp: 1781539100000,
    };
    const malformedActionQueueItem = {
      id: 'malformed-action-must-not-disappear',
      operationId: 'legacy-malformed-action-operation',
      entityType: 'task',
      entityId: 'task-1',
      type: 'update',
    } as unknown as DataSafetyExportPackage['localState']['actionQueue'][number];

    await putStoreValue(db, DB_CONFIG.stores.projects, oldProject);
    await putStoreValue(db, DB_CONFIG.stores.tasks, oldTask);
    queueBackupDb = await openQueueBackupDatabase();
    await putStoreValue(queueBackupDb, 'queue-backup', {
      id: 'queue-backup:user-1',
      ownerUserId: 'user-1',
      actions: [oldActionQueueItem],
      savedAt: '2026-06-15T00:00:00.000Z',
    });
    localStorage.setItem('nanoflow.action-queue.user-1', JSON.stringify([oldActionQueueItem]));

    const pkg = buildDataSafetyExportPackage({
      exportedAt: '2026-06-16T00:00:00.000Z',
      ownerUserId: 'user-1',
      app: { appVersion: '1.0.0', syncProtocolVersion: 1, deploymentEpoch: 0 },
      localData: {
        projects: [incomingProject],
        tasks: [incomingTask],
        connections: [connection],
        syncCursors: [cursor],
        meta,
      },
      localState: {
        retryQueue: [],
        actionQueue: [malformedActionQueueItem],
        deadLetters: [],
        conflicts: [],
        taskTombstones: {},
        connectionTombstones: [],
      },
      syncSnapshot: {
        syncState: { lastSyncTime: meta.lastSyncTime, pendingCount: 1 },
        projectCursors: [{ projectId: 'project-1', userId: 'user-1', cursor: cursor.cursor }],
        queueCounts: { retryQueue: 0, actionQueue: 1, deadLetters: 0 },
      },
      replayLog: [],
      lastWriteExplain: null,
    });

    const result = await restoreDataSafetyPackageToIndexedDb(db, pkg);

    expect(result.success).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      'localState.actionQueue[0].payload must be an object',
      'localState.actionQueue[0].timestamp must be a finite number',
      'localState.actionQueue[0].retryCount must be a non-negative integer',
    ]));
    await expect(getAllStoreValues<Project>(db, DB_CONFIG.stores.projects)).resolves.toEqual([oldProject]);
    await expect(getAllStoreValues<Task>(db, DB_CONFIG.stores.tasks)).resolves.toEqual([oldTask]);
    await expect(getStoreValue(queueBackupDb, 'queue-backup', 'queue-backup:user-1')).resolves.toMatchObject({
      actions: [oldActionQueueItem],
    });
    expect(JSON.parse(localStorage.getItem('nanoflow.action-queue.user-1') ?? '[]')).toEqual([oldActionQueueItem]);
  });

  it('rejects malformed RetryQueue items before mutation', async () => {
    const oldProject = { ...project, name: 'old local project before malformed retry restore' };
    const incomingProject = { ...project, name: 'incoming project with malformed retry' };
    const oldRetryQueueItem = {
      id: 'old-retry-before-malformed-restore',
      operationId: createDerivedSyncOperationId(
        'old-retry-before-malformed-restore',
        LEGACY_RETRY_QUEUE_OPERATION_ID_PURPOSE,
      ),
      type: 'task',
      operation: 'upsert',
      data: { id: 'old-task' },
      retryCount: 2,
      createdAt: 1781539100000,
      sourceUserId: 'user-1',
      projectId: 'project-1',
    };
    const malformedRetryQueueItem = {
      id: 'malformed-retry-must-not-be-restored',
      operationId: 'legacy-malformed-retry-operation',
      type: 'task',
      data: { id: 'task-1' },
    } as unknown as DataSafetyExportPackage['localState']['retryQueue'][number];

    await putStoreValue(db, DB_CONFIG.stores.projects, oldProject);
    retryDb = await openRetryQueueDatabase();
    await putStoreValue(retryDb, 'offline_mutation_queue', oldRetryQueueItem);
    localStorage.setItem('nanoflow.retry-queue', JSON.stringify({
      version: 1,
      items: [oldRetryQueueItem],
      savedAt: 1781539100000,
    }));

    const pkg = buildDataSafetyExportPackage({
      exportedAt: '2026-06-16T00:00:00.000Z',
      ownerUserId: 'user-1',
      app: { appVersion: '1.0.0', syncProtocolVersion: 1, deploymentEpoch: 0 },
      localData: {
        projects: [incomingProject],
        tasks: [task],
        connections: [connection],
        syncCursors: [cursor],
        meta,
      },
      localState: {
        retryQueue: [malformedRetryQueueItem],
        actionQueue: [],
        deadLetters: [],
        conflicts: [],
        taskTombstones: {},
        connectionTombstones: [],
      },
      syncSnapshot: {
        syncState: { lastSyncTime: meta.lastSyncTime, pendingCount: 1 },
        projectCursors: [{ projectId: 'project-1', userId: 'user-1', cursor: cursor.cursor }],
        queueCounts: { retryQueue: 1, actionQueue: 0, deadLetters: 0 },
      },
      replayLog: [],
      lastWriteExplain: null,
    });

    const result = await restoreDataSafetyPackageToIndexedDb(db, pkg);

    expect(result.success).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      'localState.retryQueue[0].sourceUserId is required',
      'localState.retryQueue[0].operation is required',
      'localState.retryQueue[0].retryCount must be a non-negative integer',
      'localState.retryQueue[0].createdAt must be a finite number',
    ]));
    await expect(getAllStoreValues<Project>(db, DB_CONFIG.stores.projects)).resolves.toEqual([oldProject]);
    await expect(getAllStoreValues(retryDb, 'offline_mutation_queue')).resolves.toEqual([oldRetryQueueItem]);
    expect(JSON.parse(localStorage.getItem('nanoflow.retry-queue') ?? '{}')).toMatchObject({
      items: [oldRetryQueueItem],
    });
  });

  it('rejects malformed tombstones before mutation and keeps unsupported sections explicit', async () => {
    const oldProject = { ...project, name: 'old local project before malformed tombstone restore' };
    const incomingProject = { ...project, name: 'incoming project with malformed tombstones' };
    const oldTaskTombstonesRaw = JSON.stringify({
      'project-1': { 'old-task-tombstone': 100 },
    });
    const oldConnectionTombstonesRaw = JSON.stringify([
      { projectId: 'project-1', id: 'old-connection-tombstone', timestamp: 100 },
    ]);
    const oldConflictRaw = JSON.stringify({
      projectId: 'project-1',
      ownerUserId: 'user-1',
      localProject: project,
      conflictedAt: '2026-06-15T00:00:00.000Z',
      localVersion: 1,
      reason: 'field_conflict',
    });
    const oldOfflineSnapshotRaw = JSON.stringify({
      projects: [{ ...project, tasks: [task], connections: [connection] }],
      version: 2,
      ownerUserId: 'user-1',
      savedAt: '2026-06-15T00:00:00.000Z',
    });

    await putStoreValue(db, DB_CONFIG.stores.projects, oldProject);
    localStorage.setItem('nanoflow.local-tombstones', oldTaskTombstonesRaw);
    localStorage.setItem('nanoflow.local-connection-tombstones', oldConnectionTombstonesRaw);
    localStorage.setItem('nanoflow.conflict.user-1.project-1', oldConflictRaw);
    localStorage.setItem('nanoflow.offline-cache-v2.user-1', oldOfflineSnapshotRaw);

    const pkg = buildDataSafetyExportPackage({
      exportedAt: '2026-06-16T00:00:00.000Z',
      ownerUserId: 'user-1',
      app: { appVersion: '1.0.0', syncProtocolVersion: 1, deploymentEpoch: 0 },
      localData: {
        projects: [incomingProject],
        tasks: [task],
        connections: [connection],
        syncCursors: [cursor],
        meta,
      },
      localState: {
        retryQueue: [],
        actionQueue: [],
        deadLetters: [],
        conflicts: [{
          projectId: 'project-1',
          ownerUserId: 'user-2',
          localProject: { ...project, tasks: [task], connections: [connection] },
          conflictedAt: '2026-06-16T00:00:00.000Z',
          localVersion: 1,
          reason: 'field_conflict',
        }],
        taskTombstones: {
          'project-1': { 'task-deleted-offline': 'not-a-timestamp' },
        },
        connectionTombstones: [{
          projectId: 'project-1',
          id: '',
          timestamp: 200,
        }],
        offlineSnapshots: {
          localStorage: JSON.stringify({
            projects: [{ ...project, name: 'local mirror', tasks: [task], connections: [connection] }],
            version: 2,
            ownerUserId: 'user-1',
            savedAt: '2026-06-16T00:00:00.000Z',
          }),
          indexedDb: JSON.stringify({
            projects: [{ ...project, name: 'idb mirror', tasks: [task], connections: [connection] }],
            version: 2,
            ownerUserId: 'user-1',
            savedAt: '2026-06-16T00:00:00.000Z',
          }),
        },
      },
      syncSnapshot: {
        syncState: { lastSyncTime: meta.lastSyncTime, pendingCount: 0 },
        projectCursors: [{ projectId: 'project-1', userId: 'user-1', cursor: cursor.cursor }],
        queueCounts: { retryQueue: 0, actionQueue: 0, deadLetters: 0 },
      },
      replayLog: [],
      lastWriteExplain: null,
    });

    const result = await restoreDataSafetyPackageToIndexedDb(db, pkg);

    expect(result.success).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('localState.conflicts[0].ownerUserId does not match restore owner'),
      expect.stringContaining('localState.taskTombstones.project-1.task-deleted-offline is invalid'),
      expect.stringContaining('connectionTombstones[0].connectionId is invalid'),
      expect.stringContaining('localState.offlineSnapshots mirrors differ'),
    ]));
    await expect(getAllStoreValues<Project>(db, DB_CONFIG.stores.projects)).resolves.toEqual([oldProject]);
    expect(localStorage.getItem('nanoflow.local-tombstones')).toBe(oldTaskTombstonesRaw);
    expect(localStorage.getItem('nanoflow.local-connection-tombstones')).toBe(oldConnectionTombstonesRaw);
    expect(localStorage.getItem('nanoflow.conflict.user-1.project-1')).toBe(oldConflictRaw);
    expect(localStorage.getItem('nanoflow.offline-cache-v2.user-1')).toBe(oldOfflineSnapshotRaw);
    expect(localStorage.getItem(`${DATA_SAFETY_RESTORE_MARKER_STORAGE_KEY_PREFIX}.user-1`)).toBeNull();
  });

  it('fails and rolls back instead of silently filtering malformed dead-letter items during restore', async () => {
    const oldProject = { ...project, name: 'old local project before malformed dead-letter restore' };
    const incomingProject = { ...project, name: 'incoming project with malformed dead-letter' };
    const oldActionQueueItem = {
      id: 'old-action-before-malformed-dead-letter-restore',
      operationId: createDerivedSyncOperationId(
        'old-action-before-malformed-dead-letter-restore',
        LEGACY_ACTION_QUEUE_OPERATION_ID_PURPOSE,
      ),
      entityType: 'task',
      entityId: 'old-task',
      type: 'update',
      payload: { taskId: 'old-task', projectId: 'project-1' },
      retryCount: 1,
      timestamp: 1781539100000,
    };
    const oldDeadLetterItem = {
      action: oldActionQueueItem,
      failedAt: '2026-06-15T00:00:00.000Z',
      reason: 'old dead-letter must survive malformed restore',
    };
    const malformedDeadLetterItem = {
      action: {
        id: 'malformed-dead-letter-action',
        operationId: createDerivedSyncOperationId(
          'malformed-dead-letter-action',
          LEGACY_ACTION_QUEUE_OPERATION_ID_PURPOSE,
        ),
        entityType: 'task',
        entityId: 'task-1',
        type: 'update',
        payload: { taskId: 'task-1', projectId: 'project-1' },
        retryCount: 0,
        timestamp: 1781539200000,
      },
    } as unknown as DataSafetyExportPackage['localState']['deadLetters'][number];

    await putStoreValue(db, DB_CONFIG.stores.projects, oldProject);
    queueBackupDb = await openQueueBackupDatabase();
    await putStoreValue(queueBackupDb, 'queue-backup', {
      id: 'dead-letter-backup:user-1',
      ownerUserId: 'user-1',
      deadLetters: [oldDeadLetterItem],
      savedAt: '2026-06-15T00:00:00.000Z',
    });
    localStorage.setItem('nanoflow.dead-letter-queue.user-1', JSON.stringify([oldDeadLetterItem]));

    const pkg = buildDataSafetyExportPackage({
      exportedAt: '2026-06-16T00:00:00.000Z',
      ownerUserId: 'user-1',
      app: { appVersion: '1.0.0', syncProtocolVersion: 1, deploymentEpoch: 0 },
      localData: {
        projects: [incomingProject],
        tasks: [task],
        connections: [connection],
        syncCursors: [cursor],
        meta,
      },
      localState: {
        retryQueue: [],
        actionQueue: [],
        deadLetters: [malformedDeadLetterItem],
        conflicts: [],
        taskTombstones: {},
        connectionTombstones: [],
      },
      syncSnapshot: {
        syncState: { lastSyncTime: meta.lastSyncTime, pendingCount: 1 },
        projectCursors: [{ projectId: 'project-1', userId: 'user-1', cursor: cursor.cursor }],
        queueCounts: { retryQueue: 0, actionQueue: 0, deadLetters: 1 },
      },
      replayLog: [],
      lastWriteExplain: null,
    });

    const result = await restoreDataSafetyPackageToIndexedDb(db, pkg);

    expect(result.success).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('unrestorable deadLetter item'),
      expect.stringContaining('malformed-dead-letter-action'),
    ]));
    await expect(getAllStoreValues<Project>(db, DB_CONFIG.stores.projects)).resolves.toEqual([oldProject]);
    await expect(getStoreValue(queueBackupDb, 'queue-backup', 'dead-letter-backup:user-1')).resolves.toMatchObject({
      deadLetters: [oldDeadLetterItem],
    });
    expect(JSON.parse(localStorage.getItem('nanoflow.dead-letter-queue.user-1') ?? '[]')).toEqual([oldDeadLetterItem]);
  });
  });
}

function buildRestoreMarker(rollbackProject: Project): Record<string, unknown> {
  return {
    schemaVersion: 1,
    ownerUserId: 'user-1',
    createdAt: '2026-06-16T00:00:00.000Z',
    primaryStoreSnapshot: {
      projects: [rollbackProject],
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
    },
  };
}
