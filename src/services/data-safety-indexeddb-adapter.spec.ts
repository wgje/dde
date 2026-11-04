import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { set as setKeyvalValue } from 'idb-keyval';

import type { Connection, Project, Task } from '../models';
import { PARKING_CONFIG } from '../config/parking.config';
import { DB_CONFIG } from '../app/core/state/persistence/indexeddb.service';
import { deleteRawIndexedDbDatabase } from '../app/core/state/persistence/backup-transaction.helpers';
import {
  exportDataSafetyPackageFromIndexedDb,
  recoverInterruptedDataSafetyRestoreFromIndexedDb,
  restoreDataSafetyPackageToIndexedDb,
} from './data-safety-indexeddb-adapter';
import { restoreLaunchSnapshotRestoreSnapshot } from './data-safety-indexeddb-local-state-snapshot.helpers';
import {
  buildDataSafetyExportPackage,
  type DataSafetyExportPackage,
  type DataSafetyLastWriteExplain,
  type DataSafetyReplayEntry,
} from './data-safety-package';
import { createDerivedSyncOperationId } from '../utils/sync-operation-id';
import { registerDataSafetyMalformedRestoreSpecs } from './data-safety-indexeddb-adapter-malformed-restore.spec-helpers';
import { registerDataSafetyRestoreRollbackSpecs } from './data-safety-indexeddb-adapter-restore-rollback.spec-helpers';
import { registerDataSafetyRestoreMarkerRaceSpecs } from './data-safety-indexeddb-adapter-marker-race.spec-helpers';
import { registerDataSafetyRetryQueueRaceSpecs } from './data-safety-indexeddb-adapter-retry-queue-race.spec-helpers';
import { registerDataSafetyConflictRestoreSpecs } from './data-safety-indexeddb-adapter-conflict-restore.spec-helpers';
import {
  registerDataSafetyOfflineSnapshotRestoreSpecs,
} from './data-safety-indexeddb-adapter-offline-snapshot-restore.spec-helpers';
import {
  DATA_SAFETY_RESTORE_MARKER_STORAGE_KEY_PREFIX,
  LEGACY_ACTION_QUEUE_OPERATION_ID_PURPOSE,
  LEGACY_RETRY_QUEUE_OPERATION_ID_PURPOSE,
  cleanupDataSafetyAdapterStorage,
  cleanupInterruptedRestoreProjectLocalState,
  connection,
  createInterruptedDataSafetyRestoreFixture,
  cursor,
  getAllStoreValues,
  getStoreValue,
  meta,
  openQueueBackupDatabase,
  openRetryQueueDatabase,
  project,
  putStoreValue,
  readServiceSource,
  readInterruptedRestoreDockSnapshot,
  readInterruptedRestoreParkedTaskCache,
  resetDataSafetyAdapterStorage,
  seedInterruptedRestoreParkedTaskCache,
  task,
} from './data-safety-indexeddb-adapter.spec-helpers';

describe('data-safety IndexedDB adapter', () => {
  let db: IDBDatabase;
  let retryDb: IDBDatabase | null = null;
  let queueBackupDb: IDBDatabase | null = null;

  it('keeps local-state restore internals behind the local-state adapter helper', () => {
    const adapterSource = readServiceSource('data-safety-indexeddb-adapter.ts');
    const localStateSource = readServiceSource('data-safety-indexeddb-local-state.ts');

    expect(adapterSource).toContain("from './data-safety-indexeddb-local-state'");
    expect(adapterSource).not.toContain('function restoreLocalState(');
    expect(adapterSource).not.toContain('function readLocalStateRestoreSnapshot(');
    expect(adapterSource).not.toContain('function restoreLocalStateSnapshot(');
    expect(adapterSource).not.toContain('function writeDataSafetyRestoreMarker(');
    expect(localStateSource).toContain('restoreLocalState');
    expect(localStateSource).toContain('readDataSafetyRestoreMarker');
  });

  it('preflights both launch slots before mutating either slot', async () => {
    const current = makeLaunchSnapshotFixture('user-1', '2026-07-27T00:00:00.000Z');
    const foreign = makeLaunchSnapshotFixture('user-2', '2026-07-27T00:01:00.000Z');
    const replacement = makeLaunchSnapshotFixture('user-1', '2026-07-27T00:02:00.000Z');
    localStorage.setItem('nanoflow.launch-snapshot.v1', current.v1);
    localStorage.setItem('nanoflow.launch-snapshot.v2', foreign.v2);
    const setItem = vi.spyOn(localStorage, 'setItem');

    await expect(restoreLaunchSnapshotRestoreSnapshot('user-1', {
      present: true,
      v1: replacement.v1,
      v2: replacement.v2,
    })).rejects.toThrow('belongs to another owner');

    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.getItem('nanoflow.launch-snapshot.v1')).toBe(current.v1);
    expect(localStorage.getItem('nanoflow.launch-snapshot.v2')).toBe(foreign.v2);
  });

  beforeEach(async () => {
    db = await resetDataSafetyAdapterStorage();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupDataSafetyAdapterStorage(db, retryDb, queueBackupDb);
    await cleanupInterruptedRestoreProjectLocalState();
    retryDb = null;
    queueBackupDb = null;
  });

  it('exports a local data-safety package from IndexedDB with sync snapshot and audit metadata', async () => {
    await putStoreValue(db, DB_CONFIG.stores.projects, project);
    await putStoreValue(db, DB_CONFIG.stores.tasks, task);
    await putStoreValue(db, DB_CONFIG.stores.connections, connection);
    await putStoreValue(db, DB_CONFIG.stores.syncCursors, cursor);
    await putStoreValue(db, DB_CONFIG.stores.meta, meta);

    const pkg = await exportDataSafetyPackageFromIndexedDb(db, {
      exportedAt: '2026-06-16T00:00:00.000Z',
      ownerUserId: 'user-1',
      app: { appVersion: '1.0.0', syncProtocolVersion: 1, deploymentEpoch: 0 },
      retryQueue: [{ id: 'retry-1', operationId: 'op-1', type: 'task', operation: 'upsert', data: { id: 'task-1' }, retryCount: 0, createdAt: 1781539200000, sourceUserId: 'user-1' }],
      actionQueue: [{ id: 'action-1', operationId: 'op-2', entityType: 'task', entityId: 'task-1', type: 'update', payload: { taskId: 'task-1', projectId: 'project-1' }, retryCount: 0, timestamp: 1781539200000 }],
      deadLetters: [],
      conflicts: [],
      taskTombstones: { 'project-1': ['task-deleted'] },
      connectionTombstones: ['connection-deleted'],
      replayLog: [],
      lastWriteExplain: null,
    });

    expect(pkg.localData.projects).toEqual([project]);
    expect(pkg.localData.tasks).toEqual([task]);
    expect(pkg.localData.connections).toEqual([connection]);
    expect(pkg.localData.syncCursors).toEqual([cursor]);
    expect(pkg.localData.meta).toEqual(meta);
    expect(pkg.localState.retryQueue).toHaveLength(1);
    expect(pkg.replayPlan.summary).toMatchObject({
      replayable: 2,
      inspectOnly: 0,
      retryQueue: 1,
      actionQueue: 1,
      auditLog: 0,
    });
    expect(pkg.replayPlan.steps.map(step => step.source)).toEqual(['actionQueue', 'retryQueue']);
    expect(pkg.syncSnapshot).toMatchObject({
      syncState: { lastSyncTime: '2026-01-02T00:00:00.000Z', pendingCount: 2 },
      queueCounts: { retryQueue: 1, actionQueue: 1, deadLetters: 0 },
      projectCursors: [{ projectId: 'project-1', userId: 'user-1', cursor: cursor.cursor }],
    });
    expect(pkg.integrity.tableCounts).toEqual({
      projects: 1,
      tasks: 1,
      connections: 1,
      syncCursors: 1,
      retryQueue: 1,
      actionQueue: 1,
      deadLetters: 0,
    });
  });

  it('skips malformed entity and cursor records during export', async () => {
    await putStoreValue(db, DB_CONFIG.stores.projects, project);
    await putStoreValue(db, DB_CONFIG.stores.tasks, task);
    await putStoreValue(db, DB_CONFIG.stores.connections, connection);
    await putStoreValue(db, DB_CONFIG.stores.syncCursors, cursor);
    await putStoreValue(db, DB_CONFIG.stores.projects, { id: 'project-malformed', name: 'valid id survives shape filter' });
    await putStoreValue(db, DB_CONFIG.stores.tasks, { id: 'task-malformed', content: 'valid id survives shape filter' });
    await putStoreValue(db, DB_CONFIG.stores.syncCursors, { key: 'project:user-1:project-malformed', cursor: null });

    const tx = db.transaction([
      DB_CONFIG.stores.projects,
      DB_CONFIG.stores.tasks,
      DB_CONFIG.stores.connections,
      DB_CONFIG.stores.syncCursors,
    ], 'readwrite');
    tx.objectStore(DB_CONFIG.stores.projects).put({ id: '', name: 'missing usable id' });
    tx.objectStore(DB_CONFIG.stores.tasks).put({ id: '', content: 'missing usable id' });
    tx.objectStore(DB_CONFIG.stores.connections).put({ id: '', source: 'task-1', target: 'task-1' });
    tx.objectStore(DB_CONFIG.stores.syncCursors).put({ key: '', cursor: {} });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
    });

    const pkg = await exportDataSafetyPackageFromIndexedDb(db, {
      exportedAt: '2026-06-16T00:00:00.000Z',
      ownerUserId: 'user-1',
      app: { appVersion: '1.0.0', syncProtocolVersion: 1, deploymentEpoch: 0 },
    });

    expect(pkg.localData.projects.map(item => item.id)).toEqual(['project-1', 'project-malformed']);
    expect(pkg.localData.tasks.map(item => item.id)).toEqual(['task-1', 'task-malformed']);
    expect(pkg.localData.connections.map(item => item.id)).toEqual(['connection-1']);
    expect(pkg.localData.syncCursors.map(item => item.key)).toEqual([
      'project:user-1:project-1',
      'project:user-1:project-malformed',
    ]);
  });

  it('validates before restore and keeps IndexedDB unchanged when the package is invalid', async () => {
    await putStoreValue(db, DB_CONFIG.stores.projects, project);
    const invalidPackage = { schemaVersion: '0.0.0' } as unknown as DataSafetyExportPackage;

    const result = await restoreDataSafetyPackageToIndexedDb(db, invalidPackage);

    expect(result.success).toBe(false);
    expect(result.errors).toContain('schemaVersion must be 1.0.0');
    await expect(getAllStoreValues<Project>(db, DB_CONFIG.stores.projects)).resolves.toEqual([project]);
  });

  it('restores a valid package into IndexedDB without ID remapping', async () => {
    await putStoreValue(db, DB_CONFIG.stores.projects, { ...project, name: 'stale local project' });
    const retryQueueItem = {
      id: 'retry-1',
      operationId: 'op-retry-1',
      type: 'task',
      operation: 'upsert',
      data: task,
      retryCount: 1,
      createdAt: 1781539200000,
      sourceUserId: 'user-1',
      projectId: 'project-1',
    };
    const actionQueueItem = {
      id: 'action-1',
      operationId: 'op-action-1',
      entityType: 'task',
      entityId: 'task-1',
      type: 'update',
      payload: { taskId: 'task-1', projectId: 'project-1', task },
      retryCount: 0,
      timestamp: 1781539200000,
    };
    const deadLetterItem = {
      action: actionQueueItem,
      failedAt: '2026-06-16T00:00:00.000Z',
      reason: 'test dead letter',
    };
    const existingReviewItem = {
      item: {
        id: 'retry-review-existing',
        operationId: 'operation-review-existing',
        sourceUserId: 'user-1',
        type: 'task',
        operation: 'upsert',
        data: { id: 'task-review-existing', content: 'existing review' },
        retryCount: 3,
        createdAt: 1781539100000,
      },
      reason: 'existing terminal outcome',
      quarantinedAt: '2026-06-15T23:58:00.000Z',
      ownerUserId: 'user-1',
    };
    const incomingReviewItem = {
      item: {
        id: 'retry-review-backup',
        operationId: 'operation-review-backup',
        sourceUserId: 'user-1',
        type: 'task',
        operation: 'upsert',
        data: { id: 'task-review-backup', content: 'backup review' },
        retryCount: 3,
        createdAt: 1781539200000,
      },
      reason: 'backup terminal outcome',
      quarantinedAt: '2026-06-16T00:00:00.000Z',
      ownerUserId: 'user-1',
    };
    const foreignReviewItem = {
      item: {
        id: 'retry-review-foreign',
        operationId: 'operation-review-foreign',
        sourceUserId: 'user-2',
        type: 'task',
        operation: 'upsert',
        data: { id: 'task-review-foreign', content: 'foreign review' },
        retryCount: 3,
        createdAt: 1781539200000,
      },
      reason: 'foreign owner review',
      quarantinedAt: '2026-06-16T00:00:00.000Z',
      ownerUserId: 'user-2',
    };
    localStorage.setItem(
      'nanoflow.retry-queue.legacy-review.user-1',
      JSON.stringify([existingReviewItem]),
    );
    localStorage.setItem(
      'nanoflow.retry-queue.legacy-review.user-2',
      JSON.stringify([foreignReviewItem]),
    );
    const replayEntry: DataSafetyReplayEntry = {
      operationId: 'op-retry-1',
      entityType: 'task',
      entityId: 'task-1',
      operation: 'upsert',
      sourceUserId: 'user-1',
      localCommittedAt: 1781539200000,
      baseUpdatedAt: '2026-01-02T00:00:00.000Z',
      queue: { enteredRetryQueue: true, retryCount: 1 },
      rpc: { status: 'unauthorized', reason: 'offline_restore_replay_pending' },
      lww: { decision: 'unknown', reason: 'retryQueue' },
      lastSyncTime: { before: meta.lastSyncTime, after: meta.lastSyncTime, advanced: false },
    };
    const lastWriteExplain: DataSafetyLastWriteExplain = {
      operationId: 'op-retry-1',
      actor: { sourceUserId: 'user-1' },
      entity: { type: 'task', id: 'task-1' },
      operation: 'upsert',
      localTimestamp: 1781539200000,
      updatedAtBaseline: '2026-01-02T00:00:00.000Z',
      beforeVersion: '2026-01-02T00:00:00.000Z',
      afterVersion: '2026-01-02T00:00:00.000Z',
      queueResult: { enteredRetryQueue: true, retryCount: 1 },
      rpcResult: { status: 'unauthorized', reason: 'offline_restore_replay_pending' },
      lwwDecision: { decision: 'unknown', reason: 'retryQueue' },
      lastSyncTime: { before: meta.lastSyncTime, after: meta.lastSyncTime, advanced: false },
    };
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
        retryQueue: [retryQueueItem],
        legacyRetryReview: [incomingReviewItem],
        actionQueue: [actionQueueItem],
        deadLetters: [deadLetterItem],
        conflicts: [],
        taskTombstones: {},
        connectionTombstones: [],
      },
      syncSnapshot: {
        syncState: { lastSyncTime: meta.lastSyncTime, pendingCount: 2 },
        projectCursors: [{ projectId: 'project-1', userId: 'user-1', cursor: cursor.cursor }],
        queueCounts: { retryQueue: 1, actionQueue: 1, deadLetters: 1 },
      },
      replayLog: [replayEntry],
      lastWriteExplain,
    });

    const result = await restoreDataSafetyPackageToIndexedDb(db, pkg);

    expect(result.success).toBe(true);
    expect(result.plan.idRemappingRequired).toBe(false);
    await expect(getAllStoreValues<Project>(db, DB_CONFIG.stores.projects)).resolves.toEqual([project]);
    await expect(getAllStoreValues<Task>(db, DB_CONFIG.stores.tasks)).resolves.toEqual([task]);
    await expect(getAllStoreValues<Connection>(db, DB_CONFIG.stores.connections)).resolves.toEqual([connection]);
    await expect(getAllStoreValues<Record<string, unknown>>(db, DB_CONFIG.stores.syncCursors)).resolves.toEqual([cursor]);
    await expect(getStoreValue(db, DB_CONFIG.stores.meta, 'meta')).resolves.toEqual(meta);
    retryDb = await openRetryQueueDatabase();
    await expect(getAllStoreValues(retryDb, 'offline_mutation_queue')).resolves.toEqual([retryQueueItem]);
    expect(JSON.parse(localStorage.getItem('nanoflow.retry-queue') ?? '{}')).toMatchObject({
      version: 1,
      items: [retryQueueItem],
    });
    expect(JSON.parse(localStorage.getItem('nanoflow.retry-queue.legacy-review.user-1') ?? '[]'))
      .toEqual([existingReviewItem, incomingReviewItem]);
    expect(JSON.parse(localStorage.getItem('nanoflow.retry-queue.legacy-review.user-2') ?? '[]'))
      .toEqual([foreignReviewItem]);
    expect(JSON.parse(localStorage.getItem('nanoflow.action-queue.user-1') ?? '[]')).toEqual([actionQueueItem]);
    queueBackupDb = await openQueueBackupDatabase();
    await expect(getStoreValue(queueBackupDb, 'queue-backup', 'queue-backup:user-1')).resolves.toMatchObject({
      ownerUserId: 'user-1',
      actions: [actionQueueItem],
    });
    await expect(getStoreValue(queueBackupDb, 'queue-backup', 'dead-letter-backup:user-1')).resolves.toMatchObject({
      ownerUserId: 'user-1',
      deadLetters: [deadLetterItem],
    });
    expect(JSON.parse(localStorage.getItem('nanoflow.dead-letter-queue.user-1') ?? '[]')).toEqual([deadLetterItem]);
    expect(JSON.parse(localStorage.getItem('nanoflow.data-safety-audit.user-1') ?? '{}')).toMatchObject({
      replayLog: [replayEntry],
      lastWriteExplain,
    });
  });

  it('restores project-scoped tombstones while preserving unrelated projects', async () => {
    localStorage.setItem('nanoflow.local-tombstones', JSON.stringify({
      'project-1': { 'task-old': 100 },
      'project-2': { 'task-keep': 150 },
    }));
    localStorage.setItem('nanoflow.local-connection-tombstones', JSON.stringify([
      { projectId: 'project-1', id: 'connection-old', timestamp: 100 },
      { projectId: 'project-2', id: 'connection-keep', timestamp: 150 },
    ]));
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
        retryQueue: [],
        actionQueue: [],
        deadLetters: [],
        conflicts: [],
        taskTombstones: {
          'project-1': { 'task-deleted': 200 },
        },
        connectionTombstones: [{
          projectId: 'project-1',
          id: 'connection-deleted',
          timestamp: 200,
        }],
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

    expect(result.success).toBe(true);
    expect(JSON.parse(localStorage.getItem('nanoflow.local-tombstones') ?? '{}')).toEqual({
      'project-1': { 'task-deleted': 200 },
      'project-2': { 'task-keep': 150 },
    });
    expect(JSON.parse(localStorage.getItem('nanoflow.local-connection-tombstones') ?? '[]')).toEqual([
      { projectId: 'project-2', id: 'connection-keep', timestamp: 150 },
      {
        projectId: 'project-1',
        id: 'connection-deleted',
        connectionId: 'connection-deleted',
        timestamp: 200,
      },
    ]);
  });

  it('preserves the original RetryQueue operationId across both durable replay stores', async () => {
    const retryQueueItem = {
      id: 'legacy-retry-1',
      operationId: 'legacy-operation-id',
      type: 'task',
      operation: 'upsert',
      data: task,
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
        projects: [project],
        tasks: [task],
        connections: [connection],
        syncCursors: [cursor],
        meta,
      },
      localState: {
        retryQueue: [retryQueueItem],
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

    expect(result.success).toBe(true);
    retryDb = await openRetryQueueDatabase();
    const [idbItem] = await getAllStoreValues<typeof retryQueueItem>(retryDb, 'offline_mutation_queue');
    const localStorageItems = JSON.parse(localStorage.getItem('nanoflow.retry-queue') ?? '{}').items;
    expect(idbItem.operationId).toBe(retryQueueItem.operationId);
    expect(localStorageItems).toEqual([
      expect.objectContaining({
        id: retryQueueItem.id,
        operationId: retryQueueItem.operationId,
      }),
    ]);
  });

  it('restoring one owner RetryQueue should replace only that owner and preserve other owners', async () => {
    const ownerAOld = {
      id: 'retry-owner-a-old',
      operationId: createDerivedSyncOperationId('retry-owner-a-old', 'test'),
      type: 'task',
      operation: 'upsert',
      data: { id: 'task-owner-a-old' },
      retryCount: 1,
      createdAt: 1781539200000,
      sourceUserId: 'user-1',
      projectId: 'project-owner-a',
    };
    const ownerBPending = {
      id: 'retry-owner-b-pending',
      operationId: createDerivedSyncOperationId('retry-owner-b-pending', 'test'),
      type: 'task',
      operation: 'upsert',
      data: { id: 'task-owner-b-pending' },
      retryCount: 2,
      createdAt: 1781539200001,
      sourceUserId: 'user-2',
      projectId: 'project-owner-b',
    };
    const ownerANew = {
      id: 'retry-owner-a-new',
      operationId: createDerivedSyncOperationId('retry-owner-a-new', 'test'),
      type: 'task',
      operation: 'upsert',
      data: { ...task, id: 'task-owner-a-new', projectId: 'project-owner-a' },
      retryCount: 0,
      createdAt: 1781539200002,
      sourceUserId: 'user-1',
      projectId: 'project-owner-a',
    };
    retryDb = await openRetryQueueDatabase();
    await putStoreValue(retryDb, 'offline_mutation_queue', ownerAOld);
    await putStoreValue(retryDb, 'offline_mutation_queue', ownerBPending);
    localStorage.setItem('nanoflow.retry-queue', JSON.stringify({
      version: 1,
      items: [ownerAOld, ownerBPending],
      savedAt: 1781539200001,
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
        retryQueue: [ownerANew],
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

    expect(result.success).toBe(true);
    await expect(getAllStoreValues(retryDb, 'offline_mutation_queue')).resolves.toEqual(
      expect.arrayContaining([ownerANew, ownerBPending]),
    );
    expect(await getAllStoreValues(retryDb, 'offline_mutation_queue')).toHaveLength(2);
    const localStorageItems = JSON.parse(localStorage.getItem('nanoflow.retry-queue') ?? '{}').items;
    expect(localStorageItems).toEqual(expect.arrayContaining([ownerANew, ownerBPending]));
    expect(localStorageItems).toHaveLength(2);
  });

  it('preserves the original ActionQueue operationId across both durable replay stores', async () => {
    const legacyActionQueueItem = {
      id: 'legacy-action-string-operation-id',
      operationId: 'legacy-action-operation-id',
      entityType: 'task',
      entityId: 'task-1',
      type: 'update',
      payload: { taskId: 'task-1', projectId: 'project-1', task },
      retryCount: 1,
      timestamp: 1781539200001,
    };
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
        retryQueue: [],
        actionQueue: [legacyActionQueueItem],
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

    expect(result.success).toBe(true);
    queueBackupDb = await openQueueBackupDatabase();
    const queueBackup = await getStoreValue<{ actions: typeof legacyActionQueueItem[] }>(
      queueBackupDb,
      'queue-backup',
      'queue-backup:user-1',
    );
    const localStorageItems = JSON.parse(localStorage.getItem('nanoflow.action-queue.user-1') ?? '[]');
    expect(queueBackup?.actions).toHaveLength(1);
    expect(localStorageItems).toEqual(queueBackup?.actions);
    expect(queueBackup?.actions[0]).toEqual(expect.objectContaining({
      id: legacyActionQueueItem.id,
      operationId: legacyActionQueueItem.operationId,
    }));
  });

  it('recovers local data and queue mirrors from a pending restore marker after an interrupted restore', async () => {
    const fixture = createInterruptedDataSafetyRestoreFixture();
    const {
      oldProject,
      oldTask,
      incomingProject,
      incomingTask,
      oldDockSnapshot,
      incomingDockSnapshot,
      oldLaunchSnapshot,
      incomingLaunchSnapshot,
      oldParkedTaskCache,
      incomingParkedTaskCache,
      oldRetryQueueItem,
      incomingRetryQueueItem,
      oldActionQueueItem,
      incomingActionQueueItem,
      oldDeadLetterItem,
      incomingDeadLetterItem,
      oldTaskTombstonesRaw,
      oldConnectionTombstonesRaw,
    } = fixture;
    await putStoreValue(db, DB_CONFIG.stores.projects, incomingProject);
    await putStoreValue(db, DB_CONFIG.stores.tasks, incomingTask);
    retryDb = await openRetryQueueDatabase();
    await putStoreValue(retryDb, 'offline_mutation_queue', incomingRetryQueueItem);
    localStorage.setItem('nanoflow.retry-queue', JSON.stringify({
      version: 1,
      items: [incomingRetryQueueItem],
      savedAt: 1781539200000,
    }));
    queueBackupDb = await openQueueBackupDatabase();
    await putStoreValue(queueBackupDb, 'queue-backup', {
      id: 'queue-backup:user-1',
      ownerUserId: 'user-1',
      actions: [incomingActionQueueItem],
      savedAt: '2026-06-16T00:00:00.000Z',
    });
    await putStoreValue(queueBackupDb, 'queue-backup', {
      id: 'dead-letter-backup:user-1',
      ownerUserId: 'user-1',
      deadLetters: [incomingDeadLetterItem],
      savedAt: '2026-06-16T00:00:00.000Z',
    });
    localStorage.setItem('nanoflow.action-queue.user-1', JSON.stringify([incomingActionQueueItem]));
    localStorage.setItem('nanoflow.dead-letter-queue.user-1', JSON.stringify([incomingDeadLetterItem]));
    localStorage.setItem('nanoflow.data-safety-audit.user-1', JSON.stringify({
      replayLog: [{ operationId: 'incoming-audit' }],
      lastWriteExplain: null,
    }));
    localStorage.setItem('nanoflow.local-tombstones', JSON.stringify({
      'project-1': { 'incoming-task-tombstone': 1781539200000 },
    }));
    localStorage.setItem('nanoflow.local-connection-tombstones', JSON.stringify([
      { projectId: 'project-1', id: 'incoming-connection-tombstone', timestamp: 1781539200000 },
    ]));
    localStorage.setItem(`${PARKING_CONFIG.DOCK_SNAPSHOT_STORAGE_KEY}.user-1`, incomingDockSnapshot.localStorage);
    await setKeyvalValue('nanoflow.focus-session.v5.user-1', incomingDockSnapshot.indexedDb);
    localStorage.setItem('nanoflow.launch-snapshot.v1', incomingLaunchSnapshot.v1);
    localStorage.setItem('nanoflow.launch-snapshot.v2', incomingLaunchSnapshot.v2);
    await seedInterruptedRestoreParkedTaskCache(incomingParkedTaskCache.entries, incomingParkedTaskCache.syncMetadata);
    localStorage.setItem(`${DATA_SAFETY_RESTORE_MARKER_STORAGE_KEY_PREFIX}.user-1`, JSON.stringify({
      schemaVersion: 1,
      ownerUserId: 'user-1',
      createdAt: '2026-06-16T00:00:00.000Z',
      primaryStoreSnapshot: {
        projects: [oldProject],
        tasks: [oldTask],
        connections: [],
        syncCursors: [],
        meta,
      },
      localStateSnapshot: {
        retryQueueIndexedDbItems: [oldRetryQueueItem],
        retryQueueLocalStorageValue: JSON.stringify({
          version: 1,
          items: [oldRetryQueueItem],
          savedAt: 1781539100000,
        }),
        actionQueueBackupRecord: {
          id: 'queue-backup:user-1',
          ownerUserId: 'user-1',
          actions: [oldActionQueueItem],
          savedAt: '2026-06-15T00:00:00.000Z',
        },
        actionQueueLocalStorageValue: JSON.stringify([oldActionQueueItem]),
        deadLetterBackupRecord: {
          id: 'dead-letter-backup:user-1',
          ownerUserId: 'user-1',
          deadLetters: [oldDeadLetterItem],
          savedAt: '2026-06-15T00:00:00.000Z',
        },
        deadLetterLocalStorageValue: JSON.stringify([oldDeadLetterItem]),
        auditLocalStorageValue: JSON.stringify({
          replayLog: [{ operationId: 'old-audit' }],
          lastWriteExplain: null,
        }),
        taskTombstonesLocalStorageValue: oldTaskTombstonesRaw,
        connectionTombstonesLocalStorageValue: oldConnectionTombstonesRaw,
        dockSnapshotRestoreSnapshot: {
          present: true,
          localStorage: oldDockSnapshot.localStorage,
          indexedDb: oldDockSnapshot.indexedDb,
        },
        launchSnapshotRestoreSnapshot: {
          present: true,
          v1: oldLaunchSnapshot.v1,
          v2: oldLaunchSnapshot.v2,
        },
        parkedTaskCacheRestoreSnapshot: {
          present: true,
          entries: oldParkedTaskCache.entries,
          syncMetadata: oldParkedTaskCache.syncMetadata,
        },
      },
    }));

    const result = await recoverInterruptedDataSafetyRestoreFromIndexedDb(db, 'user-1');

    expect(result).toEqual({ recovered: true, errors: [] });
    await expect(getAllStoreValues<Project>(db, DB_CONFIG.stores.projects)).resolves.toEqual([oldProject]);
    await expect(getAllStoreValues<Task>(db, DB_CONFIG.stores.tasks)).resolves.toEqual([oldTask]);
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
    expect(localStorage.getItem(`${PARKING_CONFIG.DOCK_SNAPSHOT_STORAGE_KEY}.user-1`))
      .toBe(oldDockSnapshot.localStorage);
    expect(await readInterruptedRestoreDockSnapshot()).toEqual(oldDockSnapshot.indexedDb);
    expect(localStorage.getItem('nanoflow.launch-snapshot.v1')).toBe(oldLaunchSnapshot.v1);
    expect(localStorage.getItem('nanoflow.launch-snapshot.v2')).toBe(oldLaunchSnapshot.v2);
    expect(await readInterruptedRestoreParkedTaskCache()).toEqual({
      entries: oldParkedTaskCache.entries,
      syncMetadata: oldParkedTaskCache.syncMetadata,
    });
    expect(localStorage.getItem(`${DATA_SAFETY_RESTORE_MARKER_STORAGE_KEY_PREFIX}.user-1`)).toBeNull();
  });
});

function makeLaunchSnapshotFixture(ownerUserId: string, savedAt: string): {
  v1: string;
  v2: string;
} {
  const common = {
    userId: ownerUserId,
    savedAt,
    activeProjectId: 'project-1',
    lastActiveView: 'text',
    theme: 'default',
    colorMode: 'light',
    projects: [],
  };
  return {
    v1: JSON.stringify({ version: 1, ...common }),
    v2: JSON.stringify({
      version: 2,
      ...common,
      preferredView: 'text',
      resolvedLaunchView: 'text',
      routeIntent: { kind: 'project', projectId: 'project-1', taskId: null },
      mobileDegraded: false,
      degradeReason: null,
      currentProject: null,
    }),
  };
}

registerDataSafetyRestoreRollbackSpecs();

registerDataSafetyRestoreMarkerRaceSpecs();

registerDataSafetyRetryQueueRaceSpecs();

registerDataSafetyMalformedRestoreSpecs();

registerDataSafetyConflictRestoreSpecs();

registerDataSafetyOfflineSnapshotRestoreSpecs();
