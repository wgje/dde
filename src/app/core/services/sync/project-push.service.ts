/**
 * ProjectPushService
 *
 * 从 SimpleSyncService「下切」出的「项目推送」链路（sync RPC + 耐久重试 + 会话刷新重试）。
 *
 * 职责单一：
 * - pushProject 全链路：单飞外的项目 upsert（CAS / sync RPC）+ 冲突判定 + 重试入队
 * - 会话过期/刷新重试、RLS 违规终态、版本冲突冒泡等错误分类
 *
 * 为什么抽离：
 * - AGENTS.md §12 单文件 ≤ 800 行硬线；SimpleSyncService 长期越界，文件头要求只做「下切」。
 * - 推送链路自洽，依赖多但可注入；`loadFullProjectOptimized` 兜底直接走注入的
 *   `ProjectDataService`。两个回facade依赖通过回调注入避免循环 DI：
 *   - `getSupabaseClient`（门面持有 sentry 归因 + 离线降级语义）
 *   - `durableRetryHandler`（门面 `addToRetryQueueDurably`，保留 session 守卫等完整语义）
 *
 * 验证：SimpleSyncService.spec 通过公开 API `pushProject(...)` 及 `pushProjectWithResult`
 * 的 `.call(context)` 用例覆盖本链路；门面 `pushProject()` 委托 + BatchSync 回调改指向本服务
 * 后该套用例继续校验零回归。
 */
import { Injectable, inject } from '@angular/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { Project } from '../../../../models';
import { LoggerService } from '../../../../services/logger.service';
import { ToastService } from '../../../../services/toast.service';
import { RequestThrottleService } from '../../../../services/request-throttle.service';
import { ClockSyncService } from '../../../../services/clock-sync.service';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import { SyncRpcClientService, type SyncRpcResult } from '../../../../services/sync-rpc-client.service';
import { SyncStateService } from './sync-state.service';
import { SessionManagerService } from './session-manager.service';
import { ProjectDataService } from './project-data.service';
import { ProjectStore } from '../../state/stores';
import {
  supabaseErrorToError,
  type EnhancedError,
} from '../../../../utils/supabase-error';
import { PermanentFailureError, isPermanentFailureError } from '../../../../utils/permanent-failure-error';
import { createRetryDeferredError, isRetryDeferredError } from '../../../../utils/retry-deferred-error';
import { createSyncOperationId } from '../../../../utils/sync-operation-id';
import { REQUEST_THROTTLE_CONFIG } from '../../../../config/sync.config';
import {
  createProjectRpcTerminalError as buildProjectRpcTerminalError,
  createProjectPersistenceTerminalError as buildProjectPersistenceTerminalError,
} from './sync-project-errors';
import {
  createProjectPushRetryContext,
} from './project-push-retry-context';
import { createRetryQueueLastFailure } from './retry-queue-failure-context';
import { ProjectPushRpcResultHandlerService } from './project-push-rpc-result-handler.service';
import type {
  TaskDeleteBaseUpdatedAtMap,
  RetryQueueLastFailure,
} from './retry-queue.service';
import type {
  DurableRetryHandler,
  GetSupabaseClientHandler,
  ProjectPushExecutor,
  ProjectPushRetryContext,
  ProjectPushStatus,
  ProjectPushStatusArgs,
} from './project-push.types';

@Injectable({ providedIn: 'root' })
export class ProjectPushService {
  private readonly logger = inject(LoggerService).category('ProjectPush');
  private readonly syncStateService = inject(SyncStateService);
  private readonly sessionManager = inject(SessionManagerService);
  private readonly throttle = inject(RequestThrottleService);
  private readonly toast = inject(ToastService);
  private readonly clockSync = inject(ClockSyncService);
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly projectDataService = inject(ProjectDataService);
  private readonly syncRpcClient = inject(SyncRpcClientService, { optional: true });
  private readonly projectStore = inject(ProjectStore, { optional: true });
  private readonly rpcResultHandler = inject(ProjectPushRpcResultHandlerService);

  /** 由 SimpleSyncService 构造期注入（避免循环 DI）。 */
  getSupabaseClientHandler: GetSupabaseClientHandler | null = null;
  durableRetryHandler: DurableRetryHandler | null = null;

  private get syncState() {
    return this.syncStateService.syncState;
  }

  async pushProject(
    project: Project,
    fromRetryQueue = false,
    sourceUserId?: string,
    taskIdsToDelete?: string[],
    taskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap,
    operationId?: string,
  ): Promise<boolean> {
    const result = await this.callPushProjectWithStatus({
      project,
      fromRetryQueue,
      sourceUserId,
      taskIdsToDelete,
      taskDeleteBaseUpdatedAtMap,
      operationId,
    });
    return result.success;
  }

  async pushProjectWithStatus(
    project: Project,
    fromRetryQueue = false,
    sourceUserId?: string,
    taskIdsToDelete?: string[],
    taskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap,
    operationId?: string,
  ): Promise<ProjectPushStatus> {
    const { retryContext, args } = this.createProjectPushStatusRuntime(
      project,
      fromRetryQueue,
      sourceUserId,
      taskIdsToDelete,
      taskDeleteBaseUpdatedAtMap,
      operationId,
    );
    if (this.syncState().sessionExpired) {
      return this.handleProjectPushPreflightFailure(
        project.id,
        retryContext,
        'project sync session expired',
        true,
      );
    }

    const client = this.getSupabaseClientHandler ? await this.getSupabaseClientHandler() : null;
    if (!client) {
      return await this.handleProjectPushPreflightFailure(
        project.id,
        retryContext,
        'supabase client unavailable for project sync',
        false,
      );
    }

    const executeProjectPush = this.createProjectPushExecutorFromStatusArgs(client, project, retryContext, args);

    try {
      const success = await this.throttle.execute(
        `push-project:${project.id}`,
        executeProjectPush,
        // 单项写超时对齐 task/connection 的 30s 基线：项目元数据失败会中止整批保存，
        // 60s 默认超时会让弱网挂起把批处理头部拖住两倍时间
        { priority: 'high', retries: 2, timeout: REQUEST_THROTTLE_CONFIG.INDIVIDUAL_OPERATION_TIMEOUT }
      );
      return this.createProjectPushThrottleStatus(success, retryContext);
    } catch (e) {
      return await this.handleProjectPushFailure(e, project, retryContext, executeProjectPush);
    }
  }

  private createProjectPushStatusRuntime(
    project: Project,
    fromRetryQueue: boolean,
    sourceUserId: string | undefined,
    taskIdsToDelete: string[] | undefined,
    taskDeleteBaseUpdatedAtMap: TaskDeleteBaseUpdatedAtMap | undefined,
    operationId: string | undefined,
  ): {
    retryContext: ProjectPushRetryContext;
    args: ProjectPushStatusArgs;
  } {
    const retryOperationId = operationId ?? createSyncOperationId();
    return {
      retryContext: createProjectPushRetryContext({
        durableRetryHandler: this.durableRetryHandler,
        project,
        fromRetryQueue,
        sourceUserId,
        taskIdsToDelete,
        taskDeleteBaseUpdatedAtMap,
        operationId: retryOperationId,
      }),
      args: {
        fromRetryQueue,
        sourceUserId,
        taskIdsToDelete,
        taskDeleteBaseUpdatedAtMap,
        operationId: retryOperationId,
      },
    };
  }

  private async handleProjectPushPreflightFailure(
    projectId: string,
    retryContext: ProjectPushRetryContext,
    failureReason: string,
    sessionExpired: boolean,
  ): Promise<ProjectPushStatus> {
    await retryContext.enqueueRetry();
    if (sessionExpired) {
      this.sessionManager.handleSessionExpired('pushProject', { projectId });
    }

    return {
      success: false,
      retryEnqueued: retryContext.retryEnqueued,
      failureReason,
    };
  }

  private createProjectPushThrottleStatus(
    success: boolean,
    retryContext: ProjectPushRetryContext,
  ): ProjectPushStatus {
    return {
      success,
      retryEnqueued: retryContext.retryEnqueued,
      failureReason: success
        ? undefined
        : (retryContext.retryEnqueued ? 'project sync queued for retry' : 'project push returned false'),
    };
  }

  private createProjectPushExecutorFromStatusArgs(
    client: SupabaseClient,
    project: Project,
    retryContext: ProjectPushRetryContext,
    options: ProjectPushStatusArgs,
  ): ProjectPushExecutor {
    return this.createProjectPushExecutor(
      client,
      project,
      options.fromRetryQueue,
      options.sourceUserId,
      options.taskIdsToDelete,
      options.taskDeleteBaseUpdatedAtMap,
      options.operationId,
      retryContext.enqueueRetry,
    );
  }

  private createProjectPushExecutor(
    client: SupabaseClient,
    project: Project,
    fromRetryQueue: boolean,
    sourceUserId: string | undefined,
    taskIdsToDelete: string[] | undefined,
    taskDeleteBaseUpdatedAtMap: TaskDeleteBaseUpdatedAtMap | undefined,
    operationId: string | undefined,
    enqueueRetry: (lastFailure?: RetryQueueLastFailure) => Promise<boolean>,
  ): ProjectPushExecutor {
    return async (): Promise<boolean> => {
      const sessionUserId = await this.resolveProjectPushSessionUserId(client);
      if (!sessionUserId) {
        await enqueueRetry();
        this.sessionManager.handleSessionExpired('pushProject.getSession', { projectId: project.id });
        return false;
      }

      if (sourceUserId && sessionUserId !== sourceUserId) {
        this.logger.warn('检测到项目重试归属与当前会话不匹配，已拒绝云端写入', {
          projectId: project.id,
          sourceUserId,
          sessionUserId,
        });
        await enqueueRetry();
        return false;
      }

      return await this.doProjectPush(
        project,
        sourceUserId ?? sessionUserId,
        fromRetryQueue,
        enqueueRetry,
        sourceUserId,
        taskIdsToDelete,
        taskDeleteBaseUpdatedAtMap,
        operationId,
      );
    };
  }

  private async resolveProjectPushSessionUserId(client: SupabaseClient): Promise<string | null> {
    const { data: { session } } = await client.auth.getSession();
    const sessionUserId = session?.user?.id ?? null;
    if (sessionUserId) {
      return sessionUserId;
    }

    const refreshed = await this.sessionManager.tryRefreshSession('pushProject.getSession');
    if (!refreshed) {
      return null;
    }

    const { data: { session: newSession } } = await client.auth.getSession();
    return newSession?.user?.id ?? null;
  }

  private async handleProjectPushFailure(
    error: unknown,
    project: Project,
    retryContext: ProjectPushRetryContext,
    executeProjectPush: ProjectPushExecutor,
  ): Promise<ProjectPushStatus> {
    if (isRetryDeferredError(error)) {
      throw error;
    }
    if (isPermanentFailureError(error)) {
      throw error;
    }

    const enhanced = this.toEnhancedError(error);
    if (this.sessionManager.isSessionExpiredError(enhanced)) {
      return await this.handleProjectPushSessionError(enhanced, project, retryContext, executeProjectPush);
    }

    return await this.handleProjectPushEnhancedError(enhanced, project, retryContext);
  }

  private async handleProjectPushSessionError(
    enhanced: EnhancedError,
    project: Project,
    retryContext: ProjectPushRetryContext,
    executeProjectPush: ProjectPushExecutor,
  ): Promise<ProjectPushStatus> {
    const canRetry = await this.sessionManager.handleAuthErrorWithRefresh('pushProject', {
      projectId: project.id,
      errorCode: enhanced.code
    });
    if (!canRetry) {
      await retryContext.enqueueRetry();
      this.sessionManager.handleSessionExpired('pushProject', { projectId: project.id, errorCode: enhanced.code });
      return {
        success: false,
        retryEnqueued: retryContext.retryEnqueued,
        failureReason: 'project sync session expired',
      };
    }

    try {
      const success = await executeProjectPush();
      return {
        success,
        retryEnqueued: retryContext.retryEnqueued,
        failureReason: success
          ? undefined
          : (
              retryContext.retryEnqueued
                ? 'project sync queued for retry after session refresh'
                : 'project push returned false after session refresh'
            ),
      };
    } catch (retryError) {
      return await this.handleProjectPushRetryAfterRefreshError(retryError, project, retryContext);
    }
  }

  private async handleProjectPushRetryAfterRefreshError(
    retryError: unknown,
    project: Project,
    retryContext: ProjectPushRetryContext,
  ): Promise<ProjectPushStatus> {
    if (isRetryDeferredError(retryError)) {
      throw retryError;
    }
    if (isPermanentFailureError(retryError)) {
      throw retryError;
    }

    const retryEnhanced = this.toEnhancedError(retryError);
    if (this.sessionManager.isSessionExpiredError(retryEnhanced)) {
      return await this.handleProjectPushExpiredAfterRefresh(retryEnhanced, project, retryContext);
    }

    return await this.handleProjectPushEnhancedError(retryEnhanced, project, retryContext);
  }

  private async handleProjectPushExpiredAfterRefresh(
    retryEnhanced: EnhancedError,
    project: Project,
    retryContext: ProjectPushRetryContext,
  ): Promise<ProjectPushStatus> {
    if (this.sessionManager.isRlsPolicyViolation(retryEnhanced)) {
      this.logger.warn('刷新会话后重试仍获 RLS 违规，判定为权限不足', {
        projectId: project.id,
        errorCode: retryEnhanced.code,
      });
      throw buildProjectPersistenceTerminalError(
        project.id,
        '项目同步权限校验失败，请重新登录后重试',
        'PermissionError',
        'SYNC_PROJECT_PERMISSION_DENIED',
      );
    }

    await retryContext.enqueueRetry();
    this.sessionManager.handleSessionExpired('pushProject.retryAfterRefresh', {
      projectId: project.id,
      errorCode: retryEnhanced.code
    });
    return {
      success: false,
      retryEnqueued: retryContext.retryEnqueued,
      failureReason: 'project sync session expired after refresh',
    };
  }

  private async handleProjectPushEnhancedError(
    enhanced: EnhancedError,
    project: Project,
    retryContext: ProjectPushRetryContext,
  ): Promise<ProjectPushStatus> {
    if (enhanced.errorType === 'VersionConflictError') {
      this.toast.warning('版本冲突', '数据已被修改，请刷新后重试');
      throw new PermanentFailureError('Version conflict', enhanced, { operation: 'pushProject', projectId: project.id });
    }

    if (!enhanced.isRetryable) {
      this.throwProjectPushTerminalError(project.id, enhanced);
    }

    await retryContext.enqueueRetry(createRetryQueueLastFailure(enhanced));
    return {
      success: false,
      retryEnqueued: retryContext.retryEnqueued,
      failureReason: enhanced.message,
    };
  }

  private throwProjectPushTerminalError(projectId: string, enhanced: EnhancedError): never {
    const isPermissionDenied = enhanced.errorType === 'PermissionError';
    throw buildProjectPersistenceTerminalError(
      projectId,
      isPermissionDenied ? '项目同步权限校验失败，请重新登录后重试' : enhanced.message,
      isPermissionDenied ? 'PermissionError' : 'BusinessRuleError',
      isPermissionDenied
        ? 'SYNC_PROJECT_PERMISSION_DENIED'
        : (enhanced.code ? String(enhanced.code) : 'SYNC_PROJECT_PERSISTENCE_FAILED'),
    );
  }

  private toEnhancedError(error: unknown): EnhancedError {
    return error && typeof error === 'object' && 'errorType' in error
      ? error as EnhancedError
      : supabaseErrorToError(error);
  }

  async pushProjectWithResult(
    project: Project,
    fromRetryQueue = false,
    sourceUserId?: string,
    taskIdsToDelete?: string[],
    taskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap,
    operationId?: string,
  ): Promise<{ success: boolean; conflict?: boolean; remoteData?: Project; retryEnqueued?: boolean; failureReason?: string; terminal?: boolean }> {
    try {
      const result = await this.callPushProjectWithStatus({
        project,
        fromRetryQueue,
        sourceUserId,
        taskIdsToDelete,
        taskDeleteBaseUpdatedAtMap,
        operationId,
      });
      return {
        success: result.success,
        retryEnqueued: result.retryEnqueued,
        failureReason: result.failureReason,
      };
    } catch (error) {
      if (!isPermanentFailureError(error)) {
        throw error;
      }

      const enhanced = error.originalError
        ? supabaseErrorToError(error.originalError)
        : null;
      if (enhanced?.errorType === 'VersionConflictError') {
        const remoteData = await this.projectDataService.loadFullProjectOptimized(project.id).catch(() => null);
        return {
          success: false,
          conflict: true,
          remoteData: remoteData ?? undefined,
          retryEnqueued: false,
          failureReason: 'project sync version conflict',
        };
      }

      return {
        success: false,
        retryEnqueued: false,
        failureReason: enhanced?.message ?? error.message,
        terminal: true,
      };
    }
  }

  private callPushProjectWithStatus(options: {
    project: Project;
    fromRetryQueue: boolean;
    sourceUserId?: string;
    taskIdsToDelete?: string[];
    taskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap;
    operationId?: string;
  }): Promise<ProjectPushStatus> {
    if (options.taskDeleteBaseUpdatedAtMap !== undefined) {
      return options.operationId === undefined
        ? this.pushProjectWithStatus(
            options.project,
            options.fromRetryQueue,
            options.sourceUserId,
            options.taskIdsToDelete,
            options.taskDeleteBaseUpdatedAtMap,
          )
        : this.pushProjectWithStatus(
            options.project,
            options.fromRetryQueue,
            options.sourceUserId,
            options.taskIdsToDelete,
            options.taskDeleteBaseUpdatedAtMap,
            options.operationId,
          );
    }

    return options.operationId === undefined
      ? this.pushProjectWithStatus(
          options.project,
          options.fromRetryQueue,
          options.sourceUserId,
          options.taskIdsToDelete,
        )
      : this.pushProjectWithStatus(
          options.project,
          options.fromRetryQueue,
          options.sourceUserId,
          options.taskIdsToDelete,
          undefined,
          options.operationId,
        );
  }

  private shouldUseSyncRpc(): boolean {
    return this.syncRpcClient?.isFeatureEnabled() === true && this.syncRpcClient.isClientRejected() === false;
  }

  private async primeProjectSyncRpcCapability(): Promise<void> {
    if (!this.syncRpcClient) {
      return;
    }

    if (this.shouldUseSyncRpc() || this.syncRpcClient.isClientRejected() === true) {
      return;
    }

    await this.syncRpcClient.checkProtocol();
  }

  private throwProjectSyncRpcClientRejected(projectId: string): never {
    const { message, result } = this.reportProjectSyncRpcClientRejected(projectId);
    throw buildProjectRpcTerminalError(projectId, result, message);
  }

  private reportProjectSyncRpcClientRejected(projectId: string): {
    message: string;
    result: SyncRpcResult;
  } {
    const message = '当前客户端同步协议已过期，请刷新后重试';
    const result: SyncRpcResult = {
      status: 'client-version-rejected',
      raw: null,
    };

    this.syncStateService.setSyncError(message);
    this.sentryLazyLoader.captureMessage('sync_rpc_project_rejected', {
      level: 'warning',
      tags: { operation: 'pushProject', entityType: 'project', status: result.status },
      extra: { projectId },
    });

    return { message, result };
  }

  private async enqueueProjectSyncRpcClientRejectedRetry(
    projectId: string,
    enqueueRetry: ((lastFailure?: RetryQueueLastFailure) => Promise<boolean>) | undefined,
  ): Promise<boolean> {
    const { message } = this.reportProjectSyncRpcClientRejected(projectId);
    await enqueueRetry?.({
      errorType: 'ClientVersionRejectedError',
      message,
      remoteOutcome: 'unknown',
      recordedAt: Date.now(),
    });
    return false;
  }

  private normalizeLocalProjectUpdatedAt(project: Project, serverUpdatedAt?: string | null): void {
    if (!serverUpdatedAt) return;

    const currentProject = this.projectStore?.getProject(project.id);
    if (currentProject && currentProject.updatedAt !== serverUpdatedAt) {
      this.projectStore?.setProject({
        ...currentProject,
        updatedAt: serverUpdatedAt,
      });
    }

    project.updatedAt = serverUpdatedAt;
    this.clockSync.recordServerTimestamp(serverUpdatedAt, project.id);
  }

  private async handleProjectSyncRpcResult(
    result: SyncRpcResult,
    project: Project,
    fromRetryQueue: boolean,
    enqueueRetry: (() => Promise<boolean>) | undefined,
    sourceUserId: string | undefined,
    taskIdsToDelete: string[] | undefined,
    taskDeleteBaseUpdatedAtMap: TaskDeleteBaseUpdatedAtMap | undefined,
    operationId: string | undefined,
    localTimestamp = Date.now(),
    lastSyncTimeBefore = this.syncState().lastSyncTime,
    updatedAtBaseline = project.updatedAt ?? null,
  ): Promise<boolean> {
    return await this.rpcResultHandler.handle({
      result,
      project,
      fromRetryQueue,
      enqueueRetry,
      sourceUserId,
      taskIdsToDelete,
      taskDeleteBaseUpdatedAtMap,
      operationId,
      localTimestamp,
      lastSyncTimeBefore,
      updatedAtBaseline,
      durableRetryHandler: this.durableRetryHandler,
      normalizeLocalProjectUpdatedAt: (targetProject, serverUpdatedAt) =>
        this.normalizeLocalProjectUpdatedAt(targetProject, serverUpdatedAt),
    });
  }

  /**
   * 执行项目 upsert 操作（内部方法，由 pushProjectWithStatus 调用）
   */
  private async doProjectPush(
    project: Project,
    userId: string,
    fromRetryQueue = false,
    enqueueRetry?: (lastFailure?: RetryQueueLastFailure) => Promise<boolean>,
    sourceUserId?: string,
    taskIdsToDelete?: string[],
    taskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap,
    operationId?: string,
  ): Promise<boolean> {
    await this.primeProjectSyncRpcCapability();

    if (operationId === undefined) {
      await enqueueRetry?.();
      return false;
    }

    if (this.syncRpcClient?.isClientRejected() === true) {
      return await this.enqueueProjectSyncRpcClientRejectedRetry(project.id, enqueueRetry);
    }

    if (this.shouldUseSyncRpc()) {
      return await this.pushProjectViaSyncRpc(
        project,
        userId,
        fromRetryQueue,
        enqueueRetry,
        sourceUserId,
        taskIdsToDelete,
        taskDeleteBaseUpdatedAtMap,
        operationId,
      );
    }

    if (fromRetryQueue) {
      throw createRetryDeferredError(
        'Project sync RPC is unavailable; keeping the original RetryQueue item.',
      );
    }

    await enqueueRetry?.();
    return false;
  }

  private async pushProjectViaSyncRpc(
    project: Project,
    userId: string,
    fromRetryQueue: boolean,
    enqueueRetry: (() => Promise<boolean>) | undefined,
    sourceUserId: string | undefined,
    taskIdsToDelete: string[] | undefined,
    taskDeleteBaseUpdatedAtMap: TaskDeleteBaseUpdatedAtMap | undefined,
    operationId: string,
  ): Promise<boolean> {
    const localTimestamp = Date.now();
    const lastSyncTimeBefore = this.syncState().lastSyncTime;
    const updatedAtBaseline = project.updatedAt ?? null;
    const result = await this.syncRpcClient!.upsertProject({
      operationId,
      project,
      ownerId: userId,
      baseUpdatedAt: updatedAtBaseline,
    });

    return await this.handleProjectSyncRpcResult(
      result,
      project,
      fromRetryQueue,
      enqueueRetry,
      sourceUserId,
      taskIdsToDelete,
      taskDeleteBaseUpdatedAtMap,
      operationId,
      localTimestamp,
      lastSyncTimeBefore,
      updatedAtBaseline,
    );
  }

}
