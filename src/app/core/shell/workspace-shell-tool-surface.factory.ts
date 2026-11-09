import {
  createWorkspaceShellToolControllers,
  type WorkspaceShellToolControllers,
  type WorkspaceShellToolControllersOptions,
} from './workspace-shell-tool-controllers.factory';

type WorkspaceShellToolSurfaceLazyServiceRefs = Pick<
  WorkspaceShellToolControllersOptions,
  'blackBoxService'
>;

export type WorkspaceShellToolSurfaceOptions =
  Omit<WorkspaceShellToolControllersOptions, 'blackBoxService' | 'sidebarOpen'> & {
    readonly lazyServiceRefs: WorkspaceShellToolSurfaceLazyServiceRefs;
    readonly uiState: Pick<WorkspaceShellToolControllersOptions, 'sidebarOpen'>;
    readonly createToolControllers?: (
      options: WorkspaceShellToolControllersOptions,
    ) => WorkspaceShellToolControllers;
  };

export function createWorkspaceShellToolSurface(
  options: WorkspaceShellToolSurfaceOptions,
): WorkspaceShellToolControllers {
  const {
    createToolControllers = createWorkspaceShellToolControllers,
    lazyServiceRefs,
    uiState,
    ...controllerOptions
  } = options;

  return createToolControllers({
    ...controllerOptions,
    blackBoxService: lazyServiceRefs.blackBoxService,
    sidebarOpen: uiState.sidebarOpen,
  });
}
