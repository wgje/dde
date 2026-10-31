import { AUTH_CONFIG } from '../config/auth.config';
import { shouldDiscardAfterProjectDeleteSuccess } from './action-queue-query.helpers';
import { LOCAL_QUEUE_CONFIG } from './action-queue-storage.service';
import { writeOwnerScopedLocalStorageValue } from './action-queue-owner-storage-local-helpers';
import type { QueueStalePolicy } from './action-queue-view-state.service';
import type { QueuedAction } from './action-queue.types';
import {
  buildActionQueuePayloadSignature,
  hasExactActionIdentity,
} from './action-queue-identity.helpers';
export {
  buildActionQueuePayloadSignature,
  buildAttachmentReplayPayloadSignature,
  hasExactActionIdentity,
} from './action-queue-identity.helpers';
import {
  preserveQueueBackupWithoutWrite,
  type QueueBackupStrictUpdateResult,
} from './queue-backup.service';

class DiscardedActionQueueMutationError extends Error {}

export type ExactCurrentProjectDeleteSettlementResult =
  | { status: 'current'; removedCount: 0 }
  | { status: 'committed'; removedCount: number }
  | { status: 'missing' | 'identity-mismatch' | 'protected-handoff' | 'persistence-failed' };

export interface AttachmentReplayActionSettlementInput {
  mode: 'verify-task-update' | 'remove-attachment-create';
  actionId: string;
  operationId: string;
  entityType: 'attachment' | 'task';
  type: 'create' | 'update';
  entityId: string;
  payload: unknown;
  signal: AbortSignal;
  isCurrent: () => boolean;
}

export type AttachmentReplayActionSettlementResult =
  | { status: 'current' | 'committed' }
  | { status: 'missing' | 'identity-mismatch' | 'fence-stale' | 'protected-handoff' | 'persistence-failed' };

type ExactProjectDeleteSettlementPlan =
  | {
    kind: 'no-write';
    result: ExactCurrentProjectDeleteSettlementResult;
    queue: QueuedAction[];
  }
  | { kind: 'remove'; removedCount: number; queue: QueuedAction[] };

function planExactProjectDeleteSettlement(
  queue: QueuedAction[],
  projectId: string,
  actionId: string,
  operationId: string,
): ExactProjectDeleteSettlementPlan {
  const matches = queue.filter(action => action.id === actionId);
  if (matches.length === 0) {
    return { kind: 'no-write', result: { status: 'missing' }, queue: preserveQueueBackupWithoutWrite(queue) };
  }

  const exactAction = matches[0];
  const identityMatches = matches.length === 1
    && exactAction.operationId === operationId
    && exactAction.entityType === 'project'
    && exactAction.type === 'delete'
    && exactAction.entityId === projectId
    && 'projectId' in exactAction.payload
    && exactAction.payload.projectId === projectId;
  if (!identityMatches) {
    return { kind: 'no-write', result: { status: 'identity-mismatch' }, queue: preserveQueueBackupWithoutWrite(queue) };
  }

  const nextQueue = queue.filter(action =>
    !shouldDiscardAfterProjectDeleteSuccess(action, projectId, actionId));
  const removedCount = queue.length - nextQueue.length;
  return removedCount === 0
    ? { kind: 'no-write', result: { status: 'current', removedCount: 0 }, queue: preserveQueueBackupWithoutWrite(queue) }
    : { kind: 'remove', removedCount, queue: nextQueue };
}

function isValidAttachmentReplaySettlementInput(
  input: AttachmentReplayActionSettlementInput,
): boolean {
  if (input.mode === 'remove-attachment-create') {
    return input.entityType === 'attachment' && input.type === 'create';
  }
  if (input.entityType !== 'task' || input.type !== 'update') return false;
  const payload = input.payload as { writeIntent?: unknown };
  return payload.writeIntent === 'task_attachment_update';
}

export type ActionQueueTransitionReason =
  | 'missing-signal'
  | 'aborted'
  | 'stale-current'
  | 'missing-owner-strict-update'
  | 'identity-mismatch'
  | 'already-syncing'
  | 'state-not-transitionable'
  | 'persistence-failed';

function canTransitionToSyncing(
  action: QueuedAction,
  latest: QueuedAction,
): boolean {
  if (action.syncState === 'blocked_by_auth') {
    return latest.syncState === 'blocked_by_auth';
  }
  return latest.syncState === 'pending_sync' || latest.syncState === 'retry_scheduled';
}

export interface ActionQueueDurableRemovalControllerOptions {
  getPendingActions: () => QueuedAction[];
  setPendingActions: (queue: QueuedAction[]) => void;
  filterPendingActions: (predicate: (action: QueuedAction) => boolean) => number;
  mapPendingActions: (mapper: (action: QueuedAction) => QueuedAction) => boolean;
  saveQueueToStorage: () => void;
  persistQueueMutationForOwner: (
    ownerUserId: string,
    updater: (queue: QueuedAction[]) => QueuedAction[],
  ) => Promise<QueuedAction[] | null>;
  persistQueueMutationStrictlyForOwner: (
    ownerUserId: string,
    updater: (queue: QueuedAction[]) => QueuedAction[],
  ) => Promise<QueueBackupStrictUpdateResult>;
  updateQueueBackupStrictlyForOwner?: (
    ownerUserId: string,
    updater: (queue: QueuedAction[]) => QueuedAction[],
  ) => Promise<QueueBackupStrictUpdateResult>;
  settleProjectDeleteSuccessForOwner: (
    ownerUserId: string,
    projectId: string,
    actionId?: string,
  ) => Promise<number>;
  getCurrentOwnerUserId: () => string;
  isQueueViewCurrent: (queueViewGeneration: number, ownerUserId?: string | null) => boolean;
  isStaleProcess: (processGeneration: number) => boolean;
  getStaleProcessPolicy: (
    processGeneration: number,
    processOwnerUserId: string,
  ) => QueueStalePolicy;
  applyPersistedCurrentOwnerQueue: (queue: QueuedAction[]) => void;
  syncSentryContext: () => void;
  warn: (message: string, context?: Record<string, unknown>) => void;
  warnSafely: (message: string, context?: Record<string, unknown>) => void;
  traceQueueTransitionReason: (event: { source: 'transition-exact-action-to-syncing-for-owner'; reason: string }) => void;
}

export class ActionQueueDurableRemovalController {
  private lastQueueTransitionReason: ActionQueueTransitionReason | null = null;

  constructor(private readonly options: ActionQueueDurableRemovalControllerOptions) {}

  private traceTransitionReason(reason: ActionQueueTransitionReason): void {
    this.lastQueueTransitionReason = reason;
    try {
      this.options.traceQueueTransitionReason({
        source: 'transition-exact-action-to-syncing-for-owner',
        reason,
      });
    } catch {
      // Diagnostics must never break queue transition safety.
    }
  }

  getLastQueueTransitionReason(): ActionQueueTransitionReason | null {
    return this.lastQueueTransitionReason;
  }

  async transitionExactActionToSyncingForOwner(
    ownerUserId: string,
    action: QueuedAction,
    signal: AbortSignal | undefined,
    isCurrent: () => boolean,
  ): Promise<QueuedAction | null> {
    if (!signal || signal.aborted || !isCurrent()) {
      this.traceTransitionReason(!signal ? 'missing-signal' : signal.aborted ? 'aborted' : 'stale-current');
      return null;
    }
    const updateQueue = this.options.updateQueueBackupStrictlyForOwner;
    if (!updateQueue) {
      this.traceTransitionReason('missing-owner-strict-update');
      return null;
    }
    let syncingAction: QueuedAction | undefined;
    const persistence = await updateQueue(ownerUserId, queue => {
      if (signal.aborted || !isCurrent()) {
        this.traceTransitionReason(signal.aborted ? 'aborted' : 'stale-current');
        return preserveQueueBackupWithoutWrite(queue);
      }
      const matches = queue.filter(candidate => candidate.id === action.id);
      if (matches.length !== 1 || !hasExactActionIdentity(matches[0], action)) {
        this.traceTransitionReason('identity-mismatch');
        return preserveQueueBackupWithoutWrite(queue);
      }
      const latest = matches[0];
      if (latest.syncState === 'syncing') {
        syncingAction = latest;
        this.traceTransitionReason('already-syncing');
        return preserveQueueBackupWithoutWrite(queue);
      }
      if (!canTransitionToSyncing(action, latest)) {
        this.traceTransitionReason('state-not-transitionable');
        return preserveQueueBackupWithoutWrite(queue);
      }
      const transitioned = { ...latest, syncState: 'syncing' as const };
      syncingAction = transitioned;
      return queue.map(candidate => candidate.id === latest.id ? transitioned : candidate);
    });
    if (persistence.status === 'storage-failed') {
      this.traceTransitionReason('persistence-failed');
      return null;
    }
    if (signal.aborted || !isCurrent()) {
      this.traceTransitionReason(signal.aborted ? 'aborted' : 'stale-current');
      return null;
    }
    if (!syncingAction) {
      return null;
    }
    if (persistence.status === 'committed') {
      this.publishCommittedOwnerQueue(ownerUserId, persistence.queue);
      return syncingAction;
    }
    if (persistence.status === 'no-write') return syncingAction;
    return null;
  }

  async settleExactProcessedActionForOwner(
    ownerUserId: string,
    action: QueuedAction,
    signal: AbortSignal | undefined,
    isCurrent: () => boolean,
  ): Promise<boolean> {
    if (!signal || signal.aborted || !isCurrent()) return false;
    const updateQueue = this.options.updateQueueBackupStrictlyForOwner;
    if (!updateQueue) return false;
    let removed = false;
    const persistence = await updateQueue(ownerUserId, queue => {
      if (signal.aborted || !isCurrent()) return preserveQueueBackupWithoutWrite(queue);
      const matches = queue.filter(candidate => candidate.id === action.id);
      if (matches.length !== 1 || !hasExactActionIdentity(matches[0], action)) {
        return preserveQueueBackupWithoutWrite(queue);
      }
      removed = true;
      return queue.filter(candidate => candidate.id !== action.id);
    });
    if (signal.aborted || !isCurrent() || persistence.status !== 'committed' || !removed) return false;
    this.publishCommittedOwnerQueue(ownerUserId, persistence.queue);
    return true;
  }

  async dequeueProcessedAction(
    actionId: string,
    processOwnerUserId: string,
    processGeneration: number,
  ): Promise<void> {
    let persistedQueue: QueuedAction[] | null;
    try {
      persistedQueue = await this.options.persistQueueMutationForOwner(
        processOwnerUserId,
        queue => {
          if (this.isDiscardedQueueProcess(processGeneration, processOwnerUserId)) {
            throw new DiscardedActionQueueMutationError();
          }
          return queue.filter(action => action.id !== actionId);
        },
      );
    } catch (error) {
      if (error instanceof DiscardedActionQueueMutationError) {
        this.removeOwnerQueueMirror(processOwnerUserId);
        return;
      }
      throw error;
    }

    if (this.isDiscardedQueueProcess(processGeneration, processOwnerUserId)) {
      await this.reassertDiscardedOwnerQueue(processOwnerUserId);
      return;
    }

    if (persistedQueue !== null) {
      if (this.options.isQueueViewCurrent(processGeneration, processOwnerUserId)) {
        this.options.applyPersistedCurrentOwnerQueue(persistedQueue);
      }
      return;
    }

    this.options.warn('处理成功后的持久 Outbox 收口失败，保留当前视图等待恢复重放', {
      actionId,
      ownerUserId: processOwnerUserId,
    });
    if (this.options.isQueueViewCurrent(processGeneration, processOwnerUserId)) {
      this.restoreProcessedActionAfterDurableDequeueFailure(actionId);
    }
  }

  dequeue(actionId: string): void {
    this.options.filterPendingActions(action => action.id !== actionId);
    this.options.saveQueueToStorage();
    this.options.syncSentryContext();
  }

  async settleProjectDeleteSuccessForOwner(
    ownerUserId: string,
    projectId: string,
    actionId?: string,
  ): Promise<number> {
    if (ownerUserId === this.options.getCurrentOwnerUserId()) {
      return this.discardActions(action =>
        shouldDiscardAfterProjectDeleteSuccess(action, projectId, actionId));
    }

    return await this.options.settleProjectDeleteSuccessForOwner(
      ownerUserId,
      projectId,
      actionId,
    );
  }

  async settleExactCurrentProjectDeleteSuccess(
    ownerUserId: string,
    projectId: string,
    actionId: string,
    operationId: string,
  ): Promise<ExactCurrentProjectDeleteSettlementResult> {
    if (ownerUserId !== this.options.getCurrentOwnerUserId()) {
      return { status: 'identity-mismatch' };
    }

    const state: { plan?: ExactProjectDeleteSettlementPlan } = {};
    const persistence = await this.options.persistQueueMutationStrictlyForOwner(
      ownerUserId,
      queue => {
        state.plan = planExactProjectDeleteSettlement(queue, projectId, actionId, operationId);
        return state.plan.queue;
      },
    );

    if (persistence.status === 'committed' && state.plan?.kind === 'remove') {
      if (ownerUserId === this.options.getCurrentOwnerUserId()) {
        this.options.applyPersistedCurrentOwnerQueue(persistence.queue);
      }
      return { status: 'committed', removedCount: state.plan.removedCount };
    }
    if (persistence.status === 'no-write' && state.plan?.kind === 'no-write') {
      return state.plan.result;
    }
    if (persistence.status === 'protected-handoff') {
      return { status: 'protected-handoff' };
    }
    return { status: 'persistence-failed' };
  }

  async settleAttachmentReplayActionForOwner(
    ownerUserId: string,
    input: AttachmentReplayActionSettlementInput,
  ): Promise<AttachmentReplayActionSettlementResult> {
    if (ownerUserId !== this.options.getCurrentOwnerUserId()
      || input.signal.aborted
      || !input.isCurrent()) {
      return { status: 'fence-stale' };
    }
    if (!isValidAttachmentReplaySettlementInput(input)) {
      return { status: 'identity-mismatch' };
    }
    let result: AttachmentReplayActionSettlementResult | undefined;
    const persistence = await this.options.persistQueueMutationStrictlyForOwner(ownerUserId, queue => {
      if (input.signal.aborted || !input.isCurrent()) {
        result = { status: 'fence-stale' };
        return preserveQueueBackupWithoutWrite(queue);
      }
      const matches = queue.filter(action => action.id === input.actionId);
      if (matches.length === 0) {
        result = { status: 'missing' };
        return preserveQueueBackupWithoutWrite(queue);
      }
      const action = matches[0];
      const exact = matches.length === 1
        && action.operationId === input.operationId
        && action.entityType === input.entityType
        && action.type === input.type
        && action.entityId === input.entityId
        && buildActionQueuePayloadSignature(action.payload)
          === buildActionQueuePayloadSignature(input.payload);
      if (!exact) {
        result = { status: 'identity-mismatch' };
        return preserveQueueBackupWithoutWrite(queue);
      }
      if (input.mode === 'verify-task-update') {
        result = { status: 'current' };
        return preserveQueueBackupWithoutWrite(queue);
      }
      result = { status: 'committed' };
      return queue.filter(candidate => candidate.id !== input.actionId);
    });
    if (ownerUserId !== this.options.getCurrentOwnerUserId()
      || input.signal.aborted
      || !input.isCurrent()) {
      return { status: 'fence-stale' };
    }
    if (persistence.status === 'committed' && result?.status === 'committed') {
      if (ownerUserId === this.options.getCurrentOwnerUserId()) {
        this.options.applyPersistedCurrentOwnerQueue(persistence.queue);
      }
      return result;
    }
    if (persistence.status === 'no-write' && result) return result;
    if (persistence.status === 'protected-handoff') return { status: 'protected-handoff' };
    return { status: 'persistence-failed' };
  }

  discardActions(predicate: (action: QueuedAction) => boolean): number {
    const previousQueue = [...this.options.getPendingActions()];
    const discardedCount = this.options.filterPendingActions(action => !predicate(action));

    if (discardedCount === 0) {
      return 0;
    }

    try {
      this.options.saveQueueToStorage();
    } catch (error) {
      this.options.setPendingActions(previousQueue);
      this.syncSentryContextSafely('discard-actions-rollback');
      this.options.warnSafely(
        'ActionQueue discardActions 持久化失败，已回滚内存队列',
        { discardedCount, error },
      );
      return 0;
    }

    this.syncSentryContextSafely('discard-actions');
    return discardedCount;
  }

  private isDiscardedQueueProcess(
    processGeneration: number,
    processOwnerUserId: string,
  ): boolean {
    return this.options.isStaleProcess(processGeneration) &&
      this.options.getStaleProcessPolicy(processGeneration, processOwnerUserId) === 'discard';
  }

  private async reassertDiscardedOwnerQueue(ownerUserId: string): Promise<void> {
    this.removeOwnerQueueMirror(ownerUserId);
    try {
      await this.options.persistQueueMutationForOwner(ownerUserId, () => []);
    } catch (error) {
      this.options.warnSafely(
        'discard 后旧 owner 队列清理持久化失败',
        { ownerUserId, error },
      );
    }
    this.removeOwnerQueueMirror(ownerUserId);
  }

  private removeOwnerQueueMirror(ownerUserId: string): void {
    if (typeof localStorage === 'undefined') {
      return;
    }

    try {
      localStorage.removeItem(`${LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY}.${ownerUserId}`);
      if (ownerUserId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
        localStorage.removeItem(LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY);
      }
    } catch (error) {
      this.options.warnSafely(
        'discard 后旧 owner 队列镜像清理失败',
        { ownerUserId, error },
      );
    }
  }

  private publishCommittedOwnerQueue(ownerUserId: string, queue: QueuedAction[]): void {
    if (typeof localStorage !== 'undefined') {
      try {
        writeOwnerScopedLocalStorageValue(
          LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY,
          ownerUserId,
          queue,
          (baseKey, owner) => `${baseKey}.${owner}`,
        );
      } catch (error) {
        this.options.warnSafely('strict ActionQueue commit 的 owner 镜像更新失败', {
          ownerUserId,
          error,
        });
      }
    }
    if (ownerUserId === this.options.getCurrentOwnerUserId()) {
      this.options.applyPersistedCurrentOwnerQueue(queue);
    }
  }

  private restoreProcessedActionAfterDurableDequeueFailure(actionId: string): void {
    const restored = this.options.mapPendingActions(action => {
      if (action.id !== actionId) {
        return action;
      }

      return {
        ...action,
        syncState: 'pending_sync' as const,
      };
    });

    if (!restored) {
      return;
    }

    this.options.saveQueueToStorage();
    this.options.syncSentryContext();
  }

  private syncSentryContextSafely(operation: string): void {
    try {
      this.options.syncSentryContext();
    } catch (error) {
      this.options.warnSafely('ActionQueue Sentry context 同步失败，已保留队列状态', {
        operation,
        error,
      });
    }
  }
}
