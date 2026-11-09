import {
  resolveStartupEntryIntent,
  type StartupEntryIntent,
} from '../../../utils/startup-entry-intent';
import {
  WorkspaceShellStartupEntryIntentLazyDelegateController,
} from './workspace-shell-startup-entry-intent-lazy-delegate.controller';
import {
  WorkspaceShellStartupEntryIntentLifecycleController,
} from './workspace-shell-startup-entry-intent-lifecycle.controller';
import type {
  WorkspaceShellStartupEntryIntentLazyLoadHostOptions,
} from './workspace-shell-startup-entry-intent-lazy-load-host.controller';
import {
  resolveConsumedStartupEntryNavigation,
  type ConsumedStartupEntryNavigationCommands,
} from './workspace-shell-startup-route.helpers';
import {
  createWorkspaceShellStartupEntryIntentPendingActionsController,
} from './workspace-shell-startup-entry-intent-pending-actions.controller';

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

  return new WorkspaceShellStartupEntryIntentLifecycleController({
    captureGateDependencies: () =>
      captureStartupEntryIntentGateDependencies(options),
    captureSyncDependencies: () =>
      captureStartupEntryIntentSyncDependencies(
        options,
        currentStartupEntryIntent,
      ),
    lazyHost,
    pendingActions,
    resolveConsumedStartupEntryNavigation: () =>
      resolveConsumedStartupEntryNavigation({
        routeUrl: options.routeUrl(),
        mobileRootProjectId: options.resolveMobileRootProjectId,
      }),
  });
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
