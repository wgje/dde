import type { WritableSignal } from '@angular/core';

import {
  WorkspaceShellSearchController,
} from './workspace-shell-search.controller';

type WorkspaceShellSearchUiState = ConstructorParameters<
  typeof WorkspaceShellSearchController
>[0];

export interface WorkspaceShellSearchFactoryOptions {
  uiState: WorkspaceShellSearchUiState;
  unifiedSearchQuery: WritableSignal<string>;
  createController?: (
    uiState: WorkspaceShellSearchUiState,
    unifiedSearchQuery: WritableSignal<string>,
  ) => WorkspaceShellSearchController;
}

export function createWorkspaceShellSearchController(
  options: WorkspaceShellSearchFactoryOptions,
): WorkspaceShellSearchController {
  const createController =
    options.createController ?? (
      (
        uiState: WorkspaceShellSearchUiState,
        unifiedSearchQuery: WritableSignal<string>,
      ) => new WorkspaceShellSearchController(uiState, unifiedSearchQuery)
    );

  return createController(options.uiState, options.unifiedSearchQuery);
}
