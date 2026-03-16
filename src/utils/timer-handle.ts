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
    this.id = setTimeout(() => {
      this.id = null;
      fn();
    }, safeDelay);
  }

  cancel(): void {
    if (this.id !== null) {
      clearTimeout(this.id);
      this.id = null;
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
    this.id = setInterval(fn, safeInterval);
  }

  stop(): void {
    if (this.id !== null) {
      clearInterval(this.id);
      this.id = null;
    }
  }
}
