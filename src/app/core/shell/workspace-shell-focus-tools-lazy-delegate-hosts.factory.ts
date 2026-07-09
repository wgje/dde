import { WorkspaceShellFocusToolsLazyDelegateHostController } from './workspace-shell-focus-tools-lazy-delegate-host.controller';
import type {
  WorkspaceShellFocusModePreloadLike,
  WorkspaceShellFocusToolsLoaderLike,
} from './workspace-shell-focus-tools-lazy-load.controller';

export interface WorkspaceShellFocusToolsLazyDelegateHosts {
  focusModePreloadHost: WorkspaceShellFocusToolsLazyDelegateHostController<
    WorkspaceShellFocusModePreloadLike
  >;
  focusToolsLoaderHost: WorkspaceShellFocusToolsLazyDelegateHostController<
    WorkspaceShellFocusToolsLoaderLike
  >;
}

export interface WorkspaceShellFocusToolsLazyDelegateHostsOptions {
  loadFocusModePreload: () => Promise<WorkspaceShellFocusModePreloadLike>;
  loadFocusToolsLoader: () => Promise<WorkspaceShellFocusToolsLoaderLike>;
  warn: (message: string, error: unknown) => void;
}

export function createWorkspaceShellFocusToolsLazyDelegateHosts(
  options: WorkspaceShellFocusToolsLazyDelegateHostsOptions,
): WorkspaceShellFocusToolsLazyDelegateHosts {
  return {
    focusModePreloadHost: new WorkspaceShellFocusToolsLazyDelegateHostController({
      createDelegate: options.loadFocusModePreload,
      loadFailureMessage: 'Focus 模式预热服务懒加载失败，已跳过',
      warn: options.warn,
    }),
    focusToolsLoaderHost: new WorkspaceShellFocusToolsLazyDelegateHostController({
      createDelegate: options.loadFocusToolsLoader,
      loadFailureMessage: 'Focus 工具懒加载服务加载失败，侧栏工具暂不可用',
      warn: options.warn,
    }),
  };
}
