import { NavigationEnd, type ActivatedRoute, type Router } from '@angular/router';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Subject } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellRouteSyncDelegate,
  createWorkspaceShellRouteSyncOptions,
} from './workspace-shell-route-sync.factory';
import {
  createWorkspaceShellRouteSyncController,
} from './workspace-shell-route-sync-controller.factory';
import * as routeSyncControllerFactory from './workspace-shell-route-sync-controller.factory';
import {
  readWorkspaceShellControllerGraphCallOptions,
  readWorkspaceShellControllerGraphSource,
  readWorkspaceShellInteractionSurfacesCallOptions,
  readWorkspaceShellLifecycleGraphCallOptions,
  readWorkspaceShellSessionRoutingSurfaceCallOptions,
  readWorkspaceShellSessionRoutingSurfaceSource,
  readWorkspaceShellSource,
} from './workspace-shell-source.spec-helpers';

function createRoute(projectId: string | null): ActivatedRoute {
  return {
    snapshot: { params: {} },
    firstChild: {
      snapshot: {
        params: projectId ? { projectId } : {},
      },
      firstChild: null,
    },
  } as unknown as ActivatedRoute;
}

function createRouter() {
  const events = new Subject<unknown>();
  const navigate = vi.fn().mockResolvedValue(true);

  return {
    events,
    navigate,
    router: {
      events: events.asObservable(),
      navigate,
    } as unknown as Router,
  };
}

function createLazyRouteSyncFixture() {
  const router = createRouter().router;
  const switchActiveProject = vi.fn();
  const resolveStartupProjectFallbackId = vi.fn(() => 'project-1');
  const warn = vi.fn();
  const options = {
    route: () => createRoute('project-1'),
    router: () => router,
    projectState: {
      projects: () => [{ id: 'project-1' }],
      activeProjectId: () => 'project-1',
    },
    userSession: {
      canAuthoritativelyRejectProjectRoute: () => true,
      isProjectAuthoritativelyAccessible: () => true,
      switchActiveProject,
    },
    startupEntryControllers: () => ({
      mobileRootStartupNavigation: {
        resolveStartupProjectFallbackId,
        navigateRootStartupToTextProject: vi.fn(),
      },
    }),
    warn,
  };
  return { options, resolveStartupProjectFallbackId, router, switchActiveProject, warn };
}

function createLazyDelegateHarness(
  controllerOverrides: Partial<ReturnType<typeof createWorkspaceShellRouteSyncController>> = {},
  deferFactory = false,
) {
  const routeSyncController = {
    cleanup: vi.fn(),
    setupRouteSync: vi.fn(),
    syncStateFromRoute: vi.fn(),
    updateUrlForProject: vi.fn(),
    ...controllerOverrides,
  };
  let resolveFactory!: () => void;
  let rejectFactory!: (error: unknown) => void;
  const factoryResult = deferFactory
    ? new Promise<typeof routeSyncController>((resolve, reject) => {
      resolveFactory = () => resolve(routeSyncController);
      rejectFactory = reject;
    })
    : routeSyncController;
  const createRouteSyncController = vi
    .spyOn(routeSyncControllerFactory, 'createWorkspaceShellRouteSyncController')
    .mockImplementation(() => factoryResult as unknown as
      ReturnType<typeof createWorkspaceShellRouteSyncController>);
  const { options, warn } = createLazyRouteSyncFixture();
  const controller = createWorkspaceShellRouteSyncDelegate(options);
  return {
    controller,
    createRouteSyncController,
    rejectFactory,
    resolveFactory,
    routeSyncController,
    warn,
  };
}

async function settleLazyRouteSync(): Promise<void> {
  await vi.dynamicImportSettled();
}

afterEach(() => vi.restoreAllMocks());

function createController() {
  let route = createRoute('project-1');
  let projects: readonly { id: string }[] = [{ id: 'project-1' }];
  const router = createRouter();
  const switchActiveProject = vi.fn();
  const navigateRootStartupToTextProject = vi.fn();
  const warn = vi.fn();
  const userSession = {
    canAuthoritativelyRejectProjectRoute: () => true,
    isProjectAuthoritativelyAccessible: (projectId: string) => projectId === 'project-1',
    switchActiveProject,
  };
  const controller = createWorkspaceShellRouteSyncController({
    route: () => route,
    router: () => router.router,
    projects: () => projects,
    activeProjectId: () => null,
    userSession,
    resolveStartupProjectFallbackId: items => items[0]?.id ?? null,
    navigateRootStartupToTextProject,
    warn,
  });

  return {
    controller,
    router,
    setProjects: (value: readonly { id: string }[]) => {
      projects = value;
    },
    setRouteProjectId: (projectId: string | null) => {
      route = createRoute(projectId);
    },
    switchActiveProject,
    navigateRootStartupToTextProject,
    warn,
  };
}

describe('createWorkspaceShellRouteSyncController', () => {
  it('keeps the concrete route sync controller out of the eager route sync delegate factory', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-route-sync.factory.ts'),
      'utf8',
    );

    expect(source).toContain("from './workspace-shell-route-sync-lazy-delegate.controller'");
    expect(source).toContain('new WorkspaceShellRouteSyncLazyDelegateController(');
    expect(source).not.toContain('WorkspaceShellLazyDelegateCallHostController');
    expect(source).not.toContain('createWorkspaceShellRouteSyncControllerLoader');
    expect(source).not.toContain('function createWorkspaceShellRouteSyncLazyDelegate');
    expect(source).not.toMatch(
      /import\s+(?!type\s)[\s\S]*from\s+['"]@angular\/router['"]/,
    );
    expect(source).not.toContain('NavigationEnd');
    expect(source).not.toMatch(
      /import\s+(?!type\s)\{[^;]*WorkspaceShellRouteSyncController[^;]*\}\s+from\s+['"]\.\/workspace-shell-route-sync\.controller['"]/,
    );
    expect(source).not.toContain("import('./workspace-shell-route-sync-controller.factory')");
  });

  it('builds route sync options from shell dependencies without component method bridges', () => {
    const routeValue = createRoute('project-1');
    const routerValue = createRouter().router;
    const route = vi.fn(() => routeValue);
    const router = vi.fn(() => routerValue);
    const projectState = {
      projects: vi.fn(() => [{ id: 'project-1' }]),
      activeProjectId: vi.fn(() => 'project-1'),
    };
    const userSession = {
      canAuthoritativelyRejectProjectRoute: vi.fn(() => true),
      isProjectAuthoritativelyAccessible: vi.fn(() => true),
      switchActiveProject: vi.fn(),
    };
    const mobileRootStartupNavigation = {
      resolveStartupProjectFallbackId: vi.fn(() => 'project-1'),
      navigateRootStartupToTextProject: vi.fn(),
    };
    const startupEntryControllers = { mobileRootStartupNavigation };
    const warn = vi.fn();

    const options = createWorkspaceShellRouteSyncOptions({
      route,
      router,
      projectState,
      userSession,
      startupEntryControllers: () => startupEntryControllers,
      warn,
    });

    expect(options.route()).toBe(routeValue);
    expect(options.router()).toBe(routerValue);
    expect(options.projects()).toEqual([{ id: 'project-1' }]);
    expect(options.activeProjectId()).toBe('project-1');
    expect(options.userSession).toBe(userSession);
    expect(options.resolveStartupProjectFallbackId([{ id: 'fallback' }]))
      .toBe('project-1');
    options.navigateRootStartupToTextProject('project-1');

    expect(projectState.projects).toHaveBeenCalledOnce();
    expect(projectState.activeProjectId).toHaveBeenCalledOnce();
    expect(mobileRootStartupNavigation.resolveStartupProjectFallbackId)
      .toHaveBeenCalledWith([{ id: 'fallback' }]);
    expect(mobileRootStartupNavigation.navigateRootStartupToTextProject)
      .toHaveBeenCalledWith('project-1');
    expect(options.warn).toBe(warn);
  });

  it('creates the route sync delegate lazily from shell dependencies', async () => {
    const fixture = createLazyRouteSyncFixture();
    const controller = createWorkspaceShellRouteSyncDelegate(fixture.options);

    controller.updateUrlForProject('project-1');
    await vi.dynamicImportSettled();
    await Promise.resolve();
    expect(fixture.router.navigate).toHaveBeenCalledWith(
      ['/projects', 'project-1'],
      { replaceUrl: true, queryParamsHandling: 'preserve' },
    );

    controller.setupRouteSync();
    await vi.dynamicImportSettled();
    await Promise.resolve();
    expect(fixture.switchActiveProject).toHaveBeenCalledWith('project-1');
    expect(fixture.resolveStartupProjectFallbackId)
      .not.toHaveBeenCalled();
  });

  it('classifies loaded route sync delegate operation failures separately from lazy-load failures', async () => {
    const loadError = new Error('route sync load failed');
    const operationError = new Error('route sync setup failed');
    const harness = createLazyDelegateHarness({
      setupRouteSync: vi.fn(() => {
        throw operationError;
      }),
    });
    harness.createRouteSyncController.mockRejectedValueOnce(loadError);
    harness.controller.setupRouteSync();
    await settleLazyRouteSync();
    harness.controller.setupRouteSync();
    await settleLazyRouteSync();
    expect(harness.createRouteSyncController).toHaveBeenCalledTimes(2);
    expect(harness.routeSyncController.setupRouteSync).toHaveBeenCalledTimes(1);
    expect(harness.warn.mock.calls).toEqual([
      ['Workspace route sync controller 懒加载失败，已跳过本次路由同步', loadError],
      ['Workspace route sync controller 操作执行失败，已跳过本次路由同步', operationError],
    ]);
    harness.controller.updateUrlForProject('project-1');
    await settleLazyRouteSync();
    expect(harness.createRouteSyncController).toHaveBeenCalledTimes(2);
    expect(harness.routeSyncController.updateUrlForProject).toHaveBeenCalledWith('project-1');
  });

  it('retires queued route sync work when cleanup wins before lazy resolution', async () => {
    const harness = createLazyDelegateHarness({}, true);
    harness.controller.setupRouteSync();
    harness.controller.syncStateFromRoute();
    harness.controller.updateUrlForProject('project-1');
    await settleLazyRouteSync();
    harness.controller.cleanup();
    harness.controller.cleanup();
    harness.resolveFactory();
    await settleLazyRouteSync();
    expect(harness.routeSyncController.cleanup).toHaveBeenCalledOnce();
    expect(harness.routeSyncController.setupRouteSync).not.toHaveBeenCalled();
    expect(harness.routeSyncController.syncStateFromRoute).not.toHaveBeenCalled();
    expect(harness.routeSyncController.updateUrlForProject).not.toHaveBeenCalled();
  });

  it('suppresses every route sync operation after cleanup without starting a load', async () => {
    const harness = createLazyDelegateHarness();
    harness.controller.cleanup();
    harness.controller.setupRouteSync();
    harness.controller.syncStateFromRoute();
    harness.controller.updateUrlForProject('project-1');
    await settleLazyRouteSync();
    expect(harness.createRouteSyncController).not.toHaveBeenCalled();
    expect(harness.routeSyncController.cleanup).not.toHaveBeenCalled();
  });

  it('cleans a loaded route sync controller once and suppresses later operations', async () => {
    const harness = createLazyDelegateHarness();
    harness.controller.setupRouteSync();
    await settleLazyRouteSync();
    harness.controller.cleanup();
    harness.controller.cleanup();
    harness.controller.syncStateFromRoute();
    harness.controller.updateUrlForProject('project-2');
    await settleLazyRouteSync();
    expect(harness.routeSyncController.setupRouteSync).toHaveBeenCalledOnce();
    expect(harness.routeSyncController.cleanup).toHaveBeenCalledOnce();
    expect(harness.routeSyncController.syncStateFromRoute).not.toHaveBeenCalled();
    expect(harness.routeSyncController.updateUrlForProject).not.toHaveBeenCalled();
  });

  it('classifies a late lazy rejection after cleanup only as a cleanup warning', async () => {
    const loadError = new Error('late route sync load failed');
    const harness = createLazyDelegateHarness({}, true);
    harness.controller.setupRouteSync();
    await settleLazyRouteSync();
    harness.controller.cleanup();
    harness.rejectFactory(loadError);
    await settleLazyRouteSync();
    expect(harness.warn).toHaveBeenCalledOnce();
    expect(harness.warn).toHaveBeenCalledWith(
      'Workspace route sync controller 清理失败，已跳过',
      loadError,
    );
  });

  it('reports a loaded route sync cleanup failure exactly once', async () => {
    const cleanupError = new Error('route sync cleanup failed');
    const harness = createLazyDelegateHarness({
      cleanup: vi.fn(() => {
        throw cleanupError;
      }),
    });
    harness.controller.setupRouteSync();
    await settleLazyRouteSync();
    harness.controller.cleanup();
    harness.controller.cleanup();
    expect(harness.warn).toHaveBeenCalledOnce();
    expect(harness.warn).toHaveBeenCalledWith(
      'Workspace route sync controller 清理失败，已跳过',
      cleanupError,
    );
  });

  it('keeps user session route guards grouped at the routing surface boundary', () => {
    const routeSyncBlock = readWorkspaceShellSessionRoutingSurfaceCallOptions(
      'createWorkspaceShellRoutingSurface',
    );

    expect(routeSyncBlock).toContain('...options');
    expect(routeSyncBlock).not.toContain('createWorkspaceShellRouteSyncOptions({');
    expect(routeSyncBlock).not.toContain('createWorkspaceShellRouteSyncController(');
    expect(routeSyncBlock).not.toContain('canAuthoritativelyRejectProjectRoute: () =>');
    expect(routeSyncBlock).not.toContain('isProjectAuthoritativelyAccessible: (projectId) =>');
    expect(routeSyncBlock).not.toContain('switchActiveProject: (projectId) =>');
    expect(routeSyncBlock).not.toContain('resolveStartupProjectFallbackId: (projects) =>');
    expect(routeSyncBlock).not.toContain('navigateRootStartupToTextProject: (projectId) =>');
    expect(routeSyncBlock).not.toContain('mobileRootStartupNavigation');
  });

  it('keeps route signal and route sync wiring behind a routing surface', () => {
    const componentSource = readWorkspaceShellSource();
    const graphSource = readWorkspaceShellControllerGraphSource();
    const sessionRoutingSource = readWorkspaceShellSessionRoutingSurfaceSource();
    const sessionRoutingBlock = readWorkspaceShellControllerGraphCallOptions(
      'createWorkspaceShellSessionRoutingSurface',
    );
    const interactionBlock = readWorkspaceShellInteractionSurfacesCallOptions(
      'createWorkspaceShellInteractionBoundarySurface',
    );
    const lifecycleGraphBlock = readWorkspaceShellControllerGraphCallOptions(
      'createWorkspaceShellLifecycleGraph',
    );
    const lifecycleBlock = readWorkspaceShellLifecycleGraphCallOptions(
      'createWorkspaceShellSessionLifecycleSurface',
    );

    expect(graphSource).toContain('createWorkspaceShellSessionRoutingSurface({');
    expect(sessionRoutingSource).toContain('createWorkspaceShellRoutingSurface({');
    expect(componentSource).not.toContain('createWorkspaceShellRouteUrlSignal({');
    expect(componentSource).not.toContain('createWorkspaceShellRouteSyncDelegate({');
    expect(componentSource).not.toContain('private readonly route = inject(ActivatedRoute);');
    expect(componentSource).not.toContain('private readonly router = inject(Router);');
    expect(componentSource).not.toContain('inject(ActivatedRoute)');
    expect(componentSource).not.toContain('inject(Router)');
    expect(sessionRoutingBlock).toContain(
      'startupEntryControllers: startupEntryRegistry.startupEntryControllers',
    );
    expect(graphSource).toContain('...sessionRouting');
    expect(interactionBlock).not.toContain('router: this.routing.router');
    expect(interactionBlock).not.toContain('routeUrl: this.routing.routeUrl');
    expect(lifecycleGraphBlock).toContain('...sessionRouting');
    expect(lifecycleBlock).toContain('...options');
    expect(lifecycleBlock).not.toContain(
      'routeSyncController: this.routing.routeSyncController',
    );
  });

  it('adapts Angular NavigationEnd events into route sync updates', () => {
    const { controller, router, setRouteProjectId, switchActiveProject } =
      createController();

    controller.setupRouteSync();
    expect(switchActiveProject).toHaveBeenCalledWith('project-1');

    setRouteProjectId('project-2');
    router.events.next({ type: 'not-navigation-end' });
    expect(switchActiveProject).not.toHaveBeenCalledWith('project-2');

    router.events.next(new NavigationEnd(1, '/projects/project-2', '/projects/project-2'));
    expect(router.navigate).toHaveBeenCalledWith(['/projects'], undefined);
  });

  it('forwards route sync navigation through the current Angular router', () => {
    const { controller, router } = createController();

    controller.updateUrlForProject('project-1');

    expect(router.navigate).toHaveBeenCalledWith(
      ['/projects', 'project-1'],
      { replaceUrl: true, queryParamsHandling: 'preserve' },
    );
  });

  it('unsubscribes from the Angular router stream during cleanup', () => {
    const { controller, router, setRouteProjectId, switchActiveProject } =
      createController();

    controller.setupRouteSync();
    controller.cleanup();
    setRouteProjectId('project-2');
    router.events.next(new NavigationEnd(2, '/projects/project-2', '/projects/project-2'));

    expect(switchActiveProject).not.toHaveBeenCalledWith('project-2');
  });
});
