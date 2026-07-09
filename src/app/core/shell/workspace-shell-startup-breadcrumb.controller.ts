import type { Injector } from '@angular/core';

import {
  createWorkspaceShellStartupBreadcrumbServiceLoader,
} from './workspace-shell-startup-breadcrumb-service-loader.factory';
import type {
  WorkspaceShellLazyLifecycleDelegate,
} from './workspace-shell-lazy-lifecycle-host.controller';
import {
  WorkspaceShellLazyLifecycleServiceController,
} from './workspace-shell-lazy-lifecycle-service.controller';

export interface WorkspaceShellStartupBreadcrumbLike
  extends WorkspaceShellLazyLifecycleDelegate {}

export interface WorkspaceShellStartupBreadcrumbControllerOptions {
  injector?: Injector;
  destroyed: () => boolean;
  warn: (message: string, error: unknown) => void;
  loadStartupBreadcrumb?: () => Promise<WorkspaceShellStartupBreadcrumbLike>;
}

export class WorkspaceShellStartupBreadcrumbController {
  private readonly lifecycle: WorkspaceShellLazyLifecycleServiceController<
    WorkspaceShellStartupBreadcrumbLike
  >;

  constructor(options: WorkspaceShellStartupBreadcrumbControllerOptions) {
    this.lifecycle = new WorkspaceShellLazyLifecycleServiceController({
      destroyed: options.destroyed,
      initializeFailureMessage: '启动 breadcrumb 服务懒加载失败，已跳过',
      loadService: createWorkspaceShellStartupBreadcrumbServiceLoader({
        injector: options.injector,
        loadStartupBreadcrumb: options.loadStartupBreadcrumb,
      }),
      teardownFailureMessage: '启动 breadcrumb 服务清理失败，已跳过',
      warn: options.warn,
    });
  }

  initialize(): void {
    this.lifecycle.initialize();
  }

  teardown(): void {
    this.lifecycle.teardown();
  }
}
