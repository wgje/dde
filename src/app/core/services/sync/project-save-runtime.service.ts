import { Injectable, inject } from '@angular/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { AUTH_CONFIG } from '../../../../config';
import { CircuitBreakerService } from '../../../../services/circuit-breaker.service';
import { LoggerService } from '../../../../services/logger.service';
import { MobileSyncStrategyService } from '../../../../services/mobile-sync-strategy.service';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import { SupabaseClientService } from '../../../../services/supabase-client.service';
import {
  getRemainingBrowserNetworkResumeDelayMs,
  isBrowserNetworkSuspendedError,
  isBrowserNetworkSuspendedWindow,
} from '../../../../utils/browser-network-suspension';
import { classifySupabaseClientFailure, supabaseErrorToError } from '../../../../utils/supabase-error';
import { ToastService } from '../../../../services/toast.service';
import { SessionManagerService } from './session-manager.service';
import { SyncStateService } from './sync-state.service';
import type {
  BatchSyncResult,
  ProjectSavePreflightResult,
  ProjectSaveRetryContext,
  ProjectSaveRuntimeContext,
  ProjectSaveSessionRefreshContext,
  RefreshedProjectSaveSessionContext,
} from './batch-sync.types';
import { decideRefreshedProjectSaveSession } from './project-save-plan';

@Injectable({ providedIn: 'root' })
export class ProjectSaveRuntimeService {
  private readonly supabase = inject(SupabaseClientService);
  private readonly logger = inject(LoggerService).category('BatchSync');
  private readonly toast = inject(ToastService);
  private readonly circuitBreaker = inject(CircuitBreakerService);
  private readonly mobileSync = inject(MobileSyncStrategyService);
  private readonly syncState = inject(SyncStateService);
  private readonly sessionManager = inject(SessionManagerService);
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);

  async runProjectSavePreflight(context: ProjectSaveRuntimeContext): Promise<ProjectSavePreflightResult> {
    if (context.userId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      return { result: this.localModeResult(context) };
    }

    if (!this.mobileSync.shouldAllowSync()) {
      return { result: await this.networkDeferredResult(context) };
    }

    const circuitValidation = this.circuitBreaker.validateBeforeSync(context.project);
    if (!circuitValidation.passed && circuitValidation.shouldBlock) {
      return { result: this.circuitBlockedResult(context) };
    }

    const client = this.getSupabaseClient();
    if (!client) {
      return { result: await this.clientUnavailableResult(context) };
    }

    const sessionResult = await this.validateProjectSaveSession(client, context);
    return sessionResult ? { result: sessionResult } : { client };
  }

  private getSupabaseClient(): SupabaseClient | null {
    if (!this.supabase.isConfigured) {
      const failure = classifySupabaseClientFailure(false);
      this.logger.warn('无法获取 Supabase 客户端', failure);
      this.syncState.setSyncError(failure.message);
      return null;
    }
    try {
      return this.supabase.client();
    } catch (error) {
      const failure = classifySupabaseClientFailure(true, error);
      this.logger.warn('无法获取 Supabase 客户端', {
        category: failure.category,
        message: failure.message
      });
      this.syncState.setSyncError(failure.message);
      this.sentryLazyLoader.captureMessage('Sync client unavailable', {
        level: 'warning',
        tags: {
          operation: 'BatchSync.getSupabaseClient',
          category: failure.category
        }
      });
      // eslint-disable-next-line no-restricted-syntax -- 需保持离线降级契约，调用方使用 null 判定客户端不可用
      return null;
    }
  }

  private localModeResult(context: ProjectSaveRuntimeContext): BatchSyncResult {
    this.logger.debug('本地模式，跳过云端同步');
    return {
      success: false,
      failedTaskIds: context.state.failedTaskIds,
      failedConnectionIds: context.state.failedConnectionIds,
      retryEnqueued: context.state.retryEnqueued,
      projectPushed: context.state.projectPushed,
      failureReason: 'project sync skipped in local mode',
    };
  }

  private async networkDeferredResult(context: ProjectSaveRuntimeContext): Promise<BatchSyncResult> {
    this.logger.debug('网络感知: 同步被延迟', { projectId: context.project.id });
    await context.retryTracker.enqueueProjectRetry();
    return {
      success: false,
      failedTaskIds: context.state.failedTaskIds,
      failedConnectionIds: context.state.failedConnectionIds,
      retryEnqueued: context.state.retryEnqueued,
      projectPushed: context.state.projectPushed,
      failureReason: 'project sync deferred by network awareness',
    };
  }

  private circuitBlockedResult(context: ProjectSaveRuntimeContext): BatchSyncResult {
    this.logger.error('熔断: 同步被阻止', { projectId: context.project.id });
    this.sentryLazyLoader.captureMessage('CircuitBreaker: Sync blocked', {
      level: 'error',
      tags: { operation: 'saveProjectToCloud', projectId: context.project.id }
    });
    return {
      success: false,
      failedTaskIds: context.state.failedTaskIds,
      failedConnectionIds: context.state.failedConnectionIds,
      retryEnqueued: context.state.retryEnqueued,
      projectPushed: context.state.projectPushed,
      failureReason: 'project sync blocked by circuit breaker',
    };
  }

  private async clientUnavailableResult(context: ProjectSaveRuntimeContext): Promise<BatchSyncResult> {
    await context.retryTracker.enqueueProjectRetry();
    return {
      success: false,
      failedTaskIds: context.state.failedTaskIds,
      failedConnectionIds: context.state.failedConnectionIds,
      retryEnqueued: context.state.retryEnqueued,
      projectPushed: context.state.projectPushed,
      failureReason: 'supabase client unavailable for project sync',
    };
  }

  private async validateProjectSaveSession(
    client: SupabaseClient,
    context: ProjectSaveRuntimeContext,
  ): Promise<BatchSyncResult | null> {
    try {
      let { data: { session } } = await client.auth.getSession();
      if (!context.isSessionCurrent()) {
        return this.projectSaveSessionChangedResult(context);
      }
      let sessionUserId = session?.user?.id ?? null;

      if (!sessionUserId) {
        const refreshed = await this.sessionManager.tryRefreshSession('saveProjectToCloud.getSession');
        if (!context.isSessionCurrent()) {
          return this.projectSaveSessionChangedResult(context);
        }
        if (refreshed) {
          ({ data: { session } } = await client.auth.getSession());
          if (!context.isSessionCurrent()) {
            return this.projectSaveSessionChangedResult(context);
          }
          sessionUserId = session?.user?.id ?? null;
        }
      }

      return this.handleProjectSaveSessionUser(sessionUserId, context);
    } catch (error) {
      if (!context.isSessionCurrent()) {
        return this.projectSaveSessionChangedResult(context);
      }
      return this.handleProjectSaveSessionValidationError(error, client, context);
    }
  }

  private async projectSaveSessionChangedResult(
    context: ProjectSaveRuntimeContext | ProjectSaveRetryContext,
  ): Promise<BatchSyncResult> {
    const state = 'state' in context ? context.state : context;
    const enqueueProjectRetry = 'retryTracker' in context
      ? context.retryTracker.enqueueProjectRetry
      : context.enqueueProjectRetry;
    if (!state.retryEnqueued.includes(`project:${context.project.id}`)) {
      await enqueueProjectRetry();
    }
    this.logger.info('项目同步 session 代际已变化，预检结果失效并回退原 owner 重试', {
      projectId: context.project.id,
      userId: context.userId,
    });
    return {
      success: false,
      failedTaskIds: state.failedTaskIds,
      failedConnectionIds: state.failedConnectionIds,
      retryEnqueued: state.retryEnqueued,
      projectPushed: state.projectPushed,
      failureReason: 'project sync session changed',
    };
  }

  private async handleProjectSaveSessionUser(
    sessionUserId: string | null,
    context: ProjectSaveRuntimeContext,
  ): Promise<BatchSyncResult | null> {
    if (!sessionUserId) {
      if (isBrowserNetworkSuspendedWindow()) {
        return this.deferRuntimeProjectSyncForBrowserSuspension(context, 'saveProjectToCloud.getSession');
      }

      this.syncState.setSessionExpired(true);
      await context.retryTracker.enqueueProjectRetry();
      this.logger.warn('Session 过期，项目数据已入重试队列', { projectId: context.project.id });
      this.toast.warning('登录已过期', '请重新登录以继续同步数据');
      return {
        success: false,
        failedTaskIds: context.state.failedTaskIds,
        failedConnectionIds: context.state.failedConnectionIds,
        retryEnqueued: context.state.retryEnqueued,
        projectPushed: context.state.projectPushed,
        failureReason: 'project sync session expired',
      };
    }

    if (sessionUserId === context.userId) {
      return null;
    }

    await context.retryTracker.enqueueProjectRetry();
    this.logger.warn('检测到项目批量同步 owner 与当前会话不匹配，已拒绝云端写入', {
      projectId: context.project.id,
      expectedUserId: context.userId,
      sessionUserId,
    });
    this.syncState.setSyncError('账号已切换，项目稍后将按原 owner 重试');
    return {
      success: false,
      failedTaskIds: context.state.failedTaskIds,
      failedConnectionIds: context.state.failedConnectionIds,
      retryEnqueued: context.state.retryEnqueued,
      projectPushed: context.state.projectPushed,
      failureReason: 'project sync owner mismatch',
    };
  }

  private async handleProjectSaveSessionValidationError(
    error: unknown,
    client: SupabaseClient,
    context: ProjectSaveRuntimeContext,
  ): Promise<BatchSyncResult | null> {
    const enhanced = supabaseErrorToError(error);
    if (!this.sessionManager.isSessionExpiredError(enhanced)) {
      this.logger.warn('Session 预检暂不可用，项目数据已入重试队列等待恢复', {
        projectId: context.project.id,
        errorCode: enhanced.code,
        errorType: enhanced.errorType,
      });
      await context.retryTracker.enqueueProjectRetry();
      this.syncState.setSyncError(enhanced.message);
      return {
        success: false,
        failedTaskIds: context.state.failedTaskIds,
        failedConnectionIds: context.state.failedConnectionIds,
        retryEnqueued: context.state.retryEnqueued,
        projectPushed: context.state.projectPushed,
        failureReason: 'project sync session validation deferred',
      };
    }

    return this.handleExpiredProjectSaveSessionValidation(client, context, enhanced.code);
  }

  private async handleExpiredProjectSaveSessionValidation(
    client: SupabaseClient,
    context: ProjectSaveRuntimeContext,
    errorCode: string | number | undefined,
  ): Promise<BatchSyncResult | null> {
    this.logger.info('Session 预检命中认证错误，尝试刷新后继续项目批量同步', {
      projectId: context.project.id,
      userId: context.userId,
      errorCode,
    });
    const refreshed = await this.sessionManager.tryRefreshSession('saveProjectToCloud.getSession');
    if (!context.isSessionCurrent()) {
      return this.projectSaveSessionChangedResult(context);
    }

    if (refreshed) {
      return this.retryRefreshedProjectSaveSession({
        client,
        project: context.project,
        userId: context.userId,
        pendingTaskIdsToDelete: context.pendingTaskIdsToDelete,
        retryEnqueued: context.state.retryEnqueued,
        failedTaskIds: context.state.failedTaskIds,
        failedConnectionIds: context.state.failedConnectionIds,
        projectPushed: context.state.projectPushed,
        enqueueProjectRetry: context.retryTracker.enqueueProjectRetry,
        isSessionCurrent: context.isSessionCurrent,
      });
    }

    if (isBrowserNetworkSuspendedWindow()) {
      return this.deferRuntimeProjectSyncForBrowserSuspension(
        context,
        'saveProjectToCloud.getSession.refreshDeferred',
      );
    }

    this.logger.error('Session 验证失败');
    this.syncState.setSessionExpired(true);
    await context.retryTracker.enqueueProjectRetry();
    this.logger.warn('Session 验证异常，项目数据已入重试队列', { projectId: context.project.id });
    this.toast.warning('登录已过期', '请重新登录以继续同步数据');
    return {
      success: false,
      failedTaskIds: context.state.failedTaskIds,
      failedConnectionIds: context.state.failedConnectionIds,
      retryEnqueued: context.state.retryEnqueued,
      projectPushed: context.state.projectPushed,
      failureReason: 'project sync session validation failed',
    };
  }

  private async retryRefreshedProjectSaveSession(
    context: ProjectSaveSessionRefreshContext,
  ): Promise<BatchSyncResult | null> {
    try {
      const { data: { session } } = await context.client.auth.getSession();
      if (!context.isSessionCurrent()) {
        return this.projectSaveSessionChangedResult(context);
      }
      return this.handleRefreshedProjectSaveSession({
        ...context,
        sessionUserId: session?.user?.id ?? null,
      });
    } catch (retrySessionError) {
      return this.handleProjectSaveSessionRetryError(retrySessionError, context);
    }
  }

  private async handleRefreshedProjectSaveSession(
    context: RefreshedProjectSaveSessionContext,
  ): Promise<BatchSyncResult | null> {
    const decision = decideRefreshedProjectSaveSession({
      expectedUserId: context.userId,
      sessionUserId: context.sessionUserId,
      browserSuspendedWindow: isBrowserNetworkSuspendedWindow(),
    });

    switch (decision.kind) {
      case 'continue':
        this.logger.info('Session 刷新成功，继续项目批量同步', {
          projectId: context.project.id,
          userId: context.userId,
        });
        return null;
      case 'defer-by-suspension':
        return this.deferProjectSyncForBrowserSuspension(
          context,
          'saveProjectToCloud.getSession.afterRefresh',
        );
      case 'session-expired':
        return this.handleRefreshedProjectSaveSessionExpired(context);
      case 'owner-mismatch':
        return this.handleRefreshedProjectSaveOwnerMismatch(context);
    }
  }

  private async handleRefreshedProjectSaveSessionExpired(
    context: RefreshedProjectSaveSessionContext,
  ): Promise<BatchSyncResult> {
    this.syncState.setSessionExpired(true);
    await context.enqueueProjectRetry();
    this.logger.warn('Session 刷新后仍无有效会话，项目数据已入重试队列', { projectId: context.project.id });
    this.toast.warning('登录已过期', '请重新登录以继续同步数据');
    return {
      success: false,
      failedTaskIds: context.failedTaskIds,
      failedConnectionIds: context.failedConnectionIds,
      retryEnqueued: context.retryEnqueued,
      projectPushed: context.projectPushed,
      failureReason: 'project sync session expired after refresh',
    };
  }

  private async handleRefreshedProjectSaveOwnerMismatch(
    context: RefreshedProjectSaveSessionContext,
  ): Promise<BatchSyncResult> {
    await context.enqueueProjectRetry();
    this.logger.warn('Session 刷新后项目同步 owner 与当前会话不匹配，已回退到原 owner 重试队列', {
      projectId: context.project.id,
      expectedUserId: context.userId,
      sessionUserId: context.sessionUserId,
    });
    this.syncState.setSyncError('账号已切换，项目稍后将按原 owner 重试');
    return {
      success: false,
      failedTaskIds: context.failedTaskIds,
      failedConnectionIds: context.failedConnectionIds,
      retryEnqueued: context.retryEnqueued,
      projectPushed: context.projectPushed,
      failureReason: 'project sync owner mismatch after refresh',
    };
  }

  private async handleProjectSaveSessionRetryError(
    error: unknown,
    context: ProjectSaveRetryContext,
  ): Promise<BatchSyncResult> {
    if (isBrowserNetworkSuspendedError(error) || isBrowserNetworkSuspendedWindow()) {
      return this.deferProjectSyncForBrowserSuspension(context, 'saveProjectToCloud.getSession.retry');
    }

    const retryEnhanced = supabaseErrorToError(error);
    this.logger.warn('Session 刷新后再次校验失败，项目数据已入重试队列', {
      projectId: context.project.id,
      errorCode: retryEnhanced.code,
      errorType: retryEnhanced.errorType,
    });
    await context.enqueueProjectRetry();
    this.syncState.setSyncError(retryEnhanced.message);
    return {
      success: false,
      failedTaskIds: context.failedTaskIds,
      failedConnectionIds: context.failedConnectionIds,
      retryEnqueued: context.retryEnqueued,
      projectPushed: context.projectPushed,
      failureReason: 'project sync session validation retried and deferred',
    };
  }

  private async deferRuntimeProjectSyncForBrowserSuspension(
    context: ProjectSaveRuntimeContext,
    reason: string,
  ): Promise<BatchSyncResult> {
    return this.deferProjectSyncForBrowserSuspension({
      project: context.project,
      userId: context.userId,
      pendingTaskIdsToDelete: context.pendingTaskIdsToDelete,
      retryEnqueued: context.state.retryEnqueued,
      failedTaskIds: context.state.failedTaskIds,
      failedConnectionIds: context.state.failedConnectionIds,
      projectPushed: context.state.projectPushed,
      enqueueProjectRetry: context.retryTracker.enqueueProjectRetry,
      isSessionCurrent: context.isSessionCurrent,
    }, reason);
  }

  private async deferProjectSyncForBrowserSuspension(
    context: ProjectSaveRetryContext,
    reason: string,
  ): Promise<BatchSyncResult> {
    if (!context.retryEnqueued.includes(`project:${context.project.id}`)) {
      await context.enqueueProjectRetry();
    }

    this.logger.info('浏览器网络挂起，延后项目批同步', {
      projectId: context.project.id,
      userId: context.userId,
      context: reason,
      resumeDelayMs: getRemainingBrowserNetworkResumeDelayMs(),
    });
    this.syncState.setSyncError('浏览器恢复连接中，项目稍后继续同步');

    return {
      success: false,
      failedTaskIds: context.failedTaskIds,
      failedConnectionIds: context.failedConnectionIds,
      retryEnqueued: context.retryEnqueued,
      projectPushed: context.projectPushed,
      failureReason: 'project sync deferred by browser suspension',
    };
  }
}
