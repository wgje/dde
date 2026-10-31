import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Connection, Project, Task } from '../models';
import { FOCUS_CONFIG } from '../config/focus.config';
import { DB_CONFIG } from '../app/core/state/persistence/indexeddb.service';
import { deleteRawIndexedDbDatabase } from '../app/core/state/persistence/backup-transaction.helpers';
import { del as deleteKeyvalValue } from 'idb-keyval';
import { createDerivedSyncOperationId } from '../utils/sync-operation-id';
import { deleteDataSafetyRestoreMarkerJournalDatabaseForTests } from './data-safety-restore-marker-journal';

export const DATA_SAFETY_ADAPTER_TEST_DB_NAME = 'data-safety-indexeddb-adapter-test';

export async function resetDataSafetyAdapterStorage(): Promise<IDBDatabase> {
  await deleteRawIndexedDbDatabase(DATA_SAFETY_ADAPTER_TEST_DB_NAME).catch(() => undefined);
  await deleteRawIndexedDbDatabase('nanoflow-retry-queue').catch(() => undefined);
  await deleteRawIndexedDbDatabase('nanoflow-queue-backup').catch(() => undefined);
  await deleteRawIndexedDbDatabase('nanoflow-conflicts').catch(() => undefined);
  await deleteRawIndexedDbDatabase('nanoflow-offline-snapshots').catch(() => undefined);
  await deleteDataSafetyRestoreMarkerJournalDatabaseForTests().catch(() => undefined);
  localStorage.clear();
  return openDatabase(DATA_SAFETY_ADAPTER_TEST_DB_NAME);
}

export async function cleanupDataSafetyAdapterStorage(
  db: IDBDatabase,
  retryDb: IDBDatabase | null,
  queueBackupDb: IDBDatabase | null,
): Promise<void> {
  db.close();
  retryDb?.close();
  queueBackupDb?.close();
  localStorage.clear();
  await deleteRawIndexedDbDatabase(DATA_SAFETY_ADAPTER_TEST_DB_NAME).catch(() => undefined);
  await deleteRawIndexedDbDatabase('nanoflow-retry-queue').catch(() => undefined);
  await deleteRawIndexedDbDatabase('nanoflow-queue-backup').catch(() => undefined);
  await deleteRawIndexedDbDatabase('nanoflow-conflicts').catch(() => undefined);
  await deleteRawIndexedDbDatabase('nanoflow-offline-snapshots').catch(() => undefined);
  await deleteDataSafetyRestoreMarkerJournalDatabaseForTests().catch(() => undefined);
}

export const LEGACY_RETRY_QUEUE_OPERATION_ID_PURPOSE = 'legacy-retry-queue-operation-id';
export const LEGACY_ACTION_QUEUE_OPERATION_ID_PURPOSE = 'legacy-action-queue-operation-id';
export const DATA_SAFETY_RESTORE_MARKER_STORAGE_KEY_PREFIX = 'nanoflow.data-safety-restore-marker';

export function readServiceSource(fileName: string): string {
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

export function openDatabase(dbName: string): Promise<IDBDatabase> {
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

export function putStoreValue(db: IDBDatabase, storeName: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });
}

export function getAllStoreValues<T>(db: IDBDatabase, storeName: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const request = tx.objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result ?? []);
    request.onerror = () => reject(request.error);
  });
}

export function getStoreValue<T>(db: IDBDatabase, storeName: string, key: IDBValidKey): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const request = tx.objectStore(storeName).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function openRetryQueueDatabase(): Promise<IDBDatabase> {
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

export function openQueueBackupDatabase(): Promise<IDBDatabase> {
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

export async function putConflictStorageRecords(records: unknown[]): Promise<void> {
  const db = await openConflictStorageDatabase();
  try {
    const tx = db.transaction('conflicts', 'readwrite');
    records.forEach(record => tx.objectStore('conflicts').put(record));
    await waitForTransaction(tx);
  } finally {
    db.close();
  }
}

export async function getConflictStorageRecords<T>(): Promise<T[]> {
  const db = await openConflictStorageDatabase();
  try {
    return await getAllStoreValues<T>(db, 'conflicts');
  } finally {
    db.close();
  }
}

export async function putOfflineSnapshotRecord(record: unknown): Promise<void> {
  const db = await openOfflineSnapshotDatabase();
  try {
    await putStoreValue(db, 'snapshots', record);
  } finally {
    db.close();
  }
}

export async function getOfflineSnapshotRecord<T>(id: string): Promise<T | undefined> {
  const db = await openOfflineSnapshotDatabase();
  try {
    return await getStoreValue<T>(db, 'snapshots', id);
  } finally {
    db.close();
  }
}

function openConflictStorageDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('nanoflow-conflicts', 2);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const db = request.result;
      const store = db.objectStoreNames.contains('conflicts')
        ? request.transaction!.objectStore('conflicts')
        : db.createObjectStore('conflicts', { keyPath: 'scopedId' });
      if (!store.indexNames.contains('ownerUserId')) {
        store.createIndex('ownerUserId', 'ownerUserId', { unique: false });
      }
      if (!store.indexNames.contains('conflictedAt')) {
        store.createIndex('conflictedAt', 'conflictedAt', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

function openOfflineSnapshotDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('nanoflow-offline-snapshots', 1);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('snapshots')) {
        request.result.createObjectStore('snapshots', { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

function waitForTransaction(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });
}

export const project = {
  id: 'project-1',
  name: 'Project',
  description: '',
  createdDate: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  tasks: [],
  connections: [],
} satisfies Project;

export const task = {
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

export const connection = {
  id: 'connection-1',
  source: 'task-1',
  target: 'task-1',
  fromTaskId: 'task-1',
  toTaskId: 'task-1',
  projectId: 'project-1',
  updatedAt: '2026-01-02T00:00:00.000Z',
} satisfies Connection & { fromTaskId: string; toTaskId: string; projectId: string };

export const cursor = {
  key: 'project:user-1:project-1',
  cursor: { updatedAt: '2026-01-02T00:00:00.000Z', entityType: 'task', id: 'task-1' },
};

export const meta = {
  key: 'meta',
  version: 3,
  lastSyncTime: '2026-01-02T00:00:00.000Z',
  activeProjectId: 'project-1',
};

export function createInterruptedDataSafetyRestoreFixture() {
  const oldProject = { ...project, name: 'old local project from pending marker' };
  const oldTask = { ...task, title: 'old local task from pending marker' };
  const incomingProject = { ...project, name: 'incoming project left by interrupted restore' };
  const incomingTask = { ...task, title: 'incoming task left by interrupted restore' };
  const oldDockSnapshot = makeDockSnapshotFixture('2026-06-15', 'dock-old');
  const incomingDockSnapshot = makeDockSnapshotFixture('2026-06-16', 'dock-incoming');
  const oldLaunchSnapshot = makeLaunchSnapshotFixture('2026-06-15', 'text', 'light');
  const incomingLaunchSnapshot = makeLaunchSnapshotFixture('2026-06-16', 'flow', 'dark');
  const oldParkedTaskCache = makeParkedTaskCacheFixture(
    'parked-old',
    'old parked cache',
    '2026-06-15T00:00:00.000Z',
  );
  const incomingParkedTaskCache = makeParkedTaskCacheFixture(
    'parked-incoming',
    'incoming parked cache',
    '2026-06-16T00:00:00.000Z',
  );
  const oldRetryQueueItem = makeRetryQueueFixture(
    'old-retry-from-pending-marker',
    'old-task',
    1,
    1781539100000,
  );
  const incomingRetryQueueItem = makeRetryQueueFixture(
    'incoming-retry-left-by-crash',
    'incoming-task',
    0,
    1781539200000,
  );
  const oldActionQueueItem = makeActionQueueFixture(
    'old-action-from-pending-marker',
    'old-task',
    1,
    1781539100000,
  );
  const incomingActionQueueItem = makeActionQueueFixture(
    'incoming-action-left-by-crash',
    'task-1',
    0,
    1781539200000,
  );
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
  const oldTaskTombstonesRaw = JSON.stringify({
    'project-1': { 'old-task-tombstone': 1781539100000 },
    'project-2': { 'preserved-task-tombstone': 1781539050000 },
  });
  const oldConnectionTombstonesRaw = JSON.stringify([
    { projectId: 'project-1', id: 'old-connection-tombstone', timestamp: 1781539100000 },
    { projectId: 'project-2', id: 'preserved-connection-tombstone', timestamp: 1781539050000 },
  ]);

  return {
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
  };
}

export async function cleanupInterruptedRestoreProjectLocalState(): Promise<void> {
  await deleteKeyvalValue('nanoflow.focus-session.v5.user-1').catch(() => undefined);
  await clearInterruptedRestoreParkedTaskCache().catch(() => undefined);
}

export async function seedInterruptedRestoreParkedTaskCache(
  entries: Array<Record<string, unknown>>,
  syncMetadata: Record<string, unknown>,
): Promise<void> {
  const db = await openInterruptedRestoreFocusDb();
  try {
    const tx = db.transaction([
      FOCUS_CONFIG.IDB_STORES.PARKED_TASKS,
      FOCUS_CONFIG.IDB_STORES.SYNC_METADATA,
    ], 'readwrite');
    const parkedStore = tx.objectStore(FOCUS_CONFIG.IDB_STORES.PARKED_TASKS);
    const metadataStore = tx.objectStore(FOCUS_CONFIG.IDB_STORES.SYNC_METADATA);
    parkedStore.clear();
    metadataStore.clear();
    for (const entry of entries) parkedStore.put(entry);
    for (const [key, value] of Object.entries(syncMetadata)) {
      metadataStore.put({ key, value });
    }
    await waitForTransaction(tx);
  } finally {
    db.close();
  }
}

export async function readInterruptedRestoreDockSnapshot(): Promise<unknown> {
  const request = indexedDB.open('keyval-store');
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
  try {
    const tx = db.transaction('keyval', 'readonly');
    const get = tx.objectStore('keyval').get('nanoflow.focus-session.v5.user-1');
    return await new Promise((resolve, reject) => {
      get.onerror = () => reject(get.error);
      get.onsuccess = () => resolve(get.result);
    });
  } finally {
    db.close();
  }
}

export async function readInterruptedRestoreParkedTaskCache(): Promise<{
  entries: Array<Record<string, unknown>>;
  syncMetadata: Record<string, unknown>;
}> {
  const db = await openInterruptedRestoreFocusDb();
  try {
    const tx = db.transaction([
      FOCUS_CONFIG.IDB_STORES.PARKED_TASKS,
      FOCUS_CONFIG.IDB_STORES.SYNC_METADATA,
    ], 'readonly');
    const parkedRequest = tx.objectStore(FOCUS_CONFIG.IDB_STORES.PARKED_TASKS).getAll();
    const metadataRequest = tx.objectStore(FOCUS_CONFIG.IDB_STORES.SYNC_METADATA).getAll();
    await waitForTransaction(tx);
    return {
      entries: parkedRequest.result as Array<Record<string, unknown>>,
      syncMetadata: Object.fromEntries(
        (metadataRequest.result as Array<{ key: string; value: unknown }>)
          .map(row => [row.key, row.value]),
      ),
    };
  } finally {
    db.close();
  }
}

function makeDockSnapshotFixture(date: string, taskId: string) {
  return {
    localStorage: JSON.stringify({
      version: 7,
      savedAt: `${date}T00:00:00.000Z`,
      entries: [{ taskId }],
    }),
    indexedDb: {
      version: 7,
      savedAt: `${date}T00:01:00.000Z`,
      entries: [{ taskId }],
    },
  };
}

function makeLaunchSnapshotFixture(
  date: string,
  view: 'text' | 'flow',
  colorMode: 'light' | 'dark',
) {
  const common = {
    userId: 'user-1',
    activeProjectId: 'project-1',
    theme: 'default',
    colorMode,
    projects: [],
  };
  return {
    v1: JSON.stringify({
      version: 1,
      ...common,
      savedAt: `${date}T00:00:00.000Z`,
      lastActiveView: view,
    }),
    v2: JSON.stringify({
      version: 2,
      ...common,
      savedAt: `${date}T00:01:00.000Z`,
      lastActiveView: view,
      preferredView: view,
      resolvedLaunchView: view,
      routeIntent: { kind: 'project', projectId: 'project-1', taskId: null },
      mobileDegraded: false,
      degradeReason: null,
      currentProject: null,
    }),
  };
}

function makeParkedTaskCacheFixture(taskId: string, content: string, updatedAt: string) {
  return {
    entries: [{
      ownerUserId: 'user-1',
      taskId: `${encodeURIComponent('user-1')}:${taskId}`,
      projectId: 'project-1',
      task: { ...task, id: taskId, content },
      updatedAt,
    }],
    syncMetadata: {
      [`parking_last_sync_time:${encodeURIComponent('user-1')}`]: updatedAt,
    },
  };
}

function makeRetryQueueFixture(
  id: string,
  taskId: string,
  retryCount: number,
  createdAt: number,
) {
  return {
    id,
    operationId: createDerivedSyncOperationId(id, LEGACY_RETRY_QUEUE_OPERATION_ID_PURPOSE),
    type: 'task',
    operation: 'upsert',
    data: { id: taskId },
    retryCount,
    createdAt,
    sourceUserId: 'user-1',
    projectId: 'project-1',
  };
}

function makeActionQueueFixture(
  id: string,
  taskId: string,
  retryCount: number,
  timestamp: number,
) {
  return {
    id,
    operationId: createDerivedSyncOperationId(id, LEGACY_ACTION_QUEUE_OPERATION_ID_PURPOSE),
    entityType: 'task',
    entityId: taskId,
    type: 'update',
    payload: { taskId, projectId: 'project-1' },
    retryCount,
    timestamp,
  };
}

async function clearInterruptedRestoreParkedTaskCache(): Promise<void> {
  const db = await openInterruptedRestoreFocusDb();
  try {
    const tx = db.transaction([
      FOCUS_CONFIG.IDB_STORES.PARKED_TASKS,
      FOCUS_CONFIG.IDB_STORES.SYNC_METADATA,
    ], 'readwrite');
    tx.objectStore(FOCUS_CONFIG.IDB_STORES.PARKED_TASKS).clear();
    tx.objectStore(FOCUS_CONFIG.IDB_STORES.SYNC_METADATA).clear();
    await waitForTransaction(tx);
  } finally {
    db.close();
  }
}

function openInterruptedRestoreFocusDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(FOCUS_CONFIG.SYNC.IDB_NAME, FOCUS_CONFIG.SYNC.IDB_VERSION);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(FOCUS_CONFIG.IDB_STORES.PARKED_TASKS)) {
        db.createObjectStore(FOCUS_CONFIG.IDB_STORES.PARKED_TASKS, { keyPath: 'taskId' });
      }
      if (!db.objectStoreNames.contains(FOCUS_CONFIG.IDB_STORES.SYNC_METADATA)) {
        db.createObjectStore(FOCUS_CONFIG.IDB_STORES.SYNC_METADATA, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}
