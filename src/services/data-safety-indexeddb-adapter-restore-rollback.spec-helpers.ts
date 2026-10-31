import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Project, Task } from '../models';
import { DB_CONFIG } from '../app/core/state/persistence/indexeddb.service';
import {
  recoverInterruptedDataSafetyRestoreFromIndexedDb,
  restoreDataSafetyPackageToIndexedDb,
} from './data-safety-indexeddb-adapter';
import { readDataSafetyRestoreMarker } from './data-safety-indexeddb-local-state';
import {
  buildDataSafetyExportPackage,
  type DataSafetyEntityRecord,
} from './data-safety-package';
import { createDerivedSyncOperationId } from '../utils/sync-operation-id';
import {
  LEGACY_ACTION_QUEUE_OPERATION_ID_PURPOSE,
  LEGACY_RETRY_QUEUE_OPERATION_ID_PURPOSE,
  DATA_SAFETY_RESTORE_MARKER_STORAGE_KEY_PREFIX,
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

export function registerDataSafetyRestoreRollbackSpecs(): void {
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

  it('does not recover an unexpired restore marker owned by another run', async () => {
    const markerKey = `${DATA_SAFETY_RESTORE_MARKER_STORAGE_KEY_PREFIX}.user-1`;
    const currentProject = { ...project, name: 'current project while another restore is active' };
    const rollbackProject = { ...project, name: 'rollback snapshot from the active restore' };
    await putStoreValue(db, DB_CONFIG.stores.projects, currentProject);
    const marker = {
      schemaVersion: 1,
      ownerUserId: 'user-1',
      runId: 'restore-run-a',
      createdAt: new Date(Date.now() - 1_000).toISOString(),
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      primaryStoreSnapshot: {
        projects: [rollbackProject],
        tasks: [],
        connections: [],
        syncCursors: [],
        meta: null,
      },
      localStateSnapshot: {
        retryQueueIndexedDbItems: null,
        retryQueueLocalStorageValue: null,
        actionQueueBackupRecord: null,
        actionQueueLocalStorageValue: null,
        deadLetterBackupRecord: null,
        deadLetterLocalStorageValue: null,
        auditLocalStorageValue: null,
      },
    };
    localStorage.setItem(markerKey, JSON.stringify(marker));

    const result = await recoverInterruptedDataSafetyRestoreFromIndexedDb(db, 'user-1');

    expect(result.recovered).toBe(false);
    expect(result.errors).toEqual([expect.stringContaining('restore already in progress')]);
    await expect(getAllStoreValues<Project>(db, DB_CONFIG.stores.projects)).resolves.toEqual([
      currentProject,
    ]);
    expect(JSON.parse(localStorage.getItem(markerKey) ?? 'null')).toEqual({
      schemaVersion: 2,
      storage: 'indexeddb-journal',
      markerKind: 'full-restore',
      ownerUserId: 'user-1',
      runId: marker.runId,
    });
    await expect(readDataSafetyRestoreMarker('user-1')).resolves.toEqual(marker);
  });

  it('claims an expired marker and stops recovery after a newer run takes ownership', async () => {
    const markerKey = `${DATA_SAFETY_RESTORE_MARKER_STORAGE_KEY_PREFIX}.user-1`;
    const currentProject = { ...project, name: 'current project from the newer restore' };
    const rollbackProject = { ...project, name: 'rollback snapshot from the expired marker' };
    await putStoreValue(db, DB_CONFIG.stores.projects, currentProject);
    const expiredMarker = {
      schemaVersion: 1,
      ownerUserId: 'user-1',
      runId: 'expired-restore-run-a',
      createdAt: new Date(Date.now() - 120_000).toISOString(),
      leaseExpiresAt: new Date(Date.now() - 60_000).toISOString(),
      primaryStoreSnapshot: {
        projects: [rollbackProject], tasks: [], connections: [], syncCursors: [], meta: null,
      },
      localStateSnapshot: {
        retryQueueIndexedDbItems: null,
        retryQueueLocalStorageValue: null,
        actionQueueBackupRecord: null,
        actionQueueLocalStorageValue: null,
        deadLetterBackupRecord: null,
        deadLetterLocalStorageValue: null,
        auditLocalStorageValue: JSON.stringify({ replayLog: [], lastWriteExplain: null }),
      },
    };
    localStorage.setItem(markerKey, JSON.stringify(expiredMarker));
    let claimedMarker: Record<string, unknown> | null = null;
    let newerMarkerRaw: string | null = null;
    const originalSetItem = localStorage.setItem.bind(localStorage);
    vi.spyOn(localStorage, 'setItem').mockImplementation(function (
      this: typeof localStorage,
      key: string,
      value: string,
    ) {
      originalSetItem(key, value);
      if (key !== 'nanoflow.data-safety-audit.user-1' || claimedMarker !== null) return;

      claimedMarker = JSON.parse(localStorage.getItem(markerKey) ?? '{}') as Record<string, unknown>;
      newerMarkerRaw = JSON.stringify({
        ...claimedMarker,
        runId: 'restore-run-b',
        createdAt: new Date().toISOString(),
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      originalSetItem(markerKey, newerMarkerRaw);
    });

    const result = await recoverInterruptedDataSafetyRestoreFromIndexedDb(db, 'user-1');

    expect(claimedMarker?.['runId']).not.toBe(expiredMarker.runId);
    expect(result.recovered).toBe(false);
    expect(result.errors).toEqual([expect.stringContaining('restore marker ownership lost')]);
    await expect(getAllStoreValues<Project>(db, DB_CONFIG.stores.projects)).resolves.toEqual([
      currentProject,
    ]);
    expect(localStorage.getItem(markerKey)).toBe(newerMarkerRaw);
  });

  it('does not clear a newer restore marker when an older restore completes late', async () => {
    const markerKey = `${DATA_SAFETY_RESTORE_MARKER_STORAGE_KEY_PREFIX}.user-1`;
    const incomingProject = { ...project, name: 'incoming project from the older restore' };
    const pkg = buildMinimalRestorePackage(incomingProject);
    let newerMarkerRaw: string | null = null;
    const originalSetItem = localStorage.setItem.bind(localStorage);
    vi.spyOn(localStorage, 'setItem').mockImplementation(function (
      this: typeof localStorage,
      key: string,
      value: string,
    ) {
      originalSetItem(key, value);
      if (key !== 'nanoflow.data-safety-audit.user-1' || newerMarkerRaw !== null) return;

      const activeMarker = JSON.parse(localStorage.getItem(markerKey) ?? '{}') as Record<string, unknown>;
      newerMarkerRaw = JSON.stringify({
        ...activeMarker,
        runId: 'restore-run-b',
        createdAt: new Date().toISOString(),
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      originalSetItem(markerKey, newerMarkerRaw);
    });

    const result = await restoreDataSafetyPackageToIndexedDb(db, pkg);

    expect(result.success).toBe(false);
    expect(result.errors).toEqual([expect.stringContaining('restore marker ownership lost')]);
    expect(localStorage.getItem(markerKey)).toBe(newerMarkerRaw);
  });

  it('does not roll back a newer restore when an older restore fails late', async () => {
    const markerKey = `${DATA_SAFETY_RESTORE_MARKER_STORAGE_KEY_PREFIX}.user-1`;
    const oldProject = { ...project, name: 'rollback snapshot from the older restore' };
    const incomingProject = { ...project, name: 'state retained for the newer restore' };
    await putStoreValue(db, DB_CONFIG.stores.projects, oldProject);
    const pkg = buildMinimalRestorePackage(incomingProject);
    let newerMarkerRaw: string | null = null;
    const originalSetItem = localStorage.setItem.bind(localStorage);
    vi.spyOn(localStorage, 'setItem').mockImplementation(function (
      this: typeof localStorage,
      key: string,
      value: string,
    ) {
      if (key !== 'nanoflow.data-safety-audit.user-1' || newerMarkerRaw !== null) {
        return originalSetItem(key, value);
      }

      const activeMarker = JSON.parse(localStorage.getItem(markerKey) ?? '{}') as Record<string, unknown>;
      newerMarkerRaw = JSON.stringify({
        ...activeMarker,
        runId: 'restore-run-b',
        createdAt: new Date().toISOString(),
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      originalSetItem(markerKey, newerMarkerRaw);
      throw new Error('simulated older restore failure after ownership changed');
    });

    const result = await restoreDataSafetyPackageToIndexedDb(db, pkg);

    expect(result.success).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('data-safety audit persistence failed'),
      expect.stringContaining('restore marker ownership lost'),
    ]));
    await expect(getAllStoreValues<Project>(db, DB_CONFIG.stores.projects)).resolves.toEqual([
      incomingProject,
    ]);
    expect(localStorage.getItem(markerKey)).toBe(newerMarkerRaw);
  });

  it('does not replace primary stores when local-state restore fails', async () => {
    const oldProject = { ...project, name: 'old local project' };
    const oldTask = { ...task, title: 'old local task' };
    const incomingProject = { ...project, name: 'incoming restored project' };
    const incomingTask = { ...task, title: 'incoming restored task' };
    await putStoreValue(db, DB_CONFIG.stores.projects, oldProject);
    await putStoreValue(db, DB_CONFIG.stores.tasks, oldTask);
    const oldRetryQueueItem = {
      id: 'old-retry-before-restore',
      operationId: createDerivedSyncOperationId(
        'old-retry-before-restore',
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
    const oldActionQueueItem = {
      id: 'old-action-before-restore',
      operationId: createDerivedSyncOperationId(
        'old-action-before-restore',
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
      reason: 'old dead letter must survive failed restore',
    };
    retryDb = await openRetryQueueDatabase();
    await putStoreValue(retryDb, 'offline_mutation_queue', oldRetryQueueItem);
    localStorage.setItem('nanoflow.retry-queue', JSON.stringify({
      version: 1,
      items: [oldRetryQueueItem],
      savedAt: 1781539100000,
    }));
    queueBackupDb = await openQueueBackupDatabase();
    await putStoreValue(queueBackupDb, 'queue-backup', {
      id: 'queue-backup:user-1',
      ownerUserId: 'user-1',
      actions: [oldActionQueueItem],
      savedAt: '2026-06-15T00:00:00.000Z',
    });
    await putStoreValue(queueBackupDb, 'queue-backup', {
      id: 'dead-letter-backup:user-1',
      ownerUserId: 'user-1',
      deadLetters: [oldDeadLetterItem],
      savedAt: '2026-06-15T00:00:00.000Z',
    });
    localStorage.setItem('nanoflow.action-queue.user-1', JSON.stringify([oldActionQueueItem]));
    localStorage.setItem('nanoflow.dead-letter-queue.user-1', JSON.stringify([oldDeadLetterItem]));
    localStorage.setItem('nanoflow.data-safety-audit.user-1', JSON.stringify({
      replayLog: [{ operationId: 'old-audit' }],
      lastWriteExplain: null,
    }));

    const actionQueueItem = {
      id: 'action-atomic-restore',
      operationId: createDerivedSyncOperationId(
        'action-atomic-restore',
        LEGACY_ACTION_QUEUE_OPERATION_ID_PURPOSE,
      ),
      entityType: 'task',
      entityId: 'task-1',
      type: 'update',
      payload: { taskId: 'task-1', projectId: 'project-1', task: incomingTask },
      retryCount: 0,
      timestamp: 1781539200000,
    };
    const incomingRetryQueueItem = {
      id: 'incoming-retry-atomic-restore',
      operationId: createDerivedSyncOperationId(
        'incoming-retry-atomic-restore',
        LEGACY_RETRY_QUEUE_OPERATION_ID_PURPOSE,
      ),
      type: 'task',
      operation: 'upsert',
      data: { ...incomingTask, id: 'incoming-task' },
      retryCount: 0,
      createdAt: 1781539200000,
      sourceUserId: 'user-1',
      projectId: 'project-1',
    };
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
        retryQueue: [incomingRetryQueueItem],
        actionQueue: [actionQueueItem],
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
    const originalSetItem = localStorage.setItem.bind(localStorage);
    vi.spyOn(localStorage, 'setItem').mockImplementation(function (
      this: typeof localStorage,
      key: string,
      value: string,
    ) {
      if (key === 'nanoflow.action-queue.user-1') {
        throw new Error('simulated action queue local-state restore failure');
      }
      return originalSetItem(key, value);
    });

    const result = await restoreDataSafetyPackageToIndexedDb(db, pkg);

    expect(result.success).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('simulated action queue local-state restore failure'),
    ]));
    await expect(getAllStoreValues<Project>(db, DB_CONFIG.stores.projects)).resolves.toEqual([oldProject]);
    await expect(getAllStoreValues<Task>(db, DB_CONFIG.stores.tasks)).resolves.toEqual([oldTask]);
    await expect(getAllStoreValues(retryDb, 'offline_mutation_queue')).resolves.toEqual([oldRetryQueueItem]);
    await expect(getAllStoreValues(retryDb, 'offline_mutation_queue')).resolves.not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: incomingRetryQueueItem.id })]),
    );
    expect(JSON.parse(localStorage.getItem('nanoflow.retry-queue') ?? '{}')).toMatchObject({
      items: [oldRetryQueueItem],
    });
    await expect(getStoreValue(queueBackupDb, 'queue-backup', 'queue-backup:user-1')).resolves.toMatchObject({
      actions: [oldActionQueueItem],
    });
    expect(JSON.parse(localStorage.getItem('nanoflow.action-queue.user-1') ?? '[]')).toEqual([oldActionQueueItem]);
    await expect(getStoreValue(queueBackupDb, 'queue-backup', 'dead-letter-backup:user-1')).resolves.toMatchObject({
      deadLetters: [oldDeadLetterItem],
    });
    expect(JSON.parse(localStorage.getItem('nanoflow.dead-letter-queue.user-1') ?? '[]')).toEqual([oldDeadLetterItem]);
    expect(JSON.parse(localStorage.getItem('nanoflow.data-safety-audit.user-1') ?? '{}')).toMatchObject({
      replayLog: [{ operationId: 'old-audit' }],
    });
  });

  it('rejects a RetryQueue operationId already owned by another user and rolls back', async () => {
    const sharedOperationId = createDerivedSyncOperationId('shared-cross-owner-operation', 'test');
    const ownerBItem = {
      id: 'owner-b-local-id',
      operationId: sharedOperationId,
      type: 'task',
      operation: 'upsert',
      data: { id: 'owner-b-task' },
      retryCount: 1,
      createdAt: 1781539100000,
      sourceUserId: 'user-2',
      projectId: 'owner-b-project',
    };
    const incomingOwnerAItem = {
      ...ownerBItem,
      id: 'owner-a-different-local-id',
      data: { ...task, id: 'owner-a-task' },
      retryCount: 0,
      createdAt: 1781539200000,
      sourceUserId: 'user-1',
      projectId: 'project-1',
    };
    retryDb = await openRetryQueueDatabase();
    await putStoreValue(retryDb, 'offline_mutation_queue', ownerBItem);
    localStorage.setItem('nanoflow.retry-queue', JSON.stringify({
      version: 1,
      items: [ownerBItem],
      savedAt: ownerBItem.createdAt,
    }));
    const pkg = buildDataSafetyExportPackage({
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
        retryQueue: [incomingOwnerAItem],
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
    expect(result.errors.join('\n')).toContain('operationId conflicts with another owner');
    await expect(getAllStoreValues(retryDb, 'offline_mutation_queue')).resolves.toEqual([ownerBItem]);
    expect(JSON.parse(localStorage.getItem('nanoflow.retry-queue') ?? '{}')).toMatchObject({
      items: [ownerBItem],
    });
  });

  it('rolls back durable queue mirrors when dead-letter localStorage restore fails', async () => {
    const oldRetryQueueItem = {
      id: 'old-retry-before-dead-letter-failure',
      operationId: createDerivedSyncOperationId(
        'old-retry-before-dead-letter-failure',
        LEGACY_RETRY_QUEUE_OPERATION_ID_PURPOSE,
      ),
      type: 'task',
      operation: 'upsert',
      data: { id: 'old-task' },
      retryCount: 1,
      createdAt: 1781539100000,
      sourceUserId: 'user-1',
      projectId: 'project-1',
    };
    const oldActionQueueItem = {
      id: 'old-action-before-dead-letter-failure',
      operationId: createDerivedSyncOperationId(
        'old-action-before-dead-letter-failure',
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
      reason: 'old dead letter must survive failed dead-letter mirror restore',
    };
    const incomingRetryQueueItem = {
      id: 'incoming-retry-before-dead-letter-failure',
      operationId: createDerivedSyncOperationId(
        'incoming-retry-before-dead-letter-failure',
        LEGACY_RETRY_QUEUE_OPERATION_ID_PURPOSE,
      ),
      type: 'task',
      operation: 'upsert',
      data: { ...task, id: 'incoming-task' },
      retryCount: 0,
      createdAt: 1781539200000,
      sourceUserId: 'user-1',
      projectId: 'project-1',
    };
    const incomingActionQueueItem = {
      id: 'incoming-action-before-dead-letter-failure',
      operationId: createDerivedSyncOperationId(
        'incoming-action-before-dead-letter-failure',
        LEGACY_ACTION_QUEUE_OPERATION_ID_PURPOSE,
      ),
      entityType: 'task',
      entityId: 'task-1',
      type: 'update',
      payload: { taskId: 'task-1', projectId: 'project-1', task },
      retryCount: 0,
      timestamp: 1781539200000,
    };
    const incomingDeadLetterItem = {
      action: incomingActionQueueItem,
      failedAt: '2026-06-16T00:00:00.000Z',
      reason: 'incoming dead letter must be rolled back',
    };

    retryDb = await openRetryQueueDatabase();
    await putStoreValue(retryDb, 'offline_mutation_queue', oldRetryQueueItem);
    localStorage.setItem('nanoflow.retry-queue', JSON.stringify({
      version: 1,
      items: [oldRetryQueueItem],
      savedAt: 1781539100000,
    }));
    queueBackupDb = await openQueueBackupDatabase();
    await putStoreValue(queueBackupDb, 'queue-backup', {
      id: 'queue-backup:user-1',
      ownerUserId: 'user-1',
      actions: [oldActionQueueItem],
      savedAt: '2026-06-15T00:00:00.000Z',
    });
    await putStoreValue(queueBackupDb, 'queue-backup', {
      id: 'dead-letter-backup:user-1',
      ownerUserId: 'user-1',
      deadLetters: [oldDeadLetterItem],
      savedAt: '2026-06-15T00:00:00.000Z',
    });
    localStorage.setItem('nanoflow.action-queue.user-1', JSON.stringify([oldActionQueueItem]));
    localStorage.setItem('nanoflow.dead-letter-queue.user-1', JSON.stringify([oldDeadLetterItem]));

    const pkg = buildDataSafetyExportPackage({
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
        retryQueue: [incomingRetryQueueItem],
        actionQueue: [incomingActionQueueItem],
        deadLetters: [incomingDeadLetterItem],
        conflicts: [],
        taskTombstones: {},
        connectionTombstones: [],
      },
      syncSnapshot: {
        syncState: { lastSyncTime: meta.lastSyncTime, pendingCount: 3 },
        projectCursors: [{ projectId: 'project-1', userId: 'user-1', cursor: cursor.cursor }],
        queueCounts: { retryQueue: 1, actionQueue: 1, deadLetters: 1 },
      },
      replayLog: [],
      lastWriteExplain: null,
    });
    const originalSetItem = localStorage.setItem.bind(localStorage);
    vi.spyOn(localStorage, 'setItem').mockImplementation(function (
      this: typeof localStorage,
      key: string,
      value: string,
    ) {
      if (key === 'nanoflow.dead-letter-queue.user-1') {
        throw new Error('simulated dead-letter local-state restore failure');
      }
      return originalSetItem(key, value);
    });

    const result = await restoreDataSafetyPackageToIndexedDb(db, pkg);

    expect(result.success).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('simulated dead-letter local-state restore failure'),
    ]));
    await expect(getAllStoreValues(retryDb, 'offline_mutation_queue')).resolves.toEqual([oldRetryQueueItem]);
    expect(JSON.parse(localStorage.getItem('nanoflow.retry-queue') ?? '{}')).toMatchObject({
      items: [oldRetryQueueItem],
    });
    await expect(getStoreValue(queueBackupDb, 'queue-backup', 'queue-backup:user-1')).resolves.toMatchObject({
      actions: [oldActionQueueItem],
    });
    expect(JSON.parse(localStorage.getItem('nanoflow.action-queue.user-1') ?? '[]')).toEqual([oldActionQueueItem]);
    await expect(getStoreValue(queueBackupDb, 'queue-backup', 'dead-letter-backup:user-1')).resolves.toMatchObject({
      deadLetters: [oldDeadLetterItem],
    });
    expect(JSON.parse(localStorage.getItem('nanoflow.dead-letter-queue.user-1') ?? '[]')).toEqual([oldDeadLetterItem]);
  });

  it('treats data-safety audit persistence failure as a failed local-state restore', async () => {
    const oldRetryQueueItem = {
      id: 'old-retry-before-audit-failure',
      operationId: createDerivedSyncOperationId(
        'old-retry-before-audit-failure',
        LEGACY_RETRY_QUEUE_OPERATION_ID_PURPOSE,
      ),
      type: 'task',
      operation: 'upsert',
      data: { id: 'old-task' },
      retryCount: 1,
      createdAt: 1781539100000,
      sourceUserId: 'user-1',
      projectId: 'project-1',
    };
    const oldActionQueueItem = {
      id: 'old-action-before-audit-failure',
      operationId: createDerivedSyncOperationId(
        'old-action-before-audit-failure',
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
      reason: 'old dead letter must survive failed audit restore',
    };
    const incomingRetryQueueItem = {
      id: 'incoming-retry-before-audit-failure',
      operationId: createDerivedSyncOperationId(
        'incoming-retry-before-audit-failure',
        LEGACY_RETRY_QUEUE_OPERATION_ID_PURPOSE,
      ),
      type: 'task',
      operation: 'upsert',
      data: { ...task, id: 'incoming-task' },
      retryCount: 0,
      createdAt: 1781539200000,
      sourceUserId: 'user-1',
      projectId: 'project-1',
    };
    const incomingActionQueueItem = {
      id: 'incoming-action-before-audit-failure',
      operationId: createDerivedSyncOperationId(
        'incoming-action-before-audit-failure',
        LEGACY_ACTION_QUEUE_OPERATION_ID_PURPOSE,
      ),
      entityType: 'task',
      entityId: 'task-1',
      type: 'update',
      payload: { taskId: 'task-1', projectId: 'project-1', task },
      retryCount: 0,
      timestamp: 1781539200000,
    };
    const incomingDeadLetterItem = {
      action: incomingActionQueueItem,
      failedAt: '2026-06-16T00:00:00.000Z',
      reason: 'incoming dead letter must be rolled back after audit failure',
    };
    const oldTaskTombstonesRaw = JSON.stringify({
      'project-1': { 'old-task-tombstone': 1781539100000 },
      'project-2': { 'preserved-task-tombstone': 1781539050000 },
    });
    const oldConnectionTombstonesRaw = JSON.stringify([
      { projectId: 'project-1', id: 'old-connection-tombstone', timestamp: 1781539100000 },
      { projectId: 'project-2', id: 'preserved-connection-tombstone', timestamp: 1781539050000 },
    ]);

    retryDb = await openRetryQueueDatabase();
    await putStoreValue(retryDb, 'offline_mutation_queue', oldRetryQueueItem);
    localStorage.setItem('nanoflow.retry-queue', JSON.stringify({
      version: 1,
      items: [oldRetryQueueItem],
      savedAt: 1781539100000,
    }));
    queueBackupDb = await openQueueBackupDatabase();
    await putStoreValue(queueBackupDb, 'queue-backup', {
      id: 'queue-backup:user-1',
      ownerUserId: 'user-1',
      actions: [oldActionQueueItem],
      savedAt: '2026-06-15T00:00:00.000Z',
    });
    await putStoreValue(queueBackupDb, 'queue-backup', {
      id: 'dead-letter-backup:user-1',
      ownerUserId: 'user-1',
      deadLetters: [oldDeadLetterItem],
      savedAt: '2026-06-15T00:00:00.000Z',
    });
    localStorage.setItem('nanoflow.action-queue.user-1', JSON.stringify([oldActionQueueItem]));
    localStorage.setItem('nanoflow.dead-letter-queue.user-1', JSON.stringify([oldDeadLetterItem]));
    localStorage.setItem('nanoflow.data-safety-audit.user-1', JSON.stringify({
      replayLog: [{ operationId: 'old-audit' }],
      lastWriteExplain: null,
    }));
    localStorage.setItem('nanoflow.local-tombstones', oldTaskTombstonesRaw);
    localStorage.setItem('nanoflow.local-connection-tombstones', oldConnectionTombstonesRaw);

    const pkg = buildDataSafetyExportPackage({
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
        retryQueue: [incomingRetryQueueItem],
        actionQueue: [incomingActionQueueItem],
        deadLetters: [incomingDeadLetterItem],
        conflicts: [],
        taskTombstones: {
          'project-1': { 'incoming-task-tombstone': 1781539200000 },
        },
        connectionTombstones: [{
          projectId: 'project-1',
          id: 'incoming-connection-tombstone',
          timestamp: 1781539200000,
        }],
      },
      syncSnapshot: {
        syncState: { lastSyncTime: meta.lastSyncTime, pendingCount: 3 },
        projectCursors: [{ projectId: 'project-1', userId: 'user-1', cursor: cursor.cursor }],
        queueCounts: { retryQueue: 1, actionQueue: 1, deadLetters: 1 },
      },
      replayLog: [],
      lastWriteExplain: null,
    });
    const originalSetItem = localStorage.setItem.bind(localStorage);
    vi.spyOn(localStorage, 'setItem').mockImplementation(function (
      this: typeof localStorage,
      key: string,
      value: string,
    ) {
      if (key === 'nanoflow.data-safety-audit.user-1') {
        throw new Error('simulated audit persistence failure');
      }
      return originalSetItem(key, value);
    });

    const result = await restoreDataSafetyPackageToIndexedDb(db, pkg);

    expect(result.success).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('data-safety audit persistence failed'),
    ]));
    await expect(getAllStoreValues(retryDb, 'offline_mutation_queue')).resolves.toEqual([oldRetryQueueItem]);
    expect(JSON.parse(localStorage.getItem('nanoflow.retry-queue') ?? '{}')).toMatchObject({
      items: [oldRetryQueueItem],
    });
    await expect(getStoreValue(queueBackupDb, 'queue-backup', 'queue-backup:user-1')).resolves.toMatchObject({
      actions: [oldActionQueueItem],
    });
    expect(JSON.parse(localStorage.getItem('nanoflow.action-queue.user-1') ?? '[]')).toEqual([oldActionQueueItem]);
    await expect(getStoreValue(queueBackupDb, 'queue-backup', 'dead-letter-backup:user-1')).resolves.toMatchObject({
      deadLetters: [oldDeadLetterItem],
    });
    expect(JSON.parse(localStorage.getItem('nanoflow.dead-letter-queue.user-1') ?? '[]')).toEqual([oldDeadLetterItem]);
    expect(JSON.parse(localStorage.getItem('nanoflow.data-safety-audit.user-1') ?? '{}')).toMatchObject({
      replayLog: [{ operationId: 'old-audit' }],
    });
    expect(localStorage.getItem('nanoflow.local-tombstones')).toBe(oldTaskTombstonesRaw);
    expect(localStorage.getItem('nanoflow.local-connection-tombstones')).toBe(oldConnectionTombstonesRaw);
  });
  });
}
