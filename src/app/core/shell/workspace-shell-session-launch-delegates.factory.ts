import type { Project, ThemeType } from '../../../models';
import { FEATURE_FLAGS } from '../../../config/feature-flags.config';

import {
  createWorkspaceShellSessionLaunchControllers,
  type WorkspaceShellSessionLaunchControllers,
  type WorkspaceShellSessionLaunchControllersFactoryOptions,
} from './workspace-shell-session-launch.factory';

type SessionRestoredListener = Parameters<
  NonNullable<
    WorkspaceShellSessionLaunchControllersFactoryOptions['subscribeToSessionRestored']
  >
>[0];
type SessionInvalidatedListener = Parameters<
  NonNullable<
    WorkspaceShellSessionLaunchControllersFactoryOptions['subscribeToSessionInvalidated']
  >
>[0];
type SessionSubscription = ReturnType<
  NonNullable<
    WorkspaceShellSessionLaunchControllersFactoryOptions['subscribeToSessionRestored']
  >
>;

export interface WorkspaceShellSessionLaunchDelegatesOptions {
  actionQueue: {
    reloadFromStorageForCurrentOwner(): Promise<void>;
    processQueue(): Promise<unknown>;
  };
  authCoord: { isCheckingSession(): boolean };
  authService: {
    completeCrossTabSessionRestore(userId: string): void;
    sessionInitialized(): boolean;
  };
  eventBus: {
    onSessionRestored$: {
      subscribe(listener: SessionRestoredListener): SessionSubscription;
    };
    onSessionInvalidated$: {
      subscribe(listener: SessionInvalidatedListener): SessionSubscription;
    };
  };
  launchSnapshot: {
    cancelPendingPersist(): void;
    schedulePersistDeferred:
      WorkspaceShellSessionLaunchControllersFactoryOptions['schedulePersistDeferred'];
  };
  lazyServiceRefs: {
    simpleSync: {
      startRuntime(): void;
      stopRuntime(): void;
    };
  };
  preferenceService: { theme(): ThemeType };
  projectState: {
    activeProjectId(): string | null;
    projects(): Project[];
  };
  projectSubscription: { clear(): void };
  routeState: { routeUrl(): string };
  startupTier: { isTierReady(tier: 'p2'): boolean };
  syncPulseLifecycle: {
    destroy(): void;
    resetFocusEntrySyncPulse(rearmIntentListener: boolean): void;
  };
  uiState: {
    activeView(): 'text' | 'flow' | null;
    isMobile(): boolean;
  };
  userSession: {
    currentUserId(): string | null;
    getLaunchSnapshotPersistOwnerDuringAuthSettle?(): string | null;
    isHintOnlyStartupPlaceholderVisible(): boolean;
    setCurrentUser:
      WorkspaceShellSessionLaunchControllersFactoryOptions['setCurrentUser'];
  };
  warn: WorkspaceShellSessionLaunchControllersFactoryOptions['warn'];
  readColorMode?: WorkspaceShellSessionLaunchControllersFactoryOptions['readColorMode'];
  createLaunchSnapshotController?:
    WorkspaceShellSessionLaunchControllersFactoryOptions['createLaunchSnapshotController'];
  createSessionLaunchControllers?: (
    options: WorkspaceShellSessionLaunchControllersFactoryOptions,
  ) => WorkspaceShellSessionLaunchControllers;
  createSessionTransitionController?:
    WorkspaceShellSessionLaunchControllersFactoryOptions['createSessionTransitionController'];
}

export function createWorkspaceShellSessionLaunchDelegates(
  options: WorkspaceShellSessionLaunchDelegatesOptions,
): WorkspaceShellSessionLaunchControllers {
  const createControllers =
    options.createSessionLaunchControllers
    ?? createWorkspaceShellSessionLaunchControllers;

  return createControllers(createSessionLaunchControllerOptions(options));
}

function createSessionLaunchControllerOptions(
  options: WorkspaceShellSessionLaunchDelegatesOptions,
): WorkspaceShellSessionLaunchControllersFactoryOptions {
  return {
    reloadActionQueue: () => options.actionQueue.reloadFromStorageForCurrentOwner(),
    replayActionQueue: () => options.actionQueue.processQueue(),
    currentUserId: () => options.userSession.currentUserId(),
    completeCrossTabSessionRestore: userId =>
      options.authService.completeCrossTabSessionRestore(userId),
    resetFocusEntrySyncPulseState: rearmIntentListener =>
      options.syncPulseLifecycle.resetFocusEntrySyncPulse(rearmIntentListener),
    cancelPendingLaunchSnapshotPersist: () =>
      options.launchSnapshot.cancelPendingPersist(),
    stopSyncRuntime: () => options.lazyServiceRefs.simpleSync.stopRuntime(),
    startSyncRuntime: () => options.lazyServiceRefs.simpleSync.startRuntime(),
    clearProjectSubscription: () => options.projectSubscription.clear(),
    destroySyncPulse: () => options.syncPulseLifecycle.destroy(),
    setCurrentUser: (userId, setOptions) =>
      options.userSession.setCurrentUser(userId, setOptions),
    isTieredStartupHydration: () => FEATURE_FLAGS.TIERED_STARTUP_HYDRATION_V1,
    isStartupTierReady: tier => options.startupTier.isTierReady(tier),
    warn: options.warn,
    subscribeToSessionRestored: listener =>
      options.eventBus.onSessionRestored$.subscribe(listener),
    subscribeToSessionInvalidated: listener =>
      options.eventBus.onSessionInvalidated$.subscribe(listener),
    isHintOnlyStartupPlaceholderVisible: () =>
      options.userSession.isHintOnlyStartupPlaceholderVisible(),
    projects: () => options.projectState.projects(),
    isSessionInitialized: () => options.authService.sessionInitialized(),
    isCheckingSession: () => options.authCoord.isCheckingSession(),
    getPersistOwnerDuringAuthSettle: () =>
      options.userSession.getLaunchSnapshotPersistOwnerDuringAuthSettle?.() ?? null,
    activeProjectId: () => options.projectState.activeProjectId(),
    activeView: () => options.uiState.activeView(),
    routeUrl: () => options.routeState.routeUrl(),
    isMobile: () => options.uiState.isMobile(),
    theme: () => options.preferenceService.theme(),
    schedulePersistDeferred: (projects, persistOptions) =>
      options.launchSnapshot.schedulePersistDeferred(projects, persistOptions),
    ...(options.readColorMode ? { readColorMode: options.readColorMode } : {}),
    ...(options.createLaunchSnapshotController
      ? { createLaunchSnapshotController: options.createLaunchSnapshotController }
      : {}),
    ...(options.createSessionTransitionController
      ? { createSessionTransitionController: options.createSessionTransitionController }
      : {}),
  };
}
