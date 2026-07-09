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
import { SyncResumeBackgroundTaskScheduler } from './sync-resume-background-task-scheduler';
import { SyncResumeRetryContinuationController } from './sync-resume-retry-continuation.controller';

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

type ResumeRecoveryMode = NonNullable<ResumeRecoverOptions['mode']>;
type ResumeRecoveryStage = NonNullable<ResumeRecoverOptions['stage']>;
type ResumeRetryProcessing = NonNullable<ResumeRecoverOptions['retryProcessing']>;

interface RecoveryTicketState {
  createdAt: number;
  modes: Set<ResumeRecoveryMode>;
  activeModes: Set<ResumeRecoveryMode>;
  probeCompleted: boolean;
}

interface RecoveryTicketContext {
  ticketState: RecoveryTicketState | null;
  duplicateModeInSameTicket: boolean;
}

interface ResumeRecoveryContext {
  reason: string;
  options: ResumeRecoverOptions;
  startedAt: number;
  mode: ResumeRecoveryMode;
  stage: ResumeRecoveryStage;
  interactionFirstEnabled: boolean;
  allowRemoteProbe: boolean;
  force: boolean;
  retryProcessing: ResumeRetryProcessing;
  skipRetryQueue: boolean;
  skipRealtimeResume: boolean;
  recoveryTicketId: string | null;
  recoveryTicketDedupEnabled: boolean;
  deferBlackBoxPull: boolean;
  interactionBudgetMs: number;
  skipSessionValidationWithinMs: number;
  resumeProbeTimeoutMs: number;
  backgroundProbeDelayMs: number;
  backgroundDrainMaxRounds: number;
  onlineNow: boolean;
}

type ResumeSessionValidation = Awaited<ReturnType<SessionManagerService['validateSession']>>;

interface ResumeSessionGate {
  shouldContinue: boolean;
  session: ResumeSessionValidation | null;
}

interface RemoteProbeWithTimeoutResult {
  triggered: boolean;
  timedOut: boolean;
  completion: Promise<boolean>;
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

  private readonly recoveryTicketState = new Map<string, RecoveryTicketState>();
  private readonly backgroundTasks = new SyncResumeBackgroundTaskScheduler({
    onTaskError: (source, error) => {
      this.logger.warn('页面恢复后台任务异常，已隔离调度器回调失败', { source, error });
    },
  });
  private readonly retryContinuation = new SyncResumeRetryContinuationController({
    addBreadcrumb: (breadcrumb) => this.sentryLazyLoader.addBreadcrumb(breadcrumb),
    logger: this.logger,
    processQueueSlice: (options) => this.retryQueueService.processQueueSlice(options),
    scheduleRetryContinuation: (runSlice, backoffMs) =>
      this.backgroundTasks.scheduleRetryContinuation(runSlice, backoffMs),
  });
  private remoteProbeFallbackGeneration = 0;
  /** 主恢复链路的 newest-wins 代际：新恢复启动后，仍在途的旧恢复在下一个阶段边界让位 */
  private recoveryFlightGeneration = 0;

  cancelPendingBackgroundRecovery(options: {
    preserveRetryContinuation?: boolean;
    preserveRemoteProbeFallback?: boolean;
  } = {}): void {
    if (!options.preserveRetryContinuation) {
      this.retryContinuation.cancelPendingContinuations();
      this.backgroundTasks.cancelRetryContinuation();
    }
    if (!options.preserveRemoteProbeFallback) {
      this.remoteProbeFallbackGeneration += 1;
      this.backgroundTasks.cancelRemoteProbeFallback();
    }
  }

  async recoverAfterResume(reason: string, options: ResumeRecoverOptions = {}): Promise<void> {
    const context = this.createResumeRecoveryContext(reason, options);
    this.syncStateService.update({
      isOnline: context.onlineNow,
      ...(context.onlineNow ? {} : { offlineMode: true }),
    });
    const ticketContext = this.initializeRecoveryTicket(context);
    this.addRecoveryStartBreadcrumb(context);

    if (ticketContext.duplicateModeInSameTicket) {
      this.addDuplicateTicketBreadcrumb(context, ticketContext);
      this.addRecoveryCompleteBreadcrumb(context);
      return;
    }

    // newest-wins：新恢复流程启动即取代旧的在途恢复（与下面 cancelPendingBackgroundRecovery 的语义一致），
    // 旧恢复在下一个 await 阶段边界让位，避免超时/迟到的恢复与新恢复并发跑重试队列、transport 恢复和远端探测。
    // 例外：不做远端探测的恢复（light / allowRemoteProbe=false）必须保留旧 heavy 恢复已排队的
    // probe 兜底，否则慢网唤醒场景（visibility heavy 超时排兜底 → online light 立即取消）
    // 会让两次 resume 信号最终一次远端增量拉取都没有，数据陈旧要等到心跳/轮询周期才能纠正
    const flightGeneration = ++this.recoveryFlightGeneration;
    const willRunOwnRemoteProbe = context.mode === 'heavy' && context.allowRemoteProbe;
    this.cancelPendingBackgroundRecovery({
      preserveRetryContinuation: context.skipRetryQueue,
      preserveRemoteProbeFallback: !willRunOwnRemoteProbe,
    });

    try {
      if (!this.ensureOnlineForRecovery(context)) return;

      const sessionGate = await this.resolveRecoverySession(context);
      if (this.isRecoveryFlightSuperseded(flightGeneration, context, 'session-gate')) return;
      if (!sessionGate.shouldContinue) return;
      this.connectivityRecovery.cancelScheduledRecovery();

      if (!(await this.ensureRecoveryRemoteReady(context))) return;
      if (this.isRecoveryFlightSuperseded(flightGeneration, context, 'remote-ready')) return;

      await this.processResumeRetryQueue(context);
      if (this.isRecoveryFlightSuperseded(flightGeneration, context, 'retry-queue')) return;

      // 2) 恢复实时更新状态（若之前被暂停），并在 heavy 下探测远端变更
      await this.resumeRealtimeAfterRecovery(context);
      if (this.isRecoveryFlightSuperseded(flightGeneration, context, 'realtime-resume')) return;

      // light 模式只做本地状态恢复，不触发远端探测
      const recoveryModeCompleted = await this.runResumeRemoteProbe(context, ticketContext);
      if (recoveryModeCompleted) {
        this.markRecoveryTicketMode(context, ticketContext);
      }
      this.addRecoveryCompleteBreadcrumb(context);
    } finally {
      this.releaseActiveRecoveryTicketMode(context, ticketContext);
      this.connectivityRecovery.flushPendingConnectivityRecovery(context.reason);
    }
  }

  /**
   * Sentry breadcrumb 是 best-effort 观测：SDK/beforeBreadcrumb 钩子抛错不得中断恢复链路，
   * 更不得让 initializeRecoveryTicket 预留的 activeModes 因 finally 未进入而泄漏
   * （泄漏会让同 ticket 的后续恢复被 duplicateModeInSameTicket 永久短路，直到 TTL 清理）
   */
  private safeAddBreadcrumb(
    breadcrumb: Parameters<SentryLazyLoaderService['addBreadcrumb']>[0],
  ): void {
    try {
      this.sentryLazyLoader.addBreadcrumb(breadcrumb);
    } catch {
      // Breadcrumbs must never alter resume recovery flow.
    }
  }

  private isRecoveryFlightSuperseded(
    flightGeneration: number,
    context: ResumeRecoveryContext,
    phase: string,
  ): boolean {
    if (flightGeneration === this.recoveryFlightGeneration) {
      return false;
    }
    this.safeAddBreadcrumb({
      category: 'lifecycle',
      message: 'recovery.step',
      level: 'info',
      data: {
        step: 'recovery-superseded-by-newer-flight',
        reason: context.reason,
        mode: context.mode,
        stage: context.stage,
        phase,
        recoveryTicketId: context.recoveryTicketId,
      }
    });
    this.logger.info('页面恢复链路已被更新的恢复流程取代，提前让位', {
      reason: context.reason,
      mode: context.mode,
      stage: context.stage,
      phase,
    });
    return true;
  }

  private createResumeRecoveryContext(reason: string, options: ResumeRecoverOptions): ResumeRecoveryContext {
    const startedAt = Date.now();
    const mode = options.mode ?? 'heavy';
    const stage = options.stage ?? 'full';
    return {
      reason,
      options,
      startedAt,
      mode,
      stage,
      interactionFirstEnabled: FEATURE_FLAGS.RESUME_INTERACTION_FIRST_V1 || options.force === true,
      allowRemoteProbe: options.allowRemoteProbe ?? mode === 'heavy',
      force: options.force === true,
      retryProcessing: options.retryProcessing ?? 'background',
      skipRetryQueue: options.skipRetryQueue ?? stage === 'compensation',
      skipRealtimeResume: options.skipRealtimeResume ?? stage === 'compensation',
      recoveryTicketId: options.recoveryTicketId?.trim() || null,
      recoveryTicketDedupEnabled: FEATURE_FLAGS.RECOVERY_TICKET_DEDUP_V1,
      deferBlackBoxPull: options.deferBlackBoxPull ?? true,
      interactionBudgetMs: Math.max(
        80,
        options.interactionBudgetMs ?? APP_LIFECYCLE_CONFIG.RESUME_INTERACTION_BUDGET_MS
      ),
      skipSessionValidationWithinMs: Math.max(
        0,
        options.skipSessionValidationWithinMs ?? (FEATURE_FLAGS.RESUME_SESSION_SNAPSHOT_V1 ? 10_000 : 0)
      ),
      resumeProbeTimeoutMs: Math.max(200, options.resumeProbeTimeoutMs ?? 1500),
      backgroundProbeDelayMs: Math.max(0, options.backgroundProbeDelayMs ?? 150),
      backgroundDrainMaxRounds: Math.max(1, options.backgroundDrainMaxRounds ?? 5),
      onlineNow: typeof navigator !== 'undefined' ? navigator.onLine : this.syncStateService.syncState().isOnline,
    };
  }

  private initializeRecoveryTicket(context: ResumeRecoveryContext): RecoveryTicketContext {
    this.cleanupRecoveryTicketState(context.startedAt);
    if (!context.recoveryTicketId || !context.recoveryTicketDedupEnabled) {
      return { ticketState: null, duplicateModeInSameTicket: false };
    }

    const ticketState = this.recoveryTicketState.get(context.recoveryTicketId) ?? {
      createdAt: context.startedAt,
      modes: new Set<ResumeRecoveryMode>(),
      activeModes: new Set<ResumeRecoveryMode>(),
      probeCompleted: false,
    };
    const duplicateModeInSameTicket = ticketState.modes.has(context.mode)
      || ticketState.activeModes.has(context.mode);
    if (!duplicateModeInSameTicket) {
      ticketState.activeModes.add(context.mode);
    }
    this.recoveryTicketState.set(context.recoveryTicketId, ticketState);
    return { ticketState, duplicateModeInSameTicket };
  }

  private addRecoveryStartBreadcrumb(context: ResumeRecoveryContext): void {
    this.safeAddBreadcrumb({
      category: 'lifecycle',
      message: 'recovery.step',
      level: 'info',
      data: {
        step: 'sync-recovery-start',
        reason: context.reason,
        mode: context.mode,
        stage: context.stage,
        isOnline: context.onlineNow,
        interactionFirstEnabled: context.interactionFirstEnabled,
        recoveryTicketId: context.recoveryTicketId,
        deferBlackBoxPull: context.deferBlackBoxPull,
        skipRetryQueue: context.skipRetryQueue,
        skipRealtimeResume: context.skipRealtimeResume
      }
    });
  }

  private ensureOnlineForRecovery(context: ResumeRecoveryContext): boolean {
    if (context.onlineNow || context.force) return true;
    this.logger.info('页面恢复时处于离线状态，跳过恢复同步', { reason: context.reason });
    return false;
  }

  private async resolveRecoverySession(context: ResumeRecoveryContext): Promise<ResumeSessionGate> {
    if (context.options.sessionValidated === true) {
      return { shouldContinue: true, session: null };
    }

    let session: ResumeSessionValidation | null = null;
    if (context.skipSessionValidationWithinMs > 0) {
      const snapshot = this.sessionManager.getRecentValidationSnapshot(context.skipSessionValidationWithinMs);
      if (snapshot?.valid) {
        session = { valid: true, userId: snapshot.userId };
      }
    }

    if (session) {
      return { shouldContinue: true, session };
    }

    const resumeSession = await this.sessionManager.validateOrRefreshOnResume(context.reason);
    if (resumeSession.deferred) {
      const delayMs = Math.max(100, getRemainingBrowserNetworkResumeDelayMs() + 50);
      this.connectivityRecovery.scheduleConnectivityRecovery(`${context.reason}:session-deferred`, delayMs);
      this.logger.info('页面恢复时会话校验延后，跳过本轮远端恢复链路', {
        reason: context.reason,
        mode: context.mode,
        delayMs,
        deferredReason: resumeSession.reason ?? 'client-unready',
      });
      return {
        shouldContinue: false,
        session: { valid: false, deferred: true, reason: 'client-unready' },
      };
    }

    if (!resumeSession.ok && !context.force) {
      this.logger.info('页面恢复时会话无效，跳过远端恢复链路', {
        reason: context.reason,
        mode: context.mode,
        sessionReason: resumeSession.reason,
      });
      return { shouldContinue: false, session: { valid: false } };
    }

    return { shouldContinue: true, session: null };
  }

  private async ensureRecoveryRemoteReady(context: ResumeRecoveryContext): Promise<boolean> {
    const remoteReady = await this.connectivityRecovery.probeRemoteReachability(
      context.reason,
      Math.max(SYNC_CONFIG.CONNECTIVITY_PROBE_TIMEOUT, context.resumeProbeTimeoutMs),
      true
    );
    if (remoteReady) return true;
    this.connectivityRecovery.scheduleConnectivityRecovery(
      context.reason,
      SYNC_CONFIG.CONNECTIVITY_PROBE_INTERVAL,
    );
    return false;
  }

  private async processResumeRetryQueue(context: ResumeRecoveryContext): Promise<void> {
    if (context.skipRetryQueue || this.retryQueueService.length <= 0) {
      return;
    }

    const retrySlice = Math.max(1, APP_LIFECYCLE_CONFIG.RESUME_RETRY_SLICE_MAX_ITEMS);
    this.addRetryQueueProcessBreadcrumb(context, retrySlice);
    if (context.retryProcessing === 'blocking') {
      await this.processBlockingRetryQueueSlices(context, retrySlice);
      return;
    }

    await this.processFirstBackgroundRetrySlice(context, retrySlice);
  }

  private async processBlockingRetryQueueSlices(
    context: ResumeRecoveryContext,
    retrySlice: number,
  ): Promise<void> {
    for (let round = 0; round < context.backgroundDrainMaxRounds; round += 1) {
      const result = await this.retryQueueService.processQueueSlice({
        maxItems: retrySlice,
        maxDurationMs: context.interactionBudgetMs
      });
      if (result.completed || result.remaining <= 0) {
        return;
      }
    }
  }

  private addRetryQueueProcessBreadcrumb(context: ResumeRecoveryContext, retrySlice: number): void {
    this.safeAddBreadcrumb({
      category: 'lifecycle',
      message: 'recovery.step',
      level: 'info',
      data: {
        step: 'retry-queue-process',
        reason: context.reason,
        mode: context.mode,
        stage: context.stage,
        pendingCount: this.retryQueueService.length,
        retrySlice,
        retryProcessing: context.retryProcessing,
        interactionBudgetMs: context.interactionBudgetMs
      }
    });
  }

  private async processFirstBackgroundRetrySlice(
    context: ResumeRecoveryContext,
    retrySlice: number,
  ): Promise<void> {
    await this.retryContinuation.processFirstBackgroundRetrySlice({
      reason: context.reason,
      mode: context.mode,
      retrySlice,
      maxDurationMs: context.interactionBudgetMs,
      maxRounds: context.backgroundDrainMaxRounds,
    });
  }

  private async resumeRealtimeAfterRecovery(context: ResumeRecoveryContext): Promise<void> {
    if (context.skipRealtimeResume) {
      return;
    }
    try {
      await this.realtimePollingService.resumeTransport();
    } catch (error) {
      this.logger.warn('页面恢复时 Realtime 传输恢复失败，继续执行远端 probe', {
        reason: context.reason,
        mode: context.mode,
        stage: context.stage,
        error,
      });
    }
    this.realtimePollingService.resumeRealtimeUpdates();
  }

  private addDuplicateTicketBreadcrumb(
    context: ResumeRecoveryContext,
    ticketContext: RecoveryTicketContext,
  ): void {
    if (!ticketContext.duplicateModeInSameTicket) return;
    this.safeAddBreadcrumb({
      category: 'lifecycle',
      message: 'recovery.step',
      level: 'info',
      data: {
        step: 'ticket-duplicate-mode-skipped',
        reason: context.reason,
        mode: context.mode,
        stage: context.stage,
        recoveryTicketId: context.recoveryTicketId,
      }
    });
    this.logger.debug('同一 recovery ticket 重复恢复已跳过主流程', {
      reason: context.reason,
      mode: context.mode,
      stage: context.stage,
      recoveryTicketId: context.recoveryTicketId,
    });
  }

  private markRecoveryTicketMode(context: ResumeRecoveryContext, ticketContext: RecoveryTicketContext): void {
    if (ticketContext.ticketState && !ticketContext.duplicateModeInSameTicket) {
      ticketContext.ticketState.modes.add(context.mode);
    }
  }

  private markRecoveryTicketProbeCompleted(
    context: ResumeRecoveryContext,
    ticketContext: RecoveryTicketContext,
  ): void {
    if (ticketContext.ticketState && !ticketContext.duplicateModeInSameTicket) {
      ticketContext.ticketState.probeCompleted = true;
      this.markRecoveryTicketMode(context, ticketContext);
    }
  }

  private releaseActiveRecoveryTicketMode(
    context: ResumeRecoveryContext,
    ticketContext: RecoveryTicketContext,
  ): void {
    if (ticketContext.ticketState && !ticketContext.duplicateModeInSameTicket) {
      ticketContext.ticketState.activeModes.delete(context.mode);
    }
  }

  private async runResumeRemoteProbe(
    context: ResumeRecoveryContext,
    ticketContext: RecoveryTicketContext,
  ): Promise<boolean> {
    if (this.shouldRunResumeRemoteProbe(context, ticketContext)) {
      return this.runHeavyResumeRemoteProbe(context, ticketContext);
    }
    this.addTicketProbeSkippedBreadcrumb(context, ticketContext);
    return true;
  }

  private shouldRunResumeRemoteProbe(
    context: ResumeRecoveryContext,
    ticketContext: RecoveryTicketContext,
  ): boolean {
    return context.mode === 'heavy'
      && context.allowRemoteProbe
      && !ticketContext.duplicateModeInSameTicket
      && !(ticketContext.ticketState?.probeCompleted);
  }

  private async runHeavyResumeRemoteProbe(
    context: ResumeRecoveryContext,
    ticketContext: RecoveryTicketContext,
  ): Promise<boolean> {
    const fallbackGeneration = ++this.remoteProbeFallbackGeneration;
    const payload = this.buildResumeRemoteProbePayload();
    const firstProbe = await this.triggerRemoteProbeWithTimeout(payload, context.resumeProbeTimeoutMs);
    let triggered = firstProbe.triggered;
    let timedOutProbeTriggered = false;
    const hasCallback = this.realtimePollingService.hasRemoteChangeCallback();

    if (firstProbe.timedOut) {
      void firstProbe.completion.then(completed => {
        timedOutProbeTriggered = completed;
        if (completed && fallbackGeneration === this.remoteProbeFallbackGeneration) {
          this.markRecoveryTicketProbeCompleted(context, ticketContext);
        }
      });
    }

    // 重试探测与超时兜底同属"老 ticket 补发 probe"，必须同样受代际守卫：
    // 首次探测 await 期间若有更新的 heavy 恢复启动（代际已推进），老 ticket 不得再补发网络探测
    if (!triggered && hasCallback && !firstProbe.timedOut
      && fallbackGeneration === this.remoteProbeFallbackGeneration) {
      triggered = await this.retryResumeRemoteProbe(context, payload);
    }

    const backgroundFallbackScheduled = !triggered && firstProbe.timedOut && hasCallback;
    if (backgroundFallbackScheduled) {
      this.scheduleRemoteProbeBackgroundFallback(
        context,
        payload,
        fallbackGeneration,
        () => timedOutProbeTriggered,
        () => this.markRecoveryTicketProbeCompleted(context, ticketContext),
      );
    }

    if (!triggered && !backgroundFallbackScheduled) {
      await this.handleUntriggeredRemoteProbeFallback(context, hasCallback);
    }

    if (triggered) {
      this.markRecoveryTicketProbeCompleted(context, ticketContext);
      return true;
    }

    return !backgroundFallbackScheduled;
  }

  private buildResumeRemoteProbePayload(): { eventType?: string; projectId?: string } {
    const currentProjectId = this.realtimePollingService.getCurrentProjectId();
    return {
      eventType: 'resume',
      projectId: currentProjectId ?? undefined
    };
  }

  private async retryResumeRemoteProbe(
    context: ResumeRecoveryContext,
    payload: { eventType?: string; projectId?: string },
  ): Promise<boolean> {
    this.safeAddBreadcrumb({
      category: 'lifecycle',
      message: 'recovery.step',
      level: 'info',
      data: { step: 'remote-probe-retry', reason: context.reason, mode: context.mode }
    });
    const retryProbe = await this.triggerRemoteProbeWithTimeout(payload, context.resumeProbeTimeoutMs);
    return retryProbe.triggered;
  }

  private scheduleRemoteProbeBackgroundFallback(
    context: ResumeRecoveryContext,
    payload: { eventType?: string; projectId?: string },
    generation: number,
    shouldSkip?: () => boolean,
    onCompleted?: () => void,
  ): void {
    this.backgroundTasks.scheduleRemoteProbeFallback(() => {
      if (generation !== this.remoteProbeFallbackGeneration || shouldSkip?.()) {
        return;
      }
      void this.realtimePollingService.triggerRemoteChange(payload)
        .then(completed => {
          if (completed && generation === this.remoteProbeFallbackGeneration) {
            onCompleted?.();
          }
        })
        .catch(error => {
          this.logger.warn('恢复链路后台远端 probe 补偿失败', {
            reason: context.reason,
            mode: context.mode,
            error,
          });
        });
    }, context.backgroundProbeDelayMs);
    this.safeAddBreadcrumb({
      category: 'lifecycle',
      message: 'recovery.step',
      level: 'info',
      data: {
        step: 'remote-probe-timeout-background-fallback',
        reason: context.reason,
        mode: context.mode,
        stage: context.stage,
        recoveryTicketId: context.recoveryTicketId,
        backgroundProbeDelayMs: context.backgroundProbeDelayMs
      }
    });
  }

  private async handleUntriggeredRemoteProbeFallback(
    context: ResumeRecoveryContext,
    hasCallback: boolean,
  ): Promise<void> {
    if (!context.interactionFirstEnabled) {
      this.safeAddBreadcrumb({
        category: 'lifecycle',
        message: 'recovery.step',
        level: 'info',
        data: { step: 'fallback-cloud-load', reason: context.reason, mode: context.mode }
      });

      // 全量云端加载兜底前必须重新校验会话：链路前段的 session 快照可能在慢速
      // probe/retry 阶段之后已经过期或发生账号切换，不能拿旧 userId 拉取云端项目
      const fallbackSession = await this.sessionManager.validateSession();
      if (fallbackSession.valid && fallbackSession.userId) {
        await this.projectDataService.loadProjectsFromCloud(fallbackSession.userId);
      }
      return;
    }

    if (!hasCallback) {
      this.safeAddBreadcrumb({
        category: 'lifecycle',
        message: 'recovery.step',
        level: 'info',
        data: {
          step: 'skip-fallback-no-callback',
          reason: context.reason,
          mode: context.mode,
          stage: context.stage
        }
      });
      this.logger.info('恢复链路未注册远端回调，已跳过全量云端加载兜底', {
        reason: context.reason,
        mode: context.mode,
      });
    }
  }

  private addTicketProbeSkippedBreadcrumb(
    context: ResumeRecoveryContext,
    ticketContext: RecoveryTicketContext,
  ): void {
    if (context.mode !== 'heavy' || !ticketContext.ticketState?.probeCompleted) return;
    this.safeAddBreadcrumb({
      category: 'lifecycle',
      message: 'recovery.step',
      level: 'info',
      data: {
        step: 'remote-probe-skipped-ticket-probed',
        reason: context.reason,
        mode: context.mode,
        stage: context.stage,
        recoveryTicketId: context.recoveryTicketId
      }
    });
  }

  private addRecoveryCompleteBreadcrumb(context: ResumeRecoveryContext): void {
    this.safeAddBreadcrumb({
      category: 'lifecycle',
      message: 'recovery.step',
      level: 'info',
      data: {
        step: 'sync-recovery-complete',
        reason: context.reason,
        mode: context.mode,
        stage: context.stage,
        elapsedMs: Date.now() - context.startedAt
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

  private async triggerRemoteProbeWithTimeout(
    payload: { eventType?: string; projectId?: string },
    timeoutMs: number
  ): Promise<RemoteProbeWithTimeoutResult> {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const completion = Promise.resolve()
      .then(() => this.realtimePollingService.triggerRemoteChange(payload))
      .catch(() => false);
    const timeout = new Promise<{ triggered: false; timedOut: true }>((resolve) => {
      timeoutId = setTimeout(() => {
        timeoutId = null;
        resolve({ triggered: false, timedOut: true });
      }, timeoutMs);
    });
    const result = await Promise.race([
      completion.then(triggered => ({
        triggered,
        timedOut: false
      })),
      timeout
    ]);
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    return { ...result, completion };
  }
}
