/**
 * ProjectDeleteCoordinatorService
 *
 * 从 SimpleSyncService「下切」出的「项目软删除」链路（sync RPC + soft_delete_project 兜底 + 会话刷新重试）。
 *
 * 职责单一：
 * - deleteProjectFromCloud 全链路：会话归属校验 + sync RPC 删除 / soft_delete_project 兜底
 * - 浏览器网络挂起降级、会话过期/刷新重试、RLS 违规终态、远端更新冲突冒泡等错误分类
 *
 * 为什么抽离：
 * - AGENTS.md §12 单文件 ≤ 800 行硬线；SimpleSyncService 长期越界，文件头要求只做「下切」。
 * - 删除链路自洽，依赖均可注入；唯一回 facade 依赖通过回调注入避免循环 DI：
 *   - `getSupabaseClient`（门面持有 sentry 归因 + 离线降级语义）
 * - sync-RPC 能力探测助手（shouldUseSyncRpc / primeProjectSyncRpcCapability）
 *   随删除链路一并迁入：门面侧已无其它消费者（推送链路自带副本）。
 *
 * 验证：SimpleSyncService.spec 的「项目软删除」用例通过公开 API `deleteProjectFromCloud(...)`
 * 覆盖本链路；门面 `deleteProjectFromCloud()` 委托后该套用例继续校验零回归。
 */
import { Injectable, inject } from '@angular/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { LoggerService } from '../../../../services/logger.service';
import { ClockSyncService } from '../../../../services/clock-sync.service';
import { DataSafetyWriteAuditService } from '../../../../services/data-safety-write-audit.service';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import { SyncRpcClientService } from '../../../../services/sync-rpc-client.service';
import { SyncStateService } from './sync-state.service';
import { SessionManagerService } from './session-manager.service';
import { ProjectStore } from '../../state/stores';
import { supabaseErrorToError } from '../../../../utils/supabase-error';
import {
  type Result,
  type OperationError,
  ErrorCodes,
  failure,
  success,
} from '../../../../utils/result';
import {
  getRemainingBrowserNetworkResumeDelayMs,
  isBrowserNetworkSuspendedError,
  isBrowserNetworkSuspendedWindow,
} from '../../../../utils/browser-network-suspension';

/** 获取 Supabase 客户端回调（门面持有离线降级 + sentry 归因语义） */
export type GetSupabaseClientHandler = () => Promise<SupabaseClient | null>;

@Injectable({ providedIn: 'root' })
export class ProjectDeleteCoordinatorService {
  private readonly logger = inject(LoggerService).category('ProjectDelete');
  private readonly syncStateService = inject(SyncStateService);
  private readonly sessionManager = inject(SessionManagerService);
  private readonly clockSync = inject(ClockSyncService);
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly syncRpcClient = inject(SyncRpcClientService, { optional: true });
  private readonly projectStore = inject(ProjectStore, { optional: true });
  private readonly dataSafetyWriteAudit = new DataSafetyWriteAuditService();

  /** 由 SimpleSyncService 构造期注入（避免循环 DI）。 */
  getSupabaseClientHandler: GetSupabaseClientHandler | null = null;

  private get syncState() {
    return this.syncStateService.syncState;
  }

  // sync-RPC 能力探测：删除链路仍走旧 sync-RPC 直连。
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

  private buildProjectDeleteClientRejectedFailure(
    projectId: string,
    userId: string,
  ): Result<void, OperationError> {
    const message = '当前客户端同步协议已过期，请刷新后重试';

    this.syncStateService.setSyncError(message);
    this.sentryLazyLoader.captureMessage('sync_rpc_project_delete_rejected', {
      level: 'warning',
      tags: { operation: 'deleteProjectFromCloud', entityType: 'project', status: 'client-version-rejected' },
      extra: { projectId },
    });

    return failure(ErrorCodes.OPERATION_FAILED, message, {
      projectId,
      userId,
      retryable: false,
      reason: 'client_version_rejected',
    });
  }

  private buildProjectDeleteRetryableFailure(
    message: string,
    details: Record<string, unknown>,
  ): Result<void, OperationError> {
    return failure(ErrorCodes.SYNC_OFFLINE, message, {
      retryable: true,
      ...details,
    });
  }

  private buildProjectDeleteMissingOperationIdFailure(
    projectId: string,
    userId: string,
  ): Result<void, OperationError> {
    this.logger.warn('deleteProjectFromCloud: 缺少 operationId，已拒绝远端删除以避免临时幂等键', {
      projectId,
      userId,
    });

    return this.buildProjectDeleteRetryableFailure('缺少持久化操作 ID，删除将在本地队列恢复后重试', {
      projectId,
      userId,
      reason: 'missing-operation-id',
    });
  }

  private buildProjectDeleteSyncRpcUnavailableFailure(
    projectId: string,
    userId: string,
    operationId: string,
  ): Result<void, OperationError> {
    this.logger.warn('deleteProjectFromCloud: 跳过 legacy soft_delete_project，保留本地删除等待 Sync RPC 重试', {
      projectId,
      userId,
      operationId,
      featureEnabled: this.syncRpcClient?.isFeatureEnabled() === true,
      clientRejected: this.syncRpcClient?.isClientRejected() === true,
    });

    return this.buildProjectDeleteRetryableFailure('项目删除同步通道暂不可用，删除将在恢复后重试', {
      projectId,
      userId,
      operationId,
      reason: 'sync-rpc-unavailable',
      deferred: true,
      featureEnabled: this.syncRpcClient?.isFeatureEnabled() === true,
      clientRejected: this.syncRpcClient?.isClientRejected() === true,
    });
  }

  private buildProjectDeleteAuthExpiredFailure(
    context: string,
    details: Record<string, unknown>,
  ): Result<void, OperationError> {
    try {
      this.sessionManager.handleSessionExpired(context, details);
    } catch {
      // handleSessionExpired 约定会抛出以中断上层流程；此处已转为 Result 语义返回。
    }

    return failure(ErrorCodes.SYNC_AUTH_EXPIRED, '登录已过期，请重新登录', details);
  }

  private async executeProjectDelete(
    client: SupabaseClient,
    projectId: string,
    userId: string,
    operationId: string,
    baseUpdatedAt: string | null,
  ): Promise<Result<void, OperationError>> {
    const sessionUserId = await this.resolveProjectDeleteSessionUserId(client);

    if (!sessionUserId) {
      return this.handleMissingProjectDeleteSession(projectId, userId);
    }

    if (sessionUserId !== userId) {
      this.logger.warn('检测到项目删除归属与当前会话不匹配，已拒绝云端删除', {
        projectId,
        userId,
        sessionUserId,
      });
      return this.buildProjectDeleteAuthExpiredFailure('deleteProjectFromCloud.userMismatch', {
        projectId,
        expectedUserId: userId,
        sessionUserId,
      });
    }

    await this.primeProjectSyncRpcCapability();

    if (this.syncRpcClient?.isClientRejected() === true) {
      return this.buildProjectDeleteClientRejectedFailure(projectId, userId);
    }

    if (this.shouldUseSyncRpc()) {
      return await this.deleteProjectWithSyncRpc(projectId, userId, operationId, baseUpdatedAt);
    }

    return this.buildProjectDeleteSyncRpcUnavailableFailure(projectId, userId, operationId);
  }

  private async resolveProjectDeleteSessionUserId(client: SupabaseClient): Promise<string | null> {
    const { data: { session } } = await client.auth.getSession();
    if (session?.user?.id) {
      return session.user.id;
    }

    const refreshed = await this.sessionManager.tryRefreshSession('deleteProjectFromCloud.getSession');
    if (!refreshed) {
      return null;
    }

    const { data: { session: refreshedSession } } = await client.auth.getSession();
    return refreshedSession?.user?.id ?? null;
  }

  private handleMissingProjectDeleteSession(
    projectId: string,
    userId: string,
  ): Result<void, OperationError> {
    if (isBrowserNetworkSuspendedWindow()) {
      return this.buildProjectDeleteBrowserSuspendedFailure(projectId, userId);
    }

    return this.buildProjectDeleteAuthExpiredFailure('deleteProjectFromCloud.getSession', {
      projectId,
      userId,
    });
  }

  private buildProjectDeleteBrowserSuspendedFailure(
    projectId: string,
    userId: string,
  ): Result<void, OperationError> {
    return this.buildProjectDeleteRetryableFailure('浏览器恢复连接中，请稍后重试', {
      projectId,
      userId,
      reason: 'browser-network-suspended',
      resumeDelayMs: getRemainingBrowserNetworkResumeDelayMs(),
    });
  }

  private async deleteProjectWithSyncRpc(
    projectId: string,
    userId: string,
    operationId: string,
    baseUpdatedAt: string | null,
  ): Promise<Result<void, OperationError>> {
    if (baseUpdatedAt === null) {
      const message = '项目删除缺少已确认的远端版本，已保留删除意图等待人工处理';
      this.syncStateService.setSyncError(message);
      this.logger.warn('deleteProjectFromCloud: 缺少 baseUpdatedAt，已拒绝危险的无条件远端删除', {
        projectId,
        userId,
        operationId,
      });
      return failure(ErrorCodes.SYNC_CONFLICT, message, {
        projectId,
        userId,
        operationId,
        retryable: false,
        reason: 'missing_base_updated_at',
      });
    }

    const localTimestamp = Date.now();
    const lastSyncTimeBefore = this.syncState().lastSyncTime;
    const result = await this.syncRpcClient!.deleteProject({
      operationId,
      projectId,
      baseUpdatedAt,
    });

    this.recordProjectDeleteRpcWriteAudit({
      projectId,
      userId,
      operationId,
      result,
      localTimestamp,
      baseUpdatedAt,
      lastSyncTimeBefore,
    });

    if (result.status === 'applied' || result.status === 'idempotent-replay') {
      if (result.serverUpdatedAt) {
        this.clockSync.recordServerTimestamp(result.serverUpdatedAt, projectId);
      }
      return success(undefined);
    }

    return this.buildRejectedProjectDeleteSyncRpcResult(projectId, userId, result);
  }

  private recordProjectDeleteRpcWriteAudit(input: {
    projectId: string;
    userId: string;
    operationId: string;
    result: Awaited<ReturnType<NonNullable<SyncRpcClientService>['deleteProject']>>;
    localTimestamp: number;
    baseUpdatedAt: string | null;
    lastSyncTimeBefore: string | null;
  }): void {
    this.dataSafetyWriteAudit.recordWrite({
      ownerUserId: input.userId,
      operationId: input.operationId,
      sourceUserId: input.userId,
      entityType: 'project',
      entityId: input.projectId,
      operation: 'delete',
      localTimestamp: input.localTimestamp,
      updatedAtBaseline: input.baseUpdatedAt,
      beforeVersion: input.baseUpdatedAt,
      rpcResult: input.result,
      enteredRetryQueue: false,
      retryCount: 0,
      lastSyncTimeBefore: input.lastSyncTimeBefore,
      lastSyncTimeAfter: this.syncState().lastSyncTime,
    });
  }

  private buildRejectedProjectDeleteSyncRpcResult(
    projectId: string,
    userId: string,
    result: Awaited<ReturnType<NonNullable<SyncRpcClientService>['deleteProject']>>,
  ): Result<void, OperationError> {
    const isConflict = result.status === 'remote-newer' || result.status === 'deleted-remote-newer';
    const message = result.status === 'client-version-rejected'
      ? '当前客户端同步协议已过期，请刷新后重试'
      : isConflict
        ? '远端项目版本更新，请先同步后重试删除'
        : '项目删除被服务端拒绝';
    this.syncStateService.setSyncError(message);
    this.captureRejectedProjectDeleteSyncRpcResult(projectId, result, isConflict);

    if (result.status === 'unauthorized') {
      return failure(ErrorCodes.PERMISSION_DENIED, message, {
        projectId,
        userId,
        retryable: false,
        reason: result.reason,
      });
    }

    return failure(isConflict ? ErrorCodes.SYNC_CONFLICT : ErrorCodes.OPERATION_FAILED, message, {
      projectId,
      userId,
      retryable: false,
      reason: result.reason,
    });
  }

  private captureRejectedProjectDeleteSyncRpcResult(
    projectId: string,
    result: Awaited<ReturnType<NonNullable<SyncRpcClientService>['deleteProject']>>,
    isConflict: boolean,
  ): void {
    this.sentryLazyLoader.captureMessage(
      isConflict ? 'sync_rpc_project_delete_remote_newer' : 'sync_rpc_project_delete_rejected',
      {
        level: 'warning',
        tags: { operation: 'deleteProjectFromCloud', entityType: 'project', status: result.status },
        extra: {
          projectId,
          remoteUpdatedAt: result.remoteUpdatedAt,
          reason: result.reason,
          minProtocolVersion: result.minProtocolVersion,
        },
      },
    );
  }

  private resolveProjectDeleteBaseUpdatedAt(
    projectId: string,
    durableBaseUpdatedAt: string | null | undefined,
  ): string | null {
    return durableBaseUpdatedAt === undefined
      ? this.projectStore?.getProject(projectId)?.updatedAt ?? null
      : durableBaseUpdatedAt;
  }

  async deleteProjectFromCloud(
    projectId: string,
    userId: string,
    operationId?: string,
    durableBaseUpdatedAt?: string | null,
  ): Promise<Result<void, OperationError>> {
    if (operationId === undefined) {
      return this.buildProjectDeleteMissingOperationIdFailure(projectId, userId);
    }

    if (this.syncState().sessionExpired) {
      return this.buildProjectDeleteAuthExpiredFailure('deleteProjectFromCloud.preflight', {
        projectId,
        userId,
      });
    }

    if (isBrowserNetworkSuspendedWindow()) {
      return this.buildProjectDeleteBrowserSuspendedFailure(projectId, userId);
    }

    const baseUpdatedAt = this.resolveProjectDeleteBaseUpdatedAt(projectId, durableBaseUpdatedAt);

    const client = this.getSupabaseClientHandler ? await this.getSupabaseClientHandler() : null;
    if (!client) {
      return this.buildProjectDeleteRetryableFailure('当前离线，删除将在恢复连接后重试', {
        projectId,
        userId,
        reason: 'client-unavailable',
      });
    }

    try {
      return await this.executeProjectDelete(client, projectId, userId, operationId, baseUpdatedAt);
    } catch (e) {
      if (isBrowserNetworkSuspendedError(e)) {
        return this.buildProjectDeleteBrowserSuspendedFailure(projectId, userId);
      }

      const enhanced = supabaseErrorToError(e);

      if (this.sessionManager.isSessionExpiredError(enhanced)) {
        return await this.handleProjectDeleteAuthError(
          client,
          projectId,
          userId,
          enhanced.code,
          operationId,
          baseUpdatedAt,
        );
      }

      if (enhanced.errorType === 'PermissionError') {
        return this.buildProjectDeletePermissionFailure(projectId, userId, enhanced);
      }

      return this.buildProjectDeleteOperationFailure(projectId, userId, enhanced);
    }
  }

  private async handleProjectDeleteAuthError(
    client: SupabaseClient,
    projectId: string,
    userId: string,
    errorCode: unknown,
    operationId: string,
    baseUpdatedAt: string | null,
  ): Promise<Result<void, OperationError>> {
    const canRetry = await this.sessionManager.handleAuthErrorWithRefresh('deleteProjectFromCloud', {
      projectId,
      userId,
      errorCode,
    });

    if (!canRetry) {
      if (isBrowserNetworkSuspendedWindow()) {
        return this.buildProjectDeleteBrowserSuspendedFailure(projectId, userId);
      }
      return this.buildProjectDeleteAuthExpiredFailure('deleteProjectFromCloud', { projectId, userId, errorCode });
    }

    try {
      return await this.executeProjectDelete(client, projectId, userId, operationId, baseUpdatedAt);
    } catch (retryError) {
      return this.handleProjectDeleteRetryAfterRefreshError(projectId, userId, retryError);
    }
  }

  private handleProjectDeleteRetryAfterRefreshError(
    projectId: string,
    userId: string,
    retryError: unknown,
  ): Result<void, OperationError> {
    if (isBrowserNetworkSuspendedError(retryError) || isBrowserNetworkSuspendedWindow()) {
      return this.buildProjectDeleteBrowserSuspendedFailure(projectId, userId);
    }

    const retryEnhanced = supabaseErrorToError(retryError);
    if (!this.sessionManager.isSessionExpiredError(retryEnhanced)) {
      return this.buildProjectDeleteOperationFailure(projectId, userId, retryEnhanced);
    }

    if (this.sessionManager.isRlsPolicyViolation(retryEnhanced)) {
      this.logger.warn('刷新会话后重试仍获 RLS 违规，判定为权限不足', {
        projectId, userId, errorCode: retryEnhanced.code,
      });
      return this.buildProjectDeletePermissionFailure(projectId, userId, retryEnhanced, '权限不足，无法删除此项目');
    }

    return this.buildProjectDeleteAuthExpiredFailure('deleteProjectFromCloud.retryAfterRefresh', {
      projectId,
      userId,
      errorCode: retryEnhanced.code,
    });
  }

  private buildProjectDeletePermissionFailure(
    projectId: string,
    userId: string,
    enhanced: ReturnType<typeof supabaseErrorToError>,
    message = enhanced.message,
  ): Result<void, OperationError> {
    this.logger.warn('删除项目权限不足', {
      projectId,
      userId,
      error: enhanced,
    });
    return failure(ErrorCodes.PERMISSION_DENIED, message, {
      projectId,
      userId,
      retryable: false,
      errorCode: enhanced.code,
      errorType: enhanced.errorType,
    });
  }

  private buildProjectDeleteOperationFailure(
    projectId: string,
    userId: string,
    enhanced: ReturnType<typeof supabaseErrorToError>,
  ): Result<void, OperationError> {
    const retryable = enhanced.isRetryable || enhanced.errorType === 'OfflineError' || enhanced.errorType === 'NetworkError';
    const errorCode = retryable ? ErrorCodes.SYNC_OFFLINE : ErrorCodes.OPERATION_FAILED;

    this.logger.error('删除项目失败', {
      projectId,
      userId,
      error: enhanced,
    });
    return failure(errorCode, enhanced.message, {
      projectId,
      userId,
      retryable,
      errorCode: enhanced.code,
      errorType: enhanced.errorType,
    });
  }
}
