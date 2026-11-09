/**
 * data-safety local-state 恢复内部实现（从 data-safety-indexeddb-adapter 下切）
 *
 * 职责：RetryQueue / ActionQueue / DeadLetter / 审计 localStorage 的快照读取、
 * 恢复、回滚，以及跨中断恢复所用的 restore marker 读写与归一化。
 * adapter 只保留导出/恢复编排；本模块拥有 local-state 细节与共享的
 * IndexedDB/记录归一化基础工具。
 */
import {
  type DataSafetyCurrentLocalData,
  type DataSafetyEntityRecord,
  type DataSafetyExportPackage,
  type DataSafetySyncCursorRecord,
} from './data-safety-package';
import { LOCAL_QUEUE_CONFIG } from './action-queue-storage.helpers';
import { DataSafetyAuditPersistence } from './data-safety-audit-persistence';
import {
  type DeadLetterBackupRecord,
  type QueueBackupRecord,
} from './queue-backup.service';
import {
  normalizeDeadLetterBackupRecord,
  normalizeQueueBackupRecord,
  readQueueBackupRecord,
  restoreActionQueue,
  restoreDeadLetters,
  restoreQueueBackupRecord,
} from './data-safety-indexeddb-action-queue-local-state';
import {
  normalizeMarkerTombstoneRestoreSnapshot,
  readTombstoneLocalStateSnapshot,
  restoreTombstoneLocalStateSnapshot,
  restoreTombstones,
} from './data-safety-indexeddb-tombstone-local-state';
import {
  normalizeConflictRestoreSnapshot,
  readConflictRestoreSnapshot,
  restoreConflictRestoreSnapshot,
  restoreConflicts,
  type DataSafetyConflictRestoreSnapshot,
} from './data-safety-conflict-restore.helpers';
import {
  normalizeOfflineSnapshotRestoreSnapshot,
  readOfflineSnapshotRestoreSnapshot,
  restoreOfflineSnapshot,
  restoreOfflineSnapshotRestoreSnapshot,
  type DataSafetyOfflineSnapshotRestoreSnapshot,
} from './data-safety-offline-snapshot-restore.helpers';
import {
  createDataSafetyRestoreMarkerLease,
  getDataSafetyRestoreMarkerStorageKey,
  isDataSafetyRestoreMarkerActive,
} from './data-safety-indexeddb-restore-marker-lease';
import {
  createDataSafetyRestoreMarkerJournal,
  type DataSafetyRestoreMarkerJournal,
} from './data-safety-restore-marker-journal';
import {
  prepareRetryQueueRestoreItems,
  readRetryQueueIndexedDbItems,
  restoreRetryQueue,
  rollbackRetryQueueIndexedDb,
  rollbackRetryQueueLocalStorage,
} from './data-safety-indexeddb-retry-queue-local-state';
import {
  normalizeProjectLocalStateMarkerSnapshot,
  readProjectLocalStateRestoreSnapshot,
  restoreDockSnapshotRestoreSnapshot,
  restoreLaunchSnapshotRestoreSnapshot,
  restoreParkedTaskCacheRestoreSnapshot,
  type ProjectLocalStateRestoreSnapshot,
} from './data-safety-indexeddb-local-state-snapshot.helpers';
import {
  mergeLegacyRetryReviewItems,
  ownerScopedLegacyRetryReviewStorageKey,
  parseLegacyRetryReviewStorageValue,
  readOwnerScopedLegacyRetryReviewStorageValue,
  restoreOwnerScopedLegacyRetryReviewStorageValue,
  writeOwnerScopedLegacyRetryReviewItems,
} from './legacy-retry-review-backup.helpers';

export type UnknownRecord = Record<string, unknown>;

export { collectTombstoneRestoreValidationErrors } from './data-safety-indexeddb-tombstone-local-state';
export {
  buildProjectLocalStateRestoreSnapshot,
  normalizeDockSnapshotRestoreSnapshot,
  normalizeLaunchSnapshotRestoreSnapshot,
  normalizeParkedTaskCacheRestoreSnapshot,
  restoreDockSnapshotRestoreSnapshot,
  restoreLaunchSnapshotRestoreSnapshot,
  restoreParkedTaskCacheRestoreSnapshot,
} from './data-safety-indexeddb-local-state-snapshot.helpers';
export type {
  DockSnapshotRestoreSnapshot,
  LaunchSnapshotRestoreSnapshot,
  ParkedTaskCacheRestoreSnapshot,
} from './data-safety-indexeddb-local-state-snapshot.helpers';

const RETRY_QUEUE_LOCAL_STORAGE_KEY = 'nanoflow.retry-queue';
const DATA_SAFETY_AUDIT_STORAGE_KEY_PREFIX = 'nanoflow.data-safety-audit';
const DATA_SAFETY_RESTORE_MARKER_SCHEMA_VERSION = 1;
const NOOP_RESTORE_CHECKPOINT = async (): Promise<void> => undefined;

export interface RestorableIndexedDbLocalData extends DataSafetyCurrentLocalData {
  meta: UnknownRecord | null;
}

export interface LocalStateRestoreSnapshot extends ProjectLocalStateRestoreSnapshot {
  retryQueueIndexedDbItems: UnknownRecord[] | null;
  retryQueueLocalStorageValue: string | null;
  retryQueueRestoreItems?: UnknownRecord[];
  legacyRetryReviewLocalStorageValue?: string | null;
  actionQueueBackupRecord: QueueBackupRecord | null;
  actionQueueLocalStorageValue: string | null;
  deadLetterBackupRecord: DeadLetterBackupRecord | null;
  deadLetterLocalStorageValue: string | null;
  auditLocalStorageValue: string | null;
  taskTombstonesLocalStorageValue?: string | null;
  connectionTombstonesLocalStorageValue?: string | null;
  conflictRestoreSnapshot?: DataSafetyConflictRestoreSnapshot;
  offlineSnapshotRestoreSnapshot?: DataSafetyOfflineSnapshotRestoreSnapshot;
}

export interface DataSafetyRestoreMarker {
  schemaVersion: typeof DATA_SAFETY_RESTORE_MARKER_SCHEMA_VERSION;
  ownerUserId: string;
  runId: string | null;
  createdAt: string;
  leaseExpiresAt: string | null;
  primaryStoreSnapshot: RestorableIndexedDbLocalData;
  localStateSnapshot: LocalStateRestoreSnapshot;
}

export { isDataSafetyRestoreMarkerActive } from './data-safety-indexeddb-restore-marker-lease';

// ==================== local-state 恢复 ====================

export async function restoreLocalState(
  pkg: DataSafetyExportPackage,
  retryQueueRestoreItems = prepareRetryQueueRestoreItems(pkg.ownerUserId, pkg.localState.retryQueue),
): Promise<void> {
  await restoreRetryQueue(pkg.ownerUserId, retryQueueRestoreItems);
  const legacyReviewItems = pkg.localState.legacyRetryReview;
  if (legacyReviewItems !== undefined) {
    const currentItems = parseLegacyRetryReviewStorageValue(
      readOwnerScopedLegacyRetryReviewStorageValue(pkg.ownerUserId),
      pkg.ownerUserId,
    );
    const mergedItems = mergeLegacyRetryReviewItems(
      currentItems,
      legacyReviewItems,
      pkg.ownerUserId,
    );
    writeOwnerScopedLegacyRetryReviewItems(pkg.ownerUserId, mergedItems);
    const actual = parseLegacyRetryReviewStorageValue(
      readOwnerScopedLegacyRetryReviewStorageValue(pkg.ownerUserId),
      pkg.ownerUserId,
    );
    if (JSON.stringify(actual) !== JSON.stringify(mergedItems)) {
      throw new Error('legacy retry review restore read-back failed');
    }
  }
  await restoreActionQueue(pkg.ownerUserId, pkg.localState.actionQueue);
  await restoreDeadLetters(pkg.ownerUserId, pkg.localState.deadLetters);
  restoreTombstones(pkg);
  await restoreConflicts(pkg);
  await restoreOfflineSnapshot(pkg);
  const auditSaved = new DataSafetyAuditPersistence().save(pkg.ownerUserId, {
    replayLog: pkg.replayLog,
    lastWriteExplain: pkg.lastWriteExplain,
  });
  if (!auditSaved) {
    throw new Error('data-safety audit persistence failed');
  }
}

export async function readLocalStateRestoreSnapshot(
  ownerUserId: string,
  retryQueueItems: DataSafetyExportPackage['localState']['retryQueue'] = [],
): Promise<LocalStateRestoreSnapshot> {
  const retryQueueRestoreItems = prepareRetryQueueRestoreItems(ownerUserId, retryQueueItems);
  const [
    retryQueueIndexedDbItems,
    actionQueueBackupRecord,
    deadLetterBackupRecord,
    conflictRestoreSnapshot,
    offlineSnapshotRestoreSnapshot,
    projectLocalStateRestoreSnapshot,
  ] = await Promise.all([
    readRetryQueueIndexedDbItems(),
    readQueueBackupRecord<QueueBackupRecord>(`queue-backup:${ownerUserId}`),
    readQueueBackupRecord<DeadLetterBackupRecord>(`dead-letter-backup:${ownerUserId}`),
    readConflictRestoreSnapshot(ownerUserId),
    readOfflineSnapshotRestoreSnapshot(ownerUserId),
    readProjectLocalStateRestoreSnapshot(ownerUserId),
  ]);

  const legacyReviewStorageKey = ownerScopedLegacyRetryReviewStorageKey(ownerUserId);
  const legacyRetryReviewLocalStorageValue = readLocalStorageValue(legacyReviewStorageKey);
  parseLegacyRetryReviewStorageValue(legacyRetryReviewLocalStorageValue, ownerUserId);

  return {
    retryQueueIndexedDbItems,
    retryQueueLocalStorageValue: readLocalStorageValue(RETRY_QUEUE_LOCAL_STORAGE_KEY),
    retryQueueRestoreItems,
    legacyRetryReviewLocalStorageValue,
    actionQueueBackupRecord,
    actionQueueLocalStorageValue: readLocalStorageValue(`${LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY}.${ownerUserId}`),
    deadLetterBackupRecord,
    deadLetterLocalStorageValue: readLocalStorageValue(`${LOCAL_QUEUE_CONFIG.DEAD_LETTER_STORAGE_KEY}.${ownerUserId}`),
    auditLocalStorageValue: readLocalStorageValue(`${DATA_SAFETY_AUDIT_STORAGE_KEY_PREFIX}.${ownerUserId}`),
    ...readTombstoneLocalStateSnapshot(),
    conflictRestoreSnapshot,
    offlineSnapshotRestoreSnapshot,
    ...projectLocalStateRestoreSnapshot,
  };
}

export async function restoreLocalStateSnapshot(
  ownerUserId: string,
  snapshot: LocalStateRestoreSnapshot,
  canContinue: () => boolean = () => true,
): Promise<void> {
  const errors: string[] = [];
  await restoreRetryQueueLocalStateSnapshot(ownerUserId, snapshot, canContinue, errors);
  await attemptLocalStateRollback(errors, 'legacyRetryReview localStorage', () => {
    restoreOwnerScopedLegacyRetryReviewStorageValue(
      ownerUserId,
      snapshot.legacyRetryReviewLocalStorageValue,
    );
  });
  assertLocalStateRestoreContinuation(errors, canContinue);
  await restoreQueueBacklogLocalStateSnapshot(ownerUserId, snapshot, canContinue, errors);
  await restoreTombstoneLocalStateSnapshot(snapshot, errors);
  assertLocalStateRestoreContinuation(errors, canContinue);
  await restoreExtendedLocalStateSnapshot(ownerUserId, snapshot, errors);
  assertLocalStateRestoreContinuation(errors, canContinue);
  await attemptLocalStateRollback(errors, 'dataSafetyAudit localStorage', () => {
    restoreLocalStorageValue(
      `${DATA_SAFETY_AUDIT_STORAGE_KEY_PREFIX}.${ownerUserId}`,
      snapshot.auditLocalStorageValue,
    );
  });
  assertLocalStateRestoreContinuation(errors, canContinue);

  if (errors.length > 0) throw new Error(errors.join('; '));
}

export async function restoreRetryQueueRestoreSnapshot(
  ownerUserId: string,
  snapshot: Pick<
    LocalStateRestoreSnapshot,
    'retryQueueIndexedDbItems' | 'retryQueueLocalStorageValue'
  >,
  restoredItems: UnknownRecord[] = [],
  canContinue: () => boolean = () => true,
  checkpoint: () => Promise<void> = NOOP_RESTORE_CHECKPOINT,
): Promise<void> {
  const errors: string[] = [];
  await restoreRetryQueueLocalStateSnapshot(ownerUserId, {
    ...snapshot,
    retryQueueRestoreItems: restoredItems,
  } as LocalStateRestoreSnapshot, canContinue, errors, checkpoint);
  if (errors.length > 0) throw new Error(errors.join('; '));
}

export async function restoreActionQueueRestoreSnapshot(
  ownerUserId: string,
  snapshot: Pick<
    LocalStateRestoreSnapshot,
    'actionQueueBackupRecord' | 'actionQueueLocalStorageValue'
  >,
  canContinue: () => boolean = () => true,
  checkpoint: () => Promise<void> = NOOP_RESTORE_CHECKPOINT,
): Promise<void> {
  const errors: string[] = [];
  await restoreActionQueueLocalStateSnapshot(ownerUserId, snapshot, canContinue, errors, checkpoint);
  if (errors.length > 0) throw new Error(errors.join('; '));
}

export async function restoreDeadLetterRestoreSnapshot(
  ownerUserId: string,
  snapshot: Pick<
    LocalStateRestoreSnapshot,
    'deadLetterBackupRecord' | 'deadLetterLocalStorageValue'
  >,
  canContinue: () => boolean = () => true,
  checkpoint: () => Promise<void> = NOOP_RESTORE_CHECKPOINT,
): Promise<void> {
  const errors: string[] = [];
  await restoreDeadLetterLocalStateSnapshot(ownerUserId, snapshot, canContinue, errors, checkpoint);
  if (errors.length > 0) throw new Error(errors.join('; '));
}

export async function restoreConflictRestoreStateSnapshot(
  ownerUserId: string,
  snapshot: DataSafetyConflictRestoreSnapshot,
  checkpoint: () => Promise<void> = NOOP_RESTORE_CHECKPOINT,
): Promise<void> {
  await checkpoint();
  await restoreConflictRestoreSnapshot(ownerUserId, snapshot);
  await checkpoint();
}

export async function restoreOfflineProjectRestoreSnapshot(
  ownerUserId: string,
  snapshot: DataSafetyOfflineSnapshotRestoreSnapshot,
  checkpoint: () => Promise<void> = NOOP_RESTORE_CHECKPOINT,
): Promise<void> {
  await checkpoint();
  await restoreOfflineSnapshotRestoreSnapshot(ownerUserId, snapshot);
  await checkpoint();
}

async function restoreRetryQueueLocalStateSnapshot(
  ownerUserId: string,
  snapshot: LocalStateRestoreSnapshot,
  canContinue: () => boolean,
  errors: string[],
  checkpoint: () => Promise<void> = NOOP_RESTORE_CHECKPOINT,
): Promise<void> {
  await checkpoint();
  await attemptLocalStateRollback(errors, 'retryQueue IndexedDB', async () => {
    if (snapshot.retryQueueIndexedDbItems !== null) {
      await rollbackRetryQueueIndexedDb(
        ownerUserId,
        snapshot.retryQueueIndexedDbItems,
        snapshot.retryQueueRestoreItems,
        canContinue,
      );
    }
  });
  await checkpoint();
  assertLocalStateRestoreContinuation(errors, canContinue);
  await attemptLocalStateRollback(errors, 'retryQueue localStorage', () => {
    rollbackRetryQueueLocalStorage(
      ownerUserId,
      snapshot.retryQueueLocalStorageValue,
      snapshot.retryQueueRestoreItems,
      canContinue,
    );
  });
  await checkpoint();
  assertLocalStateRestoreContinuation(errors, canContinue);
}

async function restoreQueueBacklogLocalStateSnapshot(
  ownerUserId: string,
  snapshot: LocalStateRestoreSnapshot,
  canContinue: () => boolean,
  errors: string[],
): Promise<void> {
  await restoreActionQueueLocalStateSnapshot(ownerUserId, snapshot, canContinue, errors);
  await restoreDeadLetterLocalStateSnapshot(ownerUserId, snapshot, canContinue, errors);
}

async function restoreActionQueueLocalStateSnapshot(
  ownerUserId: string,
  snapshot: Pick<
    LocalStateRestoreSnapshot,
    'actionQueueBackupRecord' | 'actionQueueLocalStorageValue'
  >,
  canContinue: () => boolean,
  errors: string[],
  checkpoint: () => Promise<void> = NOOP_RESTORE_CHECKPOINT,
): Promise<void> {
  await checkpoint();
  await attemptLocalStateRollback(errors, 'actionQueue QueueBackup', async () => {
    await restoreQueueBackupRecord(`queue-backup:${ownerUserId}`, snapshot.actionQueueBackupRecord);
  });
  await checkpoint();
  assertLocalStateRestoreContinuation(errors, canContinue);
  await attemptLocalStateRollback(errors, 'actionQueue localStorage', () => {
    restoreLocalStorageValue(
      `${LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY}.${ownerUserId}`,
      snapshot.actionQueueLocalStorageValue,
    );
  });
  await checkpoint();
  assertLocalStateRestoreContinuation(errors, canContinue);
}

async function restoreDeadLetterLocalStateSnapshot(
  ownerUserId: string,
  snapshot: Pick<
    LocalStateRestoreSnapshot,
    'deadLetterBackupRecord' | 'deadLetterLocalStorageValue'
  >,
  canContinue: () => boolean,
  errors: string[],
  checkpoint: () => Promise<void> = NOOP_RESTORE_CHECKPOINT,
): Promise<void> {
  await checkpoint();
  await attemptLocalStateRollback(errors, 'deadLetters QueueBackup', async () => {
    await restoreQueueBackupRecord(`dead-letter-backup:${ownerUserId}`, snapshot.deadLetterBackupRecord);
  });
  await checkpoint();
  assertLocalStateRestoreContinuation(errors, canContinue);
  await attemptLocalStateRollback(errors, 'deadLetters localStorage', () => {
    restoreLocalStorageValue(
      `${LOCAL_QUEUE_CONFIG.DEAD_LETTER_STORAGE_KEY}.${ownerUserId}`,
      snapshot.deadLetterLocalStorageValue,
    );
  });
  await checkpoint();
  assertLocalStateRestoreContinuation(errors, canContinue);
}

async function restoreExtendedLocalStateSnapshot(
  ownerUserId: string,
  snapshot: LocalStateRestoreSnapshot,
  errors: string[],
): Promise<void> {
  if (snapshot.conflictRestoreSnapshot !== undefined) {
    await attemptLocalStateRollback(errors, 'conflicts', () => (
      restoreConflictRestoreSnapshot(ownerUserId, snapshot.conflictRestoreSnapshot!)
    ));
  }
  if (snapshot.offlineSnapshotRestoreSnapshot !== undefined) {
    await attemptLocalStateRollback(errors, 'offline snapshot', () => (
      restoreOfflineSnapshotRestoreSnapshot(ownerUserId, snapshot.offlineSnapshotRestoreSnapshot!)
    ));
  }
  if (snapshot.dockSnapshotRestoreSnapshot !== undefined) {
    await attemptLocalStateRollback(errors, 'dock snapshot', () => (
      restoreDockSnapshotRestoreSnapshot(ownerUserId, snapshot.dockSnapshotRestoreSnapshot!)
    ));
  }
  if (snapshot.launchSnapshotRestoreSnapshot !== undefined) {
    await attemptLocalStateRollback(errors, 'launch snapshot', () => (
      restoreLaunchSnapshotRestoreSnapshot(ownerUserId, snapshot.launchSnapshotRestoreSnapshot!)
    ));
  }
  if (snapshot.parkedTaskCacheRestoreSnapshot !== undefined) {
    await attemptLocalStateRollback(errors, 'parked task cache', () => (
      restoreParkedTaskCacheRestoreSnapshot(ownerUserId, snapshot.parkedTaskCacheRestoreSnapshot!)
    ));
  }
}

// ==================== restore marker ====================

export async function writeDataSafetyRestoreMarker(
  ownerUserId: string,
  primaryStoreSnapshot: RestorableIndexedDbLocalData,
  localStateSnapshot: LocalStateRestoreSnapshot,
): Promise<DataSafetyRestoreMarker> {
  const journal = getFullRestoreMarkerJournal(ownerUserId);
  const existingMarker = await journal.read();
  if (existingMarker) {
    throw new Error(isDataSafetyRestoreMarkerActive(existingMarker)
      ? 'data-safety restore already in progress for this owner'
      : 'interrupted data-safety restore marker requires recovery');
  }

  const marker: DataSafetyRestoreMarker = {
    schemaVersion: DATA_SAFETY_RESTORE_MARKER_SCHEMA_VERSION,
    ...createDataSafetyRestoreMarkerLease(ownerUserId),
    primaryStoreSnapshot,
    localStateSnapshot,
  };
  await journal.create(marker);
  if (!await journal.owns(marker)) {
    throw new Error('data-safety restore marker ownership lost during acquisition');
  }
  return marker;
}

export async function readDataSafetyRestoreMarker(
  ownerUserId: string,
): Promise<DataSafetyRestoreMarker | null> {
  return await getFullRestoreMarkerJournal(ownerUserId).read();
}

export async function ownsDataSafetyRestoreMarker(marker: DataSafetyRestoreMarker): Promise<boolean> {
  return await getFullRestoreMarkerJournal(marker.ownerUserId).owns(marker);
}

export function hasDataSafetyRestoreMarkerSentinelOwnership(
  marker: DataSafetyRestoreMarker,
): boolean {
  return getFullRestoreMarkerJournal(marker.ownerUserId).hasSentinelOwnership(marker);
}

export async function claimExpiredDataSafetyRestoreMarker(
  marker: DataSafetyRestoreMarker,
): Promise<DataSafetyRestoreMarker | null> {
  return await getFullRestoreMarkerJournal(marker.ownerUserId).claimExpired(marker);
}

export async function renewDataSafetyRestoreMarkerLease(
  marker: DataSafetyRestoreMarker,
): Promise<boolean> {
  return (await getFullRestoreMarkerJournal(marker.ownerUserId).renew(marker)) !== null;
}

export async function clearDataSafetyRestoreMarker(marker: DataSafetyRestoreMarker): Promise<boolean> {
  return await getFullRestoreMarkerJournal(marker.ownerUserId).clear(marker);
}

function getFullRestoreMarkerJournal(
  ownerUserId: string,
): DataSafetyRestoreMarkerJournal<DataSafetyRestoreMarker> {
  return createDataSafetyRestoreMarkerJournal({
    markerKind: 'full-restore',
    ownerUserId,
    legacyStorageKey: getDataSafetyRestoreMarkerStorageKey(ownerUserId),
    normalize: value => normalizeDataSafetyRestoreMarker(value, ownerUserId),
  });
}

function normalizeDataSafetyRestoreMarker(
  value: unknown,
  ownerUserId: string,
): DataSafetyRestoreMarker | null {
  if (!isUnknownRecord(value)
    || value['schemaVersion'] !== DATA_SAFETY_RESTORE_MARKER_SCHEMA_VERSION
    || value['ownerUserId'] !== ownerUserId
    || typeof value['createdAt'] !== 'string'
  ) {
    return null;
  }
  const runId = value['runId'];
  const leaseExpiresAt = value['leaseExpiresAt'];
  const hasLegacyIdentity = (runId === undefined || runId === null)
    && (leaseExpiresAt === undefined || leaseExpiresAt === null);
  if (!hasLegacyIdentity && (
    typeof runId !== 'string'
    || runId.length === 0
    || typeof leaseExpiresAt !== 'string'
    || !Number.isFinite(Date.parse(leaseExpiresAt))
  )) {
    return null;
  }
  const primaryStoreSnapshot = normalizePrimaryStoreSnapshot(value['primaryStoreSnapshot']);
  const localStateSnapshot = normalizeLocalStateRestoreSnapshot(
    value['localStateSnapshot'],
    ownerUserId,
  );
  if (!primaryStoreSnapshot || !localStateSnapshot) {
    return null;
  }

  return {
    schemaVersion: DATA_SAFETY_RESTORE_MARKER_SCHEMA_VERSION,
    ownerUserId,
    runId: hasLegacyIdentity ? null : runId as string,
    createdAt: value['createdAt'],
    leaseExpiresAt: hasLegacyIdentity ? null : leaseExpiresAt as string,
    primaryStoreSnapshot,
    localStateSnapshot,
  };
}

function normalizePrimaryStoreSnapshot(value: unknown): RestorableIndexedDbLocalData | null {
  if (!isUnknownRecord(value)
    || !isEntityRecordArray(value['projects'])
    || !isEntityRecordArray(value['tasks'])
    || !isEntityRecordArray(value['connections'])
    || !isSyncCursorRecordArray(value['syncCursors'])
    || (value['meta'] !== null && !isUnknownRecord(value['meta']))
  ) {
    return null;
  }

  return {
    projects: [...value['projects']],
    tasks: [...value['tasks']],
    connections: [...value['connections']],
    syncCursors: [...value['syncCursors']],
    meta: value['meta'],
  };
}

function normalizeLocalStateRestoreSnapshot(
  value: unknown,
  ownerUserId: string,
): LocalStateRestoreSnapshot | null {
  if (!isUnknownRecord(value)) return null;
  const queueSnapshot = normalizeMarkerQueueRestoreSnapshot(value, ownerUserId);
  const tombstoneSnapshot = normalizeMarkerTombstoneRestoreSnapshot(value);
  const extendedSnapshot = normalizeMarkerExtendedRestoreSnapshot(value, ownerUserId);
  if (!queueSnapshot || !tombstoneSnapshot || !extendedSnapshot) return null;

  return {
    ...queueSnapshot,
    ...tombstoneSnapshot,
    ...extendedSnapshot,
  };
}

function normalizeMarkerQueueRestoreSnapshot(
  value: UnknownRecord,
  ownerUserId: string,
): Pick<LocalStateRestoreSnapshot,
  | 'retryQueueIndexedDbItems'
  | 'retryQueueLocalStorageValue'
  | 'retryQueueRestoreItems'
  | 'legacyRetryReviewLocalStorageValue'
  | 'actionQueueBackupRecord'
  | 'actionQueueLocalStorageValue'
  | 'deadLetterBackupRecord'
  | 'deadLetterLocalStorageValue'
  | 'auditLocalStorageValue'> | null {
  const retryQueueIndexedDbItems = value['retryQueueIndexedDbItems'];
  const retryQueueRestoreItems = value['retryQueueRestoreItems'];
  const legacyRetryReviewLocalStorageValue = value['legacyRetryReviewLocalStorageValue'];
  const actionQueueBackupRecord = normalizeMarkerQueueBackupRecord(
    value['actionQueueBackupRecord'],
    ownerUserId,
  );
  const deadLetterBackupRecord = normalizeMarkerDeadLetterBackupRecord(
    value['deadLetterBackupRecord'],
    ownerUserId,
  );
  if ((retryQueueIndexedDbItems !== null && !isUnknownRecordArray(retryQueueIndexedDbItems))
    || (retryQueueRestoreItems !== undefined && !isUnknownRecordArray(retryQueueRestoreItems))
    || !isNullableString(value['retryQueueLocalStorageValue'])
    || (legacyRetryReviewLocalStorageValue !== undefined
      && !isNullableString(legacyRetryReviewLocalStorageValue))
    || (value['actionQueueBackupRecord'] !== null && !actionQueueBackupRecord)
    || !isNullableString(value['actionQueueLocalStorageValue'])
    || (value['deadLetterBackupRecord'] !== null && !deadLetterBackupRecord)
    || !isNullableString(value['deadLetterLocalStorageValue'])
    || !isNullableString(value['auditLocalStorageValue'])) {
    return null;
  }
  let legacyRetryReviewStorageValid = true;
  if (legacyRetryReviewLocalStorageValue !== undefined) {
    try {
      parseLegacyRetryReviewStorageValue(legacyRetryReviewLocalStorageValue, ownerUserId);
    } catch {
      legacyRetryReviewStorageValid = false;
    }
  }
  if (!legacyRetryReviewStorageValid) return null;
  return {
    retryQueueIndexedDbItems: retryQueueIndexedDbItems === null
      ? null
      : [...retryQueueIndexedDbItems],
    retryQueueLocalStorageValue: value['retryQueueLocalStorageValue'],
    ...(retryQueueRestoreItems === undefined
      ? {}
      : { retryQueueRestoreItems: [...retryQueueRestoreItems] }),
    ...(legacyRetryReviewLocalStorageValue === undefined
      ? {}
      : { legacyRetryReviewLocalStorageValue }),
    actionQueueBackupRecord,
    actionQueueLocalStorageValue: value['actionQueueLocalStorageValue'],
    deadLetterBackupRecord,
    deadLetterLocalStorageValue: value['deadLetterLocalStorageValue'],
    auditLocalStorageValue: value['auditLocalStorageValue'],
  };
}

function normalizeMarkerExtendedRestoreSnapshot(
  value: UnknownRecord,
  ownerUserId: string,
): Pick<LocalStateRestoreSnapshot,
  | 'conflictRestoreSnapshot'
  | 'offlineSnapshotRestoreSnapshot'
  | 'dockSnapshotRestoreSnapshot'
  | 'launchSnapshotRestoreSnapshot'
  | 'parkedTaskCacheRestoreSnapshot'> | null {
  const conflictRestoreSnapshot = value['conflictRestoreSnapshot'] === undefined
    ? undefined
    : normalizeConflictRestoreSnapshot(value['conflictRestoreSnapshot']);
  const offlineSnapshotRestoreSnapshot = value['offlineSnapshotRestoreSnapshot'] === undefined
    ? undefined
    : normalizeOfflineSnapshotRestoreSnapshot(value['offlineSnapshotRestoreSnapshot']);
  const projectLocalStateSnapshot = normalizeProjectLocalStateMarkerSnapshot(value, ownerUserId);
  if ((value['conflictRestoreSnapshot'] !== undefined && !conflictRestoreSnapshot)
    || (value['offlineSnapshotRestoreSnapshot'] !== undefined && !offlineSnapshotRestoreSnapshot)
    || !projectLocalStateSnapshot) {
    return null;
  }
  return {
    ...(conflictRestoreSnapshot ? { conflictRestoreSnapshot } : {}),
    ...(offlineSnapshotRestoreSnapshot ? { offlineSnapshotRestoreSnapshot } : {}),
    ...projectLocalStateSnapshot,
  };
}

function normalizeMarkerQueueBackupRecord(
  value: unknown,
  ownerUserId: string,
): QueueBackupRecord | null {
  if (value === null) return null;
  const normalized = normalizeQueueBackupRecord(value);
  if (!normalized
    || !isUnknownRecord(value)
    || value['id'] !== `queue-backup:${ownerUserId}`
    || value['ownerUserId'] !== ownerUserId
    || typeof value['savedAt'] !== 'string'
    || !Array.isArray(value['actions'])
    || normalized.actions.length !== value['actions'].length
  ) {
    return null;
  }
  return value as unknown as QueueBackupRecord;
}

function normalizeMarkerDeadLetterBackupRecord(
  value: unknown,
  ownerUserId: string,
): DeadLetterBackupRecord | null {
  if (value === null) return null;
  const normalized = normalizeDeadLetterBackupRecord(value);
  if (!normalized
    || !isUnknownRecord(value)
    || value['id'] !== `dead-letter-backup:${ownerUserId}`
    || value['ownerUserId'] !== ownerUserId
    || typeof value['savedAt'] !== 'string'
    || !Array.isArray(value['deadLetters'])
    || normalized.deadLetters.length !== value['deadLetters'].length
  ) {
    return null;
  }
  return value as unknown as DeadLetterBackupRecord;
}

function isEntityRecordArray(value: unknown): value is DataSafetyEntityRecord[] {
  return Array.isArray(value) && value.every(isEntityRecord);
}

function isSyncCursorRecordArray(value: unknown): value is DataSafetySyncCursorRecord[] {
  return Array.isArray(value) && value.every(isSyncCursorRecord);
}

function isUnknownRecordArray(value: unknown): value is UnknownRecord[] {
  return Array.isArray(value) && value.every(isUnknownRecord);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

async function attemptLocalStateRollback(
  errors: string[],
  label: string,
  action: () => void | Promise<void>,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    errors.push(`${label}: ${formatRestoreError(error)}`);
  }
}

function assertLocalStateRestoreContinuation(
  errors: string[],
  canContinue: () => boolean,
): void {
  if (canContinue()) return;
  errors.push('data-safety restore marker ownership lost during local-state rollback');
  throw new Error(errors.join('; '));
}

// ==================== 共享基础工具（adapter 与 local-state 共用） ====================

export function getAllFromStore<T>(db: IDBDatabase, storeName: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const request = tx.objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result ?? []);
    request.onerror = () => reject(request.error);
  });
}

export function getFromStore<T>(db: IDBDatabase, storeName: string, key: IDBValidKey): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const request = tx.objectStore(storeName).get(key);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
  });
}

function readLocalStorageValue(key: string): string | null {
  if (typeof localStorage === 'undefined') {
    return null;
  }
  return localStorage.getItem(key);
}

function restoreLocalStorageValue(key: string, value: string | null): void {
  if (typeof localStorage === 'undefined') {
    return;
  }
  if (value === null) {
    localStorage.removeItem(key);
    return;
  }
  localStorage.setItem(key, value);
}

export function waitForTransaction(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

export function formatRestoreError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}

export function isEntityRecord(value: UnknownRecord): value is DataSafetyEntityRecord {
  return typeof value['id'] === 'string' && value['id'].length > 0;
}

export function isSyncCursorRecord(value: UnknownRecord): value is DataSafetySyncCursorRecord {
  return typeof value['key'] === 'string' && value['key'].length > 0;
}

export function isUnknownRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
