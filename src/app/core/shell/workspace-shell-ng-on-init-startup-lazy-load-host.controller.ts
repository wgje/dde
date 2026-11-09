import {
  type WorkspaceShellNgOnInitStartupControllerLoaderOptions,
} from './workspace-shell-ng-on-init-startup-controller-loader.factory';
import {
  WorkspaceShellNgOnInitStartupLazyHostController,
} from './workspace-shell-ng-on-init-startup-lazy-host.controller';

export interface WorkspaceShellNgOnInitStartupHostDelegate {
  initialize(): void;
  teardown(): void;
}

export interface WorkspaceShellNgOnInitStartupLazyLoadHostOptions
  extends WorkspaceShellNgOnInitStartupControllerLoaderOptions {
  warn: (message: string, error: unknown) => void;
}

export class WorkspaceShellNgOnInitStartupLazyLoadHostController {
  private readonly host: WorkspaceShellNgOnInitStartupLazyHostController;

  constructor(options: WorkspaceShellNgOnInitStartupLazyLoadHostOptions) {
    this.host = new WorkspaceShellNgOnInitStartupLazyHostController(options);
  }

  initialize(): void {
    this.host.initialize();
  }

  teardown(): void {
    this.host.teardown();
  }
}
