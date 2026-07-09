import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type {
  WorkspaceShellSessionLaunchDelegatesOptions,
} from './workspace-shell-session-launch-delegates.factory';
import {
  createWorkspaceShellSessionLaunchDelegateLoader,
} from './workspace-shell-session-launch-delegate-loader.factory';
import type {
  WorkspaceShellSessionLaunchControllers,
  WorkspaceShellSessionLaunchControllersFactoryOptions,
} from './workspace-shell-session-launch.factory';

function createSessionLaunchControllers(): WorkspaceShellSessionLaunchControllers {
  return {
    launchSnapshotController: { sync: vi.fn() },
    sessionTransition: {
      cleanup: vi.fn(),
      setupSessionHandlers: vi.fn(),
    },
  };
}

function createOptions(
  overrides: Partial<WorkspaceShellSessionLaunchDelegatesOptions> = {},
): WorkspaceShellSessionLaunchDelegatesOptions {
  return {
    authCoord: { isCheckingSession: vi.fn(() => false) },
    authService: {
      completeCrossTabSessionRestore: vi.fn(),
      sessionInitialized: vi.fn(() => true),
    },
    eventBus: {
      onSessionRestored$: { subscribe: vi.fn() },
      onSessionInvalidated$: { subscribe: vi.fn() },
    },
    launchSnapshot: {
      cancelPendingPersist: vi.fn(),
      schedulePersistDeferred: vi.fn(),
    },
    lazyServiceRefs: {
      simpleSync: {
        startRuntime: vi.fn(),
        stopRuntime: vi.fn(),
      },
    },
    preferenceService: { theme: vi.fn(() => 'default' as const) },
    projectState: {
      activeProjectId: vi.fn(() => 'project-1'),
      projects: vi.fn(() => []),
    },
    projectSubscription: { clear: vi.fn() },
    routeState: { routeUrl: vi.fn(() => '/projects/project-1/text') },
    startupTier: { isTierReady: vi.fn(() => true) },
    syncPulseLifecycle: {
      destroy: vi.fn(),
      resetFocusEntrySyncPulse: vi.fn(),
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
    ...overrides,
  };
}

describe('createWorkspaceShellSessionLaunchDelegateLoader', () => {
  it('loads session-launch delegates lazily from delegate options', async () => {
    const controllers = createSessionLaunchControllers();
    const createSessionLaunchControllersSpy = vi.fn((
      _options: WorkspaceShellSessionLaunchControllersFactoryOptions,
    ) => controllers);
    const loadDelegate = createWorkspaceShellSessionLaunchDelegateLoader({
      options: createOptions({
        createSessionLaunchControllers: createSessionLaunchControllersSpy,
      }),
    });

    expect(createSessionLaunchControllersSpy).not.toHaveBeenCalled();

    await expect(loadDelegate()).resolves.toBe(controllers);

    expect(createSessionLaunchControllersSpy).toHaveBeenCalledTimes(1);
  });

  it('owns the dynamic import of the session-launch delegates factory', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-session-launch-delegate-loader.factory.ts'),
      'utf8',
    );

    expect(source).toContain("import('./workspace-shell-session-launch-delegates.factory')");
    expect(source).not.toMatch(/import\s*{[^}]*createWorkspaceShellSessionLaunchDelegates/s);
  });
});
