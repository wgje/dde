import type { Injector } from '@angular/core';

import type {
  WorkspaceShellFocusModePreloadLike,
  WorkspaceShellFocusToolsLoaderLike,
} from './workspace-shell-focus-tools-lazy-load.controller';

export interface WorkspaceShellFocusModePreloadServiceLoaderOptions {
  injector: Injector;
  loadFocusModePreloadService?: () => Promise<WorkspaceShellFocusModePreloadLike>;
}

export interface WorkspaceShellFocusToolsLoaderServiceLoaderOptions {
  injector: Injector;
  loadFocusToolsLoaderService?: () => Promise<WorkspaceShellFocusToolsLoaderLike>;
}

export function createWorkspaceShellFocusModePreloadServiceLoader(
  options: WorkspaceShellFocusModePreloadServiceLoaderOptions,
): () => Promise<WorkspaceShellFocusModePreloadLike> {
  if (options.loadFocusModePreloadService) {
    return options.loadFocusModePreloadService;
  }

  return () => import('../../features/focus/services/focus-mode-preload.service')
    .then(({ FocusModePreloadService }) => options.injector.get(FocusModePreloadService));
}

export function createWorkspaceShellFocusToolsLoaderServiceLoader(
  options: WorkspaceShellFocusToolsLoaderServiceLoaderOptions,
): () => Promise<WorkspaceShellFocusToolsLoaderLike> {
  if (options.loadFocusToolsLoaderService) {
    return options.loadFocusToolsLoaderService;
  }

  return () => import('../../features/focus/services/focus-tools-loader.service')
    .then(({ FocusToolsLoaderService }) => options.injector.get(FocusToolsLoaderService));
}
