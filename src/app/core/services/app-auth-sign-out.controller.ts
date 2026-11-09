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
  signOutRemoteSession: () => Promise<boolean>;
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

interface AppAuthSignOutControllerInternalOptions extends AppAuthSignOutControllerOptions {
  captureAuthIdentityFence?: () => string | null;
}

interface AppAuthSignOutFlight {
  ownerFence: string | null;
  ownerUserId: string | null;
  cleanupFence: string | null;
  promise: Promise<boolean>;
}

export class AppAuthSignOutController {
  private flight: AppAuthSignOutFlight | null = null;
  constructor(private readonly options: AppAuthSignOutControllerInternalOptions) {}

  signOut(): Promise<boolean> {
    if (this.flight) return this.flight.promise;
    const flight = {} as AppAuthSignOutFlight;
    const ownerUserId = this.options.currentUserId();
    flight.ownerUserId = ownerUserId;
    flight.ownerFence = this.captureAuthIdentityFence();
    flight.cleanupFence = null;
    this.flight = flight;
    flight.promise = this.runSignOut(flight)
      .finally(() => {
        if (this.flight === flight) this.flight = null;
      });
    return flight.promise;
  }

  private async runSignOut(flight: AppAuthSignOutFlight): Promise<boolean> {
    if (!this.isOwnerCurrent(flight)) return false;
    if (!await this.revokeWidgetBindingsIfNeeded(flight.ownerUserId)) {
      return false;
    }
    if (!this.isOwnerCurrent(flight)) return false;

    if (!await this.signOutRemoteSession()) return false;
    if (!this.isRemoteResultCurrent(flight)) return false;
    flight.cleanupFence = this.captureAuthIdentityFence();

    await this.notifyLocalLogoutServices();
    if (!this.isCleanupCurrent(flight)) return false;
    const localCleanupFailed = await this.clearLocalUserData(flight);
    if (!this.isCleanupCurrent(flight)) return false;

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
      return await this.options.signOutRemoteSession();
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

  private async clearLocalUserData(flight: AppAuthSignOutFlight): Promise<boolean> {
    if (!this.isCleanupCurrent(flight)) return false;

    try {
      await this.options.setCurrentUser(null, { skipPersistentReload: true });
      const currentUserId = this.options.currentUserId();
      if (currentUserId !== null && currentUserId !== flight.ownerUserId) return false;
      flight.cleanupFence = this.captureAuthIdentityFence();
      if (!this.isCleanupCurrent(flight)) return false;
      await this.options.clearAllLocalData(flight.ownerUserId ?? undefined);
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

  private captureAuthIdentityFence(): string | null {
    return this.options.captureAuthIdentityFence?.() ?? null;
  }

  private isCurrentFlight(flight: AppAuthSignOutFlight): boolean {
    return this.flight === flight;
  }

  private isOwnerCurrent(flight: AppAuthSignOutFlight): boolean {
    return this.isCurrentFlight(flight)
      && flight.ownerFence !== null
      && this.options.currentUserId() === flight.ownerUserId
      && this.captureAuthIdentityFence() === flight.ownerFence;
  }

  private isRemoteResultCurrent(flight: AppAuthSignOutFlight): boolean {
    if (!this.isCurrentFlight(flight)) return false;
    if (!this.options.isAuthConfigured()) return true;
    return this.options.currentUserId() === null
      && flight.ownerFence !== null
      && this.captureAuthIdentityFence() !== flight.ownerFence;
  }

  private isCleanupCurrent(flight: AppAuthSignOutFlight): boolean {
    if (!this.isCurrentFlight(flight) || flight.cleanupFence === null) return false;
    const currentUserId = this.options.currentUserId();
    return (currentUserId === null || currentUserId === flight.ownerUserId)
      && this.captureAuthIdentityFence() === flight.cleanupFence;
  }
}
