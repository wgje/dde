import { describe, expect, it, vi } from 'vitest';

import type { UserSessionService } from './user-session.service';

export interface UserSessionIdleTaskSpecContext {
  service: () => UserSessionService;
}

export function registerUserSessionIdleTaskSpecs(
  context: UserSessionIdleTaskSpecContext,
): void {
  describe('runIdleTask', () => {
    it('requestIdleCallback 不触发时应由超时兜底执行任务', () => {
      vi.useFakeTimers();
      const originalRic = (window as Window & { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
      const task = vi.fn();

      Object.defineProperty(window, 'requestIdleCallback', {
        value: vi.fn(() => 1),
        configurable: true,
        writable: true,
      });

      (
        context.service() as unknown as {
          runIdleTask: (task: () => void) => void;
        }
      ).runIdleTask(task);

      expect(task).not.toHaveBeenCalled();

      vi.advanceTimersByTime(2000);

      expect(task).toHaveBeenCalledTimes(1);

      Object.defineProperty(window, 'requestIdleCallback', {
        value: originalRic,
        configurable: true,
        writable: true,
      });
      vi.useRealTimers();
    });

    it('DestroyRef 触发后不应再执行等待中的 idle 任务', () => {
      vi.useFakeTimers();
      const originalRic = (window as Window & { requestIdleCallback?: (
        cb: () => void
      ) => number }).requestIdleCallback;
      const task = vi.fn();

      Object.defineProperty(window, 'requestIdleCallback', {
        value: vi.fn(() => 1),
        configurable: true,
        writable: true,
      });

      const service = context.service();
      (
        service as unknown as {
          runIdleTask: (task: () => void) => void;
        }
      ).runIdleTask(task);

      (service as UserSessionService & { ngOnDestroy(): void }).ngOnDestroy();
      vi.advanceTimersByTime(2000);

      expect(task).not.toHaveBeenCalled();

      Object.defineProperty(window, 'requestIdleCallback', {
        value: originalRic,
        configurable: true,
        writable: true,
      });
      vi.useRealTimers();
    });

    it('DestroyRef 触发时应取消等待中的 requestIdleCallback', () => {
      const originalRic = (window as Window & {
        requestIdleCallback?: (cb: () => void) => number;
      }).requestIdleCallback;
      const originalCancelRic = (window as Window & {
        cancelIdleCallback?: (handle: number) => void;
      }).cancelIdleCallback;
      const cancelIdleCallback = vi.fn();

      Object.defineProperty(window, 'requestIdleCallback', {
        value: vi.fn(() => 42),
        configurable: true,
        writable: true,
      });
      Object.defineProperty(window, 'cancelIdleCallback', {
        value: cancelIdleCallback,
        configurable: true,
        writable: true,
      });

      const service = context.service();
      (
        service as unknown as {
          runIdleTask: (task: () => void) => void;
        }
      ).runIdleTask(vi.fn());

      (service as UserSessionService & { ngOnDestroy(): void }).ngOnDestroy();

      expect(cancelIdleCallback).toHaveBeenCalledWith(42);

      Object.defineProperty(window, 'requestIdleCallback', {
        value: originalRic,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(window, 'cancelIdleCallback', {
        value: originalCancelRic,
        configurable: true,
        writable: true,
      });
    });
  });
}
