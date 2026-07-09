export type GateMotionState =
  | 'idle'
  | 'entering'
  | 'heave_read'
  | 'heavy_drop'
  | 'settling';

export interface GateAnimationControllerOptions {
  getAnimation: () => GateMotionState;
  setAnimation: (state: GateMotionState) => void;
  prefersReducedMotion: () => boolean;
  run: (callback: () => void) => void;
  debug: (message: string) => void;
  warn: (message: string) => void;
}

const ANIMATION_START_GRACE_MS = 800;
const ANIMATION_DURATION_MAX_MS = 1500;

export class GateAnimationController {
  private timeoutId: ReturnType<typeof setTimeout> | null = null;
  private pendingState: GateMotionState | null = null;
  private pendingTimeout: (() => void) | null = null;
  private started = false;

  constructor(private readonly options: GateAnimationControllerOptions) {}

  setWithTimeout(state: GateMotionState, onTimeout?: () => void): void {
    this.clear();

    if (state !== 'idle' && this.options.prefersReducedMotion()) {
      this.options.setAnimation('idle');
      this.options.debug(`Reduced motion: skipping animation state '${state}'`);
      onTimeout?.();
      return;
    }

    this.options.setAnimation(state);
    if (state === 'idle') return;

    this.pendingState = state;
    this.pendingTimeout = onTimeout ?? null;
    this.started = false;
    this.timeoutId = setTimeout(() => this.handleStartTimeout(state), ANIMATION_START_GRACE_MS);
  }

  notifyStarted(state: GateMotionState): void {
    if (this.pendingState !== state) return;
    if (this.options.getAnimation() !== state) return;
    if (this.started) return;

    this.started = true;
    this.clearTimerOnly();
    this.timeoutId = setTimeout(() => this.handleDurationTimeout(state), ANIMATION_DURATION_MAX_MS);
  }

  clear(): void {
    this.clearTimerOnly();
    this.resetPending();
  }

  private handleStartTimeout(state: GateMotionState): void {
    this.options.run(() => {
      if (this.options.getAnimation() !== state) return;
      if (this.started) return;

      this.options.warn(`Animation did not start within ${ANIMATION_START_GRACE_MS}ms, forcing idle from '${state}'`);
      this.completeTimedOutAnimation(state);
    });
  }

  private handleDurationTimeout(state: GateMotionState): void {
    this.options.run(() => {
      if (this.options.getAnimation() !== state) return;

      this.options.warn(`Animation duration exceeded ${ANIMATION_DURATION_MAX_MS}ms, forcing idle from '${state}'`);
      this.completeTimedOutAnimation(state);
    });
  }

  private completeTimedOutAnimation(state: GateMotionState): void {
    const callback = this.pendingTimeout;
    this.resetPending();
    callback?.();
    if (this.options.getAnimation() === state) {
      this.options.setAnimation('idle');
    }
  }

  private clearTimerOnly(): void {
    if (this.timeoutId === null) return;
    clearTimeout(this.timeoutId);
    this.timeoutId = null;
  }

  private resetPending(): void {
    this.pendingState = null;
    this.pendingTimeout = null;
    this.started = false;
  }
}
