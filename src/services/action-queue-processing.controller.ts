import type { WritableSignal } from '@angular/core';
import { QUEUE_CONFIG } from '../config';
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
import type { QueuedAction } from './action-queue.types';

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
  dequeue: (actionId: string) => void | Promise<void>;
}

export class ActionQueueProcessingController {
  private leaseAcquisitionInFlight = false;
  private rerunRequested = false;

  constructor(private readonly deps: ActionQueueProcessingControllerDeps) {}

  async processQueue(): Promise<ActionQueueProcessResult> {
    if (this.deps.isProcessing() || this.leaseAcquisitionInFlight) {
      this.rerunRequested = true;
      return this.emptyResult();
    }

    if (!this.deps.storage.isOnline) {
      return this.emptyResult();
    }

    if (this.deps.writeGuard && !this.deps.writeGuard.assertWritable('ActionQueue.processQueue')) {
      return this.emptyResult();
    }

    if (this.deps.storage.shouldDeferQueueProcessing()) {
      this.deps.storage.requestQueueProcessing('processQueue');
      return this.emptyResult();
    }

    let syncWriterLeaseHandle: ActionQueueSyncWriterLeaseHandle | null = null;
    if (this.deps.syncWriterLeaseGate.isRequired()) {
      const leaseResult = await this.acquireRequiredProcessQueueLease();
      if (leaseResult === 'retry-later') {
        this.scheduleLeaseRetryIfNeeded();
        return this.emptyResult();
      }
      if (!leaseResult) {
        return this.emptyResult();
      }
      syncWriterLeaseHandle = leaseResult;
    }

    const context = this.beginQueueProcessing();
    const result: ActionQueueProcessResult = this.emptyResult();

    try {
      await this.processQueueActions(context, result);
    } finally {
      try {
        this.finishQueueProcessing(context, result);
      } finally {
        await this.releaseSyncWriterLease(syncWriterLeaseHandle);
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

  private beginQueueProcessing(): QueueProcessContext {
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

    return {
      processGeneration: this.deps.queueViewState.currentQueueViewGeneration,
      processOwnerUserId: this.deps.getCurrentOwnerUserId(),
      processLifecycleToken,
      queue: [...this.deps.pendingActions()],
      failedCreateEntities: new Set<string>()
    };
  }

  private async processQueueActions(
    context: QueueProcessContext,
    result: ActionQueueProcessResult
  ): Promise<void> {
    for (const action of context.queue) {
      if (this.shouldStopStaleQueueProcess(context, action)) break;
      if (this.shouldSkipQueuedAction(action, context)) continue;

      const processorKey = `${action.entityType}:${action.type}`;
      const processor = this.deps.processors.get(processorKey);

      if (!processor) {
        this.handleMissingActionProcessor(action, processorKey, context, result);
        continue;
      }

      const shouldStop = await this.processQueuedAction(action, processor, context, result);
      if (shouldStop) break;
    }
  }

  private shouldStopStaleQueueProcess(context: QueueProcessContext, action: QueuedAction): boolean {
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
    const syncingAction = this.deps.storage.markActionSyncState(action.id, 'syncing') ?? {
      ...action,
      syncState: 'syncing' as const,
    };

    try {
      this.deps.lifecycle.trackAction(context.processLifecycleToken, syncingAction.id);
      const processResult = await processor(syncingAction);
      return await this.handleProcessorResult(syncingAction, processResult, context, result);
    } catch (error: unknown) {
      return await this.handleProcessorException(syncingAction, error, context, result);
    } finally {
      this.deps.lifecycle.untrackAction(syncingAction.id);
    }
  }

  private async handleProcessorResult(
    action: QueuedAction,
    processResult: ActionQueueProcessorResult,
    context: QueueProcessContext,
    result: ActionQueueProcessResult
  ): Promise<boolean> {
    const success = processResult === true;
    const retryError = getProcessorRetryError(processResult) ?? { message: 'Operation returned false' };

    if (this.isStaleProcess(context.processGeneration)) {
      await this.settleStaleProcessorResult(action, success, retryError, context);
      success ? result.processed++ : result.failed++;
      return true;
    }

    if (success) {
      await this.deps.dequeue(action.id);
      result.processed++;
      return false;
    }

    await this.handleFailedProcessorResult(action, retryError, context, result);
    return false;
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
      return true;
    }

    await this.handleFailedProcessorResult(action, retryError, context, result);
    return false;
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
    outcome: { success: true } | { success: false; error: QueueRetryError }
  ): Promise<void> {
    const stalePolicy = this.getStaleProcessPolicy(processGeneration);
    if (stalePolicy !== 'settle-owner') {
      this.logDroppedStaleActionResult(action, processOwnerUserId, stalePolicy);
      return;
    }

    try {
      if (outcome.success) {
        await this.settleStaleSuccessfulAction(processOwnerUserId, action);
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
    action: QueuedAction
  ): Promise<void> {
    if (action.entityType === 'project' && action.type === 'delete') {
      await this.settleStaleProjectDeleteSuccess(processOwnerUserId, action);
      return;
    }

    await this.deps.storage.settleSuccessfulActionForOwner(processOwnerUserId, action.id);
    this.debug('旧 owner 的成功 action 已在持久化队列中收口', {
      actionId: action.id,
      processOwnerUserId,
    });
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
  ): Promise<void> {
    return this.handleFailedProcessorResultDurably(action, retryError, context, result);
  }

  private async handleFailedProcessorResultDurably(
    action: QueuedAction,
    retryError: QueueRetryError,
    context: QueueProcessContext,
    result: ActionQueueProcessResult
  ): Promise<void> {
    const retryResult = await this.deps.storage.handleRetryDurably(action, retryError);
    if (retryResult === 'dead-letter') {
      result.movedToDeadLetter++;
      this.markCreateFailureIfNeeded(action, context, true);
    }
    result.failed++;
  }

  private markCreateFailureIfNeeded(action: QueuedAction, context: QueueProcessContext, pauseDependents: boolean): void {
    if (action.type !== 'create') return;

    context.failedCreateEntities.add(getActionEntityKey(action));
    if (pauseDependents) {
      this.deps.storage.pauseDependentActions(action.entityType, action.entityId, context.queue);
    }
  }

  private finishQueueProcessing(context: QueueProcessContext, result: ActionQueueProcessResult): void {
    const { remoteSuccessCount, resolvedNoOpCount } = this.deps.lifecycle.getActionOutcomeCounts(context.processLifecycleToken);
    try {
      this.deps.lifecycle.end(context.processLifecycleToken);
    } catch (error) {
      this.warn('ActionQueue lifecycle end callback failed', error);
    }

    if (!this.isStaleProcess(context.processGeneration)) {
      this.deps.isProcessing.set(false);
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

  private getStaleProcessPolicy(processGeneration: number): QueueStalePolicy {
    return this.deps.queueViewState.getStaleProcessPolicy(processGeneration);
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
