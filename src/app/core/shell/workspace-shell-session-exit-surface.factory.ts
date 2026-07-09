import {
  createWorkspaceShellBeforeUnloadController,
  type WorkspaceShellBeforeUnloadFactoryOptions,
} from './workspace-shell-before-unload.factory';
import type {
  WorkspaceShellBeforeUnloadController,
} from './workspace-shell-before-unload.controller';
import {
  createWorkspaceShellSignOutController,
  type WorkspaceShellSignOutFactoryOptions,
} from './workspace-shell-sign-out.factory';
import type { WorkspaceShellSignOutController } from './workspace-shell-sign-out.controller';

type WorkspaceShellSessionExitFocusSyncControllers = {
  readonly syncPulseLifecycle: ReturnType<
    WorkspaceShellSignOutFactoryOptions['syncPulseLifecycle']
  >;
};

type WorkspaceShellSessionExitLazyServiceRefs = {
  readonly simpleSync: ReturnType<
    WorkspaceShellBeforeUnloadFactoryOptions['simpleSync']
  >;
};

type WorkspaceShellSessionExitSearchDelegates = {
  readonly searchController: ReturnType<
    WorkspaceShellSignOutFactoryOptions['searchController']
  >;
};

export interface WorkspaceShellSessionExitSurface {
  readonly beforeUnloadController: WorkspaceShellBeforeUnloadController;
  readonly signOutController: WorkspaceShellSignOutController;
}

export type WorkspaceShellSessionExitSurfaceOptions =
  Omit<
    WorkspaceShellSignOutFactoryOptions,
    'searchController' | 'syncPulseLifecycle'
  >
  & Omit<WorkspaceShellBeforeUnloadFactoryOptions, 'simpleSync'>
  & {
    readonly focusSyncControllers: () => WorkspaceShellSessionExitFocusSyncControllers;
    readonly lazyServiceRefs: WorkspaceShellSessionExitLazyServiceRefs;
    readonly searchDelegates: WorkspaceShellSessionExitSearchDelegates;
    readonly createBeforeUnloadController?: (
      options: WorkspaceShellBeforeUnloadFactoryOptions,
    ) => WorkspaceShellBeforeUnloadController;
    readonly createSignOutController?: (
      options: WorkspaceShellSignOutFactoryOptions,
    ) => WorkspaceShellSignOutController;
  };

export function createWorkspaceShellSessionExitSurface(
  options: WorkspaceShellSessionExitSurfaceOptions,
): WorkspaceShellSessionExitSurface {
  const {
    actionQueue,
    authCoord,
    beforeUnloadGuard,
    beforeUnloadManager,
    createBeforeUnloadController =
      createWorkspaceShellBeforeUnloadController,
    createSignOutController = createWorkspaceShellSignOutController,
    focusSyncControllers,
    isBrowser,
    lazyServiceRefs,
    onFlushError,
    projectCoord,
    searchDelegates,
    syncCoordinator,
    undoService,
  } = options;

  return {
    beforeUnloadController: createBeforeUnloadController({
      actionQueue,
      beforeUnloadGuard,
      beforeUnloadManager,
      isBrowser,
      onFlushError,
      simpleSync: () => lazyServiceRefs.simpleSync,
      syncCoordinator,
      undoService,
    }),
    signOutController: createSignOutController({
      authCoord,
      projectCoord,
      searchController: () => searchDelegates.searchController,
      syncPulseLifecycle: () => focusSyncControllers().syncPulseLifecycle,
    }),
  };
}
