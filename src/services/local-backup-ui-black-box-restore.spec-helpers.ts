import type { BlackBoxEntry } from '../models/focus';
import type { BackupData, BackupBlackBoxEntry } from '../../supabase/functions/_shared/backup-utils';
import type {
  LocalBackupUiBlackBoxPersistedEntry,
  LocalBackupUiBlackBoxRestoreDependencies,
} from './local-backup-ui-black-box-restore.types';

const DB_NAME = 'local-backup-ui-black-box-restore-spec';
const STORE_NAME = 'black_box_entries';

export const OWNER_A = 'owner-a';
export const OWNER_B = 'owner-b';
export const SOURCE_DIGEST = `sha256:${'a'.repeat(64)}`;

export function makeBlackBoxEntry(
  label: string,
  overrides: Partial<LocalBackupUiBlackBoxPersistedEntry> = {},
): LocalBackupUiBlackBoxPersistedEntry {
  const timestamp = '2026-08-03T00:00:00.000Z';
  return {
    id: crypto.randomUUID(),
    projectId: null,
    userId: OWNER_A,
    content: label,
    date: '2026-08-03',
    createdAt: timestamp,
    updatedAt: timestamp,
    isRead: false,
    isCompleted: false,
    isArchived: false,
    deletedAt: null,
    _localVersion: 2,
    ...overrides,
  };
}

export function toBackupEntry(entry: BlackBoxEntry): BackupBlackBoxEntry {
  return {
    id: entry.id,
    projectId: entry.projectId,
    userId: entry.userId,
    content: entry.content,
    date: entry.date,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    completedAt: entry.completedAt,
    isRead: entry.isRead,
    isCompleted: entry.isCompleted,
    isArchived: entry.isArchived,
    snoozeUntil: entry.snoozeUntil,
    snoozeCount: entry.snoozeCount,
    deletedAt: entry.deletedAt,
    focusMeta: entry.focusMeta,
  };
}

export function makeBackup(entries: BackupBlackBoxEntry[]): BackupData {
  return {
    version: '1.0.0',
    payloadVersion: '1.1.0',
    type: 'full',
    createdAt: '2026-08-03T00:00:00.000Z',
    checksum: 'internal-checksum',
    tableCounts: {
      projects: 0,
      tasks: 0,
      connections: 0,
      userPreferences: 0,
      blackBoxEntries: entries.length,
      focusSessions: 0,
      transcriptionUsage: 0,
      routineTasks: 0,
      routineCompletions: 0,
    },
    coverage: {
      includesProjectData: true,
      includesCloudUserState: true,
      includesLocalState: true,
    },
    projects: [],
    tasks: [],
    connections: [],
    userPreferences: [],
    blackBoxEntries: entries,
    focusSessions: [],
    transcriptionUsage: [],
    routineTasks: [],
    routineCompletions: [],
  };
}

export async function resetBlackBoxRestoreSpecDatabase(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('spec database delete blocked'));
  });
}

export async function seedBlackBoxRows(
  rows: LocalBackupUiBlackBoxPersistedEntry[],
): Promise<void> {
  const db = await openSpecDatabase();
  try {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.clear();
    for (const row of rows) store.put(row);
    await waitForTransaction(tx);
  } finally {
    db.close();
  }
}

export async function readBlackBoxRows(): Promise<LocalBackupUiBlackBoxPersistedEntry[]> {
  const db = await openSpecDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const request = tx.objectStore(STORE_NAME).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export function createBlackBoxRestoreDependencies(
  published: BlackBoxEntry[][],
  events: string[] = [],
  createGeneration: () => string = () => crypto.randomUUID(),
): LocalBackupUiBlackBoxRestoreDependencies {
  return {
    createGeneration,
    withDatabase: async operation => {
      const db = await openSpecDatabase();
      try {
        return await operation(db, STORE_NAME);
      } finally {
        db.close();
      }
    },
    publish: entries => {
      events.push('publish');
      published.push(structuredClone(entries));
    },
  };
}

function openSpecDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

function waitForTransaction(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('spec transaction aborted'));
  });
}
