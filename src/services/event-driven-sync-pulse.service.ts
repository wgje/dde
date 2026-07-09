import { DestroyRef, Injectable, inject } from '@angular/core';
import { SyncResumeCoordinatorService, SessionManagerService } from '../core-bridge';
import { STARTUP_PERF_CONFIG } from '../config/startup-performance.config';
import { FEATURE_FLAGS } from '../config/feature-flags.config';
import { APP_LIFECYCLE_CONFIG } from '../config/app-lifecycle.config';
import { LoggerService } from './logger.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { AuthService } from './auth.service';
import { NetworkAwarenessService } from './network-awareness.service';
import { AppLifecycleOrchestratorService } from './app-lifecycle-orchestrator.service';

export type SyncPulseReason =
  | 'focus'
  | 'visible'
  | 'pageshow'
  | 'online'
  | 'heartbeat'
  | 'focus-entry'
  | 'manual';

export type SyncPulseTriggerResult = {
  status: 'success' | 'failed' | 'skipped';
  skipReason?: SyncPulseSkipReason;
  retryAfterMs?: number;
};

type SyncPulseStatus = 'triggered' | 'success' | 'failed' | 'skipped';
type SyncPulseSkipReason =
  | 'disabled'
  | 'cooldown'
  | 'offline'
  | 'hidden'
  | 'unauthenticated'
  | 'resuming'
  | 'compensating'
  | 'post-heavy-cooldown'
  | 'same-ticket'
  | 'in-flight';

@Injectable({ providedIn: 'root' })
export class EventDrivenSyncPulseService {
  private readonly syncResumeCoordinator = inject(SyncResumeCoordinatorService);
  private readonly logger = inject(LoggerService).category('SyncPulse');
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly authService = inject(AuthService);
  private readonly networkAwareness = inject(NetworkAwarenessService);
  private readonly appLifecycle = inject(AppLifecycleOrchestratorService);
  private readonly sessionManager = inject(SessionManagerService);
  private readonly destroyRef = inject(DestroyRef);

  private initialized = false;
  private pulsePromise: Promise<SyncPulseTriggerResult> | null = null;
  private lastPulseAt = 0;
  private pulseGeneration = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatGeneration = 0;
  private destroyed = false;

  private focusHandler: (() => void) | null = null;
  private visibilityHandler: (() => void) | null = null;
  private pageshowHandler: ((event: PageTransitionEvent) => void) | null = null;
  private onlineHandler: (() => void) | null = null;
  private heartbeatVisibilityHandler: (() => void) | null = null;

  constructor() {
    this.destroyRef.onDestroy(() => {
      this.destroyed = true;
      this.destroy();
    });
  }

  initialize(): void {
    if (this.destroyed) {
      return;
    }
    if (this.initialized || !FEATURE_FLAGS.EVENT_DRIVEN_SYNC_PULSE_V1) {
      return;
    }

    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return;
    }

    this.focusHandler = () => {
      void this.triggerNow('focus');
    };
    this.visibilityHandler = () => {
      if (document.visibilityState === 'visible') {
        void this.triggerNow('visible');
      }
    };
    this.pageshowHandler = (event: PageTransitionEvent) => {
      if (event.persisted) {
        void this.triggerNow('pageshow');
      }
    };
    this.onlineHandler = () => {
      void this.triggerNow('online');
    };

    try {
      window.addEventListener('focus', this.focusHandler);
      document.addEventListener('visibilitychange', this.visibilityHandler);
      window.addEventListener('pageshow', this.pageshowHandler as EventListener);
      window.addEventListener('online', this.onlineHandler);

      // 心跳：仅在页面可见时启动/恢复，不可见时暂停，避免移动端后台电量浪费
      if (document.visibilityState === 'visible') {
        this.startHeartbeat();
      }
      this.heartbeatVisibilityHandler = () => {
        if (document.visibilityState === 'visible') {
          this.startHeartbeat();
        } else {
          this.stopHeartbeat();
        }
      };
      document.addEventListener('visibilitychange', this.heartbeatVisibilityHandler);

      this.initialized = true;
    } catch (error) {
      this.teardownListeners();
      throw error;
    }
    this.logInitializationSafely();
  }

  destroy(): void {
    this.pulseGeneration += 1;
    this.lastPulseAt = 0;
    this.teardownListeners();
  }

  private teardownListeners(): void {
    this.removeListenerSafely('focus', () => {
      if (this.focusHandler && typeof window !== 'undefined') {
        window.removeEventListener('focus', this.focusHandler);
      }
    });
    this.focusHandler = null;

    this.removeListenerSafely('visibilitychange', () => {
      if (this.visibilityHandler && typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', this.visibilityHandler);
      }
    });
    this.visibilityHandler = null;

    this.removeListenerSafely('pageshow', () => {
      if (this.pageshowHandler && typeof window !== 'undefined') {
        window.removeEventListener('pageshow', this.pageshowHandler as EventListener);
      }
    });
    this.pageshowHandler = null;

    this.removeListenerSafely('online', () => {
      if (this.onlineHandler && typeof window !== 'undefined') {
        window.removeEventListener('online', this.onlineHandler);
      }
    });
    this.onlineHandler = null;

    this.removeListenerSafely('heartbeat-visibilitychange', () => {
      if (this.heartbeatVisibilityHandler && typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', this.heartbeatVisibilityHandler);
      }
    });
    this.heartbeatVisibilityHandler = null;

    this.stopHeartbeat();
    this.initialized = false;
  }

  private removeListenerSafely(listener: string, remove: () => void): void {
    try {
      remove();
    } catch (error) {
      this.warnSafely('事件驱动同步脉冲监听器清理失败', { listener, error });
    }
  }

  private logInitializationSafely(): void {
    try {
      this.logger.info('事件驱动同步脉冲已初始化');
    } catch {
      // Observability failures must not roll back registered sync pulse listeners.
    }
  }

  private warnSafely(message: string, data: unknown): void {
    try {
      this.logger.warn(message, data);
    } catch {
      // Warning sinks must not change pulse, cleanup, or retry behavior.
    }
  }

  /** 启动心跳定时器（仅在页面可见时调用） */
  private startHeartbeat(): void {
    if (this.heartbeatTimer !== null) return;
    // 增加 ±10% 随机抖动，避免多标签页同时触发心跳
    const baseInterval = STARTUP_PERF_CONFIG.SYNC_HEARTBEAT_VISIBLE_INTERVAL_MS;
    const jitter = baseInterval * 0.1 * (Math.random() * 2 - 1); // [-10%, +10%]
    const interval = Math.round(baseInterval + jitter);
    const generation = ++this.heartbeatGeneration;
    const heartbeatTimer = setInterval(() => {
      if (generation !== this.heartbeatGeneration || this.heartbeatTimer !== heartbeatTimer) {
        return;
      }

      void this.triggerNow('heartbeat');
    }, interval);
    this.heartbeatTimer = heartbeatTimer;
  }

  /** 暂停心跳定时器（页面不可见时调用，节省电量） */
  private stopHeartbeat(): void {
    this.heartbeatGeneration += 1;
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  async triggerNow(reason: SyncPulseReason): Promise<SyncPulseTriggerResult> {
    if (this.destroyed) {
      this.emitPulse('skipped', reason, 'disabled');
      return { status: 'skipped', skipReason: 'disabled' };
    }

    if (!FEATURE_FLAGS.EVENT_DRIVEN_SYNC_PULSE_V1) {
      this.emitPulse('skipped', reason, 'disabled');
      return { status: 'skipped', skipReason: 'disabled' };
    }

    if (this.pulsePromise) {
      this.emitPulse('skipped', reason, 'in-flight');
      return { status: 'skipped', skipReason: 'in-flight' };
    }

    const eligibility = this.getEligibilitySafely(reason);
    if (!eligibility.ok) {
      this.emitPulse('skipped', reason, eligibility.skipReason);
      return { status: 'skipped', skipReason: eligibility.skipReason };
    }

    const elapsedSinceLastPulse = Date.now() - this.lastPulseAt;
    if (this.lastPulseAt > 0 && elapsedSinceLastPulse < STARTUP_PERF_CONFIG.SYNC_EVENT_COOLDOWN_MS) {
      this.emitPulse('skipped', reason, 'cooldown');
      return {
        status: 'skipped',
        skipReason: 'cooldown',
        retryAfterMs: Math.max(0, STARTUP_PERF_CONFIG.SYNC_EVENT_COOLDOWN_MS - elapsedSinceLastPulse),
      };
    }

    if (
      FEATURE_FLAGS.RESUME_PULSE_DEDUP_V1 &&
      this.appLifecycle.isHeavyRecoveryInCooldown(APP_LIFECYCLE_CONFIG.PULSE_SUPPRESS_AFTER_HEAVY_MS)
    ) {
      this.emitPulse('skipped', reason, 'post-heavy-cooldown');
      return {
        status: 'skipped',
        skipReason: 'post-heavy-cooldown',
        retryAfterMs: this.getPostHeavyCooldownRetryAfterMs(),
      };
    }

    const pulseGeneration = this.pulseGeneration;
    const pulsePromise = this.executePulse(reason, pulseGeneration).finally(() => {
      if (this.pulsePromise === pulsePromise) {
        this.pulsePromise = null;
      }
    });
    this.pulsePromise = pulsePromise;

    return this.pulsePromise;
  }

  private getPostHeavyCooldownRetryAfterMs(): number {
    const lastHeavyRecoveryAt = this.appLifecycle.lastHeavyRecoveryAt();
    return lastHeavyRecoveryAt === null
      ? APP_LIFECYCLE_CONFIG.PULSE_SUPPRESS_AFTER_HEAVY_MS
      : Math.max(0, APP_LIFECYCLE_CONFIG.PULSE_SUPPRESS_AFTER_HEAVY_MS - (Date.now() - lastHeavyRecoveryAt));
  }

  private getEligibilitySafely(reason: SyncPulseReason):
    | { ok: true }
    | { ok: false; skipReason: SyncPulseSkipReason } {
    try {
      return this.getEligibility();
    } catch (error) {
      this.warnSafely('同步脉冲状态检查失败，已跳过本次脉冲', { reason, error });
      return { ok: false, skipReason: 'disabled' };
    }
  }

  private getEligibility():
    | { ok: true }
    | { ok: false; skipReason: Exclude<SyncPulseSkipReason, 'disabled' | 'cooldown'> } {
    if (!this.authService.currentUserId()) {
      return { ok: false, skipReason: 'unauthenticated' };
    }

    const online = this.networkAwareness.isOnline();
    if (!online) {
      return { ok: false, skipReason: 'offline' };
    }

    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
      return { ok: false, skipReason: 'hidden' };
    }

    if (this.appLifecycle.isResuming()) {
      return { ok: false, skipReason: 'resuming' };
    }

    if (this.appLifecycle.isRecoveryCompensationInFlight()) {
      return { ok: false, skipReason: 'compensating' };
    }

    return { ok: true };
  }

  private async executePulse(
    reason: SyncPulseReason,
    pulseGeneration: number,
  ): Promise<SyncPulseTriggerResult> {
    this.emitPulse('triggered', reason);

    try {
      const recoveryTicket = this.appLifecycle.getCurrentRecoveryTicket();
      if (FEATURE_FLAGS.RECOVERY_TICKET_DEDUP_V1 && recoveryTicket) {
        return this.skipPulseForRecoveryTicket(reason);
      }

      const sessionSnapshot = FEATURE_FLAGS.RESUME_SESSION_SNAPSHOT_V1
        ? this.sessionManager.getRecentValidationSnapshot(10_000)
        : null;
      const recoveryTicketBeforeRecover = this.readRecoveryTicketForPulse();
      if (recoveryTicketBeforeRecover) {
        return this.skipPulseForRecoveryTicket(reason);
      }

      // 只在实际执行同步后才更新 lastPulseAt，跳过时不更新以避免延长冷却窗口
      this.lastPulseAt = Date.now();

      if (FEATURE_FLAGS.RESUME_INTERACTION_FIRST_V1) {
        await this.syncResumeCoordinator.recoverAfterResume(`pulse:${reason}`, {
          mode: 'light',
          allowRemoteProbe: false,
          sessionValidated: sessionSnapshot?.valid === true,
          skipSessionValidationWithinMs: 10_000,
          recoveryTicketId: recoveryTicket?.id,
        });
      } else {
        await this.syncResumeCoordinator.recoverAfterResume(`pulse:${reason}`, {
          recoveryTicketId: recoveryTicket?.id,
        });
      }
      if (pulseGeneration !== this.pulseGeneration) {
        return { status: 'skipped', skipReason: 'disabled' };
      }
      this.emitPulse('success', reason);
      return { status: 'success' };
    } catch (error) {
      return this.handlePulseFailure(error, reason, pulseGeneration);
    }
  }

  private handlePulseFailure(
    error: unknown,
    reason: SyncPulseReason,
    pulseGeneration: number,
  ): SyncPulseTriggerResult {
    if (pulseGeneration !== this.pulseGeneration) {
      return { status: 'skipped', skipReason: 'disabled' };
    }
    this.emitPulse('failed', reason);
    this.warnSafely('同步脉冲执行失败', { reason, error });
    try {
      this.sentryLazyLoader.captureException(error, {
        operation: 'sync.pulse',
        reason,
      });
    } catch (captureError) {
      this.warnSafely('同步脉冲异常上报失败', { reason, error: captureError });
    }
    return { status: 'failed' };
  }

  private readRecoveryTicketForPulse(): { id: string } | null {
    const recoveryTicket = this.appLifecycle.getCurrentRecoveryTicket();
    if (!FEATURE_FLAGS.RECOVERY_TICKET_DEDUP_V1 || !recoveryTicket) {
      return null;
    }

    return recoveryTicket;
  }

  private skipPulseForRecoveryTicket(reason: SyncPulseReason): SyncPulseTriggerResult {
    this.emitPulse('skipped', reason, 'same-ticket');
    return { status: 'skipped', skipReason: 'same-ticket' };
  }

  private emitPulse(
    status: SyncPulseStatus,
    reason: SyncPulseReason,
    skipReason?: SyncPulseSkipReason
  ): void {
    try {
      this.addPulseBreadcrumb(
        status === 'skipped'
          ? `sync.pulse.skipped.${skipReason ?? 'unknown'}`
          : `sync.pulse.${status}`,
        reason,
        skipReason ? { skipReason } : undefined
      );
    } catch (error) {
      this.warnSafely('同步脉冲 breadcrumb 记录失败', { status, reason, error });
    }

    if (typeof window === 'undefined') return;
    try {
      window.dispatchEvent(new CustomEvent('nanoflow:sync-pulse', {
        detail: {
          status,
          reason,
          skipReason,
        },
      }));
    } catch (error) {
      this.warnSafely('同步脉冲事件派发失败', { status, reason, error });
    }
  }

  private addPulseBreadcrumb(
    message: string,
    reason: SyncPulseReason,
    data?: Record<string, unknown>
  ): void {
    this.sentryLazyLoader.addBreadcrumb({
      category: 'sync',
      message,
      level: 'info',
      data: {
        reason,
        ...data,
      },
    });
  }
}
