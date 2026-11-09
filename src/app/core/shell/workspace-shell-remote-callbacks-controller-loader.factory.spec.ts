import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellRemoteCallbacksControllerLoader,
} from './workspace-shell-remote-callbacks-controller-loader.factory';
import type {
  WorkspaceShellRemoteCallbacksHostDelegate,
} from './workspace-shell-remote-callbacks-lazy-load-host.controller';

function createRemoteCallbacksDelegate(): WorkspaceShellRemoteCallbacksHostDelegate {
  return {
    registerIfReady: vi.fn(),
    teardown: vi.fn(),
  };
}

describe('createWorkspaceShellRemoteCallbacksControllerLoader', () => {
  it('uses the provided remote callbacks controller loader', async () => {
    const remoteCallbacks = createRemoteCallbacksDelegate();
    const createRemoteCallbacksController = vi.fn().mockResolvedValue(remoteCallbacks);
    const loadController = createWorkspaceShellRemoteCallbacksControllerLoader({
      createRemoteCallbacksController,
      isEnabled: () => true,
      isReady: () => true,
      importRemoteChangeHandler: vi.fn(),
      refreshActiveProjectSilent: vi.fn(),
      warn: vi.fn(),
    });

    await expect(loadController()).resolves.toBe(remoteCallbacks);

    expect(createRemoteCallbacksController).toHaveBeenCalledOnce();
  });

  it('creates the default remote callbacks controller lazily', async () => {
    const remoteChangeHandler = {
      setupCallbacks: vi.fn(),
    };
    const importRemoteChangeHandler = vi.fn().mockResolvedValue(remoteChangeHandler);
    const loadController = createWorkspaceShellRemoteCallbacksControllerLoader({
      isEnabled: () => true,
      isReady: () => true,
      importRemoteChangeHandler,
      refreshActiveProjectSilent: vi.fn(),
      warn: vi.fn(),
    });

    const controller = await loadController();
    controller.registerIfReady();

    expect(importRemoteChangeHandler).toHaveBeenCalledOnce();
    await vi.waitFor(() => {
      expect(remoteChangeHandler.setupCallbacks).toHaveBeenCalledWith(expect.objectContaining({
        onLoadProjects: expect.any(Function),
        onRefreshActiveProject: expect.any(Function),
      }));
    });
  });
});
