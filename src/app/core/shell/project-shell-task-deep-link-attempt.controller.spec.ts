import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ProjectShellTaskDeepLinkAttemptController,
} from './project-shell-task-deep-link-attempt.controller';

describe('ProjectShellTaskDeepLinkAttemptController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('invalidates the previous generation when a newer attempt begins', () => {
    const controller = new ProjectShellTaskDeepLinkAttemptController();

    const first = controller.beginAttempt();
    const second = controller.beginAttempt();

    expect(controller.isCurrent(first)).toBe(false);
    expect(controller.isCurrent(second)).toBe(true);
  });

  it('runs only the current scheduled attempt after replacing a pending timer', () => {
    const controller = new ProjectShellTaskDeepLinkAttemptController();
    const firstCallback = vi.fn();
    const secondCallback = vi.fn();
    const first = controller.beginAttempt();
    controller.schedule(first, 100, firstCallback);

    const second = controller.beginAttempt();
    controller.schedule(second, 100, secondCallback);
    vi.advanceTimersByTime(100);

    expect(firstCallback).not.toHaveBeenCalled();
    expect(secondCallback).toHaveBeenCalledOnce();
  });

  it('clears a pending timer whose runtime handle is zero', () => {
    const timer = 0 as unknown as ReturnType<typeof setTimeout>;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => timer);
    const clearTimeoutSpy = vi
      .spyOn(globalThis, 'clearTimeout')
      .mockImplementation(() => undefined);
    const controller = new ProjectShellTaskDeepLinkAttemptController();
    const generation = controller.beginAttempt();

    controller.schedule(generation, 100, vi.fn());
    controller.destroy();

    expect(clearTimeoutSpy).toHaveBeenCalledWith(0);
    expect(controller.isCurrent(generation)).toBe(false);
  });

  it('keeps attempt generation and timers outside the task deep-link controller', () => {
    const source = readFileSync(
      join(__dirname, 'project-shell-task-deep-link.controller.ts'),
      'utf8',
    );

    expect(source).toContain('ProjectShellTaskDeepLinkAttemptController');
    expect(source).not.toContain('deepLinkGeneration');
    expect(source).not.toContain('deepLinkRetryTimer');
    expect(source).not.toContain('setTimeout(');
    expect(source).not.toContain('clearTimeout(');
  });
});
