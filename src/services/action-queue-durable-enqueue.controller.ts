import type { EnqueueMutationResult } from './action-queue-enqueue-mutation.service';
import {
  persistActionQueueCurrentOwnerEnqueueMutation,
  type PersistQueueMutationWithRetrySupersession,
} from './action-queue-owner-view.helpers';
import type { DurableEnqueueMutationOutcome } from './action-queue-state.helpers';
import type { EnqueueParams, QueuedAction } from './action-queue.types';

export interface ActionQueueDurableEnqueueControllerOptions {
  warnIfQueueFrozen: (action: EnqueueParams) => void;
  createQueuedAction: (action: EnqueueParams) => QueuedAction;
  getCurrentOwnerUserId: () => string;
  persistQueueMutationForOwner: (
    ownerUserId: string,
    mutateQueue: (queue: QueuedAction[]) => QueuedAction[],
  ) => Promise<QueuedAction[] | null>;
  persistQueueMutationWithRetrySupersession?: PersistQueueMutationWithRetrySupersession;
  buildCurrentOwnerEnqueueMutation: (
    queue: QueuedAction[],
    action: EnqueueParams,
    queuedAction: QueuedAction,
  ) => EnqueueMutationResult;
  applyPersistedCurrentOwnerQueue: (persistedQueue: QueuedAction[]) => void;
  runEnqueueSideEffects: (input: {
    action: EnqueueParams;
    queuedAction: QueuedAction;
    resolvedActionId: string;
    removeRetrySourceOnSuccess: boolean;
  }) => void;
  isOnline: () => boolean;
  scheduleProcessQueue: () => void;
  warn: (message: string, context?: Record<string, unknown>) => void;
}

/**
 * 单条 durable enqueue 流水线 — 从 ActionQueueService 拆分
 *
 * 职责：先持久化调用开始时 owner 的队列 mutation，确认落盘且 owner 未切换后
 * 再更新内存视图、触发入队副作用与自动处理；持久化失败不改写当前内存视图。
 * 非 DI 协作类：由 ActionQueueService 构造并注入运行时闭包，
 * 行为由 action-queue.service.spec.ts 的 enqueueDurably 用例覆盖。
 */
export class ActionQueueDurableEnqueueController {
  constructor(private readonly options: ActionQueueDurableEnqueueControllerOptions) {}

  async enqueueDurably(action: EnqueueParams, removeRetrySourceOnSuccess: boolean): Promise<string> {
    const ownerUserId = this.options.getCurrentOwnerUserId();
    this.options.warnIfQueueFrozen(action);

    const queuedAction = this.options.createQueuedAction(action);
    const { persistedQueue, mutation } = await this.persistCurrentOwnerEnqueueMutation(
      ownerUserId,
      action,
      queuedAction,
    );
    if (!mutation) {
      this.options.warn('ActionQueue durable enqueue 未能生成队列 mutation', {
        entityType: action.entityType,
        entityId: action.entityId,
      });
      return '';
    }

    if (!mutation.wasEnqueued && !mutation.wasMergeShrunk) {
      return mutation.resolvedActionId;
    }

    if (!persistedQueue) {
      this.warnFailedDurableEnqueue(action, queuedAction, mutation);
      return '';
    }

    if (ownerUserId !== this.options.getCurrentOwnerUserId()) {
      return mutation.resolvedActionId;
    }

    this.options.applyPersistedCurrentOwnerQueue(persistedQueue);

    if (mutation.wasMergeShrunk) {
      return mutation.resolvedActionId;
    }

    const persistedAction = persistedQueue.find(item => item.id === mutation.resolvedActionId);
    this.completeDurableEnqueue(
      action,
      queuedAction,
      mutation,
      removeRetrySourceOnSuccess && !persistedAction?.retryQueueSupersessions?.length,
    );

    return mutation.resolvedActionId;
  }

  private async persistCurrentOwnerEnqueueMutation(
    ownerUserId: string,
    action: EnqueueParams,
    queuedAction: QueuedAction,
  ): Promise<DurableEnqueueMutationOutcome> {
    return persistActionQueueCurrentOwnerEnqueueMutation({
      ownerUserId,
      action,
      queuedAction,
      persistQueueMutationForOwner: (ownerUserId, mutateQueue) =>
        this.options.persistQueueMutationForOwner(ownerUserId, mutateQueue),
      persistQueueMutationWithRetrySupersession:
        this.options.persistQueueMutationWithRetrySupersession,
      buildCurrentOwnerEnqueueMutation: (queue, currentAction, currentQueuedAction) =>
        this.options.buildCurrentOwnerEnqueueMutation(queue, currentAction, currentQueuedAction),
    });
  }

  private warnFailedDurableEnqueue(
    action: EnqueueParams,
    queuedAction: QueuedAction,
    mutation: EnqueueMutationResult,
  ): void {
    this.options.warn('ActionQueue durable enqueue 未能完成持久化确认', {
      actionId: mutation.resolvedActionId || queuedAction.id,
      entityType: action.entityType,
      entityId: action.entityId,
    });
  }

  private completeDurableEnqueue(
    action: EnqueueParams,
    queuedAction: QueuedAction,
    mutation: EnqueueMutationResult,
    removeRetrySourceOnSuccess: boolean,
  ): void {
    this.options.runEnqueueSideEffects({
      action,
      queuedAction,
      resolvedActionId: mutation.resolvedActionId,
      removeRetrySourceOnSuccess,
    });

    if (this.options.isOnline()) {
      this.options.scheduleProcessQueue();
    }
  }
}
