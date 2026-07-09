import { Injector } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { NavigationEnd, type Router } from '@angular/router';
import { Subject } from 'rxjs';
import { describe, expect, it } from 'vitest';

import { createWorkspaceShellRouteUrlSignal } from './workspace-shell-route-url-signal.factory';

function createRouter(initialUrl = '/projects'): {
  events: Subject<unknown>;
  router: Router;
} {
  const events = new Subject<unknown>();

  return {
    events,
    router: {
      events: events.asObservable(),
      url: initialUrl,
    } as Router,
  };
}

describe('createWorkspaceShellRouteUrlSignal', () => {
  it('tracks the current router URL from NavigationEnd events', () => {
    TestBed.configureTestingModule({});
    const { events, router } = createRouter('/projects/start');
    const routeUrl = createWorkspaceShellRouteUrlSignal({
      injector: TestBed.inject(Injector),
      router,
    });

    expect(routeUrl()).toBe('/projects/start');

    events.next({ type: 'ignored' });
    expect(routeUrl()).toBe('/projects/start');

    events.next(new NavigationEnd(1, '/projects/old', '/projects/next?entry=widget'));
    expect(routeUrl()).toBe('/projects/next?entry=widget');
  });
});
