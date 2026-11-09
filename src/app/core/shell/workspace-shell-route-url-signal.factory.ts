import type { Injector, Signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, type Router } from '@angular/router';
import { filter, map, startWith } from 'rxjs/operators';

export interface WorkspaceShellRouteUrlSignalOptions {
  injector: Injector;
  router: Router;
}

export function createWorkspaceShellRouteUrlSignal(
  options: WorkspaceShellRouteUrlSignalOptions,
): Signal<string> {
  return toSignal(
    options.router.events.pipe(
      filter((event): event is NavigationEnd => event instanceof NavigationEnd),
      map((event) => event.urlAfterRedirects),
      startWith(options.router.url),
    ),
    {
      initialValue: options.router.url,
      injector: options.injector,
    },
  );
}
