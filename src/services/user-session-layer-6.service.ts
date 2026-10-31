import { inject } from '@angular/core';
import { AUTH_CONFIG } from '../config/auth.config';

import { UserSessionLayer5 } from './user-session-layer-5.service';
import { type SessionGuardContext, type SetCurrentUserContext, type SetCurrentUserOptions } from './user-session-base.service';
import { LocalBackupUiRestoreStartupRecoveryService } from './local-backup-ui-restore-startup-recovery.service';
import { getAuthOwnerTransition } from './auth-owner-transition.controller';

export abstract class UserSessionLayer6 extends UserSessionLayer5 {
  private readonly localBackupUiRestoreStartupRecovery = inject(
    LocalBackupUiRestoreStartupRecoveryService,
  );


  // ========== 私有方法 ==========

  /** 加载用户数据：加载项目 + 后台建立实时订阅 */
  protected async loadUserData(userId: string, sessionGuard?: SessionGuardContext): Promise<void> {
    if (this.shouldAbortStaleSession(sessionGuard, 'loadUserData:start')) {
      return;
    }

    // 先加载项目数据（这个需要等待）
    try {
      await this.loadProjectsForSession(sessionGuard ?? this.createSessionGuard(userId));
    } catch (error) {
      if (this.shouldAbortStaleSession(sessionGuard, 'loadUserData:load-projects-error')) {
        return;
      }
      // loadProjects 内部已有错误处理，这里是最后的防线
      this.warnUserSessionLifecycleSafely('loadProjects 未捕获异常', error);
      // 确保至少有可用的数据
      try {
        await this.loadFromCacheOrSeed(undefined, sessionGuard);
      } catch (fallbackError) {
        this.warnUserSessionLifecycleSafely('种子数据加载失败', fallbackError);
      }

      // 向用户显示友好的错误提示
      this.toastService.error('数据加载失败', '已尝试加载本地数据，如问题持续请刷新页面');

      return;
    }

    if (this.shouldAbortStaleSession(sessionGuard, 'loadUserData:after-load-projects')) {
      return;
    }

    if (!userId || userId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      return;
    }

    // 实时订阅和冲突数据重载在后台执行，不阻塞 UI
    // 使用 Promise 而非 await，让它们在后台运行
    this.syncCoordinator.initRealtimeSubscription(userId).catch((e: unknown) => {
      this.warnUserSessionLifecycleSafely('实时订阅初始化失败（后台）', e);
      // 实时订阅失败不影响核心功能，静默处理
    });

    this.syncCoordinator.tryReloadConflictData(userId, (id) =>
      this.projectState.getProject(id)
    ).catch(e => {
      this.warnUserSessionLifecycleSafely('冲突数据重载失败（后台）', e);
      // 冲突数据重载失败不影响核心功能，静默处理
    });
  }


  protected async loadUserDataWithSeedFallback(
    userId: string,
    sessionGuard: SessionGuardContext,
  ): Promise<void> {
    try {
      await this.loadUserData(userId, sessionGuard);
    } catch (error) {
      this.warnUserSessionLifecycleSafely('loadUserData 失败', error);
      await this.loadSeedFallbackQuietly(sessionGuard);
    }
  }


  protected async loadSessionDataForCurrentUser(
    context: SetCurrentUserContext,
    sessionGuard: SessionGuardContext,
  ): Promise<void> {
    if (!context.userId) {
      await this.loadAnonymousSessionData(sessionGuard);
      return;
    }

    // forceLoad 修复登录竞态：auth signal 可能已提前设置，不能只依赖 isUserChange。
    const hasProjects = this.projectState.projects().length > 0;
    if (context.forceLoad || !hasProjects || context.isUserChange) {
      await this.loadUserDataWithSeedFallback(context.userId, sessionGuard);
    }
  }


  protected async recoverInterruptedDataSafetyRestoreForCurrentUser(
    context: SetCurrentUserContext,
    sessionGuard: SessionGuardContext,
  ): Promise<boolean> {
    if (!context.userId) return true;
    if (this.shouldAbortStaleSession(sessionGuard, 'setCurrentUser:before-data-safety-recovery')) {
      return false;
    }

    const localBackupRecovery = await this.localBackupUiRestoreStartupRecovery.recover(
      context.userId,
    );
    if (localBackupRecovery.status === 'blocked') {
      this.logger.warn('本地备份还原启动恢复被阻止，保留标记并停止加载本地数据', {
        ownerUserId: context.userId,
        reason: localBackupRecovery.reason,
      });
      return false;
    }

    try {
      const recovery = await this.storePersistence.recoverInterruptedDataSafetyRestore(context.userId);
      if (recovery.errors.length > 0) {
        this.logger.warn('恢复中断的数据安全还原未完成，保留标记并停止加载本地数据', {
          ownerUserId: context.userId,
          errors: recovery.errors,
        });
        return false;
      }
    } catch (error) {
      this.logger.warn('恢复中断的数据安全还原失败，保留标记并停止加载本地数据', error);
      return false;
    }
    return true;
  }


  /**
   * 设置当前用户（登录/登出时调用，总是会加载项目数据）
   * @param userId 用户 ID，null 表示登出
   * @param opts.forceLoad 强制加载数据，跳过 isUserChange 检查（登录时必须为 true）
   * @param opts.skipPersistentReload 仅切换身份与清空内存，不重新加载任何本地持久化数据；
   *  用于 full wipe 失败后的安全登出，避免旧快照被重新灌回匿名态。
   * @param opts.previousUserIdHint 当前 auth signal 已提前清空时，仍用于完成旧 owner 的安全 teardown。
   * @param opts.preserveOfflineSnapshot 仅清理内存视图，不清空旧 owner 的离线快照桶。
   */
  async setCurrentUser(userId: string | null, opts?: SetCurrentUserOptions): Promise<void> {
    const ownerTransitionController = getAuthOwnerTransition(this.authService);
    const ownerTransition = ownerTransitionController.capture(userId);
    try {
      const sessionGuard = this.createSessionGuard(userId);
      const context = this.createSetCurrentUserContext(userId, opts);

      this.logSetCurrentUserContext(context);
      this.resetSessionAccessStateIfNeeded(context);

      let applyOwnerChangeCleanup: () => void = () => undefined;
      if (this.shouldPrepareOwnerChange(context)) {
        const preparation = await this.prepareOwnerChange(context, sessionGuard);
        if (!preparation) return;
        if (this.shouldAbortStaleSessionGeneration(sessionGuard, 'setCurrentUser:after-owner-change-prepare')) {
          return;
        }
        applyOwnerChangeCleanup = () => this.applyOwnerChangeCleanup(context, preparation);
      }

      const ownerCommit = ownerTransitionController.commit(
        ownerTransition,
        applyOwnerChangeCleanup,
      );
      if (ownerCommit.status === 'stale') return;
      if (this.shouldAbortStaleSession(sessionGuard, 'setCurrentUser:after-auth-set')) return;

      if (context.skipPersistentReload) {
        await this.reloadCurrentOwnerQueues(context.skipPersistentReload);
        await this.refreshConflictCountQuietly();
        return;
      }

      const mayLoadLocalData = await this.recoverInterruptedDataSafetyRestoreForCurrentUser(
        context,
        sessionGuard,
      );
      if (!mayLoadLocalData
        || this.shouldAbortStaleSession(sessionGuard, 'setCurrentUser:after-data-safety-recovery')) return;

      await this.reloadCurrentOwnerQueues(context.skipPersistentReload);
      await this.refreshConflictCountQuietly();

      await this.loadSessionDataForCurrentUser(context, sessionGuard);
    } finally {
      ownerTransitionController.discard(ownerTransition);
    }
  }
}
