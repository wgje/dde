import { Injectable, inject } from '@angular/core';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { LOCAL_QUEUE_CONFIG } from './action-queue-storage.service';
import {
  EnqueueParams,
  OperationPriority,
  PreferencePayload,
  ProjectPayload,
  QueuedAction,
} from './action-queue.types';
import { createSyncOperationId } from '../utils/sync-operation-id';

export interface EnqueueMutationResult {
  nextQueue: QueuedAction[];
  resolvedActionId: string;
  wasEnqueued: boolean;
  wasMergeShrunk: boolean;
}

@Injectable({
  providedIn: 'root',
})
export class ActionQueueEnqueueMutationService {
  private readonly logger = inject(LoggerService).category('ActionQueue');
  private readonly toast = inject(ToastService);
  private readonly QUEUE_PRESSURE_NOTICE_COOLDOWN = 60_000;
  private lastQueuePressureNoticeAt = 0;

  createQueuedAction(action: EnqueueParams): QueuedAction {
    const defaultPriority: OperationPriority =
      action.entityType === 'project' || action.entityType === 'focus-session' ? 'critical' :
      action.entityType === 'preference' ? 'low' : 'normal';
    const now = Date.now();

    return {
      ...action,
      id: createSyncOperationId(),
      operationId: action.operationId ?? createSyncOperationId(),
      timestamp: now,
      localCommittedAt: now,
      syncState: 'pending_sync',
      retryCount: 0,
      priority: action.priority ?? defaultPriority,
    };
  }

  notifyQueuePressureOnce(title: string, message: string): void {
    const now = Date.now();
    if (now - this.lastQueuePressureNoticeAt < this.QUEUE_PRESSURE_NOTICE_COOLDOWN) {
      return;
    }
    this.lastQueuePressureNoticeAt = now;
    this.toast.warning(title, message);
  }

  buildForeignOwnerEnqueueMutation(
    existingQueue: QueuedAction[],
    action: EnqueueParams,
    queuedAction: QueuedAction,
    ownerUserId: string,
  ): EnqueueMutationResult {
    const nextQueue = [...existingQueue];
    const existingOperationIndex = this.findExistingOperationIndex(nextQueue, queuedAction);
    if (existingOperationIndex !== -1) {
      const existing = nextQueue[existingOperationIndex];
      return {
        nextQueue,
        resolvedActionId: existing.id,
        wasEnqueued: false,
        wasMergeShrunk: false,
      };
    }

    const existingIndex = this.findMergeableActionIndex(nextQueue, action);

    if (existingIndex === -1) {
      nextQueue.push(queuedAction);
      return { nextQueue, resolvedActionId: queuedAction.id, wasEnqueued: true, wasMergeShrunk: false };
    }

    const existing = nextQueue[existingIndex];
    if (existing.type === 'delete' && (action.type === 'update' || action.type === 'create')) {
      this.logger.debug('忽略 foreign-owner 队列中已删除实体的操作', {
        ownerUserId,
        entityType: action.entityType,
        entityId: action.entityId,
      });
      return { nextQueue: existingQueue, resolvedActionId: '', wasEnqueued: false, wasMergeShrunk: false };
    }

    const merged = this.applyExistingActionMerge(nextQueue, existingIndex, action, queuedAction, existingQueue);
    if (merged) {
      return existing.type === 'create' && action.type === 'delete'
        ? { ...merged, resolvedActionId: existing.id }
        : merged;
    }

    nextQueue.push(queuedAction);
    return { nextQueue, resolvedActionId: queuedAction.id, wasEnqueued: true, wasMergeShrunk: false };
  }

  buildCurrentOwnerEnqueueMutation(
    queue: QueuedAction[],
    action: EnqueueParams,
    queuedAction: QueuedAction,
  ): EnqueueMutationResult {
    const mutation = this.buildBaseEnqueueMutation(queue, action, queuedAction);
    if (!mutation.resolvedActionId && mutation.nextQueue === queue && !mutation.wasMergeShrunk) {
      this.logger.debug(`忽略已删除实体的操作`, { entityType: action.entityType, entityId: action.entityId });
    }
    return mutation;
  }

  private buildBaseEnqueueMutation(
    queue: QueuedAction[],
    action: EnqueueParams,
    queuedAction: QueuedAction,
  ): EnqueueMutationResult {
    const nextQueue = [...queue];
    const existingOperationIndex = this.findExistingOperationIndex(nextQueue, queuedAction);
    if (existingOperationIndex !== -1) {
      const existing = nextQueue[existingOperationIndex];
      return {
        nextQueue,
        resolvedActionId: existing.id,
        wasEnqueued: false,
        wasMergeShrunk: false,
      };
    }

    const existingIndex = this.findMergeableActionIndex(nextQueue, action);

    if (existingIndex !== -1) {
      const deduped = this.applyExistingActionMerge(nextQueue, existingIndex, action, queuedAction, queue);
      if (deduped) {
        return deduped.wasMergeShrunk
          ? { ...deduped, resolvedActionId: '' }
          : deduped;
      }
    }

    if (this.isQueueAtAbsoluteLimit(nextQueue, action)) {
      return { nextQueue: queue, resolvedActionId: '', wasEnqueued: false, wasMergeShrunk: false };
    }

    this.warnIfQueueAtSoftLimit(nextQueue, action);
    nextQueue.push(queuedAction);
    return {
      nextQueue,
      resolvedActionId: queuedAction.id,
      wasEnqueued: true,
      wasMergeShrunk: false,
    };
  }

  private findExistingOperationIndex(queue: QueuedAction[], action: QueuedAction): number {
    return queue.findIndex(existing => existing.operationId === action.operationId);
  }

  private findMergeableActionIndex(queue: QueuedAction[], action: EnqueueParams): number {
    return queue.findIndex(existing =>
      existing.entityType === action.entityType &&
      existing.entityId === action.entityId &&
      existing.retryCount === 0 &&
      existing.syncState !== 'syncing'
    );
  }

  private applyExistingActionMerge(
    nextQueue: QueuedAction[],
    existingIndex: number,
    action: EnqueueParams,
    queuedAction: QueuedAction,
    originalQueue: QueuedAction[],
  ): EnqueueMutationResult | null {
    const existing = nextQueue[existingIndex];

    if (existing.type === 'delete' && (action.type === 'update' || action.type === 'create')) {
      return { nextQueue: originalQueue, resolvedActionId: '', wasEnqueued: false, wasMergeShrunk: false };
    }

    if (existing.type === 'update' && action.type === 'update') {
      this.logger.debug(`合并重复的update操作`, { entityType: action.entityType, entityId: action.entityId });
      nextQueue[existingIndex] = this.preserveExistingOutboxIdentity(existing, this.mergeQueuedAction(existing, queuedAction));
      return { nextQueue, resolvedActionId: existing.id, wasEnqueued: true, wasMergeShrunk: false };
    }

    if (existing.type === 'create' && action.type === 'update') {
      this.logger.debug(`合并create后的update`, { entityType: action.entityType, entityId: action.entityId });
      nextQueue[existingIndex] = this.preserveExistingOutboxIdentity(
        existing,
        { ...this.mergeQueuedAction(existing, queuedAction), type: 'create' },
      );
      return { nextQueue, resolvedActionId: existing.id, wasEnqueued: true, wasMergeShrunk: false };
    }

    if (existing.type === 'create' && action.type === 'delete') {
      this.logger.debug(`取消未同步的create操作`, { entityType: action.entityType, entityId: action.entityId });
      nextQueue.splice(existingIndex, 1);
      return { nextQueue, resolvedActionId: existing.id, wasEnqueued: false, wasMergeShrunk: true };
    }

    if (existing.type === 'update' && action.type === 'delete') {
      this.logger.debug(`合并update后的delete`, { entityType: action.entityType, entityId: action.entityId });
      nextQueue[existingIndex] = this.preserveExistingOutboxIdentity(existing, queuedAction);
      return { nextQueue, resolvedActionId: existing.id, wasEnqueued: true, wasMergeShrunk: false };
    }

    return null;
  }

  private isQueueAtAbsoluteLimit(queue: QueuedAction[], action: EnqueueParams): boolean {
    const absoluteLimit = LOCAL_QUEUE_CONFIG.MAX_QUEUE_SIZE * 5;
    if (queue.length < absoluteLimit) return false;

    this.logger.error('队列达到绝对上限，拒绝新操作入队', {
      absoluteLimit,
      rejectedType: action.type,
      rejectedEntityType: action.entityType,
      rejectedEntityId: action.entityId,
    });
    this.notifyQueuePressureOnce('同步队列超限', '已达保护上限，请先完成同步后再重试');
    return true;
  }

  private warnIfQueueAtSoftLimit(queue: QueuedAction[], action: EnqueueParams): void {
    const softLimit = LOCAL_QUEUE_CONFIG.MAX_QUEUE_SIZE;
    if (queue.length < softLimit) return;

    this.logger.warn('队列达到软上限，进入压力模式但继续入队', {
      softLimit,
      queueSize: queue.length,
      maxSize: LOCAL_QUEUE_CONFIG.MAX_QUEUE_SIZE,
      type: action.type,
      entityType: action.entityType,
    });
    this.notifyQueuePressureOnce('同步队列压力较高', '仍在接收写入，建议尽快联网完成同步');
  }

  private mergeProjectPayload(
    existingPayload: ProjectPayload,
    nextPayload: ProjectPayload,
  ): ProjectPayload {
    const nextHasDeleteIntent = nextPayload.taskIdsToDelete !== undefined;
    const taskIdsToDelete = nextHasDeleteIntent
      ? nextPayload.taskIdsToDelete
      : existingPayload.taskIdsToDelete;
    const taskDeleteBaseUpdatedAtMap = nextHasDeleteIntent
      ? nextPayload.taskDeleteBaseUpdatedAtMap
      : existingPayload.taskDeleteBaseUpdatedAtMap;

    return {
      ...nextPayload,
      sourceUserId: nextPayload.sourceUserId ?? existingPayload.sourceUserId,
      taskIdsToDelete,
      taskDeleteBaseUpdatedAtMap,
    };
  }

  private mergeQueuedAction(existing: QueuedAction, next: QueuedAction): QueuedAction {
    if (existing.entityType === 'project' && next.entityType === 'project') {
      return {
        ...next,
        payload: this.mergeProjectPayload(
          existing.payload as ProjectPayload,
          next.payload as ProjectPayload,
        ),
      };
    }

    if (existing.entityType === 'preference' && next.entityType === 'preference') {
      return {
        ...next,
        payload: this.mergePreferencePayload(
          existing.payload as PreferencePayload,
          next.payload as PreferencePayload,
        ),
      };
    }

    return next;
  }

  private mergePreferencePayload(
    existingPayload: PreferencePayload,
    nextPayload: PreferencePayload,
  ): PreferencePayload {
    return {
      ...nextPayload,
      userId: nextPayload.userId || existingPayload.userId,
      sourceUserId: nextPayload.sourceUserId ?? existingPayload.sourceUserId,
      preferences: {
        ...existingPayload.preferences,
        ...nextPayload.preferences,
      },
    };
  }

  private preserveExistingOutboxIdentity(existing: QueuedAction, merged: QueuedAction): QueuedAction {
    const operationId = this.hasAttemptedOutboxAction(existing)
      ? merged.operationId
      : existing.operationId;

    return {
      ...merged,
      id: existing.id,
      operationId,
      timestamp: existing.timestamp,
      localCommittedAt: existing.localCommittedAt ?? existing.timestamp,
      syncState: existing.syncState ?? 'pending_sync',
    };
  }

  private hasAttemptedOutboxAction(action: QueuedAction): boolean {
    if (action.retryCount > 0 || action.lastError || action.errorType) {
      return true;
    }

    const syncState = action.syncState ?? 'pending_sync';
    return syncState !== 'local_committed' && syncState !== 'pending_sync';
  }
}
