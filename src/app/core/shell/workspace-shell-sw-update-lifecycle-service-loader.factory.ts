import type { Injector } from '@angular/core';

import {
  createWorkspaceShellLazyLifecycleServiceLoader,
} from './workspace-shell-lazy-lifecycle-service-loader.factory';
import type {
  WorkspaceShellSwUpdateLifecycleLike,
} from './workspace-shell-sw-update-lifecycle.controller';

export interface WorkspaceShellSwUpdateLifecycleServiceLoaderOptions {
  injector?: Injector;
  loadSwUpdateLifecycle?: () => Promise<WorkspaceShellSwUpdateLifecycleLike>;
}

export function createWorkspaceShellSwUpdateLifecycleServiceLoader(
  options: WorkspaceShellSwUpdateLifecycleServiceLoaderOptions,
): () => Promise<WorkspaceShellSwUpdateLifecycleLike> {
  if (options.loadSwUpdateLifecycle) {
    return createWorkspaceShellLazyLifecycleServiceLoader({
      loadService: options.loadSwUpdateLifecycle,
    });
  }

  return createWorkspaceShellLazyLifecycleServiceLoader({
    injector: options.injector,
    missingInjectorMessage: 'WorkspaceShellSwUpdateLifecycleController requires an injector',
    resolveService: injector => import('../../../services/sw-update-lifecycle.service')
      .then(({ SwUpdateLifecycleService }) => injector.get(SwUpdateLifecycleService)),
  });
}
