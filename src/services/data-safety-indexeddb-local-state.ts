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
  type DataSafetyDeadLetterItem,
  type DataSafetyEntityRecord,
  type DataSafetyExportPackage,
  type DataSafetyQueuedAction,
  type DataSafetyRetryQueueItem,
  type DataSafetySyncCursorRecord,
} from './data-safety-package';
import { LOCAL_QUEUE_CONFIG } from './action-queue-storage.helpers';
import { DataSafetyAuditPersistence } from './data-safety-audit-persistence';
import {
  QUEUE_BACKUP_DB_NAME,
  QUEUE_BACKUP_DB_VERSION,
  QUEUE_BACKUP_STORE_NAME,
  type DeadLetterBackupRecord,
  type QueueBackupRecord,
} from './queue-backup.service';
import type { DeadLetterItem, QueuedAction } from './action-queue.types';
import { createDerivedSyncOperationId, createSyncOperationId, isSyncOperationId } from '../utils/sync-operation-id';

export type UnknownRecord = Record<string, unknown>;

const RETRY_QUEUE_DB_NAME = 'nanoflow-retry-queue';
const RETRY_QUEUE_STORE_NAME = 'offline_mutation_queue';
const RETRY_QUEUE_LOCAL_STORAGE_KEY = 'nanoflow.retry-queue';
const RETRY_QUEUE_LOCAL_STORAGE_VERSION = 1;
const LEGACY_RETRY_QUEUE_OPERATION_ID_PURPOSE = 'legacy-retry-queue-operation-id';
const LEGACY_ACTION_QUEUE_OPERATION_ID_PURPOSE = 'legacy-action-queue-operation-id';
const DATA_SAFETY_AUDIT_STORAGE_KEY_PREFIX = 'nanoflow.data-safety-audit';
const DATA_SAFETY_RESTORE_MARKER_STORAGE_KEY_PREFIX = 'nanoflow.data-safety-restore-marker';
const DATA_SAFETY_RESTORE_MARKER_SCHEMA_VERSION = 1;

export interface RestorableIndexedDbLocalData extends DataSafetyCurrentLocalData {
  meta: UnknownRecord | null;
}

export interface LocalStateRestoreSnapshot {
  retryQueueIndexedDbItems: UnknownRecord[] | null;
  retryQueueLocalStorageValue: string | null;
  actionQueueBackupRecord: QueueBackupRecord | null;
  actionQueueLocalStorageValue: string | null;
  deadLetterBackupRecord: DeadLetterBackupRecord | null;
  deadLetterLocalStorageValue: string | null;
  auditLocalStorageValue: string | null;
}

export interface DataSafetyRestoreMarker {
  schemaVersion: typeof DATA_SAFETY_RESTORE_MARKER_SCHEMA_VERSION;
  ownerUserId: string;
  createdAt: string;
  primaryStoreSnapshot: RestorableIndexedDbLocalData;
  localStateSnapshot: LocalStateRestoreSnapshot;
}

// ==================== local-state 恢复 ====================

export async function restoreLocalState(pkg: DataSafetyExportPackage): Promise<void> {
  await restoreRetryQueue(pkg.localState.retryQueue);
  await restoreActionQueue(pkg.ownerUserId, pkg.localState.actionQueue);
  await restoreDeadLetters(pkg.ownerUserId, pkg.localState.deadLetters);
  const auditSaved = new DataSafetyAuditPersistence().save(pkg.ownerUserId, {
    replayLog: pkg.replayLog,
    lastWriteExplain: pkg.lastWriteExplain,
  });
  if (!auditSaved) {
    throw new Error('data-safety audit persistence failed');
  }
}

export async function readLocalStateRestoreSnapshot(ownerUserId: string): Promise<LocalStateRestoreSnapshot> {
  const [
    retryQueueIndexedDbItems,
    actionQueueBackupRecord,
    deadLetterBackupRecord,
  ] = await Promise.all([
    readRetryQueueIndexedDbItems(),
    readQueueBackupRecord<QueueBackupRecord>(`queue-backup:${ownerUserId}`),
    readQueueBackupRecord<DeadLetterBackupRecord>(`dead-letter-backup:${ownerUserId}`),
  ]);

  return {
    retryQueueIndexedDbItems,
    retryQueueLocalStorageValue: readLocalStorageValue(RETRY_QUEUE_LOCAL_STORAGE_KEY),
    actionQueueBackupRecord,
    actionQueueLocalStorageValue: readLocalStorageValue(`${LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY}.${ownerUserId}`),
    deadLetterBackupRecord,
    deadLetterLocalStorageValue: readLocalStorageValue(`${LOCAL_QUEUE_CONFIG.DEAD_LETTER_STORAGE_KEY}.${ownerUserId}`),
    auditLocalStorageValue: readLocalStorageValue(`${DATA_SAFETY_AUDIT_STORAGE_KEY_PREFIX}.${ownerUserId}`),
  };
}

export async function restoreLocalStateSnapshot(
  ownerUserId: string,
  snapshot: LocalStateRestoreSnapshot,
): Promise<void> {
  const errors: string[] = [];
  await attemptLocalStateRollback(errors, 'retryQueue IndexedDB', async () => {
    if (snapshot.retryQueueIndexedDbItems !== null) {
      await restoreRetryQueueToIndexedDb(snapshot.retryQueueIndexedDbItems);
    }
  });
  await attemptLocalStateRollback(errors, 'retryQueue localStorage', () => {
    restoreLocalStorageValue(RETRY_QUEUE_LOCAL_STORAGE_KEY, snapshot.retryQueueLocalStorageValue);
  });
  await attemptLocalStateRollback(errors, 'actionQueue QueueBackup', async () => {
    await restoreQueueBackupRecord(`queue-backup:${ownerUserId}`, snapshot.actionQueueBackupRecord);
  });
  await attemptLocalStateRollback(errors, 'actionQueue localStorage', () => {
    restoreLocalStorageValue(
      `${LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY}.${ownerUserId}`,
      snapshot.actionQueueLocalStorageValue,
    );
  });
  await attemptLocalStateRollback(errors, 'deadLetters QueueBackup', async () => {
    await restoreQueueBackupRecord(`dead-letter-backup:${ownerUserId}`, snapshot.deadLetterBackupRecord);
  });
  await attemptLocalStateRollback(errors, 'deadLetters localStorage', () => {
    restoreLocalStorageValue(
      `${LOCAL_QUEUE_CONFIG.DEAD_LETTER_STORAGE_KEY}.${ownerUserId}`,
      snapshot.deadLetterLocalStorageValue,
    );
  });
  await attemptLocalStateRollback(errors, 'dataSafetyAudit localStorage', () => {
    restoreLocalStorageValue(
      `${DATA_SAFETY_AUDIT_STORAGE_KEY_PREFIX}.${ownerUserId}`,
      snapshot.auditLocalStorageValue,
    );
  });

  if (errors.length > 0) {
    throw new Error(errors.join('; '));
  }
}

// ==================== restore marker ====================

export function writeDataSafetyRestoreMarker(
  ownerUserId: string,
  primaryStoreSnapshot: RestorableIndexedDbLocalData,
  localStateSnapshot: LocalStateRestoreSnapshot,
): void {
  if (typeof localStorage === 'undefined') {
    throw new Error('localStorage unavailable for data-safety restore marker');
  }

  const marker: DataSafetyRestoreMarker = {
    schemaVersion: DATA_SAFETY_RESTORE_MARKER_SCHEMA_VERSION,
    ownerUserId,
    createdAt: new Date().toISOString(),
    primaryStoreSnapshot,
    localStateSnapshot,
  };
  localStorage.setItem(getDataSafetyRestoreMarkerStorageKey(ownerUserId), JSON.stringify(marker));
}

export function readDataSafetyRestoreMarker(ownerUserId: string): DataSafetyRestoreMarker | null {
  if (typeof localStorage === 'undefined') {
    return null;
  }

  const raw = localStorage.getItem(getDataSafetyRestoreMarkerStorageKey(ownerUserId));
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    return normalizeDataSafetyRestoreMarker(parsed, ownerUserId);
  } catch {
    return null; // eslint-disable-line no-restricted-syntax -- Corrupt persisted restore markers are treated as absent.
  }
}

export function clearDataSafetyRestoreMarker(ownerUserId: string): void {
  if (typeof localStorage === 'undefined') {
    return;
  }
  localStorage.removeItem(getDataSafetyRestoreMarkerStorageKey(ownerUserId));
}

function getDataSafetyRestoreMarkerStorageKey(ownerUserId: string): string {
  return `${DATA_SAFETY_RESTORE_MARKER_STORAGE_KEY_PREFIX}.${ownerUserId}`;
}

function normalizeDataSafetyRestoreMarker(
  value: unknown,
  ownerUserId: string,
): DataSafetyRestoreMarker | null {
  if (!isUnknownRecord(value)
    || value['schemaVersion'] !== DATA_SAFETY_RESTORE_MARKER_SCHEMA_VERSION
    || value['ownerUserId'] !== ownerUserId
  ) {
    return null;
  }
  const primaryStoreSnapshot = normalizePrimaryStoreSnapshot(value['primaryStoreSnapshot']);
  const localStateSnapshot = normalizeLocalStateRestoreSnapshot(value['localStateSnapshot']);
  if (!primaryStoreSnapshot || !localStateSnapshot) {
    return null;
  }

  return {
    schemaVersion: DATA_SAFETY_RESTORE_MARKER_SCHEMA_VERSION,
    ownerUserId,
    createdAt: typeof value['createdAt'] === 'string' ? value['createdAt'] : new Date(0).toISOString(),
    primaryStoreSnapshot,
    localStateSnapshot,
  };
}

function normalizePrimaryStoreSnapshot(value: unknown): RestorableIndexedDbLocalData | null {
  if (!isUnknownRecord(value)) {
    return null;
  }

  return {
    projects: normalizeUnknownRecordArray(value['projects']).filter(isEntityRecord),
    tasks: normalizeUnknownRecordArray(value['tasks']).filter(isEntityRecord),
    connections: normalizeUnknownRecordArray(value['connections']).filter(isEntityRecord),
    syncCursors: normalizeUnknownRecordArray(value['syncCursors']).filter(isSyncCursorRecord),
    meta: isUnknownRecord(value['meta']) ? value['meta'] : null,
  };
}

function normalizeLocalStateRestoreSnapshot(value: unknown): LocalStateRestoreSnapshot | null {
  if (!isUnknownRecord(value)) {
    return null;
  }

  return {
    retryQueueIndexedDbItems: Array.isArray(value['retryQueueIndexedDbItems'])
      ? normalizeUnknownRecordArray(value['retryQueueIndexedDbItems'])
      : null,
    retryQueueLocalStorageValue: normalizeNullableString(value['retryQueueLocalStorageValue']),
    actionQueueBackupRecord: normalizeQueueBackupRecord(value['actionQueueBackupRecord']),
    actionQueueLocalStorageValue: normalizeNullableString(value['actionQueueLocalStorageValue']),
    deadLetterBackupRecord: normalizeDeadLetterBackupRecord(value['deadLetterBackupRecord']),
    deadLetterLocalStorageValue: normalizeNullableString(value['deadLetterLocalStorageValue']),
    auditLocalStorageValue: normalizeNullableString(value['auditLocalStorageValue']),
  };
}

function normalizeQueueBackupRecord(value: unknown): QueueBackupRecord | null {
  if (!isUnknownRecord(value)
    || typeof value['id'] !== 'string'
    || typeof value['ownerUserId'] !== 'string'
    || !Array.isArray(value['actions'])
  ) {
    return null;
  }

  return {
    id: value['id'],
    ownerUserId: value['ownerUserId'],
    actions: value['actions'].filter(isRestorableQueuedAction),
    savedAt: typeof value['savedAt'] === 'string' ? value['savedAt'] : new Date(0).toISOString(),
  };
}

function normalizeDeadLetterBackupRecord(value: unknown): DeadLetterBackupRecord | null {
  if (!isUnknownRecord(value)
    || typeof value['id'] !== 'string'
    || typeof value['ownerUserId'] !== 'string'
    || !Array.isArray(value['deadLetters'])
  ) {
    return null;
  }

  return {
    id: value['id'],
    ownerUserId: value['ownerUserId'],
    deadLetters: value['deadLetters'].filter(isRestorableDeadLetterItem),
    savedAt: typeof value['savedAt'] === 'string' ? value['savedAt'] : new Date(0).toISOString(),
  };
}

function normalizeUnknownRecordArray(value: unknown): UnknownRecord[] {
  return Array.isArray(value) ? value.filter(isUnknownRecord) : [];
}

function normalizeNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
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

// ==================== RetryQueue ====================

async function restoreRetryQueue(items: DataSafetyRetryQueueItem[]): Promise<void> {
  const normalizedItems = normalizeRestoredRetryQueueItems(items);
  const restorableItems = assertRestorableRetryQueueItems(normalizedItems);
  await restoreRetryQueueToIndexedDb(restorableItems);
  if (typeof localStorage === 'undefined') {
    return;
  }

  localStorage.setItem(RETRY_QUEUE_LOCAL_STORAGE_KEY, JSON.stringify({
    version: RETRY_QUEUE_LOCAL_STORAGE_VERSION,
    items: restorableItems,
    savedAt: Date.now(),
  }));
}

function normalizeRestoredRetryQueueItems(items: DataSafetyRetryQueueItem[]): DataSafetyRetryQueueItem[] {
  return items.map(item => ({
    ...item,
    operationId: normalizeRestoredRetryQueueOperationId(item.operationId),
  }));
}

function normalizeRestoredRetryQueueOperationId(operationId: unknown): string {
  if (isSyncOperationId(operationId)) {
    return operationId;
  }

  if (typeof operationId === 'string' && operationId.length > 0) {
    return createDerivedSyncOperationId(operationId, LEGACY_RETRY_QUEUE_OPERATION_ID_PURPOSE);
  }

  return createSyncOperationId();
}

function assertRestorableRetryQueueItems(items: DataSafetyRetryQueueItem[]): DataSafetyRetryQueueItem[] {
  const invalidItems = items.filter(item => !isRestorableRetryQueueItem(item));
  if (invalidItems.length > 0) {
    throw new Error(
      `unrestorable retryQueue item(s): ${invalidItems.map(describeRetryQueueItem).join(', ')}`,
    );
  }

  return items.filter(isRestorableRetryQueueItem);
}

function describeRetryQueueItem(item: DataSafetyRetryQueueItem): string {
  const id = nonEmptyStringOrFallback(item['id'], 'missing-id');
  const operationId = nonEmptyStringOrFallback(item['operationId'], 'missing-operationId');
  const type = nonEmptyStringOrFallback(item['type'], 'missing-type');
  const operation = nonEmptyStringOrFallback(item['operation'], 'missing-operation');
  return `${id} (${operationId}, ${type}:${operation})`;
}

async function restoreRetryQueueToIndexedDb(items: UnknownRecord[]): Promise<void> {
  if (typeof indexedDB === 'undefined') {
    return;
  }

  const retryDb = await openRetryQueueDatabase();
  try {
    const tx = retryDb.transaction(RETRY_QUEUE_STORE_NAME, 'readwrite');
    const store = tx.objectStore(RETRY_QUEUE_STORE_NAME);
    store.clear();
    items.forEach(item => store.put(item));
    await waitForTransaction(tx);
  } finally {
    retryDb.close();
  }
}

async function readRetryQueueIndexedDbItems(): Promise<UnknownRecord[] | null> {
  if (typeof indexedDB === 'undefined') {
    return null;
  }

  const retryDb = await openRetryQueueDatabase();
  try {
    return await getAllFromStore<UnknownRecord>(retryDb, RETRY_QUEUE_STORE_NAME);
  } finally {
    retryDb.close();
  }
}

function openRetryQueueDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(RETRY_QUEUE_DB_NAME, 1);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const retryDb = request.result;
      if (!retryDb.objectStoreNames.contains(RETRY_QUEUE_STORE_NAME)) {
        const store = retryDb.createObjectStore(RETRY_QUEUE_STORE_NAME, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt', { unique: false });
        store.createIndex('type', 'type', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

// ==================== ActionQueue / DeadLetters ====================

async function restoreActionQueue(ownerUserId: string, queue: DataSafetyQueuedAction[]): Promise<void> {
  const normalizedQueue = normalizeRestoredActionQueueItems(queue);
  const restorableQueue = assertRestorableActionQueueItems(normalizedQueue);
  await restoreActionQueueToQueueBackup(ownerUserId, restorableQueue);
  if (typeof localStorage === 'undefined') {
    return;
  }

  localStorage.setItem(
    `${LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY}.${ownerUserId}`,
    JSON.stringify(restorableQueue),
  );
}

async function restoreActionQueueToQueueBackup(ownerUserId: string, queue: QueuedAction[]): Promise<void> {
  if (typeof indexedDB === 'undefined') {
    return;
  }

  const queueBackupDb = await openQueueBackupDatabase();
  try {
    const tx = queueBackupDb.transaction(QUEUE_BACKUP_STORE_NAME, 'readwrite');
    const store = tx.objectStore(QUEUE_BACKUP_STORE_NAME);
    store.put({
      id: `queue-backup:${ownerUserId}`,
      ownerUserId,
      actions: queue,
      savedAt: new Date().toISOString(),
    } satisfies QueueBackupRecord);
    await waitForTransaction(tx);
  } finally {
    queueBackupDb.close();
  }
}

function normalizeRestoredActionQueueItems(items: DataSafetyQueuedAction[]): DataSafetyQueuedAction[] {
  return items.map(item => ({
    ...item,
    operationId: normalizeRestoredActionQueueOperationId(item.operationId),
  }));
}

function normalizeRestoredActionQueueOperationId(operationId: unknown): string {
  if (isSyncOperationId(operationId)) {
    return operationId;
  }

  if (typeof operationId === 'string' && operationId.length > 0) {
    return createDerivedSyncOperationId(operationId, LEGACY_ACTION_QUEUE_OPERATION_ID_PURPOSE);
  }

  return createSyncOperationId();
}

function assertRestorableActionQueueItems(items: DataSafetyQueuedAction[]): QueuedAction[] {
  const invalidItems = items.filter(item => !isRestorableQueuedAction(item));
  if (invalidItems.length > 0) {
    throw new Error(
      `unrestorable actionQueue item(s): ${invalidItems.map(describeActionQueueItem).join(', ')}`,
    );
  }

  return items.filter(isRestorableQueuedAction);
}

function describeActionQueueItem(item: DataSafetyQueuedAction): string {
  const id = nonEmptyStringOrFallback(item['id'], 'missing-id');
  const operationId = nonEmptyStringOrFallback(item['operationId'], 'missing-operationId');
  const entityType = nonEmptyStringOrFallback(item['entityType'], 'missing-entityType');
  const entityId = nonEmptyStringOrFallback(item['entityId'], 'missing-entityId');
  return `${id} (${operationId}, ${entityType}:${entityId})`;
}

function openQueueBackupDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(QUEUE_BACKUP_DB_NAME, QUEUE_BACKUP_DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const queueBackupDb = request.result;
      if (!queueBackupDb.objectStoreNames.contains(QUEUE_BACKUP_STORE_NAME)) {
        queueBackupDb.createObjectStore(QUEUE_BACKUP_STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

async function readQueueBackupRecord<T extends QueueBackupRecord | DeadLetterBackupRecord>(
  recordId: string,
): Promise<T | null> {
  if (typeof indexedDB === 'undefined') {
    return null;
  }

  const queueBackupDb = await openQueueBackupDatabase();
  try {
    return await getFromStore<T>(queueBackupDb, QUEUE_BACKUP_STORE_NAME, recordId);
  } finally {
    queueBackupDb.close();
  }
}

async function restoreQueueBackupRecord(
  recordId: string,
  record: QueueBackupRecord | DeadLetterBackupRecord | null,
): Promise<void> {
  if (typeof indexedDB === 'undefined') {
    return;
  }

  const queueBackupDb = await openQueueBackupDatabase();
  try {
    const tx = queueBackupDb.transaction(QUEUE_BACKUP_STORE_NAME, 'readwrite');
    const store = tx.objectStore(QUEUE_BACKUP_STORE_NAME);
    if (record) {
      store.put(record);
    } else {
      store.delete(recordId);
    }
    await waitForTransaction(tx);
  } finally {
    queueBackupDb.close();
  }
}

async function restoreDeadLetters(ownerUserId: string, queue: DataSafetyDeadLetterItem[]): Promise<void> {
  const restorableDeadLetters = assertRestorableDeadLetterItems(queue);
  await restoreDeadLettersToQueueBackup(ownerUserId, restorableDeadLetters);
  if (typeof localStorage === 'undefined') {
    return;
  }

  localStorage.setItem(
    `${LOCAL_QUEUE_CONFIG.DEAD_LETTER_STORAGE_KEY}.${ownerUserId}`,
    JSON.stringify(restorableDeadLetters),
  );
}

async function restoreDeadLettersToQueueBackup(ownerUserId: string, queue: DeadLetterItem[]): Promise<void> {
  if (typeof indexedDB === 'undefined') {
    return;
  }

  const queueBackupDb = await openQueueBackupDatabase();
  try {
    const tx = queueBackupDb.transaction(QUEUE_BACKUP_STORE_NAME, 'readwrite');
    const store = tx.objectStore(QUEUE_BACKUP_STORE_NAME);
    store.put({
      id: `dead-letter-backup:${ownerUserId}`,
      ownerUserId,
      deadLetters: queue,
      savedAt: new Date().toISOString(),
    } satisfies DeadLetterBackupRecord);
    await waitForTransaction(tx);
  } finally {
    queueBackupDb.close();
  }
}

function assertRestorableDeadLetterItems(items: DataSafetyDeadLetterItem[]): DeadLetterItem[] {
  const invalidItems = items.filter(item => !isRestorableDeadLetterItem(item));
  if (invalidItems.length > 0) {
    throw new Error(
      `unrestorable deadLetter item(s): ${invalidItems.map(describeDeadLetterItem).join(', ')}`,
    );
  }

  return items.filter(isRestorableDeadLetterItem);
}

function describeDeadLetterItem(item: DataSafetyDeadLetterItem): string {
  if (isUnknownRecord(item['action'])) {
    return describeActionQueueItem(item['action'] as DataSafetyQueuedAction);
  }
  return nonEmptyStringOrFallback(item['id'], 'missing-action');
}

function isRestorableRetryQueueItem(item: unknown): item is DataSafetyRetryQueueItem {
  if (!isUnknownRecord(item)) {
    return false;
  }

  return typeof item['id'] === 'string'
    && typeof item['operationId'] === 'string'
    && typeof item['type'] === 'string'
    && typeof item['operation'] === 'string'
    && isUnknownRecord(item['data'])
    && typeof item['retryCount'] === 'number'
    && typeof item['createdAt'] === 'number';
}

function isRestorableQueuedAction(action: unknown): action is DataSafetyQueuedAction & QueuedAction {
  if (!isUnknownRecord(action)) {
    return false;
  }

  return (action['type'] === 'create' || action['type'] === 'update' || action['type'] === 'delete')
    && typeof action['entityType'] === 'string'
    && typeof action['entityId'] === 'string'
    && typeof action['operationId'] === 'string'
    && action['payload'] !== null
    && typeof action['payload'] === 'object'
    && typeof action['timestamp'] === 'number'
    && typeof action['retryCount'] === 'number';
}

function isRestorableDeadLetterItem(item: DataSafetyDeadLetterItem): item is DataSafetyDeadLetterItem & DeadLetterItem {
  return typeof item['failedAt'] === 'string'
    && typeof item['reason'] === 'string'
    && isRestorableQueuedAction(item['action'] as DataSafetyQueuedAction);
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

function nonEmptyStringOrFallback(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}
