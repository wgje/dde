import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellFlowPrewarmControllerLoader,
} from './workspace-shell-flow-prewarm-controller-loader.factory';
import type {
  WorkspaceShellFlowPrewarmControllerOptions,
} from './workspace-shell-flow-prewarm.controller';
import type {
  WorkspaceShellFlowPrewarmDelegate,
} from './workspace-shell-flow-prewarm-lazy-load.controller';

function createDelegate(): WorkspaceShellFlowPrewarmDelegate {
  return {
    scheduleAggressivePrewarm: vi.fn(),
    teardown: vi.fn(),
  };
}

function createOptions(
  overrides: Partial<WorkspaceShellFlowPrewarmControllerOptions> = {},
): WorkspaceShellFlowPrewarmControllerOptions {
  return {
    isDestroyed: () => false,
    prewarmFlow: vi.fn().mockResolvedValue({ warmed: true }),
    schedule: callback => {
      callback();
      return 0;
    },
    warn: vi.fn(),
    ...overrides,
  };
}

async function flushMicrotasks(): Promise<void> {
  // 纯微任务多轮排空：轮次覆盖原生/zone-patched Promise 的最深链（thenable 采纳会放大跳数），
  // 不用宏任务 setTimeout —— 共享车道 CPU 饱和时宏任务可能 2s 内不被调度导致超时
  for (let flushRound = 0; flushRound < 25; flushRound += 1) {
    await Promise.resolve();
  }
}

describe('createWorkspaceShellFlowPrewarmControllerLoader', () => {
  it('uses the provided flow prewarm controller loader', async () => {
    const delegate = createDelegate();
    const createFlowPrewarmController = vi.fn().mockResolvedValue(delegate);
    const loadController = createWorkspaceShellFlowPrewarmControllerLoader({
      ...createOptions(),
      createFlowPrewarmController,
    });

    await expect(loadController()).resolves.toBe(delegate);

    expect(createFlowPrewarmController).toHaveBeenCalledOnce();
  });

  it('creates the default flow prewarm controller lazily', async () => {
    const prewarmFlow = vi.fn().mockResolvedValue({ warmed: true });
    const loadController = createWorkspaceShellFlowPrewarmControllerLoader(createOptions({
      prewarmFlow,
    }));

    const controller = await loadController();
    controller.scheduleAggressivePrewarm('after-view-init');
    await flushMicrotasks();

    expect(prewarmFlow).toHaveBeenCalledOnce();
  });
});
