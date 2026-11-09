import { POLLING_CHECK_DELAY } from '../config/timeout.config';

type AuthSessionUser = {
  id: string;
  email?: string | null;
};

type AuthSessionResult = {
  data: { session: { user?: AuthSessionUser } | null } | null;
  error: { message: string; status?: number; name?: string } | null;
};

type CanonicalAuthBundle = {
  session: string | null;
  codeVerifier: string | null;
  user: string | null;
};

type AuthBackgroundSessionRefreshTicket = {
  scheduleGeneration: number;
  storageKey: string;
  bundle: CanonicalAuthBundle;
  authIdentityGeneration: number;
  ownerUserId: string | null;
  pendingOwnerUserId: string | null;
};

export interface AuthBackgroundSessionRefreshContext {
  storageKey: () => string | null;
  canonicalBundle: () => CanonicalAuthBundle | null;
  currentUserId: () => string | null;
  pendingOwnerUserId: () => string | null;
  runtimeState: () => string;
  authIdentityGeneration: () => number;
  destroyed: () => boolean;
  getSession: () => Promise<AuthSessionResult>;
  applySessionUser: (user: AuthSessionUser) => void;
  /**
   * 后台刷新发现会话确实无效时，清除 FastPath 乐观设置的状态。
   * 这会让 showLoginRequired 生效，触发登录兜底 UI。
   */
  invalidateSession: () => void;
  isAuthenticationError: (error: unknown) => boolean;
  trace: (eventName: string, data: Record<string, unknown>) => void;
  debug: (message: string, data?: unknown) => void;
  warn: (message: string, data?: unknown) => void;
}

export class AuthBackgroundSessionRefreshController {
  private scheduleGeneration = 0;
  private scheduledTask:
    | { kind: 'idle'; handle: number }
    | { kind: 'timer'; handle: ReturnType<typeof setTimeout> }
    | null = null;

  constructor(private readonly context: AuthBackgroundSessionRefreshContext) {}

  /**
   * 后台异步刷新 SDK session，确保 Supabase 客户端状态与本地缓存同步。
   * 不阻塞 UI，不影响用户操作。
   *
   * 当后台刷新发现会话实际无效时，清除本地状态以触发登录兜底；
   * 否则用户会看到已登录，但所有 API 调用失败且无法恢复数据。
   */
  schedule(): void {
    this.cancelPending();
    const scheduleGeneration = ++this.scheduleGeneration;
    const ticket = this.captureRefreshTicket(scheduleGeneration);
    if (!ticket) {
      return;
    }
    this.scheduledTask = this.scheduleTask(() => {
      if (!this.isRefreshCurrent(ticket)) {
        return;
      }
      this.scheduledTask = null;
      void Promise.resolve().then(async () => {
        if (!this.isRefreshCurrent(ticket)) return;
        try {
          const result = await this.context.getSession();
          if (!this.isRefreshCurrent(ticket)) return;
          if (result.data?.session?.user?.id !== undefined
            && result.data.session.user.id !== ticket.ownerUserId) return;
          this.handleResult(result, ticket.ownerUserId, () => this.isRefreshCurrent(ticket));
        } catch (error: unknown) {
          if (!this.isRefreshCurrent(ticket)) return;
          this.handleError(error, () => this.isRefreshCurrent(ticket));
        }
      });
    });
  }

  cancelPending(): void {
    this.scheduleGeneration += 1;
    const scheduledTask = this.scheduledTask;
    this.scheduledTask = null;
    if (!scheduledTask) {
      return;
    }

    if (scheduledTask.kind === 'idle') {
      if (typeof window !== 'undefined') {
        const cancelIdleCallback = (window as Window & {
          cancelIdleCallback?: (handle: number) => void;
        }).cancelIdleCallback;
        if (typeof cancelIdleCallback === 'function') {
          try {
            cancelIdleCallback.call(window, scheduledTask.handle);
          } catch {
            // The generation is already invalidated; a failed host cancel must not
            // escape into startup/session code or prevent a superseding schedule.
          }
        }
      }
      return;
    }

    clearTimeout(scheduledTask.handle);
  }

  private warn(message: string, data?: unknown, isCurrent: () => boolean = alwaysCurrent): void {
    if (!isCurrent()) return;
    try {
      this.context.warn(message, data);
    } catch {
      // Observability failures must not alter background auth state transitions.
    }
  }

  private debug(message: string, data?: unknown, isCurrent: () => boolean = alwaysCurrent): void {
    if (!isCurrent()) return;
    try {
      this.context.debug(message, data);
    } catch {
      // Observability failures must not alter background auth state transitions.
    }
  }

  private trace(eventName: string, data: Record<string, unknown>,
    isCurrent: () => boolean = alwaysCurrent): void {
    if (!isCurrent()) return;
    try {
      this.context.trace(eventName, data);
    } catch {
      // Observability failures must not alter background auth state transitions.
    }
  }

  private scheduleTask(task: () => void): NonNullable<AuthBackgroundSessionRefreshController['scheduledTask']> {
    if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
      try {
        const handle = (window as Window & {
          requestIdleCallback: (callback: () => void, options?: { timeout: number }) => number;
        }).requestIdleCallback(task, { timeout: 3000 });
        return { kind: 'idle', handle };
      } catch {
        this.warn('[BackgroundRefresh] requestIdleCallback scheduling failed; using timer fallback');
      }
    }
    return {
      kind: 'timer',
      handle: setTimeout(task, POLLING_CHECK_DELAY.CONDITION_READY),
    };
  }

  private captureRefreshTicket(scheduleGeneration: number): AuthBackgroundSessionRefreshTicket | null {
    try {
      const storageKey = this.context.storageKey();
      const bundle = this.context.canonicalBundle();
      if (!storageKey || !isCanonicalAuthBundle(bundle)) return null;
      return {
        scheduleGeneration,
        storageKey,
        bundle: { ...bundle },
        authIdentityGeneration: this.context.authIdentityGeneration(),
        ownerUserId: this.context.currentUserId(),
        pendingOwnerUserId: this.context.pendingOwnerUserId(),
      };
    } catch {
      // Authority capture failures leave the refresh unscheduled.
    }
    return null;
  }

  private isRefreshCurrent(ticket: AuthBackgroundSessionRefreshTicket): boolean {
    try {
      const currentBundle = this.context.canonicalBundle();
      return !this.context.destroyed()
        && this.scheduleGeneration === ticket.scheduleGeneration
        && this.context.storageKey() === ticket.storageKey
        && this.context.authIdentityGeneration() === ticket.authIdentityGeneration
        && this.context.currentUserId() === ticket.ownerUserId
        && this.context.pendingOwnerUserId() === ticket.pendingOwnerUserId
        && isCanonicalAuthBundle(currentBundle)
        && canonicalBundlesEqual(currentBundle, ticket.bundle);
    } catch {
      return false;
    }
  }

  handleResult(
    result: AuthSessionResult,
    expectedUserId: string | null = this.context.currentUserId(),
    isCurrent: () => boolean = alwaysCurrent,
  ): void {
    if (!isCurrent()) return;
    if (result.error) {
      this.handleErrorResult(result.error, isCurrent);
      return;
    }

    const session = result.data?.session;
    if (!session?.user) {
      this.warn('[BackgroundRefresh] SDK 返回空会话，本地缓存已失效', undefined, isCurrent);
      this.trace('auth.background_refresh_invalid_session', {
        runtimeState: this.context.runtimeState(),
        currentUserId: this.context.currentUserId(),
      }, isCurrent);
      this.runIfCurrent(isCurrent, () => this.context.invalidateSession());
      return;
    }

    if (session.user.id !== expectedUserId) {
      this.warn('[BackgroundRefresh] SDK session owner 与本地工作区不一致，拒绝直接切换身份', {
        expectedUserId,
        returnedUserId: session.user.id,
      }, isCurrent);
      this.trace('auth.background_refresh_owner_mismatch', {
        expectedUserId,
        returnedUserId: session.user.id,
      }, isCurrent);
      this.runIfCurrent(isCurrent, () => this.context.invalidateSession());
      return;
    }

    this.debug('[BackgroundRefresh] SDK session 已同步', undefined, isCurrent);
    this.trace('auth.background_refresh_synced', { userId: session.user.id }, isCurrent);
    this.runIfCurrent(isCurrent, () => this.context.applySessionUser(session.user!));
  }

  handleError(error: unknown, isCurrent: () => boolean = alwaysCurrent): void {
    if (!isCurrent()) return;
    if (this.context.isAuthenticationError(error)) {
      this.warn('[BackgroundRefresh] SDK 抛出认证异常，清除本地会话', error, isCurrent);
      this.trace('auth.background_refresh_auth_error', {
        currentUserId: this.context.currentUserId(),
      }, isCurrent);
      this.runIfCurrent(isCurrent, () => this.context.invalidateSession());
      return;
    }

    this.debug('[BackgroundRefresh] SDK session 刷新失败（网络问题，保留本地状态）', error, isCurrent);
    this.trace('auth.background_refresh_network_preserved', {
      currentUserId: this.context.currentUserId(),
    }, isCurrent);
  }

  private handleErrorResult(
    error: AuthSessionResult['error'],
    isCurrent: () => boolean,
  ): void {
    const errorName = (error as { name?: string } | null)?.name;
    if (errorName === 'ClientUnavailable') {
      this.debug('[BackgroundRefresh] SDK 客户端不可用，保留本地状态（稍后重试）', undefined, isCurrent);
      this.trace('auth.background_refresh_client_unavailable', {
        runtimeState: this.context.runtimeState(),
        currentUserId: this.context.currentUserId(),
      }, isCurrent);
      return;
    }

    if (!this.context.isAuthenticationError(error)) {
      this.debug('[BackgroundRefresh] SDK getSession 返回可重试错误，保留本地状态', error, isCurrent);
      this.trace('auth.background_refresh_network_preserved', {
        currentUserId: this.context.currentUserId(),
      }, isCurrent);
      return;
    }

    this.warn('[BackgroundRefresh] SDK getSession 返回错误，清除本地会话', error, isCurrent);
    this.trace('auth.background_refresh_auth_error', {
      currentUserId: this.context.currentUserId(),
    }, isCurrent);
    this.runIfCurrent(isCurrent, () => this.context.invalidateSession());
  }

  private runIfCurrent(isCurrent: () => boolean, action: () => void): void {
    if (isCurrent()) action();
  }
}

const alwaysCurrent = (): boolean => true;

function isCanonicalAuthBundle(bundle: CanonicalAuthBundle | null): bundle is CanonicalAuthBundle {
  return !!bundle
    && isNullableString(bundle.session)
    && isNullableString(bundle.codeVerifier)
    && isNullableString(bundle.user);
}

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === 'string';

function canonicalBundlesEqual(left: CanonicalAuthBundle, right: CanonicalAuthBundle): boolean {
  return left.session === right.session
    && left.codeVerifier === right.codeVerifier
    && left.user === right.user;
}
