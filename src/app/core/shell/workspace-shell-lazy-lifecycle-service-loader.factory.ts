import type { Injector } from '@angular/core';

import type {
  WorkspaceShellLazyLifecycleDelegate,
} from './workspace-shell-lazy-lifecycle-host.controller';

export type WorkspaceShellLazyLifecycleServiceLoaderOptions<
  TService extends WorkspaceShellLazyLifecycleDelegate,
> =
  | {
    loadService: () => Promise<TService>;
    injector?: Injector;
    missingInjectorMessage?: string;
    resolveService?: (injector: Injector) => Promise<TService>;
  }
  | {
    injector?: Injector;
    loadService?: undefined;
    missingInjectorMessage: string;
    resolveService: (injector: Injector) => Promise<TService>;
  };

export function createWorkspaceShellLazyLifecycleServiceLoader<
  TService extends WorkspaceShellLazyLifecycleDelegate,
>(
  options: WorkspaceShellLazyLifecycleServiceLoaderOptions<TService>,
): () => Promise<TService> {
  return () => {
    try {
      if (options.loadService) {
        return Promise.resolve(options.loadService());
      }

      if (!options.injector) {
        return Promise.reject(new Error(options.missingInjectorMessage));
      }

      return Promise.resolve(options.resolveService(options.injector));
    } catch (error) {
      return Promise.reject(error);
    }
  };
}
