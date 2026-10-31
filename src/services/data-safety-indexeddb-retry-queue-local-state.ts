import type { DataSafetyRetryQueueItem } from './data-safety-package';

const RETRY_QUEUE_DB_NAME = 'nanoflow-retry-queue';
const RETRY_QUEUE_STORE_NAME = 'offline_mutation_queue';
const RETRY_QUEUE_LOCAL_STORAGE_KEY = 'nanoflow.retry-queue';
const RETRY_QUEUE_LOCAL_STORAGE_VERSION = 1;

type UnknownRecord = Record<string, unknown>;
type RestoreContinuation = () => boolean;

export function prepareRetryQueueRestoreItems(
  ownerUserId: string,
  items: DataSafetyRetryQueueItem[],
): UnknownRecord[] {
  return assertRestorableRetryQueueItems(
    ownerUserId,
    items.map(item => ({ ...item })),
  );
}

export async function restoreRetryQueue(
  ownerUserId: string,
  preparedItems: UnknownRecord[],
): Promise<void> {
  const restorableItems = assertRestorableRetryQueueItems(ownerUserId, preparedItems);
  await restoreRetryQueueToIndexedDb(ownerUserId, restorableItems);
  if (typeof localStorage === 'undefined') return;

  const mergedItems = mergeRetryQueueItemsForOwner(
    readRetryQueueLocalStorageItems(),
    restorableItems,
    ownerUserId,
  );
  writeRetryQueueLocalStorageItems(mergedItems);
}

export async function readRetryQueueIndexedDbItems(): Promise<UnknownRecord[] | null> {
  if (typeof indexedDB === 'undefined') return null;

  const retryDb = await openRetryQueueDatabase();
  try {
    return await readRetryQueueItems(retryDb, 'readonly');
  } finally {
    retryDb.close();
  }
}

export async function rollbackRetryQueueIndexedDb(
  ownerUserId: string,
  snapshotItems: UnknownRecord[],
  restoredItems: UnknownRecord[] | undefined,
  canContinue: RestoreContinuation,
): Promise<void> {
  if (typeof indexedDB === 'undefined') return;

  const retryDb = await openRetryQueueDatabase();
  try {
    await updateRetryQueueItems(retryDb, currentItems => {
      assertRestoreContinuation(canContinue);
      return buildRetryQueueRollbackItems(
        currentItems,
        snapshotItems,
        restoredItems,
        ownerUserId,
      );
    });
  } finally {
    retryDb.close();
  }
}

export function rollbackRetryQueueLocalStorage(
  ownerUserId: string,
  snapshotValue: string | null,
  restoredItems: UnknownRecord[] | undefined,
  canContinue: RestoreContinuation,
): void {
  if (typeof localStorage === 'undefined') return;
  assertRestoreContinuation(canContinue);
  const snapshotItems = parseRetryQueueLocalStorageItems(snapshotValue, 'snapshot');
  const currentItems = readRetryQueueLocalStorageItems();
  const rollbackItems = buildRetryQueueRollbackItems(
    currentItems,
    snapshotItems,
    restoredItems,
    ownerUserId,
  );
  assertRestoreContinuation(canContinue);
  if (snapshotValue === null && rollbackItems.length === 0) {
    localStorage.removeItem(RETRY_QUEUE_LOCAL_STORAGE_KEY);
    return;
  }
  writeRetryQueueLocalStorageItems(rollbackItems);
}

function assertRestorableRetryQueueItems(
  ownerUserId: string,
  items: UnknownRecord[],
): UnknownRecord[] {
  const invalidItems = items.filter(item => (
    !isRestorableRetryQueueItem(item) || item['sourceUserId'] !== ownerUserId
  ));
  if (invalidItems.length > 0) {
    throw new Error(
      `unrestorable retryQueue item(s): ${invalidItems.map(describeRetryQueueItem).join(', ')}`,
    );
  }
  return items;
}

function describeRetryQueueItem(item: UnknownRecord): string {
  const id = nonEmptyStringOrFallback(item['id'], 'missing-id');
  const operationId = nonEmptyStringOrFallback(item['operationId'], 'missing-operationId');
  const type = nonEmptyStringOrFallback(item['type'], 'missing-type');
  const operation = nonEmptyStringOrFallback(item['operation'], 'missing-operation');
  return `${id} (${operationId}, ${type}:${operation})`;
}

function isRestorableRetryQueueItem(item: UnknownRecord): boolean {
  return isNonEmptyString(item['id'])
    && isNonEmptyString(item['operationId'])
    && isNonEmptyString(item['sourceUserId'])
    && isNonEmptyString(item['type'])
    && isNonEmptyString(item['operation'])
    && isUnknownRecord(item['data'])
    && isNonEmptyString(item['data']['id'])
    && Number.isInteger(item['retryCount'])
    && (item['retryCount'] as number) >= 0
    && typeof item['createdAt'] === 'number'
    && Number.isFinite(item['createdAt']);
}

function readRetryQueueLocalStorageItems(): UnknownRecord[] {
  return parseRetryQueueLocalStorageItems(
    localStorage.getItem(RETRY_QUEUE_LOCAL_STORAGE_KEY),
    'existing',
  );
}

function parseRetryQueueLocalStorageItems(
  raw: string | null,
  label: 'existing' | 'snapshot',
): UnknownRecord[] {
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} retryQueue localStorage is invalid JSON: ${formatRestoreError(error)}`);
  }
  if (!isUnknownRecord(parsed) || !Array.isArray(parsed['items'])) {
    throw new Error(`${label} retryQueue localStorage has invalid shape`);
  }
  if (parsed['version'] !== RETRY_QUEUE_LOCAL_STORAGE_VERSION) {
    throw new Error(`${label} retryQueue localStorage has unsupported version: ${String(parsed['version'])}`);
  }
  if (parsed['items'].some(item => !isUnknownRecord(item))) {
    throw new Error(`${label} retryQueue localStorage contains invalid item(s)`);
  }
  return parsed['items'] as UnknownRecord[];
}

function writeRetryQueueLocalStorageItems(items: UnknownRecord[]): void {
  localStorage.setItem(RETRY_QUEUE_LOCAL_STORAGE_KEY, JSON.stringify({
    version: RETRY_QUEUE_LOCAL_STORAGE_VERSION,
    items,
    savedAt: Date.now(),
  }));
}

function mergeRetryQueueItemsForOwner(
  existingItems: UnknownRecord[],
  restoredItems: UnknownRecord[],
  ownerUserId: string,
): UnknownRecord[] {
  const preservedItems = existingItems.filter(item => item['sourceUserId'] !== ownerUserId);
  assertNoRetryQueueIdentityConflicts(preservedItems, restoredItems);
  return [...preservedItems, ...restoredItems];
}

function assertNoRetryQueueIdentityConflicts(
  preservedItems: UnknownRecord[],
  restoredItems: UnknownRecord[],
): void {
  const preservedIds = stringFieldSet(preservedItems, 'id');
  const conflictingIds = stringFieldValues(restoredItems, 'id').filter(id => preservedIds.has(id));
  if (conflictingIds.length > 0) {
    throw new Error(`retryQueue item id conflicts with another owner: ${conflictingIds.join(', ')}`);
  }
  const preservedOperationIds = stringFieldSet(preservedItems, 'operationId');
  const conflictingOperationIds = stringFieldValues(restoredItems, 'operationId')
    .filter(operationId => preservedOperationIds.has(operationId));
  if (conflictingOperationIds.length > 0) {
    throw new Error(
      `retryQueue operationId conflicts with another owner: ${conflictingOperationIds.join(', ')}`,
    );
  }
}

function buildRetryQueueRollbackItems(
  currentItems: UnknownRecord[],
  snapshotItems: UnknownRecord[],
  restoredItems: UnknownRecord[] | undefined,
  ownerUserId: string,
): UnknownRecord[] {
  const expectedRestoredItems = new Map(
    (restoredItems ?? [])
      .filter(item => item['sourceUserId'] === ownerUserId)
      .map(item => [retryQueueIdentity(item), item]),
  );
  const snapshotOwnerItems = snapshotItems.filter(item => item['sourceUserId'] === ownerUserId);
  const preservedItems = currentItems.filter(item => shouldPreserveRollbackItem(
    item,
    snapshotOwnerItems,
    expectedRestoredItems,
    ownerUserId,
    restoredItems !== undefined,
  ));
  return appendNonConflictingSnapshotItems(preservedItems, snapshotOwnerItems);
}

function shouldPreserveRollbackItem(
  item: UnknownRecord,
  snapshotOwnerItems: UnknownRecord[],
  expectedRestoredItems: Map<string, UnknownRecord>,
  ownerUserId: string,
  hasRestoreIdentity: boolean,
): boolean {
  if (item['sourceUserId'] !== ownerUserId) return true;
  const expected = expectedRestoredItems.get(retryQueueIdentity(item));
  if (expected) return stableStringify(item) !== stableStringify(expected);
  if (hasRestoreIdentity) return true;
  const snapshotItem = snapshotOwnerItems.find(candidate => candidate['id'] === item['id']);
  return snapshotItem !== undefined && snapshotItem['operationId'] !== item['operationId'];
}

function appendNonConflictingSnapshotItems(
  preservedItems: UnknownRecord[],
  snapshotOwnerItems: UnknownRecord[],
): UnknownRecord[] {
  const result = [...preservedItems];
  const ids = stringFieldSet(result, 'id');
  const operationIds = stringFieldSet(result, 'operationId');
  for (const item of snapshotOwnerItems) {
    const id = item['id'];
    const operationId = item['operationId'];
    if ((typeof id === 'string' && ids.has(id))
      || (typeof operationId === 'string' && operationIds.has(operationId))) {
      continue;
    }
    result.push(item);
    if (typeof id === 'string') ids.add(id);
    if (typeof operationId === 'string') operationIds.add(operationId);
  }
  return result;
}

async function restoreRetryQueueToIndexedDb(
  ownerUserId: string,
  items: UnknownRecord[],
): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  const retryDb = await openRetryQueueDatabase();
  try {
    await updateRetryQueueItems(
      retryDb,
      existingItems => mergeRetryQueueItemsForOwner(existingItems, items, ownerUserId),
    );
  } finally {
    retryDb.close();
  }
}

function updateRetryQueueItems(
  retryDb: IDBDatabase,
  update: (items: UnknownRecord[]) => UnknownRecord[],
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = retryDb.transaction(RETRY_QUEUE_STORE_NAME, 'readwrite');
    const store = tx.objectStore(RETRY_QUEUE_STORE_NAME);
    const request = store.getAll();
    let updateError: unknown = null;
    request.onsuccess = () => {
      try {
        const items = update(request.result as UnknownRecord[]);
        store.clear();
        items.forEach(item => store.put(item));
      } catch (error) {
        updateError = error;
        tx.abort();
      }
    };
    request.onerror = () => {
      updateError = request.error ?? new Error('Failed to read RetryQueue items');
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(updateError ?? tx.error ?? new Error('RetryQueue update failed'));
    tx.onabort = () => reject(updateError ?? tx.error ?? new Error('RetryQueue update aborted'));
  });
}

function readRetryQueueItems(
  retryDb: IDBDatabase,
  mode: IDBTransactionMode,
): Promise<UnknownRecord[]> {
  return new Promise((resolve, reject) => {
    const tx = retryDb.transaction(RETRY_QUEUE_STORE_NAME, mode);
    const request = tx.objectStore(RETRY_QUEUE_STORE_NAME).getAll();
    request.onsuccess = () => resolve(request.result as UnknownRecord[]);
    request.onerror = () => reject(request.error);
    tx.onabort = () => reject(tx.error ?? new Error('RetryQueue read aborted'));
  });
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

function assertRestoreContinuation(canContinue: RestoreContinuation): void {
  if (!canContinue()) {
    throw new Error('data-safety restore marker ownership lost during RetryQueue rollback');
  }
}

function retryQueueIdentity(item: UnknownRecord): string {
  return `${String(item['id'])}\u0000${String(item['operationId'])}`;
}

function stringFieldSet(items: UnknownRecord[], field: string): Set<string> {
  return new Set(stringFieldValues(items, field));
}

function stringFieldValues(items: UnknownRecord[], field: string): string[] {
  return items
    .map(item => item[field])
    .filter((value): value is string => typeof value === 'string');
}

function nonEmptyStringOrFallback(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isUnknownRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(item => stableStringify(item)).join(',')}]`;
  if (isUnknownRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function formatRestoreError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
