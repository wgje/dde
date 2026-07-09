import { signal, type Injector, type Signal, type WritableSignal } from '@angular/core';
import type { Project } from '../../../models';

import {
  createWorkspaceShellSearchController,
  type WorkspaceShellSearchFactoryOptions,
} from './workspace-shell-search.factory';
import type { WorkspaceShellSearchController } from './workspace-shell-search.controller';
import {
  createWorkspaceShellSearchLazyLoadDelegate,
  type WorkspaceShellSearchLazyLoadDelegate,
  type WorkspaceShellSearchLazyLoadDelegateOptions,
} from './workspace-shell-search-lazy-load-delegate.factory';

export interface WorkspaceShellSearchDelegates {
  readonly unifiedSearchQuery: WritableSignal<string>;
  readonly searchController: WorkspaceShellSearchController;
  readonly searchLazyLoad: WorkspaceShellSearchLazyLoadDelegate;
}

export interface WorkspaceShellSearchDelegatesOptions {
  injector: Injector;
  uiState: WorkspaceShellSearchFactoryOptions['uiState'];
  fallbackProjects: Signal<Project[]>;
  runtime: {
    destroyed?: () => boolean;
  };
  warn: (message: string, error: unknown) => void;
  createUnifiedSearchQuery?: () => WritableSignal<string>;
  createSearchController?: (
    options: WorkspaceShellSearchFactoryOptions,
  ) => WorkspaceShellSearchController;
  createSearchLazyLoad?: (
    options: WorkspaceShellSearchLazyLoadDelegateOptions,
  ) => WorkspaceShellSearchLazyLoadDelegate;
}

export function createWorkspaceShellSearchDelegates(
  options: WorkspaceShellSearchDelegatesOptions,
): WorkspaceShellSearchDelegates {
  const unifiedSearchQuery = options.createUnifiedSearchQuery?.() ?? signal('');
  const searchController = (options.createSearchController ?? createWorkspaceShellSearchController)({
    uiState: options.uiState,
    unifiedSearchQuery,
  });
  const searchLazyLoad = (options.createSearchLazyLoad ?? createWorkspaceShellSearchLazyLoadDelegate)({
    destroyed: options.runtime.destroyed,
    injector: options.injector,
    fallbackProjects: options.fallbackProjects,
    hasActiveSearchQuery: () => searchController.hasActiveQuery(),
    warn: options.warn,
  });

  return {
    unifiedSearchQuery,
    searchController,
    searchLazyLoad,
  };
}
