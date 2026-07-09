import { vi } from 'vitest';
import { expect } from 'vitest';

import type {
  WorkspaceShellSidebarToolsHostDelegate,
} from './workspace-shell-sidebar-tools-lazy-load-host.controller';

export function createWorkspaceShellSidebarToolsDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, reject, resolve };
}

export function createWorkspaceShellSidebarToolsSpecDelegate(): WorkspaceShellSidebarToolsHostDelegate {
  return {
    loadBlackBoxRecorderComponent: vi.fn().mockResolvedValue('black-box'),
    loadFocusSessionTriggerComponent: vi.fn().mockResolvedValue('focus-trigger'),
    onToolsIntent: vi.fn(),
    onVoiceTranscribed: vi.fn(),
    preload: vi.fn(),
    preloadFocusModeAssets: vi.fn().mockResolvedValue(undefined),
    scheduleFocusModePreload: vi.fn(),
    teardown: vi.fn(),
  };
}

export async function expectWorkspaceShellSidebarToolsLoadsOnce(options: {
  createController: (loadSidebarTools: () => Promise<WorkspaceShellSidebarToolsHostDelegate>) =>
    WorkspaceShellSidebarToolsHostDelegate;
  createSidebarTools: () => WorkspaceShellSidebarToolsHostDelegate;
}): Promise<void> {
  const sidebarTools = options.createSidebarTools();
  const loadSidebarTools = vi.fn().mockResolvedValue(sidebarTools);
  const controller = options.createController(loadSidebarTools);

  await Promise.all([
    controller.loadFocusSessionTriggerComponent(),
    controller.loadBlackBoxRecorderComponent(),
    controller.preloadFocusModeAssets('startup'),
  ]);

  expect(loadSidebarTools).toHaveBeenCalledOnce();
  await expect(controller.loadFocusSessionTriggerComponent()).resolves.toBeDefined();
}

export async function flushWorkspaceShellSidebarToolsMicrotasks(): Promise<void> {
  // 纯微任务多轮排空：轮次覆盖原生/zone-patched Promise 的最深链（thenable 采纳会放大跳数），
  // 不用宏任务 setTimeout —— 共享车道 CPU 饱和时宏任务可能 2s 内不被调度导致超时
  for (let flushRound = 0; flushRound < 25; flushRound += 1) {
    await Promise.resolve();
  }
}
