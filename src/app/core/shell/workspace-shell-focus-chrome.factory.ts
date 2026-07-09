import {
  WorkspaceShellFocusChromeController,
  type WorkspaceShellFocusChromeControllerOptions,
} from './workspace-shell-focus-chrome.controller';

export interface WorkspaceShellFocusChromeFactoryOptions {
  focusChromePhase: WorkspaceShellFocusChromeControllerOptions['phase'];
  uiState: {
    isMobile: WorkspaceShellFocusChromeControllerOptions['isMobile'];
    sidebarOpen: WorkspaceShellFocusChromeControllerOptions['sidebarOpen'];
    sidebarWidth: WorkspaceShellFocusChromeControllerOptions['sidebarWidth'];
  };
  createController?: (
    options: WorkspaceShellFocusChromeControllerOptions,
  ) => WorkspaceShellFocusChromeController;
}

export function createWorkspaceShellFocusChromeController(
  options: WorkspaceShellFocusChromeFactoryOptions,
): WorkspaceShellFocusChromeController {
  const createController =
    options.createController ?? (
      (controllerOptions: WorkspaceShellFocusChromeControllerOptions) =>
        new WorkspaceShellFocusChromeController(controllerOptions)
    );

  return createController({
    phase: options.focusChromePhase,
    isMobile: options.uiState.isMobile,
    sidebarOpen: options.uiState.sidebarOpen,
    sidebarWidth: options.uiState.sidebarWidth,
  });
}
