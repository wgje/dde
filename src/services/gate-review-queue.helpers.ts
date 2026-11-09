export type GateReviewQueueRefreshSource = 'checkGate' | 'signal' | 'remote';

export interface RemoteEmptyQueueState {
  remoteEmptyNeedsConfirmation: boolean;
  remoteEmptyBlockedByLocalAction: boolean;
  firstRemoteEmptyProbe: boolean;
  confirmedRemoteEmpty: boolean;
  preserveCurrentDuringTransientEmpty: boolean;
}

interface RemoteEmptyQueueStateInput {
  latestPendingLength: number;
  source: GateReviewQueueRefreshSource;
  safeIndex: number;
  currentLength: number;
  hasLocalAction: boolean;
  remoteEmptyQueueConfirmations: number;
}

export function resolveRemoteEmptyQueueState(input: RemoteEmptyQueueStateInput): RemoteEmptyQueueState {
  const remoteEmptyNeedsConfirmation =
    input.source === 'remote'
    && input.latestPendingLength === 0
    && input.safeIndex < input.currentLength;
  const remoteEmptyBlockedByLocalAction = remoteEmptyNeedsConfirmation && input.hasLocalAction;
  const firstRemoteEmptyProbe = remoteEmptyNeedsConfirmation
    && !remoteEmptyBlockedByLocalAction
    && input.remoteEmptyQueueConfirmations === 0;
  const confirmedRemoteEmpty = remoteEmptyNeedsConfirmation
    && !remoteEmptyBlockedByLocalAction
    && input.remoteEmptyQueueConfirmations > 0;

  return {
    remoteEmptyNeedsConfirmation,
    remoteEmptyBlockedByLocalAction,
    firstRemoteEmptyProbe,
    confirmedRemoteEmpty,
    preserveCurrentDuringTransientEmpty: input.latestPendingLength === 0
      && input.safeIndex < input.currentLength
      && (input.source !== 'remote' || firstRemoteEmptyProbe),
  };
}

export function buildNextReviewingQueue<T extends { id: string }>(input: {
  currentItems: readonly T[];
  latestPending: readonly T[];
  safeIndex: number;
  remoteEmptyState: RemoteEmptyQueueState;
  hasActionInFlight: boolean;
}): T[] {
  const currentReviewItemCount = input.safeIndex < input.currentItems.length
    && (input.hasActionInFlight || input.remoteEmptyState.preserveCurrentDuringTransientEmpty)
    ? 1
    : 0;
  const preserveFullQueue = input.remoteEmptyState.firstRemoteEmptyProbe
    || input.remoteEmptyState.remoteEmptyBlockedByLocalAction;
  const preserveCount = preserveFullQueue
    ? input.currentItems.length
    : input.remoteEmptyState.confirmedRemoteEmpty
      ? 0
      : Math.min(input.safeIndex + currentReviewItemCount, input.currentItems.length);
  const preservedPrefix = input.currentItems.slice(0, preserveCount);
  const preservedIds = new Set(preservedPrefix.map(item => item.id));
  const nextUnprocessed = input.latestPending.filter(item => !preservedIds.has(item.id));
  return [...preservedPrefix, ...nextUnprocessed];
}

export function isSameGateQueue<T extends { id: string; updatedAt?: string | null }>(
  a: readonly T[],
  b: readonly T[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id) return false;
    if (a[i].updatedAt !== b[i].updatedAt) return false;
  }
  return true;
}
