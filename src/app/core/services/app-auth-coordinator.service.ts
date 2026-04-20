import { Injectable, inject, signal, computed, Injector } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from '../../../services/auth.service';
import { UserSessionService } from '../../../services/user-session.service';
import { ProjectStateService } from '../../../services/project-state.service';
import { ModalService, type LoginData } from '../../../services/modal.service';
import { ToastService } from '../../../services/toast.service';
import { LoggerService } from '../../../services/logger.service';
import { OptimisticStateService } from '../../../services/optimistic-state.service';
import { UndoService } from '../../../services/undo.service';
import { WidgetBindingService } from '../../../services/widget-binding.service';
import { enableLocalMode, disableLocalMode } from '../../../services/guards';
import { getErrorMessage, isFailure, humanizeErrorMessage, type OperationError } from '../../../utils/result';
import { resolveRouteIntent } from '../../../utils/route-intent';
import { AUTH_CONFIG } from '../../../config/auth.config';
import { FEATURE_FLAGS } from '../../../config/feature-flags.config';
import type { AttachmentService } from '../../../services/attachment.service';
import type { MigrationService } from '../../../services/migration.service';
import type { ProjectDataService } from './sync/project-data.service';
import { pushStartupTrace } from '../../../utils/startup-trace';

/**
 * 应用认证协调器
 *
 * 统一管理认证相关的状态和操作：
 * - 登录/注册/密码重置
 * - 会话引导（bootstrap）
 * - 本地模式切换
 * - 迁移检查
 */
@Injectable({ providedIn: 'root' })
export class AppAuthCoordinatorService {
  /** 启动阶段等待用户数据加载的最大时长（超时后转后台继续） */
  private readonly BOOTSTRAP_DATA_LOAD_TIMEOUT_MS = AUTH_CONFIG.SESSION_CHECK_TIMEOUT;

  private readonly logger = inject(LoggerService).category('Auth');
  private readonly injector = inject(Injector);
  private readonly auth = inject(AuthService);
  private readonly userSession = inject(UserSessionService);
  private readonly projectState = inject(ProjectStateService);
  private readonly modal = inject(ModalService);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);
  private readonly optimisticState = inject(OptimisticStateService);
  private readonly undoService = inject(UndoService);
  private readonly widgetBinding = inject(WidgetBindingService);

  private attachmentServiceRef: AttachmentService | null = null;
  private attachmentServicePromise: Promise<AttachmentService | null> | null = null;
  private migrationServiceRef: MigrationService | null = null;
  private migrationServicePromise: Promise<MigrationService | null> | null = null;
  private projectDataServiceRef: ProjectDataService | null = null;
  private projectDataServicePromise: Promise<ProjectDataService | null> | null = null;

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
    return this.auth.isConfigured &&
      this.auth.runtimeState() !== 'pending' &&
      this.auth.sessionInitialized() &&  // 必须等首次会话检查完成，防止启动竞态误显示
      !this.userSession.currentUserId() &&
      !this.modal.isOpen('login') &&
      !this.isCheckingSession() &&
      !this.bootstrapFailed();
  });

  /** 设置页认证表单是否可见 */
  readonly showSettingsAuthForm = computed(() =>
    !this.userSession.currentUserId() || this.isReloginMode()
  );

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

  constructor() {
    // 回滚开关关闭时，恢复旧策略：启动阶段预热重型依赖。
    if (!FEATURE_FLAGS.ROOT_STARTUP_DEP_PRUNE_V1) {
      void this.getAttachmentServiceLazy();
      void this.getMigrationServiceLazy();
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

  /**
   * 等待 Promise 完成，超时则返回 timeout，避免启动流程被长期阻塞
   */
  private async waitWithTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number
  ): Promise<'completed' | 'timeout'> {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        promise.then(() => 'completed' as const),
        new Promise<'timeout'>(resolve => {
          timeoutId = setTimeout(() => resolve('timeout'), timeoutMs);
        })
      ]);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  private getAuthFailureMessage(error: OperationError): string {
    const message = error.message?.trim();
    return message || getErrorMessage(error);
  }

  resolveSafePostAuthNavigationUrl(returnUrl?: string | null): string | null {
    const normalizedReturnUrl = typeof returnUrl === 'string'
      ? returnUrl.trim()
      : '';
    const explicitReturnUrl = normalizedReturnUrl && normalizedReturnUrl !== '/'
      ? normalizedReturnUrl
      : null;

    if (!explicitReturnUrl) {
      return explicitReturnUrl;
    }

    const routeIntent = resolveRouteIntent(explicitReturnUrl, this.projectState.activeProjectId());
    if (routeIntent.kind === 'projects' || !routeIntent.projectId) {
      return explicitReturnUrl;
    }

    const startupProjectCatalogStage = this.userSession.startupProjectCatalogStage();
    if (!this.userSession.canAuthoritativelyRejectProjectRoute()) {
      return explicitReturnUrl;
    }

    const projectExists = this.projectState.projects().some(
      (project) => project.id === routeIntent.projectId,
    );
    if (projectExists) {
      return explicitReturnUrl;
    }

    this.logger.info('[Login] 登录后目标路由不可安全恢复，已回退到项目列表', {
      candidateUrl: explicitReturnUrl,
      projectId: routeIntent.projectId,
      startupProjectCatalogStage,
      canAuthoritativelyRejectProjectRoute: true,
      hasMatchingProject: projectExists,
    });
    return '/projects';
  }

  private async bootstrapSession(): Promise<void> {
    if (this.bootstrapInFlight) {
      this.logger.debug('[Bootstrap] 已在执行中，跳过重复调用');
      return;
    }

    this.bootstrapInFlight = true;

    if (!this.auth.isConfigured) {
      this.logger.debug('[Bootstrap] Supabase 未配置，启用离线模式');
      this.isCheckingSession.set(false);
      try {
        await this.userSession.setCurrentUser(null);
      } finally {
        this.bootstrapInFlight = false;
      }
      return;
    }

    this.logger.debug('[Bootstrap] ========== 启动会话检查 ==========');
    pushStartupTrace('auth.bootstrap_start', {
      runtimeState: this.auth.runtimeState(),
      sessionInitialized: this.auth.sessionInitialized(),
      currentUserId: this.auth.currentUserId(),
    });
    const totalStartTime = Date.now();
    const isSilent = this.coldBootSilent;
    // 【P1 秒开优化 2026-03-31】冷启动时不设置 isCheckingSession = true。
    // 快照已预填充内容，auth 静默完成即可。用户无需看到"会话检测中"指示器。
    // 仅在手动重试（retryBootstrap）时显示检测 UI。
    if (!isSilent) {
      this.isCheckingSession.set(true);
    }
    this.bootstrapFailed.set(false);
    this.bootstrapErrorMessage.set(null);

    try {
      this.logger.debug('[Bootstrap] 步骤 1/3: 调用 auth.checkSession()...');
      const startTime = Date.now();
      const result = await this.auth.checkSession();
      const elapsed = Date.now() - startTime;
      this.logger.debug(`[Bootstrap] 步骤 1/3: checkSession 完成 (耗时 ${elapsed}ms)`, {
        userId: result.userId,
        hasEmail: !!result.email
      });

      if (result.userId) {
        this.sessionEmail.set(result.email);
        // 【P1 秒开优化 2026-03-31】身份已确认，立即释放 isCheckingSession。
        // 后续的数据加载（setCurrentUser）不应阻塞 UI 指示器。
        // 冷启动时 isCheckingSession 本就没有设为 true，此处兜底确保一致。
        this.isCheckingSession.set(false);
        this.logger.debug('[Bootstrap] 步骤 2/3: 用户已登录，开始加载数据...');
        const loadStartTime = Date.now();
        const loadGeneration = ++this.authLoadGeneration;
        // 【P0 修复 2026-03-27】冷启动路径必须传 forceLoad: true
        // 修复竞态：auth guard 快速路径可能已设 currentUserId，导致 isUserChange=false，
        // 如果快照预填充已让 hasProjects=true，loadUserData 会被跳过 → 数据未加载。
        const loadPromise = this.userSession.setCurrentUser(result.userId, { forceLoad: true });
        const loadStatus = await this.waitWithTimeout(
          loadPromise,
          this.BOOTSTRAP_DATA_LOAD_TIMEOUT_MS
        );

        if (loadStatus === 'completed') {
          const loadElapsed = Date.now() - loadStartTime;
          this.logger.debug(`[Bootstrap] 步骤 2/3: 数据加载完成 (耗时 ${loadElapsed}ms)`);
        } else {
          const loadElapsed = Date.now() - loadStartTime;
          this.logger.warn(
            `[Bootstrap] 步骤 2/3: 数据加载超过 ${this.BOOTSTRAP_DATA_LOAD_TIMEOUT_MS}ms，转后台继续`,
            { elapsed: loadElapsed }
          );
          pushStartupTrace('auth.bootstrap_background_continue', {
            elapsedMs: loadElapsed,
            userId: result.userId,
          });

          void loadPromise.then(() => {
            if (!this.isAuthLoadCurrent(result.userId, loadGeneration)) {
              return;
            }
            const backgroundElapsed = Date.now() - loadStartTime;
            this.logger.info(`[Bootstrap] 后台数据加载完成 (耗时 ${backgroundElapsed}ms)`);
          }).catch((error: unknown) => {
            if (!this.isAuthLoadCurrent(result.userId, loadGeneration)) {
              return;
            }
            this.logger.error('[Bootstrap] 后台数据加载失败，保留当前会话状态并停止自动回退', error);
          });
        }

        this.logger.debug('[Bootstrap] 步骤 3/3: 检查项目数据...', {
          projectCount: this.projectState.projects().length,
          activeProjectId: this.projectState.activeProjectId()
        });
      } else {
        this.logger.debug('[Bootstrap] 步骤 2/3: 无现有会话');
        // 【P1 秒开优化 2026-03-31】身份检测完毕（无会话），立即释放 UI 指示器
        this.isCheckingSession.set(false);
        // 【P0 修复】无会话时也加载离线缓存，避免用户看到空工作区
        // 先前行为：跳过数据加载 → 工作区空白
        // 修复后：加载离线快照，用户至少能看到上次的数据
        try {
          await this.userSession.setCurrentUser(null);
        } catch (loadError) {
          this.logger.warn('[Bootstrap] 离线数据加载失败', loadError);
        }
      }

      this.logger.debug('[Bootstrap] ========== 启动成功 ==========');
      pushStartupTrace('auth.bootstrap_success', {
        projectCount: this.projectState.projects().length,
        activeProjectId: this.projectState.activeProjectId(),
      });
    } catch (e: unknown) {
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
      pushStartupTrace('auth.bootstrap_failure', {
        message: errorMsg,
      });

      // 【P0 修复】auth 启动失败时加载离线缓存，防止用户数据"消失"
      // 根因：bootstrapSession 抛出异常（网络故障/Supabase 不可达）后，
      // 既不调用 setCurrentUser 也不调用 loadFromCacheOrSeed，
      // 导致 projectState 始终为空，用户看到空白工作区。
      // 修复：降级到离线模式，加载本地缓存数据。
      try {
        await this.userSession.setCurrentUser(null);
      } catch (fallbackError) {
        this.logger.warn('[Bootstrap] 降级离线数据加载也失败', fallbackError);
      }
    } finally {
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
  }

  // ========== 登录/注册/重置 ==========

  async handleLogin(
    event?: Event,
    opts?: { closeSettings?: boolean; skipPostAuthNavigation?: boolean },
  ): Promise<void> {
    event?.preventDefault();
    if (!this.auth.isConfigured) {
      this.authError.set('Supabase keys missing. Set NG_APP_SUPABASE_URL/NG_APP_SUPABASE_ANON_KEY.');
      return;
    }
    this.authError.set(null);
    this.isAuthLoading.set(true);
    try {
      const result = await this.auth.signIn(this.authEmail(), this.authPassword());
      if (isFailure(result)) {
        throw new Error(this.getAuthFailureMessage(result.error));
      }
      disableLocalMode();
      this.sessionEmail.set(this.auth.sessionEmail());
      // 【P0 修复 2026-02-08】从 signIn 结果中获取 userId，而非从 signal 读取
      // signIn() 不再提前设置 currentUserId，由 setCurrentUser 统一管理
      const userId = result.value.userId ?? null;
      if (!userId) {
        this.logger.warn('[Login] 登录成功但未返回 userId，无法安全初始化会话');
        throw new Error('登录成功，但会话初始化失败，请重新登录。');
      }

      localStorage.setItem('currentUserId', userId);
      const loadGeneration = ++this.authLoadGeneration;
      // 【P0 修复 2026-02-08】使用 waitWithTimeout 防止数据加载卡死
      // 与 bootstrapSession 对齐，超时后转后台继续，不阻塞 UI
      const DATA_LOAD_TIMEOUT_MS = 8000;
      const loadPromise = this.userSession.setCurrentUser(userId, { forceLoad: true });
      const loadStatus = await this.waitWithTimeout(loadPromise, DATA_LOAD_TIMEOUT_MS);
      if (loadStatus === 'timeout') {
        this.logger.warn('[Login] 数据加载超时，转后台继续', { timeoutMs: DATA_LOAD_TIMEOUT_MS });
        // 超时不阻断登录流程，数据在后台继续加载
        void loadPromise.catch(e => {
          if (!this.isAuthLoadCurrent(userId, loadGeneration)) {
            return;
          }
          this.logger.error('[Login] 后台数据加载失败', e);
        });
      }
      this.toast.success('登录成功', `欢迎回来`);
      const migrationGeneration = ++this.migrationCheckGeneration;
      this.isReloginMode.set(false);
      const rawLoginData = this.modal.getData('login');
      const loginData = this.isLoginData(rawLoginData) ? rawLoginData : undefined;
      const returnUrl = loginData?.returnUrl;
      this.modal.closeByType('login', { success: true, userId: userId ?? undefined });
      if (opts?.closeSettings) {
        this.modal.closeByType('settings');
      }
      const postAuthTargetUrl = opts?.skipPostAuthNavigation
        ? null
        : this.resolveSafePostAuthNavigationUrl(returnUrl);
      if (postAuthTargetUrl) {
        void this.router.navigateByUrl(postAuthTargetUrl);
      }
      setTimeout(() => {
        void this.checkMigrationAfterLogin(userId, migrationGeneration).catch(error => {
          this.logger.warn('登录后迁移检查失败，已跳过本次迁移提示', error);
        });
      }, 0);
    } catch (e: unknown) {
      const err = e as Error | undefined;
      this.authError.set(humanizeErrorMessage(err?.message ?? String(e)));
    } finally {
      this.isAuthLoading.set(false);
      this.isCheckingSession.set(false);
    }
  }

  async handleSignup(event?: Event): Promise<void> {
    event?.preventDefault();
    if (!this.auth.isConfigured) {
      this.authError.set('Supabase keys missing.');
      return;
    }
    if (this.authPassword() !== this.authConfirmPassword()) {
      this.authError.set('两次输入的密码不一致');
      return;
    }
    const minLen = 8;
    if (this.authPassword().length < minLen) {
      this.authError.set(`密码长度至少${minLen}位`);
      return;
    }
    this.authError.set(null);
    this.isAuthLoading.set(true);
    try {
      const result = await this.auth.signUp(this.authEmail(), this.authPassword());
      if (isFailure(result)) {
        throw new Error(this.getAuthFailureMessage(result.error));
      }
      const signedUpUserId = result.value.userId ?? this.auth.currentUserId();
      const signedUpEmail = result.value.email ?? this.auth.sessionEmail();
      if (result.value.needsConfirmation) {
        this.authError.set('注册成功！请查收邮件并点击验证链接完成注册。');
      } else if (signedUpUserId) {
        disableLocalMode();
        this.sessionEmail.set(signedUpEmail);
        const loadGeneration = ++this.authLoadGeneration;
        // 【修复】与 handleLogin 对齐，增加超时保护防止数据加载卡死
        const SIGNUP_DATA_LOAD_TIMEOUT_MS = 8000;
        const loadPromise = this.userSession.setCurrentUser(signedUpUserId, { forceLoad: true });
        const loadStatus = await this.waitWithTimeout(loadPromise, SIGNUP_DATA_LOAD_TIMEOUT_MS);
        if (loadStatus === 'timeout') {
          this.logger.warn('[Signup] 数据加载超时，转后台继续', { timeoutMs: SIGNUP_DATA_LOAD_TIMEOUT_MS });
          void loadPromise.catch(e => {
            if (!this.isAuthLoadCurrent(signedUpUserId, loadGeneration)) {
              return;
            }
            this.logger.error('[Signup] 后台数据加载失败', e);
          });
        }
        this.toast.success('注册成功', '欢迎使用');
        this.modal.closeByType('login', { success: true, userId: signedUpUserId });
        this.isSignupMode.set(false);
      } else {
        this.logger.warn('[Signup] 注册成功但未返回 userId，无法安全初始化会话');
        this.authError.set('注册成功，但会话初始化失败，请重新登录。');
      }
    } catch (e: unknown) {
      const err = e as Error | undefined;
      this.authError.set(humanizeErrorMessage(err?.message ?? String(e)));
    } finally {
      this.isAuthLoading.set(false);
    }
  }

  async handleResetPassword(event?: Event): Promise<void> {
    event?.preventDefault();
    if (!this.auth.isConfigured) {
      this.authError.set('Supabase keys missing.');
      return;
    }
    if (!this.authEmail()) {
      this.authError.set('请输入邮箱地址');
      return;
    }
    this.authError.set(null);
    this.isAuthLoading.set(true);
    try {
      const result = await this.auth.resetPassword(this.authEmail());
      if (isFailure(result)) {
        throw new Error(this.getAuthFailureMessage(result.error));
      }
      this.resetPasswordSent.set(true);
    } catch (e: unknown) {
      const err = e as Error | undefined;
      this.authError.set(humanizeErrorMessage(err?.message ?? String(e)));
    } finally {
      this.isAuthLoading.set(false);
    }
  }

  // ========== 模式切换 ==========

  switchToSignup(): void {
    this.isSignupMode.set(true);
    this.isResetPasswordMode.set(false);
    this.authError.set(null);
    this.authPassword.set('');
    this.authConfirmPassword.set('');
  }

  switchToLogin(): void {
    this.isSignupMode.set(false);
    this.isResetPasswordMode.set(false);
    this.resetPasswordSent.set(false);
    this.authError.set(null);
  }

  switchToResetPassword(): void {
    this.isResetPasswordMode.set(true);
    this.isSignupMode.set(false);
    this.resetPasswordSent.set(false);
    this.authError.set(null);
  }

  startRelogin(): void {
    this.isReloginMode.set(true);
    this.authPassword.set('');
    this.authError.set(null);
    if (this.sessionEmail()) {
      this.authEmail.set(this.sessionEmail()!);
    }
  }

  // ========== 登出 ==========

  /**
   * 按需获取 AttachmentService，避免其重型依赖进入启动主链路。
   * single-flight：并发请求复用同一个 Promise。
   */
  async getAttachmentServiceLazy(): Promise<AttachmentService | null> {
    if (this.attachmentServiceRef) {
      return this.attachmentServiceRef;
    }
    if (this.attachmentServicePromise) {
      return this.attachmentServicePromise;
    }

    this.attachmentServicePromise = import('../../../services/attachment.service')
      .then(({ AttachmentService: AttachmentServiceToken }) => {
        const service = this.injector.get(AttachmentServiceToken);
        this.attachmentServiceRef = service;
        return service;
      })
      .catch((error: unknown) => {
        this.logger.warn('AttachmentService 懒加载失败，降级继续', error);
        return null;
      })
      .finally(() => {
        this.attachmentServicePromise = null;
      });

    return this.attachmentServicePromise;
  }

  /**
   * 按需获取 MigrationService，避免登录前把迁移链路静态打入首屏。
   * single-flight：并发请求复用同一个 Promise。
   */
  async getMigrationServiceLazy(): Promise<MigrationService | null> {
    if (this.migrationServiceRef) {
      return this.migrationServiceRef;
    }
    if (this.migrationServicePromise) {
      return this.migrationServicePromise;
    }

    this.migrationServicePromise = import('../../../services/migration.service')
      .then(({ MigrationService: MigrationServiceToken }) => {
        const service = this.injector.get(MigrationServiceToken);
        this.migrationServiceRef = service;
        return service;
      })
      .catch((error: unknown) => {
        this.logger.warn('MigrationService 懒加载失败，降级跳过迁移检查', error);
        return null;
      })
      .finally(() => {
        this.migrationServicePromise = null;
      });

    return this.migrationServicePromise;
  }

  /**
   * 按需获取 ProjectDataService，避免登录页实例化时拉起整个同步主链路。
   * single-flight：并发请求复用同一个 Promise。
   */
  async getProjectDataServiceLazy(): Promise<ProjectDataService | null> {
    if (this.projectDataServiceRef) {
      return this.projectDataServiceRef;
    }
    if (this.projectDataServicePromise) {
      return this.projectDataServicePromise;
    }

    this.projectDataServicePromise = import('./sync/project-data.service')
      .then(({ ProjectDataService: ProjectDataServiceToken }) => {
        const service = this.injector.get(ProjectDataServiceToken);
        this.projectDataServiceRef = service;
        return service;
      })
      .catch((error: unknown) => {
        this.logger.warn('ProjectDataService 懒加载失败，降级跳过迁移探测', error);
        return null;
      })
      .finally(() => {
        this.projectDataServicePromise = null;
      });

    return this.projectDataServicePromise;
  }

  /**
   * 执行认证相关的登出清理
    * 返回 true 表示登出完成；返回 false 表示远端吊销失败，调用方必须保留当前登录态
   */
  async signOut(): Promise<boolean> {
    this.authLoadGeneration++;
    this.migrationCheckGeneration++;
    const currentUserId = this.auth.currentUserId();
    let localCleanupFailed = false;

    if (
      currentUserId
      && currentUserId !== AUTH_CONFIG.LOCAL_MODE_USER_ID
      && this.auth.isConfigured
    ) {
      const revokeResult = await this.widgetBinding.revokeAllBindings();
      if (isFailure(revokeResult)) {
        const message = humanizeErrorMessage(getErrorMessage(revokeResult.error));
        this.logger.error('Widget 远端吊销失败，中断登出流程', revokeResult.error);
        this.toast.error('设备吊销失败', `${message}；请在网络恢复后重试，当前不会退出登录`);
        return false;
      }
    }

    // 【P0 安全修复】在清理本地数据前，先调用各服务的 onUserLogout
    // 防止跨用户数据泄露：乐观更新快照、撤销历史、附件 URL 缓存
    try {
      this.optimisticState.onUserLogout();
      this.undoService.onUserLogout();
      const attachmentService = await this.getAttachmentServiceLazy();
      attachmentService?.onUserLogout();
    } catch (e) {
      this.logger.warn('onUserLogout 清理过程中出错，继续登出流程', e);
    }

    try {
      await this.userSession.setCurrentUser(null, {
        skipPersistentReload: true,
      });

      await this.userSession.clearAllLocalData(currentUserId ?? undefined);
    } catch (error) {
      localCleanupFailed = true;
      this.logger.error('本地数据清理失败，继续完成登出流程', error);
    }

    if (this.auth.isConfigured) {
      await this.auth.signOut();
    }
    // 清除认证相关 signals
    this.sessionEmail.set(null);
    this.authEmail.set('');
    this.authPassword.set('');
    this.authConfirmPassword.set('');
    this.authError.set(null);
    this.isReloginMode.set(false);
    this.isSignupMode.set(false);
    this.isResetPasswordMode.set(false);
    this.resetPasswordSent.set(false);

    if (localCleanupFailed) {
      this.toast.warning('本地清理未完成', '已退出登录；若需彻底清理本地缓存，请关闭其他标签页后重试');
    }

    return true;
  }

  // ========== 模态框事件处理 ==========

  async handleLoginFromModal(data: { email: string; password: string }): Promise<void> {
    this.authEmail.set(data.email);
    this.authPassword.set(data.password);
    await this.handleLogin(undefined, { skipPostAuthNavigation: true });
  }

  async handleSignupFromModal(data: { email: string; password: string; confirmPassword: string }): Promise<void> {
    this.authEmail.set(data.email);
    this.authPassword.set(data.password);
    this.authConfirmPassword.set(data.confirmPassword);
    await this.handleSignup();
  }

  async handleResetPasswordFromModal(email: string): Promise<void> {
    this.authEmail.set(email);
    await this.handleResetPassword();
  }

  /** 处理本地模式选择 */
  handleLocalModeFromModal(): void {
    enableLocalMode();
    this.auth.currentUserId.set(AUTH_CONFIG.LOCAL_MODE_USER_ID);
    this.modal.closeByType('login', { success: true, userId: AUTH_CONFIG.LOCAL_MODE_USER_ID });
    void this.userSession.loadProjects();
    this.toast.info('本地模式', '数据仅保存在本地，不会同步到云端');
  }

  // ========== 迁移检查 ==========

  private isMigrationCheckCurrent(userId: string | null, generation: number): boolean {
    return Boolean(
      userId &&
      userId !== AUTH_CONFIG.LOCAL_MODE_USER_ID &&
      this.migrationCheckGeneration === generation &&
      this.userSession.currentUserId() === userId
    );
  }

  private isAuthLoadCurrent(userId: string | null, generation: number): boolean {
    return this.authLoadGeneration === generation && this.userSession.currentUserId() === userId;
  }

  private async checkMigrationAfterLogin(
    userId: string | null = this.userSession.currentUserId(),
    generation: number = this.migrationCheckGeneration
  ): Promise<void> {
    if (!this.isMigrationCheckCurrent(userId, generation)) {
      return;
    }

    const migrationService = await this.getMigrationServiceLazy();
    if (!migrationService) return;

    if (!this.isMigrationCheckCurrent(userId, generation)) {
      return;
    }

    const projectDataService = await this.getProjectDataServiceLazy();
    if (!projectDataService) {
      return;
    }

    if (!this.isMigrationCheckCurrent(userId, generation)) {
      return;
    }

    if (!userId) {
      return;
    }

    const remoteProjects = await projectDataService.loadProjectListMetadataFromCloud(userId);
    if (!this.isMigrationCheckCurrent(userId, generation)) {
      return;
    }

    if (remoteProjects === null) {
      this.logger.warn('登录后迁移检查无法确认云端项目，已跳过本次迁移提示');
      return;
    }

    const needsMigration = migrationService.checkMigrationNeeded(remoteProjects);
    if (needsMigration && this.isMigrationCheckCurrent(userId, generation)) {
      this.modal.show('migration');
    }
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

  // ========== 私有工具 ==========

  /** 类型守卫：校验模态数据是否为 LoginData */
  private isLoginData(data: unknown): data is LoginData {
    return data != null && typeof data === 'object' && 'returnUrl' in (data as Record<string, unknown>);
  }
}
