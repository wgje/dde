import { AUTH_CONFIG } from '../config/auth.config';
import type { DeadLetterItem, QueuedAction } from './action-queue.types';
import { LOCAL_QUEUE_CONFIG } from './action-queue-storage.helpers';
import type { QueueSnapshot } from './action-queue-owner-storage.types';
import { normalizeQueueForOutbox } from './action-queue-outbox-normalization.helpers';

export interface ActionQueueOwnerStorageLocalLogger {
  warn(message: string, context?: unknown): void;
}

export type ActionQueueOwnerScopedStorageKeyResolver = (
  baseKey: string,
  ownerUserId: string,
) => string;

export interface ActionQueueOwnerScopedStorageOptions {
  ownerUserId: string;
  getScopedStorageKey: ActionQueueOwnerScopedStorageKeyResolver;
  logger: ActionQueueOwnerStorageLocalLogger;
}

export function clearLegacyGlobalStorageForLocalOwner(ownerUserId: string, baseKey: string): void {
  if (ownerUserId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
    localStorage.removeItem(baseKey);
  }
}

export function writeOwnerScopedLocalStorageValue(
  baseKey: string,
  ownerUserId: string,
  value: unknown,
  getScopedStorageKey: ActionQueueOwnerScopedStorageKeyResolver,
): void {
  localStorage.setItem(
    getScopedStorageKey(baseKey, ownerUserId),
    JSON.stringify(value),
  );
  clearLegacyGlobalStorageForLocalOwner(ownerUserId, baseKey);
}

export function readOwnerQueueSnapshotFromLocalStorage(
  options: ActionQueueOwnerScopedStorageOptions,
): QueueSnapshot {
  if (typeof localStorage === 'undefined') {
    return { found: false, queue: [] };
  }

  const storageKey = options.getScopedStorageKey(LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY, options.ownerUserId);
  const scopedValue = localStorage.getItem(storageKey);
  if (scopedValue === null) {
    return { found: false, queue: [] };
  }

  try {
    const queue = JSON.parse(scopedValue) as QueuedAction[];
    if (!Array.isArray(queue)) {
      const error = new Error('owner-scoped queue snapshot is not an array');
      warnLocalStorageReadFailure(options, '读取 owner-scoped 队列失败，快照结构无效', {
        ownerUserId: options.ownerUserId,
        storageKey,
        error,
      });
      return { found: false, queue: [], corrupted: true, storageKey, error };
    }
    return { found: true, queue: normalizeQueueForOutbox(queue), storageKey };
  } catch (error) {
    warnLocalStorageReadFailure(options, '读取 owner-scoped 队列失败，尝试 IndexedDB 备份恢复', {
      ownerUserId: options.ownerUserId,
      storageKey,
      error,
    });
    return { found: false, queue: [], corrupted: true, storageKey, error };
  }
}

export function readOwnerDeadLetterSnapshotFromLocalStorage(
  options: ActionQueueOwnerScopedStorageOptions,
): DeadLetterItem[] {
  if (typeof localStorage === 'undefined') {
    return [];
  }

  const scopedValue = localStorage.getItem(
    options.getScopedStorageKey(LOCAL_QUEUE_CONFIG.DEAD_LETTER_STORAGE_KEY, options.ownerUserId),
  );
  if (scopedValue === null) {
    return [];
  }

  try {
    const queue = JSON.parse(scopedValue) as DeadLetterItem[];
    return Array.isArray(queue) ? queue : [];
  } catch (error) {
    warnLocalStorageReadFailure(options, '读取 owner-scoped dead-letter 失败，按空队列处理', {
      ownerUserId: options.ownerUserId,
      error,
    });
    return [];
  }
}

function warnLocalStorageReadFailure(
  options: ActionQueueOwnerScopedStorageOptions,
  message: string,
  context: unknown,
): void {
  try {
    options.logger.warn(message, context);
  } catch {
    // Local snapshot recovery must not depend on the logging sink being healthy.
  }
}
