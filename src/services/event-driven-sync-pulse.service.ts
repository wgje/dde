import { DestroyRef, Injectable, inject } from '@angular/core';
import { SimpleSyncService, SessionManagerService } from '../core-bridge';
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
  | 'same-ticket';

@Injectable({ providedIn: 'root' })
export class EventDrivenSyncPulseService {
  private readonly simpleSync = inject(SimpleSyncService);
  private readonly logger = inject(LoggerService).category('SyncPulse');
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly authService = inject(AuthService);
  private readonly networkAwareness = inject(NetworkAwarenessService);
  private readonly appLifecycle = inject(AppLifecycleOrchestratorService);
  private readonly sessionManager = inject(SessionManagerService);
  private readonly destroyRef = inject(DestroyRef);

  private initialized = false;
  private pulsePromise: Promise<void> | null = null;
  private lastPulseAt = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  private focusHandler: (() => void) | null = null;
  private visibilityHandler: (() => void) | null = null;
  private pageshowHandler: ((event: PageTransitionEvent) => void) | null = null;
  private onlineHandler: (() => void) | null = null;
  private heartbeatVisibilityHandler: (() => void) | null = null;

  constructor() {
    this.destroyRef.onDestroy(() => this.destroy());
  }

  initialize(): void {
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

    window.addEventListener('focus', this.focusHandler);
    document.addEventListener('visibilitychange', this.visibilityHandler);
    window.addEventListener('pageshow', this.pageshowHandler as EventListener);
    window.addEventListener('online', this.onlineHandler);

    // 心跳：仅在页面可见时启动/恢复，不可见时暂停，避免移动端后台电量浪费
    this.startHeartbeat();
    this.heartbeatVisibilityHandler = () => {
      if (document.visibilityState === 'visible') {
        this.startHeartbeat();
      } else {
        this.stopHeartbeat();
      }
    };
    document.addEventListener('visibilitychange', this.heartbeatVisibilityHandler);

    this.initialized = true;
    this.logger.info('事件驱动同步脉冲已初始化');
  }

  destroy(): void {
    if (!this.initialized || typeof window === 'undefined' || typeof document === 'undefined') {
      return;
    }

    if (this.focusHandler) {
      window.removeEventListener('focus', this.focusHandler);
      this.focusHandler = null;
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
    if (this.heartbeatVisibilityHandler) {
      document.removeEventListener('visibilitychange', this.heartbeatVisibilityHandler);
      this.heartbeatVisibilityHandler = null;
    }
    this.stopHeartbeat();

    this.initialized = false;
    this.pulsePromise = null;
  }

  /** 启动心跳定时器（仅在页面可见时调用） */
  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    // 增加 ±10% 随机抖动，避免多标签页同时触发心跳
    const baseInterval = STARTUP_PERF_CONFIG.SYNC_HEARTBEAT_VISIBLE_INTERVAL_MS;
    const jitter = baseInterval * 0.1 * (Math.random() * 2 - 1); // [-10%, +10%]
    const interval = Math.round(baseInterval + jitter);
    this.heartbeatTimer = setInterval(() => {
      void this.triggerNow('heartbeat');
    }, interval);
  }

  /** 暂停心跳定时器（页面不可见时调用，节省电量） */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  async triggerNow(reason: SyncPulseReason): Promise<void> {
    if (!FEATURE_FLAGS.EVENT_DRIVEN_SYNC_PULSE_V1) {
      this.emitPulse('skipped', reason, 'disabled');
      return;
    }

    if (this.pulsePromise) {
      return this.pulsePromise;
    }

    const eligibility = this.getEligibility();
    if (!eligibility.ok) {
      this.emitPulse('skipped', reason, eligibility.skipReason);
      return;
    }

    const elapsedSinceLastPulse = Date.now() - this.lastPulseAt;
    if (this.lastPulseAt > 0 && elapsedSinceLastPulse < STARTUP_PERF_CONFIG.SYNC_EVENT_COOLDOWN_MS) {
      this.emitPulse('skipped', reason, 'cooldown');
      return;
    }

    if (
      FEATURE_FLAGS.RESUME_PULSE_DEDUP_V1 &&
      this.appLifecycle.isHeavyRecoveryInCooldown(APP_LIFECYCLE_CONFIG.PULSE_SUPPRESS_AFTER_HEAVY_MS)
    ) {
      this.emitPulse('skipped', reason, 'post-heavy-cooldown');
      return;
    }

    this.pulsePromise = this.executePulse(reason).finally(() => {
      this.pulsePromise = null;
    });

    return this.pulsePromise;
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

  private async executePulse(reason: SyncPulseReason): Promise<void> {
    this.emitPulse('triggered', reason);

    try {
      const recoveryTicket = this.appLifecycle.getCurrentRecoveryTicket();
      if (FEATURE_FLAGS.RECOVERY_TICKET_DEDUP_V1 && recoveryTicket) {
        this.emitPulse('skipped', reason, 'same-ticket');
        return;
      }

      // 只在实际执行同步后才更新 lastPulseAt，跳过时不更新以避免延长冷却窗口
      this.lastPulseAt = Date.now();

      const sessionSnapshot = FEATURE_FLAGS.RESUME_SESSION_SNAPSHOT_V1
        ? this.sessionManager.getRecentValidationSnapshot(10_000)
        : null;

      if (FEATURE_FLAGS.RESUME_INTERACTION_FIRST_V1) {
        await this.simpleSync.recoverAfterResume(`pulse:${reason}`, {
          mode: 'light',
          allowRemoteProbe: false,
          sessionValidated: sessionSnapshot?.valid === true,
          skipSessionValidationWithinMs: 10_000,
          recoveryTicketId: recoveryTicket?.id,
        });
      } else {
        await this.simpleSync.recoverAfterResume(`pulse:${reason}`, {
          recoveryTicketId: recoveryTicket?.id,
        });
      }
      this.emitPulse('success', reason);
    } catch (error) {
      this.emitPulse('failed', reason);
      this.logger.warn('同步脉冲执行失败', { reason, error });
      this.sentryLazyLoader.captureException(error, {
        operation: 'sync.pulse',
        reason,
      });
    }
  }

  private emitPulse(
    status: SyncPulseStatus,
    reason: SyncPulseReason,
    skipReason?: SyncPulseSkipReason
  ): void {
    this.addPulseBreadcrumb(
      status === 'skipped'
        ? `sync.pulse.skipped.${skipReason ?? 'unknown'}`
        : `sync.pulse.${status}`,
      reason,
      skipReason ? { skipReason } : undefined
    );

    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('nanoflow:sync-pulse', {
      detail: {
        status,
        reason,
        skipReason,
      },
    }));
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
