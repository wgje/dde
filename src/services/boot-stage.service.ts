import { Injectable, computed, signal } from '@angular/core';
import { pushStartupTrace } from '../utils/startup-trace';

export type BootStage = 'booting' | 'launch-shell' | 'handoff' | 'ready';

export interface BootStageMetrics {
  launchShellVisibleMs: number | null;
  workspaceHandoffMs: number | null;
  appReadyMs: number | null;
  loaderHiddenMs: number | null;
  blankGapMs: number;
}

const BOOT_STAGE_ORDER: Record<BootStage, number> = {
  booting: 0,
  'launch-shell': 1,
  handoff: 2,
  ready: 3,
};

const DEFAULT_METRICS: BootStageMetrics = {
  launchShellVisibleMs: null,
  workspaceHandoffMs: null,
  appReadyMs: null,
  loaderHiddenMs: null,
  blankGapMs: 0,
};

@Injectable({
  providedIn: 'root',
})
export class BootStageService {
  private readonly bootStartedAt = Date.now();
  private readonly stage = signal<BootStage>('booting');
  private readonly metricsState = signal<BootStageMetrics>({ ...DEFAULT_METRICS });

  readonly currentStage = this.stage.asReadonly();
  readonly metrics = this.metricsState.asReadonly();
  readonly isLaunchShellVisible = computed(() => BOOT_STAGE_ORDER[this.stage()] >= BOOT_STAGE_ORDER['launch-shell']);
  readonly isWorkspaceHandoffReady = computed(() => BOOT_STAGE_ORDER[this.stage()] >= BOOT_STAGE_ORDER.handoff);
  readonly isApplicationReady = computed(() => this.stage() === 'ready');

  constructor() {
    this.publishGlobals();
  }

  markLaunchShellVisible(): void {
    this.advanceStage('launch-shell', (metrics, elapsedMs) => {
      if (metrics.launchShellVisibleMs === null) {
        metrics.launchShellVisibleMs = elapsedMs;
      }
    });
  }

  markWorkspaceHandoffReady(): void {
    this.advanceStage('handoff', (metrics, elapsedMs) => {
      if (metrics.workspaceHandoffMs === null) {
        metrics.workspaceHandoffMs = elapsedMs;
      }
    });
  }

  markApplicationReady(): void {
    this.advanceStage('ready', (metrics, elapsedMs) => {
      if (metrics.appReadyMs === null) {
        metrics.appReadyMs = elapsedMs;
      }
    });
  }

  noteLoaderHidden(): void {
    this.metricsState.update((current) => {
      const next = { ...current };
      if (next.loaderHiddenMs === null) {
        next.loaderHiddenMs = this.elapsedSinceBoot();
      }
      next.blankGapMs = this.computeBlankGap(next);
      return next;
    });
    pushStartupTrace('boot.loader_hidden', {
      loaderHiddenMs: this.metricsState().loaderHiddenMs,
      blankGapMs: this.metricsState().blankGapMs,
    });
    this.publishGlobals();
  }

  private advanceStage(nextStage: BootStage, onMetrics?: (metrics: BootStageMetrics, elapsedMs: number) => void): void {
    if (BOOT_STAGE_ORDER[nextStage] <= BOOT_STAGE_ORDER[this.stage()]) {
      return;
    }

    const elapsedMs = this.elapsedSinceBoot();
    this.stage.set(nextStage);
    this.metricsState.update((current) => {
      const next = { ...current };
      onMetrics?.(next, elapsedMs);
      next.blankGapMs = this.computeBlankGap(next);
      return next;
    });
    this.publishGlobals();
  }

  private elapsedSinceBoot(): number {
    return Math.max(0, Date.now() - this.bootStartedAt);
  }

  private computeBlankGap(metrics: BootStageMetrics): number {
    if (metrics.loaderHiddenMs === null || metrics.launchShellVisibleMs === null) {
      return 0;
    }
    return Math.max(0, metrics.launchShellVisibleMs - metrics.loaderHiddenMs);
  }

  private publishGlobals(): void {
    if (typeof window === 'undefined') {
      return;
    }

    window.__NANOFLOW_BOOT_STAGE__ = this.stage();
    window.__NANOFLOW_LAUNCH_SHELL_VISIBLE__ = this.isLaunchShellVisible();
    window.__NANOFLOW_READY__ = this.isApplicationReady();
    pushStartupTrace('boot.stage', {
      stage: this.stage(),
      metrics: this.metrics(),
    });

    window.dispatchEvent(new CustomEvent('nanoflow:boot-stage', {
      detail: {
        stage: this.stage(),
        metrics: this.metrics(),
      },
    }));
  }
}
