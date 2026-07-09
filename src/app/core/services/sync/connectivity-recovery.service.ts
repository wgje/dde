/**
 * ConnectivityRecoveryService - 网络连接恢复管理
 *
 * 职责：
 * - 监控 Supabase 连接状态变化
 * - 探测远端可达性
 * - 协调连接恢复流程（会话验证 + Transport 恢复）
 * - 管理恢复定时器与重试策略
 *
 * 从 SimpleSyncService 抽离（技术债务清理 2026-05-13）
 */

import { Injectable, inject, DestroyRef } from '@angular/core';
import { SupabaseClientService, type SupabaseConnectivityChange } from '../../../../services/supabase-client.service';
import { LoggerService } from '../../../../services/logger.service';
import { SYNC_CONFIG } from '../../../../config/sync.config';
import { FEATURE_FLAGS } from '../../../../config/feature-flags.config';
import { SessionManagerService } from './session-manager.service';
import { RealtimePollingService } from './realtime-polling.service';
import { RetryQueueService } from './retry-queue.service';
import { SyncStateService } from './sync-state.service';
import { BlackBoxSyncService } from '../../../../services/black-box-sync.service';
import { WidgetBindingService } from '../../../../services/widget-binding.service';
import { AttachmentCleanupOutboxService } from '../../../../services/attachment-cleanup-outbox.service';
import { DockDirectWidgetNotifyOutboxService } from '../../../../services/dock-direct-widget-notify-outbox.service';
import {
  getRemainingBrowserNetworkResumeDelayMs,
  isBrowserNetworkSuspendedWindow,
} from '../../../../utils/browser-network-suspension';
import { shouldContinueConnectivityRecovery } from './connectivity-recovery-flow';

type PendingConnectivityRecoveryIntent = {
  reason: string;
  dueAt: number;
  source: 'hidden' | 'offline';
};

@Injectable({ providedIn: 'root' })
export class ConnectivityRecoveryService {
  private readonly supabase = inject(SupabaseClientService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('ConnectivityRecovery');
  private readonly sessionManager = inject(SessionManagerService);
  private readonly realtimePollingService = inject(RealtimePollingService);
  private readonly retryQueueService = inject(RetryQueueService);
  private readonly syncStateService = inject(SyncStateService);
  private readonly blackBoxSync = inject(BlackBoxSyncService);
  private readonly widgetBinding = inject(WidgetBindingService);
  private readonly attachmentCleanupOutbox = inject(AttachmentCleanupOutboxService);
  private readonly directWidgetNotifyOutbox = inject(DockDirectWidgetNotifyOutboxService);
  private readonly destroyRef = inject(DestroyRef);

  private connectivityRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private connectivityRecoveryTimerDueAt: number | null = null;
  private connectivityRecoveryPromise: Promise<void> | null = null;
  private pendingConnectivityRecoveryIntent: PendingConnectivityRecoveryIntent | null = null;
  private connectivityRecoveryEpoch = 0;
  private runtimeStarted = false;

  /**
   * 连续探测失败计数（长离线退避）：固定 15s 间隔在地铁/飞行等长离线期
   * 每小时产生 240 次真实 fetch；连续失败按 2^n 退避到 120s 上限，
   * 任一次探测成功或请求级恢复即复位。online/visibility 事件驱动的恢复
   * 路径不受影响，实际感知恢复仍是秒级。
   */
  private consecutiveProbeFailureCount = 0;

  private nextProbeRetryDelayMs(): number {
    // 第 N 次连续失败后的下一次探测间隔 = 15s × 2^(N-1)，封顶 120s
    const backoffExponent = Math.min(Math.max(this.consecutiveProbeFailureCount - 1, 0), 3);
    return Math.min(
      SYNC_CONFIG.CONNECTIVITY_PROBE_INTERVAL * 2 ** backoffExponent,
      SYNC_CONFIG.CONNECTIVITY_PROBE_MAX_INTERVAL,
    );
  }

  /**
   * 启动连接恢复运行时
   */
  startRuntime(): void {
    this.runtimeStarted = true;
    this.connectivityRecoveryEpoch++;
  }

  /**
   * 停止连接恢复运行时
   */
  stopRuntime(): void {
    this.runtimeStarted = false;
    this.connectivityRecoveryEpoch++;
    this.clearConnectivityRecoveryTimer();
    this.pendingConnectivityRecoveryIntent = null;
    this.connectivityRecoveryPromise = null;
  }

  /**
   * 处理 Supabase 连接状态变化
   */
  handleSupabaseConnectivityChange(change: SupabaseConnectivityChange, syncStateIsOnline: boolean): void {
    if (change.offline) {
      this.syncStateService.setOfflineMode(true);
    }

    if (!this.runtimeStarted || change.source !== 'request') {
      if (!change.offline && syncStateIsOnline) {
        this.syncStateService.setOfflineMode(false);
      }
      return;
    }

    if (change.offline) {
      this.connectivityRecoveryEpoch++;
      this.connectivityRecoveryPromise = null;
      this.clearConnectivityRecoveryTimer();
      void this.suspendRealtimeTransportSafely(
        'supabase-request-offline',
        '请求离线后 Realtime 传输挂起失败',
      );
      this.scheduleConnectivityRecovery('supabase-request-offline', this.nextProbeRetryDelayMs());
      return;
    }

    if (!syncStateIsOnline) {
      return;
    }

    this.consecutiveProbeFailureCount = 0;
    this.syncStateService.setOfflineMode(false);
    void this.restoreRemoteConnectivity('supabase-request-restored').catch((error: unknown) => {
      this.logger.warn('请求恢复后远端连接恢复失败', {
        reason: 'supabase-request-restored',
        error,
      });
    });
  }

  /**
   * 清除连接恢复定时器
   */
  private clearConnectivityRecoveryTimer(): void {
    if (this.connectivityRecoveryTimer === null) {
      return;
    }

    clearTimeout(this.connectivityRecoveryTimer);
    this.connectivityRecoveryTimer = null;
    this.connectivityRecoveryTimerDueAt = null;
  }

  cancelScheduledRecovery(): void {
    this.connectivityRecoveryEpoch++;
    this.connectivityRecoveryPromise = null;
    this.clearConnectivityRecoveryTimer();
  }

  /**
   * 探测远端可达性
   */
  async probeRemoteReachability(
    reason: string,
    timeoutMs: number = SYNC_CONFIG.CONNECTIVITY_PROBE_TIMEOUT,
    force = true
  ): Promise<boolean> {
    if (isBrowserNetworkSuspendedWindow()) {
      const delayMs = Math.max(100, getRemainingBrowserNetworkResumeDelayMs() + 50);
      this.logger.debug('浏览器网络仍处于挂起窗口，延后远端可达性探测', {
        reason,
        delayMs,
      });
      this.scheduleConnectivityRecovery(`${reason}:network-suspended`, delayMs);
      return false;
    }

    let reachable = false;
    try {
      reachable = await this.supabase.probeReachability({ timeoutMs, force });
    } catch (error) {
      this.consecutiveProbeFailureCount += 1;
      this.logger.warn('Supabase 远端可达性探测失败，保持连接恢复重试', { reason, error });
      this.syncStateService.setOfflineMode(true);
      await this.suspendRealtimeTransportSafely(reason, 'Realtime 传输挂起失败，继续连接恢复流程');
      this.scheduleConnectivityRecovery(reason, this.nextProbeRetryDelayMs());
      return false;
    }

    this.syncStateService.setOfflineMode(!reachable);

    if (!reachable) {
      this.consecutiveProbeFailureCount += 1;
      this.logger.info('Supabase 远端暂不可达，保持连接中断模式', { reason });
      await this.suspendRealtimeTransportSafely(reason, 'Realtime 传输挂起失败，继续连接恢复流程');
      return false;
    }

    this.consecutiveProbeFailureCount = 0;
    return true;
  }

  /**
   * 确保连接恢复会话就绪
   */
  private async ensureConnectivityRecoverySessionReady(reason: string): Promise<boolean> {
    const sessionSnapshot = FEATURE_FLAGS.RESUME_SESSION_SNAPSHOT_V1
      ? this.sessionManager.getRecentValidationSnapshot(10_000)
      : null;

    if (sessionSnapshot?.valid) {
      return true;
    }

    let session: Awaited<ReturnType<SessionManagerService['validateOrRefreshOnResume']>>;
    try {
      session = await this.sessionManager.validateOrRefreshOnResume(`connectivity:${reason}`);
    } catch (error) {
      this.logger.warn('连接恢复会话校验失败，保持连接恢复重试', { reason, error });
      this.scheduleConnectivityRecovery(reason, SYNC_CONFIG.CONNECTIVITY_PROBE_INTERVAL);
      return false;
    }

    if (session.deferred) {
      const delayMs = Math.max(100, getRemainingBrowserNetworkResumeDelayMs() + 50);
      this.scheduleConnectivityRecovery(`${reason}:session-deferred`, delayMs);
      this.logger.info('连接恢复等待会话稳定后重试', {
        reason,
        delayMs,
        deferredReason: session.reason ?? 'client-unready',
      });
      return false;
    }

    if (!session.ok) {
      this.logger.info('连接恢复因会话不可用而跳过', {
        reason,
        failureReason: session.reason,
      });
      return false;
    }

    return true;
  }

  /**
   * 调度连接恢复
   */
  scheduleConnectivityRecovery(reason: string, delayMs: number = SYNC_CONFIG.DEBOUNCE_DELAY): void {
    if (!this.runtimeStarted) {
      return;
    }

    const normalizedDelay = Math.max(0, delayMs);
    const nextDueAt = Date.now() + normalizedDelay;
    if (this.hasEarlierConnectivityRecovery(nextDueAt)) {
      return;
    }

    this.clearConnectivityRecoveryTimer();

    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
      this.rememberPendingConnectivityRecoveryIntent(reason, nextDueAt, 'hidden');
      this.logger.debug('页面仍处于后台，跳过连接恢复定时器，等待下一次可见恢复事件', {
        reason,
      });
      return;
    }

    const recoveryTimer = setTimeout(() => {
      this.runScheduledConnectivityRecovery(recoveryTimer, reason);
    }, normalizedDelay);
    this.connectivityRecoveryTimer = recoveryTimer;
    this.connectivityRecoveryTimerDueAt = nextDueAt;
  }

  private hasEarlierConnectivityRecovery(nextDueAt: number): boolean {
    if (
      this.connectivityRecoveryTimer !== null
      && this.connectivityRecoveryTimerDueAt !== null
      && this.connectivityRecoveryTimerDueAt <= nextDueAt
    ) {
      return true;
    }

    return this.pendingConnectivityRecoveryIntent !== null
      && this.pendingConnectivityRecoveryIntent.dueAt <= nextDueAt;
  }

  private runScheduledConnectivityRecovery(
    recoveryTimer: ReturnType<typeof setTimeout>,
    reason: string,
  ): void {
    if (this.connectivityRecoveryTimer !== recoveryTimer) {
      return;
    }

    this.connectivityRecoveryTimer = null;
    this.connectivityRecoveryTimerDueAt = null;

    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      this.rememberPendingConnectivityRecoveryIntent(reason, Date.now(), 'offline');
      this.logger.debug('浏览器仍处于离线状态，保留连接恢复意图等待 online/resume', {
        reason,
      });
      return;
    }

    const restoreReason = `scheduled:${reason}`;
    void this.restoreRemoteConnectivity(restoreReason).catch((error: unknown) => {
      this.logger.warn('定时远端连接恢复失败，保持连接恢复重试', {
        reason: restoreReason,
        error,
      });
    });
  }

  flushPendingConnectivityRecovery(triggerReason: string): boolean {
    if (!this.runtimeStarted || this.pendingConnectivityRecoveryIntent === null) {
      return false;
    }
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
      return false;
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return false;
    }

    const pendingIntent = this.pendingConnectivityRecoveryIntent;
    this.pendingConnectivityRecoveryIntent = null;
    const delayMs = Math.max(0, pendingIntent.dueAt - Date.now());
    this.logger.debug('补跑挂起的连接恢复意图', {
      triggerReason,
      pendingReason: pendingIntent.reason,
      source: pendingIntent.source,
      delayMs,
    });
    this.scheduleConnectivityRecovery(`pending:${triggerReason}:${pendingIntent.reason}`, delayMs);
    return true;
  }

  /**
   * 恢复远端连接
   */
  async restoreRemoteConnectivity(reason: string): Promise<void> {
    if (this.connectivityRecoveryPromise) {
      return this.connectivityRecoveryPromise;
    }

    this.pendingConnectivityRecoveryIntent = null;
    this.clearConnectivityRecoveryTimer();
    const recoveryEpoch = this.connectivityRecoveryEpoch;
    const recoveryPromise: Promise<void> = this.restoreRemoteConnectivityInternal(reason, recoveryEpoch)
      .finally(() => {
        if (this.connectivityRecoveryPromise === recoveryPromise) {
          this.connectivityRecoveryPromise = null;
        }
      });

    this.connectivityRecoveryPromise = recoveryPromise;

    return this.connectivityRecoveryPromise;
  }

  private rememberPendingConnectivityRecoveryIntent(
    reason: string,
    dueAt: number,
    source: PendingConnectivityRecoveryIntent['source'],
  ): void {
    if (
      this.pendingConnectivityRecoveryIntent !== null
      && this.pendingConnectivityRecoveryIntent.dueAt <= dueAt
    ) {
      return;
    }

    this.pendingConnectivityRecoveryIntent = { reason, dueAt, source };
  }

  /**
   * 恢复远端连接内部实现
   */
  private async restoreRemoteConnectivityInternal(reason: string, recoveryEpoch: number): Promise<void> {
    let remoteProbeCompleted = false;
    const shouldContinue = (): boolean => shouldContinueConnectivityRecovery({
      runtimeStarted: this.runtimeStarted,
      recoveryEpoch,
      currentEpoch: this.connectivityRecoveryEpoch,
    });

    if (this.supabase.isOfflineMode()) {
      const reachable = await this.probeRemoteReachability(reason, SYNC_CONFIG.CONNECTIVITY_PROBE_TIMEOUT, true);
      remoteProbeCompleted = true;
      if (!shouldContinue()) {
        return;
      }

      if (!reachable) {
        this.scheduleConnectivityRecovery(reason, this.nextProbeRetryDelayMs());
        return;
      }
    }

    const sessionReady = await this.ensureConnectivityRecoverySessionReady(reason);
    if (!shouldContinue()) {
      return;
    }

    if (!sessionReady) {
      return;
    }

    if (!remoteProbeCompleted) {
      const reachable = await this.probeRemoteReachability(reason, SYNC_CONFIG.CONNECTIVITY_PROBE_TIMEOUT, true);
      if (!shouldContinue()) {
        return;
      }

      if (!reachable) {
        this.scheduleConnectivityRecovery(reason, this.nextProbeRetryDelayMs());
        return;
      }
    }

    try {
      await this.realtimePollingService.resumeTransport();
    } catch (error) {
      this.logger.warn('Realtime 传输恢复失败，保持连接恢复重试', { reason, error });
      this.scheduleConnectivityRecovery(reason, SYNC_CONFIG.CONNECTIVITY_PROBE_INTERVAL);
      return;
    }

    if (!shouldContinue()) {
      return;
    }

    this.finalizeRemoteConnectivityRestore(reason);
  }

  private finalizeRemoteConnectivityRestore(reason: string): void {
    this.runConnectivityRestoreFanOutStep(
      reason,
      '远端连接恢复后 Realtime 订阅恢复失败',
      () => {
        this.realtimePollingService.resumeRealtimeUpdates();
      },
    );

    if (this.retryQueueService.length > 0) {
      this.processRetryQueueAfterConnectivityRestore(reason);
    }

    this.flushWidgetBindingOutboxAfterConnectivityRestore(reason);
    this.flushDirectWidgetNotifyOutboxAfterConnectivityRestore(reason);
    this.flushAttachmentCleanupOutboxAfterConnectivityRestore(reason);
    this.triggerRemoteChangeAfterConnectivityRestore(reason);
    this.pullBlackBoxChangesAfterConnectivityRestore(reason);
  }

  private processRetryQueueAfterConnectivityRestore(reason: string): void {
    this.runConnectivityRestoreFanOutStep(
      reason,
      '远端连接恢复后重试队列处理失败',
      () => {
        void this.retryQueueService.processQueue().catch((error: unknown) => {
          this.logger.warn('远端连接恢复后重试队列处理失败', {
            reason,
            error,
          });
        });
      },
    );
  }

  private triggerRemoteChangeAfterConnectivityRestore(reason: string): void {
    this.runConnectivityRestoreFanOutStep(
      reason,
      '远端连接恢复后远端变更回调调度失败',
      () => {
        if (!this.realtimePollingService.hasRemoteChangeCallback()) {
          return;
        }

        void this.realtimePollingService.triggerRemoteChange({
          eventType: 'reconnect',
          projectId: this.realtimePollingService.getCurrentProjectId() ?? undefined,
        }).catch((error: unknown) => {
          this.logger.warn('远端连接恢复后远端变更回调失败', {
            reason,
            error,
          });
        });
      },
    );
  }

  private flushWidgetBindingOutboxAfterConnectivityRestore(reason: string): void {
    this.runConnectivityRestoreFanOutStep(
      reason,
      '远端连接恢复后 Widget 绑定队列同步失败',
      () => {
        void this.widgetBinding.flushPendingRevokeAllBindings()
          .then((result) => {
            if (!result.ok) {
              this.logger.warn('远端连接恢复后 Widget 绑定队列同步失败', {
                reason,
                error: result.error,
              });
            }
          })
          .catch((error: unknown) => {
            this.logger.warn('远端连接恢复后 Widget 绑定队列同步失败', {
              reason,
              error,
            });
          });
      },
    );
  }

  private flushAttachmentCleanupOutboxAfterConnectivityRestore(reason: string): void {
    this.runConnectivityRestoreFanOutStep(
      reason,
      '远端连接恢复后附件清理队列同步失败',
      () => {
        void this.supabase.clientAsync()
          .then(client => this.attachmentCleanupOutbox.flushPendingCleanups(client))
          .then((result) => {
            if (!result.ok) {
              this.logger.warn('远端连接恢复后附件清理队列同步失败', {
                reason,
                error: result.errors.join('; ') || 'unknown attachment cleanup sync failure',
              });
            }
          })
          .catch((error: unknown) => {
            this.logger.warn('远端连接恢复后附件清理队列同步失败', {
              reason,
              error,
            });
          });
      },
    );
  }

  private flushDirectWidgetNotifyOutboxAfterConnectivityRestore(reason: string): void {
    this.runConnectivityRestoreFanOutStep(
      reason,
      '远端连接恢复后 Widget 直推队列同步失败',
      () => {
        void this.supabase.clientAsync()
          .then(client => this.directWidgetNotifyOutbox.flushPendingNotifications(client))
          .then((result) => {
            if (!result.ok) {
              this.logger.warn('远端连接恢复后 Widget 直推队列同步失败', {
                reason,
                error: result.errors.join('; ') || 'unknown widget direct notify sync failure',
              });
            }
          })
          .catch((error: unknown) => {
            this.logger.warn('远端连接恢复后 Widget 直推队列同步失败', {
              reason,
              error,
            });
          });
      },
    );
  }

  private pullBlackBoxChangesAfterConnectivityRestore(reason: string): void {
    this.runConnectivityRestoreFanOutStep(
      reason,
      '远端连接恢复后黑匣子补拉调度失败',
      () => {
        void this.blackBoxSync.pullChanges({ reason: 'resume' }).catch((error: unknown) => {
          this.logger.warn('远端连接恢复后黑匣子补拉失败', {
            reason,
            error,
          });
        });
      },
    );
  }

  private async suspendRealtimeTransportSafely(reason: string, failureMessage: string): Promise<void> {
    try {
      await this.realtimePollingService.suspendTransport();
    } catch (error) {
      this.logger.warn(failureMessage, { reason, error });
    }
  }

  private runConnectivityRestoreFanOutStep(
    reason: string,
    failureMessage: string,
    action: () => void,
  ): void {
    try {
      action();
    } catch (error) {
      this.logger.warn(failureMessage, { reason, error });
    }
  }
}
