import type { LeaseHandle } from '../../../../services/sync-writer-lease.service';
import { SYNC_DURABILITY_CONFIG } from '../../../../config';
import {
  SYNC_WRITER_LEASE_PROJECT_SCOPE,
  SYNC_WRITER_LEASE_WAIT_MS,
  type RetryOperationHandler,
  type RetryQueueCapacityDiagnostics,
  type RetryableEntityType,
  type RetryableOperation,
} from './retry-queue.types';
import { RetryQueueItemsLayer } from './retry-queue-items.service';

type RetryQueueSentryMessageOptions = {
  level?: 'fatal' | 'error' | 'warning' | 'log' | 'info' | 'debug';
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
  fingerprint?: string[];
};

type RetryQueueToastOptions = {
  duration?: number;
};

export abstract class RetryQueueCapacityLayer extends RetryQueueItemsLayer {
  /**
   * 检查队列容量警告（分层预警 + 满载强制处理 + 卡死检测）
   *
   * 分层策略：
   * - 70%: 仅日志记录
   * - 85%: warning toast
   * - 95%: error toast（严重告警）
   */
  checkCapacityWarning(): void {
    const currentSize = this.queue.length;
    const threshold = Math.floor(this.maxQueueSize * this.WARNING_THRESHOLD);
    const now = Date.now();

    // 低于阈值，恢复正常状态
    if (currentSize < threshold) return this.handleCapacityRecovered(currentSize);

    const percentUsed = Math.round((currentSize / this.maxQueueSize) * 100);
    this.forceProcessQueueAtHighWatermark(percentUsed, now);

    // 节流检查
    const cooldownPassed = now - this.lastWarningTime > this.WARNING_COOLDOWN;
    const significantIncrease = percentUsed >= this.lastWarningPercent + 10;
    if (!cooldownPassed && !significantIncrease) return;

    // 更新警告状态
    this.lastWarningTime = now;
    this.lastWarningPercent = percentUsed;
    this.emitCapacityWarning({
      currentSize,
      maxSize: this.maxQueueSize,
      percentUsed,
      typeBreakdown: this.getTypeBreakdown()
    }, cooldownPassed);
  }

  protected handleCapacityRecovered(currentSize: number): void {
    if (this.lastWarningPercent > 0) {
      this.lastWarningPercent = 0;
      this.safeCapacityInfo('队列容量恢复正常', { currentSize, maxSize: this.maxQueueSize });
    }
    this.tryRecoverQueueFullPressure(true);
  }

  protected forceProcessQueueAtHighWatermark(percentUsed: number, now: number): void {
    if (percentUsed < 90 || !this.operationHandler?.isOnline()) return;
    if (!this.isProcessingQueue) {
      this.processQueue();
      return;
    }

    const duration = now - this.lastProcessTime;
    if (duration <= 120_000) return;
    this.safeCapacityWarn('processQueue 卡死，强制重置', { percentUsed, duration });
    this.isProcessingQueue = false;
    this.lastDrainCompletedBySuccess = false;
    try {
      this.operationHandler.onProcessingStateChange(false, this.queue.length);
    } catch (error) {
      this.safeCapacityWarn('卡死恢复时回写处理状态失败', error);
    }
  }

  protected emitCapacityWarning(diagnostics: RetryQueueCapacityDiagnostics, cooldownPassed: boolean): void {
    const sentryExtra = this.toCapacityDiagnosticsExtra(diagnostics);

    if (diagnostics.percentUsed >= 95) {
      this.safeCapacityError('RetryQueue 即将满载', diagnostics);
      if (cooldownPassed) {
        this.safeCapacityToastError(
          '同步队列即将满载',
          '请尽快恢复网络连接，否则新操作可能无法入队',
          { duration: 30_000 }
        );
      }
      this.safeCapacityCaptureMessage('RetryQueue at 95% capacity', {
        level: 'error',
        tags: { operation: 'queueCapacityCheck', percentUsed: String(diagnostics.percentUsed) },
        extra: sentryExtra
      });
    } else if (diagnostics.percentUsed >= 85) {
      this.safeCapacityWarn('RetryQueue 接近上限', diagnostics);
      if (cooldownPassed) {
        this.safeCapacityToastWarning(
          '同步队列接近上限',
          `已使用 ${diagnostics.percentUsed}%，请尽快连接网络`,
          { duration: 10_000 }
        );
      }
      this.safeCapacityCaptureMessage('RetryQueue capacity warning', {
        level: 'warning',
        tags: { operation: 'queueCapacityCheck', percentUsed: String(diagnostics.percentUsed) },
        extra: sentryExtra
      });
    } else if (diagnostics.percentUsed >= 70) {
      // 70%：仅日志记录
      this.safeCapacityWarn('RetryQueue 容量偏高', diagnostics);
    }
  }

  protected toCapacityDiagnosticsExtra(
    diagnostics: RetryQueueCapacityDiagnostics
  ): Record<string, unknown> {
    return { ...diagnostics };
  }

  protected enterPressureMode(reason: string): void {
    if (this.queuePressure() && this.queuePressureReason() === reason) {
      return;
    }
    this.queuePressure.set(true);
    this.queuePressureReason.set(reason);
    this.pressureEventCount += 1;
    this.safeCapacitySetPressureTag('true');
    this.safeCapacitySetPressureContext({
      reason,
      queue_size: this.queue.length,
      max_size: this.maxQueueSize,
      pressure_events: this.pressureEventCount
    });
  }

  protected clearPressureMode(): void {
    if (!this.queuePressure()) {
      return;
    }
    this.queuePressure.set(false);
    this.queuePressureReason.set(null);
    this.safeCapacitySetPressureTag('false');
  }

  protected tryRecoverQueueFullPressure(force = false): void {
    if (!this.queuePressure()) {
      return;
    }
    const pressureReason = this.queuePressureReason();
    if (!pressureReason) {
      return;
    }

    if (pressureReason === 'queue_full') {
      const releaseThreshold = force
        ? Math.floor(this.maxQueueSize * this.WARNING_THRESHOLD)
        : this.maxQueueSize - 1;
      if (this.queue.length <= releaseThreshold) {
        this.clearPressureMode();
      }
      return;
    }

    if (pressureReason === 'storage_unknown_outcome') {
      this.recoverUnknownOutcomeStoragePressure();
      return;
    }

    if (!pressureReason.startsWith('storage_') || typeof localStorage === 'undefined') {
      return;
    }

    const now = Date.now();
    if (!force && now - this.lastStorageRecoveryAttempt < this.STORAGE_RECOVERY_COOLDOWN) {
      return;
    }
    this.lastStorageRecoveryAttempt = now;

    if (!this.isLocalStorageWritable()) {
      return;
    }

    this.saveToLocalStorage();
    if (!this.queuePressure()) {
      this.safeCapacityInfo('存储压力已恢复，重试队列重新开放入队', { pressureReason });
    }
  }

  protected recoverUnknownOutcomeStoragePressure(): void {}

  protected isLocalStorageWritable(): boolean {
    const probeKey = `${this.STORAGE_KEY}.probe`;
    try {
      localStorage.setItem(probeKey, '1');
      localStorage.removeItem(probeKey);
      return true;
    } catch {
      return false;
    }
  }

  private warnLeaseAcquisitionFailure(message: string): void {
    this.safeCapacityWarn('sync writer lease 获取失败，本轮 RetryQueue flush 已延后', { message });
  }

  private safeCapacityWarn(message: string, data?: unknown): void {
    try {
      if (data === undefined) {
        this.logger.warn(message);
        return;
      }
      this.logger.warn(message, data);
    } catch {
      // RetryQueue pressure recovery must not depend on observability sinks.
    }
  }

  private safeCapacityError(message: string, data?: unknown): void {
    try {
      if (data === undefined) {
        this.logger.error(message);
        return;
      }
      this.logger.error(message, data);
    } catch {
      // RetryQueue add/check flow must not depend on observability sinks.
    }
  }

  private safeCapacityInfo(message: string, data?: unknown): void {
    try {
      if (data === undefined) {
        this.logger.info(message);
        return;
      }
      this.logger.info(message, data);
    } catch {
      // RetryQueue pressure recovery must not depend on observability sinks.
    }
  }

  private safeCapacityToastWarning(
    title: string,
    message: string,
    options?: RetryQueueToastOptions,
  ): void {
    try {
      this.toast.warning(title, message, options);
    } catch {
      // RetryQueue add/check flow must not depend on observability sinks.
    }
  }

  private safeCapacityToastError(
    title: string,
    message: string,
    options?: RetryQueueToastOptions,
  ): void {
    try {
      this.toast.error(title, message, options);
    } catch {
      // RetryQueue add/check flow must not depend on observability sinks.
    }
  }

  private safeCapacityCaptureMessage(
    message: string,
    options?: RetryQueueSentryMessageOptions,
  ): void {
    try {
      this.sentryLazyLoader.captureMessage(message, options);
    } catch {
      // RetryQueue add/check flow must not depend on observability sinks.
    }
  }

  private safeCapacitySetPressureTag(value: 'true' | 'false'): void {
    try {
      this.sentryLazyLoader.setTag('retry_queue_pressure', value);
    } catch {
      // RetryQueue pressure state must not depend on observability sinks.
    }
  }

  private safeCapacitySetPressureContext(context: Record<string, unknown>): void {
    try {
      this.sentryLazyLoader.setContext('retry_queue_pressure', context);
    } catch {
      // RetryQueue pressure state must not depend on observability sinks.
    }
  }

  protected isSyncWriterLeaseRequired(): boolean {
    try {
      return this.syncWriterLease?.isFeatureEnabled() === true;
    } catch {
      return false;
    }
  }

  protected async acquireSyncWriterLease(): Promise<LeaseHandle | null> {
    if (!this.syncWriterLease) {
      return null;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SYNC_WRITER_LEASE_WAIT_MS);
    try {
      return await this.syncWriterLease.requestLease({
        userId: this.getCurrentOwnerUserId(),
        projectId: SYNC_WRITER_LEASE_PROJECT_SCOPE,
        signal: controller.signal,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.warnLeaseAcquisitionFailure(message);
      // eslint-disable-next-line no-restricted-syntax -- lease 获取失败用 null 表示本轮延后，避免误删队列项。
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  protected reportEnqueueRejected(
    type: RetryableEntityType,
    operation: RetryableOperation,
    dataId: string,
    reason: string
  ): void {
    this.safeCapacityWarn('队列拒绝入队', {
      type,
      operation,
      dataId,
      reason,
      queueSize: this.queue.length,
      maxSize: this.maxQueueSize
    });
    const now = Date.now();
    const shouldNotify = now - this.lastEnqueueRejectTime > this.ENQUEUE_REJECT_COOLDOWN;
    if (!shouldNotify) {
      return;
    }
    this.lastEnqueueRejectTime = now;
    const isStoragePressure = reason.startsWith('storage_');
    this.safeCapacityToastWarning(
      isStoragePressure ? '同步队列压力过大' : '同步队列已满',
      isStoragePressure
        ? '新操作暂未入队，请释放浏览器存储空间后重试'
        : '新操作暂未入队，请恢复网络后重试',
      { duration: 8000 }
    );
    this.safeCapacityCaptureMessage('RetryQueue enqueue rejected', {
      level: 'warning',
      tags: {
        queueSize: String(this.queue.length),
        dropPolicy: SYNC_DURABILITY_CONFIG.DROP_POLICY,
        reason
      }
    });
  }

  protected triggerEmergencyProcessQueue(trigger: 'queue_full' | 'pressure_reject' | 'high_watermark'): void {
    if (!this.operationHandler?.isOnline() || this.isProcessingQueue || this.queue.length === 0) {
      return;
    }
    this.safeCapacityInfo('触发紧急队列处理', {
      trigger,
      queueSize: this.queue.length,
      maxSize: this.maxQueueSize
    });
    void this.processQueue();
  }

  /**
   * 获取队列容量使用百分比（0-100）
   * 用于同步状态面板展示队列健康度
   */
  getCapacityPercent(): number {
    if (this.maxQueueSize === 0) return 0;
    return Math.round((this.queue.length / this.maxQueueSize) * 100);
  }

  /**
   * 获取队列中各类型项的数量统计
   */
  getTypeBreakdown(): Record<string, number> {
    const breakdown: Record<string, number> = { task: 0, project: 0, connection: 0, blackbox: 0 };
    for (const item of this.queue) {
      breakdown[item.type] = (breakdown[item.type] || 0) + 1;
    }
    return breakdown;
  }

  /**
   * 立即保存队列（用于 beforeunload）
   */
  flushSync(): void {
    this.saveToStorageSync();

    if (this.queue.length > 0) {
      this.logger.info('beforeunload: 保存待处理同步项', {
        count: this.queue.length
      });
    }
  }

  // ==================== 操作处理器 ====================

  /** 设置操作处理器（由 SimpleSyncService 调用） */
  setOperationHandler(handler: RetryOperationHandler): void {
    this.operationHandler = handler;

    // 【Bug Fix 2026-03-22 + 2026-05-16 加固】无条件同步队列长度到 SyncState。
    // 原 if (queue.length > 0) 守卫存在 stale 漂移窗口：切账号 / clearCurrentView 之后
    // 再 setOperationHandler 时，SyncState 可能仍残留旧账号的 pendingCount，
    // 导致 UI 永远显示 "X 待同步"。无条件回写可以把 SyncState 强制对齐到当前 queue.length，
    // 哪怕 queue.length === 0 也能把上游漂移清零。
    this.lastDrainCompletedBySuccess = false;
    try {
      handler.onProcessingStateChange(false, this.queue.length);
      this.logger.debug('setOperationHandler: 同步队列长度到 SyncState', { queueLength: this.queue.length });
    } catch (error) {
      this.logger.warn('setOperationHandler: 同步队列长度失败', error);
    }
  }

  consumeSuccessfulDrainFlag(): boolean {
    const drainedBySuccess = this.lastDrainCompletedBySuccess;
    this.lastDrainCompletedBySuccess = false;
    return drainedBySuccess;
  }

  hasSuccessfulDrainFlag(): boolean {
    return this.lastDrainCompletedBySuccess;
  }

  clearSuccessfulDrainFlag(): void {
    this.lastDrainCompletedBySuccess = false;
  }

  /**
   * 读取并消费"最近一次 drain 是否包含终态拒绝"标记。
   *
   * 【Layer 5】用于让上层决定是否写入红色 syncError（"部分同步失败，且存在版本冲突..."），
   * 与 `consumeSuccessfulDrainFlag` 互不影响：混合场景下两者可以同时为 true。
   */
  consumeTerminalConflictDrainFlag(): boolean {
    const had = this.lastDrainHadTerminalConflict;
    this.lastDrainHadTerminalConflict = false;
    return had;
  }

  hasTerminalConflictDrainFlag(): boolean {
    return this.lastDrainHadTerminalConflict;
  }

  clearTerminalConflictDrainFlag(): void {
    this.lastDrainHadTerminalConflict = false;
  }
}
