import { DestroyRef, Injectable, inject, signal, computed, Injector } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { AuthService } from '../../../services/auth.service';
import { UserSessionService } from '../../../services/user-session.service';
import { ProjectStateService } from '../../../services/project-state.service';
import { ModalService } from '../../../services/modal.service';
import { ToastService } from '../../../services/toast.service';
import { LoggerService } from '../../../services/logger.service';
import { OptimisticStateService } from '../../../services/optimistic-state.service';
import { UndoService } from '../../../services/undo.service';
import { WidgetBindingService } from '../../../services/widget-binding.service';
import { enableLocalMode, disableLocalMode } from '../../../services/guards';
import { humanizeErrorMessage, isFailure } from '../../../utils/result';
import { AUTH_CONFIG } from '../../../config/auth.config';
import { FEATURE_FLAGS } from '../../../config/feature-flags.config';
import type { AttachmentService } from '../../../services/attachment.service';
import type { MigrationService } from '../../../services/migration.service';
import type { ProjectDataService } from './sync/project-data.service';
import { EventBusService, type SessionInvalidatedEvent } from '../../../services/event-bus.service';
import { SyncStateService } from './sync/sync-state.service';
import { pushStartupTrace } from '../../../utils/startup-trace';
import { AppAuthSignOutController } from './app-auth-sign-out.controller';
import { AppAuthPostLoginController } from './app-auth-post-login.controller';
import {
  buildSuccessfulLoginCompletionPlan,
  type AuthFormStatePatch,
  createAppAuthLazyServiceSlot,
  getAuthCredentialPreflightError,
  getAuthFlowErrorMessage,
  getAuthFormModePatch,
  getAuthFailureMessage,
  isAuthLoadCurrent,
  resolveAppAuthLazyService,
  resolveSafePostAuthNavigationTarget,
  shouldShowLoginRequired,
  shouldShowSettingsAuthForm,
  waitForPromiseOrTimeout,
} from './app-auth-coordinator.helpers';

@Injectable({ providedIn: 'root' })
export class AppAuthCoordinatorService {
  /** 启动阶段等待用户数据加载的最大时长（超时后转后台继续） */
  private readonly BOOTSTRAP_DATA_LOAD_TIMEOUT_MS = AUTH_CONFIG.SESSION_CHECK_TIMEOUT;

  private readonly logger = inject(LoggerService).category('Auth');
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);
  private readonly auth = inject(AuthService);
  private readonly userSession = inject(UserSessionService);
  private readonly projectState = inject(ProjectStateService);
  private readonly modal = inject(ModalService);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);
  private readonly optimisticState = inject(OptimisticStateService);
  private readonly undoService = inject(UndoService);
  private readonly widgetBinding = inject(WidgetBindingService);
  private readonly eventBus = inject(EventBusService);
  private readonly syncState = inject(SyncStateService);
  private readonly attachmentServiceLazy = createAppAuthLazyServiceSlot<AttachmentService>();
  private readonly migrationServiceLazy = createAppAuthLazyServiceSlot<MigrationService>();
  private readonly projectDataServiceLazy = createAppAuthLazyServiceSlot<ProjectDataService>();
  private readonly signOutController = new AppAuthSignOutController({
    currentUserId: () => this.auth.currentUserId(),
    captureAuthIdentityFence: () => this.auth.captureAuthIdentityFence(),
    isAuthConfigured: () => this.auth.isConfigured,
    revokeWidgetBindings: () => this.widgetBinding.revokeAllBindings(),
    signOutRemoteSession: () => this.auth.signOut(),
    notifyLocalLogoutServices: () => this.notifyLocalServicesForSignOut(),
    setCurrentUser: (userId, options) => this.userSession.setCurrentUser(userId, options),
    clearAllLocalData: userId => this.userSession.clearAllLocalData(userId),
    resetAuthFormState: () => this.resetAuthFormStateAfterSignOut(),
    logError: (message, error) => this.logger.error(message, error),
    logWarn: (message, error) => this.logger.warn(message, error),
    showError: (title, message) => this.toast.error(title, message),
    showWarning: (title, message) => this.toast.warning(title, message),
  });
  private readonly postLoginController = new AppAuthPostLoginController({
    storeCurrentUserId: userId => localStorage.setItem('currentUserId', userId),
    loadPostAuthUserData: (userId, previousUserIdHint) =>
      this.loadPostAuthUserDataWithTimeout(userId, '[Login]', previousUserIdHint),
    isAuthSubmissionCurrent: (generation, allowedCurrentUserIds) =>
      this.isAuthSubmissionCurrent(generation, allowedCurrentUserIds),
    showLoginSuccess: () => this.toast.success('登录成功', '欢迎回来'),
    nextMigrationGeneration: () => ++this.migrationCheckGeneration,
    setReloginMode: enabled => this.isReloginMode.set(enabled),
    finishSuccessfulLogin: (userId, options) => this.finishSuccessfulLogin(userId, options),
    currentMigrationGeneration: () => this.migrationCheckGeneration,
    currentUserId: () => this.userSession.currentUserId(),
    localModeUserId: AUTH_CONFIG.LOCAL_MODE_USER_ID,
    getMigrationService: () => this.getMigrationServiceLazy(),
    getProjectDataService: () => this.getProjectDataServiceLazy(),
    warn: (message, error) => error === undefined
      ? this.logger.warn(message) : this.logger.warn(message, error),
    showMigrationModal: () => this.modal.show('migration'),
  });

  // ========== 认证状态 Signals ==========
  readonly authEmail = signal('');
  readonly authPassword = signal('');
  readonly authConfirmPassword = signal('');
  readonly authError = signal<string | null>(null);
  readonly isAuthLoading = signal(false);
  readonly isCheckingSession = signal(false);
  readonly bootstrapFailed = signal(false);
  readonly bootstrapErrorMessage = signal<string | null>(null);
  readonly sessionEmail = signal<string | null>(null);
  readonly isReloginMode = signal(false);
  readonly isSignupMode = signal(false);
  readonly isResetPasswordMode = signal(false);
  readonly resetPasswordSent = signal(false);

  /** 显示未登录提示界面 */
  readonly showLoginRequired = computed(() => {
    return shouldShowLoginRequired({
      isConfigured: this.auth.isConfigured,
      runtimeState: this.auth.runtimeState(),
      sessionInitialized: this.auth.sessionInitialized(),
      currentUserId: this.userSession.currentUserId(),
      isLoginModalOpen: this.modal.isOpen('login'),
      isCheckingSession: this.isCheckingSession(),
      bootstrapFailed: this.bootstrapFailed(),
    });
  });

  /** 设置页认证表单是否可见 */
  readonly showSettingsAuthForm = computed(() =>
    shouldShowSettingsAuthForm(this.userSession.currentUserId(), this.isReloginMode()));

  /** 会话引导任务是否已调度 */
  private bootstrapScheduled = false;
  /** 会话引导是否正在执行（防并发） */
  private bootstrapInFlight = false;
  /**
   * 冷启动静默标记：首次 bootstrap 期间不显示"会话检测中"UI。
   * 冷启动时快照已预填充内容，auth 在后台完成即可，用户无需感知。
   * 首次 bootstrap 结束后置为 false，后续 retry 正常显示指示器。
   */
  private coldBootSilent = true;
  /** 登录/启动相关后台数据加载代次；切账号/登出时递增，使旧后台收尾失效 */
  private authLoadGeneration = 0;
  /** 登录后迁移探测的会话代次；每次登录/登出切换都会递增以作废旧探测 */
  private migrationCheckGeneration = 0;
  /** 登录表单提交代次；与数据加载代次独立，防止迟到认证结果提交旧 owner。 */
  private authSubmissionGeneration = 0;
  private activeLoginSubmissionGeneration: number | null = null;
  private destroyed = false;

  constructor() {
    this.registerSessionInvalidationTeardown();
    this.destroyRef.onDestroy(() => {
      this.destroyed = true;
      this.invalidateAuthSubmissions();
      this.cancelPostLoginMigrationChecks();
    });

    // 回滚开关关闭时，恢复旧策略：启动阶段预热重型依赖。
    if (!FEATURE_FLAGS.ROOT_STARTUP_DEP_PRUNE_V1) {
      void this.getAttachmentServiceLazy();
      void this.getMigrationServiceLazy();
    }
  }

  private registerSessionInvalidationTeardown(): void {
    this.eventBus.onSessionInvalidated$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((event) => {
        void this.handleSessionInvalidated(event);
      });
  }

  private async handleSessionInvalidated(event: SessionInvalidatedEvent): Promise<void> {
    this.invalidateAuthSubmissions();
    this.cancelPostLoginMigrationChecks();
    try {
      await this.userSession.setCurrentUser(null, {
        skipPersistentReload: true,
        previousUserIdHint: event.userId,
        preserveOfflineSnapshot: true,
      });
    } catch (error) {
      this.logger.warn('会话失效 teardown 失败，已保留离线快照等待后续恢复', {
        source: event.source,
        userId: event.userId,
        error,
      });
    }
  }

  // ========== 会话引导 ==========

  /** 调度会话引导（在首屏渲染后执行） */
  scheduleSessionBootstrap(): void {
    if (this.bootstrapScheduled || this.bootstrapInFlight) {
      return;
    }

    this.bootstrapScheduled = true;
    const runBootstrap = () => {
      this.bootstrapScheduled = false;
      pushStartupTrace('auth.bootstrap_scheduled_run', {
        bootStage: typeof window !== 'undefined' ? window.__NANOFLOW_BOOT_STAGE__ ?? null : null,
      });
      this.bootstrapSession().catch(_e => {
        // 错误已在 bootstrapSession 内部处理
      });
    };

    // 【P1 秒开优化 2026-03-28】bootstrap 不再等 boot-stage 事件，直接异步执行。
    // P0-1 已修复 handoff 不依赖 auth，auth 可安全地在后台完成。
    // 原来等 boot-stage 事件/2500ms fallback 的逻辑已不必要。
    queueMicrotask(runBootstrap);
  }

  /** 重试启动会话 */
  retryBootstrap(): void {
    this.bootstrapSession().catch(_e => {});
  }

  resolveSafePostAuthNavigationUrl(returnUrl?: string | null): string | null {
    const target = resolveSafePostAuthNavigationTarget({
      returnUrl,
      activeProjectId: this.projectState.activeProjectId(),
      startupProjectCatalogStage: this.userSession.startupProjectCatalogStage(),
      canAuthoritativelyRejectProjectRoute: this.userSession.canAuthoritativelyRejectProjectRoute(),
      isProjectAuthoritativelyAccessible: projectId => this.userSession.isProjectAuthoritativelyAccessible(projectId),
      hasMatchingProject: projectId => this.projectState.projects().some(project => project.id === projectId),
    });
    if (target.rejected) {
      this.logger.info('[Login] 登录后目标路由不可安全恢复，已回退到项目列表', target.rejected);
    }
    return target.url;
  }

  private async bootstrapSession(): Promise<void> {
    if (this.bootstrapInFlight) {
      this.logger.debug('[Bootstrap] 已在执行中，跳过重复调用');
      return;
    }

    this.bootstrapInFlight = true;

    if (!this.auth.isConfigured) {
      await this.bootstrapUnconfiguredSession();
      return;
    }

    const { totalStartTime, isSilent } = this.beginConfiguredBootstrapSession();
    const previousUserIdHint = this.capturePreviousUserIdHint();

    try {
      const result = await this.checkBootstrapSession();
      if (result.userId) {
        await this.bootstrapAuthenticatedSession(result.userId, result.email, previousUserIdHint);
      } else {
        await this.bootstrapAnonymousSession();
      }

      this.recordBootstrapSuccess();
    } catch (e: unknown) {
      await this.handleBootstrapFailure(e);
    } finally {
      this.finishConfiguredBootstrapSession(totalStartTime, isSilent);
    }
  }

  private async bootstrapUnconfiguredSession(): Promise<void> {
    this.logger.debug('[Bootstrap] Supabase 未配置，启用离线模式');
    this.isCheckingSession.set(false);
    try {
      await this.userSession.setCurrentUser(null);
    } finally {
      this.bootstrapInFlight = false;
    }
  }

  private beginConfiguredBootstrapSession(): { totalStartTime: number; isSilent: boolean } {
    this.logger.debug('[Bootstrap] ========== 启动会话检查 ==========');
    pushStartupTrace('auth.bootstrap_start', {
      runtimeState: this.auth.runtimeState(),
      sessionInitialized: this.auth.sessionInitialized(),
      currentUserId: this.auth.currentUserId(),
    });
    const isSilent = this.coldBootSilent;
    if (!isSilent) this.isCheckingSession.set(true);
    this.bootstrapFailed.set(false);
    this.bootstrapErrorMessage.set(null);
    return { totalStartTime: Date.now(), isSilent };
  }

  private async checkBootstrapSession(): Promise<{ userId: string | null; email: string | null }> {
    this.logger.debug('[Bootstrap] 步骤 1/3: 调用 auth.checkSession()...');
    const startTime = Date.now();
    const result = await this.auth.checkSession();
    const elapsed = Date.now() - startTime;
    this.logger.debug(`[Bootstrap] 步骤 1/3: checkSession 完成 (耗时 ${elapsed}ms)`, {
      userId: result.userId,
      hasEmail: !!result.email
    });
    return { userId: result.userId, email: result.email };
  }

  private async bootstrapAuthenticatedSession(
    userId: string,
    email: string | null,
    previousUserIdHint: string | null,
  ): Promise<void> {
    this.sessionEmail.set(email);
    this.isCheckingSession.set(false);
    this.logger.debug('[Bootstrap] 步骤 2/3: 用户已登录，开始加载数据...');
    const loadStartTime = Date.now();
    const loadGeneration = ++this.authLoadGeneration;
    const loadPromise = this.userSession.setCurrentUser(userId, {
      forceLoad: true,
      previousUserIdHint,
    });
    const loadStatus = await waitForPromiseOrTimeout(loadPromise, this.BOOTSTRAP_DATA_LOAD_TIMEOUT_MS);

    if (loadStatus === 'completed') {
      const loadElapsed = Date.now() - loadStartTime;
      this.logger.debug(`[Bootstrap] 步骤 2/3: 数据加载完成 (耗时 ${loadElapsed}ms)`);
    } else {
      this.continueBootstrapLoadInBackground(userId, loadPromise, loadGeneration, loadStartTime);
    }

    this.logger.debug('[Bootstrap] 步骤 3/3: 检查项目数据...', {
      projectCount: this.projectState.projects().length,
      activeProjectId: this.projectState.activeProjectId()
    });
  }

  private continueBootstrapLoadInBackground(
    userId: string,
    loadPromise: Promise<unknown>,
    loadGeneration: number,
    loadStartTime: number
  ): void {
    const loadElapsed = Date.now() - loadStartTime;
    this.logger.warn(
      `[Bootstrap] 步骤 2/3: 数据加载超过 ${this.BOOTSTRAP_DATA_LOAD_TIMEOUT_MS}ms，转后台继续`,
      { elapsed: loadElapsed }
    );
    pushStartupTrace('auth.bootstrap_background_continue', { elapsedMs: loadElapsed, userId });

    void loadPromise.then(() => {
      if (!this.isAuthLoadCurrent(userId, loadGeneration)) {
        return;
      }
      const backgroundElapsed = Date.now() - loadStartTime;
      this.logger.info(`[Bootstrap] 后台数据加载完成 (耗时 ${backgroundElapsed}ms)`);
    }).catch((error: unknown) => {
      if (!this.isAuthLoadCurrent(userId, loadGeneration)) {
        return;
      }
      this.logger.error('[Bootstrap] 后台数据加载失败，保留当前会话状态并停止自动回退', error);
    });
  }

  private async bootstrapAnonymousSession(): Promise<void> {
    this.logger.debug('[Bootstrap] 步骤 2/3: 无现有会话');
    this.isCheckingSession.set(false);
    try {
      await this.userSession.setCurrentUser(null);
    } catch (loadError) {
      this.logger.warn('[Bootstrap] 离线数据加载失败', loadError);
    }
  }

  private recordBootstrapSuccess(): void {
    this.logger.debug('[Bootstrap] ========== 启动成功 ==========');
    pushStartupTrace('auth.bootstrap_success', {
      projectCount: this.projectState.projects().length,
      activeProjectId: this.projectState.activeProjectId(),
    });
  }

  private async handleBootstrapFailure(e: unknown): Promise<void> {
    const err = e as Error | undefined;
    this.logger.error('[Bootstrap] ========== 启动失败 ==========');
    this.logger.error('[Bootstrap] 错误详情', {
      message: err?.message, stack: err?.stack, name: err?.name, cause: err?.cause
    });
    const errorMsg = humanizeErrorMessage(err?.message ?? String(e));
    this.logger.error('[Bootstrap] 转换后的用户消息', { errorMsg });
    this.bootstrapFailed.set(true);
    this.bootstrapErrorMessage.set(errorMsg);
    this.authError.set(errorMsg);
    pushStartupTrace('auth.bootstrap_failure', { message: errorMsg });

    try {
      await this.userSession.setCurrentUser(null);
    } catch (fallbackError) {
      this.logger.warn('[Bootstrap] 降级离线数据加载也失败', fallbackError);
    }
  }

  private finishConfiguredBootstrapSession(totalStartTime: number, isSilent: boolean): void {
    const totalElapsed = Date.now() - totalStartTime;
    pushStartupTrace('auth.bootstrap_complete', {
      elapsedMs: totalElapsed,
      bootstrapFailed: this.bootstrapFailed(),
      coldBootSilent: isSilent,
    });
    this.logger.debug(`[Bootstrap] 完成 (总耗时 ${totalElapsed}ms, silent=${isSilent})`);
    this.isCheckingSession.set(false);
    this.bootstrapInFlight = false;
    this.coldBootSilent = false;
  }

  async handleLogin(
    event?: Event,
    opts?: { closeSettings?: boolean; skipPostAuthNavigation?: boolean; onOutcome?: (authenticated: boolean) => void },
  ): Promise<void> {
    event?.preventDefault();
    let authenticated = false;
    const submission = this.prepareLoginSubmission();
    if (!submission) return;
    const { previousUserIdHint, submissionGeneration } = submission;
    try {
      const result = await this.auth.signIn(
        this.authEmail(),
        this.authPassword(),
        () => this.isAuthSubmissionCurrent(submissionGeneration, [previousUserIdHint]),
      );
      if (!this.isAuthSubmissionCurrent(submissionGeneration, [previousUserIdHint])) {
        return;
      }
      if (isFailure(result)) {
        throw new Error(getAuthFailureMessage(result.error));
      }
      disableLocalMode();
      this.sessionEmail.set(this.auth.sessionEmail());
      const userId = result.value.userId ?? null;
      if (!userId) {
        this.logger.warn('[Login] 登录成功但未返回 userId，无法安全初始化会话');
        throw new Error('登录成功，但会话初始化失败，请重新登录。');
      }
      const loginOptions = { ...opts, markAuthenticated: () => { authenticated = true; } };
      await this.postLoginController.initializeSuccessfulLoginSession(
        userId,
        previousUserIdHint,
        submissionGeneration,
        loginOptions,
      );
    } catch (e: unknown) {
      if (this.isAuthSubmissionCurrent(submissionGeneration)) {
        this.authError.set(getAuthFlowErrorMessage(e));
      }
    } finally {
      if (this.activeLoginSubmissionGeneration === submissionGeneration) {
        this.activeLoginSubmissionGeneration = null;
        this.isAuthLoading.set(false);
        this.isCheckingSession.set(false);
      }
      opts?.onOutcome?.(authenticated);
    }
  }

  private prepareLoginSubmission(): {
    previousUserIdHint: string | null;
    submissionGeneration: number;
  } | null {
    if (this.isAuthLoading()) return null;
    const preflightError = getAuthCredentialPreflightError('login', {
      isConfigured: this.auth.isConfigured,
      email: this.authEmail(),
      password: this.authPassword(),
    });
    if (preflightError) {
      this.authError.set(preflightError);
      return null;
    }
    this.authError.set(null);
    this.isAuthLoading.set(true);
    return {
      previousUserIdHint: this.capturePreviousUserIdHint(),
      submissionGeneration: this.beginAuthSubmission(),
    };
  }

  // eslint-disable-next-line max-lines-per-function -- signup submission, modal, and owner fences are one ordered flow
  async handleSignup(event?: Event, canCommitContext: () => boolean = () => true): Promise<boolean> {
    event?.preventDefault();
    if (this.isAuthLoading()) return false;
    const preflightError = getAuthCredentialPreflightError('signup', {
      isConfigured: this.auth.isConfigured,
      email: this.authEmail(),
      password: this.authPassword(),
      confirmPassword: this.authConfirmPassword(),
    });
    if (preflightError) {
      this.authError.set(preflightError);
      return false;
    }
    this.authError.set(null);
    this.isAuthLoading.set(true);
    const previousUserIdHint = this.capturePreviousUserIdHint();
    const submissionGeneration = this.beginAuthSubmission();
    const isCurrent = (allowed?: readonly (string | null)[]) =>
      canCommitContext() && this.isAuthSubmissionCurrent(submissionGeneration, allowed);
    try {
      const result = await this.auth.signUp(
        this.authEmail(),
        this.authPassword(),
        () => isCurrent([previousUserIdHint]),
      );
      if (!isCurrent([previousUserIdHint])) return false;
      if (isFailure(result)) {
        throw new Error(getAuthFailureMessage(result.error));
      }
      const signedUpUserId = result.value.userId ?? null;
      const signedUpEmail = result.value.email ?? null;
      if (result.value.needsConfirmation) {
        this.authError.set('注册成功！请查收邮件并点击验证链接完成注册。');
        return false;
      } else if (signedUpUserId) {
        disableLocalMode();
        this.sessionEmail.set(signedUpEmail);
        await this.loadPostAuthUserDataWithTimeout(signedUpUserId, '[Signup]', previousUserIdHint);
        if (!isCurrent([previousUserIdHint, signedUpUserId])) return false;
        this.toast.success('注册成功', '欢迎使用');
        this.modal.closeByType('login', { success: true, userId: signedUpUserId });
        this.isSignupMode.set(false);
        return true;
      } else {
        this.logger.warn('[Signup] 注册成功但未返回 userId，无法安全初始化会话');
        this.authError.set('注册成功，但会话初始化失败，请重新登录。');
        return false;
      }
    } catch (e: unknown) {
      if (isCurrent()) {
        this.authError.set(getAuthFlowErrorMessage(e));
      }
      return false;
    } finally {
      if (this.activeLoginSubmissionGeneration === submissionGeneration) {
        this.activeLoginSubmissionGeneration = null;
        this.isAuthLoading.set(false);
      }
    }
  }

  private finishSuccessfulLogin(
    userId: string,
    opts?: { closeSettings?: boolean; skipPostAuthNavigation?: boolean; markAuthenticated?: () => void },
  ): void {
    const completionPlan = buildSuccessfulLoginCompletionPlan({
      rawLoginData: this.modal.getData('login'),
      options: opts,
      resolveNavigationUrl: returnUrl => this.resolveSafePostAuthNavigationUrl(returnUrl),
    });
    this.modal.closeByType('login', { success: true, userId });
    if (completionPlan.closeSettings) {
      this.modal.closeByType('settings');
    }
    if (completionPlan.navigationUrl) {
      void this.router.navigateByUrl(completionPlan.navigationUrl);
    }
    opts?.markAuthenticated?.();
  }

  private capturePreviousUserIdHint(): string | null {
    return this.userSession.currentUserId() ?? null;
  }

  private async loadPostAuthUserDataWithTimeout(
    userId: string,
    logPrefix: '[Login]' | '[Signup]',
    previousUserIdHint: string | null,
  ): Promise<void> {
    const loadGeneration = ++this.authLoadGeneration;
    const timeoutMs = 8000;
    const loadPromise = this.userSession.setCurrentUser(userId, {
      forceLoad: true,
      previousUserIdHint,
    });
    const loadStatus = await waitForPromiseOrTimeout(loadPromise, timeoutMs);
    if (loadStatus !== 'timeout') {
      return;
    }

    this.logger.warn(`${logPrefix} 数据加载超时，转后台继续`, { timeoutMs });
    void loadPromise.catch(e => {
      if (!this.isAuthLoadCurrent(userId, loadGeneration)) {
        return;
      }
      this.logger.error(`${logPrefix} 后台数据加载失败`, e);
    });
  }

  async handleResetPassword(event?: Event): Promise<void> {
    event?.preventDefault();
    // 并发守卫：认证请求进行中时忽略重复提交，防止连点触发第二次 resetPassword
    if (this.isAuthLoading()) return;
    const preflightError = getAuthCredentialPreflightError('reset-password',
      { isConfigured: this.auth.isConfigured, email: this.authEmail() });
    if (preflightError) {
      this.authError.set(preflightError);
      return;
    }
    this.authError.set(null);
    this.isAuthLoading.set(true);
    try {
      const result = await this.auth.resetPassword(this.authEmail());
      if (isFailure(result)) {
        throw new Error(getAuthFailureMessage(result.error));
      }
      this.resetPasswordSent.set(true);
    } catch (e: unknown) {
      this.authError.set(getAuthFlowErrorMessage(e));
    } finally {
      this.isAuthLoading.set(false);
    }
  }

  switchToSignup(): void {
    this.applyAuthFormStatePatch(getAuthFormModePatch('signup'));
  }

  switchToLogin(): void {
    this.applyAuthFormStatePatch(getAuthFormModePatch('login'));
  }

  switchToResetPassword(): void {
    this.applyAuthFormStatePatch(getAuthFormModePatch('reset-password'));
  }

  startRelogin(): void {
    this.applyAuthFormStatePatch({
      isReloginMode: true,
      authPassword: '',
      authError: null,
    });
    if (this.sessionEmail()) {
      this.authEmail.set(this.sessionEmail()!);
    }
  }

  private applyAuthFormStatePatch(patch: AuthFormStatePatch): void {
    if ('sessionEmail' in patch) this.sessionEmail.set(patch.sessionEmail ?? null);
    if ('authEmail' in patch) this.authEmail.set(patch.authEmail ?? '');
    if ('authPassword' in patch) this.authPassword.set(patch.authPassword ?? '');
    if ('authConfirmPassword' in patch) this.authConfirmPassword.set(patch.authConfirmPassword ?? '');
    if ('authError' in patch) this.authError.set(patch.authError ?? null);
    if ('isReloginMode' in patch) this.isReloginMode.set(patch.isReloginMode ?? false);
    if ('isSignupMode' in patch) this.isSignupMode.set(patch.isSignupMode ?? false);
    if ('isResetPasswordMode' in patch) this.isResetPasswordMode.set(patch.isResetPasswordMode ?? false);
    if ('resetPasswordSent' in patch) this.resetPasswordSent.set(patch.resetPasswordSent ?? false);
  }

  // ========== 登出 ==========

  /**
   * 按需获取 AttachmentService，避免其重型依赖进入启动主链路。
   * single-flight：并发请求复用同一个 Promise。
   */
  async getAttachmentServiceLazy(): Promise<AttachmentService | null> {
    return resolveAppAuthLazyService(this.attachmentServiceLazy, {
      loadToken: () => import('../../../services/attachment.service').then(module => module.AttachmentService),
      resolve: token => this.injector.get(token),
      warn: error => this.logger.warn('AttachmentService 懒加载失败，降级继续', error),
    });
  }

  /**
   * 按需获取 MigrationService，避免登录前把迁移链路静态打入首屏。
   * single-flight：并发请求复用同一个 Promise。
   */
  async getMigrationServiceLazy(): Promise<MigrationService | null> {
    return resolveAppAuthLazyService(this.migrationServiceLazy, {
      loadToken: () => import('../../../services/migration.service').then(module => module.MigrationService),
      resolve: token => this.injector.get(token),
      warn: error => this.logger.warn('MigrationService 懒加载失败，降级跳过迁移检查', error),
    });
  }

  /**
   * 按需获取 ProjectDataService，避免登录页实例化时拉起整个同步主链路。
   * single-flight：并发请求复用同一个 Promise。
   */
  async getProjectDataServiceLazy(): Promise<ProjectDataService | null> {
    return resolveAppAuthLazyService(this.projectDataServiceLazy, {
      loadToken: () => import('./sync/project-data.service').then(module => module.ProjectDataService),
      resolve: token => this.injector.get(token),
      warn: error => this.logger.warn('ProjectDataService 懒加载失败，降级跳过迁移探测', error),
    });
  }

  /**
   * 执行认证相关的登出清理
    * 返回 true 表示登出完成；返回 false 表示远端吊销失败，调用方必须保留当前登录态
   */
  async signOut(): Promise<boolean> {
    this.invalidateAuthSubmissions();
    this.authLoadGeneration++;
    this.cancelPostLoginMigrationChecks();
    return this.signOutController.signOut();
  }

  private async notifyLocalServicesForSignOut(): Promise<void> {
    this.optimisticState.onUserLogout();
    this.undoService.onUserLogout();
    const attachmentService = await this.getAttachmentServiceLazy();
    attachmentService?.onUserLogout();
  }

  private resetAuthFormStateAfterSignOut(): void {
    this.applyAuthFormStatePatch(getAuthFormModePatch('signed-out'));
  }
  async handleLoginFromModal(data: { email: string; password: string }): Promise<boolean> {
    let authenticated = false;
    this.authEmail.set(data.email);
    this.authPassword.set(data.password);
    await this.handleLogin(undefined, {
      skipPostAuthNavigation: true,
      onOutcome: outcome => { authenticated = outcome; },
    });
    return authenticated;
  }

  async handleSignupFromModal(data: { email: string; password: string; confirmPassword: string }, canCommitModal: () => boolean = () => true): Promise<boolean> {
    this.authEmail.set(data.email);
    this.authPassword.set(data.password);
    this.authConfirmPassword.set(data.confirmPassword);
    return await this.handleSignup(undefined, canCommitModal);
  }

  async handleResetPasswordFromModal(email: string): Promise<void> {
    this.authEmail.set(email);
    await this.handleResetPassword();
  }

  /** 处理本地模式选择 */
  async handleLocalModeFromModal(): Promise<void> {
    this.invalidateAuthSubmissions();
    this.cancelPostLoginMigrationChecks();
    const previousUserIdHint = this.auth.currentUserId();
    enableLocalMode();
    await this.userSession.setCurrentUser(AUTH_CONFIG.LOCAL_MODE_USER_ID, {
      forceLoad: true,
      previousUserIdHint,
      preserveOfflineSnapshot: true,
    });
    this.auth.sessionExpired.set(false);
    this.syncState.resetSessionExpired();
    this.modal.closeByType('login', { success: true, userId: AUTH_CONFIG.LOCAL_MODE_USER_ID });
    this.toast.info('本地模式', '数据仅保存在本地，不会同步到云端');
  }

  // ========== 迁移检查 ==========

  private isAuthLoadCurrent(userId: string | null, generation: number): boolean {
    return isAuthLoadCurrent(
      generation,
      this.authLoadGeneration,
      userId,
      this.userSession.currentUserId()
    );
  }

  private beginAuthSubmission(): number {
    this.authSubmissionGeneration += 1;
    this.activeLoginSubmissionGeneration = this.authSubmissionGeneration;
    return this.authSubmissionGeneration;
  }

  private invalidateAuthSubmissions(): void {
    this.authSubmissionGeneration += 1;
  }

  private cancelPostLoginMigrationChecks(): void {
    this.migrationCheckGeneration += 1;
    this.postLoginController.cancelPendingMigrationCheck();
  }

  private isAuthSubmissionCurrent(
    generation: number,
    allowedCurrentUserIds?: readonly (string | null)[],
  ): boolean {
    if (this.destroyed || generation !== this.authSubmissionGeneration) {
      return false;
    }
    if (!allowedCurrentUserIds) {
      return true;
    }
    return allowedCurrentUserIds.includes(this.userSession.currentUserId());
  }

  handleMigrationComplete(): void {
    this.modal.closeByType('migration');
    void this.userSession.loadProjects();
    this.toast.success('数据迁移完成');
  }

  closeMigrationModal(): void {
    this.modal.closeByType('migration');
    this.toast.info('您可以稍后在设置中处理数据迁移');
  }
}
