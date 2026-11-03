/**
 * ActionQueueStorageService — 操作队列存储与辅助服务
 *
 * 职责：
 * - localStorage / IndexedDB 持久化
 * - 死信队列管理（signals + CRUD）
 * - 错误分类与重试调度
 * - 网络状态监听
 *
 * 从 ActionQueueService 拆分，降低单文件复杂度
 */
import { Injectable, inject, signal, WritableSignal } from '@angular/core';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { NetworkAwarenessService } from './network-awareness.service';
import { DeadLetterItem, OutboxSyncState, QueuedAction } from './action-queue.types';
import { ActionQueueOwnerStorageService } from './action-queue-owner-storage.service';
import type { QueueBackupStrictUpdateResult } from './queue-backup.service';
import { trackLocalBackupUiRestoreWriterPromise } from './local-backup-ui-restore-writer-quiescence-tracker';
import { localBackupUiRestoreWriterQuiescence } from './local-backup-ui-restore-writer-quiescence.service';
import { ActionQueueRestoreBarrierController, type ActionQueueRestoreBarrierRelease, type OwnerStorageRestoreOutcome } from './action-queue-restore-barrier.controller';
import type { ActionQueueOwnerStorageRuntime } from './action-queue-owner-storage.types';
import {
  haveSameActionQueueOwnerStorageState,
  type ActionQueueOwnerStorageStagedState,
  type ActionQueueOwnerStorageStageResult,
} from './action-queue-owner-storage-load.helpers';
import {
  ActionQueueSchedulerService,
  type ActionQueueSchedulerRuntime,
} from './action-queue-scheduler.service';
import { pushStartupTrace } from '../utils/startup-trace';
import {
  appendCappedDeadLetterItem,
  buildFailedOwnerDeadLetterReason,
  classifyQueueRetryError,
  getActionDescription as getActionDescriptionPure,
  getActionLabel as getActionLabelPure,
  LOCAL_QUEUE_CONFIG,
  resolveQueueRetryDelay,
  type QueueRetryError,
  type QueueRetryErrorClassification,
} from './action-queue-storage.helpers';
import {
  resolveBrowserSuspensionDelay as resolveBrowserSuspensionDelayPure,
} from './action-queue-retry-serialization';
import { ActionQueueDeadLetterNotifier } from './action-queue-dead-letter-notifier';
import {
  buildActionQueueEscapeExportJson,
  downloadActionQueueEscapeExport,
} from './action-queue-escape-export.helpers';
import { ActionQueueFrozenRetryController } from './action-queue-frozen-retry.controller';
import { ActionQueueRetrySettlementController, type ActionQueueDurableRetrySettlementResult } from './action-queue-retry-settlement.controller';
import { buildDeadLetterRetryAction, upsertDeadLetterRetryAction } from './action-queue-storage-dead-letter-transition.helpers';
import { createSyncOperationId } from '../utils/sync-operation-id';
import {
  handleQueuedActionRetryDurably,
  markQueuedActionSyncState,
  stageQueuedActionDeadLetter,
  type ActionQueueProcessingMutationRuntime,
} from './action-queue-processing.helpers';
import { ActionQueueExactOwnerMutationController, type ActionQueueExactOwnerMutationResult } from './action-queue-retry-supersession.controller';
export {
  appendCappedDeadLetterItem,
  buildFailedOwnerDeadLetterReason,
  classifyQueueRetryError,
  LOCAL_QUEUE_CONFIG,
  resolveQueueRetryDelay,
};
export type { QueueRetryError };
/**
 * 操作队列上下文 — 由 ActionQueueService 在初始化时提供
 * 避免循环依赖：storage 不注入 ActionQueueService
 */
export interface ActionQueueContext {
  dequeue: (id: string) => void;
  syncSentryContext: () => void;
  processQueue: () => Promise<unknown>;
  pendingActions: WritableSignal<QueuedAction[]>;
  queueSize: WritableSignal<number>;
  canPersistCurrentOwner?: () => boolean;
  captureCurrentOwnerStorageFence?: () => (() => boolean) | null;
}

@Injectable({ providedIn: 'root' })
export class ActionQueueStorageService {
  private readonly logger = inject(LoggerService).category('ActionQueueStorage');
  private readonly toast = inject(ToastService);
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly networkAwareness = inject(NetworkAwarenessService);
  private readonly ownerStorage = inject(ActionQueueOwnerStorageService);
  private readonly scheduler = inject(ActionQueueSchedulerService);
  private readonly deadLetterNotifier = new ActionQueueDeadLetterNotifier({
    logger: this.logger,
    toast: this.toast,
    sentryLazyLoader: this.sentryLazyLoader,
    getFailureCallbacks: () => this.failureCallbacks,
    getDeadLetterQueue: () => this.deadLetterQueue(),
    getActionDescription: (action) => this.getActionDescription(action),
  });

  // ========== 死信队列 ==========
  readonly deadLetterQueue = signal<DeadLetterItem[]>([]);
  readonly deadLetterSize = signal(0);

  // ========== 存储失败状态 ==========
  readonly storageFailure = signal(false);
  readonly queueFrozen = signal(false);
  readonly queueFreezeReason = signal<string | null>(null);
  private storageFailureCallback: ((data: { queue: QueuedAction[]; deadLetter: DeadLetterItem[] }) => void) | null = null;

  // ========== 网络状态 ==========
  private _isOnline = true;
  get isOnline(): boolean { return this._isOnline; }
  set isOnline(v: boolean) { this._isOnline = v; }

  // ========== 失败回调 ==========
  private failureCallbacks: Array<(item: DeadLetterItem) => void> = [];

  private queueRestoreGeneration = 0;
  private deadLetterRestoreGeneration = 0;
  private readonly restoreBarrier = new ActionQueueRestoreBarrierController();
  private readonly exactOwnerMutation = new ActionQueueExactOwnerMutationController({
    getCurrentOwnerUserId: () => this.getCurrentOwnerUserId(),
    captureCurrentOwnerStorageFence: () => this.captureCurrentOwnerStorageFence(),
    persistQueueMutationForOwner: (ownerUserId, updater) =>
      this.ownerStorage.persistQueueMutationForOwner(ownerUserId, updater, this.ownerStorageRuntime()),
    publishCurrentOwnerQueue: queue => {
      this.ctx.pendingActions.set(queue); this.ctx.queueSize.set(queue.length);
      this.syncSentryContextSafely('persist-owner-queue', { ownerUserId: this.getCurrentOwnerUserId() });
    },
  });
  private readonly frozenRetry = new ActionQueueFrozenRetryController({
    logger: this.logger,
    toast: this.toast,
    isQueueFrozen: () => this.queueFrozen(),
    saveQueueToStorage: () => this.saveQueueToStorage(),
  });
  /** 重试裁决逻辑（错误分类 → 重试/延后/死信）委托给非 DI 控制器 */
  private readonly retrySettlement = new ActionQueueRetrySettlementController({
    logger: this.logger,
    toast: this.toast,
    updatePendingActions: (updater) => this.ctx.pendingActions.update(updater),
    saveQueueToStorage: () => this.saveQueueToStorage(),
    moveToDeadLetter: (action, reason) => this.moveToDeadLetter(action, reason),
    scheduleRetry: (delay) => this.scheduleRetry(delay),
    getActionLabel: (action) => this.getActionLabel(action),
    getCurrentOwnerUserId: () => this.getCurrentOwnerUserId(),
    persistQueueMutationForOwner: (ownerUserId, updater) => this.persistQueueMutationForOwner(ownerUserId, updater),
    applyPersistedQueue: queue => {
      this.ctx.pendingActions.set(queue); this.ctx.queueSize.set(queue.length); this.ctx.syncSentryContext();
    },
    stageDeadLetter: (action, reason) => this.stageDeadLetter(action, reason),
    notifyDeadLetterMoved: (item, reason) => this.deadLetterNotifier.handleDeadLetterMoved(item, reason),
    failClosed: reason => this.freezeQueueWrites(reason),
  });
  private readonly processingMutations: ActionQueueProcessingMutationRuntime = {
    updatePendingActions: updater => this.ctx.pendingActions.update(updater),
    getDeadLetters: () => this.deadLetterQueue(),
    updateDeadLetters: updater => this.deadLetterQueue.update(updater),
    setDeadLetterSize: size => this.deadLetterSize.set(size),
    saveQueue: () => this.saveQueueToStorage(),
    saveDeadLetters: () => this.saveDeadLetterToStorage(),
    syncSentryContext: () => this.ctx.syncSentryContext(),
    getCurrentOwnerUserId: () => this.getCurrentOwnerUserId(),
    persistQueueMutationForOwner: (ownerUserId, updater) =>
      this.persistQueueMutationForOwner(ownerUserId, updater),
    settleRetry: (action, error) => this.retrySettlement.handleRetryDurably(action, error),
    freezeQueueWrites: () => this.freezeQueueWrites('storage_failure'),
    warn: (message, context) => this.logger.warn(message, context),
    warnSafely: (message, context) => this.warnSafely(message, context),
  };
  // ========== 来自主服务的上下文引用 ==========
  private _ctx: ActionQueueContext | null = null;
  /** 安全访问上下文，未初始化时抛出明确错误而非 undefined 崩溃 */
  private get ctx(): ActionQueueContext {
    if (!this._ctx) {
      throw new Error('[ActionQueueStorage] ctx 未初始化，请确保 ActionQueueService 已完成构造');
    }
    return this._ctx;
  }
  /**
   * 初始化上下文引用（由 ActionQueueService 构造时调用）
   */
  init(ctx: ActionQueueContext): void {
    this._ctx = ctx;
  }

  // ========== 回调注册 ==========

  /** 注册失败通知回调，返回取消订阅函数 */
  onFailure(callback: (item: DeadLetterItem) => void): () => void {
    this.failureCallbacks.push(callback);
    return () => {
      const idx = this.failureCallbacks.indexOf(callback);
      if (idx >= 0) this.failureCallbacks.splice(idx, 1);
    };
  }

  /** 注册存储失败回调（逃生模式） */
  onStorageFailure(callback: (data: { queue: QueuedAction[]; deadLetter: DeadLetterItem[] }) => void): void {
    this.storageFailureCallback = callback;
  }

  private ownerStorageRuntime(): ActionQueueOwnerStorageRuntime {
    return {
      pendingActions: () => this.ctx.pendingActions(),
      setPendingActions: (queue) => this.ctx.pendingActions.set(queue),
      setQueueSize: (size) => this.ctx.queueSize.set(size),
      deadLetterQueue: () => this.deadLetterQueue(),
      setDeadLetterQueue: (queue) => this.deadLetterQueue.set(queue),
      setDeadLetterSize: (size) => this.deadLetterSize.set(size),
      syncSentryContext: () => this.ctx.syncSentryContext(),
      freezeQueueWrites: (reason) => this.freezeQueueWrites(reason),
      clearQueueFreeze: () => this.clearQueueFreeze(),
      triggerStorageFailureEscapeMode: () => this.triggerStorageFailureEscapeMode(),
      saveQueueToStorage: () => this.saveQueueToStorage(),
      requestQueueProcessing: (reason) => this.requestQueueProcessing(reason),
    };
  }

  private schedulerRuntime(): ActionQueueSchedulerRuntime {
    return {
      isOnline: () => this._isOnline,
      setOnline: (online) => { this._isOnline = online; },
      processQueue: () => this.ctx.processQueue(),
      scheduleRetry: (delay) => this.scheduleRetry(delay),
      clearRetryTimer: () => this.clearRetryTimer(),
    };
  }

  private getCurrentOwnerUserId(): string {
    return this.ownerStorage.getCurrentOwnerUserId();
  }

  private canPersistCurrentOwner(): boolean {
    return this.ctx.canPersistCurrentOwner?.() ?? true;
  }

  private captureCurrentOwnerStorageFence(): (() => boolean) | null {
    const capture = this.ctx.captureCurrentOwnerStorageFence;
    return capture ? capture() : this.canPersistCurrentOwner()
      ? () => this.canPersistCurrentOwner() : null;
  }

  private warnSafely(message: string, ...args: unknown[]): void {
    try {
      this.logger.warn(message, ...args);
    } catch {
      // Observability failures must not break durable queue state transitions.
    }
  }

  async persistQueueSnapshotForOwner(ownerUserId: string, queue: QueuedAction[]): Promise<boolean> {
    if (ownerUserId === this.getCurrentOwnerUserId() && !this.canPersistCurrentOwner()) return false;
    return this.ownerStorage.persistQueueSnapshotForOwner(
      ownerUserId,
      queue,
      this.ownerStorageRuntime(),
    );
  }

  async persistQueueMutationForOwner(
    ownerUserId: string,
    updater: (queue: QueuedAction[]) => QueuedAction[],
  ): Promise<QueuedAction[] | null> {
    return this.exactOwnerMutation.persistLegacy(ownerUserId, updater);
  }

  persistExactQueueMutationForOwner(
    ownerUserId: string,
    updater: (queue: QueuedAction[]) => QueuedAction[],
  ): Promise<ActionQueueExactOwnerMutationResult> {
    return this.exactOwnerMutation.persistExact(ownerUserId, updater);
  }

  persistQueueMutationStrictlyForOwner(
    ownerUserId: string,
    updater: (queue: QueuedAction[]) => QueuedAction[],
  ): Promise<QueueBackupStrictUpdateResult> {
    if (ownerUserId === this.getCurrentOwnerUserId() && !this.canPersistCurrentOwner()) return Promise.resolve({ status: 'storage-failed' });
    return this.ownerStorage.persistQueueMutationStrictlyForOwner(
      ownerUserId,
      updater,
      this.ownerStorageRuntime(),
    );
  }

  async settleSuccessfulActionForOwner(ownerUserId: string, actionId: string): Promise<boolean> {
    return this.ownerStorage.settleSuccessfulActionForOwner(
      ownerUserId,
      actionId,
      this.ownerStorageRuntime(),
    );
  }

  async loadQueueSnapshotForOwner(ownerUserId: string): Promise<QueuedAction[]> {
    return this.ownerStorage.loadQueueSnapshotForOwner(ownerUserId, this.ownerStorageRuntime());
  }

  stageCurrentOwnerStorage(
    generation: number,
    ownerUserId: string,
    getCurrentGeneration: () => number,
  ): Promise<ActionQueueOwnerStorageStageResult> {
    return this.ownerStorage.stageCurrentOwnerStorage(
      generation,
      ownerUserId,
      getCurrentGeneration,
    );
  }

  captureCurrentOwnerStorageState(): ActionQueueOwnerStorageStagedState {
    return {
      queue: this.ctx.pendingActions(),
      queueSize: this.ctx.queueSize(),
      deadLetters: this.deadLetterQueue(),
      deadLetterSize: this.deadLetterSize(),
      queueFrozen: this.queueFrozen(),
      queueFreezeReason: this.queueFreezeReason(),
    };
  }

  publishCurrentOwnerStorageState(state: ActionQueueOwnerStorageStagedState): void {
    this.ctx.pendingActions.set(state.queue as QueuedAction[]);
    this.ctx.queueSize.set(state.queueSize);
    this.deadLetterQueue.set(state.deadLetters as DeadLetterItem[]);
    this.deadLetterSize.set(state.deadLetterSize);
    this.queueFrozen.set(state.queueFrozen);
    this.queueFreezeReason.set(state.queueFreezeReason);
  }

  currentOwnerStorageStateMatches(state: ActionQueueOwnerStorageStagedState): boolean {
    return haveSameActionQueueOwnerStorageState(state, this.captureCurrentOwnerStorageState());
  }

  async settleProjectDeleteSuccessForOwner(
    ownerUserId: string,
    projectId: string,
    actionId?: string,
  ): Promise<number> {
    return this.ownerStorage.settleProjectDeleteSuccessForOwner(
      ownerUserId,
      projectId,
      actionId,
      this.ownerStorageRuntime(),
    );
  }

  async settleFailedActionForOwner(
    ownerUserId: string,
    action: QueuedAction,
    error: string | QueueRetryError
  ): Promise<'retry' | 'dead-letter' | 'missing'> {
    return this.ownerStorage.settleFailedActionForOwner(
      ownerUserId,
      action,
      error,
      this.ownerStorageRuntime(),
    );
  }

  async appendActionForOwner(ownerUserId: string, action: QueuedAction): Promise<void> {
    await this.ownerStorage.appendActionForOwner(
      ownerUserId,
      action,
      this.ownerStorageRuntime(),
    );
  }

  restoreDeadLettersFromBackupItems(items: unknown[], ownerUserId: string): number {
    if (ownerUserId === this.getCurrentOwnerUserId() && !this.canPersistCurrentOwner()) return 0;
    return this.ownerStorage.restoreDeadLettersFromBackupItems(
      ownerUserId,
      items,
      this.ownerStorageRuntime(),
    );
  }

  // ========== 死信队列公共操作 ==========

  clearDeadLetterQueue(): void {
    this.deadLetterQueue.set([]);
    this.deadLetterSize.set(0);
    this.saveDeadLetterMutationSafely('clear-dead-letter-queue');
    this.syncSentryContextSafely('clear-dead-letter-queue');
  }

  async retryDeadLetter(itemId: string): Promise<boolean> {
    const item = this.deadLetterQueue().find(d => d.action.id === itemId);
    if (!item) return false;

    const resetAction = buildDeadLetterRetryAction(item.action, createSyncOperationId);

    const ownerUserId = this.getCurrentOwnerUserId();
    const persistedQueue = await this.persistQueueMutationForOwner(
      ownerUserId,
      queue => upsertDeadLetterRetryAction(queue, resetAction),
    );
    if (persistedQueue === null) {
      this.warnSafely('死信重试未能持久化到 pending 队列，保留 dead-letter 条目', {
        actionId: itemId,
        ownerUserId,
      });
      return false;
    }

    // pending 已可靠持久化后再从死信移除；若后续死信保存失败，最多产生重复可恢复记录，不会丢操作。
    this.ctx.pendingActions.set(persistedQueue);
    this.ctx.queueSize.set(persistedQueue.length);
    this.deadLetterQueue.update(q => q.filter(d => d.action.id !== itemId));
    this.deadLetterSize.set(this.deadLetterQueue().length);
    this.saveDeadLetterAfterRetry(itemId, ownerUserId);
    this.syncSentryContextAfterDeadLetterRetry(itemId, ownerUserId);
    this.triggerDeadLetterRetryProcessing(itemId, ownerUserId);
    return true;
  }

  private saveDeadLetterAfterRetry(itemId: string, ownerUserId: string): void {
    this.saveDeadLetterMutationSafely('retry-dead-letter', {
      actionId: itemId,
      ownerUserId,
    });
  }

  private saveDeadLetterMutationSafely(operation: string, metadata: Record<string, unknown> = {}): void {
    try {
      if (this.saveDeadLetterToStorage()) {
        return;
      }
      this.warnSafely('死信队列持久化失败，已保留当前内存状态等待后续恢复', {
        operation,
        ...metadata,
      });
    } catch (error) {
      this.warnSafely('死信队列持久化异常，已保留当前内存状态等待后续恢复', {
        operation,
        ...metadata,
        error,
      });
    }
  }

  private syncSentryContextAfterDeadLetterRetry(itemId: string, ownerUserId: string): void {
    this.syncSentryContextSafely('retry-dead-letter', {
      actionId: itemId,
      ownerUserId,
    });
  }

  private syncSentryContextSafely(operation: string, metadata: Record<string, unknown> = {}): void {
    try {
      this.ctx.syncSentryContext();
    } catch (error) {
      this.warnSafely('死信队列 Sentry 上下文同步失败，已保留队列状态', {
        operation,
        ...metadata,
        error,
      });
    }
  }

  private triggerDeadLetterRetryProcessing(itemId: string, ownerUserId: string): void {
    if (!this._isOnline) {
      return;
    }
    try {
      void this.ctx.processQueue().catch(error => {
        this.warnSafely('死信重试后台处理失败，已保留 pending 队列等待后续触发', {
          actionId: itemId,
          ownerUserId,
          error,
        });
      });
    } catch (error) {
      this.warnSafely('死信重试后台处理触发失败，已保留 pending 队列等待后续触发', {
        actionId: itemId,
        ownerUserId,
        error,
      });
    }
  }

  dismissDeadLetter(itemId: string): void {
    this.deadLetterQueue.update(q => q.filter(d => d.action.id !== itemId));
    this.deadLetterSize.set(this.deadLetterQueue().length);
    this.saveDeadLetterMutationSafely('dismiss-dead-letter', { actionId: itemId });
    this.syncSentryContextSafely('dismiss-dead-letter', { actionId: itemId });
  }

  hasDeadLetters(): boolean {
    return this.deadLetterQueue().length > 0;
  }

  markActionSyncState(actionId: string, syncState: OutboxSyncState): QueuedAction | null {
    return markQueuedActionSyncState(actionId, syncState, this.processingMutations);
  }

  // ========== 死信队列内部操作 ==========

  /**
   * 移动操作到死信队列
   * 按优先级策略：low 静默丢弃，normal 正常入队，critical 通知用户
   */
  moveToDeadLetter(action: QueuedAction, reason: string): void {
    const deadLetterItem = this.stageDeadLetter(action, reason);
    if (!deadLetterItem) return;

    this.ctx.dequeue(action.id);
    this.deadLetterNotifier.handleDeadLetterMoved(deadLetterItem, reason);
  }

  private stageDeadLetter(action: QueuedAction, reason: string): DeadLetterItem | null {
    return stageQueuedActionDeadLetter(action, reason, this.processingMutations);
  }

  /**
   * 暂停依赖于失败 Create 的操作
   */
  pauseDependentActions(entityType: string, entityId: string, queue: QueuedAction[]): void {
    this.deadLetterNotifier.pauseDependentActions(entityType, entityId, queue);
  }

  // ========== 重试逻辑 ==========

  /**
   * 处理重试逻辑
   * 根据错误分类决定：重试 or 移入死信队列
   */
  handleRetry(action: QueuedAction, error: string | QueueRetryError): 'retry' | 'dead-letter' {
    return this.retrySettlement.handleRetry(action, error);
  }

  async handleRetryDurably(action: QueuedAction, error: string | QueueRetryError):
    Promise<ActionQueueDurableRetrySettlementResult> {
    return handleQueuedActionRetryDurably(action, error, this.processingMutations);
  }

  // ========== 错误分类（纯函数） ==========

  classifyError(error: string | QueueRetryError): QueueRetryErrorClassification {
    return classifyQueueRetryError(error);
  }

  private resolveBrowserSuspensionDelay(error?: QueueRetryError): number {
    return resolveBrowserSuspensionDelayPure(error);
  }

  getActionDescription(action: QueuedAction): string {
    return getActionDescriptionPure(action);
  }

  getActionLabel(action: QueuedAction): string {
    return getActionLabelPure(action);
  }

  // ========== 网络管理 ==========

  setupNetworkListeners(): void {
    this.scheduler.setupNetworkListeners(this.schedulerRuntime());
  }

  removeNetworkListeners(): void {
    this.scheduler.removeNetworkListeners();
  }

  // ========== 重试调度 ==========

  shouldDeferQueueProcessing(): boolean {
    return this.scheduler.shouldDeferQueueProcessing();
  }

  requestQueueProcessing(reason: string): void {
    pushStartupTrace('action_queue.storage_request', { reason });
    this.debugSafely('ActionQueue storage request', { reason });
    if (this.restoreBarrier.deferProcessing()) {
      pushStartupTrace('action_queue.storage_decision', { reason, decision: 'restore-barrier' });
      this.debugSafely('ActionQueue storage restore barrier', { reason, decision: 'deferred' });
      this.logger.debug('ActionQueue 恢复尚未完成，延后后台处理', { reason });
      return;
    }
    if (this.ctx.pendingActions().length === 0) {
      pushStartupTrace('action_queue.storage_decision', { reason, decision: 'empty' });
      this.debugSafely('ActionQueue storage empty suppression', {
        reason,
        decision: 'empty',
        pending: 0,
      });
      this.logger.debug('ActionQueue 为空，跳过后台处理', { reason });
      return;
    }
    pushStartupTrace('action_queue.storage_decision', {
      reason,
      decision: 'scheduler-forward',
      pending: this.ctx.pendingActions().length,
    });
    this.debugSafely('ActionQueue storage scheduler forward', {
      reason,
      decision: 'forward',
      pending: this.ctx.pendingActions().length,
    });
    this.scheduler.requestQueueProcessing(reason, this.schedulerRuntime());
  }

  private debugSafely(message: string, context: Record<string, unknown>): void {
    try {
      this.logger.debug(message, context);
    } catch {
      // Queue processing must not depend on observability.
    }
  }


  scheduleDeferredQueueProcessing(reason: string, explicitDelay?: number): void {
    const delay = explicitDelay ?? this.resolveBrowserSuspensionDelay();
    this.scheduler.scheduleDeferredQueueProcessing(reason, this.schedulerRuntime(), delay);
  }

  scheduleRetry(delay: number): void {
    this.scheduler.scheduleRetry(delay, () => this.requestQueueProcessing('retry-timer'));
  }

  clearRetryTimer(): void {
    this.scheduler.clearRetryTimer();
  }

  // ========== 存储操作 ==========

  /**
   * 保存队列到 localStorage
   * 处理 QuotaExceededError：尝试 IndexedDB 备份 → 逃生模式
   */
  saveQueueToStorage(): void {
    if (!this.canPersistCurrentOwner()) return;
    const save = () => {
      if (this.restoreBarrier.deferQueueSave()) {
        this.logger.debug('ActionQueue 恢复尚未完成，跳过 transient full-snapshot 写入');
        return;
      }
      this.ownerStorage.saveCurrentQueueToStorage(this.ownerStorageRuntime());
    };
    if (typeof localStorage === 'undefined') {
      save();
      return;
    }
    return localBackupUiRestoreWriterQuiescence.runSync(
      this.getCurrentOwnerUserId(), 'action-queue', save,
    );
  }

  /**
   * 从 localStorage 加载队列（含 IndexedDB 回退）
   */
  loadQueueFromStorage(): Promise<OwnerStorageRestoreOutcome> {
    const restoreOwnerUserId = this.getCurrentOwnerUserId();
    return trackLocalBackupUiRestoreWriterPromise(restoreOwnerUserId, 'action-queue', async () => {
      const restoreGeneration = ++this.queueRestoreGeneration;
      this.restoreBarrier.beginQueue(restoreGeneration);
      const outcome = await this.ownerStorage.loadCurrentQueueFromStorage(
        restoreGeneration,
        restoreOwnerUserId,
        () => this.queueRestoreGeneration,
        this.ownerStorageRuntime(),
      );
      this.finishQueueRestore(restoreGeneration, outcome);
      return outcome;
    });
  }

  private finishQueueRestore(restoreGeneration: number, outcome: OwnerStorageRestoreOutcome): void {
    this.applyRestoreBarrierRelease(this.restoreBarrier.finishQueue(restoreGeneration, outcome));
  }

  /** 保存死信队列到 localStorage */
  saveDeadLetterToStorage(): boolean {
    if (!this.canPersistCurrentOwner()) return false;
    const save = () => {
      if (this.restoreBarrier.deferDeadLetterSave()) {
        this.logger.debug('Dead-letter 恢复尚未完成，跳过 transient full-snapshot 写入');
        return false;
      }
      return this.ownerStorage.saveCurrentDeadLettersToStorage(this.ownerStorageRuntime());
    };
    return typeof localStorage === 'undefined'
      ? save()
      : localBackupUiRestoreWriterQuiescence.runSync(
          this.getCurrentOwnerUserId(), 'action-queue', save,
        );
  }

  /**
   * 从 localStorage 加载死信队列（含 TTL 清理）
   */
  loadDeadLetterFromStorage(): void {
    const restoreOwnerUserId = this.getCurrentOwnerUserId();
    void trackLocalBackupUiRestoreWriterPromise(restoreOwnerUserId, 'action-queue', async () => {
      const restoreGeneration = ++this.deadLetterRestoreGeneration;
      this.restoreBarrier.beginDeadLetters(restoreGeneration);
      const outcome = await this.ownerStorage.loadCurrentDeadLettersFromStorage(
        restoreGeneration,
        restoreOwnerUserId,
        () => this.deadLetterRestoreGeneration,
        this.ownerStorageRuntime(),
      );
      this.finishDeadLetterRestore(restoreGeneration, outcome);
    });
  }
  private finishDeadLetterRestore(restoreGeneration: number, outcome: OwnerStorageRestoreOutcome): void {
    this.applyRestoreBarrierRelease(this.restoreBarrier.finishDeadLetters(restoreGeneration, outcome));
  }

  private applyRestoreBarrierRelease(release: ActionQueueRestoreBarrierRelease): void {
    if (!this.canPersistCurrentOwner()) return;
    const runtime = this.ownerStorageRuntime();
    if (release.flushQueue) this.ownerStorage.saveCurrentQueueToStorage(runtime);
    if (release.flushDeadLetters) this.ownerStorage.saveCurrentDeadLettersToStorage(runtime);
    if (release.resumeProcessing) this.scheduler.requestQueueProcessing('owner-restore-ready', this.schedulerRuntime());
  }

  // ========== 存储失败逃生模式 ==========

  private triggerStorageFailureEscapeMode(): void {
    this.logger.error('【存储灾难】localStorage 和 IndexedDB 均不可用，进入逃生模式');
    this.storageFailure.set(true);
    this.freezeQueueWrites('storage_failure');
    this.toast.error(
      '🚨 存储失败 - 数据可能丢失',
      '浏览器存储不可用。请立即复制下方数据进行备份！',
      { duration: 0 }
    );

    if (this.storageFailureCallback) {
      try {
        this.storageFailureCallback({
          queue: this.ctx.pendingActions(),
          deadLetter: this.deadLetterQueue()
        });
      } catch (e) {
        this.logger.error('存储失败回调执行异常', e);
      }
    }
  }

  // ========== 状态重置 ==========

  /**
   * 冻结期定时重试落盘
   * 冻结后每 30s 重试一次 localStorage 写入，成功则自动解冻
   * 失败则指数退避（30s → 60s → 120s → max 5min），最多重试 10 次
   */
  startFrozenRetryTimer(): void {
    this.frozenRetry.start();
  }

  private stopFrozenRetryTimer(): void {
    this.frozenRetry.stop();
  }

  /**
   * 导出待同步操作为 JSON（逃生导出）
   * 用于队列冻结时用户手动下载备份
   */
  exportPendingActionsAsJson(): string {
    return buildActionQueueEscapeExportJson({
      pendingActions: this.ctx.pendingActions(),
      deadLetterQueue: this.deadLetterQueue(),
      frozenState: this.queueFrozen(),
      freezeReason: this.queueFreezeReason(),
    });
  }

  /**
   * 触发逃生导出下载
   */
  downloadEscapeExport(): void {
    try {
      downloadActionQueueEscapeExport(this.exportPendingActionsAsJson());
      this.toast.success('导出成功', '待同步数据已下载');
    } catch (e) {
      this.logger.error('逃生导出失败', e);
      this.toast.error('导出失败', '无法创建备份文件');
    }
  }

  reset(): void {
    this.queueRestoreGeneration += 1;
    this.deadLetterRestoreGeneration += 1;
    this.restoreBarrier.reset();
    this.removeNetworkListeners();
    this.clearRetryTimer();
    this.stopFrozenRetryTimer();
    this.deadLetterQueue.set([]);
    this.deadLetterSize.set(0);
    this.storageFailure.set(false);
    this.queueFrozen.set(false);
    this.queueFreezeReason.set(null);
    this.networkAwareness.setStoragePressure(false, null);
    this.failureCallbacks.length = 0;
    this.storageFailureCallback = null;
    this._isOnline = true;

  }

  private freezeQueueWrites(reason: string): void {
    this.queueFrozen.set(true);
    this.queueFreezeReason.set(reason);
    this.networkAwareness.setStoragePressure(true, reason);
    this.sentryLazyLoader.captureMessage('Action queue frozen', {
      level: 'warning',
      tags: { reason }
    });
    // 启动冻结期定时重试
    this.startFrozenRetryTimer();
  }

  private clearQueueFreeze(): void {
    if (!this.queueFrozen()) {
      return;
    }
    this.queueFrozen.set(false);
    this.queueFreezeReason.set(null);
    this.networkAwareness.setStoragePressure(false, null);
    this.stopFrozenRetryTimer();
  }
}
