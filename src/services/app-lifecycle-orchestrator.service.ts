import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { APP_LIFECYCLE_CONFIG } from '../config/app-lifecycle.config';
import { FEATURE_FLAGS } from '../config/feature-flags.config';
import { LoggerService } from './logger.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { ToastService } from './toast.service';
import { NetworkAwarenessService } from './network-awareness.service';
import { SimpleSyncService, SessionManagerService } from '../core-bridge';
import { SyncCoordinatorService } from './sync-coordinator.service';

export type AppResumeReason =
  | 'visibility-threshold'
  | 'visibility-quick'
  | 'pageshow'
  | 'online'
  | 'manual';

export interface RecoveryMetricsSnapshot {
  ticketId: string;
  reason: string;
  interactionReadyMs: number;
  backgroundRefreshMs?: number;
  fastPathHit?: boolean;
}

@Injectable({ providedIn: 'root' })
export class AppLifecycleOrchestratorService {
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('LifecycleOrchestrator');
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly toast = inject(ToastService);
  private readonly networkAwareness = inject(NetworkAwarenessService);
  private readonly simpleSync = inject(SimpleSyncService);
  private readonly sessionManager = inject(SessionManagerService);
  private readonly syncCoordinator = inject(SyncCoordinatorService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly isResumingSignal = signal(false);
  private readonly lastResumeAtSignal = signal<number | null>(null);
  private readonly lastHeavyRecoveryAtSignal = signal<number | null>(null);
  private readonly lastRecoveryMetricsSignal = signal<RecoveryMetricsSnapshot | null>(null);
  private readonly compensationTicketIdSignal = signal<string | null>(null);
  private readonly currentRecoveryTicketSignal = signal<{
    id: string;
    startedAt: number;
    mode: 'light' | 'heavy';
  } | null>(null);

  private initialized = false;
  private resumePromise: Promise<void> | null = null;
  private hiddenAt: number | null = null;
  private lastBackgroundDurationMs = 0;
  private consecutiveFailures = 0;
  private autoReloadScheduled = false;

  private hasPendingVersion = false;
  private hasShownResumeVersionPrompt = false;

  private visibilityHandler: (() => void) | null = null;
  private pageshowHandler: ((event: PageTransitionEvent) => void) | null = null;
  private onlineHandler: (() => void) | null = null;

  private static readonly AUTO_RELOAD_COUNTER_KEY = 'nanoflow.lifecycle.auto-reload';

  constructor() {
    this.destroyRef.onDestroy(() => this.cleanup());
  }

  /**
   * Initialize the lifecycle orchestrator by registering browser event listeners
   * for visibility changes, BFCache restoration, and network reconnection.
   *
   * This service manages the resume/recovery lifecycle and MUST be initialized
   * first among all startup services. The full service initialization order,
   * orchestrated by {@link WorkspaceShellComponent}, is:
   *
   * 1. **AppLifecycleOrchestratorService.initialize()** (constructor, synchronous)
   *    - Registers visibilitychange, pageshow, and online listeners.
   *    - Must be first so that resume/recovery orchestration is active before
   *      any async work begins.
   *
   * 2. **StartupTierOrchestratorService.initialize()** (ngOnInit, synchronous)
   *    - Sets up the P0/P1/P2 tiered startup state machine.
   *    - P0 = critical render path, P1 = interaction readiness, P2 = background
   *      sync hydration. Gated by {@link FEATURE_FLAGS.TIERED_STARTUP_HYDRATION_V1}.
   *
   * 3. **StartupFontSchedulerService.initialize()** (ngOnInit, synchronous)
   *    - Schedules non-critical font loading via requestIdleCallback / setTimeout
   *      to avoid blocking first paint.
   *
   * 4. **FocusStartupProbeService.initialize()** (signal effect, async-reactive)
   *    - Runs a local-only gate check to determine whether Focus mode has
   *      pending work. Fires after coreDataLoaded() becomes true and the user
   *      is authenticated. Gated by {@link FEATURE_FLAGS.FOCUS_STARTUP_THROTTLED_CHECK_V1}.
   *
   * 5. **EventDrivenSyncPulseService.initialize()** (signal effect, async-reactive)
   *    - Activates event-driven sync pulses (replaces fixed-interval polling).
   *      Depends on authentication, coreDataLoaded, and P2 tier readiness.
   *      Gated by {@link FEATURE_FLAGS.EVENT_DRIVEN_SYNC_PULSE_V1}.
   *
   * 6. **PwaInstallPromptService.initialize()** (deferred, lowest priority)
   *    - Captures the beforeinstallprompt event and exposes install affordance.
   *      Deferred to first user interaction or requestIdleCallback to avoid
   *      competing with critical startup work.
   *      Gated by {@link FEATURE_FLAGS.PWA_PROMPT_DEFER_V2}.
   *
   * Idempotent: subsequent calls after the first are no-ops.
   * SSR-safe: returns immediately when `window` or `document` is unavailable.
   */
  initialize(): void {
    if (this.initialized || typeof window === 'undefined' || typeof document === 'undefined') {
      return;
    }

    this.visibilityHandler = () => {
      if (document.visibilityState === 'hidden') {
        this.hiddenAt = Date.now();
        return;
      }

      if (document.visibilityState === 'visible' && this.hiddenAt) {
        const duration = Date.now() - this.hiddenAt;
        this.hiddenAt = null;
        this.lastBackgroundDurationMs = duration;

        const reason: AppResumeReason = duration >= APP_LIFECYCLE_CONFIG.RESUME_THRESHOLD_MS
          ? 'visibility-threshold'
          : 'visibility-quick';

        void this.triggerResume(reason);
      }
    };

    this.pageshowHandler = (event: PageTransitionEvent) => {
      // BFCache 恢复场景优先触发恢复编排
      if (!event.persisted) {
        return;
      }

      this.lastBackgroundDurationMs = Math.max(
        this.lastBackgroundDurationMs,
        APP_LIFECYCLE_CONFIG.RESUME_THRESHOLD_MS
      );
      void this.triggerResume('pageshow');
    };

    this.onlineHandler = () => {
      void this.triggerResume('online');
    };

    document.addEventListener('visibilitychange', this.visibilityHandler);
    window.addEventListener('pageshow', this.pageshowHandler as EventListener);
    window.addEventListener('online', this.onlineHandler);

    this.initialized = true;
    this.logger.info('Lifecycle orchestrator initialized');
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
    const compensatingTicketId = this.compensationTicketIdSignal();
    if (!compensatingTicketId) {
      return false;
    }
    if (!ticketId) {
      return true;
    }
    return compensatingTicketId === ticketId;
  }

  isHeavyRecoveryInCooldown(windowMs = APP_LIFECYCLE_CONFIG.RESUME_HEAVY_COOLDOWN_MS): boolean {
    const lastHeavy = this.lastHeavyRecoveryAtSignal();
    if (!lastHeavy) {
      return false;
    }
    return Date.now() - lastHeavy < windowMs;
  }

  async triggerResume(reason: AppResumeReason): Promise<void> {
    if (!FEATURE_FLAGS.LIFECYCLE_RECOVERY_V1) {
      return;
    }

    if (this.resumePromise) {
      return this.resumePromise;
    }

    this.resumePromise = this.executeResume(reason);

    try {
      await this.resumePromise;
    } finally {
      this.resumePromise = null;
    }
  }

  private async executeResume(reason: AppResumeReason): Promise<void> {
    const startAt = Date.now();
    const runHeavyRecovery = reason !== 'visibility-quick';
    const recoveryTicket = {
      id: this.createRecoveryTicketId(runHeavyRecovery ? 'heavy' : 'light'),
      startedAt: startAt,
      mode: runHeavyRecovery ? 'heavy' as const : 'light' as const,
    };
    this.currentRecoveryTicketSignal.set(recoveryTicket);
    const perfPrefix = `nanoflow:resume:${recoveryTicket.id}`;
    this.markPerformance(`${perfPrefix}:start`);

    this.isResumingSignal.set(true);
    this.addLifecycleBreadcrumb('lifecycle.resume.start', reason, {
      runHeavyRecovery,
      backgroundDurationMs: this.lastBackgroundDurationMs,
      recoveryTicketId: recoveryTicket.id,
    });
    this.addLifecycleBreadcrumb('lifecycle.resume.reason', reason);

    try {
      const pipelineResult = await this.withTimeout(
        this.executeRecoveryPipeline(reason, runHeavyRecovery, recoveryTicket),
        APP_LIFECYCLE_CONFIG.RESUME_TIMEOUT_MS
      );

      if (pipelineResult.deferred) {
        this.addLifecycleBreadcrumb('lifecycle.resume.success', reason, {
          elapsedMs: Date.now() - startAt,
          deferred: true,
          deferredReason: pipelineResult.reason ?? 'unknown',
        });
        return;
      }

      // session 校验/刷新失败时不重置失败计数
      if (pipelineResult.reason === 'no-session' || pipelineResult.reason === 'refresh-failed') {
        this.consecutiveFailures += 1;
        this.addLifecycleBreadcrumb('lifecycle.resume.fail', reason, {
          elapsedMs: Date.now() - startAt,
          sessionFailureReason: pipelineResult.reason,
          consecutiveFailures: this.consecutiveFailures,
        });
        this.maybeScheduleAutoReload(reason, new Error(`Session validation failed: ${pipelineResult.reason}`));
        return;
      }

      this.consecutiveFailures = 0;
      this.lastResumeAtSignal.set(Date.now());
      if (typeof pipelineResult.interactionReadyMs === 'number') {
        this.reportRecoveryMetrics({
          ticketId: recoveryTicket.id,
          reason,
          interactionReadyMs: pipelineResult.interactionReadyMs,
          fastPathHit: pipelineResult.fastPathHit,
        });
      }

      if (
        this.hasPendingVersion &&
        !this.hasShownResumeVersionPrompt &&
        this.lastBackgroundDurationMs >= APP_LIFECYCLE_CONFIG.NEW_VERSION_PROMPT_THRESHOLD_MS
      ) {
        this.hasShownResumeVersionPrompt = true;
        this.toast.info(
          '检测到新版本',
          '页面后台停留较久，建议刷新以获得最新稳定版本',
          {
            duration: 0,
            action: {
              label: '立即刷新',
              onClick: () => window.location.reload(),
            },
          }
        );
      }

      this.addLifecycleBreadcrumb('lifecycle.resume.success', reason, {
        elapsedMs: Date.now() - startAt,
      });
    } catch (error) {
      this.consecutiveFailures += 1;

      this.addLifecycleBreadcrumb('lifecycle.resume.fail', reason, {
        elapsedMs: Date.now() - startAt,
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

      this.maybeScheduleAutoReload(reason, error);
    } finally {
      this.currentRecoveryTicketSignal.set(null);
      this.isResumingSignal.set(false);
    }
  }

  private async executeRecoveryPipeline(
    reason: AppResumeReason,
    heavy: boolean,
    recoveryTicket: { id: string; startedAt: number; mode: 'light' | 'heavy' }
  ): Promise<{
    deferred: boolean;
    reason?: 'client-unready' | 'no-session' | 'refresh-failed';
    interactionReadyMs?: number;
    fastPathHit?: boolean;
  }> {
    const recoveryTicketId = recoveryTicket.id;
    const perfPrefix = recoveryTicketId ? `nanoflow:resume:${recoveryTicketId}` : null;

    this.recordRecoveryStep('network-refresh', reason);
    this.networkAwareness.refresh();

    this.recordRecoveryStep('session-validate', reason);
    const sessionSnapshot = FEATURE_FLAGS.RESUME_SESSION_SNAPSHOT_V1
      ? this.sessionManager.getRecentValidationSnapshot(10_000)
      : null;
    const session = sessionSnapshot?.valid
      ? { ok: true, refreshed: false, deferred: false, reason: undefined as ('client-unready' | 'no-session' | 'refresh-failed' | undefined) }
      : await this.sessionManager.validateOrRefreshOnResume(`resume:${reason}`);

    if (session.deferred) {
      this.logger.info('Session validation deferred during resume', { reason, deferredReason: session.reason });
      return { deferred: true, reason: session.reason };
    }

    if (!session.ok) {
      this.logger.warn('Session validation failed during resume', { reason, failureReason: session.reason });
      return { deferred: false, reason: session.reason };
    }

    const interactionStartAt = Date.now();
    if (FEATURE_FLAGS.RESUME_INTERACTION_FIRST_V1) {
      this.recordRecoveryStep('sync-recovery-light', reason);
      await this.simpleSync.recoverAfterResume(reason, {
        mode: 'light',
        stage: 'full',
        allowRemoteProbe: false,
        sessionValidated: true,
        retryProcessing: 'background',
        deferBlackBoxPull: true,
        recoveryTicketId: recoveryTicketId ?? undefined,
      });
    }
    const interactionReadyMs = Date.now() - interactionStartAt;
    if (perfPrefix) {
      this.markPerformance(`${perfPrefix}:interaction-ready`);
      this.measurePerformance('resume.interaction_ready_ms', `${perfPrefix}:start`, `${perfPrefix}:interaction-ready`);
    }

    if (!heavy) {
      return { deferred: false, interactionReadyMs };
    }

    if (
      FEATURE_FLAGS.RESUME_INTERACTION_FIRST_V1 &&
      FEATURE_FLAGS.RESUME_PULSE_DEDUP_V1 &&
      this.isHeavyRecoveryInCooldown()
    ) {
      this.recordRecoveryStep('sync-recovery-heavy-suppressed', reason);
      return { deferred: false, interactionReadyMs };
    }

    if (FEATURE_FLAGS.RESUME_INTERACTION_FIRST_V1) {
      this.scheduleRecoveryCompensation(reason, {
        id: recoveryTicketId ?? this.createRecoveryTicketId('heavy'),
        startedAt: Date.now(),
        mode: 'heavy',
      }, interactionReadyMs);
      this.lastHeavyRecoveryAtSignal.set(Date.now());
      return { deferred: false, interactionReadyMs };
    }

    this.recordRecoveryStep('sync-recovery', reason);
    await this.simpleSync.recoverAfterResume(reason, {
      sessionValidated: true,
      retryProcessing: 'background',
      deferBlackBoxPull: true,
      recoveryTicketId: recoveryTicketId ?? undefined,
      backgroundProbeDelayMs: 180,
    });

    this.recordRecoveryStep('blackbox-recovery', reason);
    const blackBoxResult = await this.syncCoordinator.refreshBlackBoxWatermarkIfNeeded('resume');

    this.recordRecoveryStep('ui-correction', reason);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('nanoflow:lifecycle-resumed', {
        detail: {
          reason,
          resumedAt: Date.now(),
        },
      }));
    }

    this.lastHeavyRecoveryAtSignal.set(Date.now());

    return { deferred: false, interactionReadyMs, fastPathHit: blackBoxResult.skipped };
  }

  private scheduleRecoveryCompensation(
    reason: AppResumeReason,
    recoveryTicket: { id: string; startedAt: number; mode: 'light' | 'heavy' },
    interactionReadyMs: number
  ): void {
    if (this.isRecoveryCompensationInFlight(recoveryTicket.id)) {
      return;
    }
    this.compensationTicketIdSignal.set(recoveryTicket.id);

    const runCompensation = async () => {
      const backgroundStartAt = Date.now();
      const perfPrefix = `nanoflow:resume:${recoveryTicket.id}`;
      this.markPerformance(`${perfPrefix}:background-start`);
      let fastPathHit: boolean | undefined;

      try {
        this.recordRecoveryStep('sync-recovery-heavy-compensation', reason);
        await this.simpleSync.recoverAfterResume(reason, {
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

        this.recordRecoveryStep('blackbox-recovery', reason);
        const blackboxRefresh = await this.syncCoordinator.refreshBlackBoxWatermarkIfNeeded('resume');
        fastPathHit = blackboxRefresh.skipped;

        this.recordRecoveryStep('ui-correction', reason);
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('nanoflow:lifecycle-resumed', {
            detail: {
              reason,
              resumedAt: Date.now(),
            },
          }));
        }

        this.lastHeavyRecoveryAtSignal.set(Date.now());
      } catch (error) {
        this.logger.warn('Resume background compensation failed', { reason, recoveryTicketId: recoveryTicket.id, error });
        this.sentryLazyLoader.captureException(error, {
          operation: 'lifecycle.resume.compensation',
          reason,
          recoveryTicketId: recoveryTicket.id,
        });
      } finally {
        const backgroundRefreshMs = Date.now() - backgroundStartAt;
        this.markPerformance(`${perfPrefix}:background-end`);
        this.measurePerformance(
          'resume.background_refresh_ms',
          `${perfPrefix}:background-start`,
          `${perfPrefix}:background-end`
        );
        this.reportRecoveryMetrics({
          ticketId: recoveryTicket.id,
          reason,
          interactionReadyMs,
          backgroundRefreshMs,
          fastPathHit,
        });
        this.compensationTicketIdSignal.set(null);
      }
    };

    if (typeof queueMicrotask === 'function') {
      queueMicrotask(() => {
        this.runIdleTask(() => {
          void runCompensation();
        });
      });
      return;
    }

    this.runIdleTask(() => {
      void runCompensation();
    });
  }

  private runIdleTask(task: () => void): void {
    if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
      (
        window as Window & {
          requestIdleCallback: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
        }
      ).requestIdleCallback(() => task(), { timeout: 1200 });
      return;
    }
    setTimeout(task, 0);
  }

  private reportRecoveryMetrics(metrics: RecoveryMetricsSnapshot): void {
    const current = this.lastRecoveryMetricsSignal();
    const next = current && current.ticketId === metrics.ticketId
      ? { ...current, ...metrics }
      : metrics;
    this.lastRecoveryMetricsSignal.set(next);

    if (FEATURE_FLAGS.RESUME_METRICS_GATE_V1) {
      this.sentryLazyLoader.setMeasurement('resume.interaction_ready_ms', next.interactionReadyMs, 'millisecond');
      if (typeof next.backgroundRefreshMs === 'number') {
        this.sentryLazyLoader.setMeasurement('resume.background_refresh_ms', next.backgroundRefreshMs, 'millisecond');
      }
      if (typeof next.fastPathHit === 'boolean') {
        this.sentryLazyLoader.setMeasurement('resume.fast_path_hit', next.fastPathHit ? 1 : 0, 'none');
      }
    }

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('nanoflow:resume-metrics', {
        detail: next,
      }));
    }
  }

  private markPerformance(markName: string): void {
    if (typeof performance === 'undefined' || typeof performance.mark !== 'function') {
      return;
    }
    performance.mark(markName);
  }

  private measurePerformance(measureName: string, startMark: string, endMark: string): void {
    if (typeof performance === 'undefined' || typeof performance.measure !== 'function') {
      return;
    }
    try {
      performance.measure(measureName, { start: startMark, end: endMark });
    } catch {
      try {
        performance.measure(measureName, startMark, endMark);
      } catch {
        // ignored
      }
    }
  }

  private createRecoveryTicketId(mode: 'light' | 'heavy'): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `${mode}:${crypto.randomUUID()}`;
    }
    return `${mode}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(new Error(`Lifecycle resume timeout after ${timeoutMs}ms`));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  private recordRecoveryStep(step: string, reason: AppResumeReason): void {
    this.addLifecycleBreadcrumb('recovery.step', reason, { step });
  }

  private addLifecycleBreadcrumb(
    message: 'lifecycle.resume.start' | 'lifecycle.resume.reason' | 'lifecycle.resume.success' | 'lifecycle.resume.fail' | 'recovery.step',
    reason: AppResumeReason,
    extra?: Record<string, unknown>
  ): void {
    this.sentryLazyLoader.addBreadcrumb({
      category: 'lifecycle',
      message,
      level: 'info',
      data: {
        reason,
        ...extra,
      },
    });
  }

  private maybeScheduleAutoReload(reason: AppResumeReason, error: unknown): void {
    if (this.autoReloadScheduled) {
      return;
    }

    if (this.consecutiveFailures < APP_LIFECYCLE_CONFIG.AUTO_RELOAD_FAILURE_THRESHOLD) {
      return;
    }

    if (!this.consumeAutoReloadQuota()) {
      return;
    }

    this.autoReloadScheduled = true;

    this.toast.warning(
      '恢复失败',
      '系统将自动刷新页面以恢复稳定状态',
      { duration: 2500 }
    );

    this.sentryLazyLoader.captureMessage('Lifecycle auto reload scheduled', {
      level: 'warning',
      tags: {
        operation: 'lifecycle.auto-reload',
        reason,
      },
      extra: {
        error: error instanceof Error ? error.message : String(error),
        consecutiveFailures: this.consecutiveFailures,
      },
    });

    setTimeout(() => {
      window.location.reload();
    }, 1500);
  }

  private consumeAutoReloadQuota(): boolean {
    if (typeof localStorage === 'undefined') {
      return false;
    }

    const today = new Date().toISOString().slice(0, 10);

    try {
      const raw = localStorage.getItem(AppLifecycleOrchestratorService.AUTO_RELOAD_COUNTER_KEY);
      const parsed = raw ? JSON.parse(raw) as { date?: string; count?: number } : {};

      const date = parsed.date === today ? today : today;
      const count = parsed.date === today ? (parsed.count ?? 0) : 0;

      if (count >= APP_LIFECYCLE_CONFIG.MAX_AUTO_RELOAD_PER_DAY) {
        return false;
      }

      localStorage.setItem(
        AppLifecycleOrchestratorService.AUTO_RELOAD_COUNTER_KEY,
        JSON.stringify({ date, count: count + 1 })
      );

      return true;
    } catch {
      return false;
    }
  }

  private cleanup(): void {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return;
    }

    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }

    if (this.pageshowHandler) {
      window.removeEventListener('pageshow', this.pageshowHandler as EventListener);
      this.pageshowHandler = null;
    }

    if (this.onlineHandler) {
      window.removeEventListener('online', this.onlineHandler);
      this.onlineHandler = null;
    }

    this.initialized = false;
  }
}
