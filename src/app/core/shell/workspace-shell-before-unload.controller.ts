const WORKSPACE_SHELL_BEFORE_UNLOAD_CALLBACK_ID = 'app-core-save';
const WORKSPACE_SHELL_BEFORE_UNLOAD_PRIORITY = 1;

type WorkspaceShellBeforeUnloadFlushStep =
  | 'pending-persist'
  | 'pending-action'
  | 'retry-queue'
  | 'action-queue'
  | 'dead-letter';

interface WorkspaceShellBeforeUnloadManager {
  initialize: () => void;
  register: (id: string, callback: () => boolean, priority: number) => void;
  unregister: (id: string) => void;
}

interface WorkspaceShellBeforeUnloadGuard {
  enable: () => void;
  disable: () => void;
}

export interface WorkspaceShellBeforeUnloadControllerOptions {
  isBrowser: () => boolean;
  beforeUnloadManager: WorkspaceShellBeforeUnloadManager;
  beforeUnloadGuard: WorkspaceShellBeforeUnloadGuard;
  flushPendingPersist: () => void;
  flushPendingAction: () => void;
  flushRetryQueueSync: () => void;
  saveQueueToStorage: () => void;
  saveDeadLetterToStorage: () => void;
  onFlushError?: (step: WorkspaceShellBeforeUnloadFlushStep, error: unknown) => void;
}

export class WorkspaceShellBeforeUnloadController {
  private isSetup = false;

  constructor(private readonly options: WorkspaceShellBeforeUnloadControllerOptions) {}

  setup(): void {
    if (this.isSetup || !this.options.isBrowser()) return;

    this.options.beforeUnloadManager.initialize();
    try {
      this.options.beforeUnloadGuard.enable();
      this.options.beforeUnloadManager.register(
        WORKSPACE_SHELL_BEFORE_UNLOAD_CALLBACK_ID,
        () => this.flushBeforeUnload(),
        WORKSPACE_SHELL_BEFORE_UNLOAD_PRIORITY,
      );
      this.isSetup = true;
    } catch (error) {
      this.rollbackSetupAfterFailure();
      throw error;
    }
  }

  cleanup(): void {
    if (!this.isSetup) return;

    this.isSetup = false;
    try {
      this.options.beforeUnloadManager.unregister(WORKSPACE_SHELL_BEFORE_UNLOAD_CALLBACK_ID);
    } catch {
      // Best-effort cleanup; guard disable must still run.
    }

    try {
      this.options.beforeUnloadGuard.disable();
    } catch {
      // Best-effort cleanup; the controller is already marked unregistered.
    }
  }

  private flushBeforeUnload(): boolean {
    this.runFlushStep('pending-persist', this.options.flushPendingPersist);
    this.runFlushStep('pending-action', this.options.flushPendingAction);
    this.runFlushStep('retry-queue', this.options.flushRetryQueueSync);
    this.runFlushStep('action-queue', this.options.saveQueueToStorage);
    this.runFlushStep('dead-letter', this.options.saveDeadLetterToStorage);
    return false;
  }

  private runFlushStep(step: WorkspaceShellBeforeUnloadFlushStep, flush: () => void): void {
    try {
      flush();
    } catch (error) {
      try {
        this.options.onFlushError?.(step, error);
      } catch {
        // Diagnostic sinks must not interrupt the remaining unload persistence steps.
      }
    }
  }

  private rollbackSetupAfterFailure(): void {
    try {
      this.options.beforeUnloadManager.unregister(WORKSPACE_SHELL_BEFORE_UNLOAD_CALLBACK_ID);
    } catch {
      // Best-effort rollback; preserve the original setup failure.
    }

    try {
      this.options.beforeUnloadGuard.disable();
    } catch {
      // Best-effort rollback; preserve the original setup failure.
    }
  }
}
