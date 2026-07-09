import { describe, expect, it, vi } from 'vitest';
import type { ActivatedRoute, Router } from '@angular/router';

import {
  createWorkspaceShellRouteSyncControllerLoader,
  type WorkspaceShellRouteSyncControllerLike,
} from './workspace-shell-route-sync-controller-loader.factory';

function createRouteSyncController(): WorkspaceShellRouteSyncControllerLike {
  return {
    cleanup: vi.fn(),
    setupRouteSync: vi.fn(),
    syncStateFromRoute: vi.fn(),
    updateUrlForProject: vi.fn(),
  };
}

function createOptions() {
  return {
    route: vi.fn(() => ({} as ActivatedRoute)),
    router: vi.fn(() => ({
      events: { subscribe: vi.fn() },
      navigate: vi.fn(),
    } as unknown as Router)),
    projects: vi.fn(() => [{ id: 'project-1' }]),
    activeProjectId: vi.fn(() => 'project-1'),
    userSession: {
      canAuthoritativelyRejectProjectRoute: vi.fn(() => true),
      isProjectAuthoritativelyAccessible: vi.fn(() => true),
      switchActiveProject: vi.fn(),
    },
    resolveStartupProjectFallbackId: vi.fn(() => 'project-1'),
    navigateRootStartupToTextProject: vi.fn(),
    warn: vi.fn(),
  };
}

describe('createWorkspaceShellRouteSyncControllerLoader', () => {
  it('uses the provided route sync controller factory', async () => {
    const controller = createRouteSyncController();
    const createRouteSyncControllerFactory = vi.fn(() => controller);
    const loadController = createWorkspaceShellRouteSyncControllerLoader({
      createRouteSyncController: createRouteSyncControllerFactory,
      options: createOptions(),
    });

    await expect(loadController()).resolves.toBe(controller);

    expect(createRouteSyncControllerFactory).toHaveBeenCalledOnce();
  });

  it('converts synchronous route sync factory failures to rejected promises and retries later', async () => {
    const failure = new Error('route sync controller factory failed');
    const controller = createRouteSyncController();
    const createRouteSyncControllerFactory = vi.fn()
      .mockImplementationOnce(() => {
        throw failure;
      })
      .mockReturnValueOnce(controller);
    const loadController = createWorkspaceShellRouteSyncControllerLoader({
      createRouteSyncController: createRouteSyncControllerFactory,
      options: createOptions(),
    });

    const loadPromise = loadController();

    await expect(loadPromise).rejects.toBe(failure);
    await expect(loadController()).resolves.toBe(controller);
    expect(createRouteSyncControllerFactory).toHaveBeenCalledTimes(2);
  });

  it('creates the default route sync controller lazily', async () => {
    const options = createOptions();
    const loadController = createWorkspaceShellRouteSyncControllerLoader({ options });

    expect(options.router).not.toHaveBeenCalled();

    const controller = await loadController();
    controller.updateUrlForProject('project-1');

    expect(options.router).toHaveBeenCalledOnce();
    const router = options.router.mock.results[0]?.value as Router;
    expect(router.navigate).toHaveBeenCalledWith(
      ['/projects', 'project-1'],
      { replaceUrl: true, queryParamsHandling: 'preserve' },
    );
  });
});
