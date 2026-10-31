import type { QueuedAction } from './action-queue.types';
import type { QueueSnapshot } from './action-queue-owner-storage.types';
import { normalizeQueueForOutbox } from './action-queue-outbox-normalization.helpers';
import { filterLocallyRemovedQueuedActions } from './action-queue-owner-storage-removal-journal';

export function resolveAtomicMutationBaseQueue(
  persistedQueue: QueuedAction[],
  localSnapshot: QueueSnapshot,
  idbRecordFound: boolean,
): QueuedAction[] {
  if (idbRecordFound) {
    const normalizedPersistedQueue = normalizeQueueForOutbox(
      filterLocallyRemovedQueuedActions(persistedQueue, localSnapshot.removedActionIdentities),
    );
    if (!localSnapshot.found || localSnapshot.queue.length === 0 || normalizedPersistedQueue.length === 0) {
      return normalizedPersistedQueue;
    }

    const persistedActionIds = new Set(normalizedPersistedQueue.map(action => action.id));
    if (!localSnapshot.queue.some(action => persistedActionIds.has(action.id))) {
      return normalizedPersistedQueue;
    }

    const localStorageOnlyActions = localSnapshot.queue.filter(action => !persistedActionIds.has(action.id));
    return localStorageOnlyActions.length > 0
      ? [...normalizedPersistedQueue, ...localStorageOnlyActions]
      : normalizedPersistedQueue;
  }

  return localSnapshot.found ? localSnapshot.queue : [];
}
