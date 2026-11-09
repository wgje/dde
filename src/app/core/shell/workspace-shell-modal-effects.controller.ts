type WorkspaceShellModalType = 'login' | 'migration';

export interface WorkspaceShellRecoverableModalError {
  title: string;
  message: string;
  details?: string;
  options: unknown[];
  defaultOptionId?: string;
  autoSelectIn?: number | null;
  resolve: (optionId: string) => void;
}

export interface WorkspaceShellModalEffectsControllerOptions {
  recoverableError: () => WorkspaceShellRecoverableModalError | null;
  isModalOpen: (type: WorkspaceShellModalType) => boolean;
  getLoginData: () => { returnUrl?: string | null } | undefined;
  closeByType: (type: WorkspaceShellModalType) => void;
  getLoginReturnUrl: () => string | null;
  setLoginReturnUrl: (url: string | null) => void;
  hasLoginModalRef: () => boolean;
  openErrorRecoveryModal: (error: {
    title: string;
    message: string;
    details?: string;
    options: unknown[];
    defaultOptionId?: string;
    autoSelectIn?: number | null;
    resolve: (result: { optionId: string }) => void;
  }) => Promise<void> | void;
  openLoginModal: () => Promise<void> | void;
  openMigrationModal: () => Promise<void> | void;
  warn: (message: string, error: unknown) => void;
}

export class WorkspaceShellModalEffectsController {
  constructor(private readonly options: WorkspaceShellModalEffectsControllerOptions) {}

  syncRecoverableError(): void {
    const error = this.options.recoverableError();
    if (!error) {
      return;
    }

    this.openModalSafely(
      () => this.options.openErrorRecoveryModal({
        title: error.title,
        message: error.message,
        details: error.details,
        options: error.options,
        defaultOptionId: error.defaultOptionId,
        autoSelectIn: error.autoSelectIn,
        resolve: result => error.resolve(result.optionId),
      }),
      '恢复操作弹窗打开失败，已跳过本次展示',
    );
  }

  syncLoginRequest(): void {
    if (!this.options.isModalOpen('login')) {
      return;
    }

    const loginData = this.options.getLoginData();
    this.options.setLoginReturnUrl(loginData?.returnUrl ?? null);
    this.options.closeByType('login');
    if (!this.options.hasLoginModalRef()) {
      this.openModalSafely(
        () => this.options.openLoginModal(),
        '登录弹窗打开失败，已跳过本次展示',
      );
    }
  }

  syncMigrationRequest(): void {
    if (!this.options.isModalOpen('migration')) {
      return;
    }

    this.options.closeByType('migration');
    this.openModalSafely(
      () => this.options.openMigrationModal(),
      '迁移弹窗打开失败，已跳过本次展示',
    );
  }

  private openModalSafely(
    open: () => Promise<void> | void,
    failureMessage: string,
  ): void {
    try {
      void Promise.resolve(open()).catch(error => {
        this.warn(failureMessage, error);
      });
    } catch (error) {
      this.warn(failureMessage, error);
    }
  }

  private warn(message: string, error: unknown): void {
    try {
      this.options.warn(message, error);
    } catch {
      // Modal warning sinks must not re-open consumed modal requests.
    }
  }
}
