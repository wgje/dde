import type { WritableSignal } from '@angular/core';
import { supabaseErrorToError } from '../utils/supabase-error';
import type { AuthState } from './auth.service';
import type { PersistedSessionIdentity } from './auth-session-identity';

type AuthCheckSessionResult = {
  userId: string | null;
  email: string | null;
};

type AuthSessionUser = {
  id: string;
  email?: string | null;
};

type AuthSessionResult = {
  data: { session: { user?: AuthSessionUser } | null } | null;
  error: { message: string; status?: number; name?: string } | null;
};

export interface AuthSessionCheckContext {
  isSupabaseConfigured: () => boolean;
  authState: WritableSignal<AuthState>;
  sessionInitialized: WritableSignal<boolean>;
  currentUserId: () => string | null;
  sessionEmail: () => string | null;
  runtimeState: () => string;
  readLocalSessionFastPath: () => PersistedSessionIdentity | null;
  isBrowserNetworkSuspendedWindow: () => boolean;
  isBrowserNetworkSuspendedError: (error: unknown) => boolean;
  ensureRuntimeAuthReady: () => Promise<void>;
  getSession: () => Promise<AuthSessionResult>;
  tryDevAutoLogin: () => Promise<AuthCheckSessionResult | null>;
  applyAuthenticatedIdentity: (
    userId: string,
    email: string | null,
    options?: { isCheckingSession?: boolean; syncSentryUser?: boolean }
  ) => void;
  setPersistedOwnerHint: (userId: string | null) => void;
  setPersistedSessionUserId: (userId: string | null) => void;
  setProvisionalAuthState: (state: 'pending' | 'ready' | 'failed') => void;
  scheduleBackgroundSessionRefresh: () => void;
  scheduleRuntimeAuthReadyInitialization: () => void;
  trace: (eventName: string, data: Record<string, unknown>) => void;
  debug: (message: string, data?: unknown) => void;
  info: (message: string, data?: unknown) => void;
  error: (message: string, data?: unknown) => void;
}

export class AuthSessionCheckController {
  constructor(private readonly context: AuthSessionCheckContext) {}

  async checkSession(): Promise<AuthCheckSessionResult> {
    this.context.debug('========== checkSession 开始 ==========');

    if (!this.context.isSupabaseConfigured()) {
      this.context.debug('Supabase 未配置，跳过会话检查');
      this.context.authState.update(s => ({ ...s, isCheckingSession: false }));
      this.context.sessionInitialized.set(true);
      return { userId: null, email: null };
    }

    this.context.authState.update(s => ({ ...s, isCheckingSession: true }));

    const localSession = this.context.readLocalSessionFastPath();
    if (localSession) {
      return this.applyLocalSessionFastPath(localSession);
    }

    if (this.context.isBrowserNetworkSuspendedWindow()) {
      return this.deferForBrowserResume('preflight');
    }

    try {
      const sessionIdentity = this.resolveNetworkSessionIdentity(await this.loadSessionWithTimeout());
      if (sessionIdentity) return sessionIdentity;

      this.context.debug('无现有会话，尝试开发环境自动登录...');
      const autoLoginResult = await this.context.tryDevAutoLogin();
      if (autoLoginResult) {
        this.context.debug('========== 自动登录成功 ==========');
        return autoLoginResult;
      }

      this.context.debug('========== 无会话，未登录 ==========');
      this.context.setPersistedOwnerHint(null);
      this.context.setPersistedSessionUserId(null);
      return { userId: null, email: null };
    } catch (e: unknown) {
      return this.handleError(e);
    } finally {
      this.context.debug('设置 isCheckingSession = false, sessionInitialized = true');
      this.context.authState.update(s => ({ ...s, isCheckingSession: false }));
      this.context.sessionInitialized.set(true);
    }
  }

  private applyLocalSessionFastPath(localSession: PersistedSessionIdentity): AuthCheckSessionResult {
    this.context.debug('[FastPath] 本地会话命中，跳过网络 getSession()');
    this.context.applyAuthenticatedIdentity(localSession.userId, localSession.email, {
      isCheckingSession: false,
      syncSentryUser: true,
    });
    this.context.sessionInitialized.set(true);
    this.context.setProvisionalAuthState('ready');
    this.context.trace('auth.fast_path_hit', {
      userId: localSession.userId,
      runtimeState: this.context.runtimeState(),
    });
    this.context.scheduleBackgroundSessionRefresh();
    this.context.scheduleRuntimeAuthReadyInitialization();
    return localSession;
  }

  private async loadSessionWithTimeout(): Promise<AuthSessionResult> {
    await this.context.ensureRuntimeAuthReady();
    this.context.debug('正在调用 supabase.getSession()...');
    const callStartTime = Date.now();
    const sessionPromise = this.context.getSession();
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('会话检查超时')), 5000);
    });

    const sessionResult = await Promise.race([sessionPromise, timeoutPromise]);
    this.context.debug(`getSession() 返回 (耗时 ${Date.now() - callStartTime}ms)`);
    return sessionResult;
  }

  private resolveNetworkSessionIdentity(sessionResult: AuthSessionResult): AuthCheckSessionResult | null {
    const { data, error } = sessionResult;
    if (error) {
      this.context.error('getSession() 返回错误', {
        message: error.message,
        status: error.status,
        name: error.name,
      });
      throw supabaseErrorToError(error);
    }

    const session = data?.session;
    this.context.debug('会话状态', { exists: !!session });
    if (!session?.user) return null;

    const userId = session.user.id;
    const email = session.user.email ?? null;
    this.context.debug('用户已登录', {
      userId: `${userId.substring(0, 8)}...`,
      email,
    });
    this.context.applyAuthenticatedIdentity(userId, email, { syncSentryUser: true });
    this.context.debug('========== checkSession 成功 ==========');
    return { userId, email };
  }

  private handleError(error: unknown): AuthCheckSessionResult {
    if (this.context.isBrowserNetworkSuspendedError(error) || this.context.isBrowserNetworkSuspendedWindow()) {
      return this.deferForBrowserResume('catch');
    }

    const err = error as Error | undefined;
    this.context.error('========== checkSession 异常 ==========', {
      message: err?.message,
      stack: err?.stack?.split('\n')?.slice(0, 3)?.join('\n'),
      isTimeout: err?.message?.includes('超时'),
    });

    if (!err?.message?.includes('超时')) {
      this.context.authState.update(s => ({
        ...s,
        error: err?.message ?? String(error),
      }));
    }

    this.context.debug('返回空会话，不阻断应用启动');
    return { userId: null, email: null };
  }

  private deferForBrowserResume(source: 'preflight' | 'catch'): AuthCheckSessionResult {
    const fallback = {
      userId: this.context.currentUserId(),
      email: this.context.sessionEmail(),
    };

    this.context.info('[CheckSession] 浏览器网络挂起窗口内延后会话检查', {
      source,
      hasCachedUser: !!fallback.userId,
    });
    this.context.authState.update(s => ({
      ...s,
      userId: fallback.userId,
      email: fallback.email,
      error: null,
      isCheckingSession: false,
    }));
    this.context.sessionInitialized.set(true);
    this.context.scheduleBackgroundSessionRefresh();
    this.context.scheduleRuntimeAuthReadyInitialization();
    return fallback;
  }
}
