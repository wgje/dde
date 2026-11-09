import { describe, expect, it, vi } from 'vitest';

import {
  WorkspaceShellRouteSyncController,
  type WorkspaceShellRouteNodeLike,
  type WorkspaceShellRouteSyncControllerOptions,
} from './workspace-shell-route-sync.controller';

function routeWithoutProject(): WorkspaceShellRouteNodeLike {
  return {
    snapshot: { params: {} },
    firstChild: null,
  };
}

async function flushNavigationSettlement(): Promise<void> {
  // 纯微任务多轮排空：轮次覆盖原生/zone-patched Promise 的最深链（thenable 采纳会放大跳数），
  // 不用宏任务 setTimeout —— 共享车道 CPU 饱和时宏任务可能 2s 内不被调度导致超时
  for (let flushRound = 0; flushRound < 25; flushRound += 1) {
    await Promise.resolve();
  }
}

function routeWithDeepestProject(projectId: string): WorkspaceShellRouteNodeLike {
  return {
    snapshot: { params: {} },
    firstChild: {
      snapshot: { params: {} },
      firstChild: {
        snapshot: { params: { projectId } },
        firstChild: null,
      },
    },
  };
}

function routeWithAncestorProject(projectId: string): WorkspaceShellRouteNodeLike {
  return {
    snapshot: { params: {} },
    firstChild: {
      snapshot: { params: { projectId } },
      firstChild: {
        snapshot: { params: { taskId: 'task-1' } },
        firstChild: null,
      },
    },
  };
}

function createController(overrides: Partial<WorkspaceShellRouteSyncControllerOptions> = {}) {
  const navigate = vi.fn();
  const navigateRootStartupToTextProject = vi.fn();
  const switchActiveProject = vi.fn();
  const warn = vi.fn();
  const projects = overrides.projects ?? (() => [{ id: 'project-1' }, { id: 'project-2' }]);
  const controller = new WorkspaceShellRouteSyncController({
    route: () => routeWithoutProject(),
    projects,
    activeProjectId: () => null,
    canAuthoritativelyRejectProjectRoute: () => true,
    isProjectAuthoritativelyAccessible: () => true,
    switchActiveProject,
    resolveStartupProjectFallbackId: (projectList) => projectList[0]?.id ?? null,
    navigateRootStartupToTextProject,
    navigate,
    warn,
    ...overrides,
  });

  return {
    controller,
    navigate,
    navigateRootStartupToTextProject,
    switchActiveProject,
    warn,
  };
}

describe('WorkspaceShellRouteSyncController', () => {
  it('routes a project-less startup route to the active project text view', () => {
    const { controller, navigateRootStartupToTextProject, switchActiveProject } = createController({
      activeProjectId: () => 'project-2',
    });

    controller.syncStateFromRoute();

    expect(navigateRootStartupToTextProject).toHaveBeenCalledWith('project-2');
    expect(switchActiveProject).not.toHaveBeenCalled();
  });

  it('uses the startup fallback project when the route has no project and no active project exists', () => {
    const { controller, navigateRootStartupToTextProject, switchActiveProject } = createController({
      resolveStartupProjectFallbackId: () => 'project-2',
    });

    controller.syncStateFromRoute();

    expect(switchActiveProject).toHaveBeenCalledWith('project-2');
    expect(navigateRootStartupToTextProject).toHaveBeenCalledWith('project-2');
  });

  it('switches to an accessible deep-link project after projects hydrate', () => {
    const { controller, navigate, switchActiveProject } = createController({
      route: () => routeWithDeepestProject('project-1'),
      activeProjectId: () => 'project-1',
    });

    controller.syncStateFromRoute();

    expect(switchActiveProject).toHaveBeenCalledWith('project-1');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('reads projectId from an ancestor route when the deepest child only has task params', () => {
    const { controller, navigate, navigateRootStartupToTextProject, switchActiveProject } = createController({
      route: () => routeWithAncestorProject('project-1'),
      activeProjectId: () => 'project-1',
    });

    controller.syncStateFromRoute();

    expect(switchActiveProject).toHaveBeenCalledWith('project-1');
    expect(navigateRootStartupToTextProject).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('keeps partial startup catalogs from rejecting a missing deep-link project early', () => {
    const { controller, navigate, switchActiveProject } = createController({
      route: () => routeWithDeepestProject('project-9'),
      canAuthoritativelyRejectProjectRoute: () => false,
      isProjectAuthoritativelyAccessible: () => false,
    });

    controller.syncStateFromRoute();

    expect(switchActiveProject).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('redirects to the project list after authoritative rejection of a missing project', () => {
    const { controller, navigate, switchActiveProject } = createController({
      route: () => routeWithDeepestProject('project-9'),
      canAuthoritativelyRejectProjectRoute: () => true,
      isProjectAuthoritativelyAccessible: () => false,
    });

    controller.syncStateFromRoute();

    expect(switchActiveProject).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(['/projects']);
  });

  it('isolates rejected missing-project redirects', async () => {
    const navigationError = new Error('missing project redirect failed');
    const { controller, navigate, switchActiveProject, warn } = createController({
      route: () => routeWithDeepestProject('project-9'),
      canAuthoritativelyRejectProjectRoute: () => true,
      isProjectAuthoritativelyAccessible: () => false,
    });
    navigate.mockRejectedValue(navigationError);

    controller.syncStateFromRoute();
    await flushNavigationSettlement();

    expect(switchActiveProject).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(['/projects']);
    expect(warn).toHaveBeenCalledWith(
      'Workspace route sync navigation failed',
      navigationError,
    );
  });

  it('warns when missing-project redirect navigation is not confirmed', async () => {
    const { controller, navigate, switchActiveProject, warn } = createController({
      route: () => routeWithDeepestProject('project-9'),
      canAuthoritativelyRejectProjectRoute: () => true,
      isProjectAuthoritativelyAccessible: () => false,
    });
    navigate.mockResolvedValue(false);

    controller.syncStateFromRoute();
    await flushNavigationSettlement();

    expect(switchActiveProject).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(['/projects']);
    expect(warn).toHaveBeenCalledWith(
      'Workspace route sync navigation was not confirmed',
      {
        commands: ['/projects'],
        options: undefined,
        result: false,
      },
    );
  });

  it('does not accept a local ghost project when authoritative access rejects it', () => {
    const { controller, navigate, switchActiveProject } = createController({
      route: () => routeWithDeepestProject('project-9'),
      projects: () => [{ id: 'project-9' }],
      canAuthoritativelyRejectProjectRoute: () => true,
      isProjectAuthoritativelyAccessible: () => false,
    });

    controller.syncStateFromRoute();

    expect(switchActiveProject).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(['/projects']);
  });

  it('updates the project URL while preserving query parameters', () => {
    const { controller, navigate } = createController();

    controller.updateUrlForProject('project-1');

    expect(navigate).toHaveBeenCalledWith(['/projects', 'project-1'], {
      replaceUrl: true,
      queryParamsHandling: 'preserve',
    });
  });

  it('isolates rejected project URL updates', async () => {
    const navigationError = new Error('project URL update failed');
    const { controller, navigate, warn } = createController();
    navigate.mockRejectedValue(navigationError);

    controller.updateUrlForProject('project-1');
    await flushNavigationSettlement();

    expect(navigate).toHaveBeenCalledWith(['/projects', 'project-1'], {
      replaceUrl: true,
      queryParamsHandling: 'preserve',
    });
    expect(warn).toHaveBeenCalledWith(
      'Workspace route sync navigation failed',
      navigationError,
    );
  });

  it('warns when project URL update navigation is not confirmed', async () => {
    const { controller, navigate, warn } = createController();
    navigate.mockResolvedValue(false);

    controller.updateUrlForProject('project-1');
    await flushNavigationSettlement();

    expect(navigate).toHaveBeenCalledWith(['/projects', 'project-1'], {
      replaceUrl: true,
      queryParamsHandling: 'preserve',
    });
    expect(warn).toHaveBeenCalledWith(
      'Workspace route sync navigation was not confirmed',
      {
        commands: ['/projects', 'project-1'],
        options: {
          replaceUrl: true,
          queryParamsHandling: 'preserve',
        },
        result: false,
      },
    );
  });

  it('runs initial route sync and syncs again on navigation end events', () => {
    const routeListenerRef: { current?: (event: unknown) => void } = {};
    const unsubscribe = vi.fn();
    const { controller, navigateRootStartupToTextProject } = createController({
      activeProjectId: () => 'project-1',
      subscribeToRouteEvents: (listener) => {
        routeListenerRef.current = listener;
        return { unsubscribe };
      },
      isNavigationEnd: (event) => event === 'navigation-end',
    });

    controller.setupRouteSync();
    routeListenerRef.current?.('ignored');
    routeListenerRef.current?.('navigation-end');

    expect(navigateRootStartupToTextProject).toHaveBeenCalledTimes(2);
    expect(unsubscribe).not.toHaveBeenCalled();
  });

  it('processes synchronously emitted navigation events before the initial route sync', () => {
    const record: string[] = [];
    const { controller } = createController({
      activeProjectId: () => 'project-1',
      navigateRootStartupToTextProject: () => {
        record.push('route-sync');
      },
      subscribeToRouteEvents: (listener) => {
        record.push('subscribe');
        listener('navigation-end');
        record.push('subscribed');
        return { unsubscribe: vi.fn() };
      },
      isNavigationEnd: () => true,
    });

    controller.setupRouteSync();

    expect(record).toEqual([
      'subscribe',
      'route-sync',
      'subscribed',
      'route-sync',
    ]);
  });

  it('continues initial route sync when route event subscription setup fails', () => {
    const subscriptionError = new Error('route subscription setup failed');
    const { controller, navigateRootStartupToTextProject, warn } = createController({
      activeProjectId: () => 'project-1',
      subscribeToRouteEvents: () => {
        throw subscriptionError;
      },
      isNavigationEnd: () => true,
    });

    expect(() => controller.setupRouteSync()).not.toThrow();

    expect(navigateRootStartupToTextProject).toHaveBeenCalledWith('project-1');
    expect(warn).toHaveBeenCalledWith(
      'Workspace route sync subscription setup failed',
      subscriptionError,
    );
  });

  it('isolates initial route sync failures during setup', () => {
    const syncError = new Error('initial route sync failed');
    const { controller, navigateRootStartupToTextProject, warn } = createController({
      activeProjectId: () => 'project-1',
      route: () => routeWithoutProject(),
      subscribeToRouteEvents: () => ({ unsubscribe: vi.fn() }),
      navigateRootStartupToTextProject: () => {
        throw syncError;
      },
    });

    expect(() => controller.setupRouteSync()).not.toThrow();

    expect(warn).toHaveBeenCalledWith(
      'Workspace route sync initial sync failed',
      syncError,
    );
  });

  it('keeps setup settled when warning about an initial route sync failure throws', () => {
    const syncError = new Error('initial route sync failed');
    const warnError = new Error('route sync warning failed');
    const { controller, warn } = createController({
      activeProjectId: () => 'project-1',
      route: () => routeWithoutProject(),
      navigateRootStartupToTextProject: () => {
        throw syncError;
      },
    });
    warn.mockImplementationOnce(() => {
      throw warnError;
    });

    expect(() => controller.setupRouteSync()).not.toThrow();

    expect(warn).toHaveBeenCalledWith(
      'Workspace route sync initial sync failed',
      syncError,
    );
  });

});
