import { DestroyRef, Injectable, Injector, inject, signal } from '@angular/core';
import { APP_LIFECYCLE_CONFIG } from '../config/app-lifecycle.config';
import { FEATURE_FLAGS } from '../config/feature-flags.config';
import { LoggerService } from './logger.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { ToastService } from './toast.service';
import { NetworkAwarenessService } from './network-awareness.service';
import { SyncResumeCoordinatorService, SessionManagerService, SyncStateService } from '../core-bridge';
import { SyncCoordinatorService } from './sync-coordinator.service';
import { FocusStartupProbeService } from './focus-startup-probe.service';
import {
  createRecoveryTicketId,
  markLifecyclePerformance,
  measureLifecyclePerformance,
  monotonicNow,
  runIdleTask,
  withLifecycleTimeout,
} from './app-lifecycle-timing.helpers';
import {
  isHeavyRecoveryInCooldown,
  isRecoveryCompensationInFlight,
} from './app-lifecycle-recovery-state.helpers';
import { AppLifecycleDeferredResumeController } from './app-lifecycle-deferred-resume.controller';
import { AppLifecycleReloadCoordinator } from './app-lifecycle-reload.coordinator';
import { AppLifecycleBrowserEventsCoordinator } from './app-lifecycle-browser-events.coordinator';
import type {
  AppResumeReason,
  LifecycleRecoveryTicket,
  RecoveryMetricsSnapshot,
  ResumePipelineResult,
} from './app-lifecycle-orchestrator.types';
import {
  buildRecoveryCompensationReport,
  mergeRecoveryMetrics,
  publishRecoveryMetrics,
} from './app-lifecycle-recovery-metrics.helpers';
import { shouldRunFocusGateResumeCheck } from './app-lifecycle-focus-gate.helpers';
import {
  AppLifecycleBreadcrumbsController,
} from './app-lifecycle-breadcrumb.helpers';
import { schedulePendingPersistRecovery } from './app-lifecycle-pending-persist.helpers';
import {
  selectHigherPriorityResumeReason,
  shouldQueueResumeAfterCurrent,
} from './app-lifecycle-resume-queue.helpers';

export type { AppResumeReason, RecoveryMetricsSnapshot } from './app-lifecycle-orchestrator.types';

@Injectable({ providedIn: 'root' })
export class AppLifecycleOrchestratorService {
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('LifecycleOrchestrator');
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly breadcrumbs =
    new AppLifecycleBreadcrumbsController(this.sentryLazyLoader, this.logger);
  private readonly toast = inject(ToastService);
  private readonly networkAwareness = inject(NetworkAwarenessService);
  private readonly syncState = inject(SyncStateService);
  private readonly syncResumeCoordinator = inject(SyncResumeCoordinatorService);
  private readonly sessionManager = inject(SessionManagerService);
  private readonly syncCoordinator = inject(SyncCoordinatorService);
  private readonly reloadCoordinator = inject(AppLifecycleReloadCoordinator);
  private readonly browserEvents = inject(AppLifecycleBrowserEventsCoordinator);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);

  private readonly isResumingSignal = signal(false);
  private readonly lastResumeAtSignal = signal<number | null>(null);
  private readonly lastHeavyRecoveryAtSignal = signal<number | null>(null);
  private readonly lastRecoveryMetricsSignal = signal<RecoveryMetricsSnapshot | null>(null);
  private readonly compensationTicketIdSignal = signal<string | null>(null);
  private readonly currentRecoveryTicketSignal = signal<LifecycleRecoveryTicket | null>(null);

  private resumePromise: Promise<void> | null = null;
  private activeResumeReason: AppResumeReason | null = null;
  private queuedResumeReason: AppResumeReason | null = null;
  private queuedResumePromise: Promise<void> | null = null;
  private consecutiveFailures = 0;
  // 仅用于诊断：会话失败计数永远不会触发 auto-reload（reload 无法修复 no-session 状态）。
  private consecutiveSessionFailures = 0;
  private recoveryCompensationGeneration = 0;
  private destroyed = false;

  private hasPendingVersion = false;
  private hasShownResumeVersionPrompt = false;

  private _focusStartupProbe?: FocusStartupProbeService;
  private readonly deferredResume = new AppLifecycleDeferredResumeController({
    logger: this.logger,
    triggerResume: (reason) => this.triggerResume(reason),
  });

  private get focusStartupProbe(): FocusStartupProbeService {
    return (this._focusStartupProbe ??= this.injector.get(FocusStartupProbeService));
  }

  constructor() {
    this.destroyRef.onDestroy(() => this.cleanup());
  }

  /** 注册 resume/recovery 监听器；必须早于异步启动服务，且保持幂等与 SSR-safe。 */
  initialize(): void {
    this.browserEvents.initialize((reason) => {
      void this.triggerResume(reason);
    });
  }

  markVersionReady(): void {
    this.hasPendingVersion = true;
    this.hasShownResumeVersionPrompt = false;
  }

  isResuming(): boolean {
    return this.isResumingSignal();
  }

  lastResumeAt(): number | null {
    return this.lastResumeAtSignal();
  }

  lastHeavyRecoveryAt(): number | null {
    return this.lastHeavyRecoveryAtSignal();
  }

  getLastRecoveryMetrics(): RecoveryMetricsSnapshot | null {
    return this.lastRecoveryMetricsSignal();
  }

  getCurrentRecoveryTicket(): { id: string; startedAt: number; mode: 'light' | 'heavy' } | null {
    return this.currentRecoveryTicketSignal();
  }

  isRecoveryCompensationInFlight(ticketId?: string): boolean {
    return isRecoveryCompensationInFlight(this.compensationTicketIdSignal(), ticketId);
  }

  isHeavyRecoveryInCooldown(windowMs = APP_LIFECYCLE_CONFIG.RESUME_HEAVY_COOLDOWN_MS): boolean {
    return isHeavyRecoveryInCooldown(this.lastHeavyRecoveryAtSignal(), Date.now(), windowMs);
  }

  async triggerResume(reason: AppResumeReason): Promise<void> {
    if (!FEATURE_FLAGS.LIFECYCLE_RECOVERY_V1) {
      return;
    }
    if (this.destroyed) {
      return;
    }

    if (this.resumePromise) {
      if (shouldQueueResumeAfterCurrent(this.activeResumeReason, reason)) {
        this.queuedResumeReason = selectHigherPriorityResumeReason(this.queuedResumeReason, reason);
        this.queuedResumePromise ??= this.resumePromise
          .then(() => this.runQueuedResume())
          .finally(() => {
            this.queuedResumePromise = null;
          });
        return this.queuedResumePromise;
      }
      return this.resumePromise;
    }

    return this.runResume(reason);
  }

  private async runResume(reason: AppResumeReason): Promise<void> {
    if (this.destroyed) {
      return;
    }
    this.deferredResume.clear();
    this.activeResumeReason = reason;
    this.resumePromise = this.executeResume(reason);
    const currentResumePromise = this.resumePromise;

    try {
      await currentResumePromise;
    } finally {
      if (this.resumePromise === currentResumePromise) {
        this.resumePromise = null;
      }
      if (this.activeResumeReason === reason) {
        this.activeResumeReason = null;
      }
    }
  }

  private async runQueuedResume(): Promise<void> {
    if (this.destroyed) {
      this.queuedResumeReason = null;
      return;
    }
    const reason = this.queuedResumeReason;
    this.queuedResumeReason = null;
    if (!reason) {
      return;
    }
    await this.triggerResume(reason);
  }

  /**
   * 执行 resume 流程。
   *
   * 失败分类（重要）：
   * 1. `pipelineResult.reason === 'no-session' | 'refresh-failed'` —— 会话状态失败：
   *    不计入 `consecutiveFailures`，也不会触发 `maybeScheduleAutoReload`。
   *    原因：reload 不修复 no-session（refresh token 仍在 localStorage；终态失效后重载只会
   *    再次走同一断路），强刷反而破坏未登录用户的当前 UI 状态。这类失败由 `SessionManager`
   *    自身的断路 + "登录已过期" toast 处理。
   * 2. pipeline 抛出运行时异常（catch 分支）—— 真异常：累加 `consecutiveFailures`，
   *    达到阈值后通过 `maybeScheduleAutoReload` 兜底刷新页面。
   */
  private async executeResume(reason: AppResumeReason): Promise<void> {
    const startAt = Date.now();
    const runHeavyRecovery = reason !== 'visibility-quick';
    const recoveryTicket = this.startResumeExecution(reason, startAt, runHeavyRecovery);

    try {
      const pipelineResult = await withLifecycleTimeout(
        this.executeRecoveryPipeline(reason, runHeavyRecovery, recoveryTicket),
        APP_LIFECYCLE_CONFIG.RESUME_TIMEOUT_MS
      );

      if (this.handleDeferredPipelineResult(reason, pipelineResult, startAt)) return;
      if (this.handleSessionPipelineFailure(reason, pipelineResult, startAt)) return;
      this.handleSuccessfulResume(reason, recoveryTicket, pipelineResult, startAt);
    } catch (error) {
      this.handlePipelineException(reason, error, startAt);
    } finally {
      this.currentRecoveryTicketSignal.set(null);
      this.isResumingSignal.set(false);
    }
  }

  private startResumeExecution(
    reason: AppResumeReason,
    startAt: number,
    runHeavyRecovery: boolean,
  ): LifecycleRecoveryTicket {
    const recoveryTicket: LifecycleRecoveryTicket = {
      id: createRecoveryTicketId(runHeavyRecovery ? 'heavy' : 'light'),
      startedAt: startAt,
      mode: runHeavyRecovery ? 'heavy' : 'light',
    };
    this.currentRecoveryTicketSignal.set(recoveryTicket);
    markLifecyclePerformance(`nanoflow:resume:${recoveryTicket.id}:start`);
    this.isResumingSignal.set(true);
    this.breadcrumbs.add('lifecycle.resume.start', reason, {
      runHeavyRecovery,
      backgroundDurationMs: this.browserEvents.getLastBackgroundDurationMs(),
      recoveryTicketId: recoveryTicket.id,
    });
    this.breadcrumbs.add('lifecycle.resume.reason', reason);
    return recoveryTicket;
  }

  private handleDeferredPipelineResult(
    reason: AppResumeReason,
    pipelineResult: ResumePipelineResult,
    startAt: number,
  ): boolean {
    if (!pipelineResult.deferred) return false;
    const deferredDelayMs = this.deferredResume.schedule(reason);
    this.breadcrumbs.add('lifecycle.resume.success', reason, {
      elapsedMs: Date.now() - startAt,
      deferred: true,
      deferredReason: pipelineResult.reason ?? 'unknown',
      deferredDelayMs,
    });
    return true;
  }

  private handleSessionPipelineFailure(
    reason: AppResumeReason,
    pipelineResult: ResumePipelineResult,
    startAt: number,
  ): boolean {
    if (pipelineResult.reason !== 'no-session' && pipelineResult.reason !== 'refresh-failed') return false;
    this.handleSessionFailure(reason, pipelineResult.reason, startAt);
    return true;
  }

  private handleSuccessfulResume(
    reason: AppResumeReason,
    recoveryTicket: LifecycleRecoveryTicket,
    pipelineResult: ResumePipelineResult,
    startAt: number,
  ): void {
    this.consecutiveFailures = 0;
    this.consecutiveSessionFailures = 0;
    this.syncState.clearCloudSyncPausedReason();
    this.lastResumeAtSignal.set(Date.now());
    this.reportInteractionReadyMetricIfPresent(reason, recoveryTicket, pipelineResult);
    this.showPendingVersionPromptIfNeeded();
    this.breadcrumbs.add('lifecycle.resume.success', reason, {
      elapsedMs: Date.now() - startAt,
    });
  }

  private reportInteractionReadyMetricIfPresent(
    reason: AppResumeReason,
    recoveryTicket: LifecycleRecoveryTicket,
    pipelineResult: ResumePipelineResult,
  ): void {
    if (typeof pipelineResult.interactionReadyMs !== 'number') return;
    this.reportRecoveryMetrics({
      ticketId: recoveryTicket.id,
      reason,
      interactionReadyMs: pipelineResult.interactionReadyMs,
      fastPathHit: pipelineResult.fastPathHit,
    });
  }

  private showPendingVersionPromptIfNeeded(): void {
    if (
      !this.hasPendingVersion ||
      this.hasShownResumeVersionPrompt ||
      this.browserEvents.getLastBackgroundDurationMs() < APP_LIFECYCLE_CONFIG.NEW_VERSION_PROMPT_THRESHOLD_MS
    ) {
      return;
    }

    this.hasShownResumeVersionPrompt = true;
    this.toast.info('检测到新版本', '页面后台停留较久，建议刷新以获得最新稳定版本', {
      duration: 0,
      action: {
        label: '立即刷新',
        pendingLabel: '正在刷新…',
        onClick: () => this.reloadCoordinator.triggerVersionReload(
          (message, breadcrumbReason, extra) => this.breadcrumbs.add(message, breadcrumbReason, extra),
          () => {
            this.hasShownResumeVersionPrompt = false;
          },
        ),
      },
    });
  }

  /**
   * 处理会话校验/刷新失败（no-session / refresh-failed）。
   *
   * 重要：不计入 `consecutiveFailures`，不会触发 auto-reload。
   * 仅维护 `consecutiveSessionFailures` 用于诊断，并写入 breadcrumb。
   */
  private handleSessionFailure(
    reason: AppResumeReason,
    failureKind: 'no-session' | 'refresh-failed',
    startAt: number
  ): void {
    this.consecutiveSessionFailures += 1;
    this.syncState.setCloudSyncPausedReason(failureKind);
    this.breadcrumbs.add('lifecycle.resume.fail', reason, {
      elapsedMs: Date.now() - startAt,
      failureKind,
      // 保留 sessionFailureReason 以兼容已存在的 Sentry 查询/告警；新代码应优先使用 failureKind。
      sessionFailureReason: failureKind,
      consecutiveSessionFailures: this.consecutiveSessionFailures,
    });
  }

  /**
   * 处理 resume pipeline 抛出的运行时异常（真异常）。
   * 累加 `consecutiveFailures`，达到阈值时通过 `maybeScheduleAutoReload` 兜底刷新。
   */
  private handlePipelineException(
    reason: AppResumeReason,
    error: unknown,
    startAt: number
  ): void {
    this.consecutiveFailures += 1;

    // 超时/异常意味着本轮恢复已宣告失败：取消协调器为本轮排下的后台探测与重试延续，
    // 避免 stale 后台任务在 UI 已复位后继续运行；下一轮恢复会重新排空积压
    try {
      this.syncResumeCoordinator.cancelPendingBackgroundRecovery();
    } catch (cancelError) {
      this.logger.warn('取消恢复协调器后台任务失败（已隔离）', { reason, cancelError });
    }

    this.breadcrumbs.add('lifecycle.resume.fail', reason, {
      elapsedMs: Date.now() - startAt,
      failureKind: 'pipeline-exception',
      consecutiveFailures: this.consecutiveFailures,
    });

    this.sentryLazyLoader.captureException(error, {
      operation: 'lifecycle.resume',
      reason,
      consecutiveFailures: this.consecutiveFailures,
    });

    this.logger.warn('Resume pipeline failed', {
      reason,
      consecutiveFailures: this.consecutiveFailures,
      error,
    });

    this.reloadCoordinator.maybeScheduleAutoReload(reason, error, this.consecutiveFailures);
  }

  private async executeRecoveryPipeline(
    reason: AppResumeReason,
    heavy: boolean,
    recoveryTicket: LifecycleRecoveryTicket
  ): Promise<ResumePipelineResult> {
    const recoveryTicketId = recoveryTicket.id;
    const perfPrefix = recoveryTicketId ? `nanoflow:resume:${recoveryTicketId}` : null;

    this.breadcrumbs.recordStep('network-refresh', reason);
    this.networkAwareness.refresh();

    const sessionGate = await this.validateResumeSession(reason);
    if (!this.isResumeExecutionCurrent(recoveryTicket)) {
      return { deferred: false };
    }
    if (sessionGate) return sessionGate;

    this.kickPendingPersistRecovery(reason);
    const interactionReadyMs = await this.runInteractionReadyRecovery(reason, recoveryTicket, perfPrefix);
    if (!this.isResumeExecutionCurrent(recoveryTicket)) {
      return { deferred: false, interactionReadyMs };
    }

    if (!heavy) return { deferred: false, interactionReadyMs };

    if (await this.trySuppressHeavyRecovery(reason)) return { deferred: false, interactionReadyMs };

    if (FEATURE_FLAGS.RESUME_INTERACTION_FIRST_V1) {
      this.scheduleInteractionFirstHeavyRecovery(reason, recoveryTicketId, interactionReadyMs);
      return { deferred: false, interactionReadyMs };
    }

    return this.runLegacyHeavyRecovery(reason, recoveryTicketId, interactionReadyMs);
  }

  private isResumeExecutionCurrent(recoveryTicket: LifecycleRecoveryTicket): boolean {
    return !this.destroyed && this.currentRecoveryTicketSignal()?.id === recoveryTicket.id;
  }

  private async validateResumeSession(reason: AppResumeReason): Promise<ResumePipelineResult | null> {
    this.breadcrumbs.recordStep('session-validate', reason);
    const sessionSnapshot = FEATURE_FLAGS.RESUME_SESSION_SNAPSHOT_V1
      ? this.sessionManager.getRecentValidationSnapshot(10_000)
      : null;
    const session = sessionSnapshot?.valid
      ? { ok: true, refreshed: false, deferred: false, reason: undefined }
      : await this.sessionManager.validateOrRefreshOnResume(`resume:${reason}`);

    if (session.deferred) {
      this.logger.info('Session validation deferred during resume', { reason, deferredReason: session.reason });
      return { deferred: true, reason: session.reason };
    }

    if (!session.ok) {
      this.logger.warn('Session validation failed during resume', { reason, failureReason: session.reason });
      return { deferred: false, reason: session.reason };
    }

    return null;
  }

  private async runInteractionReadyRecovery(
    reason: AppResumeReason,
    recoveryTicket: LifecycleRecoveryTicket,
    perfPrefix: string | null,
  ): Promise<number> {
    const interactionStartAt = monotonicNow();
    const recoveryTicketId = recoveryTicket.id;
    if (FEATURE_FLAGS.RESUME_INTERACTION_FIRST_V1) {
      this.breadcrumbs.recordStep('sync-recovery-light', reason);
      await this.syncResumeCoordinator.recoverAfterResume(reason, {
        mode: 'light',
        stage: 'full',
        allowRemoteProbe: false,
        sessionValidated: true,
        retryProcessing: 'background',
        deferBlackBoxPull: true,
        recoveryTicketId: recoveryTicketId ?? undefined,
      });
    }
    if (!this.isResumeExecutionCurrent(recoveryTicket)) {
      return 0;
    }
    const interactionReadyMs = monotonicNow() - interactionStartAt;
    this.markInteractionReadyPerformance(perfPrefix);
    await this.recheckFocusGateIfNeeded(reason, 'resume-local');
    return interactionReadyMs;
  }

  private markInteractionReadyPerformance(perfPrefix: string | null): void {
    if (!perfPrefix) return;
    markLifecyclePerformance(`${perfPrefix}:interaction-ready`);
    measureLifecyclePerformance('resume.interaction_ready_ms', `${perfPrefix}:start`, `${perfPrefix}:interaction-ready`);
  }

  private async trySuppressHeavyRecovery(reason: AppResumeReason): Promise<boolean> {
    if (
      !FEATURE_FLAGS.RESUME_INTERACTION_FIRST_V1 ||
      !FEATURE_FLAGS.RESUME_PULSE_DEDUP_V1 ||
      !this.isHeavyRecoveryInCooldown()
    ) {
      return false;
    }

    this.breadcrumbs.recordStep('sync-recovery-heavy-suppressed', reason);
    if (this.shouldRecheckFocusGate(reason)) {
      this.breadcrumbs.recordStep('blackbox-recovery', reason);
      await this.syncCoordinator.refreshBlackBoxWatermarkIfNeeded('resume');
      await this.recheckFocusGateIfNeeded(reason, 'resume-remote');
    }
    return true;
  }

  private scheduleInteractionFirstHeavyRecovery(
    reason: AppResumeReason,
    recoveryTicketId: string,
    interactionReadyMs: number,
  ): void {
    this.scheduleRecoveryCompensation(reason, {
      id: recoveryTicketId ?? createRecoveryTicketId('heavy'),
      startedAt: Date.now(),
      mode: 'heavy',
    }, interactionReadyMs);
    this.lastHeavyRecoveryAtSignal.set(Date.now());
  }

  private async runLegacyHeavyRecovery(
    reason: AppResumeReason,
    recoveryTicketId: string,
    interactionReadyMs: number,
  ): Promise<ResumePipelineResult> {
    this.breadcrumbs.recordStep('sync-recovery', reason);
    await this.syncResumeCoordinator.recoverAfterResume(reason, {
      sessionValidated: true,
      retryProcessing: 'background',
      deferBlackBoxPull: true,
      recoveryTicketId: recoveryTicketId ?? undefined,
      backgroundProbeDelayMs: 180,
    });

    this.breadcrumbs.recordStep('blackbox-recovery', reason);
    const blackBoxResult = await this.syncCoordinator.refreshBlackBoxWatermarkIfNeeded('resume');
    await this.recheckFocusGateIfNeeded(reason, 'resume-remote');
    this.dispatchLifecycleResumed(reason);
    this.lastHeavyRecoveryAtSignal.set(Date.now());
    return { deferred: false, interactionReadyMs, fastPathHit: blackBoxResult.skipped };
  }

  private kickPendingPersistRecovery(reason: AppResumeReason): void {
    schedulePendingPersistRecovery(reason, {
      hasPendingLocalChanges: () => this.syncCoordinator.hasPendingLocalChanges(),
      addBreadcrumb: breadcrumb => this.sentryLazyLoader.addBreadcrumb(breadcrumb),
      flushPendingPersistToCloud: persistReason => this.syncCoordinator.flushPendingPersistToCloud(persistReason),
      captureException: (error, context) => this.sentryLazyLoader.captureException(error, context),
      logger: this.logger,
    });
  }

  private scheduleRecoveryCompensation(
    reason: AppResumeReason,
    recoveryTicket: LifecycleRecoveryTicket,
    interactionReadyMs: number
  ): void {
    if (this.destroyed) {
      return;
    }
    if (this.isRecoveryCompensationInFlight()) {
      return;
    }
    const generation = this.recoveryCompensationGeneration;
    this.compensationTicketIdSignal.set(recoveryTicket.id);
    const runCompensation = () => {
      if (this.destroyed || generation !== this.recoveryCompensationGeneration) {
        return;
      }
      void this.runRecoveryCompensation(reason, recoveryTicket, interactionReadyMs, generation);
    };
    const handleSchedulingError = (error: unknown) => {
      if (!this.shouldContinueRecoveryCompensation(recoveryTicket, generation)) {
        return;
      }
      if (this.compensationTicketIdSignal() === recoveryTicket.id) {
        this.compensationTicketIdSignal.set(null);
      }
      this.logger.warn('Resume background compensation scheduling failed', {
        reason,
        recoveryTicketId: recoveryTicket.id,
        error,
      });
    };

    this.scheduleCompensationTask(runCompensation, handleSchedulingError);
  }

  private scheduleCompensationTask(runCompensation: () => void, onScheduleError: (error: unknown) => void): void {
    const scheduleIdle = () => {
      try {
        runIdleTask(runCompensation);
      } catch (error) {
        onScheduleError(error);
      }
    };

    if (typeof queueMicrotask === 'function') {
      try {
        queueMicrotask(() => {
          scheduleIdle();
        });
      } catch (error) {
        onScheduleError(error);
      }
      return;
    }

    scheduleIdle();
  }

  private async runRecoveryCompensation(
    reason: AppResumeReason,
    recoveryTicket: LifecycleRecoveryTicket,
    interactionReadyMs: number,
    generation: number,
  ): Promise<void> {
    if (!this.shouldContinueRecoveryCompensation(recoveryTicket, generation)) {
      return;
    }
    const backgroundStartAt = monotonicNow();
    const perfPrefix = `nanoflow:resume:${recoveryTicket.id}`;
    markLifecyclePerformance(`${perfPrefix}:background-start`);
    let fastPathHit: boolean | undefined;

    try {
      fastPathHit = await this.executeRecoveryCompensationSteps(reason, recoveryTicket, generation);
    } catch (error) {
      if (this.shouldContinueRecoveryCompensation(recoveryTicket, generation)) {
        this.handleRecoveryCompensationError(reason, recoveryTicket, error);
      }
    } finally {
      if (this.shouldContinueRecoveryCompensation(recoveryTicket, generation)) {
        this.finishRecoveryCompensation(reason, recoveryTicket, interactionReadyMs, backgroundStartAt, fastPathHit);
      }
    }
  }

  private async executeRecoveryCompensationSteps(
    reason: AppResumeReason,
    recoveryTicket: LifecycleRecoveryTicket,
    generation: number,
  ): Promise<boolean | undefined> {
    this.breadcrumbs.recordStep('sync-recovery-heavy-compensation', reason);
    await this.syncResumeCoordinator.recoverAfterResume(reason, {
      mode: 'heavy',
      stage: 'compensation',
      allowRemoteProbe: true,
      sessionValidated: true,
      retryProcessing: 'background',
      deferBlackBoxPull: true,
      recoveryTicketId: recoveryTicket.id,
      backgroundProbeDelayMs: 180,
      skipRetryQueue: true,
      skipRealtimeResume: true,
    });
    if (!this.shouldContinueRecoveryCompensation(recoveryTicket, generation)) {
      return undefined;
    }

    this.breadcrumbs.recordStep('blackbox-recovery', reason);
    const blackboxRefresh = await this.syncCoordinator.refreshBlackBoxWatermarkIfNeeded('resume');
    if (!this.shouldContinueRecoveryCompensation(recoveryTicket, generation)) {
      return undefined;
    }
    await this.recheckFocusGateIfNeeded(reason, 'resume-remote');
    if (!this.shouldContinueRecoveryCompensation(recoveryTicket, generation)) {
      return undefined;
    }
    this.dispatchLifecycleResumed(reason);
    this.lastHeavyRecoveryAtSignal.set(Date.now());
    return blackboxRefresh.skipped;
  }

  private shouldContinueRecoveryCompensation(
    recoveryTicket: LifecycleRecoveryTicket,
    generation: number,
  ): boolean {
    return !this.destroyed
      && generation === this.recoveryCompensationGeneration
      && this.compensationTicketIdSignal() === recoveryTicket.id;
  }

  private dispatchLifecycleResumed(reason: AppResumeReason): void {
    this.breadcrumbs.recordStep('ui-correction', reason);
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('nanoflow:lifecycle-resumed', {
      detail: {
        reason,
        resumedAt: Date.now(),
      },
    }));
  }

  private handleRecoveryCompensationError(
    reason: AppResumeReason,
    recoveryTicket: LifecycleRecoveryTicket,
    error: unknown,
  ): void {
    this.logger.warn('Resume background compensation failed', { reason, recoveryTicketId: recoveryTicket.id, error });
    this.sentryLazyLoader.captureException(error, {
      operation: 'lifecycle.resume.compensation',
      reason,
      recoveryTicketId: recoveryTicket.id,
    });
  }

  private finishRecoveryCompensation(
    reason: AppResumeReason,
    recoveryTicket: LifecycleRecoveryTicket,
    interactionReadyMs: number,
    backgroundStartAt: number,
    fastPathHit: boolean | undefined,
  ): void {
    const perfPrefix = `nanoflow:resume:${recoveryTicket.id}`;
    const backgroundRefreshMs = monotonicNow() - backgroundStartAt;
    markLifecyclePerformance(`${perfPrefix}:background-end`);
    measureLifecyclePerformance('resume.background_refresh_ms', `${perfPrefix}:background-start`, `${perfPrefix}:background-end`);
    const metrics = buildRecoveryCompensationReport({
      currentMetrics: this.lastRecoveryMetricsSignal(),
      reason,
      recoveryTicket,
      interactionReadyMs,
      backgroundRefreshMs,
      fastPathHit,
    });
    if (metrics) {
      this.reportRecoveryMetrics(metrics);
    }
    this.compensationTicketIdSignal.set(null);
  }

  private shouldRecheckFocusGate(reason: AppResumeReason): boolean {
    return shouldRunFocusGateResumeCheck(
      FEATURE_FLAGS.FOCUS_STARTUP_THROTTLED_CHECK_V1,
      reason,
      this.browserEvents.getLastBackgroundDurationMs(),
    );
  }

  private async recheckFocusGateIfNeeded(
    reason: AppResumeReason,
    source: 'resume-local' | 'resume-remote'
  ): Promise<void> {
    if (!this.shouldRecheckFocusGate(reason)) {
      return;
    }

    if (source === 'resume-remote' && this.focusStartupProbe.hasPendingGateWork()) {
      this.logger.debug('Skip resume-remote gate recheck because local resume already found pending gate work');
      return;
    }

    await this.focusStartupProbe.recheckGate({
      source,
      reloadLocal: source === 'resume-local',
    });
  }

  private reportRecoveryMetrics(metrics: RecoveryMetricsSnapshot): void {
    const next = mergeRecoveryMetrics(this.lastRecoveryMetricsSignal(), metrics);
    this.lastRecoveryMetricsSignal.set(next);
    publishRecoveryMetrics(next, this.sentryLazyLoader);
  }

  private cleanup(): void {
    this.destroyed = true;
    this.queuedResumeReason = null;
    this.queuedResumePromise = null;
    this.resumePromise = null;
    this.activeResumeReason = null;
    this.deferredResume.clear();
    this.recoveryCompensationGeneration += 1;
    this.currentRecoveryTicketSignal.set(null);
    this.isResumingSignal.set(false);
    this.compensationTicketIdSignal.set(null);

    this.browserEvents.cleanup();
  }
}
