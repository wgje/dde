import type { OfflineAudioCacheEntry } from '../models/focus';

type OfflineReplayCallbacks = {
  items: OfflineAudioCacheEntry[];
  replayOwnerUserId: string;
  unknownOwnerUserId: string;
  batchSize: number;
  isReplayOwnerActive: (ownerUserId: string) => boolean;
  transcribe: (blob: Blob) => Promise<string>;
  persist: (itemId: string, text: string, ownerUserId: string) => Promise<boolean>;
  deleteFromCache: (id: string) => Promise<void>;
  onQuarantinedSkip: (itemId: string) => void;
  onForeignOwnerSkip: (itemId: string, hasOwnerUserId: boolean) => void;
  onOwnerChangedBeforeItem: (ownerUserId: string) => void;
  onOwnerChangedBeforePersistence: (itemId: string, ownerUserId: string) => void;
  onPersistenceFailure: (itemId: string) => void;
  onProcessed: (itemId: string, text: string) => void;
  onError: (error: unknown, itemId: string) => 'continue' | 'stop' | Promise<'continue' | 'stop'>;
};

type OfflineReplayResult = {
  results: { id: string; text: string }[];
  stoppedByBudget: boolean;
};

type OfflineReplayItemDecision = 'process' | 'skip' | 'stop' | 'budget-exhausted';

export async function replayOfflineAudioItems(callbacks: OfflineReplayCallbacks): Promise<OfflineReplayResult> {
  const results: { id: string; text: string }[] = [];
  let processedOwnedItems = 0;

  for (const item of callbacks.items) {
    const decision = classifyOfflineReplayItem(item, processedOwnedItems, callbacks);
    if (decision === 'stop') break;
    if (decision === 'skip') continue;
    if (decision === 'budget-exhausted') return { results, stoppedByBudget: true };

    processedOwnedItems += 1;
    const processResult = await processOwnedOfflineAudioItem(item, callbacks);
    if (processResult === 'stop') break;
    if (processResult !== 'continue') results.push(processResult);
  }

  return { results, stoppedByBudget: false };
}

function classifyOfflineReplayItem(
  item: OfflineAudioCacheEntry,
  processedOwnedItems: number,
  callbacks: OfflineReplayCallbacks
): OfflineReplayItemDecision {
  if (!callbacks.isReplayOwnerActive(callbacks.replayOwnerUserId)) {
    callbacks.onOwnerChangedBeforeItem(callbacks.replayOwnerUserId);
    return 'stop';
  }

  if (item.ownerUserId === callbacks.unknownOwnerUserId) {
    callbacks.onQuarantinedSkip(item.id);
    return 'skip';
  }

  if (!item.ownerUserId || item.ownerUserId !== callbacks.replayOwnerUserId) {
    callbacks.onForeignOwnerSkip(item.id, !!item.ownerUserId);
    return 'skip';
  }

  return processedOwnedItems >= callbacks.batchSize ? 'budget-exhausted' : 'process';
}

async function processOwnedOfflineAudioItem(
  item: OfflineAudioCacheEntry,
  callbacks: OfflineReplayCallbacks
): Promise<{ id: string; text: string } | 'continue' | 'stop'> {
  try {
    const text = await callbacks.transcribe(item.blob);

    if (!callbacks.isReplayOwnerActive(callbacks.replayOwnerUserId)) {
      callbacks.onOwnerChangedBeforePersistence(item.id, callbacks.replayOwnerUserId);
      return 'stop';
    }

    if (text.trim() && !(await callbacks.persist(item.id, text, callbacks.replayOwnerUserId))) {
      callbacks.onPersistenceFailure(item.id);
      return 'stop';
    }

    await callbacks.deleteFromCache(item.id);
    callbacks.onProcessed(item.id, text);
    return { id: item.id, text };
  } catch (error) {
    return await callbacks.onError(error, item.id);
  }
}
