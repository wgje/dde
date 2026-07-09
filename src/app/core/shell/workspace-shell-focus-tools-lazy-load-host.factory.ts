import type {
  WorkspaceShellFocusToolsLazyLoadControllerOptions,
} from './workspace-shell-focus-tools-lazy-load.controller';
import type {
  WorkspaceShellFocusToolsHostDelegate,
} from './workspace-shell-tool-lazy-load-hosts.factory';
import {
  createWorkspaceShellFocusToolsLazyLoadControllerLoader,
} from './workspace-shell-focus-tools-lazy-load-controller-loader.factory';

export interface WorkspaceShellFocusToolsLazyLoadHostFactoryOptions
  extends WorkspaceShellFocusToolsLazyLoadControllerOptions {}

export function createWorkspaceShellFocusToolsLazyLoadHost(
  options: WorkspaceShellFocusToolsLazyLoadHostFactoryOptions,
): Promise<WorkspaceShellFocusToolsHostDelegate> {
  return createWorkspaceShellFocusToolsLazyLoadControllerLoader({
    injector: options.injector,
    focusSessionTriggerComponent: options.focusSessionTriggerComponent,
    blackBoxRecorderComponent: options.blackBoxRecorderComponent,
    loadFocusModePreloadService: options.loadFocusModePreloadService,
    loadFocusToolsLoaderService: options.loadFocusToolsLoaderService,
    warn: options.warn,
  })();
}
