type AuthSessionUser = {
  id: string;
  email?: string | null;
};

type AuthSessionResult = {
  data: { session: { user?: AuthSessionUser } | null } | null;
  error: { message: string; status?: number; name?: string } | null;
};

export interface AuthBackgroundSessionRefreshContext {
  currentUserId: () => string | null;
  runtimeState: () => string;
  applySessionUser: (user: AuthSessionUser) => void;
  invalidateSession: () => void;
  isAuthenticationError: (error: unknown) => boolean;
  trace: (eventName: string, data: Record<string, unknown>) => void;
  debug: (message: string, data?: unknown) => void;
  warn: (message: string, data?: unknown) => void;
}

export class AuthBackgroundSessionRefreshController {
  constructor(private readonly context: AuthBackgroundSessionRefreshContext) {}

  private warn(message: string, data?: unknown): void {
    try {
      this.context.warn(message, data);
    } catch {
      // Observability failures must not alter background auth state transitions.
    }
  }

  private debug(message: string, data?: unknown): void {
    try {
      this.context.debug(message, data);
    } catch {
      // Observability failures must not alter background auth state transitions.
    }
  }

  private trace(eventName: string, data: Record<string, unknown>): void {
    try {
      this.context.trace(eventName, data);
    } catch {
      // Observability failures must not alter background auth state transitions.
    }
  }

  handleResult(result: AuthSessionResult): void {
    if (result.error) {
      this.handleErrorResult(result.error);
      return;
    }

    const session = result.data?.session;
    if (!session?.user) {
      this.warn('[BackgroundRefresh] SDK 返回空会话，本地缓存已失效');
      this.trace('auth.background_refresh_invalid_session', {
        runtimeState: this.context.runtimeState(),
        currentUserId: this.context.currentUserId(),
      });
      this.context.invalidateSession();
      return;
    }

    this.context.applySessionUser(session.user);
    this.debug('[BackgroundRefresh] SDK session 已同步');
    this.trace('auth.background_refresh_synced', { userId: session.user.id });
  }

  handleError(error: unknown): void {
    if (this.context.isAuthenticationError(error)) {
      this.warn('[BackgroundRefresh] SDK 抛出认证异常，清除本地会话', error);
      this.trace('auth.background_refresh_auth_error', {
        currentUserId: this.context.currentUserId(),
      });
      this.context.invalidateSession();
      return;
    }

    this.debug('[BackgroundRefresh] SDK session 刷新失败（网络问题，保留本地状态）', error);
    this.trace('auth.background_refresh_network_preserved', {
      currentUserId: this.context.currentUserId(),
    });
  }

  private handleErrorResult(error: AuthSessionResult['error']): void {
    const errorName = (error as { name?: string } | null)?.name;
    if (errorName === 'ClientUnavailable') {
      this.debug('[BackgroundRefresh] SDK 客户端不可用，保留本地状态（稍后重试）');
      this.trace('auth.background_refresh_client_unavailable', {
        runtimeState: this.context.runtimeState(),
        currentUserId: this.context.currentUserId(),
      });
      return;
    }

    if (!this.context.isAuthenticationError(error)) {
      this.debug('[BackgroundRefresh] SDK getSession 返回可重试错误，保留本地状态', error);
      this.trace('auth.background_refresh_network_preserved', {
        currentUserId: this.context.currentUserId(),
      });
      return;
    }

    this.warn('[BackgroundRefresh] SDK getSession 返回错误，清除本地会话', error);
    this.trace('auth.background_refresh_auth_error', {
      currentUserId: this.context.currentUserId(),
    });
    this.context.invalidateSession();
  }
}
