import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellRemoteCallbacksDeferredDelegate,
} from './workspace-shell-remote-callbacks-deferred.factory';
import type {
  WorkspaceShellRemoteCallbacksLazyLoadDelegate,
} from './workspace-shell-remote-callbacks-lazy-load-delegate.factory';

vi.mock('../../../services/remote-change-handler.service', () => ({
  RemoteChangeHandlerService: class RemoteChangeHandlerService {},
}));

function createRemoteCallbacksHost(): WorkspaceShellRemoteCallbacksLazyLoadDelegate {
  return {
    registerIfReady: vi.fn(),
    teardown: vi.fn(),
  };
}

async function flushMicrotasks(): Promise<void> {
  // 纯微任务多轮排空：轮次覆盖原生/zone-patched Promise 的最深链（thenable 采纳会放大跳数），
  // 不用宏任务 setTimeout —— 共享车道 CPU 饱和时宏任务可能 2s 内不被调度导致超时
  for (let flushRound = 0; flushRound < 25; flushRound += 1) {
    await Promise.resolve();
  }
  await vi.dynamicImportSettled();
}

describe('createWorkspaceShellRemoteCallbacksDeferredDelegate', () => {
  it('builds readiness from auth, core data, and startup tier state outside the workspace shell component', async () => {
    const remoteCallbacks = createRemoteCallbacksHost();
    const createRemoteCallbacksLazyLoadHost = vi.fn().mockResolvedValue(remoteCallbacks);
    let currentUserId: string | null = null;
    let coreDataLoaded = false;
    let tierReady = false;

    const delegate = createWorkspaceShellRemoteCallbacksDeferredDelegate({
      isEnabled: () => true,
      currentUserId: () => currentUserId,
      coreDataLoaded: () => coreDataLoaded,
      isTieredStartupHydration: () => true,
      isStartupTierP2Ready: () => tierReady,
      createRemoteCallbacksLazyLoadHost,
      importRemoteChangeHandler: vi.fn(),
      refreshActiveProjectSilent: vi.fn(),
      warn: vi.fn(),
    });

    delegate.registerIfReady();
    await flushMicrotasks();
    currentUserId = 'user-1';
    coreDataLoaded = true;
    delegate.registerIfReady();
    await flushMicrotasks();
    tierReady = true;
    delegate.registerIfReady();
    await flushMicrotasks();

    expect(createRemoteCallbacksLazyLoadHost).toHaveBeenCalledTimes(1);
    expect(remoteCallbacks.registerIfReady).toHaveBeenCalledTimes(3);
  });

  it('resolves the default remote change handler through the injector outside the workspace shell component', async () => {
    const handler = { setupCallbacks: vi.fn() };
    const injector = { get: vi.fn().mockReturnValue(handler) };
    const delegate = createWorkspaceShellRemoteCallbacksDeferredDelegate({
      isEnabled: () => true,
      currentUserId: () => 'user-1',
      coreDataLoaded: () => true,
      isTieredStartupHydration: () => false,
      isStartupTierP2Ready: () => false,
      injector,
      refreshActiveProjectSilent: vi.fn(),
      warn: vi.fn(),
    });

    delegate.registerIfReady();

    await vi.waitFor(() => {
      expect(handler.setupCallbacks).toHaveBeenCalledTimes(1);
    });

    const { RemoteChangeHandlerService } = await import('../../../services/remote-change-handler.service');
    expect(injector.get).toHaveBeenCalledWith(RemoteChangeHandlerService);
  });
});
