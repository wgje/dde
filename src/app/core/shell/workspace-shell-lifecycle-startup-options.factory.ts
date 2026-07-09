import type { Injector } from '@angular/core';

import type {
  WorkspaceShellLifecycleDelegatesOptions,
} from './workspace-shell-lifecycle-delegates.factory';

export interface WorkspaceShellLifecycleStartupOptionsFactoryOptions {
  injector?: Injector;
  destroyed: () => boolean;
  warn: (message: string, error: unknown) => void;
}

export type WorkspaceShellLifecycleStartupOptions = Pick<
  WorkspaceShellLifecycleDelegatesOptions,
  'flowPrewarm' | 'lazyLifecycles' | 'startupLazyServices'
>;

export function createWorkspaceShellLifecycleStartupOptions(
  options: WorkspaceShellLifecycleStartupOptionsFactoryOptions,
): WorkspaceShellLifecycleStartupOptions {
  return {
    flowPrewarm: {
      isDestroyed: options.destroyed,
      warn: options.warn,
    },
    lazyLifecycles: {
      injector: options.injector,
      runtime: { destroyed: options.destroyed },
      warn: options.warn,
    },
    startupLazyServices: {
      injector: options.injector,
      warn: options.warn,
    },
  };
}
