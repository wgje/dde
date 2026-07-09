import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellRemoteCallbacksLazyLoadHostLoader,
  type WorkspaceShellRemoteCallbacksLazyLoadHostLike,
} from './workspace-shell-remote-callbacks-lazy-load-host-loader.factory';
import type {
  WorkspaceShellRemoteCallbacksHostDelegate,
} from './workspace-shell-remote-callbacks-lazy-load-host.controller';

function createRemoteCallbacksLazyLoadHost(): WorkspaceShellRemoteCallbacksLazyLoadHostLike {
  return {
    registerIfReady: vi.fn(),
    teardown: vi.fn(),
  };
}

function createRemoteCallbacksController(): WorkspaceShellRemoteCallbacksHostDelegate {
  return {
    registerIfReady: vi.fn(),
    teardown: vi.fn(),
  };
}

describe('createWorkspaceShellRemoteCallbacksLazyLoadHostLoader', () => {
  it('uses the provided remote callbacks lazy-load host factory', async () => {
    const host = createRemoteCallbacksLazyLoadHost();
    const createRemoteCallbacksLazyLoadHostFactory = vi.fn(() => host);
    const loadHost = createWorkspaceShellRemoteCallbacksLazyLoadHostLoader({
      createRemoteCallbacksLazyLoadHost: createRemoteCallbacksLazyLoadHostFactory,
      options: {
        isEnabled: () => true,
        isReady: () => true,
        importRemoteChangeHandler: vi.fn(),
        refreshActiveProjectSilent: vi.fn(),
        warn: vi.fn(),
      },
    });

    await expect(loadHost()).resolves.toBe(host);

    expect(createRemoteCallbacksLazyLoadHostFactory).toHaveBeenCalledOnce();
  });

  it('converts synchronous custom host factory failures to rejected promises and retries later', async () => {
    const failure = new Error('remote callbacks host factory failed');
    const host = createRemoteCallbacksLazyLoadHost();
    const createRemoteCallbacksLazyLoadHostFactory = vi.fn()
      .mockImplementationOnce(() => {
        throw failure;
      })
      .mockReturnValueOnce(host);
    const loadHost = createWorkspaceShellRemoteCallbacksLazyLoadHostLoader({
      createRemoteCallbacksLazyLoadHost: createRemoteCallbacksLazyLoadHostFactory,
      options: {
        isEnabled: () => true,
        isReady: () => true,
        importRemoteChangeHandler: vi.fn(),
        refreshActiveProjectSilent: vi.fn(),
        warn: vi.fn(),
      },
    });

    const loadPromise = loadHost();

    await expect(loadPromise).rejects.toBe(failure);
    await expect(loadHost()).resolves.toBe(host);
    expect(createRemoteCallbacksLazyLoadHostFactory).toHaveBeenCalledTimes(2);
  });

  it('creates the default remote callbacks lazy-load host lazily', async () => {
    const remoteCallbacks = createRemoteCallbacksController();
    const createRemoteCallbacksControllerFactory = vi.fn()
      .mockResolvedValue(remoteCallbacks);
    const loadHost = createWorkspaceShellRemoteCallbacksLazyLoadHostLoader({
      options: {
        createRemoteCallbacksController: createRemoteCallbacksControllerFactory,
        isEnabled: () => true,
        isReady: () => true,
        importRemoteChangeHandler: vi.fn(),
        refreshActiveProjectSilent: vi.fn(),
        warn: vi.fn(),
      },
    });

    expect(createRemoteCallbacksControllerFactory).not.toHaveBeenCalled();

    const host = await loadHost();
    host.registerIfReady();
    await vi.waitFor(() => expect(remoteCallbacks.registerIfReady).toHaveBeenCalledOnce());

    expect(createRemoteCallbacksControllerFactory).toHaveBeenCalledOnce();
  });
});
