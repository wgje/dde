type WorkspaceShellAuthCoordinatorLike = {
  retryBootstrap(): void;
  handleLogin(event?: Event, opts?: { closeSettings?: boolean }): Promise<void>;
  handleSignup(event?: Event): Promise<void>;
  handleResetPassword(event?: Event): Promise<void>;
  switchToSignup(): void;
  switchToLogin(): void;
  switchToResetPassword(): void;
  startRelogin(): void;
  handleMigrationComplete(): void;
  closeMigrationModal(): void;
};

type WorkspaceShellAuthModalLike = {
  handleLoginFromModal(data: { email: string; password: string }): Promise<void>;
  handleSignupFromModal(data: {
    email: string;
    password: string;
    confirmPassword: string;
  }): Promise<void>;
  handleResetPasswordFromModal(email: string): Promise<void>;
  handleLocalModeFromModal(): Promise<void>;
};

export interface WorkspaceShellAuthActionsControllerOptions {
  authCoord: WorkspaceShellAuthCoordinatorLike;
  authModal: WorkspaceShellAuthModalLike;
  signOutController: { signOut(): Promise<void> };
}

export class WorkspaceShellAuthActionsController<
  TOptions extends WorkspaceShellAuthActionsControllerOptions =
    WorkspaceShellAuthActionsControllerOptions,
> {
  constructor(protected readonly options: TOptions) {}

  retryBootstrap(): void {
    this.options.authCoord.retryBootstrap();
  }

  handleLogin(event?: Event, opts?: { closeSettings?: boolean }): Promise<void> {
    return this.options.authCoord.handleLogin(event, opts);
  }

  handleSignup(event?: Event): Promise<void> {
    return this.options.authCoord.handleSignup(event);
  }

  handleResetPassword(event?: Event): Promise<void> {
    return this.options.authCoord.handleResetPassword(event);
  }

  switchToSignup(): void {
    this.options.authCoord.switchToSignup();
  }

  switchToLogin(): void {
    this.options.authCoord.switchToLogin();
  }

  switchToResetPassword(): void {
    this.options.authCoord.switchToResetPassword();
  }

  signOut(): Promise<void> {
    return this.options.signOutController.signOut();
  }

  startRelogin(): void {
    this.options.authCoord.startRelogin();
  }

  handleLoginFromModal(data: { email: string; password: string }): Promise<void> {
    return this.options.authModal.handleLoginFromModal(data);
  }

  handleSignupFromModal(data: {
    email: string;
    password: string;
    confirmPassword: string;
  }): Promise<void> {
    return this.options.authModal.handleSignupFromModal(data);
  }

  handleResetPasswordFromModal(email: string): Promise<void> {
    return this.options.authModal.handleResetPasswordFromModal(email);
  }

  handleLocalModeFromModal(): Promise<void> {
    return this.options.authModal.handleLocalModeFromModal();
  }

  handleMigrationComplete(): void {
    this.options.authCoord.handleMigrationComplete();
  }

  closeMigrationModal(): void {
    this.options.authCoord.closeMigrationModal();
  }
}
