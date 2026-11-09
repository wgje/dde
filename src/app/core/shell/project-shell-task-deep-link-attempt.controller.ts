export class ProjectShellTaskDeepLinkAttemptController {
  private destroyed = false;
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  beginAttempt(): number {
    this.generation += 1;
    this.clearTimer();
    return this.generation;
  }

  isCurrent(generation: number): boolean {
    return !this.destroyed && generation === this.generation;
  }

  schedule(generation: number, delay: number, callback: () => void): void {
    this.clearTimer();
    const timer = setTimeout(() => {
      if (this.timer === timer) {
        this.timer = null;
      }
      if (!this.isCurrent(generation)) return;

      callback();
    }, delay);
    this.timer = timer;
  }

  destroy(): void {
    this.destroyed = true;
    this.generation += 1;
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer === null) return;

    clearTimeout(this.timer);
    this.timer = null;
  }
}
