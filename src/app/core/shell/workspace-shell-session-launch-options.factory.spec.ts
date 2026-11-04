import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type {
  WorkspaceShellSessionLaunchDelegatesOptions,
} from './workspace-shell-session-launch-delegates.factory';
import type {
  WorkspaceShellSessionLaunchControllers,
  WorkspaceShellSessionLaunchControllersFactoryOptions,
} from './workspace-shell-session-launch.factory';
import {
  readWorkspaceShellControllerGraphCallOptions,
  readWorkspaceShellControllerGraphSource,
  readWorkspaceShellLifecycleGraphCallOptions,
  readWorkspaceShellLifecycleGraphSource,
  readWorkspaceShellSessionLifecycleSurfaceSource,
  readWorkspaceShellSource,
} from './workspace-shell-source.spec-helpers';

type WorkspaceShellSessionLaunchOptionsFactory = (
  options: Record<string, unknown>,
) => WorkspaceShellSessionLaunchDelegatesOptions;
type WorkspaceShellSessionLaunchDelegateFactory = (
  options: Record<string, unknown>,
) => WorkspaceShellSessionLaunchControllers;

async function loadFactories(): Promise<{
  createWorkspaceShellSessionLaunchDelegate?:
    WorkspaceShellSessionLaunchDelegateFactory;
  createWorkspaceShellSessionLaunchSurface?:
    WorkspaceShellSessionLaunchDelegateFactory;
  createWorkspaceShellSessionLaunchOptions?:
    WorkspaceShellSessionLaunchOptionsFactory;
}> {
  const modulePath = './workspace-shell-session-launch-options.factory';
  const module = await import(/* @vite-ignore */ modulePath)
    .catch(() => ({}));

  return module as {
    createWorkspaceShellSessionLaunchDelegate?:
      WorkspaceShellSessionLaunchDelegateFactory;
    createWorkspaceShellSessionLaunchSurface?:
      WorkspaceShellSessionLaunchDelegateFactory;
    createWorkspaceShellSessionLaunchOptions?:
      WorkspaceShellSessionLaunchOptionsFactory;
  };
}

function createSessionLaunchControllers(): WorkspaceShellSessionLaunchControllers {
  return {
    launchSnapshotController: { sync: vi.fn() },
    sessionTransition: {
      cleanup: vi.fn(),
      setupSessionHandlers: vi.fn(),
    },
  };
}

describe('workspace shell session launch options', () => {
  it('builds session-launch delegate options from shell dependencies', async () => {
    const { createWorkspaceShellSessionLaunchOptions } = await loadFactories();

    expect(createWorkspaceShellSessionLaunchOptions).toEqual(
      expect.any(Function),
    );

    const authCoord = { isCheckingSession: vi.fn(() => false) };
    const authService = {
      completeCrossTabSessionRestore: vi.fn(),
      sessionInitialized: vi.fn(() => true),
    };
    const eventBus = {
      onSessionRestored$: { subscribe: vi.fn() },
      onSessionInvalidated$: { subscribe: vi.fn() },
    };
    const launchSnapshot = {
      cancelPendingPersist: vi.fn(),
      schedulePersistDeferred: vi.fn(),
    };
    const actionQueue = {
      reloadFromStorageForCurrentOwner: vi.fn(),
      processQueue: vi.fn(),
    };
    const lazyServiceRefs = {
      simpleSync: {
        startRuntime: vi.fn(),
        stopRuntime: vi.fn(),
      },
    };
    const preferenceService = { theme: vi.fn(() => 'default') };
    const projectState = {
      activeProjectId: vi.fn(() => 'project-1'),
      projects: vi.fn(() => []),
    };
    const projectSubscription = { clear: vi.fn() };
    const routeUrl = vi.fn(() => '/projects/project-1/text');
    const startupTier = { isTierReady: vi.fn(() => true) };
    const syncPulseLifecycle = {
      destroy: vi.fn(),
      resetFocusEntrySyncPulse: vi.fn(),
    };
    const uiState = {
      activeView: vi.fn(() => 'text' as const),
      isMobile: vi.fn(() => false),
    };
    const userSession = {
      currentUserId: vi.fn(() => 'user-1'),
      getLaunchSnapshotPersistOwnerDuringAuthSettle: vi.fn(() => null),
      isHintOnlyStartupPlaceholderVisible: vi.fn(() => false),
      setCurrentUser: vi.fn().mockResolvedValue(undefined),
    };
    const warn = vi.fn();

    const options = createWorkspaceShellSessionLaunchOptions?.({
      actionQueue,
      authCoord,
      authService,
      eventBus,
      launchSnapshot,
      lazyServiceRefs,
      preferenceService,
      projectState,
      projectSubscription,
      routeUrl,
      startupTier,
      syncPulseLifecycle,
      uiState,
      userSession,
      warn,
    });

    expect(options).toEqual({
      actionQueue,
      authCoord,
      authService,
      eventBus,
      launchSnapshot,
      lazyServiceRefs,
      preferenceService,
      projectState,
      projectSubscription,
      routeState: { routeUrl },
      startupTier,
      syncPulseLifecycle,
      uiState,
      userSession,
      warn,
    });
  });

  it('creates session-launch controllers from shell dependencies in one factory call', async () => {
    const { createWorkspaceShellSessionLaunchDelegate } = await loadFactories();

    expect(createWorkspaceShellSessionLaunchDelegate).toEqual(
      expect.any(Function),
    );

    let mappedOptions!: WorkspaceShellSessionLaunchControllersFactoryOptions;
    const controllers = createSessionLaunchControllers();
    const authCoord = { isCheckingSession: vi.fn(() => false) };
    const authService = {
      completeCrossTabSessionRestore: vi.fn(),
      sessionInitialized: vi.fn(() => true),
    };
    const eventBus = {
      onSessionRestored$: { subscribe: vi.fn() },
      onSessionInvalidated$: { subscribe: vi.fn() },
    };
    const launchSnapshot = {
      cancelPendingPersist: vi.fn(),
      schedulePersistDeferred: vi.fn(),
    };
    const actionQueue = {
      reloadFromStorageForCurrentOwner: vi.fn(),
      processQueue: vi.fn(),
    };
    const lazyServiceRefs = {
      simpleSync: {
        startRuntime: vi.fn(),
        stopRuntime: vi.fn(),
      },
    };
    const preferenceService = { theme: vi.fn(() => 'default') };
    const projectState = {
      activeProjectId: vi.fn(() => 'project-1'),
      projects: vi.fn(() => []),
    };
    const projectSubscription = { clear: vi.fn() };
    const routeUrl = vi.fn(() => '/projects/project-1/text');
    const startupTier = { isTierReady: vi.fn(() => true) };
    const syncPulseLifecycle = {
      destroy: vi.fn(),
      resetFocusEntrySyncPulse: vi.fn(),
    };
    const uiState = {
      activeView: vi.fn(() => 'text' as const),
      isMobile: vi.fn(() => false),
    };
    const userSession = {
      currentUserId: vi.fn(() => 'user-1'),
      isHintOnlyStartupPlaceholderVisible: vi.fn(() => false),
      setCurrentUser: vi.fn().mockResolvedValue(undefined),
    };

    const delegate = createWorkspaceShellSessionLaunchDelegate?.({
      actionQueue,
      authCoord,
      authService,
      eventBus,
      launchSnapshot,
      lazyServiceRefs,
      preferenceService,
      projectState,
      projectSubscription,
      routeUrl,
      startupTier,
      syncPulseLifecycle,
      uiState,
      userSession,
      warn: vi.fn(),
      createSessionLaunchControllers: (
        options: WorkspaceShellSessionLaunchControllersFactoryOptions,
      ) => {
        mappedOptions = options;
        return controllers;
      },
    });

    expect(delegate).not.toBe(controllers);

    delegate?.launchSnapshotController.sync();
    await vi.waitFor(() => {
      expect(controllers.launchSnapshotController.sync).toHaveBeenCalledOnce();
    });
    expect(mappedOptions.currentUserId()).toBe('user-1');
    expect(mappedOptions.activeProjectId()).toBe('project-1');
    expect(mappedOptions.routeUrl()).toBe('/projects/project-1/text');
  });

  it('creates session-launch controllers from grouped shell surfaces', async () => {
    const { createWorkspaceShellSessionLaunchSurface } = await loadFactories();

    expect(createWorkspaceShellSessionLaunchSurface).toEqual(
      expect.any(Function),
    );

    let mappedOptions!: WorkspaceShellSessionLaunchControllersFactoryOptions;
    const controllers = createSessionLaunchControllers();
    const routeUrl = vi.fn(() => '/projects/project-1/text');
    const launchSnapshot = {
      cancelPendingPersist: vi.fn(),
      schedulePersistDeferred: vi.fn(),
    };
    const syncPulseLifecycle = {
      destroy: vi.fn(),
      resetFocusEntrySyncPulse: vi.fn(),
    };
    const actionQueue = {
      reloadFromStorageForCurrentOwner: vi.fn(),
      processQueue: vi.fn(),
    };

    const delegate = createWorkspaceShellSessionLaunchSurface?.({
      actionQueue,
      authCoord: { isCheckingSession: vi.fn(() => false) },
      authService: {
        completeCrossTabSessionRestore: vi.fn(),
        sessionInitialized: vi.fn(() => true),
      },
      eventBus: {
        onSessionRestored$: { subscribe: vi.fn() },
        onSessionInvalidated$: { subscribe: vi.fn() },
      },
      launchSnapshotSurface: {
        launchSnapshot,
        startupLaunchSnapshot: vi.fn(() => null),
      },
      lazyServiceRefs: {
        simpleSync: {
          startRuntime: vi.fn(),
          stopRuntime: vi.fn(),
        },
      },
      preferenceService: { theme: vi.fn(() => 'default') },
      projectState: {
        activeProjectId: vi.fn(() => 'project-1'),
        projects: vi.fn(() => []),
      },
      projectSubscription: { clear: vi.fn() },
      routing: {
        router: {},
        routeUrl,
        routeSyncController: { syncStateFromRoute: vi.fn() },
      },
      startupTier: { isTierReady: vi.fn(() => true) },
      focusSyncControllers: {
        syncPulseLifecycle,
      },
      uiState: {
        activeView: vi.fn(() => 'text' as const),
        isMobile: vi.fn(() => false),
      },
      userSession: {
        currentUserId: vi.fn(() => 'user-1'),
        isHintOnlyStartupPlaceholderVisible: vi.fn(() => false),
        setCurrentUser: vi.fn().mockResolvedValue(undefined),
      },
      warn: vi.fn(),
      createSessionLaunchControllers: (
        options: WorkspaceShellSessionLaunchControllersFactoryOptions,
      ) => {
        mappedOptions = options;
        return controllers;
      },
    });

    expect(delegate).not.toBe(controllers);

    delegate?.launchSnapshotController.sync();
    await vi.waitFor(() => {
      expect(controllers.launchSnapshotController.sync).toHaveBeenCalledOnce();
    });
    expect(mappedOptions.routeUrl()).toBe('/projects/project-1/text');
    const persistOptions = {
      activeProjectId: 'project-1',
      colorMode: 'dark' as const,
      degradeReason: null,
      lastActiveView: 'text' as const,
      mobileDegraded: false,
      resolvedLaunchView: 'text' as const,
      routeUrl: '/projects/project-1/text',
      theme: 'default' as const,
      userId: 'user-1',
    };
    mappedOptions.schedulePersistDeferred([], persistOptions);
    mappedOptions.resetFocusEntrySyncPulseState(true);
    expect(launchSnapshot.schedulePersistDeferred)
      .toHaveBeenCalledWith([], persistOptions);
    expect(syncPulseLifecycle.resetFocusEntrySyncPulse)
      .toHaveBeenCalledWith(true);
  });

  it('defers grouped session-launch delegate construction until first use', async () => {
    const { createWorkspaceShellSessionLaunchSurface } = await loadFactories();
    const controllers = createSessionLaunchControllers();
    const createSessionLaunchSurfaceDelegate = vi.fn()
      .mockResolvedValue(controllers);
    const actionQueue = {
      reloadFromStorageForCurrentOwner: vi.fn(),
      processQueue: vi.fn(),
    };

    const delegate = createWorkspaceShellSessionLaunchSurface?.({
      actionQueue,
      authCoord: { isCheckingSession: vi.fn(() => false) },
      authService: {
        completeCrossTabSessionRestore: vi.fn(),
        sessionInitialized: vi.fn(() => true),
      },
      eventBus: {
        onSessionRestored$: { subscribe: vi.fn() },
        onSessionInvalidated$: { subscribe: vi.fn() },
      },
      launchSnapshotSurface: {
        launchSnapshot: {
          cancelPendingPersist: vi.fn(),
          schedulePersistDeferred: vi.fn(),
        },
        startupLaunchSnapshot: vi.fn(() => null),
      },
      lazyServiceRefs: {
        simpleSync: {
          startRuntime: vi.fn(),
          stopRuntime: vi.fn(),
        },
      },
      preferenceService: { theme: vi.fn(() => 'default') },
      projectState: {
        activeProjectId: vi.fn(() => 'project-1'),
        projects: vi.fn(() => []),
      },
      projectSubscription: { clear: vi.fn() },
      routing: {
        router: {},
        routeUrl: vi.fn(() => '/projects/project-1/text'),
        routeSyncController: { syncStateFromRoute: vi.fn() },
      },
      startupTier: { isTierReady: vi.fn(() => true) },
      focusSyncControllers: {
        syncPulseLifecycle: {
          destroy: vi.fn(),
          resetFocusEntrySyncPulse: vi.fn(),
        },
      },
      uiState: {
        activeView: vi.fn(() => 'text' as const),
        isMobile: vi.fn(() => false),
      },
      userSession: {
        currentUserId: vi.fn(() => 'user-1'),
        isHintOnlyStartupPlaceholderVisible: vi.fn(() => false),
        setCurrentUser: vi.fn().mockResolvedValue(undefined),
      },
      warn: vi.fn(),
      createSessionLaunchSurfaceDelegate,
    });

    expect(createSessionLaunchSurfaceDelegate).not.toHaveBeenCalled();

    delegate?.sessionTransition.setupSessionHandlers();

    await vi.waitFor(() => {
      expect(createSessionLaunchSurfaceDelegate).toHaveBeenCalledOnce();
      expect(controllers.sessionTransition.setupSessionHandlers)
        .toHaveBeenCalledOnce();
    });
  });

  it('keeps session-launch option wiring outside WorkspaceShellComponent', () => {
    const source = readWorkspaceShellSource();
    const graphSource = readWorkspaceShellControllerGraphSource();
    const lifecycleGraphSource = readWorkspaceShellLifecycleGraphSource();
    const sessionLifecycleSurfaceSource =
      readWorkspaceShellSessionLifecycleSurfaceSource();
    const lifecycleGraphOptions = readWorkspaceShellControllerGraphCallOptions(
      'createWorkspaceShellLifecycleGraph',
    );
    const sessionLaunchBlock = sessionLifecycleSurfaceSource.match(
      /createWorkspaceShellSessionLaunchSurface\(\{(?<body>[\s\S]*?)\n\s+\}\);/,
    )?.groups?.body;
    const sessionLifecycleBlock = readWorkspaceShellLifecycleGraphCallOptions(
      'createWorkspaceShellSessionLifecycleSurface',
    );

    expect(graphSource).toContain('createWorkspaceShellLifecycleGraph');
    expect(lifecycleGraphSource)
      .toContain('createWorkspaceShellSessionLifecycleSurface');
    expect(sessionLifecycleSurfaceSource)
      .toContain('createWorkspaceShellSessionLaunchSurface');
    expect(sessionLifecycleBlock).toBeDefined();
    expect(sessionLaunchBlock).toBeDefined();
    expect(source).not.toContain('createWorkspaceShellSessionLaunchOptions');
    expect(source).not.toContain('private readonly sessionLaunchOptions');
    expect(source).not.toContain('createWorkspaceShellSessionLaunchDelegates');
    expect(source).not.toMatch(
      /createWorkspaceShellSessionLaunchDelegates\(\{\s*authCoord:/s,
    );
    expect(lifecycleGraphOptions).toContain('...sessionRouting');
    expect(lifecycleGraphOptions).toContain('...startupTemplate');
    expect(sessionLifecycleBlock).toContain('...options');
    expect(sessionLaunchBlock).toContain('...options');
    expect(sessionLaunchBlock).not.toContain('routeUrl: this.routing.routeUrl');
    expect(sessionLaunchBlock).not.toContain(
      'launchSnapshot: this.launchSnapshotSurface.launchSnapshot',
    );
    expect(sessionLaunchBlock).not.toContain(
      'syncPulseLifecycle: this.focusSyncControllers.syncPulseLifecycle',
    );
    expect(sessionLaunchBlock).not.toContain(
      'routeState: { routeUrl: this.routing.routeUrl }',
    );
  });

  it('keeps session-launch lazy host state inside the lazy delegate controller', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-session-launch-options.factory.ts'),
      'utf8',
    );

    expect(source).toContain("from './workspace-shell-session-launch-lazy-delegate.controller'");
    expect(source).toContain('new WorkspaceShellSessionLaunchLazyDelegateController(');
    expect(source).toContain('createWorkspaceShellSessionLaunchDelegateLoader');
    expect(source).not.toContain('WorkspaceShellLazyDelegateCallHostController');
    expect(source).not.toContain('function createWorkspaceShellSessionLaunchLazyDelegate');
    expect(source).not.toContain('SESSION_LAUNCH_ACTION_FAILURE_MESSAGE');
    expect(source).not.toContain("import('./workspace-shell-session-launch-delegates.factory')");
    expect(source).not.toContain('createWorkspaceShellSessionLaunchDelegates(options)');
  });
});
