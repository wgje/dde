import type { Injector } from '@angular/core';

import {
  createWorkspaceShellSwUpdateLifecycleServiceLoader,
} from './workspace-shell-sw-update-lifecycle-service-loader.factory';
import type {
  WorkspaceShellLazyLifecycleDelegate,
} from './workspace-shell-lazy-lifecycle-host.controller';
import {
  WorkspaceShellLazyLifecycleServiceController,
} from './workspace-shell-lazy-lifecycle-service.controller';

export interface WorkspaceShellSwUpdateLifecycleLike
  extends WorkspaceShellLazyLifecycleDelegate {}

export interface WorkspaceShellSwUpdateLifecycleControllerOptions {
  injector?: Injector;
  destroyed: () => boolean;
  warn: (message: string, error: unknown) => void;
  loadSwUpdateLifecycle?: () => Promise<WorkspaceShellSwUpdateLifecycleLike>;
}

export class WorkspaceShellSwUpdateLifecycleController {
  private readonly lifecycle: WorkspaceShellLazyLifecycleServiceController<
    WorkspaceShellSwUpdateLifecycleLike
  >;

  constructor(options: WorkspaceShellSwUpdateLifecycleControllerOptions) {
    this.lifecycle = new WorkspaceShellLazyLifecycleServiceController({
      destroyed: options.destroyed,
      initializeFailureMessage: 'Service Worker 更新生命周期懒加载失败，已跳过',
      loadService: createWorkspaceShellSwUpdateLifecycleServiceLoader({
        injector: options.injector,
        loadSwUpdateLifecycle: options.loadSwUpdateLifecycle,
      }),
      teardownFailureMessage: 'Service Worker 更新生命周期清理失败，已跳过',
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
