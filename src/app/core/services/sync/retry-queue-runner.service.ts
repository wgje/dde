import type { LeaseHandle } from '../../../../services/sync-writer-lease.service';
import { AUTH_CONFIG } from '../../../../config/auth.config';
import type { BlackBoxEntry } from '../../../../models';
import { isPermanentFailureError } from '../../../../utils/permanent-failure-error';
import {
  isBrowserNetworkSuspendedError,
  isBrowserNetworkSuspendedWindow,
} from '../../../../utils/browser-network-suspension';
import { isRetryDeferredError } from '../../../../utils/retry-deferred-error';
import {
  classifyRetryQueueAuthBoundaryError,
  classifyRetryQueueItemPreflight,
  classifyRetryAttempt,
  isRetryQueueServerPressureError,
  normalizeRetryQueueSliceBudget,
  shouldProcessRetryQueue,
  shouldRecoverStaleProcessingLock,
  type RetryQueueItemTerminalReason,
} from './retry-queue-processing';
import type {
  RetryOperationHandler,
  RetryQueueItem,
  RetryQueueItemProcessResult,
  RetryQueueSliceOptions,
  RetryQueueSliceResult,
  RetryQueueSliceRuntime,
} from './retry-queue.types';
import { RetryQueueCircuitLayer } from './retry-queue-circuit.service';
import { createRetryQueueSliceRuntime } from './retry-queue-slice-runtime.factory';
import { logRetryQueueTerminalPreflightRemoval } from './retry-queue-preflight-logging.helpers';
import { pushRetryQueueItem } from './retry-queue-item-dispatch.helpers';
import { persistTerminalRetryQueueRemoval } from './retry-queue-runner-apply-result.helpers';
import {
  createRetryQueueSliceCompletionSummary,
  createRetryQueueSliceResult,
  shouldStopRetryQueueSliceForBudget,
  waitForManualRetryQueueResumeWindow,
} from './retry-queue-runner-slice.helpers';

interface NormalizedQueueSliceOperationIds {
  itemsSnapshot: RetryQueueItem[];
  changed: boolean;
}

export abstract class RetryQueueRunnerLayer extends RetryQueueCircuitLayer {
  // ==================== 队列处理循环 ====================
  /** 启动重试循环 */
  startLoop(intervalMs: number): void {
    if (this.lifecycleClosed) {
      return;
    }
    this.stopLoop();
    this.retryLoopTimer = setInterval(() => {
      try {
        if (this.operationHandler?.isSessionExpired()) return;
        if (this.operationHandler?.isOnline() && this.queue.length > 0) {
          void this.processQueue().catch(error => {
            this.warn('RetryQueue 重试循环执行失败', error);
          });
        }
      } catch (error) {
        this.warn('RetryQueue 重试循环执行失败', error);
      }
    }, intervalMs);
  }
  /** 停止重试循环 */
  stopLoop(): void {
    if (this.retryLoopTimer !== null) {
      clearInterval(this.retryLoopTimer);
      this.retryLoopTimer = null;
    }
  }
  protected createSliceResult(startedAt: number, completed: boolean, processed = 0): RetryQueueSliceResult {
    return createRetryQueueSliceResult({
      startedAt,
      completed,
      processed,
      remaining: this.queue.length,
    });
  }
  protected async recoverStaleProcessingLock(
    options: RetryQueueSliceOptions,
    startedAt: number,
  ): Promise<RetryQueueSliceResult | null> {
    if (!this.tryReleaseStaleProcessingLock()) {
      // 锁未超时：交由调用方按阻塞原因决定 completed 语义（见 prepareQueueSlice）
      return null;
    }
    if (!this.operationHandler?.isOnline() || !this.checkCircuitBreaker()) {
      this.logger.info('锁释放后网络不可用或熔断器打开，跳过重试');
      return this.createSliceResult(startedAt, true);
    }
    if (!options._forcedRecovery) {
      return this.processQueueSlice({ ...options, _forcedRecovery: true });
    }
    this.logger.error('processQueueSlice: 强制恢复后仍超时，放弃本次处理', {
      queueLength: this.queue.length,
      elapsed: Date.now() - this.lastProcessTime,
      maxTimeout: this.PROCESS_TIMEOUT
    });
    return this.createSliceResult(startedAt, false);
  }
  protected async prepareQueueSlice(
    options: RetryQueueSliceOptions,
    startedAt: number,
    itemsSnapshot: RetryQueueItem[],
    wasProcessingQueue: boolean,
  ): Promise<RetryQueueSliceRuntime | RetryQueueSliceResult> {
    if (this.writeGuard && !this.writeGuard.assertWritable('RetryQueue.processQueueSlice')) {
      return this.createSliceResult(startedAt, true);
    }
    const { maxItems, maxDurationMs } = normalizeRetryQueueSliceBudget(options);
    const processDecision = shouldProcessRetryQueue({
      isProcessing: wasProcessingQueue,
      queueLength: this.queue.length,
      hasHandler: this.operationHandler !== null,
      isOnline: this.operationHandler?.isOnline() ?? false,
      sessionExpired: this.operationHandler?.isSessionExpired() ?? false,
      circuitBreakerReady: this.checkCircuitBreaker(),
    });
    if (!processDecision.allowed && processDecision.reason === 'offline-or-circuit-open') {
      this.releaseStaleProcessingLockIfNeeded();
      return this.createSliceResult(startedAt, true);
    }
    const suspendedWindowResult = this.skipQueueSliceForSuspendedWindow(options, startedAt);
    if (suspendedWindowResult) return suspendedWindowResult;
    if (!processDecision.allowed) {
      const staleLockRecovery = await this.recoverStaleProcessingLock(options, startedAt);
      if (staleLockRecovery) return staleLockRecovery;
      // 锁竞争（另一切片在途）必须按未完成上报，否则恢复续跑控制器会误判"队列已排空"而放弃排空
      return this.createSliceResult(startedAt, processDecision.reason !== 'already-processing');
    }
    const operationHandler = this.operationHandler;
    if (!operationHandler) {
      return this.createSliceResult(startedAt, true);
    }
    const runtime = await this.createPreparedQueueSliceRuntime(
      options,
      startedAt,
      itemsSnapshot,
      maxItems,
      maxDurationMs,
      operationHandler,
    );
    return runtime ?? this.createSliceResult(startedAt, false);
  }
  protected async createPreparedQueueSliceRuntime(
    options: RetryQueueSliceOptions,
    startedAt: number,
    itemsSnapshot: RetryQueueItem[],
    maxItems: number,
    maxDurationMs: number,
    operationHandler: RetryOperationHandler,
  ): Promise<RetryQueueSliceRuntime | null> {
    const normalized = this.normalizeQueueSliceOperationIds(itemsSnapshot);
    if (normalized.changed && !await this.persistNormalizedQueueSliceOperationIds()) {
      return null;
    }
    const leaseHandle = await this.acquireQueueSliceLease();
    if (leaseHandle === undefined) {
      return null;
    }
    if (this.lifecycleClosed) {
      if (leaseHandle) {
        await this.releaseQueueSliceLease(leaseHandle);
      }
      return null;
    }
    return createRetryQueueSliceRuntime({
      options,
      startedAt,
      generation: this.queueViewGeneration,
      itemsSnapshot: normalized.itemsSnapshot,
      maxItems,
      maxDurationMs,
      operationHandler,
      leaseHandle,
    });
  }
  private releaseStaleProcessingLockIfNeeded(): void {
    this.tryReleaseStaleProcessingLock();
  }
  private tryReleaseStaleProcessingLock(): boolean {
    if (!shouldRecoverStaleProcessingLock({
      isProcessing: this.isProcessingQueue,
      lastProcessTime: this.lastProcessTime,
      now: Date.now(),
      timeoutMs: this.PROCESS_TIMEOUT,
    })) {
      return false;
    }
    this.warn('processQueueSlice 处理锁超时，强制释放', {
      lastProcessTime: this.lastProcessTime,
      elapsed: Date.now() - this.lastProcessTime
    });
    this.isProcessingQueue = false;
    return true;
  }
  private skipQueueSliceForSuspendedWindow(
    options: RetryQueueSliceOptions,
    startedAt: number,
  ): RetryQueueSliceResult | null {
    if (!isBrowserNetworkSuspendedWindow() || options.allowWhileSuspended) {
      return null;
    }
    this.logger.debug('浏览器网络挂起窗口内暂停重试切片', {
      remainingCount: this.queue.length,
    });
    return this.createSliceResult(startedAt, false);
  }
  protected normalizeQueueSliceOperationIds(itemsSnapshot: RetryQueueItem[]): NormalizedQueueSliceOperationIds {
    let changed = false;
    const normalizedItemsSnapshot = itemsSnapshot.map(item => {
      const normalized = this.ensureLoadedItemOperationId(item);
      changed ||= normalized !== item;
      return normalized;
    });
    if (!changed) {
      return { itemsSnapshot: normalizedItemsSnapshot, changed: false };
    }
    const byId = new Map(normalizedItemsSnapshot.map(item => [item.id, item]));
    this.queue = this.queue.map(item => byId.get(item.id) ?? item);
    this.hiddenQueueItems = this.hiddenQueueItems.map(item => byId.get(item.id) ?? item);
    this.touchQueueState();
    return { itemsSnapshot: normalizedItemsSnapshot, changed: true };
  }
  private async persistNormalizedQueueSliceOperationIds(): Promise<boolean> {
    try {
      const persisted = await this.saveToStorageImmediate();
      if (!persisted) {
        this.warn('RetryQueue 切片重放前 operationId 修复未能持久化，暂停本轮重放');
      }
      return persisted;
    } catch (error) {
      this.warn('RetryQueue 切片重放前 operationId 修复持久化异常，暂停本轮重放', error);
      return false;
    }
  }
  protected async acquireQueueSliceLease(): Promise<LeaseHandle | null | undefined> {
    if (!this.isSyncWriterLeaseRequired()) {
      return null;
    }
    const leaseHandle = await this.acquireSyncWriterLease();
    return leaseHandle ?? undefined;
  }
  protected notifyQueueSliceSyncStart(runtime: RetryQueueSliceRuntime): void {
    if (runtime.hasNotifiedSyncStart) {
      return;
    }
    runtime.hasNotifiedSyncStart = true;
    this.lastDrainCompletedBySuccess = false;
    try {
      runtime.operationHandler.onProcessingStateChange(true, this.queue.length);
    } catch (error) {
      this.warn('onProcessingStateChange(true) 回调失败', error);
    }
  }
  protected async getValidQueueSliceItems(runtime: RetryQueueSliceRuntime): Promise<RetryQueueItem[]> {
    const sortedItems = [...runtime.itemsSnapshot].sort((a, b) => {
      const order: Record<string, number> = { project: 0, task: 1, connection: 2, blackbox: 3 };
      return order[a.type] - order[b.type];
    });
    const now = Date.now();
    const validItems: RetryQueueItem[] = [];
    for (const item of sortedItems) {
      // §5.6：过期项先落终态证据（隔离保留，不得静默删除）；证据持久化失败时保留待下轮重试
      if (now - item.createdAt <= this.MAX_ITEM_AGE) {
        validItems.push(item);
      } else if (await this.persistTerminalRetryEvidence(item, 'expired')) {
        runtime.expiredIds.add(item.id);
      }
    }
    if (runtime.expiredIds.size > 0) {
      this.queue = this.queue.filter(item => !runtime.expiredIds.has(item.id));
      this.touchQueueState();
      this.saveToStorage();
      runtime.hadTerminalRemoval = true;
      this.logger.info('清理过期队列项', { expiredCount: runtime.expiredIds.size });
    }
    return validItems;
  }
  protected shouldStopQueueSliceForBudget(runtime: RetryQueueSliceRuntime): boolean {
    return shouldStopRetryQueueSliceForBudget(runtime);
  }
  protected async processQueueSliceItems(runtime: RetryQueueSliceRuntime): Promise<void> {
    const validItems = await this.getValidQueueSliceItems(runtime);
    for (const item of validItems) {
      if (this.shouldStopQueueSliceForBudget(runtime)) {
        runtime.stoppedByBudget = true;
        break;
      }
      runtime.processedCount++;
      const result = await this.processQueueSliceItem(runtime, item);
      if (result === 'break') {
        break;
      }
    }
  }
  protected async processQueueSliceItem(
    runtime: RetryQueueSliceRuntime,
    item: RetryQueueItem,
  ): Promise<RetryQueueItemProcessResult> {
    const preflightResult = this.handleQueueSliceItemPreflight(runtime, item);
    if (preflightResult) {
      return preflightResult;
    }
    this.notifyQueueSliceSyncStart(runtime);
    const replay = await this.replayQueueSliceItem(runtime, item);
    if (replay === 'break' || replay === 'continue') {
      return replay;
    }
    if (runtime.operationHandler.isSessionExpired()) {
      this.logger.info('检测到会话过期，停止本轮重试切片，保留剩余项等待恢复后重放');
      return 'break';
    }
    return this.applyRetryAttemptResult(
      runtime,
      item,
      replay.success,
      replay.deferredByBrowserSuspension,
      replay.serverPressure,
    );
  }
  protected handleQueueSliceItemPreflight(
    runtime: RetryQueueSliceRuntime,
    item: RetryQueueItem,
  ): RetryQueueItemProcessResult | null {
    const preflightDecision = classifyRetryQueueItemPreflight({
      item,
      existsInQueue: this.queue.some(queueItem => queueItem.id === item.id),
      currentUserId: this.authService.currentUserId(),
      localModeUserId: AUTH_CONFIG.LOCAL_MODE_USER_ID,
      shouldSilentlyDropUnownedLegacyItem: this.shouldSilentlyDropUnownedLegacyRetryItem(),
    });
    if (preflightDecision.kind === 'missing-from-queue') {
      return 'continue';
    }
    if (this.hasCompletedRetryQueueOperation(item)) {
      this.logger.debug('RetryQueue 已有完成标记，跳过远端重放并清理本地残留', {
        type: item.type,
        queueItemId: item.id,
        dataId: item.data.id,
        operationId: item.operationId,
      });
      runtime.processedIds.add(item.id);
      return 'continue';
    }
    if (preflightDecision.kind === 'remove-terminal') {
      this.logTerminalPreflightRemoval(item, preflightDecision.reason);
      runtime.processedIds.add(item.id);
      runtime.hadTerminalRemoval = true;
      return 'continue';
    }
    if (preflightDecision.kind === 'quarantine') {
      if (!this.quarantineLegacyRetryItem(item, preflightDecision.reason)) {
        this.warn('RetryQueue 隔离证据持久化失败，保留队列项等待后续恢复', {
          queueItemId: item.id,
          type: item.type,
          dataId: item.data.id,
          reason: preflightDecision.reason,
        });
        runtime.stoppedByBudget = true;
        return 'break';
      }
      runtime.processedIds.add(item.id);
      runtime.hadTerminalRemoval = true;
      return 'continue';
    }
    return null;
  }
  protected logTerminalPreflightRemoval(item: RetryQueueItem, reason: RetryQueueItemTerminalReason): void {
    logRetryQueueTerminalPreflightRemoval(this.logger, item, reason);
  }
  protected async replayQueueSliceItem(
    runtime: RetryQueueSliceRuntime,
    item: RetryQueueItem,
  ): Promise<{
    success: boolean;
    deferredByBrowserSuspension: boolean;
    serverPressure: boolean;
  } | 'break' | 'continue'> {
    let success = false;
    let deferredByBrowserSuspension = false;
    let serverPressure = false;
    try {
      success = await pushRetryQueueItem(runtime.operationHandler, item);
    } catch (error) {
      const errorResult = await this.handleRetryQueueItemError(runtime, item, error);
      if (errorResult === 'break' || errorResult === 'continue') {
        return errorResult;
      }
      deferredByBrowserSuspension = errorResult === 'deferred-browser-suspension';
      serverPressure = errorResult === 'deferred-server-pressure';
    }
    return { success, deferredByBrowserSuspension, serverPressure };
  }
  protected async handleRetryQueueItemError(
    runtime: RetryQueueSliceRuntime,
    item: RetryQueueItem,
    error: unknown,
  ): Promise<'continue' | 'break' | 'deferred-browser-suspension' | 'deferred-server-pressure' | 'retry-failed'> {
    if (isPermanentFailureError(error)) {
      return await this.handlePermanentRetryQueueItemError(runtime, item, error);
    }
    if (isRetryDeferredError(error)) {
      this.logger.info('重试项受控延后，保留等待后续合并或恢复', {
        type: item.type,
        id: item.data.id,
      });
      return 'deferred-browser-suspension';
    }
    if (isBrowserNetworkSuspendedError(error) || isBrowserNetworkSuspendedWindow()) {
      this.logger.info('浏览器网络挂起，保留当前重试项等待恢复', {
        type: item.type,
        id: item.data.id,
      });
      return 'deferred-browser-suspension';
    }
    const authBoundary = classifyRetryQueueAuthBoundaryError(error);
    if (authBoundary.kind === 'pause') {
      this.logger.info('鉴权边界错误，停止本轮重试切片并保留队列项等待会话恢复', {
        type: item.type,
        id: item.data.id,
        reason: authBoundary.reason,
      });
      runtime.stoppedByBudget = true;
      return 'break';
    }
    if (isRetryQueueServerPressureError(error)) {
      return this.deferServerPressureRetry(item);
    }
    const errorType = (error as { errorType?: string })?.errorType
      || this.classifyErrorType(error as Error);
    this.recordCircuitFailure(errorType);
    this.logger.error('重试失败', error);
    if (!this.checkCircuitBreaker()) {
      this.warn('熔断器触发，停止本轮队列处理');
      return 'break';
    }
    return 'retry-failed';
  }
  protected deferServerPressureRetry(item: RetryQueueItem): 'deferred-server-pressure' {
    this.logger.info('服务端限流或暂时不可用，停止本轮重试切片并保留队列项等待后台退避', {
      type: item.type,
      id: item.data.id,
    });
    return 'deferred-server-pressure';
  }
  private async handlePermanentRetryQueueItemError(
    runtime: RetryQueueSliceRuntime,
    item: RetryQueueItem,
    error: unknown,
  ): Promise<RetryQueueItemProcessResult> {
    const errorMessage = (error as Error).message;
    this.warn('永久失败，从队列移除', { type: item.type, id: item.data.id, error: errorMessage });
    return await this.persistTerminalRemoval(
      runtime,
      item,
      'permanent-failure',
      'RetryQueue 永久失败终态证据持久化失败，保留队列项等待后续恢复',
      {
        queueItemId: item.id,
        type: item.type,
        dataId: item.data.id,
        error: errorMessage,
      },
    );
  }
  protected async applyRetryAttemptResult(
    runtime: RetryQueueSliceRuntime,
    item: RetryQueueItem,
    success: boolean,
    deferredByBrowserSuspension: boolean,
    serverPressure = false,
  ): Promise<RetryQueueItemProcessResult> {
    const retryAttempt = classifyRetryAttempt({
      success,
      retryCount: item.retryCount,
      maxRetries: this.MAX_RETRIES,
      terminalFailure: false,
      deferredByBrowserSuspension,
      browserSuspendedNow: !success && isBrowserNetworkSuspendedWindow(),
      serverPressure,
    });
    if (
      retryAttempt.kind === 'deferred-browser-suspension' ||
      retryAttempt.kind === 'deferred-server-pressure'
    ) {
      runtime.stoppedByBudget = true;
      return 'break';
    }
    if (retryAttempt.kind === 'success') {
      return await this.handleSuccessfulQueueReplay(runtime, item);
    }
    if (retryAttempt.kind === 'terminal') {
      return await this.persistPermanentFailureTerminalAttempt(runtime, item);
    }
    item.retryCount = retryAttempt.nextRetryCount;
    this.touchQueueState();
    if (retryAttempt.kind === 'retry-exhausted') {
      return await this.persistMaxRetriesTerminalAttempt(runtime, item);
    }
    return 'continue';
  }
  private async persistPermanentFailureTerminalAttempt(
    runtime: RetryQueueSliceRuntime,
    item: RetryQueueItem,
  ): Promise<RetryQueueItemProcessResult> {
    return await this.persistTerminalRemoval(
      runtime,
      item,
      'permanent-failure',
      'RetryQueue 终态证据持久化失败，保留队列项等待后续恢复',
      {
        queueItemId: item.id,
        type: item.type,
        dataId: item.data.id,
        reason: 'permanent-failure',
      },
    );
  }
  private async persistMaxRetriesTerminalAttempt(
    runtime: RetryQueueSliceRuntime,
    item: RetryQueueItem,
  ): Promise<RetryQueueItemProcessResult> {
    return await this.persistTerminalRemoval(
      runtime,
      item,
      'max-retries',
      'RetryQueue 最大重试终态证据持久化失败，保留队列项等待后续恢复',
      {
        queueItemId: item.id,
        type: item.type,
        dataId: item.data.id,
        retryCount: item.retryCount,
      },
      true,
    );
  }
  private async persistTerminalRemoval(
    runtime: RetryQueueSliceRuntime,
    item: RetryQueueItem,
    reason: string,
    failureMessage: string,
    failureDetails: Record<string, unknown>,
    incrementExceededCount = false,
  ): Promise<RetryQueueItemProcessResult> {
    return await persistTerminalRetryQueueRemoval({
      runtime,
      item,
      reason,
      failureMessage,
      failureDetails,
      incrementExceededCount,
      warn: (message, data) => this.warn(message, data),
      persistTerminalRetryEvidence: (queueItem, terminalReason) =>
        this.persistTerminalRetryEvidence(queueItem, terminalReason),
    });
  }
  protected async handleSuccessfulQueueReplay(
    runtime: RetryQueueSliceRuntime,
    item: RetryQueueItem,
  ): Promise<RetryQueueItemProcessResult> {
    if (item.type === 'project') {
      return await this.handleSuccessfulProjectReplay(runtime, item);
    }
    const refreshedItem = this.getRefreshedItemDuringProcessing(item);
    if (refreshedItem) {
      if (
        item.type === 'blackbox' &&
        refreshedItem.type === 'blackbox' &&
        this.buildBlackBoxRetryDataFingerprint(refreshedItem.data as BlackBoxEntry)
          === this.buildBlackBoxRetryDataFingerprint(item.data as BlackBoxEntry)
      ) {
        this.recordCompletedRetryQueueOperation(item);
        runtime.successfulReplayCount++;
        runtime.processedIds.add(item.id);
        this.recordCircuitSuccess();
        return 'continue';
      }
      this.logger.debug('重试项处理期间已刷新，保留最新快照等待下一轮回放', {
        type: item.type,
        queueItemId: item.id,
        dataId: item.data.id,
      });
      this.recordCircuitSuccess();
      return 'continue';
    }
    this.recordCompletedRetryQueueOperation(item);
    runtime.successfulReplayCount++;
    runtime.processedIds.add(item.id);
    this.recordCircuitSuccess();
    return 'continue';
  }
  protected async handleSuccessfulProjectReplay(
    runtime: RetryQueueSliceRuntime,
    item: RetryQueueItem,
  ): Promise<RetryQueueItemProcessResult> {
    if (this.wasItemRefreshedDuringProcessing(item)) {
      this.logger.debug('重试项处理期间已刷新，保留最新快照等待下一轮回放', {
        type: item.type,
        queueItemId: item.id,
        dataId: item.data.id,
      });
      this.recordCircuitSuccess();
      return 'continue';
    }
    this.recordCompletedRetryQueueOperation(item);
    const previousVisibleQueue = [...this.queue];
    const previousHiddenQueue = [...this.hiddenQueueItems];
    this.removeItemsFromAllViews(new Set([item.id]));
    let persistedRemoval = false;
    try {
      persistedRemoval = await this.persistNow();
    } catch (error) {
      this.warn('项目重试项移除持久化异常，保留在 RetryQueue 中等待后续回放', error);
    }
    if (!persistedRemoval) {
      this.queue = previousVisibleQueue;
      this.hiddenQueueItems = previousHiddenQueue;
      this.touchQueueState();
      this.checkCapacityWarning();
      this.warn('项目重试项移除未能完成持久化确认，保留在 RetryQueue 中等待后续回放', {
        projectId: item.data.id,
        sourceUserId: item.sourceUserId,
      });
      runtime.stoppedByBudget = true;
      return 'break';
    }
    runtime.successfulReplayCount++;
    this.recordCircuitSuccess();
    return 'continue';
  }
  private recordCompletedRetryQueueOperation(item: RetryQueueItem): void {
    if (this.persistCompletedRetryQueueOperation(item)) {
      return;
    }

    this.warn('RetryQueue 完成标记持久化失败，若本地删除持久化失败将依赖 operationId 幂等重放', {
      type: item.type,
      queueItemId: item.id,
      dataId: item.data.id,
      operationId: item.operationId,
    });
  }
  protected async finishQueueSlice(runtime: RetryQueueSliceRuntime): Promise<RetryQueueSliceResult> {
    if (runtime.exceededCount > 0) {
      this.warn('重试次数超限，移除项目', { count: runtime.exceededCount });
      this.toast.error('部分数据同步失败，请检查网络连接');
    }
    const persistedProcessedRemoval = await this.removeProcessedItemsFromQueueSlice(runtime);
    const completion = createRetryQueueSliceCompletionSummary(runtime, this.queue.length);
    if (completion.logEntry) {
      this.logger.info('processQueueSlice 完成', completion.logEntry);
    }
    runtime.drainCompletedBySuccessfulReplay =
      this.queue.length === 0 &&
      runtime.successfulReplayCount > 0 &&
      !runtime.stoppedByBudget;
    this.lastDrainHadTerminalConflict = runtime.hadTerminalRemoval;
    if (!persistedProcessedRemoval) {
      this.saveToStorage();
    }
    this.checkCapacityWarning();
    return completion.result;
  }
  private async removeProcessedItemsFromQueueSlice(
    runtime: RetryQueueSliceRuntime,
  ): Promise<boolean> {
    if (runtime.processedIds.size === 0) return false;
    const previousVisibleQueue = [...this.queue];
    const previousHiddenQueue = [...this.hiddenQueueItems];
    this.removeItemsFromAllViews(runtime.processedIds);
    let persistedProcessedRemoval = false;
    try {
      persistedProcessedRemoval = await this.persistNow();
    } catch (error) {
      this.warn('重试项移除持久化异常，保留在 RetryQueue 中等待后续回放', error);
    }
    if (persistedProcessedRemoval) return true;
    this.clearLocallyRemovedRetryItemIds(runtime.processedIds);
    this.queue = previousVisibleQueue;
    this.hiddenQueueItems = previousHiddenQueue;
    this.touchQueueState();
    this.checkCapacityWarning();
    this.warn('重试项移除未能完成持久化确认，保留在 RetryQueue 中等待后续回放', {
      processedCount: runtime.processedIds.size,
    });
    runtime.stoppedByBudget = true;
    return false;
  }
  protected handleQueueSliceError(error: unknown, startedAt: number): RetryQueueSliceResult {
    this.logger.error('processQueueSlice 发生未捕获异常', error);
    this.sentryLazyLoader.captureException(error, {
      tags: {
        operation: 'retryQueue.processQueueSlice'
      },
      extra: {
        queueSize: this.queue.length
      }
    });
    return this.createSliceResult(startedAt, false);
  }
  protected async finalizeQueueSlice(runtime: RetryQueueSliceRuntime): Promise<void> {
    if (runtime.generation === this.queueViewGeneration) {
      this.isProcessingQueue = false;
    }
    const queueWasModified = this.queue.length !== runtime.initialQueueLength;
    const shouldNotifyFalse =
      runtime.hasNotifiedSyncStart ||
      (runtime.generation === this.queueViewGeneration && queueWasModified);
    if (shouldNotifyFalse) {
      this.lastDrainCompletedBySuccess = runtime.drainCompletedBySuccessfulReplay;
      try {
        runtime.operationHandler.onProcessingStateChange(false, this.queue.length);
      } catch (error) {
        this.warn('onProcessingStateChange(false) 回调失败', error);
      }
    }
    if (runtime.leaseHandle) {
      await this.releaseQueueSliceLease(runtime.leaseHandle);
    }
  }
  private async releaseQueueSliceLease(leaseHandle: LeaseHandle): Promise<void> {
    await leaseHandle.release().catch(error => {
      this.warn('sync writer lease 释放失败', error);
    });
  }
  private warn(message: string, data?: unknown): void {
    try {
      if (arguments.length > 1) {
        this.logger.warn(message, data);
      } else {
        this.logger.warn(message);
      }
    } catch {
      // Observability failures must not change retry queue state transitions.
    }
  }
  /**
   * 处理重试队列（兼容入口）
   * 无参数时按历史语义尽量处理当前可处理项；有 maxItems 时限制处理条数。
   * manualTrigger=true 标记用户主动触发（如 "立即同步"），会等待浏览器恢复保护期
   * 真正结束后再进入正常切片，避免把下层网络门禁整体放开。
   */
  async processQueue(maxItems?: number, manualTrigger = false): Promise<void> {
    if (this.lifecycleClosed) {
      return;
    }
    // 【Cloudflare 迁移 §3 / §16.26】 export-only / read-only 部署禁止 flush 云端写入
    if (this.writeGuard && !this.writeGuard.assertWritable('RetryQueue.processQueue')) {
      return;
    }
    if (manualTrigger) {
      const resumeWindowResult = await waitForManualRetryQueueResumeWindow({
        isManualTrigger: true,
        isLifecycleClosed: () => this.lifecycleClosed,
      });
      if (resumeWindowResult === 'closed') {
        return;
      }
    }
    await this.processQueueSlice({
      maxItems: typeof maxItems === 'number' && maxItems > 0 ? maxItems : undefined,
    });
  }
  /**
   * 按“条数 + 时间预算”切片处理队列，避免恢复路径阻塞主线程。
   */
  async processQueueSlice(options: RetryQueueSliceOptions = {}): Promise<RetryQueueSliceResult> {
    const startedAt = Date.now();
    if (this.lifecycleClosed) {
      return this.createSliceResult(startedAt, true);
    }
    const wasProcessingQueue = this.isProcessingQueue;
    if (!wasProcessingQueue) {
      this.isProcessingQueue = true;
      this.lastProcessTime = Date.now();
    }
    const itemsSnapshot = [...this.queue];
    let prepared: RetryQueueSliceRuntime | RetryQueueSliceResult | null = null;
    try {
      prepared = await this.prepareQueueSlice(options, startedAt, itemsSnapshot, wasProcessingQueue);
      if ('processed' in prepared) {
        return prepared;
      }
      await this.processQueueSliceItems(prepared);
      return await this.finishQueueSlice(prepared);
    } catch (error) {
      return this.handleQueueSliceError(error, startedAt);
    } finally {
      if (prepared && !('processed' in prepared)) {
        await this.finalizeQueueSlice(prepared);
      } else if (!wasProcessingQueue) {
        this.isProcessingQueue = false;
      }
    }
  }
}
