import {
  WorkspaceShellAuthModalLazyActionHostController,
  type WorkspaceShellAuthModalLoginData,
  type WorkspaceShellAuthModalSignupData,
} from './workspace-shell-auth-modal-lazy-action-host.controller';
import {
  createWorkspaceShellAuthModalControllerLoader,
} from './workspace-shell-auth-modal-controller-loader.factory';
import type {
  WorkspaceShellAuthModalControllerLike,
  WorkspaceShellAuthModalLazyLoadControllerOptions,
} from './workspace-shell-auth-modal-lazy-load.controller';

export type {
  WorkspaceShellAuthModalLoginData,
  WorkspaceShellAuthModalSignupData,
} from './workspace-shell-auth-modal-lazy-action-host.controller';

const AUTH_MODAL_CONTROLLER_LOAD_FAILURE_MESSAGE =
  '认证模态框控制器懒加载失败，认证表单暂不可用';
const AUTH_MODAL_CONTROLLER_OPERATION_FAILURE_MESSAGE =
  '认证模态框控制器操作失败，已跳过';
const AUTH_MODAL_CONTROLLER_TEARDOWN_FAILURE_MESSAGE =
  '认证模态框控制器清理失败，已跳过';

export interface WorkspaceShellAuthModalLazyHostControllerOptions
  extends WorkspaceShellAuthModalLazyLoadControllerOptions {}

export class WorkspaceShellAuthModalLazyHostController {
  private readonly host: WorkspaceShellAuthModalLazyActionHostController<
    WorkspaceShellAuthModalControllerLike
  >;

  constructor(options: WorkspaceShellAuthModalLazyHostControllerOptions) {
    this.host = new WorkspaceShellAuthModalLazyActionHostController({
      createDelegate: createWorkspaceShellAuthModalControllerLoader(options),
      loadFailureMessage: AUTH_MODAL_CONTROLLER_LOAD_FAILURE_MESSAGE,
      operationFailureMessage: AUTH_MODAL_CONTROLLER_OPERATION_FAILURE_MESSAGE,
      teardownFailureMessage: AUTH_MODAL_CONTROLLER_TEARDOWN_FAILURE_MESSAGE,
      warn: options.warn,
    });
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
