import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Connection, Project, Task } from '../models';
import { DB_CONFIG } from '../app/core/state/persistence/indexeddb.service';
import { deleteRawIndexedDbDatabase } from '../app/core/state/persistence/backup-transaction.helpers';
import {
  exportDataSafetyPackageFromIndexedDb,
  recoverInterruptedDataSafetyRestoreFromIndexedDb,
  restoreDataSafetyPackageToIndexedDb,
} from './data-safety-indexeddb-adapter';
import {
  buildDataSafetyExportPackage,
  type DataSafetyExportPackage,
  type DataSafetyLastWriteExplain,
  type DataSafetyReplayEntry,
} from './data-safety-package';
import { createDerivedSyncOperationId, isSyncOperationId } from '../utils/sync-operation-id';

const LEGACY_RETRY_QUEUE_OPERATION_ID_PURPOSE = 'legacy-retry-queue-operation-id';
const LEGACY_ACTION_QUEUE_OPERATION_ID_PURPOSE = 'legacy-action-queue-operation-id';
const DATA_SAFETY_RESTORE_MARKER_STORAGE_KEY_PREFIX = 'nanoflow.data-safety-restore-marker';

function readServiceSource(fileName: string): string {
  try {
    return readFileSync(join(__dirname, fileName), 'utf8');
  } catch (error) {
    if (
      error instanceof Error
      && 'code' in error
      && error.code === 'ENOENT'
    ) {
      return '';
    }

    throw error;
  }
}

function openDatabase(dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, 1);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => ensureStores(request.result);
    request.onsuccess = () => resolve(request.result);
  });
}

function ensureStores(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains(DB_CONFIG.stores.projects)) {
    db.createObjectStore(DB_CONFIG.stores.projects, { keyPath: 'id' });
  }
  if (!db.objectStoreNames.contains(DB_CONFIG.stores.tasks)) {
    db.createObjectStore(DB_CONFIG.stores.tasks, { keyPath: 'id' });
  }
  if (!db.objectStoreNames.contains(DB_CONFIG.stores.connections)) {
    db.createObjectStore(DB_CONFIG.stores.connections, { keyPath: 'id' });
  }
  if (!db.objectStoreNames.contains(DB_CONFIG.stores.meta)) {
    db.createObjectStore(DB_CONFIG.stores.meta, { keyPath: 'key' });
  }
  if (!db.objectStoreNames.contains(DB_CONFIG.stores.syncCursors)) {
    db.createObjectStore(DB_CONFIG.stores.syncCursors, { keyPath: 'key' });
  }
}

function putStoreValue(db: IDBDatabase, storeName: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });
}

function getAllStoreValues<T>(db: IDBDatabase, storeName: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const request = tx.objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result ?? []);
    request.onerror = () => reject(request.error);
  });
}

function getStoreValue<T>(db: IDBDatabase, storeName: string, key: IDBValidKey): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const request = tx.objectStore(storeName).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function openRetryQueueDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('nanoflow-retry-queue', 1);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const retryDb = request.result;
      if (!retryDb.objectStoreNames.contains('offline_mutation_queue')) {
        retryDb.createObjectStore('offline_mutation_queue', { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

function openQueueBackupDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('nanoflow-queue-backup', 1);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const queueBackupDb = request.result;
      if (!queueBackupDb.objectStoreNames.contains('queue-backup')) {
        queueBackupDb.createObjectStore('queue-backup', { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

const project = {
  id: 'project-1',
  name: 'Project',
  description: '',
  createdDate: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  tasks: [],
  connections: [],
} satisfies Project;

const task = {
  id: 'task-1',
  title: 'Task',
  content: 'content must survive export',
  stage: null,
  parentId: null,
  order: 0,
  rank: 0,
  status: 'active',
  x: 0,
  y: 0,
  displayId: 'T1',
  projectId: 'project-1',
  createdDate: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
} satisfies Task & { projectId: string };

const connection = {
  id: 'connection-1',
  source: 'task-1',
  target: 'task-1',
  fromTaskId: 'task-1',
  toTaskId: 'task-1',
  projectId: 'project-1',
  updatedAt: '2026-01-02T00:00:00.000Z',
} satisfies Connection & { fromTaskId: string; toTaskId: string; projectId: string };

const cursor = {
  key: 'project:user-1:project-1',
  cursor: { updatedAt: '2026-01-02T00:00:00.000Z', entityType: 'task', id: 'task-1' },
};

const meta = {
  key: 'meta',
  version: 3,
  lastSyncTime: '2026-01-02T00:00:00.000Z',
  activeProjectId: 'project-1',
};

describe('data-safety IndexedDB adapter', () => {
  const dbName = 'data-safety-indexeddb-adapter-test';
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

  beforeEach(async () => {
    await deleteRawIndexedDbDatabase(dbName).catch(() => undefined);
    await deleteRawIndexedDbDatabase('nanoflow-retry-queue').catch(() => undefined);
    await deleteRawIndexedDbDatabase('nanoflow-queue-backup').catch(() => undefined);
    localStorage.clear();
    db = await openDatabase(dbName);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    db.close();
    retryDb?.close();
    queueBackupDb?.close();
    retryDb = null;
    queueBackupDb = null;
    localStorage.clear();
    await deleteRawIndexedDbDatabase(dbName).catch(() => undefined);
    await deleteRawIndexedDbDatabase('nanoflow-retry-queue').catch(() => undefined);
    await deleteRawIndexedDbDatabase('nanoflow-queue-backup').catch(() => undefined);
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
      retryQueue: [{ id: 'retry-1', operationId: 'op-1', type: 'task', operation: 'upsert', data: { id: 'task-1' }, retryCount: 0, createdAt: 1781539200000 }],
      actionQueue: [{ id: 'action-1', operationId: 'op-2', entityType: 'task', entityId: 'task-1' }],
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
      data: { id: 'task-1' },
      retryCount: 1,
      createdAt: 1781539200000,
      sourceUserId: 'user-1',
      projectId: 'project-1',
    };
    const normalizedRetryQueueItem = {
      ...retryQueueItem,
      operationId: createDerivedSyncOperationId(
        retryQueueItem.operationId,
        LEGACY_RETRY_QUEUE_OPERATION_ID_PURPOSE,
      ),
    };
    const actionQueueItem = {
      id: 'action-1',
      operationId: 'op-action-1',
      entityType: 'task',
      entityId: 'task-1',
      type: 'update',
      payload: { taskId: 'task-1', projectId: 'project-1' },
      retryCount: 0,
      timestamp: 1781539200000,
    };
    const normalizedActionQueueItem = {
      ...actionQueueItem,
      operationId: createDerivedSyncOperationId(
        actionQueueItem.operationId,
        LEGACY_ACTION_QUEUE_OPERATION_ID_PURPOSE,
      ),
    };
    const deadLetterItem = {
      action: actionQueueItem,
      failedAt: '2026-06-16T00:00:00.000Z',
      reason: 'test dead letter',
    };
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
    await expect(getAllStoreValues(retryDb, 'offline_mutation_queue')).resolves.toEqual([normalizedRetryQueueItem]);
    expect(JSON.parse(localStorage.getItem('nanoflow.retry-queue') ?? '{}')).toMatchObject({
      version: 1,
      items: [normalizedRetryQueueItem],
    });
    expect(JSON.parse(localStorage.getItem('nanoflow.action-queue.user-1') ?? '[]')).toEqual([normalizedActionQueueItem]);
    queueBackupDb = await openQueueBackupDatabase();
    await expect(getStoreValue(queueBackupDb, 'queue-backup', 'queue-backup:user-1')).resolves.toMatchObject({
      ownerUserId: 'user-1',
      actions: [normalizedActionQueueItem],
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

  it('normalizes legacy RetryQueue operationId before restoring durable replay stores', async () => {
    const retryQueueItem = {
      id: 'legacy-retry-1',
      operationId: 'legacy-operation-id',
      type: 'task',
      operation: 'upsert',
      data: { id: 'task-1' },
      retryCount: 0,
      createdAt: 1781539200000,
      sourceUserId: 'user-1',
      projectId: 'project-1',
    };
    const expectedOperationId = createDerivedSyncOperationId(
      retryQueueItem.operationId,
      LEGACY_RETRY_QUEUE_OPERATION_ID_PURPOSE,
    );
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
    expect(idbItem.operationId).toBe(expectedOperationId);
    expect(isSyncOperationId(idbItem.operationId)).toBe(true);
    expect(localStorageItems).toEqual([
      expect.objectContaining({
        id: retryQueueItem.id,
        operationId: expectedOperationId,
      }),
    ]);
  });

  it('normalizes legacy ActionQueue operationId before restoring durable replay stores', async () => {
    const missingOperationActionQueueItem = {
      id: 'legacy-action-missing-operation-id',
      entityType: 'task',
      entityId: 'task-1',
      type: 'update',
      payload: { taskId: 'task-1', projectId: 'project-1' },
      retryCount: 0,
      timestamp: 1781539200000,
    } as unknown as DataSafetyExportPackage['localState']['actionQueue'][number];
    const legacyActionQueueItem = {
      id: 'legacy-action-string-operation-id',
      operationId: 'legacy-action-operation-id',
      entityType: 'task',
      entityId: 'task-1',
      type: 'update',
      payload: { taskId: 'task-1', projectId: 'project-1' },
      retryCount: 1,
      timestamp: 1781539200001,
    };
    const expectedLegacyOperationId = createDerivedSyncOperationId(
      legacyActionQueueItem.operationId,
      LEGACY_ACTION_QUEUE_OPERATION_ID_PURPOSE,
    );
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
        actionQueue: [missingOperationActionQueueItem, legacyActionQueueItem],
        deadLetters: [],
        conflicts: [],
        taskTombstones: {},
        connectionTombstones: [],
      },
      syncSnapshot: {
        syncState: { lastSyncTime: meta.lastSyncTime, pendingCount: 2 },
        projectCursors: [{ projectId: 'project-1', userId: 'user-1', cursor: cursor.cursor }],
        queueCounts: { retryQueue: 0, actionQueue: 2, deadLetters: 0 },
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
    expect(queueBackup?.actions).toHaveLength(2);
    expect(localStorageItems).toEqual(queueBackup?.actions);
    expect(queueBackup?.actions[0]).toEqual(expect.objectContaining({
      id: missingOperationActionQueueItem.id,
      operationId: expect.any(String),
    }));
    expect(queueBackup?.actions[1]).toEqual(expect.objectContaining({
      id: legacyActionQueueItem.id,
      operationId: expectedLegacyOperationId,
    }));
    expect(isSyncOperationId(queueBackup?.actions[0]?.operationId)).toBe(true);
    expect(isSyncOperationId(queueBackup?.actions[1]?.operationId)).toBe(true);
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
      payload: { taskId: 'task-1', projectId: 'project-1' },
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
      data: { id: 'incoming-task' },
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
      data: { id: 'incoming-task' },
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
      payload: { taskId: 'task-1', projectId: 'project-1' },
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
      data: { id: 'incoming-task' },
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
      payload: { taskId: 'task-1', projectId: 'project-1' },
      retryCount: 0,
      timestamp: 1781539200000,
    };
    const incomingDeadLetterItem = {
      action: incomingActionQueueItem,
      failedAt: '2026-06-16T00:00:00.000Z',
      reason: 'incoming dead letter must be rolled back after audit failure',
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
  });

  it('fails and rolls back instead of silently filtering malformed ActionQueue items during restore', async () => {
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
      expect.stringContaining('unrestorable actionQueue item'),
      expect.stringContaining('malformed-action-must-not-disappear'),
    ]));
    await expect(getAllStoreValues<Project>(db, DB_CONFIG.stores.projects)).resolves.toEqual([oldProject]);
    await expect(getAllStoreValues<Task>(db, DB_CONFIG.stores.tasks)).resolves.toEqual([oldTask]);
    await expect(getStoreValue(queueBackupDb, 'queue-backup', 'queue-backup:user-1')).resolves.toMatchObject({
      actions: [oldActionQueueItem],
    });
    expect(JSON.parse(localStorage.getItem('nanoflow.action-queue.user-1') ?? '[]')).toEqual([oldActionQueueItem]);
  });

  it('fails and rolls back instead of restoring malformed RetryQueue items', async () => {
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
      expect.stringContaining('unrestorable retryQueue item'),
      expect.stringContaining('malformed-retry-must-not-be-restored'),
    ]));
    await expect(getAllStoreValues<Project>(db, DB_CONFIG.stores.projects)).resolves.toEqual([oldProject]);
    await expect(getAllStoreValues(retryDb, 'offline_mutation_queue')).resolves.toEqual([oldRetryQueueItem]);
    expect(JSON.parse(localStorage.getItem('nanoflow.retry-queue') ?? '{}')).toMatchObject({
      items: [oldRetryQueueItem],
    });
  });

  it('fails before mutation instead of silently dropping unsupported localState restore sections', async () => {
    const oldProject = { ...project, name: 'old local project before unsupported localState restore' };
    const incomingProject = { ...project, name: 'incoming project with unsupported localState' };

    await putStoreValue(db, DB_CONFIG.stores.projects, oldProject);

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
        conflicts: [
          {
            status: 'conflict-detected',
            localSnapshot: { title: 'local edit must not disappear' },
            remoteSnapshot: { title: 'remote edit must not overwrite silently' },
          },
        ],
        taskTombstones: { 'project-1': ['task-deleted-offline'] },
        connectionTombstones: ['connection-deleted-offline'],
        offlineSnapshots: { projects: [{ id: 'snapshot-project-1' }] },
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
      expect.stringContaining('localState.conflicts restore is unsupported'),
      expect.stringContaining('localState.taskTombstones restore is unsupported'),
      expect.stringContaining('localState.connectionTombstones restore is unsupported'),
      expect.stringContaining('localState.offlineSnapshots restore is unsupported'),
    ]));
    await expect(getAllStoreValues<Project>(db, DB_CONFIG.stores.projects)).resolves.toEqual([oldProject]);
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

  it('recovers local data and queue mirrors from a pending restore marker after an interrupted restore', async () => {
    const oldProject = { ...project, name: 'old local project from pending marker' };
    const oldTask = { ...task, title: 'old local task from pending marker' };
    const incomingProject = { ...project, name: 'incoming project left by interrupted restore' };
    const incomingTask = { ...task, title: 'incoming task left by interrupted restore' };
    const oldRetryQueueItem = {
      id: 'old-retry-from-pending-marker',
      operationId: createDerivedSyncOperationId(
        'old-retry-from-pending-marker',
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
    const incomingRetryQueueItem = {
      id: 'incoming-retry-left-by-crash',
      operationId: createDerivedSyncOperationId(
        'incoming-retry-left-by-crash',
        LEGACY_RETRY_QUEUE_OPERATION_ID_PURPOSE,
      ),
      type: 'task',
      operation: 'upsert',
      data: { id: 'incoming-task' },
      retryCount: 0,
      createdAt: 1781539200000,
      sourceUserId: 'user-1',
      projectId: 'project-1',
    };
    const oldActionQueueItem = {
      id: 'old-action-from-pending-marker',
      operationId: createDerivedSyncOperationId(
        'old-action-from-pending-marker',
        LEGACY_ACTION_QUEUE_OPERATION_ID_PURPOSE,
      ),
      entityType: 'task',
      entityId: 'old-task',
      type: 'update',
      payload: { taskId: 'old-task', projectId: 'project-1' },
      retryCount: 1,
      timestamp: 1781539100000,
    };
    const incomingActionQueueItem = {
      id: 'incoming-action-left-by-crash',
      operationId: createDerivedSyncOperationId(
        'incoming-action-left-by-crash',
        LEGACY_ACTION_QUEUE_OPERATION_ID_PURPOSE,
      ),
      entityType: 'task',
      entityId: 'task-1',
      type: 'update',
      payload: { taskId: 'task-1', projectId: 'project-1' },
      retryCount: 0,
      timestamp: 1781539200000,
    };
    const oldDeadLetterItem = {
      action: oldActionQueueItem,
      failedAt: '2026-06-15T00:00:00.000Z',
      reason: 'old dead-letter from pending marker',
    };
    const incomingDeadLetterItem = {
      action: incomingActionQueueItem,
      failedAt: '2026-06-16T00:00:00.000Z',
      reason: 'incoming dead-letter left by crash',
    };

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
    expect(localStorage.getItem(`${DATA_SAFETY_RESTORE_MARKER_STORAGE_KEY_PREFIX}.user-1`)).toBeNull();
  });
});
