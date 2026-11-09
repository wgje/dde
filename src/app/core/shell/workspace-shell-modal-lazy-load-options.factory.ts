import type { Injector, WritableSignal } from '@angular/core';

import type {
  ModalCallbacks,
  WorkspaceModalCoordinatorService,
} from '../../../services/workspace-modal-coordinator.service';
import type {
  WorkspaceShellModalLazyLoadFactoryOptions,
} from './workspace-shell-modal-lazy-load.factory';
import type {
  WorkspaceShellModalCoordinatorLike,
} from './workspace-shell-modal-coordinator-lazy-load.controller';

export interface WorkspaceShellModalLazyLoadOptionsDependencies<
  TModalCoord extends WorkspaceShellModalCoordinatorLike = WorkspaceModalCoordinatorService,
> {
  modalCallbacks: {
    createCallbacks: () => ModalCallbacks | Promise<ModalCallbacks>;
  };
  destroyed: () => boolean;
  modalCoord: TModalCoord;
  injector: Injector;
  modalLoading: WritableSignal<Record<string, boolean>>;
  warn: (message: string, error: unknown) => void;
}

export function createWorkspaceShellModalLazyLoadOptions<
  TModalCoord extends WorkspaceShellModalCoordinatorLike = WorkspaceModalCoordinatorService,
>(
  dependencies: WorkspaceShellModalLazyLoadOptionsDependencies<TModalCoord>,
): WorkspaceShellModalLazyLoadFactoryOptions<TModalCoord> {
  return {
    createCallbacks: () => dependencies.modalCallbacks.createCallbacks(),
    destroyed: dependencies.destroyed,
    fallbackModalCoord: dependencies.modalCoord,
    injector: dependencies.injector,
    modalLoading: dependencies.modalLoading,
    warn: dependencies.warn,
  };
}
