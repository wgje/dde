import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { STARTUP_PERF_CONFIG } from '../config/startup-performance.config';
import { FEATURE_FLAGS } from '../config/feature-flags.config';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';

type StartupTier = 'p0' | 'p1' | 'p2';

type TriggerReason =
  | 'initialize'
  | 'auth-ready'
  | 'timer'
  | 'visible'
  | 'online'
  | 'focus'
  | 'manual';

@Injectable({
  providedIn: 'root'
})
export class StartupTierOrchestratorService {
  private readonly sentry = inject(SentryLazyLoaderService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly tierP0 = signal(false);
  private readonly tierP1 = signal(false);
  private readonly tierP2 = signal(false);

  private initialized = false;
  private authReady = false;
  private destroyed = false;

  private p1Timer: ReturnType<typeof setTimeout> | null = null;
  private p2Timer: ReturnType<typeof setTimeout> | null = null;
  private minVisibleTimer: ReturnType<typeof setTimeout> | null = null;

  private visibleSince = typeof document !== 'undefined' && !document.hidden ? Date.now() : 0;
  private lastTriggerAt = new Map<StartupTier, number>();
  private triggerPromise = new Map<StartupTier, Promise<void>>();

  private readonly visibilityListener = () => {
    if (document.hidden) return;
    this.visibleSince = Date.now();
    void this.triggerNow('p2', 'visible');
  };

  private readonly onlineListener = () => {
    void this.triggerNow('p2', 'online');
  };

  private readonly focusListener = () => {
    void this.triggerNow('p2', 'focus');
  };

  initialize(): void {
    if (this.initialized || this.destroyed) return;
    this.initialized = true;

    this.setTier('p0', true, 'initialize');

    if (!FEATURE_FLAGS.TIERED_STARTUP_HYDRATION_V1) {
      this.setTier('p1', true, 'initialize');
      this.setTier('p2', true, 'initialize');
      return;
    }

    this.p1Timer = setTimeout(() => {
      void this.triggerNow('p1', 'timer');
    }, STARTUP_PERF_CONFIG.P1_INTERACTION_HYDRATE_DELAY_MS);

    this.p2Timer = setTimeout(() => {
      void this.triggerNow('p2', 'timer');
    }, STARTUP_PERF_CONFIG.P2_SYNC_HYDRATE_DELAY_MS);

    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.onlineListener, { passive: true });
      window.addEventListener('focus', this.focusListener, { passive: true });
    }

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.visibilityListener, { passive: true });
    }

    this.destroyRef.onDestroy(() => this.destroy());
  }

  markAuthReady(): void {
    this.authReady = true;
    void this.triggerNow('p2', 'auth-ready');
  }

  isTierReady(tier: StartupTier): boolean {
    if (tier === 'p0') return this.tierP0();
    if (tier === 'p1') return this.tierP1();
    return this.tierP2();
  }

  async triggerNow(tier: StartupTier, reason: TriggerReason): Promise<void> {
    if (this.destroyed) return;

    const current = this.triggerPromise.get(tier);
    if (current) return current;

    const running = this.runTrigger(tier, reason)
      .catch(() => {
        // 编排层仅做 gating，失败不向上抛，避免阻断主流程
      })
      .finally(() => {
        if (this.triggerPromise.get(tier) === running) {
          this.triggerPromise.delete(tier);
        }
      });

    this.triggerPromise.set(tier, running);
    return running;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    if (this.p1Timer) {
      clearTimeout(this.p1Timer);
      this.p1Timer = null;
    }
    if (this.p2Timer) {
      clearTimeout(this.p2Timer);
      this.p2Timer = null;
    }
    if (this.minVisibleTimer) {
      clearTimeout(this.minVisibleTimer);
      this.minVisibleTimer = null;
    }

    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.onlineListener);
      window.removeEventListener('focus', this.focusListener);
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityListener);
    }
  }

  private async runTrigger(tier: StartupTier, reason: TriggerReason): Promise<void> {
    if (this.isTierReady(tier)) return;

    const now = Date.now();
    const cooldown = STARTUP_PERF_CONFIG.SYNC_EVENT_COOLDOWN_MS;
    const last = this.lastTriggerAt.get(tier) ?? 0;
    if (now - last < cooldown) {
      this.addBreadcrumb('startup.tier.skip_reason', {
        tier,
        reason,
        skip: 'cooldown'
      });
      return;
    }

    if (tier === 'p1') {
      this.lastTriggerAt.set(tier, now);
      this.setTier('p1', true, reason);
      return;
    }

    if (tier === 'p2') {
      if (!this.authReady) {
        this.addBreadcrumb('startup.tier.skip_reason', {
          tier,
          reason,
          skip: 'auth_not_ready'
        });
        return;
      }

      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        this.addBreadcrumb('startup.tier.skip_reason', {
          tier,
          reason,
          skip: 'offline'
        });
        return;
      }

      if (typeof document !== 'undefined' && document.hidden) {
        this.addBreadcrumb('startup.tier.skip_reason', {
          tier,
          reason,
          skip: 'hidden'
        });
        return;
      }

      const visibleElapsed = now - this.visibleSince;
      const minVisible = STARTUP_PERF_CONFIG.P2_SYNC_MIN_VISIBLE_MS;
      if (visibleElapsed < minVisible) {
        const waitMs = minVisible - visibleElapsed;
        if (this.minVisibleTimer) clearTimeout(this.minVisibleTimer);
        this.minVisibleTimer = setTimeout(() => {
          void this.triggerNow('p2', 'visible');
        }, waitMs);
        this.addBreadcrumb('startup.tier.skip_reason', {
          tier,
          reason,
          skip: 'min_visible_not_reached',
          waitMs,
        });
        return;
      }

      this.lastTriggerAt.set(tier, now);
      this.setTier('p2', true, reason);
    }
  }

  private setTier(tier: StartupTier, ready: boolean, reason: TriggerReason): void {
    this.addBreadcrumb(`startup.tier.${tier}.start`, { tier, reason });

    if (tier === 'p0') this.tierP0.set(ready);
    if (tier === 'p1') this.tierP1.set(ready);
    if (tier === 'p2') this.tierP2.set(ready);

    this.addBreadcrumb(`startup.tier.${tier}.done`, { tier, reason, ready });
  }

  private addBreadcrumb(message: string, data: Record<string, unknown>): void {
    this.sentry.addBreadcrumb({
      category: 'startup',
      message,
      level: 'info',
      data,
    });
  }
}
