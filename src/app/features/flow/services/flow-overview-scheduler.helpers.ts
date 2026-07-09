import type { OverviewUpdateSource } from './flow-overview-viewport.helpers';

export type OverviewBindingsUpdateMode = 'immediate' | 'deferred';

interface OverviewBindingTarget {
  requestUpdate: () => void;
  updateAllTargetBindings: () => void;
}

interface OverviewBindingsSchedulerOptions {
  dragThrottleMs: number;
  idleThrottleMs: number;
  onUpdateError?: (error: unknown) => void;
}

export class OverviewBindingsScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending = false;
  private lastMode: OverviewBindingsUpdateMode | null = null;

  constructor(private readonly options: OverviewBindingsSchedulerOptions) {}

  schedule(mode: OverviewBindingsUpdateMode, getOverview: () => OverviewBindingTarget | null): void {
    const overview = getOverview();
    if (!overview) return;

    if (mode === 'immediate') {
      this.scheduleImmediate(overview);
      return;
    }

    this.scheduleDeferred(getOverview);
  }

  cancelPendingRefresh(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending = false;
    this.lastMode = null;
  }

  private scheduleImmediate(overview: OverviewBindingTarget): void {
    if (this.pending && this.lastMode === 'immediate') {
      return;
    }

    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    this.pending = true;
    this.lastMode = 'immediate';
    try {
      overview.updateAllTargetBindings();
      overview.requestUpdate();
    } catch (error) {
      this.resetPendingState();
      if (this.options.onUpdateError) {
        this.options.onUpdateError(error);
        return;
      }
      throw error;
    }
    this.timer = setTimeout(() => this.resetPendingState(), this.options.dragThrottleMs);
  }

  private scheduleDeferred(getOverview: () => OverviewBindingTarget | null): void {
    if (this.pending) {
      return;
    }

    this.pending = true;
    this.lastMode = 'deferred';
    this.timer = setTimeout(() => {
      try {
        const overview = getOverview();
        if (overview) {
          overview.updateAllTargetBindings();
          overview.requestUpdate();
        }
      } catch (error) {
        if (!this.options.onUpdateError) {
          throw error;
        }
        this.options.onUpdateError(error);
      } finally {
        this.resetPendingState();
      }
    }, this.options.idleThrottleMs);
  }

  private resetPendingState(): void {
    this.pending = false;
    this.timer = null;
    this.lastMode = null;
  }
}

interface OverviewViewportUpdateSchedulerOptions {
  throttleMs: number;
  requestAnimationFrameFn?: (callback: FrameRequestCallback) => number;
  cancelAnimationFrameFn?: (handle: number) => void;
  nowFn?: () => number;
  onApplyError?: (error: unknown) => void;
}

interface OverviewViewportUpdateRuntime {
  applyUpdate: (source: OverviewUpdateSource) => void;
  hasOverview: () => boolean;
  isDestroyed: () => boolean;
  isNodeDragging: () => boolean;
}

export class OverviewViewportUpdateScheduler {
  private scheduledRafId: number | null = null;
  private pendingSource: OverviewUpdateSource | null = null;
  private interactionLastApplyAt = 0;
  private readonly requestAnimationFrameFn: (callback: FrameRequestCallback) => number;
  private readonly cancelAnimationFrameFn: (handle: number) => void;
  private readonly nowFn: () => number;
  private readonly onApplyError?: (error: unknown) => void;

  constructor(private readonly options: OverviewViewportUpdateSchedulerOptions) {
    this.requestAnimationFrameFn = options.requestAnimationFrameFn ?? requestAnimationFrame;
    this.cancelAnimationFrameFn = options.cancelAnimationFrameFn ?? cancelAnimationFrame;
    this.nowFn = options.nowFn ?? Date.now;
    this.onApplyError = options.onApplyError;
  }

  schedule(source: OverviewUpdateSource, runtime: OverviewViewportUpdateRuntime): void {
    if (runtime.isDestroyed() || !runtime.hasOverview()) return;

    if (source === 'document') {
      this.pendingSource = source;
    }

    if (source !== 'document' && runtime.isNodeDragging()) {
      const now = this.nowFn();
      if (now - this.interactionLastApplyAt < this.options.throttleMs) return;
      this.interactionLastApplyAt = now;
    }

    if (this.pendingSource !== 'document') {
      this.pendingSource = source;
    }

    if (this.scheduledRafId !== null) {
      return;
    }

    this.scheduledRafId = this.requestAnimationFrameFn(() => {
      this.scheduledRafId = null;
      const nextSource = this.pendingSource ?? source;
      this.pendingSource = null;
      if (runtime.isDestroyed() || !runtime.hasOverview()) return;
      try {
        runtime.applyUpdate(nextSource);
      } catch (error) {
        this.onApplyError?.(error);
      }
    });
  }

  applyNow(source: OverviewUpdateSource, runtime: OverviewViewportUpdateRuntime): void {
    if (runtime.isDestroyed() || !runtime.hasOverview()) return;

    if (this.scheduledRafId !== null) {
      this.cancelAnimationFrameFn(this.scheduledRafId);
      this.scheduledRafId = null;
    }
    this.pendingSource = null;
    try {
      runtime.applyUpdate(source);
    } catch (error) {
      this.onApplyError?.(error);
    }
  }

  cancelPendingNonDocument(): void {
    if (this.scheduledRafId === null || this.pendingSource === 'document') {
      return;
    }

    this.cancelAnimationFrameFn(this.scheduledRafId);
    this.scheduledRafId = null;
    this.pendingSource = null;
  }

  cancelAll(): void {
    if (this.scheduledRafId !== null) {
      this.cancelAnimationFrameFn(this.scheduledRafId);
      this.scheduledRafId = null;
    }
    this.pendingSource = null;
  }

  resetInteractionThrottle(): void {
    this.interactionLastApplyAt = 0;
  }

  getInteractionThrottleTimestamp(): number {
    return this.interactionLastApplyAt;
  }

  setInteractionThrottleTimestamp(value: number): void {
    this.interactionLastApplyAt = value;
  }
}
