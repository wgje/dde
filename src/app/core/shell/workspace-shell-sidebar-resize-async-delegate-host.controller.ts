import type {
  WorkspaceShellSidebarResizeAsyncDelegate,
} from './workspace-shell-sidebar-resize-async-delegate.controller';
import { WorkspaceShellLazyDelegateCallHostController } from './workspace-shell-lazy-delegate-call-host.controller';

export interface WorkspaceShellSidebarResizeAsyncDelegateHostControllerOptions {
  loadDelegate: () => Promise<WorkspaceShellSidebarResizeAsyncDelegate>;
  loadFailureMessage: string;
  teardownFailureMessage: string;
  warn: (message: string, error: unknown) => void;
}

export class WorkspaceShellSidebarResizeAsyncDelegateHostController {
  private readonly host: WorkspaceShellLazyDelegateCallHostController<
    WorkspaceShellSidebarResizeAsyncDelegate
  >;

  constructor(
    options: WorkspaceShellSidebarResizeAsyncDelegateHostControllerOptions,
  ) {
    this.host = new WorkspaceShellLazyDelegateCallHostController({
      createDelegate: options.loadDelegate,
      loadFailureMessage: options.loadFailureMessage,
      teardownFailureMessage: options.teardownFailureMessage,
      warn: options.warn,
    });
  }

  get loadedDelegate(): WorkspaceShellSidebarResizeAsyncDelegate | null {
    return this.host.loadedDelegate;
  }

  call<TResult>(
    action: (
      delegate: WorkspaceShellSidebarResizeAsyncDelegate
    ) => TResult | Promise<TResult>,
    fallback: TResult,
    failureMessage?: string,
    loadFailureMessage = failureMessage,
  ): Promise<TResult> {
    return this.host.call(action, fallback, failureMessage, loadFailureMessage);
  }

  teardown(): void {
    this.host.teardown();
  }
}
