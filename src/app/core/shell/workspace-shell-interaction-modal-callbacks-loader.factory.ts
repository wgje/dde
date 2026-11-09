import type { ModalCallbacks } from '../../../services/workspace-modal-coordinator.service';
import type {
  WorkspaceShellInteractionModalCallbacksOptions,
} from './workspace-shell-interaction-modal-callbacks.factory';

export interface WorkspaceShellInteractionModalCallbacksLoaderOptions {
  readonly options: WorkspaceShellInteractionModalCallbacksOptions;
}

export function createWorkspaceShellInteractionModalCallbacksLoader(
  loaderOptions: WorkspaceShellInteractionModalCallbacksLoaderOptions,
): () => Promise<ModalCallbacks> {
  return () => import('./workspace-shell-modal-callbacks.controller')
    .then(({ WorkspaceShellModalCallbacksController }) =>
      new WorkspaceShellModalCallbacksController(loaderOptions.options).createCallbacks());
}
