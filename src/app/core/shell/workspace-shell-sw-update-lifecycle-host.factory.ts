import type { Injector } from '@angular/core';

import type {
  WorkspaceShellLazyLifecycleGroupMember,
} from './workspace-shell-lazy-lifecycle-hosts.factory';
import {
  createWorkspaceShellSwUpdateLifecycleControllerLoader,
} from './workspace-shell-sw-update-lifecycle-controller-loader.factory';
import {
  createWorkspaceShellLazyLifecycleControllerHost,
} from './workspace-shell-lazy-lifecycle-controller-host.factory';

export interface WorkspaceShellSwUpdateLifecycleHostOptions {
  injector?: Injector;
  runtime: {
    destroyed: () => boolean;
  };
  warn: (message: string, error: unknown) => void;
}

export function createWorkspaceShellSwUpdateLifecycleHost(
  options: WorkspaceShellSwUpdateLifecycleHostOptions,
): Promise<WorkspaceShellLazyLifecycleGroupMember> {
  return createWorkspaceShellLazyLifecycleControllerHost({
    destroyed: options.runtime.destroyed,
    loadController: createWorkspaceShellSwUpdateLifecycleControllerLoader({
      injector: options.injector,
      destroyed: options.runtime.destroyed,
      warn: options.warn,
    }),
  });
}
