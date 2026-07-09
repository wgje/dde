import { vi } from 'vitest';
import { expect } from 'vitest';

import type {
  WorkspaceShellLazyLifecycleDelegate,
} from './workspace-shell-lazy-lifecycle-host.controller';

export function createWorkspaceShellLazyLifecycleDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, reject, resolve };
}

export function createWorkspaceShellLazyLifecycleSpecMember(
  label?: string,
  record?: string[],
): WorkspaceShellLazyLifecycleDelegate {
  return {
    initialize: vi.fn(() => {
      if (label && record) {
        record.push(`${label}.initialize`);
      }
    }),
    teardown: vi.fn(() => {
      if (label && record) {
        record.push(`${label}.teardown`);
      }
    }),
  };
}

export function createWorkspaceShellLazyLifecycleSpecService<
  TService extends WorkspaceShellLazyLifecycleDelegate,
>(label?: string, record?: string[]): TService {
  return createWorkspaceShellLazyLifecycleSpecMember(label, record) as TService;
}

export async function expectWorkspaceShellLazyLifecycleLoaderUsesExplicitLoader<
  TService extends WorkspaceShellLazyLifecycleDelegate,
>(options: {
  createLoader: (loadService: () => Promise<TService>) => () => Promise<TService>;
  createService: () => TService;
}): Promise<void> {
  const service = options.createService();
  const loadService = vi.fn().mockResolvedValue(service);
  const loader = options.createLoader(loadService);

  await expect(loader()).resolves.toBe(service);

  expect(loadService).toHaveBeenCalledOnce();
}

export async function expectWorkspaceShellLazyLifecycleLoaderMissingInjector(
  options: {
    createLoader: () => () => Promise<WorkspaceShellLazyLifecycleDelegate>;
    expectedMessage: string;
  },
): Promise<void> {
  const loader = options.createLoader();

  await expect(loader()).rejects.toThrow(options.expectedMessage);
}

export async function expectWorkspaceShellLazyLifecycleHostSkipsDestroyedLoad<
  TService extends WorkspaceShellLazyLifecycleDelegate,
>(options: {
  createHost: (hostOptions: {
    destroyed: () => boolean;
    loadService: () => Promise<TService>;
    warn: (message: string, error: unknown) => void;
  }) => Promise<WorkspaceShellLazyLifecycleDelegate>;
  createService: () => TService;
}): Promise<void> {
  const loadService = vi.fn().mockResolvedValue(options.createService());
  const warn = vi.fn();
  const host = await options.createHost({
    destroyed: () => true,
    loadService,
    warn,
  });

  host.initialize();
  host.teardown();
  await flushWorkspaceShellLazyLifecycleMicrotasks();

  expect(loadService).not.toHaveBeenCalled();
  expect(warn).not.toHaveBeenCalled();
}

export async function flushWorkspaceShellLazyLifecycleMicrotasks(): Promise<void> {
  // 纯微任务多轮排空：轮次覆盖原生/zone-patched Promise 的最深链（thenable 采纳会放大跳数），
  // 不用宏任务 setTimeout —— 共享车道 CPU 饱和时宏任务可能 2s 内不被调度导致超时
  for (let flushRound = 0; flushRound < 25; flushRound += 1) {
    await Promise.resolve();
  }
}
