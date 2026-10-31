import type {
  DataSafetyDeadLetterItem,
  DataSafetyQueuedAction,
} from './data-safety-package';
import { LOCAL_QUEUE_CONFIG } from './action-queue-storage.helpers';
import {
  QUEUE_BACKUP_DB_NAME,
  QUEUE_BACKUP_DB_VERSION,
  QUEUE_BACKUP_STORE_NAME,
  type DeadLetterBackupRecord,
  type QueueBackupRecord,
} from './queue-backup.service';
import type { DeadLetterItem, QueuedAction } from './action-queue.types';
import {
  canonicalizePersistedValue,
  isPersistedQueuedAction,
  isQueueBackupPersonalRestoreTransition,
  preservesPreparedRestoreActions,
} from './action-queue-identity.helpers';

type UnknownRecord = Record<string, unknown>;

export async function restoreActionQueue(
  ownerUserId: string,
  queue: DataSafetyQueuedAction[],
): Promise<void> {
  const restorableQueue = assertRestorableActionQueueItems(
    queue.map(item => ({ ...item })),
  );
  await restoreActionQueueToQueueBackup(ownerUserId, restorableQueue);
  if (typeof localStorage === 'undefined') {
    return;
  }

  localStorage.setItem(
    `${LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY}.${ownerUserId}`,
    JSON.stringify(restorableQueue),
  );
}

export async function restoreDeadLetters(
  ownerUserId: string,
  queue: DataSafetyDeadLetterItem[],
): Promise<void> {
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

export async function readQueueBackupRecord<T extends QueueBackupRecord | DeadLetterBackupRecord>(
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

export async function restoreQueueBackupRecord(
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
    const request = store.get(recordId);
    let protectionError: Error | undefined;
    request.onsuccess = () => {
      const current = request.result as QueueBackupRecord | DeadLetterBackupRecord | undefined;
      const transition = isUnknownRecord(current)
        ? current['personalRestoreTransition']
        : undefined;
      if (transition !== undefined) {
        const prepared = normalizeQueueBackupRecord(current);
        if (!prepared || !record
          || canonicalizePersistedValue(prepared) !== canonicalizePersistedValue(record)) {
          protectionError = new Error(
            'DataSafety rollback cannot replace a prepared personal restore',
          );
          tx.abort();
          return;
        }
      }
      if (record) store.put(record);
      else store.delete(recordId);
    };
    request.onerror = () => tx.abort();
    try {
      await waitForTransaction(tx);
    } catch (error) {
      throw protectionError ?? error;
    }
    const readback = await getFromStore<QueueBackupRecord | DeadLetterBackupRecord>(
      queueBackupDb, QUEUE_BACKUP_STORE_NAME, recordId,
    );
    if (canonicalizePersistedValue(readback) !== canonicalizePersistedValue(record)) {
      throw new Error('DataSafety queue backup rollback readback mismatch');
    }
  } finally {
    queueBackupDb.close();
  }
}

export function normalizeQueueBackupRecord(value: unknown): QueueBackupRecord | null {
  if (!isUnknownRecord(value)
    || typeof value['id'] !== 'string'
    || typeof value['ownerUserId'] !== 'string'
    || !Array.isArray(value['actions'])
    || typeof value['savedAt'] !== 'string'
    || !value['actions'].every(isRestorableQueuedAction)
  ) {
    return null;
  }
  const transition = value['personalRestoreTransition'];
  if (transition !== undefined && (!isQueueBackupPersonalRestoreTransition(transition)
    || transition.ownerUserId !== value['ownerUserId']
    || !transition.preimage.every(isRestorableQueuedAction)
    || !transition.restoredActions.every(isRestorableQueuedAction)
    || !preservesPreparedRestoreActions(
      value['actions'] as QueuedAction[], value['actions'] as QueuedAction[], transition,
    ))) {
    return null;
  }
  return value as unknown as QueueBackupRecord;
}

export function normalizeDeadLetterBackupRecord(value: unknown): DeadLetterBackupRecord | null {
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

async function restoreActionQueueToQueueBackup(
  ownerUserId: string, queue: QueuedAction[],
): Promise<void> {
  if (typeof indexedDB === 'undefined') {
    return;
  }

  const queueBackupDb = await openQueueBackupDatabase();
  try {
    const tx = queueBackupDb.transaction(QUEUE_BACKUP_STORE_NAME, 'readwrite');
    const store = tx.objectStore(QUEUE_BACKUP_STORE_NAME);
    const recordId = `queue-backup:${ownerUserId}`;
    const request = store.get(recordId);
    let protectionError: Error | undefined;
    let nextRecord: QueueBackupRecord | undefined;
    request.onsuccess = () => {
      const existing = request.result as QueueBackupRecord | undefined;
      const transition = existing?.personalRestoreTransition;
      if (transition !== undefined && (!isQueueBackupPersonalRestoreTransition(transition)
        || transition.ownerUserId !== ownerUserId
        || !preservesPreparedRestoreActions(existing!.actions, queue, transition))) {
        protectionError = new Error('DataSafety restore cannot replace a prepared personal restore');
        tx.abort();
        return;
      }
      nextRecord = {
        ...existing,
        id: recordId,
        ownerUserId,
        actions: queue,
        savedAt: new Date().toISOString(),
      } satisfies QueueBackupRecord;
      store.put(nextRecord);
    };
    request.onerror = () => tx.abort();
    try {
      await waitForTransaction(tx);
    } catch (error) {
      throw protectionError ?? error;
    }
    const readback = await getFromStore<QueueBackupRecord>(
      queueBackupDb, QUEUE_BACKUP_STORE_NAME, recordId,
    );
    if (!nextRecord
      || canonicalizePersistedValue(readback) !== canonicalizePersistedValue(nextRecord)) {
      throw new Error('DataSafety queue backup readback mismatch');
    }
  } finally {
    queueBackupDb.close();
  }
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

async function restoreDeadLettersToQueueBackup(
  ownerUserId: string,
  queue: DeadLetterItem[],
): Promise<void> {
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

function isRestorableQueuedAction(action: unknown): action is DataSafetyQueuedAction & QueuedAction {
  return isPersistedQueuedAction(action);
}

function isRestorableDeadLetterItem(
  item: DataSafetyDeadLetterItem,
): item is DataSafetyDeadLetterItem & DeadLetterItem {
  return typeof item['failedAt'] === 'string'
    && typeof item['reason'] === 'string'
    && isRestorableQueuedAction(item['action'] as DataSafetyQueuedAction);
}

function getFromStore<T>(
  db: IDBDatabase,
  storeName: string,
  key: IDBValidKey,
): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    let value: T | null = null;
    const request = tx.objectStore(storeName).get(key);
    request.onsuccess = () => { value = request.result ?? null; };
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => resolve(value);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB read transaction aborted'));
  });
}

function waitForTransaction(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

function isUnknownRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyStringOrFallback(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}
