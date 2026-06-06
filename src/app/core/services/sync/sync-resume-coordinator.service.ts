/**
 * SyncResumeCoordinatorService
 *
 * 从 SimpleSyncService「下切」出的「页面恢复 / resume」恢复链路状态机。
 *
 * 职责单一：
 * - 页面恢复（visibility / online / pulse）时按 light/heavy/compensation 分级恢复
 * - 离线积压重试队列的前台/后台分片排空（含 recovery-ticket 去重）
 * - heavy 模式下的远端可达性探测 + 远端变更触发（带超时与后台兜底）
 *
 * 为什么抽离：
 * - AGENTS.md §12 单文件 ≤ 800 行硬线；SimpleSyncService 长期越界，文件头要求只做「下切」。
 * - 恢复链路是自洽的横切责任，依赖全部可注入；`loadProjectsFromCloud` 兜底直接走
 *   注入的 `ProjectDataService`，因此无需任何回指门面的回调（零循环 DI）。
 *
 * 验证：SimpleSyncService.spec 有专属 `recoverAfterResume` describe 块，直接调用真实方法
 * 覆盖 online/light/compensation/远端不可达/会话延后等多模式；门面 `recoverAfterResume()`
 * 改为委托本协调器后该套用例继续校验零回归。
 */
import { Injectable, inject } from '@angular/core';
import { LoggerService } from '../../../../services/logger.service';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import { SyncStateService } from './sync-state.service';
import { SessionManagerService } from './session-manager.service';
import { ConnectivityRecoveryService } from './connectivity-recovery.service';
import { RetryQueueService } from './retry-queue.service';
import { RealtimePollingService } from './realtime-polling.service';
import { ProjectDataService } from './project-data.service';
import { FEATURE_FLAGS } from '../../../../config/feature-flags.config';
import { APP_LIFECYCLE_CONFIG } from '../../../../config/app-lifecycle.config';
import { SYNC_CONFIG } from '../../../../config/sync.config';
import { getRemainingBrowserNetworkResumeDelayMs } from '../../../../utils/browser-network-suspension';

/** 恢复链路参数 */
export interface ResumeRecoverOptions {
  mode?: 'light' | 'heavy';
  stage?: 'full' | 'compensation';
  allowRemoteProbe?: boolean;
  force?: boolean;
  sessionValidated?: boolean;
  retryProcessing?: 'background' | 'blocking';
  interactionBudgetMs?: number;
  skipSessionValidationWithinMs?: number;
  resumeProbeTimeoutMs?: number;
  backgroundDrainMaxRounds?: number;
  deferBlackBoxPull?: boolean;
  backgroundProbeDelayMs?: number;
  recoveryTicketId?: string;
  skipRetryQueue?: boolean;
  skipRealtimeResume?: boolean;
}

@Injectable({ providedIn: 'root' })
export class SyncResumeCoordinatorService {
  private readonly logger = inject(LoggerService).category('SyncResume');
  private readonly syncStateService = inject(SyncStateService);
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly sessionManager = inject(SessionManagerService);
  private readonly connectivityRecovery = inject(ConnectivityRecoveryService);
  private readonly retryQueueService = inject(RetryQueueService);
  private readonly realtimePollingService = inject(RealtimePollingService);
  private readonly projectDataService = inject(ProjectDataService);

  private readonly recoveryTicketState = new Map<
    string,
    { createdAt: number; modes: Set<'light' | 'heavy'>; probeCompleted: boolean }
  >();

  async recoverAfterResume(reason: string, options: ResumeRecoverOptions = {}): Promise<void> {
    const startedAt = Date.now();
    const mode = options.mode ?? 'heavy';
    const stage = options.stage ?? 'full';
    const interactionFirstEnabled = FEATURE_FLAGS.RESUME_INTERACTION_FIRST_V1 || options.force === true;
    const allowRemoteProbe = options.allowRemoteProbe ?? mode === 'heavy';
    const force = options.force === true;
    const retryProcessing = options.retryProcessing ?? 'background';
    const skipRetryQueue = options.skipRetryQueue ?? stage === 'compensation';
    const skipRealtimeResume = options.skipRealtimeResume ?? stage === 'compensation';
    const recoveryTicketId = options.recoveryTicketId?.trim() || null;
    const recoveryTicketDedupEnabled = FEATURE_FLAGS.RECOVERY_TICKET_DEDUP_V1;
    const deferBlackBoxPull = options.deferBlackBoxPull ?? true;
    const interactionBudgetMs = Math.max(
      80,
      options.interactionBudgetMs ?? APP_LIFECYCLE_CONFIG.RESUME_INTERACTION_BUDGET_MS
    );
    const skipSessionValidationWithinMs = Math.max(
      0,
      options.skipSessionValidationWithinMs ?? (FEATURE_FLAGS.RESUME_SESSION_SNAPSHOT_V1 ? 10_000 : 0)
    );
    const resumeProbeTimeoutMs = Math.max(200, options.resumeProbeTimeoutMs ?? 1500);
    const backgroundProbeDelayMs = Math.max(0, options.backgroundProbeDelayMs ?? 150);
    const backgroundDrainMaxRounds = Math.max(1, options.backgroundDrainMaxRounds ?? 5);
    const onlineNow = typeof navigator !== 'undefined' ? navigator.onLine : this.syncStateService.syncState().isOnline;
    this.syncStateService.update({ isOnline: onlineNow });

    this.cleanupRecoveryTicketState(startedAt);
    let ticketState: { createdAt: number; modes: Set<'light' | 'heavy'>; probeCompleted: boolean } | null = null;
    let duplicateModeInSameTicket = false;
    if (recoveryTicketId && recoveryTicketDedupEnabled) {
      ticketState = this.recoveryTicketState.get(recoveryTicketId) ?? {
        createdAt: startedAt,
        modes: new Set<'light' | 'heavy'>(),
        probeCompleted: false,
      };
      duplicateModeInSameTicket = ticketState.modes.has(mode);
      this.recoveryTicketState.set(recoveryTicketId, ticketState);
    }

    this.sentryLazyLoader.addBreadcrumb({
      category: 'lifecycle',
      message: 'recovery.step',
      level: 'info',
      data: {
        step: 'sync-recovery-start',
        reason,
        mode,
        stage,
        isOnline: onlineNow,
        interactionFirstEnabled,
        recoveryTicketId,
        deferBlackBoxPull,
        skipRetryQueue,
        skipRealtimeResume
      }
    });

    if (!onlineNow && !force) {
      this.logger.info('页面恢复时处于离线状态，跳过恢复同步', { reason });
      return;
    }

    let session: { valid: boolean; userId?: string; deferred?: boolean; reason?: 'client-unready' } | null = null;
    if (options.sessionValidated !== true) {
      if (skipSessionValidationWithinMs > 0) {
        const snapshot = this.sessionManager.getRecentValidationSnapshot(skipSessionValidationWithinMs);
        if (snapshot?.valid) {
          session = { valid: true, userId: snapshot.userId };
        }
      }

      // light/heavy 都执行会话校验，确保恢复链路在无效会话下快速退出
      session = session ?? await this.sessionManager.validateSession();
      if (session.deferred) {
        const delayMs = Math.max(100, getRemainingBrowserNetworkResumeDelayMs() + 50);
        this.connectivityRecovery.scheduleConnectivityRecovery(`${reason}:session-deferred`, delayMs);
        this.logger.info('页面恢复时会话校验延后，跳过本轮远端恢复链路', {
          reason,
          mode,
          delayMs,
          deferredReason: session.reason ?? 'client-unready',
        });
        return;
      }

      if (!session.valid && !force) {
        this.logger.info('页面恢复时会话无效，跳过远端恢复链路', { reason, mode });
        return;
      }
    }

    this.connectivityRecovery.cancelScheduledRecovery();

    const remoteReady = await this.connectivityRecovery.probeRemoteReachability(
      reason,
      Math.max(SYNC_CONFIG.CONNECTIVITY_PROBE_TIMEOUT, resumeProbeTimeoutMs),
      true
    );
    if (!remoteReady) {
      this.connectivityRecovery.scheduleConnectivityRecovery(reason);
      return;
    }

    // 1) 先处理离线积压队列
    if (!skipRetryQueue && this.retryQueueService.length > 0) {
      const retrySlice = Math.max(1, APP_LIFECYCLE_CONFIG.RESUME_RETRY_SLICE_MAX_ITEMS);
      this.sentryLazyLoader.addBreadcrumb({
        category: 'lifecycle',
        message: 'recovery.step',
        level: 'info',
        data: {
          step: 'retry-queue-process',
          reason,
          mode,
          stage,
          pendingCount: this.retryQueueService.length,
          retrySlice,
          retryProcessing,
          interactionBudgetMs
        }
      });

      if (retryProcessing === 'blocking') {
        await this.retryQueueService.processQueueSlice({
          maxItems: retrySlice,
          maxDurationMs: interactionBudgetMs
        });
      } else {
        const firstSlice = await this.retryQueueService.processQueueSlice({
          maxItems: retrySlice,
          maxDurationMs: interactionBudgetMs
        });
        if (!firstSlice.completed) {
          this.scheduleRetryQueueContinuation(
            reason,
            mode,
            retrySlice,
            interactionBudgetMs,
            backgroundDrainMaxRounds
          );
        }
      }
    }

    // 2) 恢复实时更新状态（若之前被暂停），并在 heavy 下探测远端变更
    if (!skipRealtimeResume) {
      await this.realtimePollingService.resumeTransport();
      this.realtimePollingService.resumeRealtimeUpdates();
    }

    if (duplicateModeInSameTicket) {
      this.sentryLazyLoader.addBreadcrumb({
        category: 'lifecycle',
        message: 'recovery.step',
        level: 'info',
        data: {
          step: 'ticket-duplicate-mode-skipped',
          reason,
          mode,
          stage,
          recoveryTicketId,
        }
      });
      this.logger.debug('同一 recovery ticket 重复恢复已跳过主流程', { reason, mode, stage, recoveryTicketId });
    }

    if (ticketState && !duplicateModeInSameTicket) {
      ticketState.modes.add(mode);
    }

    // light 模式只做本地状态恢复，不触发远端探测
    if (mode === 'heavy' && allowRemoteProbe && !duplicateModeInSameTicket && !(ticketState?.probeCompleted)) {
      const currentProjectId = this.realtimePollingService.getCurrentProjectId();
      const payload = {
        eventType: 'resume',
        projectId: currentProjectId ?? undefined
      };
      const firstProbe = await this.triggerRemoteProbeWithTimeout(payload, resumeProbeTimeoutMs);
      let triggered = firstProbe.triggered;
      const hasCallback = this.realtimePollingService.hasRemoteChangeCallback();

      if (!triggered && hasCallback && !firstProbe.timedOut) {
        this.sentryLazyLoader.addBreadcrumb({
          category: 'lifecycle',
          message: 'recovery.step',
          level: 'info',
          data: { step: 'remote-probe-retry', reason, mode }
        });
        const retryProbe = await this.triggerRemoteProbeWithTimeout(payload, resumeProbeTimeoutMs);
        triggered = retryProbe.triggered;
      }

      if (!triggered && firstProbe.timedOut && hasCallback) {
        setTimeout(() => {
          void this.realtimePollingService.triggerRemoteChange(payload);
        }, backgroundProbeDelayMs);
        this.sentryLazyLoader.addBreadcrumb({
          category: 'lifecycle',
          message: 'recovery.step',
          level: 'info',
          data: {
            step: 'remote-probe-timeout-background-fallback',
            reason,
            mode,
            stage,
            recoveryTicketId,
            backgroundProbeDelayMs
          }
        });
      }

      // 3) 灰度开关关闭时保留旧兜底；开启后禁止全量 loadProjectsFromCloud
      if (!triggered) {
        if (!interactionFirstEnabled) {
          this.sentryLazyLoader.addBreadcrumb({
            category: 'lifecycle',
            message: 'recovery.step',
            level: 'info',
            data: { step: 'fallback-cloud-load', reason, mode }
          });

          const fallbackSession = session ?? await this.sessionManager.validateSession();
          if (fallbackSession.valid && fallbackSession.userId) {
            await this.projectDataService.loadProjectsFromCloud(fallbackSession.userId);
          }
        } else if (!hasCallback) {
          this.sentryLazyLoader.addBreadcrumb({
            category: 'lifecycle',
            message: 'recovery.step',
            level: 'info',
            data: {
              step: 'skip-fallback-no-callback',
              reason,
              mode,
              stage
            }
          });
          this.logger.info('恢复链路未注册远端回调，已跳过全量云端加载兜底', { reason, mode });
        }
      }

      if (ticketState) {
        ticketState.probeCompleted = triggered || firstProbe.timedOut;
      }
    } else if (mode === 'heavy' && ticketState?.probeCompleted) {
      this.sentryLazyLoader.addBreadcrumb({
        category: 'lifecycle',
        message: 'recovery.step',
        level: 'info',
        data: {
          step: 'remote-probe-skipped-ticket-probed',
          reason,
          mode,
          stage,
          recoveryTicketId
        }
      });
    }

    this.sentryLazyLoader.addBreadcrumb({
      category: 'lifecycle',
      message: 'recovery.step',
      level: 'info',
      data: {
        step: 'sync-recovery-complete',
        reason,
        mode,
        stage,
        elapsedMs: Date.now() - startedAt
      }
    });
  }

  private cleanupRecoveryTicketState(nowMs: number): void {
    if (this.recoveryTicketState.size === 0) {
      return;
    }

    const ttlMs = APP_LIFECYCLE_CONFIG.RESUME_HEAVY_COOLDOWN_MS * 4;
    const expiredTicketIds: string[] = [];
    this.recoveryTicketState.forEach((state, ticketId) => {
      if (nowMs - state.createdAt > ttlMs) {
        expiredTicketIds.push(ticketId);
      }
    });
    expiredTicketIds.forEach(ticketId => {
      this.recoveryTicketState.delete(ticketId);
    });
  }

  private scheduleRetryQueueContinuation(
    reason: string,
    mode: 'light' | 'heavy',
    retrySlice: number,
    maxDurationMs: number,
    maxRounds: number,
    round = 1
  ): void {
    if (round > maxRounds) {
      this.sentryLazyLoader.addBreadcrumb({
        category: 'lifecycle',
        message: 'recovery.step',
        level: 'warning',
        data: {
          step: 'retry-queue-background-drain-max-rounds',
          reason,
          mode,
          maxRounds
        }
      });
      return;
    }

    const backoffDelaysMs = [200, 500, 1000, 1000, 1000];
    const backoffMs = backoffDelaysMs[Math.min(round - 1, backoffDelaysMs.length - 1)];
    const runSlice = () => {
      void this.retryQueueService.processQueueSlice({
        maxItems: retrySlice,
        maxDurationMs
      }).then((result) => {
        if (!result.completed && result.remaining > 0) {
          this.scheduleRetryQueueContinuation(reason, mode, retrySlice, maxDurationMs, maxRounds, round + 1);
          return;
        }

        this.sentryLazyLoader.addBreadcrumb({
          category: 'lifecycle',
          message: 'recovery.step',
          level: 'info',
          data: {
            step: 'retry-queue-background-drain',
            reason,
            mode,
            remaining: result.remaining,
            processed: result.processed,
            durationMs: result.durationMs,
            round
          }
        });
      }).catch((error) => {
        this.logger.warn('恢复链路后台重试切片失败', { reason, mode, error });
        this.scheduleRetryQueueContinuation(reason, mode, retrySlice, maxDurationMs, maxRounds, round + 1);
      });
    };

    if (typeof window !== 'undefined' && typeof (window as Window & { requestIdleCallback?: unknown }).requestIdleCallback === 'function') {
      (
        window as Window & {
          requestIdleCallback: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
        }
      ).requestIdleCallback(() => runSlice(), { timeout: backoffMs });
      return;
    }
    setTimeout(runSlice, backoffMs);
  }

  private async triggerRemoteProbeWithTimeout(
    payload: { eventType?: string; projectId?: string },
    timeoutMs: number
  ): Promise<{ triggered: boolean; timedOut: boolean }> {
    try {
      const result = await Promise.race([
        this.realtimePollingService.triggerRemoteChange(payload).then(triggered => ({
          triggered,
          timedOut: false
        })),
        new Promise<{ triggered: false; timedOut: true }>((resolve) =>
          setTimeout(() => resolve({ triggered: false, timedOut: true }), timeoutMs)
        )
      ]);
      return result;
    } catch {
      return { triggered: false, timedOut: false };
    }
  }
}
