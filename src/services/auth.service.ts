import { Injectable, inject, signal, DestroyRef } from '@angular/core';
import { SupabaseClientService } from './supabase-client.service';
import { EventBusService } from './event-bus.service';
import { Result, OperationError, ErrorCodes, failure } from '../utils/result';
import { environment } from '../environments/environment';
import { ToastService } from './toast.service';
import { LoggerService } from './logger.service';
import { isLocalModeEnabled } from './guards/auth.guard';
import { pushStartupTrace } from '../utils/startup-trace';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { AUTH_CONFIG } from '../config/auth.config';
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
import { AuthSessionStateWriter, type ApplyAuthenticatedIdentityOptions } from './auth-session-state-writer';
import { AuthBackgroundSessionRefreshController } from './auth-background-session-refresh.controller';
import { AuthStorageBridgeController } from './auth-storage-bridge.controller';
import { AuthDevAutoLoginController } from './auth-dev-auto-login.controller';
import { AuthCredentialFlowController, type AuthCredentialStateCommitPredicate } from './auth-credential-flow.controller';
import { AuthSessionCheckController } from './auth-session-check.controller';
import { AuthSessionRestoreController, type ApplyConfirmedSessionIdentityOptions } from './auth-session-restore.controller';
import { AuthCredentialSessionFenceController } from './auth-credential-session-fence.controller';
import { AuthExplicitSignOutController } from './auth-explicit-sign-out.controller';
import { AuthOwnerTransitionController, bindAuthOwnerTransition } from './auth-owner-transition.controller';
import { getCanonicalAuthStorageAuthority } from './supabase-auth-client-lifecycle.controller';
export type { AuthResult } from './auth-types';
export interface AuthState {
  isCheckingSession: boolean;
  isLoading: boolean;
  userId: string | null;
  email: string | null;
  error: string | null;
}

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
  private authListenerLifecycleGeneration = 0;
  private authIdentityGeneration = 0;
  private destroyed = false;
  private readonly storageKey = this.supabase.getStorageKey();
  private readonly credentialSessionFence = new AuthCredentialSessionFenceController({
    isConfigured: () => this.supabase.isConfigured,
    runSignInRequest: (email, password, requestId, canCommitCredentialState) =>
      this.runCredentialRequest(
        () => this.authCredentialRequests.signIn(email, password, requestId),
        canCommitCredentialState,
      ),
    runSignUpRequest: (email, password, canCommitCredentialState, afterSessionCommit) =>
      this.runCredentialRequest(
        () => this.authCredentialRequests.signUp(
          email, password, canCommitCredentialState, afterSessionCommit,
        ),
        canCommitCredentialState,
      ),
    captureAuthIdentityFence: () => this.captureAuthIdentityFence(),
    authorizeSignupAdoption: (session, authorize) => this.supabase.authorizeSignupAdoption(session, authorize),
    restartAuthRuntime: () => this.restartAuthRuntimeForStorageAdoption(),
    storageKey: () => this.storageKey,
    currentUserId: () => this.currentUserId(),
    consumeCredentialRequestBinding: accessToken =>
      this.supabase.consumeCredentialRequestIdForAccessToken(accessToken),
    pendingStorageBridgeUserId: () => this.pendingStorageBridgeSessionIdentity?.userId ?? null,
    deferStorageBridgeIdentity: (userId, email) => {
      this.pendingStorageBridgeSessionIdentity = { userId, email };
      this.setPersistedOwnerHint(userId);
    },
    clearPendingStorageBridgeIdentity: () => {
      this.pendingStorageBridgeSessionIdentity = null;
    },
    applyConfirmedSessionIdentity: (userId, email) =>
      this.applyConfirmedSessionIdentity(userId, email, {
        publishSessionRestored: true,
        source: 'AuthService',
      }),
    clearCachedSessionArtifacts: () => this.clearCachedSessionArtifacts(),
    sessionExpired: () => this.sessionExpired(),
    syncPersistedOwnerHintFromStorage: () => this.syncPersistedOwnerHintFromStorage(),
    syncPersistedSessionUserIdFromStorage: () => this.syncPersistedSessionUserIdFromStorage(),
    debug: message => this.logger.debug(message),
    info: (message, data) => this.logger.info(message, data),
    warn: (message, data) => this.logger.warn(message, data),
  });
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
      this.ownerTransition.advanceGeneration();
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
  private readonly ownerTransition = bindAuthOwnerTransition(this, new AuthOwnerTransitionController({
    generation: () => this.authIdentityGeneration,
    currentOwnerUserId: () => this.currentUserId(),
    pendingOwnerUserId: () => this.pendingStorageBridgeSessionIdentity?.userId ?? null,
    advanceGeneration: () => { this.authIdentityGeneration += 1; },
    publishTargetOwner: ownerUserId => this.currentUserId.set(ownerUserId),
  }));
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
  private readonly sessionRestore = new AuthSessionRestoreController({
    advanceAuthIdentityGeneration: () => this.ownerTransition.advanceGeneration(),
    applyAuthenticatedIdentity: (userId, email) =>
      this.sessionStateWriter.applyAuthenticatedIdentity(userId, email, {
        isCheckingSession: false,
        syncSentryUser: true,
      }),
    captureAuthIdentityFence: () => this.captureAuthIdentityFence(),
    clearPendingStorageBridgeSessionIdentity: () => {
      this.pendingStorageBridgeSessionIdentity = null;
    },
    currentUserId: () => this.currentUserId(),
    localModeUserId: AUTH_CONFIG.LOCAL_MODE_USER_ID,
    pendingSessionRestoredNotification: () => this.pendingSessionRestoredNotification,
    peekPersistedSessionIdentity: () => this.peekPersistedSessionIdentity(),
    publishSessionRestored: (userId, source) =>
      this.notifySyncServiceSessionRestored(userId, source),
    sessionExpired: () => this.sessionExpired(),
    sessionRecoveryRequired$: this.eventBus.onSessionRecoveryRequired$,
    setPendingSessionRestoredNotification: value => { this.pendingSessionRestoredNotification = value; },
    setSessionExpired: value => this.sessionExpired.set(value),
  });
  private readonly backgroundSessionRefresh = new AuthBackgroundSessionRefreshController({
    storageKey: () => this.storageKey,
    canonicalBundle: () => {
      const authority = getCanonicalAuthStorageAuthority();
      return authority && this.storageKey ? authority.peekBundle(this.storageKey) : null;
    },
    currentUserId: () => this.currentUserId(),
    pendingOwnerUserId: () => this.pendingStorageBridgeSessionIdentity?.userId ?? null,
    runtimeState: () => this.runtimeState(),
    authIdentityGeneration: () => this.authIdentityGeneration,
    destroyed: () => this.destroyed,
    getSession: () => this.supabase.getSession(),
    applySessionUser: (user) => {
      this.sessionStateWriter.applyAuthenticatedIdentity(user.id, user.email ?? null);
      this.ownerTransition.advanceGeneration();
    },
    invalidateSession: () => {
      const invalidatedUserId = this.currentUserId();
      pushStartupTrace('auth.background_refresh_clear_local_session', {
        currentUserId: invalidatedUserId,
      });
      this.teardownInvalidatedSession('AuthService.backgroundRefresh');
    },
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
    peekPersistedSessionIdentity: () => this.peekPersistedSessionIdentity(),
    sessionExpired: () => this.sessionExpired(),
    pendingStorageBridgeSessionIdentity: () => this.pendingStorageBridgeSessionIdentity,
    setPendingStorageBridgeSessionIdentity: (identity) => { this.pendingStorageBridgeSessionIdentity = identity; },
    setPersistedOwnerHint: (userId) => this.setPersistedOwnerHint(userId),
    syncPersistedOwnerHintFromStorage: () => this.syncPersistedOwnerHintFromStorage(),
    syncPersistedSessionUserIdFromStorage: () => this.syncPersistedSessionUserIdFromStorage(),
    resolvePersistedSessionIdentityFromAuthData: (authData) => this.resolvePersistedSessionIdentityFromAuthData(authData),
    captureAcceptedSession: session => this.credentialSessionFence.captureAcceptedPersistedSession(session),
    applyConfirmedSessionIdentity: (userId, email, options) => this.applyConfirmedSessionIdentity(userId, email, options),
    publishSessionRestored: (userId, source) => this.eventBus.publishSessionRestored(userId, source),
    teardownInvalidatedSession: (source) => this.teardownInvalidatedSession(source),
    readCanonicalBundle: () => this.readCanonicalBundle(),
    restartAuthRuntimeForStorageAdoption: () => this.restartAuthRuntimeForStorageAdoption(),
    debug: (message, data) => this.logger.debug(message, data),
  });
  private readonly devAutoLogin = new AuthDevAutoLoginController({
    devAutoLogin: (environment as {
      devAutoLogin?: { email: string; password: string } | null;
    }).devAutoLogin,
    production: (environment as { production?: boolean }).production,
    signIn: (email, password, canCommitCredentialState) => this.signInWithCredentialCommitPredicate(email, password, canCommitCredentialState),
    debug: (message, data) => this.logger.debug(message, data),
    info: (message, data) => this.logger.info(message, data),
    warn: (message, data) => this.logger.warn(message, data),
  });
  private readonly sessionCheck = new AuthSessionCheckController({
    isSupabaseConfigured: () => this.supabase.isConfigured,
    authState: this.authState,
    sessionInitialized: this.sessionInitialized,
    currentUserId: () => this.currentUserId(),
    pendingOwnerUserId: () => this.pendingStorageBridgeSessionIdentity?.userId ?? null,
    sessionEmail: () => this.sessionEmail(),
    authIdentityGeneration: () => this.authIdentityGeneration,
    runtimeState: () => this.runtimeState(),
    readLocalSessionFastPath: () => this.authSessionCache.readPersistedSessionIdentity(true),
    isBrowserNetworkSuspendedWindow: () => isBrowserNetworkSuspendedWindow(),
    isBrowserNetworkSuspendedError: (error) => isBrowserNetworkSuspendedError(error),
    ensureRuntimeAuthReady: () => this.ensureRuntimeAuthReady(),
    getSession: () => this.supabase.getSession(),
    tryDevAutoLogin: (canCommitCredentialState) => this.tryDevAutoLogin(canCommitCredentialState),
    applyAuthenticatedIdentity: (userId, email, options) => {
      this.applySessionCheckIdentity(userId, email, options);
    },
    setPersistedOwnerHint: (userId) => this.setPersistedOwnerHint(userId),
    setPersistedSessionUserId: (userId) => this.setPersistedSessionUserId(userId),
    setProvisionalAuthState: (state) => this.setProvisionalAuthState(state),
    scheduleBackgroundSessionRefresh: () => this.backgroundSessionRefresh.schedule(),
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
  private readonly explicitSignOut = new AuthExplicitSignOutController({
    isConfigured: () => this.supabase.isConfigured,
    ensureRuntimeAuthReady: () => this.ensureRuntimeAuthReady(),
    hasActiveAuthListener: () => this.authStateSubscription !== null,
    hasCurrentAuthClient: () => {
      try { this.supabase.client(); return true; } catch { return false; }
    },
    captureOwnerFence: () => {
      const currentOwner = this.currentUserId();
      const pendingOwner = this.pendingStorageBridgeSessionIdentity?.userId ?? null;
      const canonicalOwner = this.peekPersistedOwnerHint();
      const fenceOwner = currentOwner && canonicalOwner !== pendingOwner
        ? canonicalOwner ?? currentOwner
        : currentOwner;
      return `${this.captureAuthIdentityFence()}:${fenceOwner ?? ''}:${pendingOwner ?? ''}`;
    },
    currentUserId: () => this.currentUserId(),
    captureRevocation: () => this.credentialSessionFence.captureExplicitSignOutRevocation(),
    signOutRemote: () => this.supabase.signOut(),
    finalize: async (signedOutUserId, commitRevocation, isCurrent) => {
      await commitRevocation();
      const authority = getCanonicalAuthStorageAuthority();
      const bundle = authority && this.storageKey
        ? authority.peekBundle(this.storageKey)
        : null;
      if (!isCurrent() || (this.storageKey && (
        !bundle || bundle.session !== null
        || bundle.codeVerifier !== null || bundle.user !== null
      ))) return false;
      this.sessionStateWriter.clearInvalidatedSession({
        keepLocalModeUser: false,
        localModeUserId: AUTH_CONFIG.LOCAL_MODE_USER_ID,
      });
      this.ownerTransition.advanceGeneration();
      this.sessionExpired.set(false);
      this.clearCachedSessionArtifacts();
      this.eventBus.publishSessionSignedOut('AuthService.signOut', signedOutUserId);
      return true;
    },
    warn: (message, error) => this.logger.warn(message, { error }),
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
      this.destroyed = true;
      this.authListenerLifecycleGeneration += 1;
      this.ownerTransition.destroy();
      this.explicitSignOut.reset();
      this.credentialSessionFence.reset();
      this.storageBridgeController.reset();
      this.backgroundSessionRefresh.cancelPending();
      this.authStateSubscription?.unsubscribe();
      this.authStateSubscription = null;
      this.sessionRestore.destroy();
      if (typeof window !== 'undefined') {
        window.removeEventListener('storage', this.storageListener);
      }
    });
  }
  async ensureRuntimeAuthReady(): Promise<void> {
    if (this.destroyed) {
      return;
    }
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
    const listenerGeneration = this.authListenerLifecycleGeneration;
    let resolveListener!: () => void, rejectListener!: (error: unknown) => void;
    const readyPromise = new Promise<void>((resolve, reject) => { resolveListener = resolve; rejectListener = reject; })
      .then(() => {
        if (!this.isAuthListenerLifecycleCurrent(listenerGeneration)
          || !this.authStateSubscription) {
          return;
        }
        this.authRuntimeReady = true;
        this.setProvisionalAuthState('ready');
      })
      .catch((error) => {
        if (this.isAuthListenerLifecycleCurrent(listenerGeneration)) {
          this.setProvisionalAuthState('failed');
        }
        throw error;
      })
      .finally(() => {
        if (this.runtimeAuthReadyPromise === readyPromise) {
          this.runtimeAuthReadyPromise = null;
        }
      });
    this.runtimeAuthReadyPromise = readyPromise;
    void this.initAuthStateListener(listenerGeneration).then(resolveListener, rejectListener);
    return readyPromise;
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
  private checkSessionPromiseFence: string | null = null;
  async checkSession(): Promise<{ userId: string | null; email: string | null }> {
    pushStartupTrace('auth.check_session', {
      runtimeState: this.runtimeState(),
      sessionInitialized: this.sessionInitialized(),
      currentUserId: this.currentUserId(),
    });
    const checkFence = this.captureAuthIdentityFence();
    if (this.checkSessionPromise && this.checkSessionPromiseFence === checkFence) {
      return this.checkSessionPromise;
    }
    const checkSessionPromise = this.sessionCheck.checkSession();
    this.checkSessionPromise = checkSessionPromise;
    this.checkSessionPromiseFence = checkFence;
    try {
      return await checkSessionPromise;
    } finally {
      if (this.checkSessionPromise === checkSessionPromise) {
        this.checkSessionPromise = null;
        this.checkSessionPromiseFence = null;
      }
    }
  }
  captureAuthIdentityFence(): string {
    return `${this.authIdentityGeneration}:${this.currentUserId() ?? ''}:${this.pendingStorageBridgeSessionIdentity?.userId ?? ''}`;
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

  private readCanonicalBundle() {
    const authority = getCanonicalAuthStorageAuthority();
    if (!authority || !this.storageKey) throw new Error('AUTH_CANONICAL_AUTHORITY_UNAVAILABLE');
    return authority.readBundle(this.storageKey);
  }

  private async restartAuthRuntimeForStorageAdoption(): Promise<void> {
    this.authListenerLifecycleGeneration += 1;
    this.authStateSubscription?.unsubscribe();
    this.authStateSubscription = null;
    this.authRuntimeReady = false;
    this.runtimeAuthReadyPromise = null;
    this.supabase.reset();
    await this.ensureRuntimeAuthReady();
    if (!this.authStateSubscription) throw new Error('AUTH_LISTENER_UNAVAILABLE');
  }
  private scheduleRuntimeAuthReadyInitialization(): void {
    queueMicrotask(() => {
      void this.ensureRuntimeAuthReady().catch(() => {
        // initAuthStateListener 失败不影响当前已登录状态
      });
    });
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
  private async tryDevAutoLogin(canCommitCredentialState: AuthCredentialStateCommitPredicate): Promise<{ userId: string | null; email: string | null } | null> {
    return await this.devAutoLogin.tryDevAutoLogin(canCommitCredentialState);
  }
  async signIn(
    email: string,
    password: string,
    canCommitCredentialState?: AuthCredentialStateCommitPredicate,
  ): Promise<Result<AuthResult, OperationError>> {
    return await this.signInWithCredentialCommitPredicate(email, password, canCommitCredentialState);
  }

  private async signInWithCredentialCommitPredicate(
    email: string, password: string, canCommitCredentialState?: AuthCredentialStateCommitPredicate,
  ): Promise<Result<AuthResult, OperationError>> {
    return await this.credentialSessionFence.signIn(email, password, canCommitCredentialState);
  }

  async signUp(
    email: string,
    password: string,
    canCommitCredentialState?: AuthCredentialStateCommitPredicate,
  ): Promise<Result<AuthResult, OperationError>> {
    return await this.credentialSessionFence.signUp(email, password, canCommitCredentialState);
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
    request: () => Promise<Result<T, OperationError>>, canCommitCredentialState?: AuthCredentialStateCommitPredicate,
  ): Promise<Result<T, OperationError>> {
    return await this.credentialFlow.run(request, canCommitCredentialState);
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
  signOut(): Promise<boolean> {
    this.credentialSessionFence.cancelPendingSignupInitialSessionAdoption();
    return this.explicitSignOut.signOut();
  }
  restartRuntimeAfterAuthCallback(): Promise<void> { return this.restartAuthRuntimeForStorageAdoption(); }
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
    this.authListenerLifecycleGeneration += 1;
    this.ownerTransition.reset();
    this.explicitSignOut.reset();
    this.credentialSessionFence.reset();
    this.storageBridgeController.reset();
    this.backgroundSessionRefresh.cancelPending();
    this.sessionRestore.clearPendingSyncSessionRecovery();
    if (typeof window !== 'undefined') {
      window.removeEventListener('storage', this.storageListener);
    }
    this.pendingStorageBridgeSessionIdentity = null;
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
  private async initAuthStateListener(listenerGeneration: number): Promise<void> {
    if (!this.isAuthListenerLifecycleCurrent(listenerGeneration)) {
      return;
    }
    if (!this.supabase.isConfigured) {
      this.logger.debug('Supabase 未配置，跳过认证状态监听');
      return;
    }
    if (this.authStateSubscription) {
      return;
    }
    const client = await this.supabase.clientAsync();
    if (!this.isAuthListenerLifecycleCurrent(listenerGeneration)) {
      return;
    }
    if (!client) {
      this.logger.warn('Supabase 客户端未就绪，跳过认证状态监听初始化');
      return;
    }
    const { data } = client.auth.onAuthStateChange((event, session) => {
      if (!this.isAuthListenerLifecycleCurrent(listenerGeneration)) {
        return;
      }
      this.logger.debug('认证状态变更', { event, hasSession: !!session });
      switch (event) {
        case 'SIGNED_OUT':
          this.handleSignedOut();
          break;
        case 'TOKEN_REFRESHED':
          this.credentialSessionFence.handleTokenRefreshed(session);
          break;
        case 'SIGNED_IN':
          this.credentialSessionFence.handleSignedIn(session);
          break;
        case 'INITIAL_SESSION':
          if (this.credentialSessionFence.shouldApplyInitialSession(session)) this.storageBridgeController.handleInitialSession(session);
          break;
        case 'USER_UPDATED':
          if (session?.user) {
            this.logger.debug('用户信息已更新', { userId: session.user.id });
          }
          break;
      }
    });
    if (!this.isAuthListenerLifecycleCurrent(listenerGeneration)) {
      data.subscription.unsubscribe();
      return;
    }
    this.authStateSubscription = data.subscription;
  }
  private isAuthListenerLifecycleCurrent(listenerGeneration: number): boolean {
    return !this.destroyed && this.authListenerLifecycleGeneration === listenerGeneration;
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

  private applySessionCheckIdentity(
    userId: string,
    email: string | null,
    options?: ApplyAuthenticatedIdentityOptions,
  ): void {
    this.sessionStateWriter.applyAuthenticatedIdentity(userId, email, options);
    this.ownerTransition.advanceGeneration();
  }

  private teardownInvalidatedSession(source: string): { invalidatedUserId: string | null; keepLocalModeUser: boolean } {
    const clearCanonicalSession = this.authSessionCache.captureCanonicalSessionRemoval();
    this.ownerTransition.advanceGeneration();
    this.credentialSessionFence.clearAcceptedPersistedSession();
    this.sessionRestore.clearPendingSyncSessionRecovery();
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
    void clearCanonicalSession();

    return { invalidatedUserId, keepLocalModeUser };
  }
  
  /**
   * 处理登出事件
   * 区分用户主动登出和 Token 过期
   */
  private handleSignedOut(): void {
    this.credentialSessionFence.cancelPendingSignupInitialSessionAdoption();
    if (this.explicitSignOut.observeSignedOut()) {
      this.logger.info('用户主动登出');
    } else if (this.storageBridgeController.shouldDeferSignedOutInvalidation()) {
      this.logger.info('检测到跨标签页 pending owner handoff，忽略旧会话 SIGNED_OUT');
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
  
  completeCrossTabSessionRestore(userId: string): void {
    this.sessionRestore.completeCrossTabSessionRestore(userId);
  }
  private applyConfirmedSessionIdentity(
    userId: string,
    email: string | null,
    options?: ApplyConfirmedSessionIdentityOptions,
  ): void {
    this.sessionRestore.applyConfirmedSessionIdentity(userId, email, options);
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
