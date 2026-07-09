import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Connection, Project, Task } from '../../../../models';
import { DB_CONFIG } from './indexeddb.service';
import {
  backupDatabaseNameForDate,
  deleteRawIndexedDbDatabase,
  readBackupPayload,
  restoreBackupPayloadToMainDatabase,
  writeBackupPayload,
  type BackupPayload,
  type BackupStoreMeta,
} from './backup-transaction.helpers';

function openDatabase(
  dbName: string,
  upgrade: (db: IDBDatabase) => void,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, 1);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => upgrade(request.result);
    request.onsuccess = () => resolve(request.result);
  });
}

function ensureMainStores(db: IDBDatabase): void {
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

function ensureBackupStores(db: IDBDatabase): void {
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
    db.createObjectStore(DB_CONFIG.stores.meta);
  }
  if (!db.objectStoreNames.contains(DB_CONFIG.stores.syncCursors)) {
    db.createObjectStore(DB_CONFIG.stores.syncCursors, { keyPath: 'key' });
  }
}

function getStoreValue<T>(
  db: IDBDatabase,
  storeName: string,
  key: IDBValidKey,
): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const request = tx.objectStore(storeName).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
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

const project = {
  id: 'project-1',
  name: 'Project',
  description: '',
  createdDate: '2026-01-01T00:00:00.000Z',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  tasks: [],
  connections: [],
} satisfies Project & { createdAt: string };
const task = {
  id: 'task-1',
  title: 'Task',
  content: 'Content',
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
  target: 'task-2',
  fromTaskId: 'task-1',
  toTaskId: 'task-2',
  projectId: 'project-1',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
} satisfies Connection & {
  fromTaskId: string;
  toTaskId: string;
  projectId: string;
  createdAt: string;
};
const cursor = {
  key: 'project:user',
  cursor: { updatedAt: '2026-01-02T00:00:00.000Z', entityType: 'task', id: 'task-1' },
};
const meta = {
  key: 'meta',
  version: 3,
  lastSyncTime: '2026-01-02T00:00:00.000Z',
  activeProjectId: 'project-1',
} satisfies BackupStoreMeta;

describe('backup transaction helpers', () => {
  const dbNames = ['backup-helper-main', 'backup-helper-backup'];
  let opened: IDBDatabase[] = [];

  beforeEach(async () => {
    await Promise.all(dbNames.map((name) => deleteRawIndexedDbDatabase(name).catch(() => undefined)));
    opened = [];
  });

  afterEach(async () => {
    opened.forEach((db) => db.close());
    await Promise.all(dbNames.map((name) => deleteRawIndexedDbDatabase(name).catch(() => undefined)));
  });

  it('builds daily backup names from local backup dates', () => {
    expect(backupDatabaseNameForDate(new Date('2026-06-09T15:30:00.000Z'))).toBe('nanoflow-db-backup-20260609');
  });

  it('writes and reads the complete backup payload including metadata timestamp', async () => {
    const db = await openDatabase(dbNames[1], ensureBackupStores);
    opened.push(db);
    const payload: BackupPayload = {
      projects: [project],
      tasks: [task],
      connections: [connection],
      syncCursors: [cursor],
      meta,
    };

    await writeBackupPayload(db, payload, '2026-06-09T10:00:00.000Z');

    await expect(readBackupPayload(db)).resolves.toEqual({
      ...payload,
      meta: { ...meta, backupTime: '2026-06-09T10:00:00.000Z' },
    });
  });

  it('restores a backup payload atomically into the main schema meta store', async () => {
    const db = await openDatabase(dbNames[0], ensureMainStores);
    opened.push(db);
    const payload: BackupPayload = {
      projects: [project],
      tasks: [task],
      connections: [connection],
      syncCursors: [cursor],
      meta,
    };

    await restoreBackupPayloadToMainDatabase(db, payload);

    await expect(getAllStoreValues<Project>(db, DB_CONFIG.stores.projects)).resolves.toEqual([project]);
    await expect(getAllStoreValues<Task>(db, DB_CONFIG.stores.tasks)).resolves.toEqual([task]);
    await expect(getAllStoreValues<Connection>(db, DB_CONFIG.stores.connections)).resolves.toEqual([connection]);
    await expect(getAllStoreValues<Record<string, unknown>>(db, DB_CONFIG.stores.syncCursors)).resolves.toEqual([cursor]);
    await expect(getStoreValue(db, DB_CONFIG.stores.meta, 'meta')).resolves.toEqual(meta);
  });
});
