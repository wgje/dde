import { AUTH_CONFIG } from '../../../config/auth.config';
import type { OperationError, Result } from '../../../utils/result';
import {
  buildWidgetRevocationFailureNotice,
  getLocalCleanupFailureNotice,
  getSupabaseSignOutFailureNotice,
  shouldRevokeWidgetBindingsOnSignOut,
} from './app-auth-coordinator.helpers';

export interface AppAuthSignOutControllerOptions {
  currentUserId: () => string | null;
  isAuthConfigured: () => boolean;
  revokeWidgetBindings: () => Promise<Result<unknown, OperationError>>;
  signOutRemoteSession: () => Promise<void>;
  notifyLocalLogoutServices: () => Promise<void>;
  setCurrentUser: (
    userId: string | null,
    options: { skipPersistentReload: true },
  ) => Promise<void>;
  clearAllLocalData: (userId?: string) => Promise<void>;
  resetAuthFormState: () => void;
  logError: (message: string, error: unknown) => void;
  logWarn: (message: string, error: unknown) => void;
  showError: (title: string, message: string) => void;
  showWarning: (title: string, message: string) => void;
}

export class AppAuthSignOutController {
  constructor(private readonly options: AppAuthSignOutControllerOptions) {}

  async signOut(): Promise<boolean> {
    const currentUserId = this.options.currentUserId();

    if (!await this.revokeWidgetBindingsIfNeeded(currentUserId)) {
      return false;
    }

    if (!await this.signOutRemoteSession()) {
      return false;
    }

    await this.notifyLocalLogoutServices();
    const localCleanupFailed = await this.clearLocalUserData(currentUserId);
    this.options.resetAuthFormState();
    this.warnIfLocalCleanupFailed(localCleanupFailed);
    return true;
  }

  private async revokeWidgetBindingsIfNeeded(
    currentUserId: string | null,
  ): Promise<boolean> {
    if (!shouldRevokeWidgetBindingsOnSignOut({
      currentUserId,
      localModeUserId: AUTH_CONFIG.LOCAL_MODE_USER_ID,
      isConfigured: this.options.isAuthConfigured(),
    })) {
      return true;
    }

    const revokeResult = await this.options.revokeWidgetBindings();
    if (revokeResult.ok) {
      return true;
    }

    const notice = buildWidgetRevocationFailureNotice(revokeResult.error);
    this.options.logError(notice.logMessage, revokeResult.error);
    this.options.showError(notice.toastTitle, notice.toastMessage);
    return false;
  }

  private async signOutRemoteSession(): Promise<boolean> {
    if (!this.options.isAuthConfigured()) {
      return true;
    }

    try {
      await this.options.signOutRemoteSession();
      return true;
    } catch (error) {
      const notice = getSupabaseSignOutFailureNotice();
      this.options.logError(notice.logMessage, error);
      this.options.showError(notice.toastTitle, notice.toastMessage);
      return false;
    }
  }

  private async notifyLocalLogoutServices(): Promise<void> {
    try {
      await this.options.notifyLocalLogoutServices();
    } catch (error) {
      this.options.logWarn('onUserLogout 清理过程中出错，继续登出流程', error);
    }
  }

  private async clearLocalUserData(currentUserId: string | null): Promise<boolean> {
    try {
      await this.options.setCurrentUser(null, { skipPersistentReload: true });
      await this.options.clearAllLocalData(currentUserId ?? undefined);
      return false;
    } catch (error) {
      const notice = getLocalCleanupFailureNotice();
      this.options.logError(notice.logMessage, error);
      return true;
    }
  }

  private warnIfLocalCleanupFailed(localCleanupFailed: boolean): void {
    if (!localCleanupFailed) {
      return;
    }

    const notice = getLocalCleanupFailureNotice();
    this.options.showWarning(notice.toastTitle, notice.toastMessage);
  }
}
