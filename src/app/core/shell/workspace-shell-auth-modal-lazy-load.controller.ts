import type { WorkspaceShellAuthModalControllerOptions } from './workspace-shell-auth-modal.controller';
import {
  type WorkspaceShellAuthModalLazyActionDelegate,
} from './workspace-shell-auth-modal-lazy-action-host.controller';
import {
  WorkspaceShellAuthModalLazyHostController,
  type WorkspaceShellAuthModalLoginData,
  type WorkspaceShellAuthModalSignupData,
} from './workspace-shell-auth-modal-lazy-host.controller';

export interface WorkspaceShellAuthModalControllerLike
  extends WorkspaceShellAuthModalLazyActionDelegate {}

export interface WorkspaceShellAuthModalLazyLoadControllerOptions
  extends WorkspaceShellAuthModalControllerOptions {
  warn: (message: string, error: unknown) => void;
  createAuthModalController?: () => Promise<WorkspaceShellAuthModalControllerLike>;
}

export class WorkspaceShellAuthModalLazyLoadController {
  private readonly host: WorkspaceShellAuthModalLazyHostController;

  constructor(options: WorkspaceShellAuthModalLazyLoadControllerOptions) {
    this.host = new WorkspaceShellAuthModalLazyHostController(options);
  }

  async handleLoginFromModal(data: WorkspaceShellAuthModalLoginData): Promise<void> {
    await this.host.handleLoginFromModal(data);
  }

  async handleSignupFromModal(data: WorkspaceShellAuthModalSignupData): Promise<void> {
    await this.host.handleSignupFromModal(data);
  }

  async handleResetPasswordFromModal(email: string): Promise<void> {
    await this.host.handleResetPasswordFromModal(email);
  }

  async handleLocalModeFromModal(): Promise<void> {
    await this.host.handleLocalModeFromModal();
  }

  teardown(): void {
    this.host.teardown();
  }
}
