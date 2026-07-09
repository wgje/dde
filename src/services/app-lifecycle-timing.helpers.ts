export function markLifecyclePerformance(markName: string): void {
  if (typeof performance === 'undefined' || typeof performance.mark !== 'function') {
    return;
  }
  performance.mark(markName);
}

export function monotonicNow(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

export function measureLifecyclePerformance(measureName: string, startMark: string, endMark: string): void {
  if (typeof performance === 'undefined' || typeof performance.measure !== 'function') {
    return;
  }

  try {
    performance.measure(measureName, { start: startMark, end: endMark });
  } catch {
    try {
      performance.measure(measureName, startMark, endMark);
    } catch {
      // 浏览器 performance mark 不完整时，恢复流程不能因此中断。
    }
  }
}

export function createRecoveryTicketId(mode: 'light' | 'heavy'): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${mode}:${crypto.randomUUID()}`;
  }
  return `${mode}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
}

export async function withLifecycleTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`Lifecycle resume timeout after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  }
}

export function runIdleTask(task: () => void): void {
  const requestIdleCallback = typeof window !== 'undefined'
    ? (
        window as Window & {
          requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
        }
      ).requestIdleCallback
    : undefined;

  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(() => task(), { timeout: 1200 });
    return;
  }
  setTimeout(task, 0);
}
