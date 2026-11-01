import type { DestroyRef, Injector } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd } from '@angular/router';
import type { Observable } from 'rxjs';
import { filter, startWith } from 'rxjs/operators';

import { LocalBackupService } from '../../../services/local-backup.service';

type ProjectsProvider = Parameters<LocalBackupService['setProjectsProvider']>[0];

export interface ProjectShellLifecycleControllerOptions {
  contentResize: {
    cleanup(): void;
  };
  destroyRef: DestroyRef;
  getProjects: ProjectsProvider;
  injector: Injector;
  routeController: {
    destroy(): void;
    handleRouteChange(): void;
  };
  routerEvents: Observable<unknown>;
  textViewSwipe: {
    destroy(): void;
  };
}

export class ProjectShellLifecycleController {
  constructor(private readonly options: ProjectShellLifecycleControllerOptions) {}

  initialize(): void {
    this.options.injector
      .get(LocalBackupService)
      .setProjectsProvider(this.options.getProjects);
    this.options.routerEvents.pipe(
      filter(event => event instanceof NavigationEnd),
      startWith(null),
      takeUntilDestroyed(this.options.destroyRef),
    ).subscribe(() => {
      this.options.routeController.handleRouteChange();
    });
  }

  destroy(): void {
    this.options.textViewSwipe.destroy();
    this.options.routeController.destroy();
    this.options.contentResize.cleanup();
  }
}
