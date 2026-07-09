import { Injectable, inject, signal, DestroyRef } from '@angular/core';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { SentryAlertService } from './sentry-alert.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { ActionQueueStorageService, type QueueRetryError } from './action-queue-storage.service';
import { RetryQueueService } from '../core-bridge';
import { AuthService } from './auth.service';
import { WriteGuardService } from './write-guard.service';
import { AUTH_CONFIG } from '../config/auth.config';
import { ActionQueueEnqueueMutationService, type EnqueueMutationResult } from './action-queue-enqueue-mutation.service';
import { ActionQueueSyncWriterLeaseService } from './action-queue-sync-writer-lease.service';
import { ActionQueueViewStateService, type QueueStalePolicy } from './action-queue-view-state.service';
import {
  buildDeferredActionQueueRetry,
  buildFailedActionQueueRetry,
  type ActionQueueProcessorResult,
  type DeferredActionQueueRetry,
  type FailedActionQueueRetry,
} from './action-queue-processor-result.helpers';
import {
  ActionQueueLifecycleController,
  type ActionQueueProcessSettledSummary,
} from './action-queue-lifecycle.controller';
import { ActionQueueProcessorRegistryController } from './action-queue-processor-registry.controller';
import type {
  ActionQueueProcessResult,
} from './action-queue-processing.types';
import { ActionQueueProcessingController } from './action-queue-processing.controller';
import {
  getActionsForEntity as filterActionsForEntity,
  getBlockedActions as selectBlockedActions,
  getPendingActionsForProject as filterPendingActionsForProject,
  hasUncompletedCreate as hasUncompletedCreateAction,
  shouldDiscardAfterProjectDeleteSuccess,
} from './action-queue-query.helpers';
import {
  persistBulkDurableEnqueueMutation,
  runBulkDurableEnqueue,
} from './action-queue-bulk-durable-enqueue.helpers';
import {
  type DurableEnqueueMutationOutcome,
} from './action-queue-state.helpers';
import {
  enqueueActionQueueForForeignOwner,
  persistActionQueueCurrentOwnerEnqueueMutation,
} from './action-queue-owner-view.helpers';
import { warnIfActionQueueFrozen } from './action-queue-frozen-warning.helpers';
import { ActionQueueFrozenPersistenceController } from './action-queue-frozen-persistence.controller';
import { ActionQueuePendingViewController } from './action-queue-pending-view.controller';
import { ActionQueueRuntimeSideEffectsController } from './action-queue-runtime-side-effects.helpers';
import {
  QueuedAction,
  EnqueueParams,
  DeadLetterItem
} from './action-queue.types';

export type { ActionQueueProcessorResult, DeferredActionQueueRetry, FailedActionQueueRetry } from './action-queue-public.types';
export type { OperationPriority, ActionPayload, ProjectPayload, ProjectDeletePayload, ConnectionPayload, TaskPayload, TaskDeletePayload, PreferencePayload, QueuedAction, EnqueueParams, DeadLetterItem } from './action-queue-public.types';

/**
 * 离线操作队列服务
 * 负责存储失败的变更操作，网络恢复后自动重试
 * 实现离线优先架构的可靠性保证
 * 
 * 存储/死信/网络/重试逻辑委托给 ActionQueueStorageService
 */
@Injectable({
  providedIn: 'root'
})
export class ActionQueueService {
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('ActionQueue');
  private readonly toast = inject(ToastService);
  private readonly sentryAlert = inject(SentryAlertService);
  private readonly authService = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);
  /**
   * 写入闸门：迁移期 export-only / read-only 部署 gate 云端 flush。
   * 标记 optional：测试 harness 通常不提供，保持向后兼容。
   * 缺失时默认为可写（与迁移前行为一致）。
   */
  private readonly writeGuard = inject(WriteGuardService, { optional: true });
  readonly storage = inject(ActionQueueStorageService);
  private readonly enqueueMutations = inject(ActionQueueEnqueueMutationService);
  private readonly syncWriterLeaseGate = inject(ActionQueueSyncWriterLeaseService);
  private readonly queueViewState = inject(ActionQueueViewStateService);
  /** 跨队列去重：当新操作入队时移除 RetryQueue 中同一实体的旧重试 */
  private readonly retryQueue = inject(RetryQueueService);
  
  /** 待处理队列 */
  readonly pendingActions = signal<QueuedAction[]>([]);
  
  /** 死信队列 — 委托给 storage */
  readonly deadLetterQueue = this.storage.deadLetterQueue;
  
  /** 是否正在处理队列 */
  readonly isProcessing = signal(false);
  
  /** 队列大小 */
  readonly queueSize = signal(0);
  
  /** 死信队列大小 — 委托给 storage */
  readonly deadLetterSize = this.storage.deadLetterSize;
  
  /** 存储失败状态 — 委托给 storage */
  readonly storageFailure = this.storage.storageFailure;
  /** 队列冻结状态（配额/存储压力） */
  readonly queueFrozen = this.storage.queueFrozen;
  /** 队列冻结原因，用于同步状态面板解释本地持久化风险 */
  readonly queueFreezeReason = this.storage.queueFreezeReason;
  private readonly runtimeSideEffects = new ActionQueueRuntimeSideEffectsController({
    getQueueLength: () => this.pendingActions().length,
    getDeadLetterCount: () => this.deadLetterQueue().length,
    retryQueue: this.retryQueue,
    sentryLazyLoader: this.sentryLazyLoader,
    sentryAlert: this.sentryAlert,
    logger: this.logger,
  });
  
  private readonly pendingView = new ActionQueuePendingViewController({
    pendingActions: this.pendingActions,
    queueSize: this.queueSize,
    setProcessing: isProcessing => this.isProcessing.set(isProcessing),
  });
  /** 处理器函数映射与注册就绪状态 */
  private readonly processorRegistry = new ActionQueueProcessorRegistryController({
    getPendingActions: () => this.pendingActions(),
    requestQueueProcessing: reason => this.storage.requestQueueProcessing(reason),
    debug: (message, context) => this.logger.debug(message, context),
    error: (message, context) => this.logger.error(message, context),
  });
  /** 队列处理生命周期回调与活动 token 管理 */
  private readonly lifecycle = new ActionQueueLifecycleController();
  private readonly processingController = new ActionQueueProcessingController({
    logger: this.logger,
    toast: this.toast,
    sentryLazyLoader: this.sentryLazyLoader,
    storage: this.storage,
    syncWriterLeaseGate: this.syncWriterLeaseGate,
    writeGuard: this.writeGuard,
    queueViewState: this.queueViewState,
    lifecycle: this.lifecycle,
    pendingActions: this.pendingActions,
    isProcessing: this.isProcessing,
    processors: this.processorRegistry.processors,
    isProcessorRegistrationReady: () => this.processorRegistry.isReady(),
    getCurrentOwnerUserId: () => this.getCurrentOwnerUserId(),
    dequeue: (actionId) => this.dequeueProcessedAction(actionId),
  });
  private readonly frozenPersistence = new ActionQueueFrozenPersistenceController({
    isQueueFrozen: () => this.storage.queueFrozen(),
    saveQueueToStorage: () => this.storage.saveQueueToStorage(),
  });

  constructor() {
    // 初始化 storage 上下文引用
    this.storage.init({
      dequeue: (id) => this.dequeue(id),
      syncSentryContext: () => this.runtimeSideEffects.syncSentryContext(),
      processQueue: () => this.processQueue(),
      pendingActions: this.pendingActions,
      queueSize: this.queueSize,
    });
    
    this.storage.loadQueueFromStorage();
    this.storage.loadDeadLetterFromStorage();
    this.storage.setupNetworkListeners();
    
    this.destroyRef.onDestroy(() => this.storage.removeNetworkListeners());
  }

  private warnSafely(message: string, context?: Record<string, unknown>): void {
    try {
      this.logger.warn(message, context);
    } catch {
      // Observability failures must not break queue state recovery.
    }
  }

  private syncSentryContextSafely(operation: string): void {
    try {
      this.runtimeSideEffects.syncSentryContext();
    } catch (error) {
      this.warnSafely('ActionQueue Sentry context 同步失败，已保留队列状态', {
        operation,
        error,
      });
    }
  }
  
  // ========== 公共方法 ==========
  
  /**
   * 注册操作处理器
   */
  registerProcessor(type: string, processor: (action: QueuedAction) => Promise<ActionQueueProcessorResult>) {
    this.processorRegistry.registerProcessor(type, processor);
  }

  deferRetry(error: QueueRetryError): DeferredActionQueueRetry {
    return buildDeferredActionQueueRetry(error);
  }

  failRetry(error: QueueRetryError): FailedActionQueueRetry {
    return buildFailedActionQueueRetry(error);
  }
  
  /**
   * 验证所有必需的处理器是否已注册
   */
  validateProcessors(requiredProcessors: string[]): string[] {
    return this.processorRegistry.validateProcessors(requiredProcessors);
  }
  
  /**
   * 获取已注册的处理器类型列表（用于调试）
   */
  getRegisteredProcessorTypes(): string[] {
    return this.processorRegistry.getRegisteredProcessorTypes();
  }

  /** 注册失败通知回调 */
  onFailure(callback: (item: DeadLetterItem) => void) {
    this.storage.onFailure(callback);
  }
  
  /** 注册存储失败回调（逃生模式） */
  onStorageFailure(callback: (data: { queue: QueuedAction[]; deadLetter: DeadLetterItem[] }) => void) {
    this.storage.onStorageFailure(callback);
  }
  
  /** 导出待同步数据为 JSON 并下载（逃生导出，冻结时使用） */
  downloadEscapeExport(): void {
    this.storage.downloadEscapeExport();
  }
  
  /**
   * 添加操作到队列（类型安全版本）
   * 支持优先级分级 + 智能合并
   */
  enqueue(action: EnqueueParams): string {
    return this.enqueueInternal(action, true, true);
  }

  async enqueueDurably(action: EnqueueParams): Promise<string> {
    return this.enqueueDurablyInternal(action, true);
  }

  async enqueueManyDurably(actions: EnqueueParams[]): Promise<string[]> {
    return runBulkDurableEnqueue({
      actions,
      enqueueSingle: action => this.enqueueDurably(action),
      readPendingActions: () => this.pendingActions(),
      warnIfQueueFrozen: action => this.warnIfQueueFrozen(action),
      getCurrentOwnerUserId: () => this.getCurrentOwnerUserId(),
      createQueuedAction: action => this.enqueueMutations.createQueuedAction(action),
      buildCurrentOwnerEnqueueMutation: (queue, action, queuedAction) =>
        this.enqueueMutations.buildCurrentOwnerEnqueueMutation(
          queue,
          action,
          queuedAction,
        ),
      persistQueueMutationForOwner: (ownerUserId, mutateQueue) =>
        this.storage.persistQueueMutationForOwner(ownerUserId, mutateQueue),
      rollbackFailedBulkDurableEnqueue: previousQueue =>
        this.rollbackFailedBulkDurableEnqueue(previousQueue),
      applyPersistedCurrentOwnerQueue: persistedQueue =>
        this.applyPersistedCurrentOwnerQueue(persistedQueue),
      completeDurableEnqueueSideEffects: (
        action,
        queuedAction,
        resolvedActionId,
        removeRetrySourceOnSuccess,
      ) => this.runtimeSideEffects.runEnqueueSideEffects(
        {
          action,
          queuedAction,
          resolvedActionId,
          removeRetrySourceOnSuccess,
        },
      ),
      isOnline: () => this.storage.isOnline,
      processQueue: () => this.processQueue(),
      warn: (message, context) => this.logger.warn(message, context),
    });
  }

  private async enqueueDurablyInternal(action: EnqueueParams, removeRetrySourceOnSuccess: boolean): Promise<string> {
    const previousQueue = [...this.pendingActions()];
    this.warnIfQueueFrozen(action);

    const queuedAction = this.enqueueMutations.createQueuedAction(action);
    const { persistedQueue, mutation } = await this.persistCurrentOwnerEnqueueMutation(action, queuedAction);
    if (!mutation) {
      this.logger.warn('ActionQueue durable enqueue 未能生成队列 mutation', {
        entityType: action.entityType,
        entityId: action.entityId,
      });
      return '';
    }

    if (!mutation.wasEnqueued && !mutation.wasMergeShrunk) {
      return mutation.resolvedActionId;
    }

    if (!persistedQueue) {
      this.rollbackFailedDurableEnqueue(action, queuedAction, mutation, previousQueue);
      return '';
    }

    this.applyPersistedCurrentOwnerQueue(persistedQueue);

    if (mutation.wasMergeShrunk) {
      return mutation.resolvedActionId;
    }

    this.completeDurableEnqueue(action, queuedAction, mutation, removeRetrySourceOnSuccess);

    return mutation.resolvedActionId;
  }

  private async persistCurrentOwnerEnqueueMutation(
    action: EnqueueParams,
    queuedAction: QueuedAction,
  ): Promise<DurableEnqueueMutationOutcome> {
    return persistActionQueueCurrentOwnerEnqueueMutation({
      ownerUserId: this.getCurrentOwnerUserId(),
      action,
      queuedAction,
      persistQueueMutationForOwner: (ownerUserId, mutateQueue) =>
        this.storage.persistQueueMutationForOwner(ownerUserId, mutateQueue),
      buildCurrentOwnerEnqueueMutation: (queue, currentAction, currentQueuedAction) =>
        this.enqueueMutations.buildCurrentOwnerEnqueueMutation(queue, currentAction, currentQueuedAction),
    });
  }

  private rollbackFailedDurableEnqueue(
    action: EnqueueParams,
    queuedAction: QueuedAction,
    mutation: EnqueueMutationResult,
    previousQueue: QueuedAction[],
  ): void {
    this.pendingView.setQueue(previousQueue);
    this.runtimeSideEffects.syncSentryContext();
    this.logger.warn('ActionQueue durable enqueue 未能完成持久化确认', {
      actionId: mutation.resolvedActionId || queuedAction.id,
      entityType: action.entityType,
      entityId: action.entityId,
    });
  }

  private applyPersistedCurrentOwnerQueue(persistedQueue: QueuedAction[]): void {
    this.pendingView.setQueue(persistedQueue);
    this.runtimeSideEffects.syncSentryContext();
  }

  private rollbackFailedBulkDurableEnqueue(previousQueue: QueuedAction[]): void {
    this.pendingView.setQueue(previousQueue);
    this.runtimeSideEffects.syncSentryContext();
  }

  private completeDurableEnqueue(
    action: EnqueueParams,
    queuedAction: QueuedAction,
    mutation: EnqueueMutationResult,
    removeRetrySourceOnSuccess: boolean,
  ): void {
    this.runtimeSideEffects.runEnqueueSideEffects({
      action,
      queuedAction,
      resolvedActionId: mutation.resolvedActionId,
      removeRetrySourceOnSuccess,
    });

    if (this.storage.isOnline) {
      this.scheduleProcessQueue();
    }
  }

  async enqueueDurablyForOwner(ownerUserId: string, action: EnqueueParams): Promise<string> {
    if (ownerUserId === this.getCurrentOwnerUserId()) {
      return this.enqueueDurablyInternal(action, false);
    }

    return enqueueActionQueueForForeignOwner({
      ownerUserId,
      action,
      createQueuedAction: currentAction => this.enqueueMutations.createQueuedAction(currentAction),
      persistQueueMutationForOwner: (targetOwnerUserId, mutateQueue) =>
        this.storage.persistQueueMutationForOwner(targetOwnerUserId, mutateQueue),
      buildForeignOwnerEnqueueMutation: (queue, currentAction, queuedAction, targetOwnerUserId) =>
        this.enqueueMutations.buildForeignOwnerEnqueueMutation(
          queue,
          currentAction,
          queuedAction,
          targetOwnerUserId,
        ),
      logInfo: (message, context) => this.logger.info(message, context),
    });
  }

  async enqueueManyDurablyForOwner(ownerUserId: string, actions: EnqueueParams[]): Promise<string[]> {
    if (actions.length === 0) {
      return [];
    }

    if (ownerUserId === this.getCurrentOwnerUserId()) {
      return this.enqueueManyDurably(actions);
    }

    if (actions.length === 1) {
      const actionId = await this.enqueueDurablyForOwner(ownerUserId, actions[0]);
      return actionId ? [actionId] : [];
    }

    actions.forEach(action => this.warnIfQueueFrozen(action));
    const outcome = await persistBulkDurableEnqueueMutation({
      actions,
      getCurrentOwnerUserId: () => ownerUserId,
      createQueuedAction: action => this.enqueueMutations.createQueuedAction(action),
      buildCurrentOwnerEnqueueMutation: (queue, action, queuedAction) =>
        this.enqueueMutations.buildForeignOwnerEnqueueMutation(
          queue,
          action,
          queuedAction,
          ownerUserId,
        ),
      persistQueueMutationForOwner: (targetOwnerUserId, mutateQueue) =>
        this.storage.persistQueueMutationForOwner(targetOwnerUserId, mutateQueue),
    });

    if (outcome.error || !outcome.persistedQueue || outcome.resolvedActionIds.length !== actions.length) {
      this.logger.warn('ActionQueue owner-scoped bulk durable enqueue 未能完成原子持久化', {
        ownerUserId,
        actionCount: actions.length,
        resolvedActionCount: outcome.resolvedActionIds.length,
        rejectedEntityType: outcome.rejectedAction?.entityType,
        rejectedEntityId: outcome.rejectedAction?.entityId,
        error: outcome.error,
      });
      return [];
    }

    this.logger.info('已将批量离线操作 durably 写入指定 owner 队列', {
      ownerUserId,
      actionCount: actions.length,
    });

    return [...outcome.resolvedActionIds];
  }

  private enqueueInternal(action: EnqueueParams, autoProcess: boolean, dedupeRetry: boolean): string {
    this.warnIfQueueFrozen(action);
    if (this.storage.queueFrozen()) {
      return '';
    }

    const queuedAction = this.enqueueMutations.createQueuedAction(action);
    const mutation = this.enqueueMutations.buildCurrentOwnerEnqueueMutation(
      this.pendingActions(),
      action,
      queuedAction
    );

    this.pendingView.setQueue(mutation.nextQueue);

    const resolvedActionId = mutation.resolvedActionId;

    // 智能合并导致队列缩小时，同步 queueSize 并持久化
    if (mutation.wasMergeShrunk) {
      this.persistCurrentOwnerQueueState();
      return resolvedActionId;
    }

    if (!mutation.wasEnqueued) {
      return resolvedActionId;
    }

    this.persistCurrentOwnerQueueState();

    this.runtimeSideEffects.runEnqueueSideEffects({
      action,
      queuedAction,
      resolvedActionId,
      removeRetrySourceOnSuccess: dedupeRetry,
    });

    if (autoProcess && this.storage.isOnline) {
      this.scheduleProcessQueue();
    }

    return resolvedActionId;
  }

  private scheduleProcessQueue(): void {
    void this.processQueue().catch(error => {
      this.logger.warn('ActionQueue 自动处理失败', error);
    });
  }

  private warnIfQueueFrozen(action: EnqueueParams): void {
    warnIfActionQueueFrozen({
      action,
      isQueueFrozen: () => this.storage.queueFrozen(),
      getFreezeReason: () => this.storage.queueFreezeReason(),
      warn: (message, context) => this.logger.warn(message, context),
      notifyQueuePressureOnce: (title, message) =>
        this.enqueueMutations.notifyQueuePressureOnce(title, message),
    });
  }

  private persistCurrentOwnerQueueState(): void {
    this.pendingView.setQueue(this.pendingActions());
    this.persistQueue();
    this.runtimeSideEffects.syncSentryContext();
  }

  async enqueueForOwner(ownerUserId: string, action: EnqueueParams): Promise<string> {
    return this.enqueueDurablyForOwner(ownerUserId, action);
  }

  private persistQueue(): void {
    this.frozenPersistence.persist();
  }

  private async dequeueProcessedAction(actionId: string): Promise<void> {
    const ownerUserId = this.getCurrentOwnerUserId();
    const persistedQueue = await this.storage.persistQueueMutationForOwner(
      ownerUserId,
      queue => queue.filter(action => action.id !== actionId),
    );

    if (persistedQueue !== null) {
      this.applyPersistedCurrentOwnerQueue(persistedQueue);
      return;
    }

    this.logger.warn('处理成功后的持久 Outbox 收口失败，保留当前视图等待恢复重放', {
      actionId,
      ownerUserId,
    });
    this.restoreProcessedActionAfterDurableDequeueFailure(actionId);
  }

  private restoreProcessedActionAfterDurableDequeueFailure(actionId: string): void {
    const restored = this.pendingView.mapQueue(action => {
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

    this.storage.saveQueueToStorage();
    this.runtimeSideEffects.syncSentryContext();
  }
  
  /**
   * 从队列中移除操作
   */
  dequeue(actionId: string) {
    this.pendingView.filterQueue(action => action.id !== actionId);
    this.storage.saveQueueToStorage();
    this.runtimeSideEffects.syncSentryContext();
  }
  
  /**
   * 设置队列处理生命周期回调
   */
  setQueueProcessCallbacks(
    onStart: () => void,
    onEnd: () => void,
    onSettled?: (summary: ActionQueueProcessSettledSummary) => void
  ) {
    this.lifecycle.setCallbacks(onStart, onEnd, onSettled);
  }

  markActionSyncedRemotely(actionId: string): void {
    this.lifecycle.markActionSyncedRemotely(actionId);
  }

  markActionResolvedWithoutRemote(actionId: string): void {
    this.lifecycle.markActionResolvedWithoutRemote(actionId);
  }

  private getCurrentOwnerUserId(): string {
    return this.authService.currentUserId() ?? AUTH_CONFIG.LOCAL_MODE_USER_ID;
  }

  private releaseAllQueueProcessLifecycles(reason: string): void {
    if (!this.lifecycle.releaseAll()) {
      return;
    }

    this.logger.debug('强制释放旧队列处理生命周期', { reason });
  }

  private invalidateQueueView(
    reason: string,
    stalePolicy: QueueStalePolicy = 'discard'
  ): number {
    return this.queueViewState.invalidateQueueView(reason, stalePolicy);
  }

  private isStaleProcess(processGeneration: number): boolean {
    return this.queueViewState.isStaleProcess(processGeneration);
  }

  getCurrentQueueViewGeneration(): number {
    return this.queueViewState.currentQueueViewGeneration;
  }

  isQueueViewCurrent(queueViewGeneration: number, ownerUserId?: string | null): boolean {
    const ownerMatches = typeof ownerUserId === 'string'
      ? this.getCurrentOwnerUserId() === ownerUserId
      : true;
    return this.queueViewState.isQueueViewCurrent(queueViewGeneration, ownerMatches);
  }

  getProjectMutationViewGeneration(projectId: string, ownerUserId?: string | null): number {
    return this.queueViewState.getProjectMutationViewGeneration(
      projectId,
      ownerUserId ?? this.getCurrentOwnerUserId()
    );
  }

  invalidateProjectMutationView(projectId: string, ownerUserId?: string | null): number {
    return this.queueViewState.invalidateProjectMutationView(
      projectId,
      ownerUserId ?? this.getCurrentOwnerUserId()
    );
  }

  async settleProjectDeleteSuccessForOwner(
    ownerUserId: string,
    projectId: string,
    actionId?: string,
  ): Promise<number> {
    if (ownerUserId === this.getCurrentOwnerUserId()) {
      return this.discardActions(action =>
        shouldDiscardAfterProjectDeleteSuccess(action, projectId, actionId));
    }

    return await this.storage.settleProjectDeleteSuccessForOwner(ownerUserId, projectId, actionId);
  }
  
  /**
   * 处理队列中的所有操作
   * 
   * 【依赖顺序控制】
   * Create 操作必须在对应实体的 Update/Delete 操作之前成功
   */
  async processQueue(): Promise<ActionQueueProcessResult> {
    return this.processingController.processQueue();
  }

  /** 清空队列 */
  clearQueue() {
    this.invalidateQueueView('clear-queue', 'discard');
    this.releaseAllQueueProcessLifecycles('clear-queue');
    this.clearPendingQueueView();
    this.storage.saveQueueToStorage();
    this.runtimeSideEffects.syncSentryContext();
  }
  
  /** 清空死信队列 */
  clearDeadLetterQueue() { this.storage.clearDeadLetterQueue(); }

  /**
   * 仅清空当前内存视图，不覆盖持久化数据。
   * 用于切账号时先断开旧 owner 的可见队列，再按新 owner 重新加载。
   */
  clearCurrentView(): void {
    this.invalidateQueueView('clear-current-view', 'settle-owner');
    this.releaseAllQueueProcessLifecycles('clear-current-view');
    this.clearPendingQueueView();
    this.storage.deadLetterQueue.set([]);
    this.storage.deadLetterSize.set(0);
    this.runtimeSideEffects.syncSentryContext();
  }

  /** 按当前 owner 重新加载持久化队列，避免跨账号会话看到旧队列/死信。 */
  reloadFromStorageForCurrentOwner(): void {
    this.clearCurrentView();
    this.runOwnerReloadPhaseSafely('load-pending', () => this.storage.loadQueueFromStorage());
    this.runOwnerReloadPhaseSafely('load-dead-letter', () => this.storage.loadDeadLetterFromStorage());
    this.runOwnerReloadPhaseSafely('sync-sentry', () => this.runtimeSideEffects.syncSentryContext());
  }

  private runOwnerReloadPhaseSafely(phase: string, run: () => void): void {
    try {
      run();
    } catch (error) {
      this.warnSafely('ActionQueue owner 队列重新加载阶段失败，已继续后续阶段', {
        phase,
        error,
      });
    }
  }
  
  /** 从死信队列重试操作 */
  retryDeadLetter(itemId: string): Promise<boolean> {
    return this.storage.retryDeadLetter(itemId);
  }
  
  /** 从死信队列删除操作（放弃同步） */
  dismissDeadLetter(itemId: string) { this.storage.dismissDeadLetter(itemId); }

  /** 将待处理操作直接转入死信队列，保留数据供人工确认或稍后重试 */
  moveToDeadLetter(action: QueuedAction, reason: string): void {
    this.storage.moveToDeadLetter(action, reason);
  }
  
  /** 获取特定实体的待处理操作 */
  getActionsForEntity(entityType: string, entityId: string): QueuedAction[] {
    return filterActionsForEntity(this.pendingActions(), entityType, entityId);
  }

  /**
   * 获取特定项目的所有待处理操作
   */
  getPendingActionsForProject(projectId: string): QueuedAction[] {
    return filterPendingActionsForProject(this.pendingActions(), projectId);
  }

  /** 检查是否有待处理的操作 */
  hasPendingActions(): boolean {
    return this.pendingActions().length > 0;
  }

  /** 丢弃满足条件的待处理操作，并立即持久化队列 */
  discardActions(predicate: (action: QueuedAction) => boolean): number {
    const previousQueue = [...this.pendingActions()];
    const discardedCount = this.pendingView.filterQueue(action => !predicate(action));

    if (discardedCount === 0) {
      return 0;
    }

    try {
      this.storage.saveQueueToStorage();
    } catch (error) {
      this.pendingView.setQueue(previousQueue);
      this.syncSentryContextSafely('discard-actions-rollback');
      this.warnSafely('ActionQueue discardActions 持久化失败，已回滚内存队列', {
        discardedCount,
        error,
      });
      return 0;
    }

    this.syncSentryContextSafely('discard-actions');
    return discardedCount;
  }
  
  /** 检查是否有死信 */
  hasDeadLetters(): boolean {
    return this.storage.hasDeadLetters();
  }
  
  /** 检查指定实体是否有未完成的 Create 操作 */
  hasUncompletedCreate(entityType: string, entityId: string): boolean {
    return hasUncompletedCreateAction(this.pendingActions(), entityType, entityId);
  }
  
  /** 获取被阻塞的操作（等待 Create 成功） */
  getBlockedActions(): QueuedAction[] {
    return selectBlockedActions(this.pendingActions());
  }

  // ========== 状态重置 ==========
  
  /**
   * 显式重置服务状态（测试 / HMR）
   */
  reset(): void {
    this.invalidateQueueView('reset', 'discard');
    this.releaseAllQueueProcessLifecycles('reset');
    this.storage.reset();
    
    this.clearPendingQueueView();
    this.runtimeSideEffects.syncSentryContext();
    
    this.processorRegistry.clearProcessors();
    this.lifecycle.clearCallbacks();
  }

  private clearPendingQueueView(): void {
    this.pendingView.resetQueueView();
  }
}
