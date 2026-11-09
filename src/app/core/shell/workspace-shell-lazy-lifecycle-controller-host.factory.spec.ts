import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellLazyLifecycleControllerHost,
} from './workspace-shell-lazy-lifecycle-controller-host.factory';
import type {
  WorkspaceShellLazyLifecycleDelegate,
} from './workspace-shell-lazy-lifecycle-host.controller';

function createController(): WorkspaceShellLazyLifecycleDelegate {
  return {
    initialize: vi.fn(),
    teardown: vi.fn(),
  };
}

describe('createWorkspaceShellLazyLifecycleControllerHost', () => {
  it('returns a no-op host without loading the controller when already destroyed', async () => {
    const loadController = vi.fn().mockResolvedValue(createController());

    const host = await createWorkspaceShellLazyLifecycleControllerHost({
      destroyed: () => true,
      loadController,
    });

    host.initialize();
    host.teardown();

    expect(loadController).not.toHaveBeenCalled();
  });

  it('loads the controller when the shell is still alive', async () => {
    const controller = createController();
    const loadController = vi.fn().mockResolvedValue(controller);

    const host = await createWorkspaceShellLazyLifecycleControllerHost({
      destroyed: () => false,
      loadController,
    });

    host.initialize();

    expect(loadController).toHaveBeenCalledOnce();
    expect(controller.initialize).toHaveBeenCalledOnce();
  });
});
