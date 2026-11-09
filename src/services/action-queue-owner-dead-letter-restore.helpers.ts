import { LOCAL_QUEUE_CONFIG } from './action-queue-storage.helpers';
import type { DeadLetterItem } from './action-queue.types';
import {
  getQueuedActionOperationIdentity,
  normalizeQueuedActionForOutbox,
} from './action-queue-outbox-normalization.helpers';

export function normalizeStoredDeadLetters(
  queue: DeadLetterItem[],
  now = Date.now(),
): { queue: DeadLetterItem[]; repairedCount: number; agedCount: number } {
  let repairedCount = 0;
  let agedCount = 0;
  const normalizedQueue = queue.map(item => {
    const failedTime = new Date(item.failedAt).getTime();
    if (!Number.isFinite(failedTime)) {
      repairedCount += 1;
      return { ...item, failedAt: new Date(now).toISOString() };
    }
    if (now - failedTime >= LOCAL_QUEUE_CONFIG.DEAD_LETTER_TTL) agedCount += 1;
    return item;
  });
  return { queue: normalizedQueue, repairedCount, agedCount };
}

export function extractRestorableDeadLetters(
  items: unknown[],
  ownerUserId: string,
  resolveOwnerUserId: (item: DeadLetterItem) => string,
): DeadLetterItem[] {
  if (!Array.isArray(items) || ownerUserId.length === 0) {
    return [];
  }

  // §5.6：死信备份恢复不再按 TTL 静默丢弃（超龄条目保留供导出/重试/放弃），
  // 非法 failedAt 修复为当前时间保留；owner 过滤与形状校验保持不变。
  const now = Date.now();
  return items.filter((item): item is DeadLetterItem => {
    if (!isRestorableDeadLetterShape(item)) {
      return false;
    }

    return resolveRestorableDeadLetterOwnerUserId(item, resolveOwnerUserId) === ownerUserId;
  }).map(item => ({
    ...item,
    failedAt: Number.isFinite(new Date(item.failedAt).getTime())
      ? item.failedAt
      : new Date(now).toISOString(),
    action: {
      ...normalizeQueuedActionForOutbox(item.action),
      syncState: 'dead_letter',
    },
  }));
}

export function mergeRestoredDeadLetters(
  currentQueue: DeadLetterItem[],
  restoredQueue: DeadLetterItem[],
): { queue: DeadLetterItem[]; restoredCount: number } {
  const currentIdentities = new Set<string>();
  const merged: DeadLetterItem[] = [];
  let restoredCount = 0;

  for (const item of currentQueue) {
    const identity = getDeadLetterRestoreIdentity(item);
    if (currentIdentities.has(identity)) {
      continue;
    }

    currentIdentities.add(identity);
    merged.push(item);
  }

  if (merged.length >= LOCAL_QUEUE_CONFIG.MAX_DEAD_LETTER_SIZE) {
    return {
      queue: merged.slice(-LOCAL_QUEUE_CONFIG.MAX_DEAD_LETTER_SIZE),
      restoredCount: 0,
    };
  }

  for (const item of restoredQueue) {
    if (merged.length >= LOCAL_QUEUE_CONFIG.MAX_DEAD_LETTER_SIZE) {
      break;
    }

    const identity = getDeadLetterRestoreIdentity(item);
    if (currentIdentities.has(identity)) {
      continue;
    }

    currentIdentities.add(identity);
    merged.push(item);
    restoredCount += 1;
  }

  return {
    queue: merged,
    restoredCount,
  };
}

function isRestorableDeadLetterShape(item: unknown): item is DeadLetterItem {
  if (!item || typeof item !== 'object') {
    return false;
  }

  const candidate = item as Partial<DeadLetterItem>;
  const operationId = (candidate.action as { operationId?: unknown } | undefined)?.operationId;
  return !!candidate.action
    && typeof candidate.action === 'object'
    && typeof candidate.action.id === 'string'
    && typeof candidate.action.entityId === 'string'
    && (operationId === undefined || typeof operationId === 'string')
    && typeof candidate.action.timestamp === 'number'
    && Number.isFinite(candidate.action.timestamp)
    && typeof candidate.action.retryCount === 'number'
    && Number.isFinite(candidate.action.retryCount)
    && typeof candidate.failedAt === 'string'
    && typeof candidate.reason === 'string';
}

function resolveRestorableDeadLetterOwnerUserId(
  item: DeadLetterItem,
  resolveOwnerUserId: (item: DeadLetterItem) => string,
): string | null {
  let ownerUserId: string | null = null;
  try {
    ownerUserId = resolveOwnerUserId(item);
  } catch {
    // Corrupt backup records should not abort restoration of later valid records.
  }
  return ownerUserId;
}

function getDeadLetterRestoreIdentity(item: DeadLetterItem): string {
  const operationIdentity = getQueuedActionOperationIdentity(item.action.operationId);
  return operationIdentity !== null
    ? `operation:${operationIdentity}`
    : `action:${item.action.id}`;
}
