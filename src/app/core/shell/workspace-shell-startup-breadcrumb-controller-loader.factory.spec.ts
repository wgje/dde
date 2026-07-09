import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellStartupBreadcrumbControllerLoader,
} from './workspace-shell-startup-breadcrumb-controller-loader.factory';
import type {
  WorkspaceShellStartupBreadcrumbLike,
} from './workspace-shell-startup-breadcrumb.controller';
import {
  flushWorkspaceShellLazyLifecycleMicrotasks,
} from './workspace-shell-lazy-lifecycle.spec-helpers';

describe('createWorkspaceShellStartupBreadcrumbControllerLoader', () => {
  it('creates the default startup breadcrumb controller lazily', async () => {
    const service: WorkspaceShellStartupBreadcrumbLike = {
      initialize: vi.fn(),
      teardown: vi.fn(),
    };
    const loadStartupBreadcrumb = vi.fn().mockResolvedValue(service);
    const loadController = createWorkspaceShellStartupBreadcrumbControllerLoader({
      destroyed: () => false,
      loadStartupBreadcrumb,
      warn: vi.fn(),
    });

    const controller = await loadController();
    controller.initialize();
    await flushWorkspaceShellLazyLifecycleMicrotasks();

    expect(loadStartupBreadcrumb).toHaveBeenCalledOnce();
    expect(service.initialize).toHaveBeenCalledOnce();
  });
});
