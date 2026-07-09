import { DB_CONFIG } from '../app/core/state/persistence/indexeddb.service';
import {
  buildDataSafetyExportPackage,
  buildRestorePlan,
  validateDataSafetyExportPackage,
  type DataSafetyAppSnapshot,
  type DataSafetyCurrentLocalData,
  type DataSafetyDeadLetterItem,
  type DataSafetyExportPackage,
  type DataSafetyLastWriteExplain,
  type DataSafetyQueuedAction,
  type DataSafetyReplayEntry,
  type DataSafetyRestorePlan,
  type DataSafetyRetryQueueItem,
} from './data-safety-package';
import {
  clearDataSafetyRestoreMarker,
  formatRestoreError,
  getAllFromStore,
  getFromStore,
  isEntityRecord,
  isSyncCursorRecord,
  isUnknownRecord,
  readDataSafetyRestoreMarker,
  readLocalStateRestoreSnapshot,
  restoreLocalState,
  restoreLocalStateSnapshot,
  waitForTransaction,
  writeDataSafetyRestoreMarker,
  type LocalStateRestoreSnapshot,
  type RestorableIndexedDbLocalData,
  type UnknownRecord,
} from './data-safety-indexeddb-local-state';

interface IndexedDbDataSafetySnapshotRows {
  projects: UnknownRecord[];
  tasks: UnknownRecord[];
  connections: UnknownRecord[];
  syncCursors: UnknownRecord[];
  meta: UnknownRecord | null;
}

const DATA_SAFETY_STORE_NAMES = [
  DB_CONFIG.stores.projects,
  DB_CONFIG.stores.tasks,
  DB_CONFIG.stores.connections,
  DB_CONFIG.stores.meta,
  DB_CONFIG.stores.syncCursors,
] as const;

export interface IndexedDbDataSafetyExportOptions {
  exportedAt: string;
  ownerUserId: string;
  app: DataSafetyAppSnapshot;
  retryQueue?: DataSafetyRetryQueueItem[];
  actionQueue?: DataSafetyQueuedAction[];
  deadLetters?: DataSafetyDeadLetterItem[];
  conflicts?: unknown[];
  taskTombstones?: unknown;
  connectionTombstones?: unknown;
  offlineSnapshots?: unknown;
  replayLog?: DataSafetyReplayEntry[];
  lastWriteExplain?: DataSafetyLastWriteExplain | null;
}

export interface IndexedDbDataSafetyRestoreResult {
  success: boolean;
  plan: DataSafetyRestorePlan;
  errors: string[];
}

export interface IndexedDbDataSafetyRestoreRecoveryResult {
  recovered: boolean;
  errors: string[];
}

export async function exportDataSafetyPackageFromIndexedDb(
  db: IDBDatabase,
  options: IndexedDbDataSafetyExportOptions,
): Promise<DataSafetyExportPackage> {
  const [projects, tasks, connections, syncCursors, meta] = await Promise.all([
    getAllFromStore<UnknownRecord>(db, DB_CONFIG.stores.projects),
    getAllFromStore<UnknownRecord>(db, DB_CONFIG.stores.tasks),
    getAllFromStore<UnknownRecord>(db, DB_CONFIG.stores.connections),
    getAllFromStore<UnknownRecord>(db, DB_CONFIG.stores.syncCursors),
    getFromStore<UnknownRecord>(db, DB_CONFIG.stores.meta, 'meta'),
  ]);
  const retryQueue = options.retryQueue ?? [];
  const actionQueue = options.actionQueue ?? [];
  const deadLetters = options.deadLetters ?? [];

  return buildDataSafetyExportPackageFromRows(
    { projects, tasks, connections, syncCursors, meta },
    { retryQueue, actionQueue, deadLetters },
    options,
  );
}

function buildDataSafetyExportPackageFromRows(
  rows: IndexedDbDataSafetySnapshotRows,
  queues: {
    retryQueue: DataSafetyRetryQueueItem[];
    actionQueue: DataSafetyQueuedAction[];
    deadLetters: DataSafetyDeadLetterItem[];
  },
  options: IndexedDbDataSafetyExportOptions,
): DataSafetyExportPackage {
  const syncCursors = rows.syncCursors.filter(isSyncCursorRecord);

  return buildDataSafetyExportPackage({
    exportedAt: options.exportedAt,
    ownerUserId: options.ownerUserId,
    app: options.app,
    localData: {
      projects: rows.projects.filter(isEntityRecord),
      tasks: rows.tasks.filter(isEntityRecord),
      connections: rows.connections.filter(isEntityRecord),
      syncCursors,
      meta: rows.meta,
    },
    localState: {
      retryQueue: queues.retryQueue,
      actionQueue: queues.actionQueue,
      deadLetters: queues.deadLetters,
      conflicts: options.conflicts ?? [],
      taskTombstones: options.taskTombstones ?? {},
      connectionTombstones: options.connectionTombstones ?? [],
      offlineSnapshots: options.offlineSnapshots,
    },
    syncSnapshot: {
      syncState: {
        lastSyncTime: readLastSyncTime(rows.meta),
        pendingCount: queues.retryQueue.length + queues.actionQueue.length,
      },
      projectCursors: syncCursors.map(cursor => ({
        projectId: parseProjectIdFromCursorKey(cursor['key']),
        userId: options.ownerUserId,
        cursor: cursor['cursor'] ?? cursor,
      })),
      queueCounts: {
        retryQueue: queues.retryQueue.length,
        actionQueue: queues.actionQueue.length,
        deadLetters: queues.deadLetters.length,
      },
    },
    replayLog: options.replayLog ?? [],
    lastWriteExplain: options.lastWriteExplain ?? null,
  });
}

export async function restoreDataSafetyPackageToIndexedDb(
  db: IDBDatabase,
  pkg: DataSafetyExportPackage,
): Promise<IndexedDbDataSafetyRestoreResult> {
  const validation = validateDataSafetyExportPackage(pkg);
  if (!validation.valid) {
    return {
      success: false,
      plan: emptyRestorePlan(validation.errors),
      errors: validation.errors,
    };
  }

  const pendingRecovery = await recoverInterruptedDataSafetyRestoreFromIndexedDb(db, pkg.ownerUserId);
  if (pendingRecovery.errors.length > 0) {
    return {
      success: false,
      plan: emptyRestorePlan(pendingRecovery.errors),
      errors: pendingRecovery.errors,
    };
  }

  const current = await readCurrentLocalData(db);
  const plan = buildRestorePlan(pkg, current);
  const unsupportedLocalStateErrors = collectUnsupportedLocalStateRestoreErrors(pkg.localState);
  if (unsupportedLocalStateErrors.length > 0) {
    return {
      success: false,
      plan: { ...plan, errors: [...plan.errors, ...unsupportedLocalStateErrors] },
      errors: unsupportedLocalStateErrors,
    };
  }

  const rollbackSnapshot = await readRestorableCurrentLocalData(db);
  const localStateRollbackSnapshot = await readLocalStateRestoreSnapshot(pkg.ownerUserId);

  try {
    writeDataSafetyRestoreMarker(pkg.ownerUserId, rollbackSnapshot, localStateRollbackSnapshot);
    await restorePackageToDatabase(db, pkg);
    await restoreLocalState(pkg);
    clearDataSafetyRestoreMarker(pkg.ownerUserId);
  } catch (error) {
    const errors = await rollbackFailedRestore(db, pkg, rollbackSnapshot, localStateRollbackSnapshot, error);
    return {
      success: false,
      plan: { ...plan, errors: [...plan.errors, ...errors] },
      errors,
    };
  }

  return { success: true, plan, errors: [] };
}

async function rollbackFailedRestore(
  db: IDBDatabase,
  pkg: DataSafetyExportPackage,
  rollbackSnapshot: RestorableIndexedDbLocalData,
  localStateRollbackSnapshot: LocalStateRestoreSnapshot,
  error: unknown,
): Promise<string[]> {
  const errors = [`local-state restore failed: ${formatRestoreError(error)}`];
  try {
    await restoreLocalStateSnapshot(pkg.ownerUserId, localStateRollbackSnapshot);
  } catch (localStateRollbackError) {
    errors.push(`local-state rollback failed: ${formatRestoreError(localStateRollbackError)}`);
  }
  try {
    await restoreLocalDataToDatabase(db, rollbackSnapshot);
  } catch (rollbackError) {
    errors.push(`primary-store rollback failed: ${formatRestoreError(rollbackError)}`);
  }
  if (errors.length === 1) {
    try {
      clearDataSafetyRestoreMarker(pkg.ownerUserId);
    } catch (markerClearError) {
      errors.push(`restore marker clear failed: ${formatRestoreError(markerClearError)}`);
    }
  }
  return errors;
}

export async function recoverInterruptedDataSafetyRestoreFromIndexedDb(
  db: IDBDatabase,
  ownerUserId: string,
): Promise<IndexedDbDataSafetyRestoreRecoveryResult> {
  const marker = readDataSafetyRestoreMarker(ownerUserId);
  if (!marker) {
    return { recovered: false, errors: [] };
  }

  const errors: string[] = [];
  try {
    await restoreLocalStateSnapshot(ownerUserId, marker.localStateSnapshot);
  } catch (error) {
    errors.push(`local-state interrupted restore recovery failed: ${formatRestoreError(error)}`);
  }
  try {
    await restoreLocalDataToDatabase(db, marker.primaryStoreSnapshot);
  } catch (error) {
    errors.push(`primary-store interrupted restore recovery failed: ${formatRestoreError(error)}`);
  }

  if (errors.length > 0) {
    return { recovered: false, errors };
  }

  try {
    clearDataSafetyRestoreMarker(ownerUserId);
  } catch (error) {
    return {
      recovered: true,
      errors: [`restore marker clear failed: ${formatRestoreError(error)}`],
    };
  }

  return { recovered: true, errors: [] };
}

function emptyRestorePlan(errors: string[]): DataSafetyRestorePlan {
  return {
    idRemappingRequired: false,
    operations: [],
    summary: { writes: 0, skips: 0, deletes: 0 },
    errors,
  };
}

function collectUnsupportedLocalStateRestoreErrors(
  localState: DataSafetyExportPackage['localState'],
): string[] {
  const unsupportedSections: Array<[string, unknown]> = [
    ['localState.conflicts', localState.conflicts],
    ['localState.taskTombstones', localState.taskTombstones],
    ['localState.connectionTombstones', localState.connectionTombstones],
    ['localState.offlineSnapshots', localState.offlineSnapshots],
  ];

  return unsupportedSections
    .filter(([, value]) => hasNonEmptyLocalStatePayload(value))
    .map(([section, value]) => (
      `${section} restore is unsupported; package contains ${describeLocalStatePayload(value)}`
    ));
}

function hasNonEmptyLocalStatePayload(value: unknown): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (isUnknownRecord(value)) {
    return Object.keys(value).length > 0;
  }
  if (typeof value === 'string') {
    return value.length > 0;
  }
  return true;
}

function describeLocalStatePayload(value: unknown): string {
  if (Array.isArray(value)) {
    return `${value.length} item(s)`;
  }
  if (isUnknownRecord(value)) {
    return `${Object.keys(value).length} key(s)`;
  }
  return 'a non-empty value';
}

async function readCurrentLocalData(db: IDBDatabase): Promise<DataSafetyCurrentLocalData> {
  const [projects, tasks, connections, syncCursors] = await Promise.all([
    getAllFromStore<UnknownRecord>(db, DB_CONFIG.stores.projects),
    getAllFromStore<UnknownRecord>(db, DB_CONFIG.stores.tasks),
    getAllFromStore<UnknownRecord>(db, DB_CONFIG.stores.connections),
    getAllFromStore<UnknownRecord>(db, DB_CONFIG.stores.syncCursors),
  ]);

  return {
    projects: projects.filter(isEntityRecord),
    tasks: tasks.filter(isEntityRecord),
    connections: connections.filter(isEntityRecord),
    syncCursors: syncCursors.filter(isSyncCursorRecord),
  };
}

async function readRestorableCurrentLocalData(db: IDBDatabase): Promise<RestorableIndexedDbLocalData> {
  const [current, meta] = await Promise.all([
    readCurrentLocalData(db),
    getFromStore<UnknownRecord>(db, DB_CONFIG.stores.meta, 'meta'),
  ]);

  return { ...current, meta };
}

async function restorePackageToDatabase(
  db: IDBDatabase,
  pkg: DataSafetyExportPackage,
): Promise<void> {
  await restoreLocalDataToDatabase(db, {
    ...pkg.localData,
    meta: isUnknownRecord(pkg.localData.meta) ? pkg.localData.meta : null,
  });
}

async function restoreLocalDataToDatabase(
  db: IDBDatabase,
  localData: RestorableIndexedDbLocalData,
): Promise<void> {
  const tx = db.transaction([...DATA_SAFETY_STORE_NAMES], 'readwrite');
  const projectStore = tx.objectStore(DB_CONFIG.stores.projects);
  const taskStore = tx.objectStore(DB_CONFIG.stores.tasks);
  const connectionStore = tx.objectStore(DB_CONFIG.stores.connections);
  const metaStore = tx.objectStore(DB_CONFIG.stores.meta);
  const cursorStore = tx.objectStore(DB_CONFIG.stores.syncCursors);

  projectStore.clear();
  taskStore.clear();
  connectionStore.clear();
  metaStore.clear();
  cursorStore.clear();

  localData.projects.forEach(project => projectStore.put(project));
  localData.tasks.forEach(task => taskStore.put(task));
  localData.connections.forEach(connection => connectionStore.put(connection));
  localData.syncCursors.forEach(cursor => cursorStore.put(cursor));
  if (localData.meta && typeof localData.meta === 'object') {
    metaStore.put({ ...(localData.meta as UnknownRecord), key: 'meta' });
  }

  await waitForTransaction(tx);
}

function readLastSyncTime(meta: UnknownRecord | null): string | null {
  return typeof meta?.['lastSyncTime'] === 'string' ? meta['lastSyncTime'] : null;
}

function parseProjectIdFromCursorKey(key: unknown): string {
  if (typeof key !== 'string' || key.length === 0) return 'unknown';
  const parts = key.split(':');
  return parts[parts.length - 1] || key;
}
