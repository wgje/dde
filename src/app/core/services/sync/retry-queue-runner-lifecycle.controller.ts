import type { LeaseHandle } from '../../../../services/sync-writer-lease.service';
import { shouldRecoverStaleProcessingLock } from './retry-queue-processing';
import { createRetryQueueSliceResult } from './retry-queue-runner-slice.helpers';
import type { RetryQueueSliceOptions, RetryQueueSliceResult } from './retry-queue.types';

export interface RetryQueueRunnerLifecycleControllerOptions {
  isLifecycleClosed: () => boolean;
  isSessionExpired: () => boolean;
  isOnline: () => boolean;
  queueLength: () => number;
  processQueue: () => Promise<void>;
  currentTimer: () => ReturnType<typeof setInterval> | null;
  setTimer: (timer: ReturnType<typeof setInterval> | null) => void;
  isProcessing: () => boolean;
  setProcessing: (processing: boolean) => void;
  lastProcessTime: () => number;
  processTimeoutMs: number;
  now: () => number;
  checkCircuitBreaker: () => boolean;
  processQueueSlice: (options: RetryQueueSliceOptions) => Promise<RetryQueueSliceResult>;
  isBrowserNetworkSuspendedWindow: () => boolean;
  debug: (message: string, data?: unknown) => void;
  info: (message: string, data?: unknown) => void;
  error: (message: string, data?: unknown) => void;
  captureException: (error: unknown, context: {
    tags: Record<string, string>;
    extra: Record<string, unknown>;
  }) => void;
  warn: (message: string, data?: unknown) => void;
}

export class RetryQueueRunnerLifecycleController {
  constructor(private readonly options: RetryQueueRunnerLifecycleControllerOptions) {}

  startLoop(intervalMs: number): void {
    if (this.options.isLifecycleClosed()) {
      return;
    }
    this.stopLoop();
    this.options.setTimer(setInterval(() => {
      try {
        if (this.options.isSessionExpired()) return;
        if (this.options.isOnline() && this.options.queueLength() > 0) {
          void this.options.processQueue().catch(error => {
            this.options.warn('RetryQueue 重试循环执行失败', error);
          });
        }
      } catch (error) {
        this.options.warn('RetryQueue 重试循环执行失败', error);
      }
    }, intervalMs));
  }

  stopLoop(): void {
    const timer = this.options.currentTimer();
    if (timer === null) {
      return;
    }
    clearInterval(timer);
    this.options.setTimer(null);
  }

  createSliceResult(
    startedAt: number,
    completed: boolean,
    processed = 0,
  ): RetryQueueSliceResult {
    return createRetryQueueSliceResult({
      startedAt,
      completed,
      processed,
      remaining: this.options.queueLength(),
    });
  }

  releaseStaleProcessingLockIfNeeded(): void {
    this.tryReleaseStaleProcessingLock();
  }

  async recoverStaleProcessingLock(
    options: RetryQueueSliceOptions,
    startedAt: number,
  ): Promise<RetryQueueSliceResult | null> {
    if (!this.tryReleaseStaleProcessingLock()) {
      return null;
    }
    if (!this.options.isOnline() || !this.options.checkCircuitBreaker()) {
      this.options.info('锁释放后网络不可用或熔断器打开，跳过重试');
      return this.createSliceResult(startedAt, true);
    }
    if (!options._forcedRecovery) {
      return this.options.processQueueSlice({ ...options, _forcedRecovery: true });
    }
    this.options.error('processQueueSlice: 强制恢复后仍超时，放弃本次处理', {
      queueLength: this.options.queueLength(),
      elapsed: this.options.now() - this.options.lastProcessTime(),
      maxTimeout: this.options.processTimeoutMs,
    });
    return this.createSliceResult(startedAt, false);
  }

  skipQueueSliceForSuspendedWindow(
    options: RetryQueueSliceOptions,
    startedAt: number,
  ): RetryQueueSliceResult | null {
    if (!this.options.isBrowserNetworkSuspendedWindow() || options.allowWhileSuspended) {
      return null;
    }
    this.options.debug('浏览器网络挂起窗口内暂停重试切片', {
      remainingCount: this.options.queueLength(),
    });
    return this.createSliceResult(startedAt, false);
  }

  handleQueueSliceError(error: unknown, startedAt: number): RetryQueueSliceResult {
    this.options.error('processQueueSlice 发生未捕获异常', error);
    this.options.captureException(error, {
      tags: { operation: 'retryQueue.processQueueSlice' },
      extra: { queueSize: this.options.queueLength() },
    });
    return this.createSliceResult(startedAt, false);
  }

  async releaseQueueSliceLease(leaseHandle: Pick<LeaseHandle, 'release'>): Promise<void> {
    await leaseHandle.release().catch(error => {
      this.options.warn('sync writer lease 释放失败', error);
    });
  }

  tryReleaseStaleProcessingLock(): boolean {
    const now = this.options.now();
    const lastProcessTime = this.options.lastProcessTime();
    if (!shouldRecoverStaleProcessingLock({
      isProcessing: this.options.isProcessing(),
      lastProcessTime,
      now,
      timeoutMs: this.options.processTimeoutMs,
    })) {
      return false;
    }
    this.options.warn('processQueueSlice 处理锁超时，强制释放', {
      lastProcessTime,
      elapsed: now - lastProcessTime,
    });
    this.options.setProcessing(false);
    return true;
  }
}
