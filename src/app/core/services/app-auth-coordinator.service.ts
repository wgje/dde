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
import { enableLocalMode, disableLocalMode } from '../../../services/guards';
import { getErrorMessage, isFailure, humanizeErrorMessage } from '../../../utils/result';
import { AUTH_CONFIG } from '../../../config/auth.config';
import { FEATURE_FLAGS } from '../../../config/feature-flags.config';
import type { AttachmentService } from '../../../services/attachment.service';
import type { MigrationService } from '../../../services/migration.service';

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

  private attachmentServiceRef: AttachmentService | null = null;
  private attachmentServicePromise: Promise<AttachmentService | null> | null = null;
  private migrationServiceRef: MigrationService | null = null;
  private migrationServicePromise: Promise<MigrationService | null> | null = null;

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
      this.bootstrapSession().catch(_e => {
        // 错误已在 bootstrapSession 内部处理
      });
    };

    // 关键：确保首帧先完成渲染，再进行会话检查
    if (typeof window !== 'undefined' && 'requestAnimationFrame' in window) {
      requestAnimationFrame(() => setTimeout(runBootstrap, 0));
      return;
    }

    setTimeout(runBootstrap, 0);
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
    const totalStartTime = Date.now();
    this.isCheckingSession.set(true);
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
        this.logger.debug('[Bootstrap] 步骤 2/3: 用户已登录，开始加载数据...');
        const loadStartTime = Date.now();
        const loadPromise = this.userSession.setCurrentUser(result.userId);
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

          void loadPromise.then(() => {
            const backgroundElapsed = Date.now() - loadStartTime;
            this.logger.info(`[Bootstrap] 后台数据加载完成 (耗时 ${backgroundElapsed}ms)`);
          }).catch((error: unknown) => {
            this.logger.error('[Bootstrap] 后台数据加载失败', error);
          });
        }

        this.logger.debug('[Bootstrap] 步骤 3/3: 检查项目数据...', {
          projectCount: this.projectState.projects().length,
          activeProjectId: this.projectState.activeProjectId()
        });
      } else {
        this.logger.debug('[Bootstrap] 步骤 2/3: 无现有会话，跳过数据加载');
      }

      this.logger.debug('[Bootstrap] ========== 启动成功 ==========');
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
    } finally {
      const totalElapsed = Date.now() - totalStartTime;
      this.logger.debug(`[Bootstrap] 完成，设置 isCheckingSession = false (总耗时 ${totalElapsed}ms)`);
      this.isCheckingSession.set(false);
      this.bootstrapInFlight = false;
    }
  }

  // ========== 登录/注册/重置 ==========

  async handleLogin(event?: Event, opts?: { closeSettings?: boolean }): Promise<void> {
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
        throw new Error(getErrorMessage(result.error));
      }
      disableLocalMode();
      this.sessionEmail.set(this.auth.sessionEmail());
      // 【P0 修复 2026-02-08】从 signIn 结果中获取 userId，而非从 signal 读取
      // signIn() 不再提前设置 currentUserId，由 setCurrentUser 统一管理
      const userId = result.value.userId ?? null;
      if (userId) {
        localStorage.setItem('currentUserId', userId);
      }
      // 【P0 修复 2026-02-08】使用 waitWithTimeout 防止数据加载卡死
      // 与 bootstrapSession 对齐，超时后转后台继续，不阻塞 UI
      const DATA_LOAD_TIMEOUT_MS = 8000;
      const loadPromise = this.userSession.setCurrentUser(userId, { forceLoad: true });
      const loadStatus = await this.waitWithTimeout(loadPromise, DATA_LOAD_TIMEOUT_MS);
      if (loadStatus === 'timeout') {
        this.logger.warn('[Login] 数据加载超时，转后台继续', { timeoutMs: DATA_LOAD_TIMEOUT_MS });
        // 超时不阻断登录流程，数据在后台继续加载
        void loadPromise.catch(e => this.logger.error('[Login] 后台数据加载失败', e));
      }
      this.toast.success('登录成功', `欢迎回来`);
      await this.checkMigrationAfterLogin();
      this.isReloginMode.set(false);
      const rawLoginData = this.modal.getData('login');
      const loginData = this.isLoginData(rawLoginData) ? rawLoginData : undefined;
      const returnUrl = loginData?.returnUrl;
      this.modal.closeByType('login', { success: true, userId: userId ?? undefined });
      if (opts?.closeSettings) {
        this.modal.closeByType('settings');
      }
      if (returnUrl && returnUrl !== '/') {
        void this.router.navigateByUrl(returnUrl);
      }
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
        throw new Error(getErrorMessage(result.error));
      }
      if (result.value.needsConfirmation) {
        this.authError.set('注册成功！请查收邮件并点击验证链接完成注册。');
      } else if (this.auth.currentUserId()) {
        this.sessionEmail.set(this.auth.sessionEmail());
        // 【修复】与 handleLogin 对齐，增加超时保护防止数据加载卡死
        const SIGNUP_DATA_LOAD_TIMEOUT_MS = 8000;
        const loadPromise = this.userSession.setCurrentUser(this.auth.currentUserId(), { forceLoad: true });
        const loadStatus = await this.waitWithTimeout(loadPromise, SIGNUP_DATA_LOAD_TIMEOUT_MS);
        if (loadStatus === 'timeout') {
          this.logger.warn('[Signup] 数据加载超时，转后台继续', { timeoutMs: SIGNUP_DATA_LOAD_TIMEOUT_MS });
          void loadPromise.catch(e => this.logger.error('[Signup] 后台数据加载失败', e));
        }
        this.toast.success('注册成功', '欢迎使用');
        this.modal.closeByType('login', { success: true, userId: this.auth.currentUserId() ?? undefined });
        this.isSignupMode.set(false);
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
        throw new Error(getErrorMessage(result.error));
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
   * 执行认证相关的登出清理
   * 返回后，调用方需要自行清理组件级别的状态
   */
  async signOut(): Promise<void> {
    const currentUserId = this.auth.currentUserId();
    
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
    
    await this.userSession.clearAllLocalData(currentUserId ?? undefined);
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
    await this.userSession.setCurrentUser(null);
  }

  // ========== 模态框事件处理 ==========

  async handleLoginFromModal(data: { email: string; password: string }): Promise<void> {
    this.authEmail.set(data.email);
    this.authPassword.set(data.password);
    await this.handleLogin();
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
    const rawLoginData = this.modal.getData('login');
    const loginData = this.isLoginData(rawLoginData) ? rawLoginData : undefined;
    const returnUrl = loginData?.returnUrl || '/projects';
    void this.router.navigateByUrl(returnUrl);
  }

  // ========== 迁移检查 ==========

  private async checkMigrationAfterLogin(): Promise<void> {
    const migrationService = await this.getMigrationServiceLazy();
    if (!migrationService) return;

    const remoteProjects = this.projectState.projects();
    const needsMigration = migrationService.checkMigrationNeeded(remoteProjects);
    if (needsMigration) {
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
