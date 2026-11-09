/**
 * TimerHandle — 可复用的定时器封装
 * 解决多个 timer 字段的重复 clear + set + null 模式。
 */
export class TimerHandle {
  private id: ReturnType<typeof setTimeout> | null = null;

  get active(): boolean {
    return this.id !== null;
  }

  schedule(fn: () => void, delay: number): void {
    this.cancel();
    const safeDelay = Number.isFinite(delay) && delay >= 0 ? delay : 0;
    const id = setTimeout(() => {
      if (this.id !== id) {
        return;
      }

      this.id = null;
      fn();
    }, safeDelay);
    this.id = id;
  }

  cancel(): void {
    if (this.id === null) return;

    const id = this.id;
    this.id = null;
    try {
      clearTimeout(id);
    } catch {
      // Timer cleanup is best-effort; internal state must still be released.
    }
  }
}

/**
 * IntervalHandle — 可复用的 setInterval 封装
 */
export class IntervalHandle {
  private id: ReturnType<typeof setInterval> | null = null;

  get active(): boolean {
    return this.id !== null;
  }

  start(fn: () => void, interval: number): void {
    this.stop();
    const safeInterval = Number.isFinite(interval) && interval > 0 ? interval : 1;
    const id = setInterval(() => {
      if (this.id !== id) {
        return;
      }

      fn();
    }, safeInterval);
    this.id = id;
  }

  stop(): void {
    if (this.id === null) return;

    const id = this.id;
    this.id = null;
    try {
      clearInterval(id);
    } catch {
      // Interval cleanup is best-effort; internal state must still be released.
    }
  }
}
