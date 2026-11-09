import type {
  WorkspaceShellAuthModalLazyLoadDelegate,
  WorkspaceShellAuthModalLazyLoadDelegateOptions,
} from './workspace-shell-auth-modal-lazy-load-delegate.factory';
import { WorkspaceShellLazyDelegateCallHostController } from './workspace-shell-lazy-delegate-call-host.controller';

const AUTH_MODAL_FACTORY_LOAD_FAILURE_MESSAGE =
  '认证模态框 factory lazy-load 加载失败，认证表单暂不可用';
const AUTH_MODAL_FACTORY_TEARDOWN_FAILURE_MESSAGE =
  '认证模态框 factory lazy-load 清理失败，已跳过';

export type WorkspaceShellAuthModalFactoryDelegate =
  WorkspaceShellAuthModalLazyLoadDelegate;

export interface WorkspaceShellAuthModalFactoryOptions
  extends WorkspaceShellAuthModalLazyLoadDelegateOptions {}

export class WorkspaceShellAuthModalFactoryLazyDelegateController
implements WorkspaceShellAuthModalFactoryDelegate {
  private readonly host: WorkspaceShellLazyDelegateCallHostController<
    WorkspaceShellAuthModalFactoryDelegate
  >;

  constructor(private readonly options: WorkspaceShellAuthModalFactoryOptions) {
    this.host = new WorkspaceShellLazyDelegateCallHostController({
      createDelegate: () => this.createDelegate(),
      loadFailureMessage: AUTH_MODAL_FACTORY_LOAD_FAILURE_MESSAGE,
      teardownFailureMessage: AUTH_MODAL_FACTORY_TEARDOWN_FAILURE_MESSAGE,
      warn: options.warn,
    });
  }

  handleLoginFromModal(data: { email: string; password: string }): Promise<void> {
    return this.call(delegate => delegate.handleLoginFromModal(data));
  }

  handleSignupFromModal(data: {
    email: string;
    password: string;
    confirmPassword: string;
  }): Promise<void> {
    return this.call(delegate => delegate.handleSignupFromModal(data));
  }

  handleResetPasswordFromModal(email: string): Promise<void> {
    return this.call(delegate => delegate.handleResetPasswordFromModal(email));
  }

  handleLocalModeFromModal(): Promise<void> {
    return this.call(delegate => delegate.handleLocalModeFromModal());
  }

  teardown(): void {
    this.host.teardown();
  }

  private call(
    action: (delegate: WorkspaceShellAuthModalFactoryDelegate) => Promise<void>,
  ): Promise<void> {
    return this.host.call(action, undefined)
      .then(() => undefined);
  }

  private createDelegate(): Promise<WorkspaceShellAuthModalFactoryDelegate> {
    return import('./workspace-shell-auth-modal-lazy-load-delegate.factory')
      .then(({ createWorkspaceShellAuthModalLazyLoadDelegate }) =>
        createWorkspaceShellAuthModalLazyLoadDelegate(this.options));
  }
}
