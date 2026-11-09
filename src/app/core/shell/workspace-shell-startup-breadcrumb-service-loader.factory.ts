import type { Injector } from '@angular/core';

import {
  createWorkspaceShellLazyLifecycleServiceLoader,
} from './workspace-shell-lazy-lifecycle-service-loader.factory';
import type {
  WorkspaceShellStartupBreadcrumbLike,
} from './workspace-shell-startup-breadcrumb.controller';

export interface WorkspaceShellStartupBreadcrumbServiceLoaderOptions {
  injector?: Injector;
  loadStartupBreadcrumb?: () => Promise<WorkspaceShellStartupBreadcrumbLike>;
}

export function createWorkspaceShellStartupBreadcrumbServiceLoader(
  options: WorkspaceShellStartupBreadcrumbServiceLoaderOptions,
): () => Promise<WorkspaceShellStartupBreadcrumbLike> {
  if (options.loadStartupBreadcrumb) {
    return createWorkspaceShellLazyLifecycleServiceLoader({
      loadService: options.loadStartupBreadcrumb,
    });
  }

  return createWorkspaceShellLazyLifecycleServiceLoader({
    injector: options.injector,
    missingInjectorMessage: 'WorkspaceShellStartupBreadcrumbController requires an injector',
    resolveService: injector => import('../../../services/startup-breadcrumb.service')
      .then(({ StartupBreadcrumbService }) => injector.get(StartupBreadcrumbService)),
  });
}
