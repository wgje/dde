import type { StartupEntryIntent } from '../../../utils/startup-entry-intent';
import type {
  WorkspaceShellStartupEntryIntentLazyLoadHostOptions,
} from './workspace-shell-startup-entry-intent-lazy-load-host.controller';
import {
  createWorkspaceShellStartupEntryIntentLazyLoadHostLoader,
} from './workspace-shell-startup-entry-intent-lazy-load-host-loader.factory';
import type {
  WorkspaceShellStartupEntryIntentControllerLike,
  WorkspaceShellStartupEntryIntentFactoryOptions,
} from './workspace-shell-startup-entry-intent.factory';
import { WorkspaceShellLazyDelegateCallHostController } from './workspace-shell-lazy-delegate-call-host.controller';

const STARTUP_ENTRY_INTENT_LAZY_LOAD_FAILURE_MESSAGE =
  'Startup entry intent lazy-load host 加载失败，已保留待处理动作';

export interface WorkspaceShellStartupEntryIntentLazyHostControllerOptions {
  clearDeferredStartupEntryIntent: () => void;
  currentStartupEntryIntent: () => StartupEntryIntent | null;
  options: WorkspaceShellStartupEntryIntentFactoryOptions;
}

export class WorkspaceShellStartupEntryIntentLazyHostController {
  private readonly host: WorkspaceShellLazyDelegateCallHostController<
    WorkspaceShellStartupEntryIntentControllerLike
  >;

  constructor(
    lazyOptions: WorkspaceShellStartupEntryIntentLazyHostControllerOptions,
  ) {
    const loadStartupEntryIntentHost =
      createWorkspaceShellStartupEntryIntentLazyLoadHostLoader({
        options: createStartupEntryIntentLazyHostOptions(lazyOptions),
      });

    this.host = new WorkspaceShellLazyDelegateCallHostController({
      createDelegate: loadStartupEntryIntentHost,
      loadFailureMessage: STARTUP_ENTRY_INTENT_LAZY_LOAD_FAILURE_MESSAGE,
      warn: lazyOptions.options.warn,
    });
  }

  get loadedDelegate(): WorkspaceShellStartupEntryIntentControllerLike | null {
    return this.host.loadedDelegate;
  }

  run(
    action: (delegate: WorkspaceShellStartupEntryIntentControllerLike) => void,
    failureMessage = STARTUP_ENTRY_INTENT_LAZY_LOAD_FAILURE_MESSAGE,
  ): void {
    this.host.run(action, failureMessage);
  }

  teardown(): void {
    this.host.teardown();
  }
}

function createStartupEntryIntentLazyHostOptions(
  lazyOptions: WorkspaceShellStartupEntryIntentLazyHostControllerOptions,
): WorkspaceShellStartupEntryIntentLazyLoadHostOptions {
  const {
    deferredStartupEntryIntent,
    persistDeferredStartupEntryIntent,
    ...hostOptions
  } = lazyOptions.options;

  void persistDeferredStartupEntryIntent;

  return {
    ...hostOptions,
    currentStartupEntryIntent: lazyOptions.currentStartupEntryIntent,
    deferredStartupEntryIntent,
    clearDeferredStartupEntryIntent: lazyOptions.clearDeferredStartupEntryIntent,
  };
}
