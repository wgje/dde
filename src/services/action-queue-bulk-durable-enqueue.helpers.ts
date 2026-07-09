import type { EnqueueMutationResult } from './action-queue-enqueue-mutation.service';
import type {
  EnqueueParams,
  QueuedAction,
} from './action-queue.types';

export interface BulkDurableEnqueueMutationRecord {
  action: EnqueueParams;
  queuedAction: QueuedAction;
  mutation: EnqueueMutationResult;
}

interface BulkDurableEnqueueMutationState {
  resolvedActionIds: string[];
  acceptedMutations: BulkDurableEnqueueMutationRecord[];
  rejectedAction: EnqueueParams | null;
}

export interface BulkDurableEnqueueMutationOutcome
  extends BulkDurableEnqueueMutationState {
  persistedQueue: QueuedAction[] | null;
  error: unknown | null;
}

export interface PersistBulkDurableEnqueueMutationOptions {
  actions: EnqueueParams[];
  getCurrentOwnerUserId: () => string;
  createQueuedAction: (action: EnqueueParams) => QueuedAction;
  buildCurrentOwnerEnqueueMutation: (
    queue: QueuedAction[],
    action: EnqueueParams,
    queuedAction: QueuedAction,
  ) => EnqueueMutationResult;
  persistQueueMutationForOwner: (
    ownerUserId: string,
    mutateQueue: (queue: QueuedAction[]) => QueuedAction[],
  ) => Promise<QueuedAction[] | null>;
}

export interface RunBulkDurableEnqueueOptions
  extends PersistBulkDurableEnqueueMutationOptions {
  enqueueSingle: (action: EnqueueParams) => Promise<string>;
  readPendingActions: () => QueuedAction[];
  warnIfQueueFrozen: (action: EnqueueParams) => void;
  rollbackFailedBulkDurableEnqueue: (previousQueue: QueuedAction[]) => void;
  applyPersistedCurrentOwnerQueue: (persistedQueue: QueuedAction[]) => void;
  completeDurableEnqueueSideEffects: (
    action: EnqueueParams,
    queuedAction: QueuedAction,
    resolvedActionId: string,
    removeRetrySourceOnSuccess: boolean,
  ) => void;
  isOnline: () => boolean;
  processQueue: () => Promise<unknown>;
  warn: (message: string, context: unknown) => void;
}

export async function runBulkDurableEnqueue(
  options: RunBulkDurableEnqueueOptions,
): Promise<string[]> {
  if (options.actions.length === 0) {
    return [];
  }

  if (options.actions.length === 1) {
    const actionId = await options.enqueueSingle(options.actions[0]);
    return actionId ? [actionId] : [];
  }

  const previousQueue = [...options.readPendingActions()];
  options.actions.forEach(action => options.warnIfQueueFrozen(action));
  const outcome = await persistBulkDurableEnqueueMutation(options);

  if (outcome.error) {
    logFailedBulkDurableEnqueueMutation(outcome, options.warn);
    options.rollbackFailedBulkDurableEnqueue(previousQueue);
    return [];
  }

  if (!outcome.persistedQueue || outcome.resolvedActionIds.length !== options.actions.length) {
    logUnconfirmedBulkDurableEnqueue(options.actions.length, outcome, options.warn);
    options.rollbackFailedBulkDurableEnqueue(previousQueue);
    return [];
  }

  options.applyPersistedCurrentOwnerQueue(outcome.persistedQueue);
  completeBulkDurableEnqueueSideEffects(outcome.acceptedMutations, options);

  if (options.isOnline()) {
    void options.processQueue();
  }

  return [...outcome.resolvedActionIds];
}

export async function persistBulkDurableEnqueueMutation(
  options: PersistBulkDurableEnqueueMutationOptions,
): Promise<BulkDurableEnqueueMutationOutcome> {
  const queuedActions = options.actions.map(action =>
    options.createQueuedAction(action));
  const state = createBulkDurableEnqueueMutationState();

  try {
    const persistedQueue = await options.persistQueueMutationForOwner(
      options.getCurrentOwnerUserId(),
      queue => buildBulkDurableEnqueueMutation(queue, queuedActions, state, options),
    );

    return { ...state, persistedQueue, error: null };
  } catch (error) {
    return { ...state, persistedQueue: null, error };
  }
}

function logFailedBulkDurableEnqueueMutation(
  outcome: BulkDurableEnqueueMutationOutcome,
  warn: RunBulkDurableEnqueueOptions['warn'],
): void {
  warn('ActionQueue bulk durable enqueue 未能完成原子持久化', {
    rejectedEntityType: outcome.rejectedAction?.entityType,
    rejectedEntityId: outcome.rejectedAction?.entityId,
    error: outcome.error,
  });
}

function logUnconfirmedBulkDurableEnqueue(
  actionCount: number,
  outcome: BulkDurableEnqueueMutationOutcome,
  warn: RunBulkDurableEnqueueOptions['warn'],
): void {
  warn('ActionQueue bulk durable enqueue 未能完成持久化确认', {
    actionCount,
    resolvedActionCount: outcome.resolvedActionIds.length,
  });
}

function completeBulkDurableEnqueueSideEffects(
  acceptedMutations: BulkDurableEnqueueMutationRecord[],
  options: RunBulkDurableEnqueueOptions,
): void {
  for (const { action, queuedAction, mutation } of acceptedMutations) {
    if (!mutation.wasEnqueued || mutation.wasMergeShrunk) {
      continue;
    }
    options.completeDurableEnqueueSideEffects(
      action,
      queuedAction,
      mutation.resolvedActionId || queuedAction.id,
      true,
    );
  }
}

function createBulkDurableEnqueueMutationState(): BulkDurableEnqueueMutationState {
  return {
    resolvedActionIds: [],
    acceptedMutations: [],
    rejectedAction: null,
  };
}

function buildBulkDurableEnqueueMutation(
  queue: QueuedAction[],
  queuedActions: QueuedAction[],
  state: BulkDurableEnqueueMutationState,
  options: PersistBulkDurableEnqueueMutationOptions,
): QueuedAction[] {
  let nextQueue = queue;
  state.resolvedActionIds.length = 0;
  state.acceptedMutations.length = 0;
  state.rejectedAction = null;

  for (let index = 0; index < options.actions.length; index++) {
    const action = options.actions[index];
    const queuedAction = queuedActions[index];
    const mutation = options.buildCurrentOwnerEnqueueMutation(
      nextQueue,
      action,
      queuedAction,
    );

    const resolvedActionId = mutation.resolvedActionId || queuedAction.id;
    if (
      !isAcceptedDurableEnqueueMutation(mutation) ||
      resolvedActionId.length === 0
    ) {
      state.rejectedAction = action;
      throw new Error('ActionQueue bulk enqueue rejected action');
    }

    nextQueue = mutation.nextQueue;
    state.resolvedActionIds.push(resolvedActionId);
    state.acceptedMutations.push({ action, queuedAction, mutation });
  }

  return nextQueue;
}

function isAcceptedDurableEnqueueMutation(
  mutation: EnqueueMutationResult,
): boolean {
  return (
    mutation.wasEnqueued ||
    mutation.wasMergeShrunk ||
    mutation.resolvedActionId.length > 0
  );
}
