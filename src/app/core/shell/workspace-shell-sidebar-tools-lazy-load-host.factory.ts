import {
  WorkspaceShellSidebarToolsLazyLoadHostController,
  type WorkspaceShellSidebarToolsHostDelegate,
} from './workspace-shell-sidebar-tools-lazy-load-host.controller';
import type {
  WorkspaceShellSidebarToolsControllerOptions,
} from './workspace-shell-sidebar-tools.controller';
import type {
  WorkspaceShellFocusToolsHostDelegate,
} from './workspace-shell-tool-lazy-load-hosts.factory';

export interface WorkspaceShellSidebarToolsLazyLoadHostFactoryOptions
  extends Omit<
    WorkspaceShellSidebarToolsControllerOptions,
    | 'loadFocusSessionTrigger'
    | 'loadBlackBoxRecorder'
    | 'preloadFocusMode'
    | 'scheduleFocusModePreload'
  > {
  focusToolsLazyLoad: WorkspaceShellFocusToolsHostDelegate;
  warn: (message: string, error: unknown) => void;
  createSidebarToolsController?: () => Promise<WorkspaceShellSidebarToolsHostDelegate>;
}

export function createWorkspaceShellSidebarToolsLazyLoadHost(
  options: WorkspaceShellSidebarToolsLazyLoadHostFactoryOptions,
): Promise<WorkspaceShellSidebarToolsHostDelegate> {
  return Promise.resolve(new WorkspaceShellSidebarToolsLazyLoadHostController({
    createBlackBoxEntry: options.createBlackBoxEntry,
    warning: options.warning,
    dynamicLoadEnabled: options.dynamicLoadEnabled,
    isBlackBoxEnabled: options.isBlackBoxEnabled,
    loadFocusSessionTrigger: () =>
      options.focusToolsLazyLoad.loadFocusSessionTriggerComponent(),
    loadBlackBoxRecorder: () =>
      options.focusToolsLazyLoad.loadBlackBoxRecorderComponent(),
    preloadFocusMode: (reason) =>
      options.focusToolsLazyLoad.preloadFocusMode(reason),
    scheduleFocusModePreload: (reason) =>
      options.focusToolsLazyLoad.scheduleFocusModePreload(reason),
    addBreadcrumb: options.addBreadcrumb,
    createSidebarToolsController: options.createSidebarToolsController,
    warn: options.warn,
  }));
}
