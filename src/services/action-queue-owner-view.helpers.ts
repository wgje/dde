import type { EnqueueMutationResult } from './action-queue-enqueue-mutation.service';
import type { DurableEnqueueMutationOutcome } from './action-queue-state.helpers';
import type { EnqueueParams, QueuedAction } from './action-queue.types';

type PersistQueueMutationForOwner = (
  ownerUserId: string,
  mutateQueue: (queue: QueuedAction[]) => QueuedAction[],
) => Promise<QueuedAction[] | null>;

export type PersistQueueMutationWithRetrySupersession = (
  ownerUserId: string,
  mutateQueue: (queue: QueuedAction[]) => QueuedAction[],
  getCandidateActionIds: () => string[],
  persistWithoutSupersession: () => Promise<QueuedAction[] | null>,
) => Promise<QueuedAction[] | null>;

export interface PersistActionQueueCurrentOwnerEnqueueMutationParams {
  ownerUserId: string;
  action: EnqueueParams;
  queuedAction: QueuedAction;
  persistQueueMutationForOwner: PersistQueueMutationForOwner;
  persistQueueMutationWithRetrySupersession?: PersistQueueMutationWithRetrySupersession;
  buildCurrentOwnerEnqueueMutation: (
    queue: QueuedAction[],
    action: EnqueueParams,
    queuedAction: QueuedAction,
  ) => EnqueueMutationResult;
}

export async function persistActionQueueCurrentOwnerEnqueueMutation({
  ownerUserId,
  action,
  queuedAction,
  persistQueueMutationForOwner,
  persistQueueMutationWithRetrySupersession,
  buildCurrentOwnerEnqueueMutation,
}: PersistActionQueueCurrentOwnerEnqueueMutationParams): Promise<DurableEnqueueMutationOutcome> {
  const mutationState: { value: EnqueueMutationResult | null } = { value: null };
  const mutateQueue = (queue: QueuedAction[]) => {
    const nextMutation = buildCurrentOwnerEnqueueMutation(queue, action, queuedAction);
    mutationState.value = nextMutation;
    return nextMutation.nextQueue;
  };
  const getCandidateActionIds = () => {
    const mutation = mutationState.value;
    return mutation?.wasEnqueued && !mutation.wasMergeShrunk && mutation.resolvedActionId
      ? [mutation.resolvedActionId]
      : [];
  };
  const persistWithoutSupersession = () => persistQueueMutationForOwner(ownerUserId, mutateQueue);
  const persistedQueue = persistQueueMutationWithRetrySupersession
    ? await persistQueueMutationWithRetrySupersession(
      ownerUserId,
      mutateQueue,
      getCandidateActionIds,
      persistWithoutSupersession,
    )
    : await persistWithoutSupersession();

  return { persistedQueue, mutation: mutationState.value };
}

export interface EnqueueActionQueueForForeignOwnerParams {
  ownerUserId: string;
  action: EnqueueParams;
  createQueuedAction: (action: EnqueueParams) => QueuedAction;
  persistQueueMutationForOwner: PersistQueueMutationForOwner;
  buildForeignOwnerEnqueueMutation: (
    queue: QueuedAction[],
    action: EnqueueParams,
    queuedAction: QueuedAction,
    ownerUserId: string,
  ) => EnqueueMutationResult;
  logInfo: (message: string, context: Record<string, unknown>) => void;
}

export async function enqueueActionQueueForForeignOwner({
  ownerUserId,
  action,
  createQueuedAction,
  persistQueueMutationForOwner,
  buildForeignOwnerEnqueueMutation,
  logInfo,
}: EnqueueActionQueueForForeignOwnerParams): Promise<string> {
  const queuedAction = createQueuedAction(action);
  const mutationState: { value: EnqueueMutationResult | null } = { value: null };
  const persistedQueue = await persistQueueMutationForOwner(ownerUserId, queue => {
    const nextMutation = buildForeignOwnerEnqueueMutation(queue, action, queuedAction, ownerUserId);
    mutationState.value = nextMutation;
    return nextMutation.nextQueue;
  });
  const mutation = mutationState.value;
  if (!mutation?.resolvedActionId || !persistedQueue) {
    return '';
  }

  logInfo('已将离线操作 durably 写入指定 owner 队列', {
    ownerUserId,
    actionId: mutation.resolvedActionId,
    type: queuedAction.type,
    entityType: queuedAction.entityType,
    entityId: queuedAction.entityId,
  });

  return mutation.resolvedActionId;
}
