import type {
  WorkspaceShellSessionTransitionControllerLoaderOptions,
} from './workspace-shell-session-transition-controller-loader.factory';
import {
  WorkspaceShellSessionTransitionLazyHostController,
} from './workspace-shell-session-transition-lazy-host.controller';

export interface WorkspaceShellSessionTransitionControllerLike {
  setupSessionHandlers(): void;
  cleanup(): void;
}

export interface WorkspaceShellSessionTransitionLazyLoadControllerOptions
  extends WorkspaceShellSessionTransitionControllerLoaderOptions {}

export class WorkspaceShellSessionTransitionLazyLoadController {
  private readonly host: WorkspaceShellSessionTransitionLazyHostController;

  constructor(options: WorkspaceShellSessionTransitionLazyLoadControllerOptions) {
    this.host = new WorkspaceShellSessionTransitionLazyHostController(options);
  }

  setupSessionHandlers(): void {
    this.host.setupSessionHandlers();
  }

  cleanup(): void {
    this.host.teardown();
  }

}
