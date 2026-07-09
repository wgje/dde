import {
  WorkspaceShellStartupEntryIntentLazyHostController,
  type WorkspaceShellStartupEntryIntentLazyHostControllerOptions,
} from './workspace-shell-startup-entry-intent-lazy-host.controller';
import type {
  WorkspaceShellStartupEntryIntentControllerLike,
} from './workspace-shell-startup-entry-intent.factory';

export type WorkspaceShellStartupEntryIntentLazyDelegateControllerOptions =
  WorkspaceShellStartupEntryIntentLazyHostControllerOptions;

export class WorkspaceShellStartupEntryIntentLazyDelegateController {
  private readonly host: WorkspaceShellStartupEntryIntentLazyHostController;

  constructor(
    lazyOptions: WorkspaceShellStartupEntryIntentLazyDelegateControllerOptions,
  ) {
    this.host = new WorkspaceShellStartupEntryIntentLazyHostController(lazyOptions);
  }

  get loadedDelegate(): WorkspaceShellStartupEntryIntentControllerLike | null {
    return this.host.loadedDelegate;
  }

  run(
    action: (delegate: WorkspaceShellStartupEntryIntentControllerLike) => void,
    failureMessage?: string,
  ): void {
    this.host.run(action, failureMessage);
  }

  teardown(): void {
    this.host.teardown();
  }
}
