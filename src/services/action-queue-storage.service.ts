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
import type { ActionQueueOwnerStorageRuntime } from './action-queue-owner-storage.types';
import {
  ActionQueueSchedulerService,
  type ActionQueueSchedulerRuntime,
} from './action-queue-scheduler.service';
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
  normalizeRetryError as normalizeRetryErrorPure,
  parseRetryErrorMessage as parseRetryErrorMessagePure,
  formatRetryError as formatRetryErrorPure,
  isBrowserSuspensionError as isBrowserSuspensionErrorPure,
  isPartialRetryHandoffError as isPartialRetryHandoffErrorPure,
  isAuthPendingRetryError as isAuthPendingRetryErrorPure,
  resolveDeferredRetryDelay as resolveDeferredRetryDelayPure,
  describeDeferredRetryReason as describeDeferredRetryReasonPure,
  resolveBrowserSuspensionDelay as resolveBrowserSuspensionDelayPure,
  type DeferredRetryReason,
} from './action-queue-retry-serialization';
import { ActionQueueDeadLetterNotifier } from './action-queue-dead-letter-notifier';
import {
  buildActionQueueEscapeExportJson,
  downloadActionQueueEscapeExport,
} from './action-queue-escape-export.helpers';
import { ActionQueueFrozenRetryController } from './action-queue-frozen-retry.controller';
import { createSyncOperationId, isSyncOperationId } from '../utils/sync-operation-id';
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
  private readonly frozenRetry = new ActionQueueFrozenRetryController({
    logger: this.logger,
    toast: this.toast,
    isQueueFrozen: () => this.queueFrozen(),
    saveQueueToStorage: () => this.saveQueueToStorage(),
  });

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

  private getScopedStorageKey(baseKey: string, ownerUserId = this.getCurrentOwnerUserId()): string {
    return this.ownerStorage.getScopedStorageKey(baseKey, ownerUserId);
  }

  private warnSafely(message: string, ...args: unknown[]): void {
    try {
      this.logger.warn(message, ...args);
    } catch {
      // Observability failures must not break durable queue state transitions.
    }
  }

  private invalidateLocalQueueSnapshot(ownerUserId = this.getCurrentOwnerUserId()): void {
    this.ownerStorage.invalidateLocalQueueSnapshot(ownerUserId);
  }

  private async loadPersistedQueueForOwner(ownerUserId: string): Promise<QueuedAction[]> {
    return this.ownerStorage.loadQueueSnapshotForOwner(ownerUserId, this.ownerStorageRuntime());
  }

  private async saveQueueSnapshotForOwner(ownerUserId: string, queue: QueuedAction[]): Promise<void> {
    const saved = await this.ownerStorage.persistQueueSnapshotForOwner(
      ownerUserId,
      queue,
      this.ownerStorageRuntime(),
    );
    if (!saved) {
      throw new Error(`owner-scoped 队列保存失败: ${ownerUserId}`);
    }
  }

  async persistQueueSnapshotForOwner(ownerUserId: string, queue: QueuedAction[]): Promise<boolean> {
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
    return this.ownerStorage.persistQueueMutationForOwner(
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
    return this.ownerStorage.restoreDeadLettersFromBackupItems(
      ownerUserId,
      items,
      this.ownerStorageRuntime(),
    );
  }

  private clearLegacyGlobalStorageIfLocalOwner(baseKey: string): void {
    this.ownerStorage.clearLegacyGlobalStorageIfLocalOwner(baseKey);
  }

  private loadScopedOrLegacyStorage(baseKey: string): string | null {
    return this.ownerStorage.loadScopedOrLegacyStorage(baseKey, this.ownerStorageRuntime());
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

    const resetAction: QueuedAction = {
      ...item.action,
      operationId: isSyncOperationId(item.action.operationId)
        ? item.action.operationId
        : createSyncOperationId(),
      retryCount: 0,
      lastError: undefined,
      errorType: undefined,
      syncState: 'pending_sync',
    };

    const ownerUserId = this.getCurrentOwnerUserId();
    const persistedQueue = await this.persistQueueMutationForOwner(
      ownerUserId,
      queue => [
        ...queue.filter(action => action.id !== resetAction.id),
        resetAction,
      ],
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
    let updatedAction: QueuedAction | null = null;

    this.ctx.pendingActions.update(queue => queue.map(action => {
      if (action.id !== actionId) return action;

      updatedAction = { ...action, syncState };
      return updatedAction;
    }));

    if (updatedAction) {
      this.saveQueueToStorage();
      this.ctx.syncSentryContext();
    }

    return updatedAction;
  }

  // ========== 死信队列内部操作 ==========

  /**
   * 移动操作到死信队列
   * 按优先级策略：low 静默丢弃，normal 正常入队，critical 通知用户
   */
  moveToDeadLetter(action: QueuedAction, reason: string): void {
    const deadLetterAction: QueuedAction = {
      ...action,
      syncState: 'dead_letter',
    };
    const deadLetterItem: DeadLetterItem = {
      action: deadLetterAction,
      failedAt: new Date().toISOString(),
      reason
    };

    this.deadLetterQueue.update(queue => {
      const result = appendCappedDeadLetterItem(queue, deadLetterItem);
      if (result.overflow > 0) {
        this.logger.warn('死信队列超出上限，移除最旧的条目', {
          overflow: result.overflow,
          maxSize: LOCAL_QUEUE_CONFIG.MAX_DEAD_LETTER_SIZE,
        });
      }
      return result.queue;
    });

    this.deadLetterSize.set(this.deadLetterQueue().length);
    const deadLetterPersisted = this.saveDeadLetterToStorage();
    this.ctx.syncSentryContext();
    if (!deadLetterPersisted) {
      this.logger.warn('死信队列持久化失败，保留 pending action 等待恢复重试', {
        actionId: action.id,
        reason,
      });
      return;
    }

    this.ctx.dequeue(action.id);
    this.deadLetterNotifier.handleDeadLetterMoved(deadLetterItem, reason);
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
    const normalizedError = this.normalizeRetryError(error);
    const errorMessage = this.formatRetryError(normalizedError);
    const errorType = this.classifyError(normalizedError);

    if (errorType === 'business' || errorType === 'permission') {
      return this.handlePermanentRetryFailure(action, errorType, errorMessage);
    }

    if (errorType === 'deferred') {
      return this.handleDeferredRetry(action, normalizedError, errorMessage);
    }

    if (action.retryCount >= LOCAL_QUEUE_CONFIG.MAX_RETRIES) {
      return this.handleRetryBudgetExhausted(action, errorMessage);
    }

    this.ctx.pendingActions.update(queue =>
      queue.map(a => a.id === action.id
        ? { ...a, retryCount: a.retryCount + 1, lastError: errorMessage, errorType, syncState: 'retry_scheduled' }
        : a
      )
    );
    this.saveQueueToStorage();

    const delay = resolveQueueRetryDelay(errorType, action.retryCount);
    this.logger.debug(`调度重试`, {
      actionId: action.id, errorType,
      retryCount: action.retryCount + 1, delay: `${delay}ms`
    });

    this.scheduleRetry(delay);
    return 'retry';
  }

  async handleRetryDurably(action: QueuedAction, error: string | QueueRetryError): Promise<'retry' | 'dead-letter'> {
    const result = this.handleRetry(action, error);
    await this.persistCurrentOwnerQueueSnapshot('handleRetryDurably');
    return result;
  }

  private async persistCurrentOwnerQueueSnapshot(reason: string): Promise<void> {
    const ownerUserId = this.getCurrentOwnerUserId();
    const saved = await this.ownerStorage.persistQueueSnapshotForOwner(
      ownerUserId,
      this.ctx.pendingActions(),
      this.ownerStorageRuntime(),
    );

    if (!saved) {
      this.logger.warn('当前 owner 主 Outbox 持久化收口失败', {
        ownerUserId,
        reason,
      });
    }
  }

  private handlePermanentRetryFailure(
    action: QueuedAction,
    errorType: 'business' | 'permission',
    errorMessage: string,
  ): 'dead-letter' {
    this.logger.warn(`${errorType === 'business' ? '业务' : '权限'}错误，不可重试`, {
      actionId: action.id,
      error: errorMessage,
    });
    this.moveToDeadLetter(action, `${errorType === 'business' ? '业务' : '权限'}错误: ${errorMessage}`);
    return 'dead-letter';
  }

  private handleDeferredRetry(
    action: QueuedAction,
    normalizedError: QueueRetryError,
    errorMessage: string,
  ): 'retry' {
    const delay = this.resolveDeferredRetryDelay(normalizedError);
    const errorType = 'deferred';
    const deferredReason = this.describeDeferredRetryReason(normalizedError);
    const syncState = deferredReason === 'auth-pending' ? 'blocked_by_auth' : 'retry_scheduled';
    this.ctx.pendingActions.update(queue =>
      queue.map(a => a.id === action.id
        ? { ...a, lastError: errorMessage, errorType, syncState }
        : a
      )
    );
    this.saveQueueToStorage();

    this.logger.info('延后队列重试且不消耗 retry budget', {
      actionId: action.id,
      type: action.type,
      entityType: action.entityType,
      entityId: action.entityId,
      deferredReason,
      delay,
    });
    this.scheduleRetry(delay);
    return 'retry';
  }

  private handleRetryBudgetExhausted(action: QueuedAction, errorMessage: string): 'dead-letter' {
    this.logger.error('超过最大重试次数，移入死信队列', {
      actionId: action.id, type: action.type,
      entityType: action.entityType, entityId: action.entityId, error: errorMessage
    });
    this.moveToDeadLetter(action, `超过最大重试次数 (${LOCAL_QUEUE_CONFIG.MAX_RETRIES}): ${errorMessage}`);

    if (action.priority === 'critical') {
      this.toast.error('重要操作失败', `${this.getActionLabel(action)} 失败，请检查网络后重试`);
    }
    return 'dead-letter';
  }

  // ========== 错误分类（纯函数） ==========

  classifyError(error: string | QueueRetryError): QueueRetryErrorClassification {
    return classifyQueueRetryError(error);
  }

  private normalizeRetryError(error: string | QueueRetryError): QueueRetryError {
    return normalizeRetryErrorPure(error);
  }

  private parseRetryErrorMessage(message: string): QueueRetryError {
    return parseRetryErrorMessagePure(message);
  }

  private formatRetryError(error: QueueRetryError): string {
    return formatRetryErrorPure(error);
  }

  private isBrowserSuspensionError(error: QueueRetryError): boolean {
    return isBrowserSuspensionErrorPure(error);
  }

  private isPartialRetryHandoffError(error: QueueRetryError): boolean {
    return isPartialRetryHandoffErrorPure(error);
  }

  private isAuthPendingRetryError(error: QueueRetryError): boolean {
    return isAuthPendingRetryErrorPure(error);
  }

  private resolveDeferredRetryDelay(error: QueueRetryError): number {
    return resolveDeferredRetryDelayPure(error);
  }

  private describeDeferredRetryReason(error: QueueRetryError): DeferredRetryReason {
    return describeDeferredRetryReasonPure(error);
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
    this.scheduler.requestQueueProcessing(reason, this.schedulerRuntime());
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
    this.ownerStorage.saveCurrentQueueToStorage(this.ownerStorageRuntime());
  }

  /**
   * 从 localStorage 加载队列（含 IndexedDB 回退）
   */
  loadQueueFromStorage(): void {
    const restoreGeneration = ++this.queueRestoreGeneration;
    const restoreOwnerUserId = this.getCurrentOwnerUserId();
    this.ownerStorage.loadCurrentQueueFromStorage(
      restoreGeneration,
      restoreOwnerUserId,
      () => this.queueRestoreGeneration,
      this.ownerStorageRuntime(),
    );
  }

  /** 保存死信队列到 localStorage */
  saveDeadLetterToStorage(): boolean {
    return this.ownerStorage.saveCurrentDeadLettersToStorage(this.ownerStorageRuntime());
  }

  /**
   * 从 localStorage 加载死信队列（含 TTL 清理）
   */
  loadDeadLetterFromStorage(): void {
    this.ownerStorage.loadCurrentDeadLettersFromStorage(this.ownerStorageRuntime());
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

    // 清除 localStorage 中的持久化数据
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.removeItem(LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY);
        localStorage.removeItem(LOCAL_QUEUE_CONFIG.DEAD_LETTER_STORAGE_KEY);
      } catch (e) {
        this.logger.warn('清除 localStorage 队列数据失败', { error: e });
      }
    }
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
    // 停止冻结期重试
    this.stopFrozenRetryTimer();
  }
}
