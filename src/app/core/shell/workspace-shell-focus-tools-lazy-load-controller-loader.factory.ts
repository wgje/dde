import type {
  WorkspaceShellFocusToolsLazyLoadControllerOptions,
} from './workspace-shell-focus-tools-lazy-load.controller';

export type WorkspaceShellFocusToolsLazyLoadControllerLike =
  Pick<
    import('./workspace-shell-focus-tools-lazy-load.controller').WorkspaceShellFocusToolsLazyLoadController,
    | 'loadBlackBoxRecorderComponent'
    | 'loadFocusSessionTriggerComponent'
    | 'preloadFocusMode'
    | 'scheduleFocusModePreload'
    | 'teardown'
  >;

export function createWorkspaceShellFocusToolsLazyLoadControllerLoader(
  options: WorkspaceShellFocusToolsLazyLoadControllerOptions,
): () => Promise<WorkspaceShellFocusToolsLazyLoadControllerLike> {
  return () => import('./workspace-shell-focus-tools-lazy-load.controller')
    .then(({ WorkspaceShellFocusToolsLazyLoadController }) =>
      new WorkspaceShellFocusToolsLazyLoadController(options));
}
