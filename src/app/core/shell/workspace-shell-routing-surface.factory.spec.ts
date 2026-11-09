import { Injector } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, NavigationEnd, Router } from '@angular/router';
import { Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import { createWorkspaceShellRoutingSurface } from './workspace-shell-routing-surface.factory';

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

function createRouter(initialUrl = '/projects') {
  const events = new Subject<unknown>();
  const navigate = vi.fn().mockResolvedValue(true);

  return {
    events,
    navigate,
    router: {
      events: events.asObservable(),
      navigate,
      url: initialUrl,
    } as unknown as Router,
  };
}

describe('createWorkspaceShellRoutingSurface', () => {
  it('groups route URL and route sync delegates behind one shell surface', async () => {
    TestBed.configureTestingModule({});
    const injector = TestBed.inject(Injector);
    const router = createRouter('/projects');
    const mobileRootStartupNavigation = {
      resolveStartupProjectFallbackId: vi.fn(() => 'project-1'),
      navigateRootStartupToTextProject: vi.fn(),
    };
    const userSession = {
      canAuthoritativelyRejectProjectRoute: vi.fn(() => true),
      isProjectAuthoritativelyAccessible: vi.fn(() => true),
      switchActiveProject: vi.fn(),
    };

    const route = createRoute('project-1');
    const routeInjector = {
      get: vi.fn((token: unknown) => {
        if (token === ActivatedRoute) return route;
        if (token === Router) return router.router;
        return injector.get(token as never);
      }),
    } as unknown as Injector;

    const surface = createWorkspaceShellRoutingSurface({
      injector: routeInjector,
      projectState: {
        projects: vi.fn(() => [{ id: 'project-1' }]),
        activeProjectId: vi.fn(() => null),
      },
      userSession,
      startupEntryControllers: () => ({ mobileRootStartupNavigation }),
      warn: vi.fn(),
    });

    expect(surface.router).toBe(router.router);
    expect(routeInjector.get).toHaveBeenCalledWith(ActivatedRoute);
    expect(routeInjector.get).toHaveBeenCalledWith(Router);
    expect(surface.routeUrl()).toBe('/projects');

    router.events.next(
      new NavigationEnd(1, '/projects/project-1', '/projects/project-1'),
    );
    expect(surface.routeUrl()).toBe('/projects/project-1');

    surface.routeSyncController.updateUrlForProject('project-1');
    await vi.dynamicImportSettled();
    await Promise.resolve();

    expect(router.navigate).toHaveBeenCalledWith(
      ['/projects', 'project-1'],
      { replaceUrl: true, queryParamsHandling: 'preserve' },
    );
  });
});
