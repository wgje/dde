import type { Injector } from '@angular/core';

import type {
  WorkspaceShellLazyLifecycleGroupMember,
} from './workspace-shell-lazy-lifecycle-hosts.factory';
import type {
  WorkspaceShellStartupBreadcrumbControllerOptions,
} from './workspace-shell-startup-breadcrumb.controller';
import {
  createWorkspaceShellStartupBreadcrumbControllerLoader,
} from './workspace-shell-startup-breadcrumb-controller-loader.factory';
import {
  createWorkspaceShellLazyLifecycleControllerHost,
} from './workspace-shell-lazy-lifecycle-controller-host.factory';

export interface WorkspaceShellStartupBreadcrumbLifecycleHostOptions {
  injector?: Injector;
  runtime: {
    destroyed: () => boolean;
  };
  loadStartupBreadcrumb?: WorkspaceShellStartupBreadcrumbControllerOptions['loadStartupBreadcrumb'];
  warn: (message: string, error: unknown) => void;
}

export function createWorkspaceShellStartupBreadcrumbLifecycleHost(
  options: WorkspaceShellStartupBreadcrumbLifecycleHostOptions,
): Promise<WorkspaceShellLazyLifecycleGroupMember> {
  return createWorkspaceShellLazyLifecycleControllerHost({
    destroyed: options.runtime.destroyed,
    loadController: createWorkspaceShellStartupBreadcrumbControllerLoader({
      injector: options.injector,
      destroyed: options.runtime.destroyed,
      loadStartupBreadcrumb: options.loadStartupBreadcrumb,
      warn: options.warn,
    }),
  });
}
