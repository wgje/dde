import {
  WorkspaceShellDerivedUiStateController,
  type WorkspaceShellDeleteProjectData,
  type WorkspaceShellDerivedUiStateControllerOptions,
} from './workspace-shell-derived-ui-state.controller';

export interface WorkspaceShellDerivedUiStateFactoryOptions {
  uiState: { filterMode(): string };
  projectState: {
    getTask: WorkspaceShellDerivedUiStateControllerOptions['getTask'];
  };
  modal: {
    isOpen: (id: 'deleteProject') => boolean;
    getData: (id: 'deleteProject') => unknown;
  };
  authCoord: {
    showLoginRequired: () => boolean;
  };
  handoffCoordinator: {
    result: () => { kind: string };
  };
  createController?: (
    options: WorkspaceShellDerivedUiStateControllerOptions,
  ) => WorkspaceShellDerivedUiStateController;
}

export function createWorkspaceShellDerivedUiStateController(
  options: WorkspaceShellDerivedUiStateFactoryOptions,
): WorkspaceShellDerivedUiStateController {
  const createController =
    options.createController ?? (
      (controllerOptions: WorkspaceShellDerivedUiStateControllerOptions) =>
        new WorkspaceShellDerivedUiStateController(controllerOptions)
    );

  return createController({
    filterId: () => options.uiState.filterMode(),
    getTask: (taskId) => options.projectState.getTask(taskId),
    isDeleteProjectModalOpen: () => options.modal.isOpen('deleteProject'),
    getDeleteProjectData: () =>
      options.modal.getData('deleteProject') as
        | WorkspaceShellDeleteProjectData
        | undefined,
    isAuthLoginRequired: () => options.authCoord.showLoginRequired(),
    isHandoffLoginRequired: () =>
      options.handoffCoordinator.result().kind === 'login-required',
  });
}
