import { Injectable, OnDestroy, computed, signal } from '@angular/core';
import { PARKING_CONFIG } from '../config/parking.config';

export type FocusPerformanceTier = 'T0' | 'T1' | 'T2';

@Injectable({
  providedIn: 'root',
})
export class PerformanceTierService implements OnDestroy {
  readonly tier = signal<FocusPerformanceTier>('T0');
  readonly isTier1Plus = computed(() => this.tier() === 'T1' || this.tier() === 'T2');
  readonly isTier2 = computed(() => this.tier() === 'T2');
  readonly lastMeasuredFps = signal(60);

  private rafId: number | null = null;
  private frameCount = 0;
  private lastWindowStart = 0;
  private lowWindowCount = 0;
  private recoverWindowCount = 0;
  private activeConsumers = 0;

  ngOnDestroy(): void {
    this.stopMeasuring();
  }

  /** 消费方调用以启动 FPS 采样（引用计数，多次调用安全） */
  startMeasuring(): void {
    this.activeConsumers += 1;
    if (this.activeConsumers === 1) {
      this.resumeRaf();
    }
  }

  /** 消费方不再需要性能监测时调用 */
  stopMeasuring(): void {
    this.activeConsumers = Math.max(0, this.activeConsumers - 1);
    if (this.activeConsumers === 0) {
      this.pauseRaf();
    }
  }

  private resumeRaf(): void {
    if (this.rafId !== null) return;
    if (typeof window === 'undefined' || typeof performance === 'undefined' || typeof requestAnimationFrame === 'undefined') {
      return;
    }
    this.lastWindowStart = performance.now();
    this.frameCount = 0;
    this.rafId = requestAnimationFrame(ts => this.onFrame(ts));
  }

  private pauseRaf(): void {
    if (this.rafId !== null && typeof cancelAnimationFrame !== 'undefined') {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private onFrame(timestamp: number): void {
    this.frameCount += 1;
    const elapsed = timestamp - this.lastWindowStart;
    if (elapsed >= PARKING_CONFIG.FOCUS_PERF_SAMPLE_WINDOW_MS) {
      const fps = (this.frameCount * 1000) / elapsed;
      this.lastMeasuredFps.set(Math.max(0, Math.round(fps)));
      this.evaluateTier(fps);
      this.frameCount = 0;
      this.lastWindowStart = timestamp;
    }

    this.rafId = requestAnimationFrame(ts => this.onFrame(ts));
  }

  private evaluateTier(fps: number): void {
    const current = this.tier();
    const degradeTarget: FocusPerformanceTier =
      fps < PARKING_CONFIG.FOCUS_PERF_T2_FPS
        ? 'T2'
        : fps < PARKING_CONFIG.FOCUS_PERF_T1_FPS
          ? 'T1'
          : 'T0';

    if (degradeTarget !== 'T0' && this.isWorse(degradeTarget, current)) {
      this.lowWindowCount += 1;
      this.recoverWindowCount = 0;
      if (this.lowWindowCount >= PARKING_CONFIG.FOCUS_PERF_HYSTERESIS_WINDOWS) {
        this.tier.set(degradeTarget);
        this.lowWindowCount = 0;
      }
      return;
    }

    if (fps >= PARKING_CONFIG.FOCUS_PERF_RECOVER_FPS && current !== 'T0') {
      this.recoverWindowCount += 1;
      this.lowWindowCount = 0;
      if (this.recoverWindowCount >= PARKING_CONFIG.FOCUS_PERF_HYSTERESIS_WINDOWS) {
        this.tier.set('T0');
        this.recoverWindowCount = 0;
      }
      return;
    }

    this.lowWindowCount = 0;
    this.recoverWindowCount = 0;
  }

  private isWorse(next: FocusPerformanceTier, current: FocusPerformanceTier): boolean {
    const rank: Record<FocusPerformanceTier, number> = { T0: 0, T1: 1, T2: 2 };
    return rank[next] > rank[current];
  }
}
