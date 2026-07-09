import {
  resolveStartupEntryIntent,
  type StartupEntryIntent,
} from '../../../utils/startup-entry-intent';
import {
  WorkspaceShellStartupEntryIntentLazyDelegateController,
} from './workspace-shell-startup-entry-intent-lazy-delegate.controller';
import type {
  WorkspaceShellStartupEntryIntentLazyLoadHostOptions,
} from './workspace-shell-startup-entry-intent-lazy-load-host.controller';
import {
  resolveConsumedStartupEntryNavigation,
  type ConsumedStartupEntryNavigationCommands,
} from './workspace-shell-startup-route.helpers';
import {
  createWorkspaceShellStartupEntryIntentPendingActionsController,
  type WorkspaceShellStartupEntryIntentPendingActionsController,
} from './workspace-shell-startup-entry-intent-pending-actions.controller';

const STARTUP_ENTRY_INTENT_LAZY_LOAD_FAILURE_MESSAGE =
  'Startup entry intent lazy-load host 加载失败，已保留待处理动作';

export type WorkspaceShellDeferredStartupEntryIntentSignal = (
  () => StartupEntryIntent | null
) & {
  set: (startupEntryIntent: StartupEntryIntent | null) => void;
};

export interface WorkspaceShellStartupEntryIntentFactoryOptions
  extends Omit<
    WorkspaceShellStartupEntryIntentLazyLoadHostOptions,
    | 'clearDeferredStartupEntryIntent'
    | 'currentStartupEntryIntent'
    | 'deferredStartupEntryIntent'
  > {
  deferredStartupEntryIntent: WorkspaceShellDeferredStartupEntryIntentSignal;
  persistDeferredStartupEntryIntent: (
    startupEntryIntent: StartupEntryIntent | null,
  ) => void;
}

export interface WorkspaceShellStartupEntryIntentControllerLike {
  flushWidgetWorkspaceGateRecheck(): void;
  resetPrimeState(): void;
  resolveConsumedStartupEntryNavigation(): ConsumedStartupEntryNavigationCommands;
  sync(): void;
  teardown(): void;
}

type WorkspaceShellStartupEntryIntentLazyHost =
  WorkspaceShellStartupEntryIntentLazyDelegateController;

interface WorkspaceShellStartupEntryIntentControllerState {
  options: WorkspaceShellStartupEntryIntentFactoryOptions;
  currentStartupEntryIntent: () => StartupEntryIntent | null;
  lazyHost: WorkspaceShellStartupEntryIntentLazyHost;
  pendingActions: WorkspaceShellStartupEntryIntentPendingActionsController;
  isTornDown: () => boolean;
  markTornDown: () => void;
}

export function createWorkspaceShellStartupEntryIntentResolver(options: {
  routeUrl: () => string;
}): () => StartupEntryIntent | null {
  return () => resolveStartupEntryIntent(options.routeUrl());
}

export function createWorkspaceShellStartupEntryIntentController(
  options: WorkspaceShellStartupEntryIntentFactoryOptions,
): WorkspaceShellStartupEntryIntentControllerLike {
  const currentStartupEntryIntent = createWorkspaceShellStartupEntryIntentResolver({
    routeUrl: options.routeUrl,
  });
  const lazyHost = createStartupEntryIntentLazyHost(
    options,
    currentStartupEntryIntent,
    createDeferredStartupEntryIntentClearer(options),
  );
  const pendingActions = createWorkspaceShellStartupEntryIntentPendingActionsController();
  let isTornDown = false;

  return createStartupEntryIntentControllerFacade({
    options,
    currentStartupEntryIntent,
    lazyHost,
    pendingActions,
    isTornDown: () => isTornDown,
    markTornDown: () => {
      isTornDown = true;
    },
  });
}

function createStartupEntryIntentControllerFacade(
  state: WorkspaceShellStartupEntryIntentControllerState,
): WorkspaceShellStartupEntryIntentControllerLike {
  const resolvePendingActions = () =>
    resolveStartupEntryIntentPendingActions(state);

  return {
    flushWidgetWorkspaceGateRecheck(): void {
      if (state.isTornDown()) {
        return;
      }

      captureStartupEntryIntentGateDependencies(state.options);
      state.pendingActions.markFlushPending();
      resolvePendingActions();
    },
    resetPrimeState(): void {
      if (state.isTornDown()) {
        return;
      }

      state.lazyHost.loadedDelegate?.resetPrimeState();
    },
    resolveConsumedStartupEntryNavigation(): ConsumedStartupEntryNavigationCommands {
      return resolveConsumedStartupEntryNavigation({
        routeUrl: state.options.routeUrl(),
        mobileRootProjectId: state.options.resolveMobileRootProjectId,
      });
    },
    sync(): void {
      if (state.isTornDown()) {
        return;
      }

      captureStartupEntryIntentSyncDependencies(
        state.options,
        state.currentStartupEntryIntent,
      );
      state.pendingActions.markSyncPending();
      resolvePendingActions();
    },
    teardown(): void {
      state.markTornDown();
      state.pendingActions.clear();
      state.lazyHost.teardown();
    },
  };
}

function resolveStartupEntryIntentPendingActions(
  state: WorkspaceShellStartupEntryIntentControllerState,
): void {
  if (state.isTornDown()) {
    return;
  }

  state.lazyHost.run(
    host => state.pendingActions.flush(host),
    STARTUP_ENTRY_INTENT_LAZY_LOAD_FAILURE_MESSAGE,
  );
}

function createDeferredStartupEntryIntentClearer(
  options: WorkspaceShellStartupEntryIntentFactoryOptions,
): () => void {
  return () => {
    options.deferredStartupEntryIntent.set(null);
    options.persistDeferredStartupEntryIntent(null);
  };
}

function captureStartupEntryIntentSyncDependencies(
  options: WorkspaceShellStartupEntryIntentFactoryOptions,
  currentStartupEntryIntent: () => StartupEntryIntent | null,
): void {
  options.routeUrl();
  currentStartupEntryIntent();
  options.deferredStartupEntryIntent();
  options.isApplicationReady();
  options.currentUserId();
}

function captureStartupEntryIntentGateDependencies(
  options: WorkspaceShellStartupEntryIntentFactoryOptions,
): void {
  options.isApplicationReady();
  options.currentUserId();
}

function createStartupEntryIntentLazyHost(
  options: WorkspaceShellStartupEntryIntentFactoryOptions,
  currentStartupEntryIntent: () => StartupEntryIntent | null,
  clearDeferredStartupEntryIntent: () => void,
): WorkspaceShellStartupEntryIntentLazyHost {
  return new WorkspaceShellStartupEntryIntentLazyDelegateController({
    options,
    currentStartupEntryIntent,
    clearDeferredStartupEntryIntent,
  });
}
