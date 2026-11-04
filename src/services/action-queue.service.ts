import { Injectable, Injector, inject, signal, DestroyRef } from '@angular/core';
import { pushStartupTrace } from '../utils/startup-trace';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { SentryAlertService } from './sentry-alert.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import {
  ActionQueueStorageService,
  type QueueRetryError,
} from './action-queue-storage.service';
import { RetryQueueService } from '../core-bridge';
import { AuthService } from './auth.service';
import { UserSessionService } from './user-session.service';
import { WriteGuardService } from './write-guard.service';
import { AUTH_CONFIG } from '../config/auth.config';
import {
  ActionQueueEnqueueMutationService,
  type ActionQueueDurableEnqueueRuntime,
} from './action-queue-enqueue-mutation.service';
import { ActionQueueSyncWriterLeaseService } from './action-queue-sync-writer-lease.service';
import { QueueBackupService } from './queue-backup.service';
import { ActionQueueViewStateService, type QueueStalePolicy } from './action-queue-view-state.service';
import {
  buildDeferredActionQueueRetry,
  buildFailedActionQueueRetry,
  type DeferredActionQueueRetry,
  type FailedActionQueueRetry,
} from './action-queue-processor-result.helpers';
import {
  ActionQueueLifecycleController,
  type ActionQueueProcessSettledSummary,
} from './action-queue-lifecycle.controller';
import { ActionQueueProcessorRegistryController } from './action-queue-processor-registry.controller';
import type { ActionQueueProcessResult, QueueProcessor } from './action-queue-processing.types';
import { ActionQueueProcessingController } from './action-queue-processing.controller';
import {
  getActionsForEntity as filterActionsForEntity,
  getBlockedActions as selectBlockedActions,
  getPendingActionsForProject as filterPendingActionsForProject,
  hasDurablePendingTaskMutation as hasDurablePendingTaskMutationPure,
  hasUnscopedPendingProjectWrite,
  hasUncompletedCreate as hasUncompletedCreateAction,
} from './action-queue-query.helpers';
import { ActionQueueDurableEnqueueController } from './action-queue-durable-enqueue.controller';
import {
  ActionQueueOwnerStorageLoadController,
  ActionQueueRetrySupersessionController,
  type ActionQueueOwnerStorageLoadRecord,
} from './action-queue-retry-supersession.controller';
import { warnIfActionQueueFrozen } from './action-queue-frozen-warning.helpers';
import { ActionQueueFrozenPersistenceController } from './action-queue-frozen-persistence.controller';
import { ActionQueuePendingViewController } from './action-queue-pending-view.controller';
import { ActionQueueRuntimeSideEffectsController } from './action-queue-runtime-side-effects.helpers';
import {
  ActionQueueDurableRemovalController,
  type AttachmentReplayActionSettlementInput,
  type AttachmentReplayActionSettlementResult,
  type ExactCurrentProjectDeleteSettlementResult,
} from './action-queue-durable-removal.controller';
import {
  ActionQueueHeldActionController,
  type HeldActionReceipt,
  type HeldActionLocalHandoffSeed,
  type LocalHandoffIdentity,
  type LocalHandoffQueueMutationResult,
  type LocalHandoffTransitionInput,
} from './action-queue-held-action.controller';
import { createActionQueueOwnerReloadController } from './action-queue-owner-reload.controller';
import { localBackupUiRestoreWriterQuiescence } from './local-backup-ui-restore-writer-quiescence.service';
import { LocalBackupUiRestorePreActionQueueFenceService } from './local-backup-ui-restore-pre-actionqueue-fence.service';
import {
  QueuedAction,
  EnqueueParams,
  DeadLetterItem
} from './action-queue.types';

export type { ActionQueueProcessorResult, DeferredActionQueueRetry, FailedActionQueueRetry } from './action-queue-public.types';
export type { OperationPriority, ActionPayload, ProjectPayload, ProjectDeletePayload, ConnectionPayload, TaskPayload, TaskDeletePayload, PreferencePayload, QueuedAction, EnqueueParams, DeadLetterItem } from './action-queue-public.types';

export type ActionQueueProjectPendingWriteState = 'pending' | 'clear' | 'unknown';

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
  private readonly injector = inject(Injector);
  /** 迁移期 export-only/read-only 部署的可选云端写入闸门。 */
  private readonly writeGuard = inject(WriteGuardService, { optional: true });
  readonly storage = inject(ActionQueueStorageService);
  private readonly enqueueMutations = inject(ActionQueueEnqueueMutationService);
  private readonly syncWriterLeaseGate = inject(ActionQueueSyncWriterLeaseService);
  private readonly queueBackup = inject(QueueBackupService);
  private readonly queueViewState = inject(ActionQueueViewStateService);
  private readonly preActionQueueFence = inject(LocalBackupUiRestorePreActionQueueFenceService);
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
  private readonly durableRemoval = new ActionQueueDurableRemovalController({
    getPendingActions: () => this.pendingActions(),
    setPendingActions: queue => this.pendingView.setQueue(queue),
    filterPendingActions: predicate => this.pendingView.filterQueue(predicate),
    mapPendingActions: mapper => this.pendingView.mapQueue(mapper),
    saveQueueToStorage: () => this.storage.saveQueueToStorage(),
    persistQueueMutationForOwner: (ownerUserId, updater) =>
      this.storage.persistQueueMutationForOwner(ownerUserId, updater),
    persistQueueMutationStrictlyForOwner: (ownerUserId, updater) =>
      this.storage.persistQueueMutationStrictlyForOwner(ownerUserId, updater),
    updateQueueBackupStrictlyForOwner: (ownerUserId, updater) =>
      this.queueBackup.updateQueueStrictly(ownerUserId, updater),
    settleProjectDeleteSuccessForOwner: (ownerUserId, projectId, actionId) =>
      this.storage.settleProjectDeleteSuccessForOwner(ownerUserId, projectId, actionId),
    getCurrentOwnerUserId: () => this.getCurrentOwnerUserId(),
    isQueueViewCurrent: (generation, ownerUserId) =>
      this.isQueueViewCurrent(generation, ownerUserId),
    isStaleProcess: generation => this.queueViewState.isStaleProcess(generation),
    getStaleProcessPolicy: (generation, ownerUserId) =>
      this.queueViewState.getStaleProcessPolicy(generation, ownerUserId),
    applyPersistedCurrentOwnerQueue: queue => this.applyPersistedCurrentOwnerQueue(queue),
    syncSentryContext: () => this.runtimeSideEffects.syncSentryContext(),
    warn: (message, context) => this.logger.warn(message, context),
    warnSafely: (message, context) => this.warnSafely(message, context),
    traceQueueTransitionReason: event => pushStartupTrace(event.source, { reason: event.reason }),
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
  private readonly processingController: ActionQueueProcessingController = new ActionQueueProcessingController({
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
    createPersistenceFence: (owner, generation, signal) =>
      this.retrySupersession.createPersistenceFence(owner, generation, signal),
    settleRetrySupersession: (action, ownerUserId, generation, signal) =>
      this.retrySupersession.settleBeforeProcessing(action, ownerUserId, generation, signal),
    transitionToSyncing: (action, owner, signal, isCurrent) =>
      this.durableRemoval.transitionExactActionToSyncingForOwner(owner, action, signal, isCurrent),
    getLastQueueTransitionReason: () => this.durableRemoval.getLastQueueTransitionReason(),
    settleSuccessfulAction: (action, owner, signal, isCurrent) =>
      this.durableRemoval.settleExactProcessedActionForOwner(owner, action, signal, isCurrent),
  });
  private readonly frozenPersistence = new ActionQueueFrozenPersistenceController({
    isQueueFrozen: () => this.storage.queueFrozen(),
    saveQueueToStorage: () => this.storage.saveQueueToStorage(),
  });
  private readonly ownerStorageLoad = new ActionQueueOwnerStorageLoadController({
    getCurrentOwnerUserId: () => this.getCurrentOwnerUserId(),
    warn: (message, context) => this.warnSafely(message, context),
  });
  private readonly ownerReload = createActionQueueOwnerReloadController({
    ownerStorageLoad: this.ownerStorageLoad,
    preActionQueueFence: this.preActionQueueFence,
    storage: this.storage,
    retryQueue: this.retryQueue,
    createRetryBridge: () => this.retrySupersession.createRetryQueueBridge(),
    warn: (message, context) => this.warnSafely(message, context),
  });
  /** 单条 durable enqueue 流水线（持久化确认 → 视图应用 → 副作用）委托给非 DI 控制器 */
  private readonly durableEnqueue = new ActionQueueDurableEnqueueController({
    warnIfQueueFrozen: action => this.warnIfQueueFrozen(action),
    createQueuedAction: action => this.enqueueMutations.createQueuedAction(action),
    getCurrentOwnerUserId: () => this.getCurrentOwnerUserId(),
    persistQueueMutationForOwner: (ownerUserId, mutateQueue) =>
      this.storage.persistQueueMutationForOwner(ownerUserId, mutateQueue),
    persistQueueMutationWithRetrySupersession: (ownerUserId, mutateQueue, getIds, persist) =>
      this.retrySupersession.persistMutation({
        ownerUserId, mutateQueue, getCandidateActionIds: getIds, persistWithoutSupersession: persist,
      }),
    buildCurrentOwnerEnqueueMutation: (queue, action, queuedAction) =>
      this.enqueueMutations.buildCurrentOwnerEnqueueMutation(queue, action, queuedAction),
    applyPersistedCurrentOwnerQueue: persistedQueue =>
      this.applyPersistedCurrentOwnerQueue(persistedQueue),
    runEnqueueSideEffects: input => this.runtimeSideEffects.runEnqueueSideEffects(input),
    isOnline: () => this.storage.isOnline,
    scheduleProcessQueue: () => this.scheduleProcessQueue(),
    warn: (message, context) => this.logger.warn(message, context),
  });
  private readonly retrySupersession: ActionQueueRetrySupersessionController = new ActionQueueRetrySupersessionController({
    isRetrySupersessionSupported: () =>
      typeof this.retryQueue.inspectActionQueueSupersessionTargets === 'function'
      && typeof this.retryQueue.reserveActionQueueSupersession === 'function'
      && typeof this.retryQueue.settleActionQueueSupersessions === 'function',
    getCurrentOwnerUserId: () => this.getCurrentOwnerUserId(),
    getQueueGeneration: () => this.queueViewState.currentQueueViewGeneration,
    getSessionGeneration: () => this.resolveUserSession()?.getCurrentSessionGeneration() ?? -1,
    captureAuthFence: () => this.authService.captureAuthIdentityFence(),
    isQueueContextCurrent: (ownerUserId, generation) => this.isQueueViewCurrent(generation, ownerUserId),
    isSessionContextCurrent: (generation, ownerUserId) =>
      this.resolveUserSession()?.isSessionContextCurrent(generation, ownerUserId) === true,
    isOwnerStorageLoaded: ownerUserId => this.isOwnerStorageLoaded(ownerUserId),
    acquireWriterLease: ownerUserId => this.syncWriterLeaseGate.acquire(ownerUserId),
    borrowActiveWriterLease: ownerUserId => this.processingController.borrowActiveWriterLease(ownerUserId),
    restoreQueueSnapshot: ownerUserId => this.queueBackup.restoreQueueSnapshot?.(ownerUserId)
      ?? this.queueBackup.restoreQueue(ownerUserId).then(actions => ({
        recordFound: actions !== null,
        actions: actions ?? [],
        savedAt: null,
      })),
    persistQueueMutationStrictlyForOwner: (ownerUserId, updater) =>
      this.storage.persistQueueMutationStrictlyForOwner(ownerUserId, updater),
    inspectRetryTargets: (action, ownerUserId, signal) =>
      this.retryQueue.inspectActionQueueSupersessionTargets?.(action, ownerUserId, signal)
        ?? { status: 'ready', retryItems: [] },
    reserveRetrySupersession: (reservation, signal) =>
      this.retryQueue.reserveActionQueueSupersession(reservation, signal),
    settleRetrySupersessions: (action, signal) =>
      this.retryQueue.settleActionQueueSupersessions(action, signal),
    applyPersistedCurrentOwnerQueue: queue => this.applyPersistedCurrentOwnerQueue(queue),
    warn: (message, context) => this.warnSafely(message, { context }),
  });
  private readonly heldEnqueue = new ActionQueueHeldActionController({
    createQueuedAction: action => this.enqueueMutations.createQueuedAction(action),
    getCurrentOwnerUserId: () => this.getCurrentOwnerUserId(),
    persistQueueMutationStrictlyForOwner: (ownerUserId, updater) =>
      this.storage.persistQueueMutationStrictlyForOwner(ownerUserId, updater),
    buildCurrentOwnerEnqueueMutation: (queue, action, queuedAction) =>
      this.enqueueMutations.buildCurrentOwnerEnqueueMutation(queue, action, queuedAction),
    buildForeignOwnerEnqueueMutation: (queue, action, queuedAction, ownerUserId) =>
      this.enqueueMutations.buildForeignOwnerEnqueueMutation(
        queue,
        action,
        queuedAction,
        ownerUserId,
      ),
    applyPersistedCurrentOwnerQueue: queue => this.applyPersistedCurrentOwnerQueue(queue),
  });
  private readonly durableEnqueueRuntime: ActionQueueDurableEnqueueRuntime = {
    getCurrentOwnerUserId: () => this.getCurrentOwnerUserId(),
    enqueueCurrent: (action, autoProcess) => this.durableEnqueue.enqueueDurably(action, autoProcess),
    enqueueManyCurrent: actions => this.enqueueManyDurably(actions),
    enqueueForOwner: (ownerUserId, action) => this.enqueueDurablyForOwner(ownerUserId, action),
    warnIfQueueFrozen: action => this.warnIfQueueFrozen(action),
    persistQueueMutationForOwner: (ownerUserId, updater) =>
      this.storage.persistQueueMutationForOwner(ownerUserId, updater),
    persistQueueMutationWithRetrySupersession: (ownerUserId, mutateQueue, getIds, persist) =>
      this.retrySupersession.persistMutation({
        ownerUserId, mutateQueue, getCandidateActionIds: getIds, persistWithoutSupersession: persist,
      }),
    applyPersistedCurrentOwnerQueue: queue => this.applyPersistedCurrentOwnerQueue(queue),
    completeDurableEnqueueSideEffects: (action, queuedAction, resolvedActionId, removeRetrySourceOnSuccess) =>
      this.runtimeSideEffects.runEnqueueSideEffects({
        action, queuedAction, resolvedActionId, removeRetrySourceOnSuccess,
      }),
    isOnline: () => this.storage.isOnline,
    processQueue: () => this.processQueue(),
    info: (message, context) => this.logger.info(message, context),
    warn: (message, context) => this.logger.warn(message, context),
  };

  constructor() {
    this.storage.init({
      dequeue: (id) => this.dequeue(id),
      syncSentryContext: () => this.runtimeSideEffects.syncSentryContext(),
      processQueue: () => this.processQueue(),
      pendingActions: this.pendingActions,
      queueSize: this.queueSize,
      canPersistCurrentOwner: () => this.isOwnerStorageLoaded(this.getCurrentOwnerUserId()),
      captureCurrentOwnerStorageFence: () =>
        this.ownerStorageLoad.captureLoadedFence(this.getCurrentOwnerUserId()),
    });

    this.destroyRef.onDestroy(() => this.storage.removeNetworkListeners());
  }

  private warnSafely(message: string, context?: Record<string, unknown>): void {
    try {
      this.logger.warn(message, context);
    } catch {
      // Observability failures must not break queue state recovery.
    }
  }

  private requireOwnerStorageLoaded(ownerUserId: string): void {
    if (ownerUserId === this.getCurrentOwnerUserId() && !this.isOwnerStorageLoaded(ownerUserId)) {
      throw new Error('ActionQueue owner storage is unknown');
    }
  }
  private runOwnerMutationSync<T>(owner: string, operation: () => T): T { this.requireOwnerStorageLoaded(owner); return localBackupUiRestoreWriterQuiescence.runSync(owner, 'action-queue', () => { this.requireOwnerStorageLoaded(owner); return operation(); }); }
  private async runOwnerMutationAsync<T>(owner: string, operation: () => T | Promise<T>): Promise<T> { this.requireOwnerStorageLoaded(owner); return localBackupUiRestoreWriterQuiescence.runAsync(owner, 'action-queue', async () => { this.requireOwnerStorageLoaded(owner); return operation(); }); }
  private runOwnerMutationContinuationSync<T>(owner: string, operation: () => T): T { this.requireOwnerStorageLoaded(owner); return localBackupUiRestoreWriterQuiescence.runContinuationSync(owner, 'action-queue', () => { this.requireOwnerStorageLoaded(owner); return operation(); }); }

  // ========== 公共方法 ==========
  
  /**
   * 注册操作处理器
   */
  registerProcessor(type: string, processor: QueueProcessor) {
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
    return this.runOwnerMutationSync(this.getCurrentOwnerUserId(), () => this.enqueueInternal(action, true, true));
  }

  async enqueueDurably(action: EnqueueParams): Promise<string> {
    return this.runOwnerMutationAsync(this.getCurrentOwnerUserId(), () => this.durableEnqueue.enqueueDurably(action, true));
  }

  async enqueueManyDurably(actions: EnqueueParams[]): Promise<string[]> { return this.runOwnerMutationAsync(this.getCurrentOwnerUserId(), () =>
    this.enqueueMutations.enqueueManyDurably(actions, this.durableEnqueueRuntime)); }

  private applyPersistedCurrentOwnerQueue(persistedQueue: QueuedAction[]): void {
    this.pendingView.setQueue(persistedQueue);
    this.runtimeSideEffects.syncSentryContext();
  }

  async enqueueDurablyForOwner(ownerUserId: string, action: EnqueueParams): Promise<string> { return this.runOwnerMutationAsync(ownerUserId, () =>
    this.enqueueMutations.enqueueDurablyForOwner(ownerUserId, action, this.durableEnqueueRuntime)); }

  enqueueHeldDurablyForOwner(
    ownerUserId: string,
    action: EnqueueParams,
    localHandoff?: HeldActionLocalHandoffSeed,
  ): Promise<HeldActionReceipt | null> {
    return this.runOwnerMutationAsync(
      ownerUserId,
      () => this.heldEnqueue.enqueueHeldDurablyForOwner(ownerUserId, action, localHandoff),
    );
  }

  transitionLocalHandoffStrictlyForOwner(
    input: LocalHandoffTransitionInput,
  ): Promise<LocalHandoffQueueMutationResult> {
    return this.runOwnerMutationAsync(
      input.ownerUserId,
      () => this.heldEnqueue.transitionLocalHandoffStrictlyForOwner(input),
    );
  }

  removeCompletedLocalHandoffStrictlyForOwner(
    input: LocalHandoffIdentity,
  ): Promise<LocalHandoffQueueMutationResult> {
    return this.runOwnerMutationAsync(
      input.ownerUserId,
      () => this.heldEnqueue.removeCompletedLocalHandoffStrictlyForOwner(input),
    );
  }

  activateLocalHandoffStrictlyForOwner(
    input: LocalHandoffIdentity,
  ): Promise<LocalHandoffQueueMutationResult> {
    return this.runOwnerMutationAsync(
      input.ownerUserId,
      () => this.heldEnqueue.activateLocalHandoffStrictlyForOwner(input),
    );
  }

  async enqueueManyDurablyForOwner(ownerUserId: string, actions: EnqueueParams[]): Promise<string[]> { return this.runOwnerMutationAsync(ownerUserId, () =>
    this.enqueueMutations.enqueueManyDurablyForOwner(ownerUserId, actions, this.durableEnqueueRuntime)); }

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

  /**
   * 从队列中移除操作
   */
  dequeue(actionId: string) {
    return this.runOwnerMutationSync(this.getCurrentOwnerUserId(), () => this.durableRemoval.dequeue(actionId));
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

  subscribeToQueueSettled(listener: () => void): () => void {
    return this.lifecycle.subscribeToSettled(listener);
  }

  subscribeToOwnerStorageLoadStateChanges(listener: () => void): () => void {
    return this.ownerStorageLoad.subscribe(listener);
  }

  getCurrentOwnerStorageLoadState(): ActionQueueOwnerStorageLoadRecord['state'] {
    return this.ownerStorageLoad.currentState();
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

  private resolveUserSession(): UserSessionService | null {
    return this.injector.get(UserSessionService, null);
  }

  private markCurrentOwnerStorageLoadUnknown(): void {
    this.ownerStorageLoad.markCurrentOwnerUnknown();
  }

  private isOwnerStorageLoaded(ownerUserId: string): boolean {
    return this.ownerStorageLoad.isLoaded(ownerUserId);
  }

  private releaseAllQueueProcessLifecycles(reason: string): void {
    if (!this.lifecycle.releaseAll()) {
      return;
    }

    this.logger.debug('强制释放旧队列处理生命周期', { reason });
  }

  private invalidateQueueView(
    reason: string,
    stalePolicy: QueueStalePolicy = 'discard',
    ownerUserId: string | null = null,
  ): number {
    return this.queueViewState.invalidateQueueView(reason, stalePolicy, ownerUserId);
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
    return await this.runOwnerMutationAsync(ownerUserId, () => this.durableRemoval.settleProjectDeleteSuccessForOwner(
      ownerUserId,
      projectId,
      actionId,
    ));
  }

  async settleExactCurrentProjectDeleteSuccess(
    ownerUserId: string, projectId: string, actionId: string, operationId: string,
  ): Promise<ExactCurrentProjectDeleteSettlementResult> {
    return await this.runOwnerMutationAsync(ownerUserId, () =>
      this.durableRemoval.settleExactCurrentProjectDeleteSuccess(
        ownerUserId, projectId, actionId, operationId,
      ));
  }
  settleAttachmentReplayActionForOwner(
    ownerUserId: string,
    input: AttachmentReplayActionSettlementInput,
  ): Promise<AttachmentReplayActionSettlementResult> {
    return this.runOwnerMutationAsync(
      ownerUserId,
      () => this.durableRemoval.settleAttachmentReplayActionForOwner(ownerUserId, input),
    );
  }
  /**
   * 处理队列中的所有操作
   * 
   * 【依赖顺序控制】
   * Create 操作必须在对应实体的 Update/Delete 操作之前成功
   */
  async processQueue(): Promise<ActionQueueProcessResult> {
    return this.runOwnerMutationAsync(this.getCurrentOwnerUserId(), () => this.processingController.processQueue());
  }

  /** 清空队列 */
  clearQueue() {
    return this.runOwnerMutationSync(this.getCurrentOwnerUserId(), () => this.clearQueueForOwnerScope('clear-queue', this.getCurrentOwnerUserId()));
  }

  /** full wipe 专用：使所有 owner 的旧处理循环进入 discard。 */
  clearQueueForFullWipe(): void {
    return this.runOwnerMutationSync(this.getCurrentOwnerUserId(), () => this.clearQueueForOwnerScope('clear-queue-full-wipe', null));
  }

  private clearQueueForOwnerScope(reason: string, ownerUserId: string | null): void {
    this.invalidateQueueView(reason, 'discard', ownerUserId);
    this.releaseAllQueueProcessLifecycles(reason);
    this.clearPendingQueueView();
    this.storage.saveQueueToStorage();
    this.runtimeSideEffects.syncSentryContext();
  }
  
  /** 清空死信队列 */
  clearDeadLetterQueue() { return this.runOwnerMutationSync(this.getCurrentOwnerUserId(), () => this.storage.clearDeadLetterQueue()); }

  /**
   * 仅清空当前内存视图，不覆盖持久化数据。
   * 用于切账号时先断开旧 owner 的可见队列，再按新 owner 重新加载。
   */
  clearCurrentView(): void { return localBackupUiRestoreWriterQuiescence.runSync(this.getCurrentOwnerUserId(), 'action-queue', () => {
    this.invalidateQueueView('clear-current-view', 'settle-owner');
    this.releaseAllQueueProcessLifecycles('clear-current-view');
    this.clearPendingQueueView();
    this.markCurrentOwnerStorageLoadUnknown();
    this.storage.deadLetterQueue.set([]);
    this.storage.deadLetterSize.set(0);
    this.runtimeSideEffects.syncSentryContext();
  }); }

  /** 按当前 owner 重新加载持久化队列，避免跨账号会话看到旧队列/死信。 */
  reloadFromStorageForCurrentOwner(): Promise<void> {
    return this.ownerReload.reload();
  }
  
  /** 从死信队列重试操作 */
  retryDeadLetter(itemId: string): Promise<boolean> {
    return this.runOwnerMutationAsync(this.getCurrentOwnerUserId(), () => this.storage.retryDeadLetter(itemId));
  }
  
  /** 从死信队列删除操作（放弃同步） */
  dismissDeadLetter(itemId: string) { return this.runOwnerMutationSync(this.getCurrentOwnerUserId(), () => this.storage.dismissDeadLetter(itemId)); }

  /** 将待处理操作直接转入死信队列，保留数据供人工确认或稍后重试 */
  moveToDeadLetter(action: QueuedAction, reason: string): void {
    return this.runOwnerMutationContinuationSync(this.getCurrentOwnerUserId(), () => this.storage.moveToDeadLetter(action, reason));
  }
  
  getActionsForEntity(entityType: string, entityId: string): QueuedAction[] {
    return filterActionsForEntity(this.pendingActions(), entityType, entityId);
  }

  /** 获取特定项目的所有待处理操作。 */
  getPendingActionsForProject(projectId: string): QueuedAction[] {
    return filterPendingActionsForProject(this.pendingActions(), projectId);
  }

  getProjectPendingWriteState(
    projectId: string,
    ownerUserId: string,
  ): ActionQueueProjectPendingWriteState {
    if (ownerUserId !== this.getCurrentOwnerUserId()) {
      return 'unknown';
    }
    if (this.getPendingActionsForProject(projectId).length > 0) {
      return 'pending';
    }
    if (hasUnscopedPendingProjectWrite(this.pendingActions())) return 'unknown';
    return this.isOwnerStorageLoaded(ownerUserId) ? 'clear' : 'unknown';
  }

  hasDurablePendingTaskMutation(projectId: string, taskId: string): boolean {
    return hasDurablePendingTaskMutationPure(
      this.pendingActions(), projectId, taskId, (type, id) => this.retryQueue.hasEntity(type, id),
    );
  }

  /** 检查是否有待处理的操作 */
  hasPendingActions(): boolean {
    return this.pendingActions().length > 0;
  }

  /** 丢弃满足条件的待处理操作，并立即持久化队列 */
  discardActions(predicate: (action: QueuedAction) => boolean): number {
    return this.runOwnerMutationSync(this.getCurrentOwnerUserId(), () => this.durableRemoval.discardActions(predicate));
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
  reset(): void { return localBackupUiRestoreWriterQuiescence.runSync(this.getCurrentOwnerUserId(), 'action-queue', () => {
    this.invalidateQueueView('reset', 'discard');
    this.releaseAllQueueProcessLifecycles('reset');
    this.storage.reset();
    
    this.clearPendingQueueView();
    this.markCurrentOwnerStorageLoadUnknown();
    this.runtimeSideEffects.syncSentryContext();
    
    this.processorRegistry.clearProcessors();
    this.lifecycle.clearCallbacks();
  }); }

  private clearPendingQueueView(): void {
    this.pendingView.resetQueueView();
  }
}
