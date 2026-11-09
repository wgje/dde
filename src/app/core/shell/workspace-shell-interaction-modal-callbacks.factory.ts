import type { ModalCallbacks } from '../../../services/workspace-modal-coordinator.service';
import type {
  WorkspaceShellModalCallbackActions,
} from './workspace-shell-modal-callbacks.controller';
import {
  createWorkspaceShellInteractionModalCallbacksLoader,
} from './workspace-shell-interaction-modal-callbacks-loader.factory';

export interface WorkspaceShellModalCallbacksDelegate {
  createCallbacks(): ModalCallbacks | Promise<ModalCallbacks>;
}

export interface WorkspaceShellInteractionModalCallbacksOptions {
  actions: WorkspaceShellModalCallbackActions;
  warn: (message: string, error: unknown) => void;
}

export function createWorkspaceShellInteractionModalCallbacks(
  options: WorkspaceShellInteractionModalCallbacksOptions,
): WorkspaceShellModalCallbacksDelegate {
  const loadCallbacks = createWorkspaceShellInteractionModalCallbacksLoader({
    options,
  });

  return {
    createCallbacks: () => loadCallbacks(),
  };
}
