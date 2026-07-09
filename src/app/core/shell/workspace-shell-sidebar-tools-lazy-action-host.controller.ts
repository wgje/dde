import { WorkspaceShellLazyDelegateCallHostController } from './workspace-shell-lazy-delegate-call-host.controller';

export interface WorkspaceShellSidebarToolsLazyActionHostOptions<TDelegate> {
  createDelegate: () => Promise<TDelegate>;
  loadFailureMessage: string;
  operationFailureMessage: string;
  teardownFailureMessage: string;
  warn: (message: string, error: unknown) => void;
}

export class WorkspaceShellSidebarToolsLazyActionHostController<TDelegate> {
  private readonly host: WorkspaceShellLazyDelegateCallHostController<TDelegate>;
  private readonly loadFailureMessage: string;
  private readonly operationFailureMessage: string;

  constructor(options: WorkspaceShellSidebarToolsLazyActionHostOptions<TDelegate>) {
    this.host = new WorkspaceShellLazyDelegateCallHostController({
      createDelegate: options.createDelegate,
      loadFailureMessage: options.loadFailureMessage,
      teardownFailureMessage: options.teardownFailureMessage,
      warn: options.warn,
    });
    this.operationFailureMessage = options.operationFailureMessage;
    this.loadFailureMessage = options.loadFailureMessage;
  }

  run(action: (controller: TDelegate) => void): void {
    this.host.run(
      action,
      this.operationFailureMessage,
      this.loadFailureMessage,
    );
  }

  call<T>(
    action: (controller: TDelegate) => T | Promise<T>,
  ): Promise<T | undefined> {
    return this.host.call(
      action,
      undefined,
      this.operationFailureMessage,
      this.loadFailureMessage,
    );
  }

  teardown(): void {
    this.host.teardown();
  }
}
