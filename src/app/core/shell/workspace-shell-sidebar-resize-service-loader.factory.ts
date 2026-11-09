import type { Injector } from '@angular/core';

import type {
  WorkspaceShellSidebarResizeServiceLike,
} from './workspace-shell-sidebar-resize-delegate.factory';

export interface WorkspaceShellSidebarResizeServiceLoaderOptions {
  injector?: Injector;
  loadSidebarResize?: () => Promise<WorkspaceShellSidebarResizeServiceLike>;
}

export function createWorkspaceShellSidebarResizeServiceLoader(
  options: WorkspaceShellSidebarResizeServiceLoaderOptions,
): () => Promise<WorkspaceShellSidebarResizeServiceLike> {
  if (options.loadSidebarResize) {
    return options.loadSidebarResize;
  }

  return () => import('../../../services/sidebar-resize.service')
    .then(({ SidebarResizeService }) => {
      if (!options.injector) {
        throw new Error('WorkspaceShellSidebarResizeServiceLoader requires an injector');
      }

      return options.injector.get(SidebarResizeService);
    });
}
