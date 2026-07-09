import type { Injector, WritableSignal } from '@angular/core';
import type {
  ModalCallbacks,
  WorkspaceModalCoordinatorService,
} from '../../../services/workspace-modal-coordinator.service';
import { WorkspaceShellModalActionRunner } from './workspace-shell-modal-action-runner.controller';
import {
  WorkspaceShellModalCoordinatorLazyLoadController,
  type WorkspaceShellModalCoordinatorLike,
} from './workspace-shell-modal-coordinator-lazy-load.controller';
import {
  createWorkspaceShellModalCoordinatorServiceLoader,
} from './workspace-shell-modal-coordinator-service-loader.factory';

export interface WorkspaceShellModalLazyLoadFactoryOptions<
  TModalCoord extends WorkspaceShellModalCoordinatorLike = WorkspaceModalCoordinatorService,
> {
  createCallbacks: () => ModalCallbacks | Promise<ModalCallbacks>;
  destroyed: () => boolean;
  fallbackModalCoord: TModalCoord;
  injector?: Injector;
  loadModalCoord?: () => Promise<TModalCoord>;
  modalLoading: WritableSignal<Record<string, boolean>>;
  warn?: (message: string, error: unknown) => void;
}

export interface WorkspaceShellModalLazyLoadDelegates<
  TModalCoord extends WorkspaceShellModalCoordinatorLike = WorkspaceModalCoordinatorService,
> {
  readonly actions: WorkspaceShellModalActionRunner<TModalCoord>;
  readonly coordinator: WorkspaceShellModalCoordinatorLazyLoadController<TModalCoord>;
}

export function createWorkspaceShellModalLazyLoadDelegates<
  TModalCoord extends WorkspaceShellModalCoordinatorLike = WorkspaceModalCoordinatorService,
>(
  options: WorkspaceShellModalLazyLoadFactoryOptions<TModalCoord>,
): WorkspaceShellModalLazyLoadDelegates<TModalCoord> {
  const loadModalCoord = createWorkspaceShellModalCoordinatorServiceLoader<TModalCoord>({
    injector: options.injector,
    loadModalCoord: options.loadModalCoord,
  });
  const coordinator = new WorkspaceShellModalCoordinatorLazyLoadController<TModalCoord>({
    createCallbacks: options.createCallbacks,
    destroyed: options.destroyed,
    fallbackModalCoord: options.fallbackModalCoord,
    loadModalCoord,
    warn: options.warn,
  });
  const actions = new WorkspaceShellModalActionRunner<TModalCoord>({
    modalLoading: options.modalLoading,
    getModalCoord: () => coordinator.get(),
    isCoordinatorLoading: type => coordinator.isModalLoading(type),
  });

  return { actions, coordinator };
}
