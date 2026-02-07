import { Injectable, inject, signal, computed } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from '../../../services/auth.service';
import { UserSessionService } from '../../../services/user-session.service';
import { ProjectStateService } from '../../../services/project-state.service';
import { MigrationService } from '../../../services/migration.service';
import { ModalService, type LoginData } from '../../../services/modal.service';
import { ToastService } from '../../../services/toast.service';
import { LoggerService } from '../../../services/logger.service';
import { enableLocalMode, disableLocalMode } from '../../../services/guards';
import { getErrorMessage, isFailure, humanizeErrorMessage } from '../../../utils/result';
import { AUTH_CONFIG } from '../../../config';

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
  private readonly logger = inject(LoggerService).category('Auth');
  private readonly auth = inject(AuthService);
  private readonly userSession = inject(UserSessionService);
  private readonly projectState = inject(ProjectStateService);
  private readonly migrationService = inject(MigrationService);
  private readonly modal = inject(ModalService);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);

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

  // ========== 会话引导 ==========

  /** 调度会话引导（在首屏渲染后执行） */
  scheduleSessionBootstrap(): void {
    queueMicrotask(() => {
      this.bootstrapSession().catch(_e => {
        // 错误已在 bootstrapSession 内部处理
      });
    });
  }

  /** 重试启动会话 */
  retryBootstrap(): void {
    this.bootstrapSession().catch(_e => {});
  }

  private async bootstrapSession(): Promise<void> {
    if (!this.auth.isConfigured) {
      this.logger.debug('[Bootstrap] Supabase 未配置，启用离线模式');
      this.isCheckingSession.set(false);
      await this.userSession.setCurrentUser(null);
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
        await this.userSession.setCurrentUser(result.userId);
        const loadElapsed = Date.now() - loadStartTime;
        this.logger.debug(`[Bootstrap] 步骤 2/3: 数据加载完成 (耗时 ${loadElapsed}ms)`);
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
      const userId = this.auth.currentUserId();
      if (userId) {
        localStorage.setItem('currentUserId', userId);
      }
      await this.userSession.setCurrentUser(userId);
      this.toast.success('登录成功', `欢迎回来`);
      await this.checkMigrationAfterLogin();
      this.isReloginMode.set(false);
      const loginData = this.modal.getData('login') as LoginData | undefined;
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
        await this.userSession.setCurrentUser(this.auth.currentUserId());
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
   * 执行认证相关的登出清理
   * 返回后，调用方需要自行清理组件级别的状态
   */
  async signOut(): Promise<void> {
    const currentUserId = this.auth.currentUserId();
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
    const loginData = this.modal.getData('login') as LoginData | undefined;
    const returnUrl = loginData?.returnUrl || '/projects';
    void this.router.navigateByUrl(returnUrl);
  }

  // ========== 迁移检查 ==========

  private async checkMigrationAfterLogin(): Promise<void> {
    const remoteProjects = this.projectState.projects();
    const needsMigration = this.migrationService.checkMigrationNeeded(remoteProjects);
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
}
