import type { Connection, Project, Task } from '../../../../models';
import { DB_CONFIG } from './indexeddb.service';

export const BACKUP_DB_PREFIX = 'nanoflow-db-backup-';

export interface BackupStoreMeta {
  key?: 'meta';
  version: number;
  lastSyncTime: string;
  activeProjectId: string | null;
  lastAuthenticatedUser?: string | null;
  backupTime?: string;
}

export interface BackupPayload {
  projects: Project[];
  tasks: Task[];
  connections: Connection[];
  syncCursors: Array<Record<string, unknown>>;
  meta: BackupStoreMeta | null;
}

const BACKUP_STORE_NAMES = [
  DB_CONFIG.stores.projects,
  DB_CONFIG.stores.tasks,
  DB_CONFIG.stores.connections,
  DB_CONFIG.stores.meta,
  DB_CONFIG.stores.syncCursors,
] as const;

export function backupDatabaseNameForDate(date: Date): string {
  const dateStr = date.toISOString().split('T')[0].replace(/-/g, '');
  return `${BACKUP_DB_PREFIX}${dateStr}`;
}

export function deleteRawIndexedDbDatabase(dbName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(dbName);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error(`Failed to delete ${dbName}`));
    request.onblocked = () => reject(new Error(`Delete blocked for ${dbName}`));
  });
}

export async function writeBackupPayload(
  backupDb: IDBDatabase,
  payload: BackupPayload,
  backupTime: string,
): Promise<void> {
  const tx = backupDb.transaction([...BACKUP_STORE_NAMES], 'readwrite');
  const projectStore = tx.objectStore(DB_CONFIG.stores.projects);
  const taskStore = tx.objectStore(DB_CONFIG.stores.tasks);
  const connStore = tx.objectStore(DB_CONFIG.stores.connections);
  const metaStore = tx.objectStore(DB_CONFIG.stores.meta);
  const cursorStore = tx.objectStore(DB_CONFIG.stores.syncCursors);

  payload.projects.forEach((project) => projectStore.put(project));
  payload.tasks.forEach((task) => taskStore.put(task));
  payload.connections.forEach((conn) => connStore.put(conn));
  payload.syncCursors.forEach((cursor) => cursorStore.put(cursor));
  if (payload.meta) {
    metaStore.put({ ...payload.meta, backupTime }, 'meta');
  }

  await waitForTransaction(tx);
}

export async function readBackupPayload(backupDb: IDBDatabase): Promise<BackupPayload> {
  const [projects, tasks, connections, syncCursors, meta] = await Promise.all([
    getAllFromBackupStore<Project>(backupDb, DB_CONFIG.stores.projects),
    getAllFromBackupStore<Task>(backupDb, DB_CONFIG.stores.tasks),
    getAllFromBackupStore<Connection>(backupDb, DB_CONFIG.stores.connections),
    backupDb.objectStoreNames.contains(DB_CONFIG.stores.syncCursors)
      ? getAllFromBackupStore<Record<string, unknown>>(backupDb, DB_CONFIG.stores.syncCursors)
      : Promise.resolve([]),
    getFromBackupStore<BackupStoreMeta>(backupDb, DB_CONFIG.stores.meta, 'meta'),
  ]);

  return { projects, tasks, connections, syncCursors, meta };
}

export async function restoreBackupPayloadToMainDatabase(
  db: IDBDatabase,
  payload: BackupPayload,
): Promise<void> {
  const tx = db.transaction([...BACKUP_STORE_NAMES], 'readwrite');
  const projectStore = tx.objectStore(DB_CONFIG.stores.projects);
  const taskStore = tx.objectStore(DB_CONFIG.stores.tasks);
  const connStore = tx.objectStore(DB_CONFIG.stores.connections);
  const metaStore = tx.objectStore(DB_CONFIG.stores.meta);
  const cursorStore = tx.objectStore(DB_CONFIG.stores.syncCursors);

  projectStore.clear();
  taskStore.clear();
  connStore.clear();
  metaStore.clear();
  cursorStore.clear();

  payload.projects.forEach((project) => projectStore.put(project));
  payload.tasks.forEach((task) => taskStore.put(task));
  payload.connections.forEach((conn) => connStore.put(conn));
  payload.syncCursors.forEach((cursor) => cursorStore.put(cursor));
  if (payload.meta) {
    metaStore.put({ ...payload.meta, key: 'meta' });
  }

  await waitForTransaction(tx);
}

function getAllFromBackupStore<T>(db: IDBDatabase, storeName: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const request = tx.objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result ?? []);
    request.onerror = () => reject(request.error);
  });
}

function getFromBackupStore<T>(
  db: IDBDatabase,
  storeName: string,
  key: IDBValidKey,
): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const request = tx.objectStore(storeName).get(key);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
  });
}

function waitForTransaction(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}
