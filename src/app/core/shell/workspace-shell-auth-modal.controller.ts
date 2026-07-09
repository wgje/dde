interface WorkspaceShellLoginModalRef {
  componentRef: {
    setInput: (name: string, value: unknown) => void;
  };
}

interface WorkspaceShellAuthModalAuthCoord {
  authError: () => string | null;
  resetPasswordSent: () => boolean;
  resolveSafePostAuthNavigationUrl: (returnUrl: string | null) => string | null;
  handleLoginFromModal: (data: { email: string; password: string }) => Promise<void>;
  handleSignupFromModal: (data: {
    email: string;
    password: string;
    confirmPassword: string;
  }) => Promise<void>;
  handleResetPasswordFromModal: (email: string) => Promise<void>;
  handleLocalModeFromModal: () => Promise<void>;
}

interface WorkspaceShellAuthModalCoord {
  loginReturnUrl: string | null;
  loginModalRef?: WorkspaceShellLoginModalRef | null;
  closeLoginModal: () => void;
}

export interface WorkspaceShellAuthModalControllerOptions {
  authCoord: WorkspaceShellAuthModalAuthCoord;
  modalCoord: WorkspaceShellAuthModalCoord;
  currentUserId: () => string | null;
  navigateByUrl: (url: string) => Promise<unknown> | unknown;
  warn: (message: string, error: unknown) => void;
}

export class WorkspaceShellAuthModalController {
  constructor(private readonly options: WorkspaceShellAuthModalControllerOptions) {}

  async handleLoginFromModal(data: { email: string; password: string }): Promise<void> {
    this.setLoginModalInput('isLoading', true);
    this.setLoginModalInput('authError', null);

    try {
      await this.options.authCoord.handleLoginFromModal(data);
    } catch (error) {
      this.completeAuthModalFailure(error);
      return;
    }

    if (!this.options.authCoord.authError()) {
      this.completeAuthModalSuccess();
      return;
    }

    this.setLoginModalInput('isLoading', false);
    this.setLoginModalInput('authError', this.options.authCoord.authError());
  }

  async handleSignupFromModal(data: {
    email: string;
    password: string;
    confirmPassword: string;
  }): Promise<void> {
    this.setLoginModalInput('isLoading', true);
    this.setLoginModalInput('authError', null);

    try {
      await this.options.authCoord.handleSignupFromModal(data);
    } catch (error) {
      this.completeAuthModalFailure(error);
      return;
    }

    if (!this.options.authCoord.authError() && this.options.currentUserId()) {
      this.completeAuthModalSuccess();
      return;
    }

    this.setLoginModalInput('isLoading', false);
    this.setLoginModalInput('authError', this.options.authCoord.authError());
  }

  async handleResetPasswordFromModal(email: string): Promise<void> {
    this.setLoginModalInput('isLoading', true);
    this.setLoginModalInput('authError', null);

    try {
      await this.options.authCoord.handleResetPasswordFromModal(email);
    } catch (error) {
      this.completeAuthModalFailure(error);
      this.setLoginModalInput('resetPasswordSent', this.options.authCoord.resetPasswordSent());
      return;
    }

    this.setLoginModalInput('isLoading', false);
    this.setLoginModalInput('authError', this.options.authCoord.authError());
    this.setLoginModalInput('resetPasswordSent', this.options.authCoord.resetPasswordSent());
  }

  async handleLocalModeFromModal(): Promise<void> {
    await this.options.authCoord.handleLocalModeFromModal();
    this.completeAuthModalSuccess('/projects');
  }

  private completeAuthModalSuccess(fallbackUrl: string | null = null): void {
    const postAuthTargetUrl = this.options.authCoord.resolveSafePostAuthNavigationUrl(
      this.options.modalCoord.loginReturnUrl,
    ) ?? fallbackUrl;

    try {
      this.options.modalCoord.closeLoginModal();
    } catch (error) {
      this.warn('认证成功后关闭登录弹窗失败，已继续后续导航', error);
    }

    if (postAuthTargetUrl) {
      try {
        void Promise.resolve(this.options.navigateByUrl(postAuthTargetUrl))
          .catch(error => {
            this.warn('认证成功后导航失败，已保留当前页面状态', error);
          });
      } catch (error) {
        this.warn('认证成功后导航失败，已保留当前页面状态', error);
      }
    }
  }

  private setLoginModalInput(name: string, value: unknown): void {
    this.options.modalCoord.loginModalRef?.componentRef.setInput(name, value);
  }

  private completeAuthModalFailure(error: unknown): void {
    this.setLoginModalInput('isLoading', false);
    this.setLoginModalInput('authError', this.resolveAuthModalError(error));
  }

  private resolveAuthModalError(error: unknown): string {
    const authError = this.options.authCoord.authError();
    if (authError) {
      return authError;
    }

    if (error instanceof Error && error.message) {
      return error.message;
    }

    return '认证请求失败，请稍后重试';
  }

  private warn(message: string, error: unknown): void {
    try {
      this.options.warn(message, error);
    } catch {
      // Warning failures must not interrupt auth modal state transitions.
    }
  }
}
