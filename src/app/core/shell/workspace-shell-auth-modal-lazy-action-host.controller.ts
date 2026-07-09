import { WorkspaceShellLazyDelegateCallHostController } from './workspace-shell-lazy-delegate-call-host.controller';

export interface WorkspaceShellAuthModalLoginData {
  email: string;
  password: string;
}

export interface WorkspaceShellAuthModalSignupData {
  email: string;
  password: string;
  confirmPassword: string;
}

export interface WorkspaceShellAuthModalLazyActionDelegate {
  handleLoginFromModal(data: WorkspaceShellAuthModalLoginData): Promise<void>;
  handleSignupFromModal(data: WorkspaceShellAuthModalSignupData): Promise<void>;
  handleResetPasswordFromModal(email: string): Promise<void>;
  handleLocalModeFromModal(): Promise<void>;
  teardown?(): void;
}

export interface WorkspaceShellAuthModalLazyActionHostOptions<
  TDelegate extends WorkspaceShellAuthModalLazyActionDelegate,
> {
  createDelegate: () => Promise<TDelegate>;
  loadFailureMessage: string;
  operationFailureMessage: string;
  teardownFailureMessage: string;
  warn: (message: string, error: unknown) => void;
}

export class WorkspaceShellAuthModalLazyActionHostController<
  TDelegate extends WorkspaceShellAuthModalLazyActionDelegate =
    WorkspaceShellAuthModalLazyActionDelegate,
> {
  private readonly host: WorkspaceShellLazyDelegateCallHostController<TDelegate>;

  constructor(options: WorkspaceShellAuthModalLazyActionHostOptions<TDelegate>) {
    this.host = new WorkspaceShellLazyDelegateCallHostController({
      createDelegate: options.createDelegate,
      loadFailureMessage: options.loadFailureMessage,
      teardownFailureMessage: options.teardownFailureMessage,
      warn: options.warn,
    });
    this.loadFailureMessage = options.loadFailureMessage;
    this.operationFailureMessage = options.operationFailureMessage;
  }

  private readonly loadFailureMessage: string;
  private readonly operationFailureMessage: string;

  handleLoginFromModal(data: WorkspaceShellAuthModalLoginData): Promise<void | undefined> {
    return this.call(authModal => authModal.handleLoginFromModal(data));
  }

  handleSignupFromModal(data: WorkspaceShellAuthModalSignupData): Promise<void | undefined> {
    return this.call(authModal => authModal.handleSignupFromModal(data));
  }

  handleResetPasswordFromModal(email: string): Promise<void | undefined> {
    return this.call(authModal => authModal.handleResetPasswordFromModal(email));
  }

  handleLocalModeFromModal(): Promise<void | undefined> {
    return this.call(authModal => authModal.handleLocalModeFromModal());
  }

  teardown(): void {
    this.host.teardown();
  }

  private call(
    action: (authModal: TDelegate) => Promise<void>,
  ): Promise<void | undefined> {
    return this.host.call(
      action,
      undefined,
      this.operationFailureMessage,
      this.loadFailureMessage,
    );
  }
}
