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
 * - sync-RPC 能力探测助手（shouldUseSyncRpc / primeProjectSyncRpcCapability /
 *   createSyncRpcOperationId）随删除链路一并迁入：门面侧已无其它消费者（推送链路自带副本）。
 *
 * 验证：SimpleSyncService.spec 的「项目软删除」用例通过公开 API `deleteProjectFromCloud(...)`
 * 覆盖本链路；门面 `deleteProjectFromCloud()` 委托后该套用例继续校验零回归。
 */
import { Injectable, inject } from '@angular/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { LoggerService } from '../../../../services/logger.service';
import { ClockSyncService } from '../../../../services/clock-sync.service';
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
import { createSyncOperationId } from '../../../../utils/sync-operation-id';

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

  private createSyncRpcOperationId(): string {
    return createSyncOperationId();
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
  ): Promise<Result<void, OperationError>> {
    const { data: { session } } = await client.auth.getSession();
    let sessionUserId = session?.user?.id ?? null;

    if (!sessionUserId) {
      const refreshed = await this.sessionManager.tryRefreshSession('deleteProjectFromCloud.getSession');
      if (refreshed) {
        const { data: { session: refreshedSession } } = await client.auth.getSession();
        sessionUserId = refreshedSession?.user?.id ?? null;
      }
    }

    if (!sessionUserId) {
      if (isBrowserNetworkSuspendedWindow()) {
        return this.buildProjectDeleteRetryableFailure('浏览器恢复连接中，请稍后重试', {
          projectId,
          userId,
          reason: 'browser-network-suspended',
          resumeDelayMs: getRemainingBrowserNetworkResumeDelayMs(),
        });
      }

      return this.buildProjectDeleteAuthExpiredFailure('deleteProjectFromCloud.getSession', {
        projectId,
        userId,
      });
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
      const result = await this.syncRpcClient!.deleteProject({
        operationId: this.createSyncRpcOperationId(),
        projectId,
        baseUpdatedAt: this.projectStore?.getProject(projectId)?.updatedAt ?? null,
      });

      if (result.status === 'applied' || result.status === 'idempotent-replay') {
        if (result.serverUpdatedAt) {
          this.clockSync.recordServerTimestamp(result.serverUpdatedAt, projectId);
        }
        return success(undefined);
      }

      const isConflict = result.status === 'remote-newer' || result.status === 'deleted-remote-newer';
      const message = result.status === 'client-version-rejected'
        ? '当前客户端同步协议已过期，请刷新后重试'
        : isConflict
          ? '远端项目版本更新，请先同步后重试删除'
          : '项目删除被服务端拒绝';
      this.syncStateService.setSyncError(message);
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

    const { error } = await client.rpc('soft_delete_project', {
      p_project_id: projectId,
    });
    if (error) throw supabaseErrorToError(error);

    return success(undefined);
  }

  async deleteProjectFromCloud(projectId: string, userId: string): Promise<Result<void, OperationError>> {
    if (this.syncState().sessionExpired) {
      return this.buildProjectDeleteAuthExpiredFailure('deleteProjectFromCloud.preflight', {
        projectId,
        userId,
      });
    }

    if (isBrowserNetworkSuspendedWindow()) {
      return this.buildProjectDeleteRetryableFailure('浏览器恢复连接中，请稍后重试', {
        projectId,
        userId,
        reason: 'browser-network-suspended',
        resumeDelayMs: getRemainingBrowserNetworkResumeDelayMs(),
      });
    }

    const client = this.getSupabaseClientHandler ? await this.getSupabaseClientHandler() : null;
    if (!client) {
      return this.buildProjectDeleteRetryableFailure('当前离线，删除将在恢复连接后重试', {
        projectId,
        userId,
        reason: 'client-unavailable',
      });
    }

    try {
      return await this.executeProjectDelete(client, projectId, userId);
    } catch (e) {
      if (isBrowserNetworkSuspendedError(e)) {
        return this.buildProjectDeleteRetryableFailure('浏览器恢复连接中，请稍后重试', {
          projectId,
          userId,
          reason: 'browser-network-suspended',
          resumeDelayMs: getRemainingBrowserNetworkResumeDelayMs(),
        });
      }

      const enhanced = supabaseErrorToError(e);

      if (this.sessionManager.isSessionExpiredError(enhanced)) {
        const canRetry = await this.sessionManager.handleAuthErrorWithRefresh('deleteProjectFromCloud', {
          projectId,
          userId,
          errorCode: enhanced.code,
        });

        if (canRetry) {
          try {
            return await this.executeProjectDelete(client, projectId, userId);
          } catch (retryError) {
            if (isBrowserNetworkSuspendedError(retryError) || isBrowserNetworkSuspendedWindow()) {
              return this.buildProjectDeleteRetryableFailure('浏览器恢复连接中，请稍后重试', {
                projectId,
                userId,
                reason: 'browser-network-suspended',
                resumeDelayMs: getRemainingBrowserNetworkResumeDelayMs(),
              });
            }

            const retryEnhanced = supabaseErrorToError(retryError);
            if (this.sessionManager.isSessionExpiredError(retryEnhanced)) {
              // 会话刷新成功后重试仍然失败：
              // - 若为 42501 (RLS 违规)，说明是真正的权限不足，非会话过期
              // - 若为 401，说明刷新未能完全恢复，标记为会话过期
              if (this.sessionManager.isRlsPolicyViolation(retryEnhanced)) {
                this.logger.warn('刷新会话后重试仍获 RLS 违规，判定为权限不足', {
                  projectId, userId, errorCode: retryEnhanced.code,
                });
                return failure(ErrorCodes.PERMISSION_DENIED, '权限不足，无法删除此项目', {
                  projectId,
                  userId,
                  retryable: false,
                  errorCode: retryEnhanced.code,
                  errorType: retryEnhanced.errorType,
                });
              }
              return this.buildProjectDeleteAuthExpiredFailure('deleteProjectFromCloud.retryAfterRefresh', {
                projectId,
                userId,
                errorCode: retryEnhanced.code,
              });
            }

            return failure(
              retryEnhanced.errorType === 'PermissionError' ? ErrorCodes.PERMISSION_DENIED : ErrorCodes.OPERATION_FAILED,
              retryEnhanced.message,
              {
                projectId,
                userId,
                retryable: retryEnhanced.isRetryable,
                errorCode: retryEnhanced.code,
                errorType: retryEnhanced.errorType,
              },
            );
          }
        }

        if (isBrowserNetworkSuspendedWindow()) {
          return this.buildProjectDeleteRetryableFailure('浏览器恢复连接中，请稍后重试', {
            projectId,
            userId,
            reason: 'browser-network-suspended',
            resumeDelayMs: getRemainingBrowserNetworkResumeDelayMs(),
          });
        }

        return this.buildProjectDeleteAuthExpiredFailure('deleteProjectFromCloud', {
          projectId,
          userId,
          errorCode: enhanced.code,
        });
      }

      if (enhanced.errorType === 'PermissionError') {
        this.logger.warn('删除项目权限不足', {
          projectId,
          userId,
          error: enhanced,
        });
        return failure(ErrorCodes.PERMISSION_DENIED, enhanced.message, {
          projectId,
          userId,
          retryable: false,
          errorCode: enhanced.code,
          errorType: enhanced.errorType,
        });
      }

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
}
