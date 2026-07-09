import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellLazyLifecycleHostMember,
} from './workspace-shell-lazy-lifecycle-host-member.factory';
import type {
  WorkspaceShellLazyLifecycleDelegate,
} from './workspace-shell-lazy-lifecycle-host.controller';

async function flushMicrotasks(): Promise<void> {
  // 纯微任务多轮排空：轮次覆盖原生/zone-patched Promise 的最深链（thenable 采纳会放大跳数），
  // 不用宏任务 setTimeout —— 共享车道 CPU 饱和时宏任务可能 2s 内不被调度导致超时
  for (let flushRound = 0; flushRound < 25; flushRound += 1) {
    await Promise.resolve();
  }
}

describe('createWorkspaceShellLazyLifecycleHostMember', () => {
  it('loads and initializes the lifecycle controller lazily', async () => {
    const controller: WorkspaceShellLazyLifecycleDelegate = {
      initialize: vi.fn(),
      teardown: vi.fn(),
    };
    const createController = vi.fn().mockResolvedValue(controller);

    const host = createWorkspaceShellLazyLifecycleHostMember({
      createController,
      initializeFailureMessage: 'initialize failed',
      teardownFailureMessage: 'teardown failed',
      warn: vi.fn(),
    });

    expect(createController).not.toHaveBeenCalled();

    host.initialize();
    await flushMicrotasks();

    expect(createController).toHaveBeenCalledTimes(1);
    expect(controller.initialize).toHaveBeenCalledTimes(1);
  });

  it('warns with the configured initialize message when loading fails', async () => {
    const error = new Error('load failed');
    const warn = vi.fn();
    const host = createWorkspaceShellLazyLifecycleHostMember({
      createController: vi.fn().mockRejectedValue(error),
      initializeFailureMessage: 'initialize failed',
      teardownFailureMessage: 'teardown failed',
      warn,
    });

    host.initialize();
    await flushMicrotasks();

    expect(warn).toHaveBeenCalledWith('initialize failed', error);
  });
});
