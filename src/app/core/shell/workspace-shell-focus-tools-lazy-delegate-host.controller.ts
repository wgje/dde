import { WorkspaceShellFocusToolsLazyActionHostController } from './workspace-shell-focus-tools-lazy-action-host.controller';

export interface WorkspaceShellFocusToolsLazyDelegateHostControllerOptions<TDelegate> {
  createDelegate: () => Promise<TDelegate>;
  loadFailureMessage: string;
  warn: (message: string, error: unknown) => void;
}

export class WorkspaceShellFocusToolsLazyDelegateHostController<TDelegate> {
  private readonly host: WorkspaceShellFocusToolsLazyActionHostController<TDelegate>;

  constructor(
    options: WorkspaceShellFocusToolsLazyDelegateHostControllerOptions<TDelegate>,
  ) {
    this.host = new WorkspaceShellFocusToolsLazyActionHostController(options);
  }

  get loadedDelegate(): TDelegate | null {
    return this.host.loadedDelegate;
  }

  call<TResult>(
    action: (delegate: TDelegate) => TResult | Promise<TResult>,
    fallback: TResult,
    failureMessage?: string,
    loadFailureMessage = failureMessage,
  ): Promise<TResult> {
    return this.host.call(action, fallback, failureMessage, loadFailureMessage);
  }

  run(
    action: (delegate: TDelegate) => void,
    failureMessage?: string,
    loadFailureMessage = failureMessage,
  ): void {
    this.host.run(action, failureMessage, loadFailureMessage);
  }

  runIfLoaded(
    action: (delegate: TDelegate) => void,
    failureMessage?: string,
  ): void {
    this.host.runIfLoaded(action, failureMessage);
  }

  teardown(): void {
    this.host.teardown();
  }
}
