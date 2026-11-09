import type { WritableSignal } from '@angular/core';

import {
  WorkspaceShellSidebarToggleEventController,
  type WorkspaceShellSidebarToggleEventControllerOptions,
} from './workspace-shell-sidebar-toggle-event.controller';

export interface WorkspaceShellSidebarToggleEventFactoryOptions {
  isSidebarOpen: Pick<WritableSignal<boolean>, 'update'>;
  createController?: (
    options: WorkspaceShellSidebarToggleEventControllerOptions,
  ) => WorkspaceShellSidebarToggleEventController;
}

export function createWorkspaceShellSidebarToggleEventController(
  options: WorkspaceShellSidebarToggleEventFactoryOptions,
): WorkspaceShellSidebarToggleEventController {
  const createController =
    options.createController ?? (
      (controllerOptions: WorkspaceShellSidebarToggleEventControllerOptions) =>
        new WorkspaceShellSidebarToggleEventController(controllerOptions)
    );

  return createController({
    toggleSidebar: () => options.isSidebarOpen.update(open => !open),
  });
}
