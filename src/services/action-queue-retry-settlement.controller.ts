import {
  classifyQueueRetryError,
  LOCAL_QUEUE_CONFIG,
  resolveQueueRetryDelay,
  type QueueRetryError,
} from './action-queue-storage.helpers';
import {
  describeDeferredRetryReason,
  formatRetryError,
  normalizeRetryError,
  resolveDeferredRetryDelay,
} from './action-queue-retry-serialization';
import {
  createFailedActionSettlement,
  type FailedActionSettlement,
} from './action-queue-owner-storage-failed-settlement.helpers';
import type { DeadLetterItem, QueuedAction } from './action-queue.types';

export type ActionQueueDurableRetrySettlementResult =
  | 'retry'
  | 'dead-letter'
  | 'missing'
  | 'persistence-failed';

interface ActionQueueRetrySettlementLogger {
  debug(message: string, context?: unknown): void;
  info(message: string, context?: unknown): void;
  warn(message: string, context?: unknown): void;
  error(message: string, context?: unknown): void;
}

interface ActionQueueRetrySettlementToast {
  error(title: string, message: string): void;
}

export interface ActionQueueRetrySettlementControllerOptions {
  logger: ActionQueueRetrySettlementLogger;
  toast: ActionQueueRetrySettlementToast;
  updatePendingActions: (updater: (queue: QueuedAction[]) => QueuedAction[]) => void;
  saveQueueToStorage: () => void;
  moveToDeadLetter: (action: QueuedAction, reason: string) => void;
  scheduleRetry: (delay: number) => void;
  getActionLabel: (action: QueuedAction) => string;
  getCurrentOwnerUserId: () => string;
  persistQueueMutationForOwner: (
    ownerUserId: string,
    updater: (queue: QueuedAction[]) => QueuedAction[],
  ) => Promise<QueuedAction[] | null>;
  applyPersistedQueue: (queue: QueuedAction[]) => void;
  stageDeadLetter: (action: QueuedAction, reason: string) => DeadLetterItem | null;
  notifyDeadLetterMoved: (item: DeadLetterItem, reason: string) => void;
  failClosed: (reason: string) => void;
}

/**
 * 队列重试裁决控制器 — 从 ActionQueueStorageService 拆分
 *
 * 职责：按错误分类裁决失败操作的去向（重试 / 延后重试 / 死信），
 * durable 变体额外收口当前 owner 的主 Outbox 持久化。
 * 非 DI 协作类：由 ActionQueueStorageService 构造并注入运行时闭包，
 * 行为由 action-queue-storage.service.spec.ts 的 handleRetry 用例覆盖。
 */
export class ActionQueueRetrySettlementController {
  constructor(private readonly options: ActionQueueRetrySettlementControllerOptions) {}

  /**
   * 处理重试逻辑
   * 根据错误分类决定：重试 or 移入死信队列
   */
  handleRetry(action: QueuedAction, error: string | QueueRetryError): 'retry' | 'dead-letter' {
    const normalizedError = normalizeRetryError(error);
    const errorMessage = formatRetryError(normalizedError);
    const errorType = classifyQueueRetryError(normalizedError);

    if (errorType === 'business' || errorType === 'permission') {
      return this.handlePermanentRetryFailure(action, errorType, errorMessage);
    }

    if (errorType === 'deferred') {
      return this.handleDeferredRetry(action, normalizedError, errorMessage);
    }

    if (action.retryCount >= LOCAL_QUEUE_CONFIG.MAX_RETRIES) {
      return this.handleRetryBudgetExhausted(action, errorMessage);
    }

    this.options.updatePendingActions(queue =>
      queue.map(a => a.id === action.id
        ? { ...a, retryCount: a.retryCount + 1, lastError: errorMessage, errorType, syncState: 'retry_scheduled' }
        : a
      )
    );
    this.options.saveQueueToStorage();

    const delay = resolveQueueRetryDelay(errorType, action.retryCount);
    this.options.logger.debug(`调度重试`, {
      actionId: action.id, errorType,
      retryCount: action.retryCount + 1, delay: `${delay}ms`
    });

    this.options.scheduleRetry(delay);
    return 'retry';
  }

  async handleRetryDurably(
    action: QueuedAction,
    error: string | QueueRetryError,
  ): Promise<ActionQueueDurableRetrySettlementResult> {
    const ownerUserId = this.options.getCurrentOwnerUserId();
    const normalizedError = normalizeRetryError(error);
    const state: { action?: QueuedAction; settlement?: FailedActionSettlement } = {};
    const persistedQueue = await this.persistMutationSafely(
      ownerUserId,
      queue => queue.map(item => {
        if (!this.matchesTarget(item, action)) return item;
        state.action = item;
        state.settlement = createFailedActionSettlement(item, normalizedError);
        return state.settlement.shouldDeadLetter
          ? item
          : this.buildRetryAction(item, state.settlement);
      }),
    );
    if (persistedQueue === null) return 'persistence-failed';
    if (!state.action || !state.settlement) return 'missing';

    if (state.settlement.shouldDeadLetter) {
      return this.settleTerminalDurably(ownerUserId, state.action, state.settlement);
    }

    if (this.applyPersistedQueueIfCurrent(ownerUserId, persistedQueue)) {
      this.schedulePersistedRetry(state.action, state.settlement, normalizedError);
    }
    return 'retry';
  }

  private async settleTerminalDurably(
    ownerUserId: string,
    action: QueuedAction,
    settlement: FailedActionSettlement,
  ): Promise<ActionQueueDurableRetrySettlementResult> {
    if (this.options.getCurrentOwnerUserId() !== ownerUserId) return 'missing';

    const reason = this.buildTerminalReason(settlement);
    const deadLetterItem = this.options.stageDeadLetter({
      ...action,
      lastError: settlement.errorMessage,
      errorType: settlement.errorType,
    }, reason);
    if (!deadLetterItem) {
      this.options.failClosed('storage_failure');
      return 'persistence-failed';
    }

    let removed = false;
    const persistedQueue = await this.persistMutationSafely(ownerUserId, queue => queue.filter(item => {
      const matches = this.matchesTarget(item, action);
      removed ||= matches;
      return !matches;
    }));
    if (persistedQueue === null) return 'persistence-failed';
    if (!removed) return 'missing';

    if (this.applyPersistedQueueIfCurrent(ownerUserId, persistedQueue)) {
      this.options.notifyDeadLetterMoved(deadLetterItem, reason);
      if (settlement.errorType !== 'business' && settlement.errorType !== 'permission' && action.priority === 'critical') {
        this.options.toast.error('重要操作失败', `${this.options.getActionLabel(action)} 失败，请检查网络后重试`);
      }
    }
    return 'dead-letter';
  }

  private async persistMutationSafely(
    ownerUserId: string,
    updater: (queue: QueuedAction[]) => QueuedAction[],
  ): Promise<QueuedAction[] | null> {
    let persistedQueue: QueuedAction[] | null = null;
    try {
      persistedQueue = await this.options.persistQueueMutationForOwner(ownerUserId, updater);
      if (persistedQueue === null) this.options.failClosed('storage_failure');
    } catch (error) {
      this.options.failClosed('storage_failure');
      this.options.logger.warn('ActionQueue durable 失败结算持久化异常', { ownerUserId, error });
    }
    return persistedQueue;
  }

  private matchesTarget(item: QueuedAction, target: QueuedAction): boolean {
    return item.id === target.id && item.operationId === target.operationId;
  }

  private buildRetryAction(action: QueuedAction, settlement: FailedActionSettlement): QueuedAction {
    return {
      ...action,
      retryCount: settlement.errorType === 'deferred' ? action.retryCount : action.retryCount + 1,
      lastError: settlement.errorMessage,
      errorType: settlement.errorType,
      syncState: settlement.syncState,
    };
  }

  private applyPersistedQueueIfCurrent(ownerUserId: string, queue: QueuedAction[]): boolean {
    if (this.options.getCurrentOwnerUserId() !== ownerUserId) return false;
    this.options.applyPersistedQueue(queue);
    return true;
  }

  private schedulePersistedRetry(
    action: QueuedAction,
    settlement: FailedActionSettlement,
    normalizedError: QueueRetryError,
  ): void {
    const delay = settlement.errorType === 'deferred'
      ? resolveDeferredRetryDelay(normalizedError)
      : resolveQueueRetryDelay(settlement.errorType, action.retryCount);
    this.options.scheduleRetry(delay);
  }

  private buildTerminalReason(settlement: FailedActionSettlement): string {
    if (settlement.errorType === 'business' || settlement.errorType === 'permission') {
      const label = settlement.errorType === 'business' ? '业务' : '权限';
      return `${label}错误: ${settlement.errorMessage}`;
    }
    return `超过最大重试次数 (${LOCAL_QUEUE_CONFIG.MAX_RETRIES}): ${settlement.errorMessage}`;
  }

  private handlePermanentRetryFailure(
    action: QueuedAction,
    errorType: 'business' | 'permission',
    errorMessage: string,
  ): 'dead-letter' {
    this.options.logger.warn(`${errorType === 'business' ? '业务' : '权限'}错误，不可重试`, {
      actionId: action.id,
      error: errorMessage,
    });
    this.options.moveToDeadLetter(action, `${errorType === 'business' ? '业务' : '权限'}错误: ${errorMessage}`);
    return 'dead-letter';
  }

  private handleDeferredRetry(
    action: QueuedAction,
    normalizedError: QueueRetryError,
    errorMessage: string,
  ): 'retry' {
    const delay = resolveDeferredRetryDelay(normalizedError);
    const errorType = 'deferred';
    const deferredReason = describeDeferredRetryReason(normalizedError);
    const syncState = deferredReason === 'auth-pending' ? 'blocked_by_auth' : 'retry_scheduled';
    this.options.updatePendingActions(queue =>
      queue.map(a => a.id === action.id
        ? { ...a, lastError: errorMessage, errorType, syncState }
        : a
      )
    );
    this.options.saveQueueToStorage();

    this.options.logger.info('延后队列重试且不消耗 retry budget', {
      actionId: action.id,
      type: action.type,
      entityType: action.entityType,
      entityId: action.entityId,
      deferredReason,
      delay,
    });
    this.options.scheduleRetry(delay);
    return 'retry';
  }

  private handleRetryBudgetExhausted(action: QueuedAction, errorMessage: string): 'dead-letter' {
    this.options.logger.error('超过最大重试次数，移入死信队列', {
      actionId: action.id, type: action.type,
      entityType: action.entityType, entityId: action.entityId, error: errorMessage
    });
    this.options.moveToDeadLetter(action, `超过最大重试次数 (${LOCAL_QUEUE_CONFIG.MAX_RETRIES}): ${errorMessage}`);

    if (action.priority === 'critical') {
      this.options.toast.error('重要操作失败', `${this.options.getActionLabel(action)} 失败，请检查网络后重试`);
    }
    return 'dead-letter';
  }
}
