import type { Signal } from '@angular/core';
import type { Project } from '../../../models';
import type {
  WorkspaceShellSearchLazyLoadControllerOptions,
  WorkspaceShellSearchServiceLike,
  WorkspaceShellSearchTask,
} from './workspace-shell-search-lazy-load.controller';
import type { WorkspaceShellSearchLazyLoadControllerFactory } from './workspace-shell-search-lazy-load-controller-loader.factory';
import { WorkspaceShellSearchLazyLoadDelegateController } from './workspace-shell-search-lazy-load-delegate.controller';

export interface WorkspaceShellSearchLazyLoadDelegate {
  readonly searchResults: Signal<WorkspaceShellSearchTask[]>;
  readonly filteredProjects: Signal<Project[]>;
  ensureLoaded(): void;
}

export interface WorkspaceShellSearchLazyLoadDelegateOptions
  extends WorkspaceShellSearchLazyLoadControllerOptions {
  loadSearchDelegate?: WorkspaceShellSearchLazyLoadControllerFactory;
}

export function createWorkspaceShellSearchLazyLoadDelegate(
  options: WorkspaceShellSearchLazyLoadDelegateOptions,
): WorkspaceShellSearchLazyLoadDelegate {
  return new WorkspaceShellSearchLazyLoadDelegateController(options);
}

export type { WorkspaceShellSearchServiceLike };
