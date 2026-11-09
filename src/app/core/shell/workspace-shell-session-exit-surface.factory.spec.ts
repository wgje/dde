import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type {
  WorkspaceShellBeforeUnloadFactoryOptions,
} from './workspace-shell-before-unload.factory';
import type {
  WorkspaceShellSignOutFactoryOptions,
} from './workspace-shell-sign-out.factory';
import {
  readWorkspaceShellControllerGraphSource,
  readWorkspaceShellSource,
} from './workspace-shell-source.spec-helpers';

type WorkspaceShellSessionExitSurfaceFactory = (options: Record<string, unknown>) => {
  readonly beforeUnloadController: unknown;
  readonly signOutController: unknown;
};

async function loadFactory(): Promise<{
  createWorkspaceShellSessionExitSurface?: WorkspaceShellSessionExitSurfaceFactory;
}> {
  const modulePath = './workspace-shell-session-exit-surface.factory';
  const module = await import(/* @vite-ignore */ modulePath)
    .catch(() => ({}));

  return module as {
    createWorkspaceShellSessionExitSurface?: WorkspaceShellSessionExitSurfaceFactory;
  };
}

describe('workspace shell session exit surface', () => {
  it('maps shell exit dependencies into sign-out and before-unload controllers', async () => {
    const { createWorkspaceShellSessionExitSurface } = await loadFactory();

    expect(createWorkspaceShellSessionExitSurface).toEqual(expect.any(Function));

    let signOutOptions!: WorkspaceShellSignOutFactoryOptions;
    let beforeUnloadOptions!: WorkspaceShellBeforeUnloadFactoryOptions;
    const signOutController = { signOut: vi.fn() };
    const beforeUnloadController = {
      cleanup: vi.fn(),
      setup: vi.fn(),
    };
    const syncPulseLifecycle = {
      resetFocusEntrySyncPulse: vi.fn(),
      destroy: vi.fn(),
    };
    const searchController = { clear: vi.fn() };
    const simpleSync = { flushRetryQueueSync: vi.fn() };
    const onFlushError = vi.fn();

    const result = createWorkspaceShellSessionExitSurface?.({
      actionQueue: {
        storage: {
          saveQueueToStorage: vi.fn(),
          saveDeadLetterToStorage: vi.fn(),
        },
      },
      authCoord: { signOut: vi.fn(async () => true) },
      beforeUnloadGuard: {
        disable: vi.fn(),
        enable: vi.fn(),
      },
      beforeUnloadManager: {
        initialize: vi.fn(),
        register: vi.fn(),
        unregister: vi.fn(),
      },
      focusSyncControllers: vi.fn(() => ({ syncPulseLifecycle })),
      lazyServiceRefs: { simpleSync },
      projectCoord: { clearState: vi.fn() },
      searchDelegates: { searchController },
      syncCoordinator: { flushPendingPersist: vi.fn() },
      undoService: { flushPendingAction: vi.fn() },
      onFlushError,
      createBeforeUnloadController: (
        options: WorkspaceShellBeforeUnloadFactoryOptions,
      ) => {
        beforeUnloadOptions = options;
        return beforeUnloadController;
      },
      createSignOutController: (options: WorkspaceShellSignOutFactoryOptions) => {
        signOutOptions = options;
        return signOutController;
      },
    });

    expect(result?.signOutController).toBe(signOutController);
    expect(result?.beforeUnloadController).toBe(beforeUnloadController);
    expect(signOutOptions.syncPulseLifecycle()).toBe(syncPulseLifecycle);
    expect(signOutOptions.searchController()).toBe(searchController);
    expect(beforeUnloadOptions.simpleSync()).toBe(simpleSync);
    expect(
      (beforeUnloadOptions as { onFlushError?: unknown }).onFlushError,
    ).toBe(onFlushError);
  }, 10000);

  it('keeps session exit option assembly outside WorkspaceShellComponent', () => {
    const source = readWorkspaceShellSource();
    const graphSource = readWorkspaceShellControllerGraphSource();
    const sessionRoutingSurfaceSource = readFileSync(
      join(
        process.cwd(),
        'src/app/core/shell/workspace-shell-session-routing-surface.factory.ts',
      ),
      'utf8',
    );

    expect(graphSource).toContain('createWorkspaceShellSessionRoutingSurface');
    expect(sessionRoutingSurfaceSource)
      .toContain('createWorkspaceShellSessionExitSurface');
    expect(source).not.toContain('createWorkspaceShellSignOutController');
    expect(source).not.toContain('createWorkspaceShellBeforeUnloadController');
    expect(source).not.toContain(
      'searchController: () => this.searchDelegates.searchController',
    );
    expect(source).not.toContain('simpleSync: () => this.lazyServiceRefs.simpleSync');
    expect(source).not.toContain('syncPulseLifecycle: () => this.syncPulseLifecycle');
  });
});
