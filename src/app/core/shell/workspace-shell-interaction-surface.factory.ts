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
import type {
  WorkspaceShellRoutingSurface,
} from './workspace-shell-routing-surface.factory';
import type {
  WorkspaceShellFocusSyncControllers,
} from './workspace-shell-focus-sync-controllers.factory';
import type {
  WorkspaceShellChromeSurface,
} from './workspace-shell-chrome-surface.factory';
import type {
  WorkspaceShellSearchDelegates,
} from './workspace-shell-search-delegates.factory';
import type {
  WorkspaceShellDerivedUiStateController,
} from './workspace-shell-derived-ui-state.controller';

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

export type WorkspaceShellInteractionBoundarySurfaceOptions<
  TModalCoord extends WorkspaceShellInteractionModalCoord =
    WorkspaceShellInteractionModalCoord,
> = Omit<
  WorkspaceShellInteractionSurfaceOptions<TModalCoord>,
  | 'dockEngine'
  | 'focus'
  | 'layout'
  | 'modalLoading'
  | 'navigation'
  | 'runtime'
  | 'searchController'
  | 'searchLazyLoad'
> & {
  readonly routing: Pick<
    WorkspaceShellRoutingSurface,
    'router' | 'routeUrl'
  >;
  readonly focusSyncControllers: Pick<
    WorkspaceShellFocusSyncControllers,
    'mobileFocusGate'
  >;
  readonly chrome: Pick<WorkspaceShellChromeSurface, 'dockEngine'>;
  readonly lazyServiceRefs: {
    readonly parkingService: WorkspaceShellInteractionDelegatesOptions['runtime']['lazyServiceRefs']['parkingService'];
  };
  readonly uiState:
    WorkspaceShellInteractionDelegatesOptions['layout']['uiState'] & {
      readonly sidebarOpen:
        WorkspaceShellInteractionDelegatesOptions['layout']['sidebarOpen'];
    };
  readonly projectState:
    WorkspaceShellInteractionDelegatesOptions['navigation']['projectState'];
  readonly searchDelegates: Pick<
    WorkspaceShellSearchDelegates,
    'searchController' | 'searchLazyLoad'
  >;
  readonly derivedUiState: Pick<WorkspaceShellDerivedUiStateController, 'modalLoading'>;
};

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

function createWorkspaceShellInteractionBoundarySurfaceOptions<
  TModalCoord extends WorkspaceShellInteractionModalCoord,
>(
  options: WorkspaceShellInteractionBoundarySurfaceOptions<TModalCoord>,
): WorkspaceShellInteractionSurfaceOptions<TModalCoord> {
  const {
    chrome,
    derivedUiState,
    focusSyncControllers,
    lazyServiceRefs,
    projectState,
    routing,
    searchDelegates,
    uiState,
    ...surfaceOptions
  } = options;

  return {
    ...surfaceOptions,
    dockEngine: chrome.dockEngine,
    navigation: {
      router: routing.router,
      projectState,
    },
    layout: {
      uiState,
      sidebarOpen: uiState.sidebarOpen,
    },
    focus: {
      mobileFocusGate: focusSyncControllers.mobileFocusGate,
    },
    runtime: {
      lazyServiceRefs,
    },
    searchController: searchDelegates.searchController,
    searchLazyLoad: searchDelegates.searchLazyLoad,
    modalLoading: derivedUiState.modalLoading,
  };
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

export function createWorkspaceShellInteractionBoundarySurface<
  TModalCoord extends WorkspaceShellInteractionModalCoord,
>(
  options: WorkspaceShellInteractionBoundarySurfaceOptions<TModalCoord>,
): WorkspaceShellInteractionSurface<TModalCoord> {
  return createWorkspaceShellInteractionSurface(
    createWorkspaceShellInteractionBoundarySurfaceOptions(options),
  );
}
