import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellStartupLazyServicesControllerLoader,
} from './workspace-shell-startup-lazy-services-controller-loader.factory';
import type {
  WorkspaceShellStartupLazyServicesHostDelegate,
  WorkspaceShellStartupLazyServicesHostOptions,
} from './workspace-shell-startup-lazy-services-host.controller';

function createDelegate(): WorkspaceShellStartupLazyServicesHostDelegate {
  return {
    initializeStartupDiagnosticsLazy: vi.fn(),
    scheduleStartupFontInitialization: vi.fn(),
    teardown: vi.fn(),
  };
}

async function flushMicrotasks(): Promise<void> {
  // 纯微任务多轮排空：轮次覆盖原生/zone-patched Promise 的最深链（thenable 采纳会放大跳数），
  // 不用宏任务 setTimeout —— 共享车道 CPU 饱和时宏任务可能 2s 内不被调度导致超时
  for (let flushRound = 0; flushRound < 25; flushRound += 1) {
    await Promise.resolve();
  }
}

function createOptions(
  overrides: Partial<WorkspaceShellStartupLazyServicesHostOptions> = {},
): WorkspaceShellStartupLazyServicesHostOptions {
  return {
    initializeStartupFontScheduler: vi.fn().mockResolvedValue(undefined),
    warn: vi.fn(),
    ...overrides,
  };
}

describe('createWorkspaceShellStartupLazyServicesControllerLoader', () => {
  it('uses the provided startup lazy services controller loader', async () => {
    const delegate = createDelegate();
    const createStartupLazyServicesController = vi.fn().mockResolvedValue(delegate);
    const loadController = createWorkspaceShellStartupLazyServicesControllerLoader({
      ...createOptions(),
      createStartupLazyServicesController,
    });

    await expect(loadController()).resolves.toBe(delegate);

    expect(createStartupLazyServicesController).toHaveBeenCalledOnce();
  });

  it('creates the default startup lazy services controller lazily', async () => {
    const initializeStartupFontScheduler = vi.fn().mockResolvedValue(undefined);
    const loadController = createWorkspaceShellStartupLazyServicesControllerLoader(createOptions({
      initializeStartupFontScheduler,
    }));

    const controller = await loadController();
    controller.scheduleStartupFontInitialization();
    await flushMicrotasks();

    expect(initializeStartupFontScheduler).toHaveBeenCalledOnce();
  });
});
