import {
  WorkspaceShellAuthModalLazyActionHostController,
  type WorkspaceShellAuthModalLoginData,
  type WorkspaceShellAuthModalSignupData,
} from './workspace-shell-auth-modal-lazy-action-host.controller';
import {
  createWorkspaceShellAuthModalLazyLoadDelegateLoader,
} from './workspace-shell-auth-modal-lazy-load-delegate-loader.factory';
import type {
  WorkspaceShellAuthModalLazyLoadDelegate,
  WorkspaceShellAuthModalLazyLoadDelegateOptions,
} from './workspace-shell-auth-modal-lazy-load-delegate.factory';

const AUTH_MODAL_HOST_LOAD_FAILURE_MESSAGE =
  '认证模态框 lazy-load host 加载失败，认证表单暂不可用';
const AUTH_MODAL_HOST_OPERATION_FAILURE_MESSAGE =
  '认证模态框 lazy-load host 操作失败，已跳过';
const AUTH_MODAL_HOST_TEARDOWN_FAILURE_MESSAGE =
  '认证模态框 lazy-load host 清理失败，已跳过';

export class WorkspaceShellAuthModalLazyLoadDelegateController
implements WorkspaceShellAuthModalLazyLoadDelegate {
  private readonly host: WorkspaceShellAuthModalLazyActionHostController<
    WorkspaceShellAuthModalLazyLoadDelegate
  >;

  constructor(options: WorkspaceShellAuthModalLazyLoadDelegateOptions) {
    this.host = new WorkspaceShellAuthModalLazyActionHostController({
      createDelegate: createWorkspaceShellAuthModalLazyLoadDelegateLoader(options),
      loadFailureMessage: AUTH_MODAL_HOST_LOAD_FAILURE_MESSAGE,
      operationFailureMessage: AUTH_MODAL_HOST_OPERATION_FAILURE_MESSAGE,
      teardownFailureMessage: AUTH_MODAL_HOST_TEARDOWN_FAILURE_MESSAGE,
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
