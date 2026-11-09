import { describe, expect, it, vi } from 'vitest';

import {
  WorkspaceShellFlowPrewarmController,
  type FlowPrewarmStatus,
} from './workspace-shell-flow-prewarm.controller';

async function flushMicrotasks(): Promise<void> {
  // 纯微任务多轮排空：轮次覆盖原生/zone-patched Promise 的最深链（thenable 采纳会放大跳数），
  // 不用宏任务 setTimeout —— 共享车道 CPU 饱和时宏任务可能 2s 内不被调度导致超时
  for (let flushRound = 0; flushRound < 25; flushRound += 1) {
    await Promise.resolve();
  }
}

function runScheduled(callback: (() => void) | null): void {
  callback?.();
}

describe('WorkspaceShellFlowPrewarmController', () => {
  it('records the after-view-init prewarm intent as scheduled while the P1 gate is closed', async () => {
    const traceEvents: Array<[FlowPrewarmStatus, string]> = [];
    const prewarmFlow = vi.fn().mockResolvedValue({ warmed: true });
    let releaseGate: (() => void) | undefined;
    const controller = new WorkspaceShellFlowPrewarmController({
      isDestroyed: () => false,
      prewarmFlow,
      schedule: callback => {
        callback();
        return 1;
      },
      clearScheduled: vi.fn(),
      gateScheduledPrewarm: resume => {
        releaseGate = resume;
      },
      trace: {
        record: (status, reason) => traceEvents.push([status, reason]),
      },
      warn: vi.fn(),
    });

    controller.scheduleAggressivePrewarm('workspace-after-view-init');
    await flushMicrotasks();

    expect(releaseGate).toEqual(expect.any(Function));
    expect(prewarmFlow).not.toHaveBeenCalled();
    expect(controller.status()).toBe('scheduled');
    expect(traceEvents).toEqual([
      ['scheduled', 'workspace-after-view-init'],
    ]);
  });

  it('advances a retained after-view-init prewarm intent when the P1 gate opens', async () => {
    const traceEvents: Array<[FlowPrewarmStatus, string]> = [];
    const prewarmFlow = vi.fn().mockResolvedValue({ warmed: true });
    let releaseGate: (() => void) | undefined;
    const controller = new WorkspaceShellFlowPrewarmController({
      isDestroyed: () => false,
      prewarmFlow,
      schedule: callback => {
        callback();
        return 1;
      },
      clearScheduled: vi.fn(),
      gateScheduledPrewarm: resume => {
        releaseGate = resume;
      },
      trace: {
        record: (status, reason) => traceEvents.push([status, reason]),
      },
      warn: vi.fn(),
    });

    controller.scheduleAggressivePrewarm('workspace-after-view-init');
    await flushMicrotasks();

    expect(releaseGate).toEqual(expect.any(Function));
    expect(prewarmFlow).not.toHaveBeenCalled();
    expect(controller.status()).toBe('scheduled');

    releaseGate?.();
    await flushMicrotasks();

    expect(prewarmFlow).toHaveBeenCalledTimes(1);
    expect(controller.status()).toBe('ready');
    expect(traceEvents).toEqual([
      ['scheduled', 'workspace-after-view-init'],
      ['loading', 'workspace-after-view-init'],
      ['ready', 'workspace-after-view-init'],
    ]);
  });

  it('ignores a deferred gate resume after teardown and cleans up the gate once', async () => {
    const traceEvents: Array<[FlowPrewarmStatus, string]> = [];
    const prewarmFlow = vi.fn().mockResolvedValue({ warmed: true });
    const releaseGate = vi.fn();
    let deferredResume: (() => void) | undefined;
    const controller = new WorkspaceShellFlowPrewarmController({
      isDestroyed: () => false,
      prewarmFlow,
      schedule: callback => {
        callback();
        return 1;
      },
      clearScheduled: vi.fn(),
      gateScheduledPrewarm: resume => {
        deferredResume = resume;
        return releaseGate;
      },
      trace: {
        record: (status, reason) => traceEvents.push([status, reason]),
      },
      warn: vi.fn(),
    });

    controller.scheduleAggressivePrewarm('workspace-after-view-init');
    await flushMicrotasks();

    expect(deferredResume).toEqual(expect.any(Function));
    expect(prewarmFlow).not.toHaveBeenCalled();
    expect(traceEvents).toEqual([
      ['scheduled', 'workspace-after-view-init'],
    ]);

    controller.teardown();
    controller.teardown();
    deferredResume?.();
    await flushMicrotasks();

    expect(releaseGate).toHaveBeenCalledTimes(1);
    expect(prewarmFlow).not.toHaveBeenCalled();
    expect(traceEvents).toEqual([
      ['scheduled', 'workspace-after-view-init'],
    ]);
    expect(traceEvents.map(([status]) => status)).not.toContain('loading');
    expect(controller.status()).toBe('idle');
  });

  it('records state transitions with the scheduled prewarm reason', async () => {
    const traceEvents: Array<[FlowPrewarmStatus, string]> = [];
    const controller = new WorkspaceShellFlowPrewarmController({
      isDestroyed: () => false,
      prewarmFlow: vi.fn().mockResolvedValue({ warmed: true }),
      schedule: callback => {
        callback();
        return 1;
      },
      clearScheduled: vi.fn(),
      trace: {
        record: (status, reason) => traceEvents.push([status, reason]),
      },
      warn: vi.fn(),
    });

    controller.scheduleAggressivePrewarm('text-ready');
    await flushMicrotasks();

    expect(traceEvents).toEqual([
      ['scheduled', 'text-ready'],
      ['loading', 'text-ready'],
      ['ready', 'text-ready'],
    ]);
  });

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

  it('does not retain a scheduled handle after the scheduler runs synchronously', async () => {
    let resolvePrewarm: (value: { warmed: boolean }) => void = () => undefined;
    const prewarmFlow = vi.fn().mockImplementation(() => new Promise<{ warmed: boolean }>(resolve => {
      resolvePrewarm = resolve;
    }));
    const clearScheduled = vi.fn();
    const controller = new WorkspaceShellFlowPrewarmController({
      isDestroyed: () => false,
      prewarmFlow,
      schedule: callback => {
        callback();
        return 9;
      },
      clearScheduled,
      warn: vi.fn(),
    });

    controller.scheduleAggressivePrewarm('text-ready');
    expect(controller.status()).toBe('loading');

    controller.teardown();
    resolvePrewarm({ warmed: true });
    await flushMicrotasks();

    expect(clearScheduled).not.toHaveBeenCalled();
    expect(controller.status()).toBe('idle');
  });

  it('resets to failed and allows retry when scheduling prewarm throws', async () => {
    const error = new Error('schedule failed');
    const prewarmFlow = vi.fn().mockResolvedValue({ warmed: true });
    const warn = vi.fn();
    let firstSchedule = true;
    const controller = new WorkspaceShellFlowPrewarmController({
      isDestroyed: () => false,
      prewarmFlow,
      schedule: callback => {
        if (firstSchedule) {
          firstSchedule = false;
          throw error;
        }
        callback();
        return 1;
      },
      clearScheduled: vi.fn(),
      warn,
    });

    expect(() => controller.scheduleAggressivePrewarm('text-ready')).not.toThrow();
    expect(controller.status()).toBe('failed');

    controller.scheduleAggressivePrewarm('retry');
    await flushMicrotasks();

    expect(prewarmFlow).toHaveBeenCalledTimes(1);
    expect(controller.status()).toBe('ready');
    expect(warn).toHaveBeenCalledWith('Flow 预热调度失败，已允许稍后重试', error);
  });

  it('resets to failed and allows retry after prewarm load failure', async () => {
    const error = new Error('chunk failed');
    const prewarmFlow = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce({ warmed: true });
    const warn = vi.fn();
    const traceEvents: Array<[FlowPrewarmStatus, string]> = [];
    const controller = new WorkspaceShellFlowPrewarmController({
      isDestroyed: () => false,
      prewarmFlow,
      schedule: callback => {
        callback();
        return 1;
      },
      clearScheduled: vi.fn(),
      trace: {
        record: (status, reason) => traceEvents.push([status, reason]),
      },
      warn,
    });

    controller.scheduleAggressivePrewarm('text-ready');
    await flushMicrotasks();
    expect(controller.status()).toBe('failed');

    expect(traceEvents).toEqual([
      ['scheduled', 'text-ready'],
      ['loading', 'text-ready'],
      ['failed', 'text-ready'],
    ]);

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

  it('continues teardown when clearing scheduled work fails', async () => {
    let scheduled: (() => void) | null = null;
    const clearError = new Error('clear scheduled failed');
    const clearScheduled = vi.fn(() => {
      throw clearError;
    });
    const prewarmFlow = vi.fn().mockResolvedValue({ warmed: true });
    const warn = vi.fn();
    const controller = new WorkspaceShellFlowPrewarmController({
      isDestroyed: () => false,
      prewarmFlow,
      schedule: callback => {
        scheduled = callback;
        return 7;
      },
      clearScheduled,
      warn,
    });

    controller.scheduleAggressivePrewarm('text-ready');

    expect(() => controller.teardown()).not.toThrow();
    runScheduled(scheduled);
    await flushMicrotasks();

    expect(clearScheduled).toHaveBeenCalledWith(7);
    expect(warn).toHaveBeenCalledWith('Flow 预热调度清理失败，已继续清理', clearError);
    expect(prewarmFlow).not.toHaveBeenCalled();
    expect(controller.status()).toBe('idle');
  });

  it('continues teardown when clearing scheduled work warning fails', async () => {
    let scheduled: (() => void) | null = null;
    const clearError = new Error('clear scheduled failed');
    const clearScheduled = vi.fn(() => {
      throw clearError;
    });
    const prewarmFlow = vi.fn().mockResolvedValue({ warmed: true });
    const warn = vi.fn(() => {
      throw new Error('warning sink failed');
    });
    const controller = new WorkspaceShellFlowPrewarmController({
      isDestroyed: () => false,
      prewarmFlow,
      schedule: callback => {
        scheduled = callback;
        return 7;
      },
      clearScheduled,
      warn,
    });

    controller.scheduleAggressivePrewarm('text-ready');

    expect(() => controller.teardown()).not.toThrow();
    runScheduled(scheduled);
    await flushMicrotasks();

    expect(clearScheduled).toHaveBeenCalledWith(7);
    expect(warn).toHaveBeenCalledWith('Flow 预热调度清理失败，已继续清理', clearError);
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
