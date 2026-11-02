import type {
  WorkspaceShellFocusSyncControllers,
  WorkspaceShellFocusSyncControllersOptions,
} from './workspace-shell-focus-sync-controllers.factory';
import { createWorkspaceShellFocusSyncMountState } from './workspace-shell-focus-sync-mount-state.factory';
import {
  WorkspaceShellFocusSyncSurfaceLazyDelegateController,
} from './workspace-shell-focus-sync-surface-lazy-delegate.controller';
import { createWorkspaceShellFocusSyncSurfaceDelegates } from './workspace-shell-focus-sync-surface-delegates.factory';
import { createWorkspaceShellTaskOpsAdapter } from './workspace-shell-task-ops-adapter.factory';

type WorkspaceShellFocusSyncLazyServiceRefs = Pick<
  WorkspaceShellFocusSyncControllersOptions,
  'focusStartupProbe' | 'simpleSync'
>;

type WorkspaceShellFocusSyncToolControllers = Pick<
  WorkspaceShellFocusSyncControllersOptions,
  'sidebarToolsLazyLoad'
>;

export type WorkspaceShellFocusSyncSurfaceOptions =
  Omit<
    WorkspaceShellFocusSyncControllersOptions,
    'focusStartupProbe'
    | 'isMobile'
    | 'sidebarToolsLazyLoad'
    | 'simpleSync'
    | 'taskOpsAdapter'
  > & {
    readonly lazyServiceRefs: WorkspaceShellFocusSyncLazyServiceRefs;
    readonly toolControllers: WorkspaceShellFocusSyncToolControllers;
    readonly uiState: Pick<WorkspaceShellFocusSyncControllersOptions, 'isMobile'>;
    readonly createFocusSyncControllers?: (
      options: WorkspaceShellFocusSyncControllersOptions,
    ) => WorkspaceShellFocusSyncControllers;
  };

export function createWorkspaceShellFocusSyncSurface(
  options: WorkspaceShellFocusSyncSurfaceOptions,
): WorkspaceShellFocusSyncControllers {
  const focusSyncOptions = createWorkspaceShellFocusSyncOptions(options);
  const mountState = createWorkspaceShellFocusSyncMountState(focusSyncOptions);
  const lazyControllers = createWorkspaceShellFocusSyncLazyControllers(
    focusSyncOptions,
    mountState,
    options.createFocusSyncControllers,
  );

  return {
    mountState,
    ...createWorkspaceShellFocusSyncSurfaceDelegates(
      lazyControllers,
      mountState,
    ),
  };
}

function createWorkspaceShellFocusSyncOptions(
  options: WorkspaceShellFocusSyncSurfaceOptions,
): WorkspaceShellFocusSyncControllersOptions {
  const {
    lazyServiceRefs,
    toolControllers,
    uiState,
    ...controllerOptions
  } = options;

  return {
    ...controllerOptions,
    focusStartupProbe: lazyServiceRefs.focusStartupProbe,
    isMobile: uiState.isMobile,
    sidebarToolsLazyLoad: toolControllers.sidebarToolsLazyLoad,
    simpleSync: lazyServiceRefs.simpleSync,
    taskOpsAdapter: createWorkspaceShellTaskOpsAdapter({
      injector: options.injector,
    }),
  };
}

function createWorkspaceShellFocusSyncLazyControllers(
  focusSyncOptions: WorkspaceShellFocusSyncControllersOptions,
  mountState: WorkspaceShellFocusSyncControllers['mountState'],
  createFocusSyncControllers?: WorkspaceShellFocusSyncSurfaceOptions['createFocusSyncControllers'],
) {
  return new WorkspaceShellFocusSyncSurfaceLazyDelegateController({
    focusSyncOptions,
    mountState,
    createFocusSyncControllers,
  });
}
