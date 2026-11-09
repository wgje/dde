import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  WorkspaceShellFlowPrewarmSchedulerController,
} from './workspace-shell-flow-prewarm-scheduler.controller';

describe('WorkspaceShellFlowPrewarmSchedulerController', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not retain a handle when the scheduler runs synchronously', () => {
    const clearScheduled = vi.fn();
    const callback = vi.fn();
    const controller = new WorkspaceShellFlowPrewarmSchedulerController({
      schedule: scheduledCallback => {
        scheduledCallback();
        return 9;
      },
      clearScheduled,
    });

    controller.schedule(callback);
    controller.clear();

    expect(callback).toHaveBeenCalledOnce();
    expect(clearScheduled).not.toHaveBeenCalled();
  });

  it('clears pending scheduled work once', () => {
    const clearScheduled = vi.fn();
    const controller = new WorkspaceShellFlowPrewarmSchedulerController({
      schedule: vi.fn().mockReturnValue(7),
      clearScheduled,
    });

    controller.schedule(vi.fn());
    controller.clear();
    controller.clear();

    expect(clearScheduled).toHaveBeenCalledOnce();
    expect(clearScheduled).toHaveBeenCalledWith(7);
  });

  it('uses the browser idle callback APIs when available', () => {
    const requestIdleCallback = vi.fn().mockReturnValue(13);
    const cancelIdleCallback = vi.fn();
    vi.stubGlobal('requestIdleCallback', requestIdleCallback);
    vi.stubGlobal('cancelIdleCallback', cancelIdleCallback);
    const callback = vi.fn();
    const controller = new WorkspaceShellFlowPrewarmSchedulerController();

    controller.schedule(callback);
    controller.clear();

    expect(requestIdleCallback).toHaveBeenCalledWith(expect.any(Function), { timeout: 750 });
    expect(cancelIdleCallback).toHaveBeenCalledWith(13);
  });

  it('does not retain a handle when scheduling throws', () => {
    const error = new Error('schedule failed');
    const clearScheduled = vi.fn();
    const controller = new WorkspaceShellFlowPrewarmSchedulerController({
      schedule: () => {
        throw error;
      },
      clearScheduled,
    });

    expect(() => controller.schedule(vi.fn())).toThrow(error);
    controller.clear();

    expect(clearScheduled).not.toHaveBeenCalled();
  });
});
