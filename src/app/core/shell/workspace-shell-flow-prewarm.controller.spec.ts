import { describe, expect, it, vi } from 'vitest';

import {
  WorkspaceShellFlowPrewarmController,
  type FlowPrewarmStatus,
} from './workspace-shell-flow-prewarm.controller';

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}

function runScheduled(callback: (() => void) | null): void {
  callback?.();
}

describe('WorkspaceShellFlowPrewarmController', () => {
  it('coalesces repeated aggressive prewarm requests into one load', async () => {
    const prewarmFlow = vi.fn().mockResolvedValue({ warmed: true });
    const controller = new WorkspaceShellFlowPrewarmController({
      isDestroyed: () => false,
      prewarmFlow,
      schedule: callback => {
        callback();
        return 1;
      },
      clearScheduled: vi.fn(),
      warn: vi.fn(),
    });

    controller.scheduleAggressivePrewarm('text-ready');
    controller.scheduleAggressivePrewarm('duplicate');
    await flushMicrotasks();

    expect(prewarmFlow).toHaveBeenCalledTimes(1);
    expect(controller.status()).toBe('ready');
  });

  it('resets to failed and allows retry after prewarm load failure', async () => {
    const error = new Error('chunk failed');
    const prewarmFlow = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce({ warmed: true });
    const warn = vi.fn();
    const controller = new WorkspaceShellFlowPrewarmController({
      isDestroyed: () => false,
      prewarmFlow,
      schedule: callback => {
        callback();
        return 1;
      },
      clearScheduled: vi.fn(),
      warn,
    });

    controller.scheduleAggressivePrewarm('text-ready');
    await flushMicrotasks();
    expect(controller.status()).toBe('failed');

    controller.scheduleAggressivePrewarm('retry');
    await flushMicrotasks();

    expect(prewarmFlow).toHaveBeenCalledTimes(2);
    expect(controller.status()).toBe('ready');
    expect(warn).toHaveBeenCalledWith('Flow 预热失败，已允许稍后重试', error);
  });

  it('handles synchronous prewarm load throws as failures that can retry', async () => {
    const error = new Error('sync chunk failed');
    const prewarmFlow = vi.fn()
      .mockImplementationOnce(() => {
        throw error;
      })
      .mockResolvedValueOnce({ warmed: true });
    const warn = vi.fn();
    const controller = new WorkspaceShellFlowPrewarmController({
      isDestroyed: () => false,
      prewarmFlow,
      schedule: callback => {
        callback();
        return 1;
      },
      clearScheduled: vi.fn(),
      warn,
    });

    controller.scheduleAggressivePrewarm('text-ready');
    await flushMicrotasks();
    expect(controller.status()).toBe('failed');

    controller.scheduleAggressivePrewarm('retry');
    await flushMicrotasks();

    expect(prewarmFlow).toHaveBeenCalledTimes(2);
    expect(controller.status()).toBe('ready');
    expect(warn).toHaveBeenCalledWith('Flow 预热失败，已允许稍后重试', error);
  });

  it('cancels scheduled work on teardown', async () => {
    let scheduled: (() => void) | null = null;
    const clearScheduled = vi.fn();
    const prewarmFlow = vi.fn().mockResolvedValue({ warmed: true });
    const controller = new WorkspaceShellFlowPrewarmController({
      isDestroyed: () => false,
      prewarmFlow,
      schedule: callback => {
        scheduled = callback;
        return 7;
      },
      clearScheduled,
      warn: vi.fn(),
    });

    controller.scheduleAggressivePrewarm('text-ready');
    controller.teardown();
    runScheduled(scheduled);
    await flushMicrotasks();

    expect(clearScheduled).toHaveBeenCalledWith(7);
    expect(prewarmFlow).not.toHaveBeenCalled();
    expect(controller.status()).toBe('idle');
  });

  it('keeps teardown idle when an in-flight prewarm resolves late', async () => {
    let resolvePrewarm: (value: { warmed: boolean }) => void = () => undefined;
    const prewarmFlow = vi.fn().mockImplementation(() => new Promise<{ warmed: boolean }>(resolve => {
      resolvePrewarm = resolve;
    }));
    const warn = vi.fn();
    const controller = new WorkspaceShellFlowPrewarmController({
      isDestroyed: () => false,
      prewarmFlow,
      schedule: callback => {
        callback();
        return 1;
      },
      clearScheduled: vi.fn(),
      warn,
    });

    controller.scheduleAggressivePrewarm('text-ready');
    expect(controller.status()).toBe('loading');

    controller.teardown();
    resolvePrewarm({ warmed: true });
    await flushMicrotasks();

    expect(controller.status()).toBe('idle');
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not start prewarm when destroyed before the scheduled callback runs', async () => {
    let destroyed = false;
    let scheduled: (() => void) | null = null;
    const prewarmFlow = vi.fn().mockResolvedValue({ warmed: true });
    const controller = new WorkspaceShellFlowPrewarmController({
      isDestroyed: () => destroyed,
      prewarmFlow,
      schedule: callback => {
        scheduled = callback;
        return 1;
      },
      clearScheduled: vi.fn(),
      warn: vi.fn(),
    });

    controller.scheduleAggressivePrewarm('text-ready');
    destroyed = true;
    runScheduled(scheduled);
    await flushMicrotasks();

    expect(prewarmFlow).not.toHaveBeenCalled();
    expect(controller.status()).toBe('idle' satisfies FlowPrewarmStatus);
  });
});
