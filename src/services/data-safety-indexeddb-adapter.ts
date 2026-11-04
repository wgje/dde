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
  type DataSafetyLocalStateSnapshot,
  type DataSafetyOfflineSnapshotMirrors,
  type DataSafetyQueuedAction,
  type DataSafetyReplayEntry,
  type DataSafetyRestorePlan,
  type DataSafetyRetryQueueItem,
} from './data-safety-package';
import {
  clearDataSafetyRestoreMarker,
  claimExpiredDataSafetyRestoreMarker,
  collectTombstoneRestoreValidationErrors,
  formatRestoreError,
  getAllFromStore,
  getFromStore,
  hasDataSafetyRestoreMarkerSentinelOwnership,
  isEntityRecord,
  isDataSafetyRestoreMarkerActive,
  isSyncCursorRecord,
  isUnknownRecord,
  ownsDataSafetyRestoreMarker,
  readDataSafetyRestoreMarker,
  readLocalStateRestoreSnapshot,
  renewDataSafetyRestoreMarkerLease,
  restoreLocalState,
  restoreLocalStateSnapshot,
  waitForTransaction,
  writeDataSafetyRestoreMarker,
  type LocalStateRestoreSnapshot,
  type DataSafetyRestoreMarker,
  type RestorableIndexedDbLocalData,
  type UnknownRecord,
} from './data-safety-indexeddb-local-state';
import { DATA_SAFETY_RESTORE_MARKER_HEARTBEAT_MS } from './data-safety-indexeddb-restore-marker-lease';
import { collectConflictRestoreValidationErrors } from './data-safety-conflict-restore.helpers';
import { collectOfflineSnapshotRestoreValidationErrors } from './data-safety-offline-snapshot-restore.helpers';

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
  legacyRetryReview?: NonNullable<DataSafetyLocalStateSnapshot['legacyRetryReview']>;
  actionQueue?: DataSafetyQueuedAction[];
  deadLetters?: DataSafetyDeadLetterItem[];
  conflicts?: unknown[];
  taskTombstones?: unknown;
  connectionTombstones?: unknown;
  offlineSnapshots?: DataSafetyOfflineSnapshotMirrors | null;
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

class DataSafetyRestoreMarkerOwnershipLostError extends Error {
  constructor() {
    super('data-safety restore marker ownership lost');
    this.name = 'DataSafetyRestoreMarkerOwnershipLostError';
  }
}

interface DataSafetyRestoreMarkerHeartbeat {
  hasOwnership: () => boolean;
  verifyOwnership: () => Promise<boolean>;
  stop: () => Promise<void>;
}

function startDataSafetyRestoreMarkerHeartbeat(
  marker: DataSafetyRestoreMarker,
): DataSafetyRestoreMarkerHeartbeat {
  let ownershipLost = false;
  let refreshInFlight: Promise<boolean> | null = null;
  const refresh = (): Promise<boolean> => {
    if (ownershipLost) return Promise.resolve(false);
    if (refreshInFlight) return refreshInFlight;
    const activeRefresh = (async () => {
      try {
        ownershipLost ||= !await renewDataSafetyRestoreMarkerLease(marker);
      } catch {
        ownershipLost = true;
      }
      return !ownershipLost;
    })();
    refreshInFlight = activeRefresh;
    void activeRefresh.finally(() => {
      if (refreshInFlight === activeRefresh) refreshInFlight = null;
    });
    return activeRefresh;
  };
  const timer = setInterval(() => {
    void refresh();
  }, DATA_SAFETY_RESTORE_MARKER_HEARTBEAT_MS);
  return {
    hasOwnership: () => !ownershipLost
      && hasDataSafetyRestoreMarkerSentinelOwnership(marker),
    verifyOwnership: refresh,
    stop: async () => {
      clearInterval(timer);
      await refreshInFlight;
    },
  };
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
      legacyRetryReview: options.legacyRetryReview ?? [],
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
  const validationFailure = validateRestorePackage(pkg);
  if (validationFailure) return validationFailure;

  return restoreValidatedDataSafetyPackageToIndexedDb(db, pkg);
}

async function restoreValidatedDataSafetyPackageToIndexedDb(
  db: IDBDatabase,
  pkg: DataSafetyExportPackage,
): Promise<IndexedDbDataSafetyRestoreResult> {
  const pendingRecovery = await recoverInterruptedDataSafetyRestoreFromIndexedDb(db, pkg.ownerUserId);
  if (pendingRecovery.errors.length > 0) {
    return {
      success: false,
      plan: emptyRestorePlan(pendingRecovery.errors),
      errors: pendingRecovery.errors,
    };
  }

  return executeDataSafetyRestore(db, pkg);
}

async function executeDataSafetyRestore(
  db: IDBDatabase,
  pkg: DataSafetyExportPackage,
): Promise<IndexedDbDataSafetyRestoreResult> {
  const current = await readCurrentLocalData(db);
  const plan = buildRestorePlan(pkg, current);
  const localStatePreflightErrors = collectLocalStatePreflightErrors(pkg);
  if (localStatePreflightErrors.length > 0) {
    return buildLocalStatePreflightFailure(plan, localStatePreflightErrors);
  }

  const { rollbackSnapshot, localStateRollbackSnapshot } = await readRestoreRollbackSnapshots(db, pkg);

  let restoreMarker: DataSafetyRestoreMarker | null = null;
  let markerHeartbeat: DataSafetyRestoreMarkerHeartbeat | null = null;
  try {
    restoreMarker = await writeDataSafetyRestoreMarker(
      pkg.ownerUserId,
      rollbackSnapshot,
      localStateRollbackSnapshot,
    );
    markerHeartbeat = startDataSafetyRestoreMarkerHeartbeat(restoreMarker);
    await restorePackageToDatabase(db, pkg);
    if (!await markerHeartbeat.verifyOwnership()) {
      throw new DataSafetyRestoreMarkerOwnershipLostError();
    }
    await restoreLocalState(pkg, localStateRollbackSnapshot.retryQueueRestoreItems);
    if (
      !await markerHeartbeat.verifyOwnership()
      || !await clearDataSafetyRestoreMarker(restoreMarker)
    ) {
      throw new DataSafetyRestoreMarkerOwnershipLostError();
    }
  } catch (error) {
    const errors = await resolveDataSafetyRestoreFailure(
      error,
      db,
      pkg,
      rollbackSnapshot,
      localStateRollbackSnapshot,
      restoreMarker,
      markerHeartbeat,
    );
    return { success: false, plan: { ...plan, errors: [...plan.errors, ...errors] }, errors };
  } finally {
    await markerHeartbeat?.stop();
  }

  return { success: true, plan, errors: [] };
}

async function resolveDataSafetyRestoreFailure(
  error: unknown,
  db: IDBDatabase,
  pkg: DataSafetyExportPackage,
  rollbackSnapshot: RestorableIndexedDbLocalData,
  localStateRollbackSnapshot: LocalStateRestoreSnapshot,
  restoreMarker: DataSafetyRestoreMarker | null,
  markerHeartbeat: DataSafetyRestoreMarkerHeartbeat | null,
): Promise<string[]> {
  if (error instanceof DataSafetyRestoreMarkerOwnershipLostError) return [error.message];
  return await rollbackFailedRestore(
    db,
    pkg,
    rollbackSnapshot,
    localStateRollbackSnapshot,
    restoreMarker,
    markerHeartbeat,
    error,
  );
}

async function readRestoreRollbackSnapshots(
  db: IDBDatabase,
  pkg: DataSafetyExportPackage,
): Promise<{
  rollbackSnapshot: RestorableIndexedDbLocalData;
  localStateRollbackSnapshot: LocalStateRestoreSnapshot;
}> {
  const rollbackSnapshot = await readRestorableCurrentLocalData(db);
  const localStateRollbackSnapshot = await readLocalStateRestoreSnapshot(
    pkg.ownerUserId,
    pkg.localState.retryQueue,
  );
  return { rollbackSnapshot, localStateRollbackSnapshot };
}

function buildLocalStatePreflightFailure(
  plan: DataSafetyRestorePlan,
  errors: string[],
): IndexedDbDataSafetyRestoreResult {
  return {
    success: false,
    plan: { ...plan, errors: [...plan.errors, ...errors] },
    errors,
  };
}

function validateRestorePackage(
  pkg: DataSafetyExportPackage,
): IndexedDbDataSafetyRestoreResult | null {
  const validation = validateDataSafetyExportPackage(pkg);
  if (validation.valid) return null;
  return {
    success: false,
    plan: emptyRestorePlan(validation.errors),
    errors: validation.errors,
  };
}

function collectLocalStatePreflightErrors(pkg: DataSafetyExportPackage): string[] {
  return [
    ...collectTombstoneRestoreValidationErrors(pkg),
    ...collectConflictRestoreValidationErrors(pkg),
    ...collectOfflineSnapshotRestoreValidationErrors(pkg),
  ];
}

async function rollbackFailedRestore(
  db: IDBDatabase,
  pkg: DataSafetyExportPackage,
  rollbackSnapshot: RestorableIndexedDbLocalData,
  localStateRollbackSnapshot: LocalStateRestoreSnapshot,
  restoreMarker: DataSafetyRestoreMarker | null,
  markerHeartbeat: DataSafetyRestoreMarkerHeartbeat | null,
  error: unknown,
): Promise<string[]> {
  const restoreFailure = `local-state restore failed: ${formatRestoreError(error)}`;
  if (!restoreMarker) {
    return [restoreFailure];
  }
  if (!await retainsDataSafetyRestoreMarkerOwnership(restoreMarker, markerHeartbeat)) {
    return [
      restoreFailure,
      'data-safety restore marker ownership lost; rollback skipped',
    ];
  }
  const errors = [restoreFailure];
  try {
    await restoreLocalStateSnapshot(
      pkg.ownerUserId,
      localStateRollbackSnapshot,
      markerHeartbeat?.hasOwnership ?? (() => true),
    );
  } catch (localStateRollbackError) {
    errors.push(`local-state rollback failed: ${formatRestoreError(localStateRollbackError)}`);
  }
  if (!await retainsDataSafetyRestoreMarkerOwnership(restoreMarker, markerHeartbeat)) {
    errors.push('data-safety restore marker ownership lost before primary-store rollback');
    return errors;
  }
  try {
    await restoreLocalDataToDatabase(db, rollbackSnapshot);
  } catch (rollbackError) {
    errors.push(`primary-store rollback failed: ${formatRestoreError(rollbackError)}`);
  }
  if (errors.length === 1) {
    try {
      if (!await clearDataSafetyRestoreMarker(restoreMarker)) {
        errors.push('restore marker ownership lost during rollback clear');
      }
    } catch (markerClearError) {
      errors.push(`restore marker clear failed: ${formatRestoreError(markerClearError)}`);
    }
  }
  return errors;
}

async function retainsDataSafetyRestoreMarkerOwnership(
  marker: DataSafetyRestoreMarker,
  heartbeat: DataSafetyRestoreMarkerHeartbeat | null,
): Promise<boolean> {
  return await ownsDataSafetyRestoreMarker(marker)
    && (heartbeat === null || await heartbeat.verifyOwnership());
}

export async function recoverInterruptedDataSafetyRestoreFromIndexedDb(
  db: IDBDatabase,
  ownerUserId: string,
): Promise<IndexedDbDataSafetyRestoreRecoveryResult> {
  const claim = await claimInterruptedDataSafetyRestoreMarker(ownerUserId);
  if (claim.result) return claim.result;
  const markerHeartbeat = startDataSafetyRestoreMarkerHeartbeat(claim.marker!);
  try {
    return await recoverClaimedInterruptedDataSafetyRestore(
      db,
      ownerUserId,
      claim.marker!,
      markerHeartbeat,
    );
  } finally {
    await markerHeartbeat.stop();
  }
}

interface InterruptedDataSafetyRestoreMarkerClaim {
  marker: DataSafetyRestoreMarker | null;
  result: IndexedDbDataSafetyRestoreRecoveryResult | null;
}

async function claimInterruptedDataSafetyRestoreMarker(
  ownerUserId: string,
): Promise<InterruptedDataSafetyRestoreMarkerClaim> {
  let marker: DataSafetyRestoreMarker | null;
  try {
    marker = await readDataSafetyRestoreMarker(ownerUserId);
  } catch (error) {
    return { marker: null, result: {
      recovered: false,
      errors: [`restore marker validation failed: ${formatRestoreError(error)}`],
    } };
  }
  if (!marker) {
    return { marker: null, result: { recovered: false, errors: [] } };
  }
  if (isDataSafetyRestoreMarkerActive(marker)) {
    return { marker: null, result: {
      recovered: false,
      errors: ['data-safety restore already in progress for this owner'],
    } };
  }
  marker = await claimExpiredDataSafetyRestoreMarker(marker);
  if (!marker) {
    return { marker: null, result: {
      recovered: false,
      errors: ['data-safety restore marker ownership lost before interrupted restore recovery'],
    } };
  }
  return { marker, result: null };
}

async function recoverClaimedInterruptedDataSafetyRestore(
  db: IDBDatabase,
  ownerUserId: string,
  marker: DataSafetyRestoreMarker,
  markerHeartbeat: DataSafetyRestoreMarkerHeartbeat,
): Promise<IndexedDbDataSafetyRestoreRecoveryResult> {
  const errors: string[] = [];
  try {
    await restoreInterruptedLocalStateSnapshot(ownerUserId, marker, markerHeartbeat);
  } catch (error) {
    errors.push(`local-state interrupted restore recovery failed: ${formatRestoreError(error)}`);
  }
  if (!await markerHeartbeat.verifyOwnership()) {
    return {
      recovered: false,
      errors: ['data-safety restore marker ownership lost during interrupted restore recovery'],
    };
  }
  try {
    await restoreLocalDataToDatabase(db, marker.primaryStoreSnapshot);
  } catch (error) {
    errors.push(`primary-store interrupted restore recovery failed: ${formatRestoreError(error)}`);
  }

  if (!await markerHeartbeat.verifyOwnership()) {
    return {
      recovered: false,
      errors: ['data-safety restore marker ownership lost during interrupted restore recovery'],
    };
  }

  if (errors.length > 0) {
    return { recovered: false, errors };
  }

  try {
    if (!await clearDataSafetyRestoreMarker(marker)) {
      return {
        recovered: false,
        errors: ['restore marker ownership lost during interrupted restore recovery'],
      };
    }
  } catch (error) {
    return {
      recovered: true,
      errors: [`restore marker clear failed: ${formatRestoreError(error)}`],
    };
  }

  return { recovered: true, errors: [] };
}

function restoreInterruptedLocalStateSnapshot(
  ownerUserId: string,
  marker: DataSafetyRestoreMarker,
  markerHeartbeat: DataSafetyRestoreMarkerHeartbeat,
): Promise<void> {
  return restoreLocalStateSnapshot(
    ownerUserId,
    marker.localStateSnapshot,
    markerHeartbeat.hasOwnership,
  );
}

function emptyRestorePlan(errors: string[]): DataSafetyRestorePlan {
  return {
    idRemappingRequired: false,
    operations: [],
    summary: { writes: 0, skips: 0, deletes: 0 },
    errors,
  };
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
