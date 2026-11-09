import { describe, expect, it, vi } from 'vitest';

import type {
  WorkspaceShellSidebarToolsHostDelegate,
  WorkspaceShellSidebarToolsLazyLoadHostOptions,
} from './workspace-shell-sidebar-tools-lazy-load-host.controller';
import {
  createWorkspaceShellSidebarToolsResolverLoader,
} from './workspace-shell-sidebar-tools-resolver-loader.factory';
import {
  createWorkspaceShellSidebarToolsSpecDelegate,
} from './workspace-shell-sidebar-tools.spec-helpers';

describe('createWorkspaceShellSidebarToolsResolverLoader', () => {
  it('uses the provided sidebar tools resolver loader', async () => {
    const resolver = (
      createWorkspaceShellSidebarToolsSpecDelegate()
    ) as WorkspaceShellSidebarToolsHostDelegate;
    const createSidebarToolsController = vi.fn().mockResolvedValue(resolver);
    const loadResolver = createWorkspaceShellSidebarToolsResolverLoader({
      createSidebarToolsController,
      warn: vi.fn(),
    } satisfies WorkspaceShellSidebarToolsLazyLoadHostOptions);

    await expect(loadResolver()).resolves.toBe(resolver);

    expect(createSidebarToolsController).toHaveBeenCalledOnce();
  });
});
