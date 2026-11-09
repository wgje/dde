import { LOCAL_QUEUE_CONFIG } from './action-queue-storage.helpers';
import type { QueuedAction } from './action-queue.types';

type ScopedStorageKeyResolver = (baseKey: string, ownerUserId: string) => string;

const QUEUE_REMOVAL_JOURNAL_KEY = `${LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY}.removed`;
const MAX_REMOVAL_IDENTITIES = 2000;

export function recordOwnerQueueRemovalsBeforeSnapshotWrite(
  ownerUserId: string,
  nextQueue: QueuedAction[],
  getScopedStorageKey: ScopedStorageKeyResolver,
): void {
  const queueKey = getScopedStorageKey(LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY, ownerUserId);
  const previousQueue = parseStoredQueue(localStorage.getItem(queueKey));
  const nextIdentities = new Set(nextQueue.flatMap(getRemovalIdentities));
  const removedIdentities = previousQueue
    .flatMap(getRemovalIdentities)
    .filter(identity => !nextIdentities.has(identity));
  const retainedJournal = readOwnerQueueRemovalJournal(ownerUserId, getScopedStorageKey)
    .filter(identity => !nextIdentities.has(identity));
  const journal = [...new Set([...retainedJournal, ...removedIdentities])]
    .slice(-MAX_REMOVAL_IDENTITIES);
  const journalKey = getScopedStorageKey(QUEUE_REMOVAL_JOURNAL_KEY, ownerUserId);

  if (journal.length === 0) {
    localStorage.removeItem(journalKey);
    return;
  }
  localStorage.setItem(journalKey, JSON.stringify(journal));
}

export function readOwnerQueueRemovalJournal(
  ownerUserId: string,
  getScopedStorageKey: ScopedStorageKeyResolver,
): string[] {
  if (typeof localStorage === 'undefined') return [];
  const raw = localStorage.getItem(getScopedStorageKey(QUEUE_REMOVAL_JOURNAL_KEY, ownerUserId));
  if (raw === null) return [];

  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((identity): identity is string => typeof identity === 'string' && identity.length > 0)
      : [];
  } catch {
    return [];
  }
}

export function filterLocallyRemovedQueuedActions(
  queue: QueuedAction[],
  removedActionIdentities: readonly string[] | undefined,
): QueuedAction[] {
  if (!removedActionIdentities || removedActionIdentities.length === 0) return queue;
  const removed = new Set(removedActionIdentities);
  return queue.filter(action => !getRemovalIdentities(action).some(identity => removed.has(identity)));
}

function parseStoredQueue(raw: string | null): QueuedAction[] {
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed as QueuedAction[] : [];
  } catch {
    return [];
  }
}

function getRemovalIdentities(action: QueuedAction): string[] {
  const identities = [`id:${action.id}`];
  if (typeof action.operationId === 'string' && action.operationId.length > 0) {
    identities.push(`operation:${action.operationId}`);
  }
  return identities;
}
