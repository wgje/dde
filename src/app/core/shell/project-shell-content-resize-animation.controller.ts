import { signal } from '@angular/core';

export class ProjectShellContentResizeAnimationController {
  private static readonly DURATION_MS = 320;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;

  readonly animating = signal(false);

  enable(): void {
    this.clearTimer();
    const generation = this.generation + 1;
    this.generation = generation;
    this.animating.set(true);
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      timer = setTimeout(() => {
        if (this.generation !== generation || this.timer !== timer) {
          return;
        }

        this.animating.set(false);
        this.timer = null;
      }, ProjectShellContentResizeAnimationController.DURATION_MS);
    } catch {
      if (this.generation === generation) {
        this.animating.set(false);
        this.timer = null;
      }
      return;
    }
    this.timer = timer;
  }

  clear(): void {
    this.clearTimer();
    this.animating.set(false);
  }

  private clearTimer(): void {
    if (this.timer === null) return;

    const timer = this.timer;
    this.timer = null;
    this.generation += 1;
    try {
      clearTimeout(timer);
    } catch {
      // Generation invalidation keeps stale callbacks from changing new state.
    }
  }
}
