import { describe, expect, it, vi } from 'vitest';
import type { Project } from '../../../models';

import {
  createWorkspaceShellSessionLaunchControllers,
  type WorkspaceShellSessionLaunchControllersFactoryOptions,
} from './workspace-shell-session-launch.factory';
import { createWorkspaceShellSessionLaunchDelegates } from './workspace-shell-session-launch-delegates.factory';
import type {
  WorkspaceShellLaunchSnapshotController,
  WorkspaceShellLaunchSnapshotControllerOptions,
} from './workspace-shell-launch-snapshot.controller';
import type {
  WorkspaceShellSessionTransitionLazyLoadController,
  WorkspaceShellSessionTransitionLazyLoadControllerOptions,
} from './workspace-shell-session-transition-lazy-load.controller';

function createOptions(
  overrides: Partial<WorkspaceShellSessionLaunchControllersFactoryOptions> = {},
): WorkspaceShellSessionLaunchControllersFactoryOptions {
  return {
    activeProjectId: () => 'project-1',
    activeView: () => 'flow',
    cancelPendingLaunchSnapshotPersist: vi.fn(),
    clearProjectSubscription: vi.fn(),
    completeCrossTabSessionRestore: vi.fn(),
    currentUserId: () => 'user-1',
    destroySyncPulse: vi.fn(),
    getPersistOwnerDuringAuthSettle: () => null,
    isCheckingSession: () => false,
    isHintOnlyStartupPlaceholderVisible: () => false,
    isMobile: () => false,
    isSessionInitialized: () => true,
    isStartupTierReady: () => true,
    isTieredStartupHydration: () => false,
    projects: () => [] as Project[],
    readColorMode: () => 'dark',
    resetFocusEntrySyncPulseState: vi.fn(),
    routeUrl: () => '/projects/project-1/flow',
    schedulePersistDeferred: vi.fn(),
    setCurrentUser: vi.fn().mockResolvedValue(undefined),
    startSyncRuntime: vi.fn(),
    stopSyncRuntime: vi.fn(),
    subscribeToSessionInvalidated: vi.fn(),
    subscribeToSessionRestored: vi.fn(),
    theme: () => 'default',
    warn: vi.fn(),
    ...overrides,
  };
}

describe('createWorkspaceShellSessionLaunchControllers', () => {
  it('shares launch snapshot write blocking between session transitions and snapshot persistence', () => {
    let sessionOptions!: WorkspaceShellSessionTransitionLazyLoadControllerOptions;
    let launchOptions!: WorkspaceShellLaunchSnapshotControllerOptions;
    const sessionTransition = {} as WorkspaceShellSessionTransitionLazyLoadController;
    const launchSnapshotController = {} as WorkspaceShellLaunchSnapshotController;

    const controllers = createWorkspaceShellSessionLaunchControllers(createOptions({
      createLaunchSnapshotController: (options) => {
        launchOptions = options;
        return launchSnapshotController;
      },
      createSessionTransitionController: (options) => {
        sessionOptions = options;
        return sessionTransition;
      },
    }));

    expect(controllers.sessionTransition).toBe(sessionTransition);
    expect(controllers.launchSnapshotController).toBe(launchSnapshotController);
    expect(launchOptions.isWriteBlocked()).toBe(false);

    sessionOptions.setLaunchSnapshotWriteBlocked(true);
    expect(launchOptions.isWriteBlocked()).toBe(true);

    sessionOptions.setLaunchSnapshotWriteBlocked(false);
    expect(launchOptions.isWriteBlocked()).toBe(false);
  });

  it('maps session cancel-persist semantics to the launch snapshot controller', () => {
    let launchOptions!: WorkspaceShellLaunchSnapshotControllerOptions;
    const cancelPendingLaunchSnapshotPersist = vi.fn();

    createWorkspaceShellSessionLaunchControllers(createOptions({
      cancelPendingLaunchSnapshotPersist,
      createLaunchSnapshotController: (options) => {
        launchOptions = options;
        return {} as WorkspaceShellLaunchSnapshotController;
      },
      createSessionTransitionController: () =>
        ({} as WorkspaceShellSessionTransitionLazyLoadController),
    }));

    launchOptions.cancelPendingPersist();

    expect(cancelPendingLaunchSnapshotPersist).toHaveBeenCalledTimes(1);
  });
});

describe('createWorkspaceShellSessionLaunchDelegates', () => {
  it('maps shell services and delegates into session launch controller options', async () => {
    let mappedOptions!: WorkspaceShellSessionLaunchControllersFactoryOptions;
    const subscription = { unsubscribe: vi.fn() };
    const authService = {
      completeCrossTabSessionRestore: vi.fn(),
      sessionInitialized: () => true,
    };
    const syncPulseLifecycle = {
      resetFocusEntrySyncPulse: vi.fn(),
      destroy: vi.fn(),
    };
    const launchSnapshot = {
      cancelPendingPersist: vi.fn(),
      schedulePersistDeferred: vi.fn(),
    };
    const lazyServiceRefs = {
      simpleSync: {
        stopRuntime: vi.fn(),
        startRuntime: vi.fn(),
      },
    };
    const projectSubscription = {
      clear: vi.fn(),
    };
    const userSession = {
      currentUserId: () => 'user-1',
      setCurrentUser: vi.fn().mockResolvedValue(undefined),
      isHintOnlyStartupPlaceholderVisible: () => false,
      getLaunchSnapshotPersistOwnerDuringAuthSettle: () => 'settling-user',
    };
    const eventBus = {
      onSessionRestored$: { subscribe: vi.fn(() => subscription) },
      onSessionInvalidated$: { subscribe: vi.fn(() => subscription) },
    };
    const projects = [{ id: 'project-1' }] as Project[];
    const routeState = { routeUrl: vi.fn(() => '/projects/project-1/flow') };

    createWorkspaceShellSessionLaunchDelegates({
      authCoord: { isCheckingSession: () => false },
      authService,
      eventBus,
      launchSnapshot,
      lazyServiceRefs,
      preferenceService: { theme: () => 'default' },
      projectState: {
        activeProjectId: () => 'project-1',
        projects: () => projects,
      },
      projectSubscription,
      routeState,
      startupTier: { isTierReady: () => true },
      syncPulseLifecycle,
      uiState: {
        activeView: () => 'flow',
        isMobile: () => false,
      },
      userSession,
      warn: vi.fn(),
      createSessionLaunchControllers: (options) => {
        mappedOptions = options;
        return {
          launchSnapshotController: {} as WorkspaceShellLaunchSnapshotController,
          sessionTransition: {} as WorkspaceShellSessionTransitionLazyLoadController,
        };
      },
    });

    mappedOptions.completeCrossTabSessionRestore('user-2');
    mappedOptions.resetFocusEntrySyncPulseState(false);
    mappedOptions.cancelPendingLaunchSnapshotPersist();
    mappedOptions.stopSyncRuntime();
    mappedOptions.startSyncRuntime();
    mappedOptions.clearProjectSubscription();
    mappedOptions.destroySyncPulse();
    await mappedOptions.setCurrentUser('user-2', { forceLoad: true });
    mappedOptions.subscribeToSessionRestored?.(vi.fn());
    mappedOptions.subscribeToSessionInvalidated?.(vi.fn());
    mappedOptions.schedulePersistDeferred(projects, {
      activeProjectId: 'project-1',
      colorMode: 'dark',
      degradeReason: null,
      lastActiveView: 'flow',
      mobileDegraded: false,
      resolvedLaunchView: 'flow',
      routeUrl: '/projects/project-1/flow',
      theme: 'default',
      userId: 'user-1',
    });

    expect(mappedOptions.currentUserId()).toBe('user-1');
    expect(authService.completeCrossTabSessionRestore).toHaveBeenCalledWith('user-2');
    expect(syncPulseLifecycle.resetFocusEntrySyncPulse).toHaveBeenCalledWith(false);
    expect(launchSnapshot.cancelPendingPersist).toHaveBeenCalledTimes(1);
    expect(lazyServiceRefs.simpleSync.stopRuntime).toHaveBeenCalledTimes(1);
    expect(lazyServiceRefs.simpleSync.startRuntime).toHaveBeenCalledTimes(1);
    expect(projectSubscription.clear).toHaveBeenCalledTimes(1);
    expect(syncPulseLifecycle.destroy).toHaveBeenCalledTimes(1);
    expect(userSession.setCurrentUser).toHaveBeenCalledWith('user-2', { forceLoad: true });
    expect(eventBus.onSessionRestored$.subscribe).toHaveBeenCalledTimes(1);
    expect(eventBus.onSessionInvalidated$.subscribe).toHaveBeenCalledTimes(1);
    expect(mappedOptions.isHintOnlyStartupPlaceholderVisible()).toBe(false);
    expect(mappedOptions.projects()).toBe(projects);
    expect(mappedOptions.isSessionInitialized()).toBe(true);
    expect(mappedOptions.isCheckingSession()).toBe(false);
    expect(mappedOptions.getPersistOwnerDuringAuthSettle()).toBe('settling-user');
    expect(mappedOptions.activeProjectId()).toBe('project-1');
    expect(mappedOptions.activeView()).toBe('flow');
    expect(mappedOptions.routeUrl()).toBe('/projects/project-1/flow');
    expect(mappedOptions.isMobile()).toBe(false);
    expect(mappedOptions.theme()).toBe('default');
    expect(mappedOptions.isTieredStartupHydration()).toBe(true);
    expect(launchSnapshot.schedulePersistDeferred).toHaveBeenCalledTimes(1);
  });
});
