import { Injectable, inject, signal, DestroyRef } from '@angular/core';
import { SupabaseClientService } from './supabase-client.service';
import { EventBusService } from './event-bus.service';
import {
  Result, OperationError, ErrorCodes, failure
} from '../utils/result';
import { environment } from '../environments/environment';
import { ToastService } from './toast.service';
import { LoggerService } from './logger.service';
import { isLocalModeEnabled } from './guards/auth.guard';
import { pushStartupTrace } from '../utils/startup-trace';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { AUTH_CONFIG } from '../config/auth.config';
import { POLLING_CHECK_DELAY } from '../config/timeout.config';
import {
  isBrowserNetworkSuspendedError,
  isBrowserNetworkSuspendedWindow,
} from '../utils/browser-network-suspension';
import {
  isAuthenticationError as isAuthenticationErrorPure,
  type PersistedSessionIdentity,
} from './auth-session-identity';
import { AuthSessionCacheService } from './auth-session-cache.service';
import { AuthCredentialRequestService } from './auth-credential-request.service';
import type { AuthResult } from './auth-types';
import { resolveInvalidatedOwnerUserId as resolveInvalidatedOwnerUserIdPure } from './auth-session-invalidation.helpers';
import { AuthSessionStateWriter } from './auth-session-state-writer';
import { AuthBackgroundSessionRefreshController } from './auth-background-session-refresh.controller';
import { AuthStorageBridgeController } from './auth-storage-bridge.controller';
import { AuthDevAutoLoginController } from './auth-dev-auto-login.controller';
import { AuthCredentialFlowController } from './auth-credential-flow.controller';
import { AuthSessionCheckController } from './auth-session-check.controller';
export type { AuthResult } from './auth-types';

export interface AuthState {
  isCheckingSession: boolean;
  isLoading: boolean;
  userId: string | null;
  email: string | null;
  error: string | null;
}

type AuthSessionUser = {
  id: string;
  email?: string | null;
};

/**
 * 认证服务
 * 负责用户登录、注册、登出
 * 
 * 开发环境自动登录：
 * - 设置 environment.devAutoLogin 后，应用启动时会自动登录
 * - Guard 仍然存在且生效，只是登录过程被自动化
 * - 这避免了"关掉 Guard"的懒惰做法，保持代码路径与生产环境一致
 * 
 * 所有公共方法返回 Result<T> 类型以保持一致性
 */
@Injectable({
  providedIn: 'root'
})
export class AuthService {
  private supabase = inject(SupabaseClientService);
  private toast = inject(ToastService);
  private logger = inject(LoggerService).category('AuthService');
  private destroyRef = inject(DestroyRef);
  private eventBus = inject(EventBusService);
  private sentryLazyLoader = inject(SentryLazyLoaderService);
  private authSessionCache = inject(AuthSessionCacheService);
  private authCredentialRequests = inject(AuthCredentialRequestService);
  
  /** 是否为用户主动登出（区分 Token 过期） */
  private isManualSignOut = false;
  
  /** 会话是否已过期 */
  readonly sessionExpired = signal(false);
  
  /**
   * 会话初始化是否完成（首次 checkSession 已执行完毕）
   * 用于区分"尚未检查"与"检查完毕无会话"两种状态，
   * 解决 Guard 与 bootstrap 间的竞态条件导致登录弹窗误弹出
   */
  readonly sessionInitialized = signal(false);
  readonly runtimeState = signal<'idle' | 'pending' | 'ready' | 'failed'>('idle');
  
  /** 认证状态变更订阅的取消函数 */
  private authStateSubscription: { unsubscribe: () => void } | null = null;
  private authRuntimeReady = false;
  private runtimeAuthReadyPromise: Promise<void> | null = null;
  private readonly storageKey = this.supabase.getStorageKey();
  private readonly storageListener = (event: StorageEvent) => this.handleStorageEvent(event);
  private setProvisionalAuthState(state: 'pending' | 'ready' | 'failed'): void {
    this.runtimeState.set(state);
  }
  
  /** Supabase 是否已配置 */
  get isConfigured(): boolean {
    return this.supabase.isConfigured;
  }
  
  /** 
   * 认证状态
   * 【性能优化 2026-01-31】isCheckingSession 初始值改为 false
   * 只有在实际调用 checkSession() 时才设为 true
   * 这样 Guard 不会在应用启动时就开始等待
   */
  readonly authState = signal<AuthState>({
    isCheckingSession: false,
    isLoading: false,
    userId: null,
    email: null,
    error: null
  });

  /** 当前用户 ID */
  readonly currentUserId = signal<string | null>(null);
  /**
   * 【P1 秒开优化 2026-03-31】临时 userId 预设，用于快照预填充阶段。
   * 仅在 currentUserId 为 null 时生效。checkSession 完成后若为同一用户则为 no-op，
   * 若为不同用户则 checkSession 会覆盖。
   */
  setProvisionalCurrentUserId(userId: string): void {
    if (!this.currentUserId()) {
      this.currentUserId.set(userId);
    }
  }
  private readonly persistedOwnerHintState = signal<string | null>(null);
  readonly persistedOwnerHint = this.persistedOwnerHintState.asReadonly();
  private readonly persistedSessionUserIdState = signal<string | null>(null);
  readonly persistedSessionUserId = this.persistedSessionUserIdState.asReadonly();
  
  /** 当前用户邮箱 */
  readonly sessionEmail = signal<string | null>(null);
  private pendingStorageBridgeSessionIdentity: PersistedSessionIdentity | null = null;
  private pendingSessionRestoredNotification = false;
  private readonly sessionStateWriter = new AuthSessionStateWriter({
    currentUserId: this.currentUserId,
    persistedOwnerHint: this.persistedOwnerHintState,
    persistedSessionUserId: this.persistedSessionUserIdState,
    sessionEmail: this.sessionEmail,
    sessionExpired: this.sessionExpired,
    sessionInitialized: this.sessionInitialized,
    runtimeState: this.runtimeState,
    authState: this.authState,
    setSentryUser: (user) => this.sentryLazyLoader.setUser(user),
    clearCachedSessionArtifacts: () => this.clearCachedSessionArtifacts(),
  });
  private readonly backgroundSessionRefresh = new AuthBackgroundSessionRefreshController({
    currentUserId: () => this.currentUserId(),
    runtimeState: () => this.runtimeState(),
    applySessionUser: (user) => this.applyBackgroundSessionUser(user),
    invalidateSession: () => this.handleBackgroundSessionInvalid(),
    isAuthenticationError: (error) => this.isAuthenticationError(error),
    trace: (eventName, data) => pushStartupTrace(eventName, data),
    debug: (message, data) => this.logger.debug(message, data),
    warn: (message, data) => this.logger.warn(message, data),
  });
  private readonly storageBridgeController = new AuthStorageBridgeController({
    storageKey: () => this.storageKey,
    authRuntimeReady: () => this.authRuntimeReady,
    isLocalModeEnabled: () => isLocalModeEnabled(),
    currentUserId: () => this.currentUserId(),
    localModeUserId: AUTH_CONFIG.LOCAL_MODE_USER_ID,
    sessionExpired: () => this.sessionExpired(),
    pendingStorageBridgeSessionIdentity: () => this.pendingStorageBridgeSessionIdentity,
    setPendingStorageBridgeSessionIdentity: (identity) => {
      this.pendingStorageBridgeSessionIdentity = identity;
    },
    setPersistedOwnerHint: (userId) => this.setPersistedOwnerHint(userId),
    syncPersistedOwnerHintFromStorage: () => this.syncPersistedOwnerHintFromStorage(),
    syncPersistedSessionUserIdFromStorage: () => this.syncPersistedSessionUserIdFromStorage(),
    resolvePersistedSessionIdentityFromAuthData: (authData) => this.resolvePersistedSessionIdentityFromAuthData(authData),
    applyConfirmedSessionIdentity: (userId, email, options) => this.applyConfirmedSessionIdentity(userId, email, options),
    publishSessionRestored: (userId, source) => this.eventBus.publishSessionRestored(userId, source),
    teardownInvalidatedSession: (source) => this.teardownInvalidatedSession(source),
    debug: (message, data) => this.logger.debug(message, data),
  });
  private readonly devAutoLogin = new AuthDevAutoLoginController({
    devAutoLogin: (environment as {
      devAutoLogin?: { email: string; password: string } | null;
    }).devAutoLogin,
    production: (environment as { production?: boolean }).production,
    signIn: (email, password) => this.signIn(email, password),
    debug: (message, data) => this.logger.debug(message, data),
    info: (message, data) => this.logger.info(message, data),
    warn: (message, data) => this.logger.warn(message, data),
  });
  private readonly sessionCheck = new AuthSessionCheckController({
    isSupabaseConfigured: () => this.supabase.isConfigured,
    authState: this.authState,
    sessionInitialized: this.sessionInitialized,
    currentUserId: () => this.currentUserId(),
    sessionEmail: () => this.sessionEmail(),
    runtimeState: () => this.runtimeState(),
    readLocalSessionFastPath: () => this.authSessionCache.readPersistedSessionIdentity(true),
    isBrowserNetworkSuspendedWindow: () => isBrowserNetworkSuspendedWindow(),
    isBrowserNetworkSuspendedError: (error) => isBrowserNetworkSuspendedError(error),
    ensureRuntimeAuthReady: () => this.ensureRuntimeAuthReady(),
    getSession: () => this.supabase.getSession(),
    tryDevAutoLogin: () => this.tryDevAutoLogin(),
    applyAuthenticatedIdentity: (userId, email, options) => {
      this.sessionStateWriter.applyAuthenticatedIdentity(userId, email, options);
    },
    setPersistedOwnerHint: (userId) => this.setPersistedOwnerHint(userId),
    setPersistedSessionUserId: (userId) => this.setPersistedSessionUserId(userId),
    setProvisionalAuthState: (state) => this.setProvisionalAuthState(state),
    scheduleBackgroundSessionRefresh: () => this.scheduleBackgroundSessionRefresh(),
    scheduleRuntimeAuthReadyInitialization: () => this.scheduleRuntimeAuthReadyInitialization(),
    trace: (eventName, data) => pushStartupTrace(eventName, data),
    debug: (message, data) => this.logger.debug(message, data),
    info: (message, data) => this.logger.info(message, data),
    error: (message, data) => this.logger.error(message, data),
  });
  private readonly credentialFlow = new AuthCredentialFlowController({
    authState: this.authState,
    applyCredentialIdentity: (result) => this.applyCredentialIdentity(result),
  });
  
  constructor() {
    if (!this.supabase.isConfigured) {
      this.runtimeState.set('ready');
    }
    this.syncPersistedOwnerHintFromStorage();
    this.syncPersistedSessionUserIdFromStorage();
    this.initStorageBridge();
    
    // 组件销毁时清理订阅
    this.destroyRef.onDestroy(() => {
      this.authStateSubscription?.unsubscribe();
      if (typeof window !== 'undefined') {
        window.removeEventListener('storage', this.storageListener);
      }
    });
  }

  async ensureRuntimeAuthReady(): Promise<void> {
    if (!this.supabase.isConfigured || this.authRuntimeReady) {
      this.setProvisionalAuthState('ready');
      return;
    }

    if (this.runtimeAuthReadyPromise) {
      return this.runtimeAuthReadyPromise;
    }

    // 【Bug 修复 2026-03-27】仅当 runtimeState 还是 'idle' 时才降级为 'pending'。
    // FastPath 已提前将 runtimeState 设为 'ready'，此处不能将其回退为 'pending'，
    // 否则 handoff 条件中 runtimeState === 'pending' 会让结果卡在 'pending'。
    if (this.runtimeState() === 'idle') {
      this.setProvisionalAuthState('pending');
    }
    this.runtimeAuthReadyPromise = this.initAuthStateListener()
      .then(() => {
        this.authRuntimeReady = true;
        this.setProvisionalAuthState('ready');
      })
      .catch((error) => {
        this.setProvisionalAuthState('failed');
        throw error;
      })
      .finally(() => {
        this.runtimeAuthReadyPromise = null;
      });

    return this.runtimeAuthReadyPromise;
  }

  /**
   * 检查并恢复会话
   * 添加超时保护，防止网络异常时无限阻塞
   * 【P2-07 修复】添加并发调用防护，避免多个 checkSession 竞争
   * 
   * 【P3-10 说明】返回 userId=null 时，通过 authState 区分两种情况：
   * - 无会话（正常）：authState().error === null
   * - 检查失败（异常）：authState().error 包含错误信息
   * 
   * 开发环境：如果没有现有会话且配置了 devAutoLogin，会自动登录
   */
  private checkSessionPromise: Promise<{ userId: string | null; email: string | null }> | null = null;
  
  async checkSession(): Promise<{ userId: string | null; email: string | null }> {
    pushStartupTrace('auth.check_session', {
      runtimeState: this.runtimeState(),
      sessionInitialized: this.sessionInitialized(),
      currentUserId: this.currentUserId(),
    });
    // 如果已有进行中的 checkSession，直接复用
    if (this.checkSessionPromise) {
      return this.checkSessionPromise;
    }
    
    this.checkSessionPromise = this.sessionCheck.checkSession();
    try {
      return await this.checkSessionPromise;
    } finally {
      this.checkSessionPromise = null;
    }
  }
  
  /**
   * 【性能优化 2026-03-24】本地会话快速路径
   * 
   * 优化策略：
   * 1. 优先读取 index.html 预热脚本的刷新结果（window.__NANOFLOW_SESSION_PREWARM__）
   * 2. 其次读取 localStorage 中 Supabase 缓存的会话 token
   * 3. 只要 token 未过期（>60s 缓冲），直接使用本地数据，跳过网络调用
   * 4. 后台异步触发 SDK getSession() 确保 token 最终刷新
   * 
   * 预期收益：冷启动节省 1-3s（跳过 getSession 网络往返）
   */
  peekPersistedSessionIdentity(): PersistedSessionIdentity | null {
    return this.authSessionCache.peekPersistedSessionIdentity();
  }

  /**
   * 仅用于本地 owner 匹配的 userId 提示，不代表当前会话已经通过认证校验。
   * 当 access token 临近过期、但 refresh token 仍可恢复时，冷启动预填充依赖此提示命中正确的 owner-scoped 快照。
   */
  peekPersistedOwnerHint(): string | null {
    return this.authSessionCache.peekPersistedOwnerHint();
  }

  private setPersistedOwnerHint(userId: string | null): void {
    this.persistedOwnerHintState.set(userId);
  }

  private syncPersistedOwnerHintFromStorage(): void {
    this.persistedOwnerHintState.set(this.peekPersistedOwnerHint());
  }

  private setPersistedSessionUserId(userId: string | null): void {
    this.persistedSessionUserIdState.set(userId);
  }

  private syncPersistedSessionUserIdFromStorage(): void {
    this.persistedSessionUserIdState.set(this.peekPersistedSessionIdentity()?.userId ?? null);
  }

  private resolvePersistedSessionIdentityFromAuthData(authData: unknown): PersistedSessionIdentity | null {
    return this.authSessionCache.resolvePersistedSessionIdentityFromAuthData(authData);
  }

  private scheduleRuntimeAuthReadyInitialization(): void {
    queueMicrotask(() => {
      void this.ensureRuntimeAuthReady().catch(() => {
        // initAuthStateListener 失败不影响当前已登录状态
      });
    });
  }

  /**
   * 后台异步刷新 SDK session，确保 Supabase 客户端状态与本地缓存同步。
   * 不阻塞 UI，不影响用户操作。
   *
   * 【Bug 修复 2026-03-26】当后台刷新发现会话实际无效时（getSession 返回错误
   * 或无 user），清除 currentUserId 等状态，触发 showLoginRequired 兜底。
   * 否则用户看到"已登录"但所有 API 调用失败 → 永远无数据。
   */
  private scheduleBackgroundSessionRefresh(): void {
    this.scheduleBackgroundAuthTask(() => {
      void this.supabase.getSession()
        .then(result => this.backgroundSessionRefresh.handleResult(result))
        .catch((e: unknown) => this.backgroundSessionRefresh.handleError(e));
    });
  }

  private scheduleBackgroundAuthTask(task: () => void): void {
    if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
      (window as Window & { requestIdleCallback: (cb: () => void, opts?: { timeout: number }) => number })
        .requestIdleCallback(() => task(), { timeout: 3000 });
      return;
    }

    setTimeout(task, POLLING_CHECK_DELAY.CONDITION_READY);
  }

  private applyBackgroundSessionUser(user: AuthSessionUser): void {
    this.sessionStateWriter.applyAuthenticatedIdentity(user.id, user.email ?? null);
  }

  /**
   * 后台刷新发现会话确实无效时，清除 FastPath 乐观设置的状态。
   * 这会让 showLoginRequired 生效，触发登录兜底 UI。
   */
  private handleBackgroundSessionInvalid(): void {
    const invalidatedUserId = this.currentUserId();
    pushStartupTrace('auth.background_refresh_clear_local_session', {
      currentUserId: invalidatedUserId,
    });
    this.teardownInvalidatedSession('AuthService.backgroundRefresh');
  }

  /**
   * 区分认证错误和网络错误
   * 认证错误（会话失效）：必须清除本地状态
   * 网络错误（暂时离线）：保留本地缓存
   */
  private isAuthenticationError(error: unknown): boolean {
    return isAuthenticationErrorPure(error);
  }

  /**
   * 尝试开发环境自动登录
   * 
   * 设计理念：
   * - 保留 Guard 的存在，确保代码路径与生产环境一致
   * - 只是自动化登录过程，不是跳过登录
   * - 便于开发调试，同时不污染生产代码
   * 
   * @returns 登录成功返回用户信息，否则返回 null
   */
  private async tryDevAutoLogin(): Promise<{ userId: string | null; email: string | null } | null> {
    return await this.devAutoLogin.tryDevAutoLogin();
  }

  async signIn(email: string, password: string): Promise<Result<AuthResult, OperationError>> {
    if (!this.supabase.isConfigured) {
      return failure(
        ErrorCodes.SYNC_AUTH_EXPIRED,
        'Supabase 未配置。请设置 NG_APP_SUPABASE_URL 和 NG_APP_SUPABASE_ANON_KEY。'
      );
    }

    return await this.runCredentialRequest(() =>
      this.authCredentialRequests.signIn(email, password)
    );
  }

  /**
   * 注册
   * @returns Result 类型，成功时可能包含 needsConfirmation 标志
   */
  async signUp(email: string, password: string): Promise<Result<AuthResult, OperationError>> {
    if (!this.supabase.isConfigured) {
      return failure(
        ErrorCodes.SYNC_AUTH_EXPIRED,
        'Supabase 未配置。请设置 NG_APP_SUPABASE_URL 和 NG_APP_SUPABASE_ANON_KEY。'
      );
    }
    return await this.runCredentialRequest(async () => {
      await this.ensureRuntimeAuthReady();
      return await this.authCredentialRequests.signUp(email, password);
    });
  }

  /**
   * 重置密码（发送重置邮件）
   * @returns Result 类型
   */
  async resetPassword(email: string): Promise<Result<void, OperationError>> {
    if (!this.supabase.isConfigured) {
      return failure(ErrorCodes.SYNC_AUTH_EXPIRED, 'Supabase 未配置');
    }
    return await this.runCredentialRequest(async () => {
      await this.ensureRuntimeAuthReady();
      return await this.authCredentialRequests.resetPassword(email);
    });
  }

  private async runCredentialRequest<T extends AuthResult | void>(
    request: () => Promise<Result<T, OperationError>>,
  ): Promise<Result<T, OperationError>> {
    return await this.credentialFlow.run(request);
  }

  private applyCredentialIdentity(result: AuthResult): void {
    if (!result.userId) {
      return;
    }

    // signIn/signUp 不设置 currentUserId；handleLogin/setCurrentUser 负责真实用户切换与数据加载。
    const userEmail = result.email ?? null;
    this.sessionEmail.set(userEmail);
    this.authState.update(s => ({
      ...s,
      userId: result.userId ?? null,
      email: userEmail,
      error: null,
    }));
  }

  /**
   * 登出
   * 注意：先尝试 Supabase 远端登出，成功后才清理本地 auth artifacts。
   * 这样可以保留 refresh token 的远端撤销机会；失败由上层提示重试。
   */
  async signOut(): Promise<void> {
    // 标记为手动登出，避免触发 sessionExpired 提示
    this.isManualSignOut = true;
    const signedOutUserId = this.currentUserId();

    try {
      if (this.supabase.isConfigured) {
        await this.supabase.signOut();
      }
    } catch (e) {
      if (this.supabase.isConfigured) {
        this.logger.warn('Supabase signOut failed', { error: e });
      }
      this.isManualSignOut = false;
      throw e;
    }

    this.sessionStateWriter.clearInvalidatedSession({
      keepLocalModeUser: false,
      localModeUserId: AUTH_CONFIG.LOCAL_MODE_USER_ID,
    });
    this.sessionExpired.set(false);
    this.clearCachedSessionArtifacts();
    // 通知订阅方丢弃旧会话身份缓存（如 SessionManager 校验快照），
    // 否则登出后 10s 内的 resume 快路仍会按旧 userId 放行恢复链路
    this.eventBus.publishSessionSignedOut('AuthService.signOut', signedOutUserId);
  }

  /**
   * 清除错误
   */
  clearError() {
    this.authState.update(s => ({ ...s, error: null }));
  }
  
  // ========== 显式状态重置（用于测试和 HMR）==========
  
  /**
   * 显式重置服务状态
   * 用于测试环境的 afterEach 或 HMR 重载
   */
  reset(): void {
    if (typeof window !== 'undefined') {
      window.removeEventListener('storage', this.storageListener);
    }
    this.pendingStorageBridgeSessionIdentity = null;
    this.isManualSignOut = false;
    this.devAutoLogin.reset();
    this.authRuntimeReady = false;
    this.pendingSessionRestoredNotification = false;
    this.authStateSubscription?.unsubscribe();
    this.authStateSubscription = null;
    this.runtimeAuthReadyPromise = null;
    this.sessionStateWriter.reset({
      runtimeState: this.supabase.isConfigured ? 'idle' : 'ready',
    });
  }
  
  // ==================== 私有方法 ====================
  
  /**
   * 初始化认证状态监听
   * 
   * 监听 Supabase 的 onAuthStateChange 事件：
   * - SIGNED_OUT: 用户登出（检测是否为 Token 过期）
   * - TOKEN_REFRESHED: Token 刷新成功
   * - SIGNED_IN: 用户登录
   * - USER_UPDATED: 用户信息更新
   */
  private async initAuthStateListener(): Promise<void> {
    if (!this.supabase.isConfigured) {
      this.logger.debug('Supabase 未配置，跳过认证状态监听');
      return;
    }

    if (this.authStateSubscription) {
      return;
    }
    
    const client = await this.supabase.clientAsync();
    if (!client) {
      this.logger.warn('Supabase 客户端未就绪，跳过认证状态监听初始化');
      return;
    }
    
    const { data } = client.auth.onAuthStateChange((event, session) => {
      this.logger.debug('认证状态变更', { event, hasSession: !!session });
      
      switch (event) {
        case 'SIGNED_OUT':
          this.handleSignedOut();
          break;
          
        case 'TOKEN_REFRESHED':
          this.handleTokenRefreshed(session);
          break;
          
        case 'SIGNED_IN':
          this.handleSignedIn(session);
          break;
          
        case 'USER_UPDATED':
          if (session?.user) {
            this.logger.debug('用户信息已更新', { userId: session.user.id });
          }
          break;
      }
    });
    
    this.authStateSubscription = data.subscription;
  }

  private initStorageBridge(): void {
    if (typeof window === 'undefined' || !this.storageKey) {
      return;
    }

    window.addEventListener('storage', this.storageListener);
  }

  private handleStorageEvent(event: StorageEvent): void {
    this.storageBridgeController.handleStorageEvent(event);
  }

  private resolveInvalidatedOwnerUserId(currentUserId = this.currentUserId()): string | null {
    return resolveInvalidatedOwnerUserIdPure({
      localModeUserId: AUTH_CONFIG.LOCAL_MODE_USER_ID,
      currentUserId,
      persistedSessionUserId: this.persistedSessionUserId(),
      persistedOwnerHint: this.persistedOwnerHint(),
    });
  }

  private clearCachedSessionArtifacts(): void {
    this.pendingStorageBridgeSessionIdentity = null;
    this.authSessionCache.clearCachedSessionArtifacts();
  }

  private teardownInvalidatedSession(source: string): { invalidatedUserId: string | null; keepLocalModeUser: boolean } {
    const currentUserId = this.currentUserId();
    const keepLocalModeUser = currentUserId === AUTH_CONFIG.LOCAL_MODE_USER_ID;
    const invalidatedUserId = this.resolveInvalidatedOwnerUserId(currentUserId);

    // 中文注释：先同步广播 teardown，让 WorkspaceShell 立即停写 launch snapshot，
    // 再清空 auth signal，避免旧 owner 项目摘要落进 anonymous bucket。
    if (invalidatedUserId) {
      this.pendingSessionRestoredNotification = true;
      this.eventBus.publishSessionInvalidated(source, invalidatedUserId);
    }

    this.sessionStateWriter.clearInvalidatedSession({
      keepLocalModeUser,
      localModeUserId: AUTH_CONFIG.LOCAL_MODE_USER_ID,
    });

    return { invalidatedUserId, keepLocalModeUser };
  }
  
  /**
   * 处理登出事件
   * 区分用户主动登出和 Token 过期
   */
  private handleSignedOut(): void {
    if (this.isManualSignOut) {
      this.logger.info('用户主动登出');
      // 重置标志
      this.isManualSignOut = false;
    } else if (this.currentUserId() && this.currentUserId() !== AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      // 仅当之前存在已登录用户时，才视为会话过期
      // 防止启动阶段 Supabase 触发的初始 SIGNED_OUT 事件被误判为过期
      this.logger.warn('检测到非主动登出，Token 过期');
      this.handleSessionExpired();
    } else {
      // 未登录状态下收到 SIGNED_OUT，非真正过期，仅记录日志
      this.logger.debug('忽略 SIGNED_OUT 事件：当前无已登录用户，非会话过期');
    }
  }
  
  /**
   * 处理会话过期
   * 
   * 【Week 8-9 数据保护 - JWT 刷新失败监听】
   */
  private handleSessionExpired(): void {
    this.teardownInvalidatedSession('AuthService.signedOut');
    this.sessionExpired.set(true);
    
    // 显示重新登录提示
    this.toast.warning('登录已过期', '请重新登录以继续同步数据', { duration: 0 });
    
    this.logger.warn('会话已过期，需要重新登录');
  }
  
  /**
   * 处理 Token 刷新成功
   */
  private handleTokenRefreshed(session: { user?: { id: string; email?: string | null } } | null): void {
    this.logger.debug('Token 刷新成功');

    // 更新会话信息
    if (session?.user) {
      this.applyConfirmedSessionIdentity(session.user.id, session.user.email ?? null, {
        publishSessionRestored: true,
        source: 'AuthService',
      });
    }
  }
  
  /**
   * 处理登录成功
   */
  private handleSignedIn(session: { user?: { id: string; email?: string | null } } | null): void {
    if (session?.user) {
      this.logger.info('用户已登录', { userId: session.user.id });
      if (this.pendingStorageBridgeSessionIdentity?.userId === session.user.id && this.currentUserId() !== session.user.id) {
        this.pendingStorageBridgeSessionIdentity = {
          userId: session.user.id,
          email: session.user.email ?? null,
        };
        this.setPersistedOwnerHint(session.user.id);
        return;
      }

      this.pendingStorageBridgeSessionIdentity = null;
      this.applyConfirmedSessionIdentity(session.user.id, session.user.email ?? null, {
        publishSessionRestored: true,
        source: 'AuthService',
      });
    }
  }

  completeCrossTabSessionRestore(userId: string): void {
    if (this.currentUserId() !== userId) {
      return;
    }

    const sessionIdentity = this.peekPersistedSessionIdentity();
    if (!sessionIdentity || sessionIdentity.userId !== userId) {
      return;
    }

    this.pendingStorageBridgeSessionIdentity = null;
    this.applyConfirmedSessionIdentity(userId, sessionIdentity.email ?? null);
  }

  private applyConfirmedSessionIdentity(
    userId: string,
    email: string | null,
    options?: {
      publishSessionRestored?: boolean;
      source?: string;
    },
  ): void {
    this.sessionStateWriter.applyAuthenticatedIdentity(userId, email, {
      isCheckingSession: false,
      syncSentryUser: true,
    });

    const shouldPublishSessionRestored = options?.publishSessionRestored
      && (this.sessionExpired() || this.pendingSessionRestoredNotification);

    if (this.sessionExpired()) {
      this.sessionExpired.set(false);
    }

    if (shouldPublishSessionRestored) {
      this.pendingSessionRestoredNotification = false;
      this.notifySyncServiceSessionRestored(userId, options?.source ?? 'AuthService');
    }

  }
  
  /**
   * 通知会话已恢复
   * 
   * 【技术债务修复 2026-01-31】
   * 使用 EventBusService 替代 injector hack，彻底解决循环依赖
   */
  private notifySyncServiceSessionRestored(userId = this.authState().userId, source = 'AuthService'): void {
    if (userId) {
      this.eventBus.publishSessionRestored(userId, source);
    }
  }
}
