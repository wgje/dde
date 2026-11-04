import type { Injector, WritableSignal } from '@angular/core';

import {
  createWorkspaceShellInteractionDelegates,
  type WorkspaceShellInteractionDelegatesOptions,
} from './workspace-shell-interaction-delegates.factory';
import {
  createWorkspaceShellInteractionTemplateSurface,
  type WorkspaceShellInteractionTemplateSurface,
} from './workspace-shell-interaction-template-surface.factory';
import type {
  WorkspaceShellInteractionLazyLoadDelegates,
} from './workspace-shell-interaction-lazy-load-delegates.factory';
import {
  createWorkspaceShellModalLazyLoadDelegates,
  type WorkspaceShellModalLazyLoadDelegates,
  type WorkspaceShellModalLazyLoadFactoryOptions,
} from './workspace-shell-modal-lazy-load.factory';
import type {
  WorkspaceShellModalCoordinatorLike,
} from './workspace-shell-modal-coordinator-lazy-load.controller';
import {
  createWorkspaceShellModalLazyLoadOptions,
  type WorkspaceShellModalLazyLoadOptionsDependencies,
} from './workspace-shell-modal-lazy-load-options.factory';
import type {
  WorkspaceShellSessionExitSurface,
} from './workspace-shell-session-exit-surface.factory';

export type WorkspaceShellInteractionModalCoord =
  WorkspaceShellInteractionDelegatesOptions['modalCoord'] &
  WorkspaceShellModalCoordinatorLike;

export interface WorkspaceShellInteractionSurface<
  TModalCoord extends WorkspaceShellInteractionModalCoord =
    WorkspaceShellInteractionModalCoord,
> {
  readonly interaction: WorkspaceShellInteractionTemplateSurface;
  readonly interactionLifecycle:
    WorkspaceShellInteractionLazyLoadDelegates['lifecycle'];
  readonly modalCallbacks:
    WorkspaceShellInteractionLazyLoadDelegates['modalCallbacks'];
  readonly modalLazyLoad: WorkspaceShellModalLazyLoadDelegates<TModalCoord>;
}

export interface WorkspaceShellInteractionSurfaceOptions<
  TModalCoord extends WorkspaceShellInteractionModalCoord =
    WorkspaceShellInteractionModalCoord,
> extends Omit<
    WorkspaceShellInteractionDelegatesOptions,
    'destroyed' | 'injector' | 'modalCoord' | 'signOutController'
  > {
  readonly destroyed: () => boolean;
  readonly injector: Injector;
  readonly modalCoord: TModalCoord;
  readonly modalLoading: WritableSignal<Record<string, boolean>>;
  readonly sessionExitSurface: Pick<
    WorkspaceShellSessionExitSurface,
    'signOutController'
  >;
  readonly createInteractionDelegates?: (
    options: WorkspaceShellInteractionDelegatesOptions,
  ) => WorkspaceShellInteractionLazyLoadDelegates;
  readonly createInteractionTemplateSurface?: (
    delegates: WorkspaceShellInteractionLazyLoadDelegates,
  ) => WorkspaceShellInteractionTemplateSurface;
  readonly createModalLazyLoadOptions?: (
    dependencies: WorkspaceShellModalLazyLoadOptionsDependencies<TModalCoord>,
  ) => WorkspaceShellModalLazyLoadFactoryOptions<TModalCoord>;
  readonly createModalLazyLoadDelegates?: (
    options: WorkspaceShellModalLazyLoadFactoryOptions<TModalCoord>,
  ) => WorkspaceShellModalLazyLoadDelegates<TModalCoord>;
}

export function createWorkspaceShellInteractionSurface<
  TModalCoord extends WorkspaceShellInteractionModalCoord,
>(
  options: WorkspaceShellInteractionSurfaceOptions<TModalCoord>,
): WorkspaceShellInteractionSurface<TModalCoord> {
  const {
    createInteractionDelegates = createWorkspaceShellInteractionDelegates,
    createInteractionTemplateSurface =
      createWorkspaceShellInteractionTemplateSurface,
    createModalLazyLoadDelegates =
      createWorkspaceShellModalLazyLoadDelegates,
    createModalLazyLoadOptions = createWorkspaceShellModalLazyLoadOptions,
    modalLoading,
    sessionExitSurface,
    ...interactionOptions
  } = options;

  const interactionDelegates = createInteractionDelegates({
    ...interactionOptions,
    signOutController: sessionExitSurface.signOutController,
  });
  const modalCallbacks = interactionDelegates.modalCallbacks;
  const modalLazyLoadOptions = createModalLazyLoadOptions({
    modalCallbacks,
    destroyed: options.destroyed,
    modalCoord: options.modalCoord,
    injector: options.injector,
    modalLoading,
    warn: options.warn,
  });

  return {
    interaction: createInteractionTemplateSurface(interactionDelegates),
    interactionLifecycle: interactionDelegates.lifecycle,
    modalCallbacks,
    modalLazyLoad: createModalLazyLoadDelegates(modalLazyLoadOptions),
  };
}
