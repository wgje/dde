import { describe, expect, it, vi } from 'vitest';

import type {
  WorkspaceShellSidebarToolsLazyLoadControllerLike,
  WorkspaceShellSidebarToolsLazyLoadResolverOptions,
} from './workspace-shell-sidebar-tools-lazy-load-resolver.controller';
import {
  createWorkspaceShellSidebarToolsLazyLoadControllerLoader,
} from './workspace-shell-sidebar-tools-lazy-load-controller-loader.factory';
import {
  createWorkspaceShellSidebarToolsSpecDelegate,
} from './workspace-shell-sidebar-tools.spec-helpers';

describe('createWorkspaceShellSidebarToolsLazyLoadControllerLoader', () => {
  it('uses the provided lazy-load controller loader', async () => {
    const controller = (
      createWorkspaceShellSidebarToolsSpecDelegate()
    ) as WorkspaceShellSidebarToolsLazyLoadControllerLike;
    const createSidebarToolsController = vi.fn().mockResolvedValue(controller);
    const loadController = createWorkspaceShellSidebarToolsLazyLoadControllerLoader({
      createSidebarToolsController,
      warn: vi.fn(),
    } satisfies WorkspaceShellSidebarToolsLazyLoadResolverOptions);

    await expect(loadController()).resolves.toBe(controller);

    expect(createSidebarToolsController).toHaveBeenCalledOnce();
  });
});
