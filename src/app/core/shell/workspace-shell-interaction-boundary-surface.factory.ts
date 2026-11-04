import type { WorkspaceShellChromeSurface } from './workspace-shell-chrome-surface.factory';
import type { WorkspaceShellDerivedUiStateController } from './workspace-shell-derived-ui-state.controller';
import type { WorkspaceShellFocusSyncControllers } from './workspace-shell-focus-sync-controllers.factory';
import type { WorkspaceShellInteractionDelegatesOptions } from './workspace-shell-interaction-delegates.factory';
import {
  createWorkspaceShellInteractionSurface,
  type WorkspaceShellInteractionModalCoord,
  type WorkspaceShellInteractionSurface,
  type WorkspaceShellInteractionSurfaceOptions,
} from './workspace-shell-interaction-surface.factory';
import type { WorkspaceShellRoutingSurface } from './workspace-shell-routing-surface.factory';
import type { WorkspaceShellSearchDelegates } from './workspace-shell-search-delegates.factory';

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

export function createWorkspaceShellInteractionBoundarySurface<
  TModalCoord extends WorkspaceShellInteractionModalCoord,
>(
  options: WorkspaceShellInteractionBoundarySurfaceOptions<TModalCoord>,
): WorkspaceShellInteractionSurface<TModalCoord> {
  return createWorkspaceShellInteractionSurface(
    createWorkspaceShellInteractionBoundarySurfaceOptions(options),
  );
}
