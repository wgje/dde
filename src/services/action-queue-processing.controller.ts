import type { WritableSignal } from '@angular/core';
import { QUEUE_CONFIG } from '../config';
import { pushStartupTrace } from '../utils/startup-trace';
import { hasExactActionIdentity, type ActionQueueTransitionReason } from './action-queue-durable-removal.controller';
import { getActionEntityKey, getQueuedActionSkipDecision } from './action-queue-processing.helpers';
import type { ActionQueueLifecycleController } from './action-queue-lifecycle.controller';
import { getProcessorRetryError, toActionQueueRetryError, type ActionQueueProcessorResult } from './action-queue-processor-result.helpers';
import type { ActionQueueStorageService, QueueRetryError } from './action-queue-storage.service';
import type { ActionQueueSyncWriterLeaseService, ActionQueueSyncWriterLeaseHandle } from './action-queue-sync-writer-lease.service';
import type { QueueStalePolicy, ActionQueueViewStateService } from './action-queue-view-state.service';
import type { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import type { ToastService } from './toast.service';
import type { WriteGuardService } from './write-guard.service';
import type { CategoryLogger } from './logger.service';
import type {
  ActionQueueProcessResult,
  QueueProcessContext,
  QueueProcessor,
} from './action-queue-processing.types';
import type { QueuedAction, TaskPayload } from './action-queue.types';

type RequiredLeaseResult = ActionQueueSyncWriterLeaseHandle | 'retry-later' | null;

export interface ActionQueueProcessingControllerDeps {
  logger: CategoryLogger;
  toast: ToastService;
  sentryLazyLoader: SentryLazyLoaderService;
  storage: ActionQueueStorageService;
  syncWriterLeaseGate: ActionQueueSyncWriterLeaseService;
  writeGuard: WriteGuardService | null;
  queueViewState: ActionQueueViewStateService;
  lifecycle: ActionQueueLifecycleController;
  pendingActions: WritableSignal<QueuedAction[]>;
  isProcessing: WritableSignal<boolean>;
  processors: Map<string, QueueProcessor>;
  isProcessorRegistrationReady: () => boolean;
  getCurrentOwnerUserId: () => string;
  createPersistenceFence: (
    ownerUserId: string,
    generation: number,
    signal: AbortSignal | undefined,
  ) => () => boolean;
  settleRetrySupersession?: (
    action: QueuedAction,
    processOwnerUserId: string,
    processGeneration: number,
    leaseSignal: AbortSignal | undefined,
  ) => Promise<QueuedAction | null>;
  transitionToSyncing: (
    action: QueuedAction,
    processOwnerUserId: string,
    leaseSignal: AbortSignal | undefined,
    isCurrent: () => boolean,
  ) => Promise<QueuedAction | null>;
  getLastQueueTransitionReason: () => ActionQueueTransitionReason | null;
  settleSuccessfulAction: (
    action: QueuedAction,
    processOwnerUserId: string,
    leaseSignal: AbortSignal | undefined,
    isCurrent: () => boolean,
  ) => Promise<boolean>;
}

export class ActionQueueProcessingController {
  private leaseAcquisitionInFlight = false;
  private rerunRequested = false;
  private activeWriterLease: {
    ownerUserId: string;
    handle: ActionQueueSyncWriterLeaseHandle | null;
  } | null = null;
  private activePersistenceFence: (() => boolean) | null = null;
  private readonly suppressedSettledLifecycleTokens = new Set<number>();

  constructor(private readonly deps: ActionQueueProcessingControllerDeps) {}

  async processQueue(): Promise<ActionQueueProcessResult> {
    pushStartupTrace('action_queue.processing_invoked');
    if (this.deps.isProcessing() || this.leaseAcquisitionInFlight) {
      this.rerunRequested = true;
      this.debug('ActionQueue processQueue early return', { reason: 'already-processing' });
      pushStartupTrace('action_queue.processing_early_return', { reason: 'already-processing' });
      return this.emptyResult();
    }

    if (!this.deps.storage.isOnline) {
      this.debug('ActionQueue processQueue early return', { reason: 'offline' });
      pushStartupTrace('action_queue.processing_early_return', { reason: 'offline' });
      return this.emptyResult();
    }

    if (this.deps.writeGuard && !this.deps.writeGuard.assertWritable('ActionQueue.processQueue')) {
      this.debug('ActionQueue processQueue early return', { reason: 'write-guard-blocked' });
      pushStartupTrace('action_queue.processing_early_return', { reason: 'write-guard-blocked' });
      return this.emptyResult();
    }

    if (this.deps.storage.shouldDeferQueueProcessing()) {
      this.deps.storage.requestQueueProcessing('processQueue');
      this.debug('ActionQueue processQueue early return', { reason: 'defer-queue-processing' });
      pushStartupTrace('action_queue.processing_early_return', { reason: 'defer-queue-processing' });
      return this.emptyResult();
    }

    const leaseIsRequired = this.deps.syncWriterLeaseGate.isRequired();
    const leaseResult = leaseIsRequired
      ? await this.acquireRequiredProcessQueueLease()
      : await this.acquireSyncWriterLease();
    if (leaseResult === 'retry-later') {
      this.scheduleLeaseRetryIfNeeded();
      this.debug('ActionQueue processQueue early return', { reason: 'lease-retry-later' });
      pushStartupTrace('action_queue.processing_early_return', { reason: 'lease-retry-later' });
      return this.emptyResult();
    }
    if (!leaseResult) {
      this.debug('ActionQueue processQueue early return', { reason: 'lease-unavailable' });
      pushStartupTrace('action_queue.processing_early_return', { reason: 'lease-unavailable' });
      return this.emptyResult();
    }
    const syncWriterLeaseHandle = leaseIsRequired
      ? leaseResult
      : { ...leaseResult, mode: 'memory-only' as const };

    const context = this.beginQueueProcessing(syncWriterLeaseHandle);
    const result: ActionQueueProcessResult = this.emptyResult();
    pushStartupTrace('action_queue.processing_begun', { queueCount: context.queue.length });

    try {
      await this.processQueueActions(context, result);
    } finally {
      try {
        await this.releaseSyncWriterLease(syncWriterLeaseHandle);
      } finally {
        try {
          this.finishQueueProcessing(context, result);
        } finally {
          this.activeWriterLease = null;
          this.activePersistenceFence = null;
        }
      }
    }

    if (this.consumeRerunRequest() && this.deps.storage.isOnline) {
      const followupResult = await this.processQueue();
      return {
        processed: result.processed + followupResult.processed,
        failed: result.failed + followupResult.failed,
        movedToDeadLetter: result.movedToDeadLetter + followupResult.movedToDeadLetter,
      };
    }

    return result;
  }

  borrowActiveWriterLease(
    ownerUserId: string,
  ): ActionQueueSyncWriterLeaseHandle | 'unavailable' | null {
    if (!this.activeWriterLease) return null;
    const handle = this.activeWriterLease.handle;
    if (this.activeWriterLease.ownerUserId !== ownerUserId
      || !handle
      || handle.mode === 'memory-only'
      || !handle.signal
      || handle.signal.aborted) return 'unavailable';
    return handle;
  }

  private async acquireRequiredProcessQueueLease(): Promise<RequiredLeaseResult> {
    const leaseRequestOwnerUserId = this.deps.getCurrentOwnerUserId();
    const leaseRequestQueueGeneration = this.deps.queueViewState.currentQueueViewGeneration;
    const syncWriterLeaseHandle = await this.acquireSyncWriterLease();
    if (!syncWriterLeaseHandle) return 'retry-later';

    if (syncWriterLeaseHandle.mode === 'memory-only') {
      this.warn('sync writer lease 退化为 memory-only，本轮 ActionQueue flush 已延后');
      await this.releaseSyncWriterLease(syncWriterLeaseHandle);
      return null;
    }

    if (
      this.deps.getCurrentOwnerUserId() !== leaseRequestOwnerUserId ||
      this.deps.queueViewState.currentQueueViewGeneration !== leaseRequestQueueGeneration
    ) {
      await this.releaseSyncWriterLease(syncWriterLeaseHandle);
      return null;
    }

    return syncWriterLeaseHandle;
  }

  private scheduleLeaseRetryIfNeeded(): void {
    if (!this.deps.storage.isOnline || this.deps.pendingActions().length === 0) {
      return;
    }

    this.debug('sync writer lease 未获取，已安排 ActionQueue 后续重试');
    try {
      this.deps.storage.scheduleRetry(0);
    } catch (error) {
      this.warn('sync writer lease 重试调度失败，已保留队列等待后续触发', error);
    }
  }

  private emptyResult(): ActionQueueProcessResult {
    return { processed: 0, failed: 0, movedToDeadLetter: 0 };
  }

  private async acquireSyncWriterLease(): Promise<ActionQueueSyncWriterLeaseHandle | null> {
    this.leaseAcquisitionInFlight = true;
    try {
      return await this.deps.syncWriterLeaseGate.acquire(this.deps.getCurrentOwnerUserId());
    } finally {
      this.leaseAcquisitionInFlight = false;
    }
  }

  private async releaseSyncWriterLease(syncWriterLeaseHandle: ActionQueueSyncWriterLeaseHandle | null): Promise<void> {
    if (!syncWriterLeaseHandle) return;

    await syncWriterLeaseHandle.release().catch(error => {
      this.warn('sync writer lease 释放失败', error);
    });
  }

  private consumeRerunRequest(): boolean {
    if (!this.rerunRequested) {
      return false;
    }

    this.rerunRequested = false;
    return this.deps.pendingActions().length > 0;
  }

  private beginQueueProcessing(
    syncWriterLeaseHandle: ActionQueueSyncWriterLeaseHandle | null,
  ): QueueProcessContext {
    const queueSnapshot = this.deps.pendingActions();
    try {
      this.deps.sentryLazyLoader.addBreadcrumb({
        category: 'sync',
        message: `Queue processing started`,
        level: 'info',
        data: {
          queueSize: queueSnapshot.length,
          actionTypes: queueSnapshot.map(a => `${a.entityType}:${a.type}`).join(', ')
        }
      });
    } catch (error) {
      this.warn('ActionQueue start breadcrumb failed', error);
    }

    this.deps.isProcessing.set(true);
    const processLifecycleToken = this.deps.lifecycle.begin();

    const processGeneration = this.deps.queueViewState.currentQueueViewGeneration;
    const processOwnerUserId = this.deps.getCurrentOwnerUserId();
    const leaseSignal = syncWriterLeaseHandle?.signal;
    this.activeWriterLease = { ownerUserId: processOwnerUserId, handle: syncWriterLeaseHandle };
    this.activePersistenceFence = this.deps.createPersistenceFence(
      processOwnerUserId,
      processGeneration,
      leaseSignal,
    );
    return {
      processGeneration,
      processOwnerUserId,
      processLifecycleToken,
      leaseSignal,
      queue: [...this.deps.pendingActions()],
      failedCreateEntities: new Set<string>()
    };
  }

  private async processQueueActions(
    context: QueueProcessContext,
    result: ActionQueueProcessResult
  ): Promise<void> {
    for (const action of context.queue) {
      if (this.shouldStopStaleQueueProcess(context, action)) {
        pushStartupTrace('action_queue.processing_stale_stop', {
          entityType: action.entityType,
          actionType: action.type,
        });
        break;
      }
      if (this.shouldSkipQueuedAction(action, context)) {
        pushStartupTrace('action_queue.processing_action_skipped', {
          entityType: action.entityType,
          actionType: action.type,
        });
        continue;
      }

      const processorKey = `${action.entityType}:${action.type}`;
      const processor = this.deps.processors.get(processorKey);

      if (!processor) {
        pushStartupTrace('action_queue.processing_missing_processor', { processorKey });
        this.handleMissingActionProcessor(action, processorKey, context, result);
        continue;
      }

      const shouldStop = await this.processQueuedAction(action, processor, context, result);
      if (shouldStop) break;
    }
  }

  private shouldStopStaleQueueProcess(context: QueueProcessContext, action: QueuedAction): boolean {
    if (this.isLeaseLost(context)) {
      this.warn('sync writer lease 已丢失，停止 ActionQueue 后续处理', {
        actionId: action.id,
        processGeneration: context.processGeneration,
      });
      return true;
    }
    if (!this.isStaleProcess(context.processGeneration)) return false;

    this.debug('检测到过期的队列处理循环，停止后续处理', {
      actionId: action.id,
      processGeneration: context.processGeneration,
      currentGeneration: this.deps.queueViewState.currentQueueViewGeneration,
    });
    return true;
  }

  private shouldSkipQueuedAction(action: QueuedAction, context: QueueProcessContext): boolean {
    const decision = getQueuedActionSkipDecision({
      action,
      currentPendingActions: this.deps.pendingActions(),
      processQueueSnapshot: context.queue,
      failedCreateEntities: context.failedCreateEntities,
    });
    if (!decision.shouldSkip) return false;

    const logData = { actionId: action.id, type: action.type, entityKey: decision.entityKey };
    if (decision.reason === 'failed-create') {
      this.debug('跳过操作：依赖的 Create 尚未成功', logData);
    } else if (decision.reason === 'pending-create') {
      this.debug('跳过操作：队列中有未处理的 Create', logData);
    }
    return true;
  }

  private handleMissingActionProcessor(
    action: QueuedAction,
    processorKey: string,
    context: QueueProcessContext,
    result: ActionQueueProcessResult
  ): void {
    this.warn(`No processor registered for action type: ${processorKey} - action will remain in queue`);
    if (!this.deps.isProcessorRegistrationReady()) {
      this.debug('处理器注册尚未完成，保留队列项等待启动完成后重放', {
        actionId: action.id,
        processorKey,
      });
      result.failed++;
      return;
    }

    const waitTime = Date.now() - action.timestamp;

    if (waitTime > QUEUE_CONFIG.NO_PROCESSOR_TIMEOUT) {
      this.warn(`Action ${action.id} has no processor and timed out (${Math.round(waitTime / 1000)}s), moving to dead letter`);
      this.deps.storage.moveToDeadLetter(action, `无处理器且等待超时 (${Math.round(waitTime / 60000)}分钟)`);
      result.movedToDeadLetter++;
      this.markCreateFailureIfNeeded(action, context, false);
    } else if (action.retryCount > 2) {
      this.toastWarning('操作待处理', `有 ${processorKey} 类型的操作尚未处理，请稍后重试`);
    }

    result.failed++;
  }

  private async processQueuedAction(
    action: QueuedAction,
    processor: QueueProcessor,
    context: QueueProcessContext,
    result: ActionQueueProcessResult
  ): Promise<boolean> {
    if (action.localHandoff && (!context.leaseSignal
      || this.activeWriterLease?.handle?.mode === 'memory-only')) {
      pushStartupTrace('action_queue.processing_local_handoff', {
        entityType: action.entityType,
        actionType: action.type,
      });
      return true;
    }
    const settledAction = this.deps.settleRetrySupersession
      ? await this.deps.settleRetrySupersession(
        action,
        context.processOwnerUserId,
        context.processGeneration,
        context.leaseSignal,
      )
      : action;
    if (!settledAction) return true;
    if (settledAction.localHandoff && (!context.leaseSignal
      || this.activeWriterLease?.handle?.mode === 'memory-only')) {
      pushStartupTrace('action_queue.processing_local_handoff', {
        entityType: action.entityType,
        actionType: action.type,
      });
      return true;
    }
    const syncingAction = this.isSelfSettledAttachmentReplay(settledAction) || settledAction.localHandoff
      ? settledAction
      : await this.deps.transitionToSyncing(
        settledAction,
        context.processOwnerUserId,
        context.leaseSignal,
        this.activePersistenceFence ?? (() => false),
      );
    if (!syncingAction) {
      pushStartupTrace('action_queue.processing_transition_null', {
        entityType: action.entityType,
        actionType: action.type,
        transitionReason: this.deps.getLastQueueTransitionReason(),
      });
      return true;
    }
    const isCurrent = this.createProcessorFence(syncingAction, context);
    if (!isCurrent()) {
      pushStartupTrace('action_queue.processing_fence_stale', {
        entityType: action.entityType,
        actionType: action.type,
      });
      return true;
    }

    try {
      this.deps.lifecycle.trackAction(context.processLifecycleToken, syncingAction.id);
      pushStartupTrace('action_queue.processing_processor_invoked', {
        processorKey: syncingAction.entityType + ':' + syncingAction.type,
      });
      this.debug('ActionQueue processor reach', {
        processorKey: syncingAction.entityType + ':' + syncingAction.type,
      });
      const processResult = context.leaseSignal
        ? await processor(syncingAction, { leaseSignal: context.leaseSignal, isCurrent })
        : await processor(syncingAction);
      if (this.isFullFenceReplay(syncingAction) && !isCurrent()) {
        return this.stopStaleFullFenceProcessing(context, result);
      }
      pushStartupTrace('action_queue.processing_processor_resolved', {
        processorKey: syncingAction.entityType + ':' + syncingAction.type,
        outcome: processResult === true ? 'success' : 'retry',
      });
      return await this.handleProcessorResult(syncingAction, processResult, context, result, isCurrent);
    } catch (error: unknown) {
      pushStartupTrace('action_queue.processing_processor_rejected', {
        processorKey: syncingAction.entityType + ':' + syncingAction.type,
      });
      if (this.isFullFenceReplay(syncingAction) && !isCurrent()) {
        return this.stopStaleFullFenceProcessing(context, result);
      }
      return await this.handleProcessorException(syncingAction, error, context, result);
    } finally {
      pushStartupTrace('action_queue.processing_processor_finished', {
        processorKey: syncingAction.entityType + ':' + syncingAction.type,
      });
      this.deps.lifecycle.untrackAction(syncingAction.id, context.processLifecycleToken);
    }
  }

  private async handleProcessorResult(
    action: QueuedAction,
    processResult: ActionQueueProcessorResult,
    context: QueueProcessContext,
    result: ActionQueueProcessResult,
    isCurrent: () => boolean,
  ): Promise<boolean> {
    const success = processResult === true;
    const retryError = getProcessorRetryError(processResult) ?? { message: 'Operation returned false' };

    if (this.isStaleProcess(context.processGeneration)) {
      await this.settleStaleProcessorResult(action, success, retryError, context);
      success ? result.processed++ : result.failed++;
      pushStartupTrace('action_queue.processing_stale_settlement', {
        entityType: action.entityType,
        actionType: action.type,
      });
      return true;
    }

    if (this.isLeaseLost(context)) {
      this.warn('sync writer lease 在 processor 结算前丢失，保留 action 等待后续对账', {
        actionId: action.id,
        success,
      });
      success ? result.processed++ : result.failed++;
      pushStartupTrace('action_queue.processing_lease_lost_settlement', {
        entityType: action.entityType,
        actionType: action.type,
      });
      return true;
    }

    if (success) {
      if (!this.isSelfSettledAttachmentReplay(action)
        && (!action.localHandoff || this.deps.pendingActions().some(item => item.id === action.id))) {
        const settled = await this.deps.settleSuccessfulAction(
          action,
          context.processOwnerUserId,
          context.leaseSignal,
          isCurrent,
        );
        if (!settled) {
          if (this.isFullFenceReplay(action)) {
            this.suppressedSettledLifecycleTokens.add(context.processLifecycleToken);
          }
          pushStartupTrace('action_queue.processing_settle_null', {
            entityType: action.entityType,
            actionType: action.type,
          });
          result.processed++;
          return true;
        }
      }
      result.processed++;
      return false;
    }

    if (this.isTaskQueueOnlyReplay(action, retryError)) return this.preserveTaskQueueOnlyReplay(context, result);
    return await this.handleFailedProcessorResult(action, retryError, context, result);
  }

  private async handleProcessorException(
    action: QueuedAction,
    error: unknown,
    context: QueueProcessContext,
    result: ActionQueueProcessResult
  ): Promise<boolean> {
    const retryError = toActionQueueRetryError(error);
    if (this.isStaleProcess(context.processGeneration)) {
      await this.settleStaleActionResultSafely(context, action, {
        success: false,
        error: retryError,
      });
      result.failed++;
      pushStartupTrace('action_queue.processing_stale_settlement', {
        entityType: action.entityType,
        actionType: action.type,
      });
      return true;
    }
    if (this.isLeaseLost(context)) {
      this.warn('sync writer lease 在 processor 异常结算前丢失，保留 action 等待后续处理', {
        actionId: action.id,
        error: retryError,
      });
      result.failed++;
      pushStartupTrace('action_queue.processing_lease_lost_settlement', {
        entityType: action.entityType,
        actionType: action.type,
      });
      return true;
    }

    if (this.isTaskQueueOnlyReplay(action, retryError)) return this.preserveTaskQueueOnlyReplay(context, result);
    return await this.handleFailedProcessorResult(action, retryError, context, result);
  }

  private async settleStaleProcessorResult(
    action: QueuedAction,
    success: boolean,
    retryError: QueueRetryError,
    context: QueueProcessContext
  ): Promise<void> {
    await this.settleStaleActionResultSafely(
      context,
      action,
      success ? { success: true } : { success: false, error: retryError },
    );
  }

  private async settleStaleActionResultSafely(
    context: QueueProcessContext,
    action: QueuedAction,
    outcome: { success: true } | { success: false; error: QueueRetryError },
  ): Promise<void> {
    const kind = outcome.success ? '结果' : '异常';
    try {
      await this.settleStaleActionResult(
        context.processGeneration,
        context.processOwnerUserId,
        action,
        outcome,
        context.leaseSignal,
      );
      this.logStaleActionSettled(action, context, kind);
    } catch (error) {
      this.warn('旧 owner 队列项持久化收口失败，已保留存储保护状态', {
        actionId: action.id,
        processOwnerUserId: context.processOwnerUserId,
        kind,
        error,
      });
    }
  }

  private async settleStaleActionResult(
    processGeneration: number,
    processOwnerUserId: string,
    action: QueuedAction,
    outcome: { success: true } | { success: false; error: QueueRetryError },
    leaseSignal: AbortSignal | undefined,
  ): Promise<void> {
    const stalePolicy = this.getStaleProcessPolicy(processGeneration, processOwnerUserId);
    if (stalePolicy !== 'settle-owner') {
      this.logDroppedStaleActionResult(action, processOwnerUserId, stalePolicy);
      return;
    }

    try {
      if (outcome.success) {
        await this.settleStaleSuccessfulAction(
          processOwnerUserId,
          processGeneration,
          action,
          leaseSignal,
        );
        return;
      }

      if (!outcome.success) {
        await this.settleStaleFailedAction(processOwnerUserId, action, outcome.error);
      }
    } catch (error) {
      this.warn('旧 owner 队列收口失败，保留持久队列等待恢复', {
        actionId: action.id,
        processOwnerUserId,
        error,
      });
    }
  }

  private logDroppedStaleActionResult(
    action: QueuedAction,
    processOwnerUserId: string,
    stalePolicy: QueueStalePolicy
  ): void {
    this.debug('旧处理循环结果已丢弃（非 owner 切换场景）', {
      actionId: action.id,
      processOwnerUserId,
      stalePolicy,
    });
  }

  private async settleStaleSuccessfulAction(
    processOwnerUserId: string,
    processGeneration: number,
    action: QueuedAction,
    leaseSignal: AbortSignal | undefined,
  ): Promise<void> {
    if (this.isSelfSettledAttachmentReplay(action)) return;
    if (action.entityType === 'project' && action.type === 'delete') {
      await this.settleStaleProjectDeleteSuccess(processOwnerUserId, action);
      return;
    }

    await this.deps.settleSuccessfulAction(
      action,
      processOwnerUserId,
      leaseSignal,
      () => leaseSignal?.aborted !== true
        && this.getStaleProcessPolicy(processGeneration, processOwnerUserId) === 'settle-owner',
    );
    this.debug('旧 owner 的成功 action 已在持久化队列中收口', {
      actionId: action.id,
      processOwnerUserId,
    });
  }

  private isSelfSettledAttachmentReplay(action: QueuedAction): boolean {
    return action.entityType === 'attachment' && action.type === 'create';
  }

  private isFullFenceReplay(action: QueuedAction): boolean {
    return (action.entityType === 'preference' && action.type === 'update')
      || ((action.type === 'create' || action.type === 'update')
        && ['task', 'focus-session', 'routine-task', 'routine-completion'].includes(action.entityType));
  }

  private isTaskQueueOnlyReplay(action: QueuedAction, retryError: QueueRetryError): boolean {
    if (action.entityType !== 'task' || (action.type !== 'create' && action.type !== 'update')
      || (retryError.code !== 'SYNC_TASK_WRITE_FAILED' && retryError.code !== 'SYNC_AUTH_PENDING')) return false;
    const payload = action.payload as TaskPayload;
    const details = retryError.details;
    const taskId = payload.task?.id;
    if (!details || typeof taskId !== 'string'
      || details['actionType'] !== `task:${action.type}` || details['taskId'] !== taskId) return false;
    return retryError.code === 'SYNC_TASK_WRITE_FAILED'
      ? details['reason'] === 'task-sync-failed' && details['projectId'] === payload.projectId
      : details['reason'] === 'auth-pending' && details['entityId'] === taskId;
  }

  private preserveTaskQueueOnlyReplay(context: QueueProcessContext, result: ActionQueueProcessResult): true {
    this.suppressedSettledLifecycleTokens.add(context.processLifecycleToken);
    result.failed++;
    return true;
  }

  private stopStaleFullFenceProcessing(context: QueueProcessContext, result: ActionQueueProcessResult): true {
    this.suppressedSettledLifecycleTokens.add(context.processLifecycleToken);
    result.failed++;
    return true;
  }

  private async settleStaleProjectDeleteSuccess(
    processOwnerUserId: string,
    action: QueuedAction
  ): Promise<void> {
    const removedCount = await this.deps.storage.settleProjectDeleteSuccessForOwner(
      processOwnerUserId,
      action.entityId,
      action.id,
    );
    this.debug('旧 owner 的项目删除已在持久化队列中收口', {
      actionId: action.id,
      processOwnerUserId,
      projectId: action.entityId,
      removedCount,
    });
  }

  private async settleStaleFailedAction(
    processOwnerUserId: string,
    action: QueuedAction,
    error: QueueRetryError,
  ): Promise<void> {
    const settleResult = await this.deps.storage.settleFailedActionForOwner(
      processOwnerUserId,
      action,
      error
    );
    this.debug('旧 owner 的失败 action 已在持久化队列中收口', {
      actionId: action.id,
      processOwnerUserId,
      settleResult,
    });
  }

  private logStaleActionSettled(action: QueuedAction, context: QueueProcessContext, kind: '结果' | '异常'): void {
    this.debug(`旧账号队列项处理${kind}已失效，已转入旧 owner 收口流程`, {
      actionId: action.id,
      processGeneration: context.processGeneration,
      currentGeneration: this.deps.queueViewState.currentQueueViewGeneration,
    });
  }

  private handleFailedProcessorResult(
    action: QueuedAction,
    retryError: QueueRetryError,
    context: QueueProcessContext,
    result: ActionQueueProcessResult
  ): Promise<boolean> {
    return this.handleFailedProcessorResultDurably(action, retryError, context, result);
  }

  private async handleFailedProcessorResultDurably(
    action: QueuedAction,
    retryError: QueueRetryError,
    context: QueueProcessContext,
    result: ActionQueueProcessResult
  ): Promise<boolean> {
    const retryResult = await this.deps.storage.handleRetryDurably(action, retryError);
    const settlementIsStale = this.isStaleProcess(context.processGeneration)
      || this.deps.getCurrentOwnerUserId() !== context.processOwnerUserId;
    if (retryResult === 'dead-letter') {
      result.movedToDeadLetter++;
      if (!settlementIsStale) this.markCreateFailureIfNeeded(action, context, true);
    }
    result.failed++;
    return settlementIsStale || retryResult === 'persistence-failed' || retryResult === 'missing';
  }

  private markCreateFailureIfNeeded(action: QueuedAction, context: QueueProcessContext, pauseDependents: boolean): void {
    if (action.type !== 'create') return;

    context.failedCreateEntities.add(getActionEntityKey(action));
    if (pauseDependents) {
      this.deps.storage.pauseDependentActions(action.entityType, action.entityId, context.queue);
    }
  }

  private isLeaseLost(context: QueueProcessContext): boolean {
    return context.leaseSignal?.aborted === true;
  }

  private createProcessorFence(action: QueuedAction, context: QueueProcessContext): () => boolean {
    const persistenceFence = this.activePersistenceFence ?? (() => false);
    return () => {
      if (!context.leaseSignal || context.leaseSignal.aborted || !persistenceFence()) return false;
      const matches = this.deps.pendingActions().filter(candidate => candidate.id === action.id);
      return matches.length === 1 && hasExactActionIdentity(matches[0], action);
    };
  }

  private finishQueueProcessing(context: QueueProcessContext, result: ActionQueueProcessResult): void {
    const { remoteSuccessCount, resolvedNoOpCount } = this.deps.lifecycle.getActionOutcomeCounts(context.processLifecycleToken);
    const suppressSettled = this.suppressedSettledLifecycleTokens.delete(context.processLifecycleToken);
    try {
      this.deps.lifecycle.end(context.processLifecycleToken);
    } catch (error) {
      this.warn('ActionQueue lifecycle end callback failed', error);
    }

    const queueProcessIsCurrent = !this.isStaleProcess(context.processGeneration);
    if (queueProcessIsCurrent) {
      this.deps.isProcessing.set(false);
    }
    if (queueProcessIsCurrent && !suppressSettled && this.activePersistenceFence?.() === true) {
      try {
        this.deps.lifecycle.notifySettled({
          ...result,
          remaining: this.deps.pendingActions().length,
          remoteSuccessCount,
          resolvedNoOpCount,
        });
      } catch (error) {
        this.warn('ActionQueue lifecycle settled callback failed', error);
      }
    }

    try {
      this.deps.lifecycle.clearActionOutcomes(context.processLifecycleToken);
    } catch (error) {
      this.warn('ActionQueue lifecycle outcome cleanup failed', error);
    }
    try {
      this.deps.sentryLazyLoader.addBreadcrumb({
        category: 'sync',
        message: `Queue processing completed`,
        level: result.processed > 0 ? 'info' : (result.failed > 0 ? 'warning' : 'info'),
        data: result
      });
    } catch (error) {
      this.warn('ActionQueue completion breadcrumb failed', error);
    }
  }

  private getStaleProcessPolicy(
    processGeneration: number,
    processOwnerUserId: string,
  ): QueueStalePolicy {
    return this.deps.queueViewState.getStaleProcessPolicy(
      processGeneration,
      processOwnerUserId,
    );
  }

  private isStaleProcess(processGeneration: number): boolean {
    return this.deps.queueViewState.isStaleProcess(processGeneration);
  }

  private debug(message: string, context?: unknown): void {
    try {
      this.deps.logger.debug(message, context);
    } catch {
      // Queue recovery and cleanup paths must not depend on observability sinks.
    }
  }

  private warn(message: string, context?: unknown): void {
    try {
      this.deps.logger.warn(message, context);
    } catch {
      // Queue recovery and cleanup paths must not depend on observability sinks.
    }
  }

  private toastWarning(title: string, message: string): void {
    try {
      this.deps.toast.warning(title, message);
    } catch (error) {
      this.warn('ActionQueue pending-operation toast failed', error);
    }
  }
}
