import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellSwUpdateLifecycleControllerLoader,
} from './workspace-shell-sw-update-lifecycle-controller-loader.factory';
import {
  flushWorkspaceShellLazyLifecycleMicrotasks,
} from './workspace-shell-lazy-lifecycle.spec-helpers';
import type {
  WorkspaceShellSwUpdateLifecycleLike,
} from './workspace-shell-sw-update-lifecycle.controller';

describe('createWorkspaceShellSwUpdateLifecycleControllerLoader', () => {
  it('creates the default SW update lifecycle controller lazily', async () => {
    const service: WorkspaceShellSwUpdateLifecycleLike = {
      initialize: vi.fn(),
      teardown: vi.fn(),
    };
    const loadSwUpdateLifecycle = vi.fn().mockResolvedValue(service);
    const loadController = createWorkspaceShellSwUpdateLifecycleControllerLoader({
      destroyed: () => false,
      loadSwUpdateLifecycle,
      warn: vi.fn(),
    });

    const controller = await loadController();
    controller.initialize();
    await flushWorkspaceShellLazyLifecycleMicrotasks();

    expect(loadSwUpdateLifecycle).toHaveBeenCalledOnce();
    expect(service.initialize).toHaveBeenCalledOnce();
  });
});
