import {
  WorkspaceShellBeforeUnloadController,
  type WorkspaceShellBeforeUnloadControllerOptions,
} from './workspace-shell-before-unload.controller';

interface WorkspaceShellBeforeUnloadManagerLike {
  initialize(): void;
  register(id: string, callback: () => boolean, priority: number): void;
  unregister(id: string): void;
}

interface WorkspaceShellBeforeUnloadGuardLike {
  enable(): void;
  disable(): void;
}

export interface WorkspaceShellBeforeUnloadFactoryOptions {
  isBrowser?: () => boolean;
  beforeUnloadManager: WorkspaceShellBeforeUnloadManagerLike;
  beforeUnloadGuard: WorkspaceShellBeforeUnloadGuardLike;
  syncCoordinator: {
    flushPendingPersist(): void;
  };
  undoService: {
    flushPendingAction(): void;
  };
  simpleSync: () => {
    flushRetryQueueSync(): void;
  };
  actionQueue: {
    storage: {
      saveQueueToStorage(): void;
      saveDeadLetterToStorage(): void;
    };
  };
  onFlushError?: WorkspaceShellBeforeUnloadControllerOptions['onFlushError'];
}

export function createWorkspaceShellBeforeUnloadController(
  options: WorkspaceShellBeforeUnloadFactoryOptions,
): WorkspaceShellBeforeUnloadController {
  return new WorkspaceShellBeforeUnloadController({
    isBrowser: options.isBrowser ?? isBrowserRuntime,
    beforeUnloadManager: options.beforeUnloadManager,
    beforeUnloadGuard: options.beforeUnloadGuard,
    flushPendingPersist: () => options.syncCoordinator.flushPendingPersist(),
    flushPendingAction: () => options.undoService.flushPendingAction(),
    flushRetryQueueSync: () => options.simpleSync().flushRetryQueueSync(),
    saveQueueToStorage: () => options.actionQueue.storage.saveQueueToStorage(),
    saveDeadLetterToStorage: () =>
      options.actionQueue.storage.saveDeadLetterToStorage(),
    onFlushError: options.onFlushError,
  });
}

function isBrowserRuntime(): boolean {
  return typeof window !== 'undefined';
}
