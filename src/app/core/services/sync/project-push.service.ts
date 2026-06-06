/**
 * ProjectPushService
 *
 * 从 SimpleSyncService「下切」出的「项目推送」链路（sync RPC + 直连兜底 + 会话刷新重试）。
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
import { Task, Project, Connection } from '../../../../models';
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
import { createSyncOperationId } from '../../../../utils/sync-operation-id';
import {
  createProjectDirectConflictError as buildProjectDirectConflictError,
  createProjectClockUncertainError as buildProjectClockUncertainError,
  createProjectRpcConflictError as buildProjectRpcConflictError,
  createProjectRpcTerminalError as buildProjectRpcTerminalError,
  createProjectPersistenceTerminalError as buildProjectPersistenceTerminalError,
} from './sync-project-errors';
import type { RetryableEntityType, RetryableOperation } from './retry-queue.service';

/** 获取 Supabase 客户端回调（门面持有离线降级 + sentry 归因语义） */
export type GetSupabaseClientHandler = () => Promise<SupabaseClient | null>;

/** durable 重试入队回调（门面 addToRetryQueueDurably，保留 session 守卫等完整语义） */
export type DurableRetryHandler = (
  type: RetryableEntityType,
  operation: RetryableOperation,
  data: Task | Project | Connection | { id: string },
  projectId?: string,
  sourceUserId?: string,
  taskIdsToDelete?: string[],
) => Promise<boolean>;

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
  ): Promise<boolean> {
    const result = await this.pushProjectWithStatus(project, fromRetryQueue, sourceUserId, taskIdsToDelete);
    return result.success;
  }

  async pushProjectWithStatus(
    project: Project,
    fromRetryQueue = false,
    sourceUserId?: string,
    taskIdsToDelete?: string[],
  ): Promise<{ success: boolean; retryEnqueued: boolean; failureReason?: string }> {
    let retryEnqueued = false;

    const enqueueRetry = async (): Promise<boolean> => {
      if (fromRetryQueue) {
        return false;
      }

      retryEnqueued = this.durableRetryHandler
        ? await this.durableRetryHandler('project', 'upsert', project, undefined, sourceUserId, taskIdsToDelete)
        : false;
      return retryEnqueued;
    };

    if (this.syncState().sessionExpired) {
      this.sessionManager.handleSessionExpired('pushProject', { projectId: project.id });
      return {
        success: false,
        retryEnqueued,
        failureReason: 'project sync session expired',
      };
    }

    const client = this.getSupabaseClientHandler ? await this.getSupabaseClientHandler() : null;
    if (!client) {
      await enqueueRetry();
      return {
        success: false,
        retryEnqueued,
        failureReason: 'supabase client unavailable for project sync',
      };
    }

    // 【#95057880 修复】支持自动刷新后重试的内部执行函数（与 pushTask 对齐）
    const executeProjectPush = async (): Promise<boolean> => {
      const { data: { session } } = await client.auth.getSession();
      let sessionUserId = session?.user?.id ?? null;
      if (!sessionUserId) {
        // 先尝试刷新会话，而非立即标记永久失败
        const refreshed = await this.sessionManager.tryRefreshSession('pushProject.getSession');
        if (refreshed) {
          const { data: { session: newSession } } = await client.auth.getSession();
          sessionUserId = newSession?.user?.id ?? null;
        }
      }

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
        client,
        project,
        sourceUserId ?? sessionUserId,
        fromRetryQueue,
        enqueueRetry,
        sourceUserId,
        taskIdsToDelete,
      );
    };

    try {
      const success = await this.throttle.execute(
        `push-project:${project.id}`,
        executeProjectPush,
        { priority: 'high', retries: 2 }
      );
      return {
        success,
        retryEnqueued,
        failureReason: success
          ? undefined
          : (retryEnqueued ? 'project sync queued for retry' : 'project push returned false'),
      };
    } catch (e) {
      // 【#95057880 修复】PermanentFailureError 直接向上冒泡，不做二次处理
      if (isPermanentFailureError(e)) {
        throw e;
      }

      const enhanced = e && typeof e === 'object' && 'errorType' in e
        ? e as EnhancedError
        : supabaseErrorToError(e);

      // 【#95057880 修复】检测到认证错误时先尝试刷新 session（与 pushTask 对齐）
      if (this.sessionManager.isSessionExpiredError(enhanced)) {
        const canRetry = await this.sessionManager.handleAuthErrorWithRefresh('pushProject', {
          projectId: project.id,
          errorCode: enhanced.code
        });
        if (canRetry) {
          try {
            const success = await executeProjectPush();
            return {
              success,
              retryEnqueued,
              failureReason: success
                ? undefined
                : (retryEnqueued ? 'project sync queued for retry after session refresh' : 'project push returned false after session refresh'),
            };
          } catch (retryError) {
            if (isPermanentFailureError(retryError)) throw retryError;
            const retryEnhanced = retryError && typeof retryError === 'object' && 'errorType' in retryError
              ? retryError as EnhancedError
              : supabaseErrorToError(retryError);
            if (this.sessionManager.isSessionExpiredError(retryEnhanced)) {
              // 会话刷新成功后重试仍然失败
              if (this.sessionManager.isRlsPolicyViolation(retryEnhanced)) {
                // 42501: RLS 策略违规，真正的权限不足，非会话过期
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
              await enqueueRetry();
              this.sessionManager.handleSessionExpired('pushProject.retryAfterRefresh', {
                projectId: project.id,
                errorCode: retryEnhanced.code
              });
              return {
                success: false,
                retryEnqueued,
                failureReason: 'project sync session expired after refresh',
              };
            }

            if (retryEnhanced.errorType === 'VersionConflictError') {
              this.toast.warning('版本冲突', '数据已被修改，请刷新后重试');
              throw new PermanentFailureError('Version conflict', retryEnhanced, { operation: 'pushProject', projectId: project.id });
            }

            if (retryEnhanced.isRetryable) {
              await enqueueRetry();
              return {
                success: false,
                retryEnqueued,
                failureReason: retryEnhanced.message,
              };
            }

            const isPermissionDenied = retryEnhanced.errorType === 'PermissionError';
            const terminalMessage = isPermissionDenied
              ? '项目同步权限校验失败，请重新登录后重试'
              : retryEnhanced.message;
            const terminalErrorType = isPermissionDenied ? 'PermissionError' : 'BusinessRuleError';
            const terminalCode = isPermissionDenied
              ? 'SYNC_PROJECT_PERMISSION_DENIED'
              : (retryEnhanced.code ? String(retryEnhanced.code) : 'SYNC_PROJECT_PERSISTENCE_FAILED');
            throw buildProjectPersistenceTerminalError(
              project.id,
              terminalMessage,
              terminalErrorType,
              terminalCode,
            );
          }
        } else {
          await enqueueRetry();
          this.sessionManager.handleSessionExpired('pushProject', { projectId: project.id, errorCode: enhanced.code });
          return {
            success: false,
            retryEnqueued,
            failureReason: 'project sync session expired',
          };
        }
      }

      if (enhanced.errorType === 'VersionConflictError') {
        this.toast.warning('版本冲突', '数据已被修改，请刷新后重试');
        throw new PermanentFailureError('Version conflict', enhanced, { operation: 'pushProject', projectId: project.id });
      }

      if (enhanced.isRetryable) {
        await enqueueRetry();
      } else {
        const isPermissionDenied = enhanced.errorType === 'PermissionError';
        throw buildProjectPersistenceTerminalError(
          project.id,
          isPermissionDenied ? '项目同步权限校验失败，请重新登录后重试' : enhanced.message,
          isPermissionDenied ? 'PermissionError' : 'BusinessRuleError',
          isPermissionDenied
            ? 'SYNC_PROJECT_PERMISSION_DENIED'
            : (enhanced.code ? String(enhanced.code) : 'SYNC_PROJECT_PERSISTENCE_FAILED'),
        );
      }
      return {
        success: false,
        retryEnqueued,
        failureReason: enhanced.message,
      };
    }
  }

  async pushProjectWithResult(
    project: Project,
    fromRetryQueue = false,
    sourceUserId?: string,
    taskIdsToDelete?: string[],
  ): Promise<{ success: boolean; conflict?: boolean; remoteData?: Project; retryEnqueued?: boolean; failureReason?: string; terminal?: boolean }> {
    try {
      const result = await this.pushProjectWithStatus(project, fromRetryQueue, sourceUserId, taskIdsToDelete);
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

    throw buildProjectRpcTerminalError(projectId, result, message);
  }

  private createSyncRpcOperationId(): string {
    return createSyncOperationId();
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

  private async loadRemoteProjectFreshness(
    client: SupabaseClient,
    projectId: string,
    userId: string,
  ): Promise<{ updatedAt: string | null; deletedAt: string | null } | null> {
    const { data, error } = await client
      .from('projects')
      .select('id,updated_at,deleted_at')
      .eq('id', projectId)
      .eq('owner_id', userId)
      .maybeSingle();

    if (error) {
      throw supabaseErrorToError(error);
    }

    if (!data) {
      return null;
    }

    const row = data as { updated_at?: string | null; deleted_at?: string | null };
    return {
      updatedAt: typeof row.updated_at === 'string' ? row.updated_at : null,
      deletedAt: typeof row.deleted_at === 'string' ? row.deleted_at : null,
    };
  }

  private async handleProjectSyncRpcResult(
    result: SyncRpcResult,
    project: Project,
    fromRetryQueue: boolean,
    enqueueRetry: (() => Promise<boolean>) | undefined,
    sourceUserId: string | undefined,
    taskIdsToDelete: string[] | undefined,
  ): Promise<boolean> {
    if (result.status === 'applied' || result.status === 'idempotent-replay') {
      this.normalizeLocalProjectUpdatedAt(project, result.serverUpdatedAt);
      this.logger.debug('pushProject: sync RPC 写入成功', {
        projectId: project.id,
        status: result.status,
      });
      return true;
    }

    if (result.status === 'remote-newer' || result.status === 'deleted-remote-newer') {
      this.logger.warn('pushProject: sync RPC CAS 拒绝，远端版本更新', {
        projectId: project.id,
        status: result.status,
        remoteUpdatedAt: result.remoteUpdatedAt,
        reason: result.reason,
      });
      this.sentryLazyLoader.captureMessage('sync_rpc_project_remote_newer', {
        level: 'warning',
        tags: { operation: 'pushProject', entityType: 'project', status: result.status },
        extra: { projectId: project.id, remoteUpdatedAt: result.remoteUpdatedAt, reason: result.reason },
      });
      this.toast.warning('版本冲突', '数据已被修改，请刷新后重试');
      throw buildProjectRpcConflictError(project.id, result);
    }

    if (result.status === 'unauthorized' && result.reason === 'supabase_client_unavailable') {
      this.logger.warn('pushProject: sync RPC client 不可用，回退重试队列', {
        projectId: project.id,
        reason: result.reason,
      });
      if (!fromRetryQueue) {
        if (enqueueRetry) {
          await enqueueRetry();
        } else if (this.durableRetryHandler) {
          await this.durableRetryHandler('project', 'upsert', project, undefined, sourceUserId, taskIdsToDelete);
        }
      }
      return false;
    }

    const message = result.status === 'client-version-rejected'
      ? '当前客户端同步协议已过期，请刷新后重试'
      : '项目同步权限校验失败，请重新登录后重试';
    this.syncStateService.setSyncError(message);
    this.sentryLazyLoader.captureMessage('sync_rpc_project_rejected', {
      level: 'warning',
      tags: { operation: 'pushProject', entityType: 'project', status: result.status },
      extra: { projectId: project.id, reason: result.reason, minProtocolVersion: result.minProtocolVersion },
    });
    throw buildProjectRpcTerminalError(project.id, result, message);
  }

  /**
   * 执行项目 upsert 操作（内部方法，由 pushProjectWithStatus 调用）
   */
  private async doProjectPush(
    client: SupabaseClient,
    project: Project,
    userId: string,
    fromRetryQueue = false,
    enqueueRetry?: () => Promise<boolean>,
    sourceUserId?: string,
    taskIdsToDelete?: string[],
  ): Promise<boolean> {
    await this.primeProjectSyncRpcCapability();

    if (this.syncRpcClient?.isClientRejected() === true) {
      this.throwProjectSyncRpcClientRejected(project.id);
    }

    if (this.shouldUseSyncRpc()) {
      const result = await this.syncRpcClient!.upsertProject({
        operationId: this.createSyncRpcOperationId(),
        project,
        ownerId: userId,
        baseUpdatedAt: project.updatedAt ?? null,
      });

      return await this.handleProjectSyncRpcResult(
        result,
        project,
        fromRetryQueue,
        enqueueRetry,
        sourceUserId,
        taskIdsToDelete,
      );
    }

    const remoteProject = await this.loadRemoteProjectFreshness(client, project.id, userId);
    const remoteHasTombstone = !!(remoteProject?.deletedAt && !project.deletedAt);
    const remoteUpdatedAt = remoteProject?.updatedAt ?? null;
    const localUpdatedAt = project.updatedAt ?? null;
    const rawRemoteMs = remoteUpdatedAt ? new Date(remoteUpdatedAt).getTime() : Number.NaN;
    const rawLocalMs = localUpdatedAt ? new Date(localUpdatedAt).getTime() : Number.NaN;
    const timestampsDiffer = Number.isFinite(rawRemoteMs)
      && Number.isFinite(rawLocalMs)
      && rawLocalMs !== rawRemoteMs;
    const clockSyncResult = timestampsDiffer
      ? await this.clockSync.ensureSynced().catch(() => null)
      : null;

    if (timestampsDiffer && !clockSyncResult?.reliable) {
      throw buildProjectClockUncertainError(
        project.id,
        localUpdatedAt,
        remoteUpdatedAt,
      );
    }

    const remoteIsNewer = !!(
      remoteUpdatedAt
      && localUpdatedAt
      && (
        clockSyncResult?.reliable
          ? this.clockSync.compareTimestamps(localUpdatedAt, remoteUpdatedAt) < 0
          : rawRemoteMs > rawLocalMs
      )
    );

    if (remoteHasTombstone || remoteIsNewer) {
      throw buildProjectDirectConflictError(
        project.id,
        remoteProject?.updatedAt ?? remoteProject?.deletedAt ?? null,
        remoteHasTombstone ? 'remote-tombstone' : 'remote-newer',
      );
    }

    const projectInsertPayload = {
      id: project.id,
      owner_id: userId,
      title: project.name,
      description: project.description,
      version: project.version || 1,
      migrated_to_v2: true,
      deleted_at: project.deletedAt ?? null,
    };
    const projectUpdatePayload = {
      title: project.name,
      description: project.description,
      version: project.version || 1,
      migrated_to_v2: true,
      deleted_at: project.deletedAt ?? null,
    };

    let data: { updated_at?: string | null } | null = null;
    let error: unknown | null = null;

    if (remoteProject?.updatedAt) {
      ({ data, error } = await client
        .from('projects')
        .update(projectUpdatePayload)
        .eq('id', project.id)
        .eq('owner_id', userId)
        .eq('updated_at', remoteProject.updatedAt)
        .select('updated_at')
        .maybeSingle());

      if (!error && !data) {
        throw buildProjectDirectConflictError(
          project.id,
          remoteProject.updatedAt,
          'remote-newer',
        );
      }
    } else if (remoteProject) {
      throw buildProjectDirectConflictError(
        project.id,
        remoteProject.updatedAt ?? remoteProject.deletedAt ?? null,
        'remote-newer',
      );
    } else {
      ({ data, error } = await client
        .from('projects')
        .insert(projectInsertPayload)
        .select('updated_at')
        .maybeSingle());

      const code = (error as { code?: string | number } | null)?.code;
      if (error && (code === '23505' || code === 23505)) {
        throw buildProjectDirectConflictError(
          project.id,
          project.updatedAt ?? null,
          'remote-newer',
        );
      }

      if (!error && !data) {
        throw buildProjectDirectConflictError(
          project.id,
          project.updatedAt ?? null,
          'remote-newer',
        );
      }
    }

    if (error) throw supabaseErrorToError(error);
    this.normalizeLocalProjectUpdatedAt(
      project,
      typeof data?.updated_at === 'string' ? data.updated_at : null,
    );
    return true;
  }
}
