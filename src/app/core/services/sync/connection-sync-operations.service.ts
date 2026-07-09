import { Injectable, inject } from '@angular/core';
import { SupabaseClientService } from '../../../../services/supabase-client.service';
import { LoggerService } from '../../../../services/logger.service';
import { RequestThrottleService } from '../../../../services/request-throttle.service';
import { ClockSyncService } from '../../../../services/clock-sync.service';
import { ConflictStorageService } from '../../../../services/conflict-storage.service';
import { ProjectStateService } from '../../../../services/project-state.service';
import { resolveRemoteVersionConflictEvidence } from '../../../../services/action-queue-operation-conflict.helpers';
import { SyncOperationHelperService } from './sync-operation-helper.service';
import { RetryQueueService, type RetryQueueLastFailure } from './retry-queue.service';
import { SyncStateService } from './sync-state.service';
import { Connection } from '../../../../models';
import { DataSafetyWriteAuditService } from '../../../../services/data-safety-write-audit.service';
import {
  classifySupabaseClientFailure,
} from '../../../../utils/supabase-error';
import { PermanentFailureError } from '../../../../utils/permanent-failure-error';
import { REQUEST_THROTTLE_CONFIG } from '../../../../config';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SyncRpcClientService, type SyncRpcResult } from '../../../../services/sync-rpc-client.service';
import {
  isBrowserNetworkSuspendedError,
  isBrowserNetworkSuspendedWindow,
} from '../../../../utils/browser-network-suspension';
import { createRetryDeferredError, isRetryDeferredError } from '../../../../utils/retry-deferred-error';
import {
  ConnectionTombstoneLookupService,
  type ConnectionTombstoneCheckResult,
} from './connection-tombstone-lookup.service';
import {
  ConnectionEndpointTaskValidationService,
  type TaskValidationResult,
} from './connection-endpoint-task-validation.service';
import { ConnectionPushErrorHandlerService } from './connection-push-error-handler.service';
import { ConnectionRetryEnqueueService } from './connection-retry-enqueue.service';
import { ConnectionCanonicalIdentityService } from './connection-canonical-identity.service';
import {
  ConnectionPushPreflightService,
  type ConnectionPushRequest,
} from './connection-push-preflight.service';
import {
  ConnectionSyncRpcResultHandlerService,
} from './connection-sync-rpc-result-handler.service';
import { ConnectionRestPersistenceService } from './connection-rest-persistence.service';
import {
  createConnectionRpcWriteAudit,
  createConnectionRestRemoteNewerConflict,
  createConnectionSyncRpcResultHandlers,
  createConnectionSyncRpcOperationId,
  createPendingConnectionPushExecutionResult,
  persistConnectionRpcReplayConflict,
  shouldUseConnectionSyncRpc,
  type ConnectionRpcWriteAudit,
  type ConnectionPushExecutionResult,
} from './connection-sync-operations.helpers';
import { ConnectionCanonicalPrecheckService } from './connection-canonical-precheck.service';
import { ConnectionTerminalRejectionService } from './connection-terminal-rejection.service';
import { ConnectionRestConflictRecoveryService } from './connection-rest-conflict-recovery.service';

@Injectable({
  providedIn: 'root'
})
export class ConnectionSyncOperationsService {
  private readonly supabase = inject(SupabaseClientService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('ConnectionSyncOps');
  private readonly throttle = inject(RequestThrottleService);
  private readonly clockSync = inject(ClockSyncService);
  private readonly syncOpHelper = inject(SyncOperationHelperService);
  private readonly retryQueueService = inject(RetryQueueService);
  private readonly syncStateService = inject(SyncStateService);
  private readonly syncRpcClient = inject(SyncRpcClientService, { optional: true });
  private readonly connectionTombstones = inject(ConnectionTombstoneLookupService);
  private readonly connectionTaskValidation = inject(ConnectionEndpointTaskValidationService);
  private readonly connectionPushErrors = inject(ConnectionPushErrorHandlerService);
  private readonly connectionRetryEnqueue = inject(ConnectionRetryEnqueueService);
  private readonly canonicalIdentity = inject(ConnectionCanonicalIdentityService);
  private readonly connectionPreflight = inject(ConnectionPushPreflightService);
  private readonly connectionRpcResultHandler = inject(ConnectionSyncRpcResultHandlerService);
  private readonly connectionRestPersistence = inject(ConnectionRestPersistenceService);
  private readonly canonicalPrecheck = inject(ConnectionCanonicalPrecheckService);
  private readonly terminalRejection = inject(ConnectionTerminalRejectionService);
  private readonly restConflictRecovery = inject(ConnectionRestConflictRecoveryService);
  private readonly conflictStorage = inject(ConflictStorageService);
  private readonly projectState = inject(ProjectStateService);
  private readonly dataSafetyWriteAudit = new DataSafetyWriteAuditService();

  private readonly enqueueConnectionRetry = (
    connection: Connection,
    projectId: string,
    sourceUserId?: string,
    allowWhenSessionExpired = false,
    operationId?: string,
    lastFailure?: RetryQueueLastFailure,
  ): Promise<boolean> => {
    return this.connectionRetryEnqueue.enqueueConnectionUpsert(
      connection,
      projectId,
      sourceUserId,
      allowWhenSessionExpired,
      operationId,
      lastFailure,
    );
  };

  private recordConnectionRpcWriteAudit(input: ConnectionRpcWriteAudit): void {
    this.dataSafetyWriteAudit.recordWrite({
      ownerUserId: input.sourceUserId,
      operationId: input.operationId,
      sourceUserId: input.sourceUserId,
      entityType: 'connection',
      entityId: input.connection.id,
      operation: 'upsert',
      localTimestamp: input.localTimestamp,
      updatedAtBaseline: input.beforeVersion,
      beforeVersion: input.beforeVersion,
      rpcResult: input.result,
      enteredRetryQueue: input.enteredRetryQueue,
      retryCount: input.retryCount,
      lastSyncTimeBefore: input.lastSyncTimeBefore,
      lastSyncTimeAfter: this.syncStateService.syncState().lastSyncTime,
    });
  }

  /**
   * 获取 Supabase 客户端，离线模式返回 null
   */
  private getSupabaseClient(): SupabaseClient | null {
    if (!this.supabase.isConfigured) {
      const failure = classifySupabaseClientFailure(false);
      this.logger.warn('无法获取 Supabase 客户端', failure);
      this.syncStateService.setSyncError(failure.message);
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
      this.syncStateService.setSyncError(failure.message);
      // eslint-disable-next-line no-restricted-syntax -- 维持调用方约定：客户端不可用时返回 null 走降级链路
      return null;
    }
  }

  /**
   * 推送连接到云端
   *
   * @param skipTombstoneCheck 跳过 tombstone 检查（调用方已批量过滤时使用）
   * @param skipTaskExistenceCheck 跳过任务存在性检查（调用方已验证时使用）
   * @param fromRetryQueue 是否从 processRetryQueue 调用，为 true 时不自动入队
   */
  async pushConnection(
    connection: Connection,
    projectId: string,
    skipTombstoneCheck = false,
    skipTaskExistenceCheck = false,
    fromRetryQueue = false,
    sourceUserId?: string,
    operationId?: string,
    requireSyncRpc = false,
  ): Promise<boolean> {
    const request: ConnectionPushRequest = {
      connection,
      projectId,
      skipTombstoneCheck,
      skipTaskExistenceCheck,
      fromRetryQueue,
      sourceUserId,
      operationId,
      requireSyncRpc,
    };

    if (await this.connectionPreflight.shouldDeferConnectionBeforeClientLookup(
      request,
      this.enqueueConnectionRetry,
    )) {
      return false;
    }

    const client = this.getSupabaseClient();
    if (await this.connectionPreflight.shouldDeferConnectionForMissingClient(
      client,
      request,
      this.enqueueConnectionRetry,
    )) {
      return false;
    }
    if (!client) {
      return false;
    }

    try {
      return await this.pushConnectionWithClient(client, request);
    } catch (e) {
      return await this.handlePushConnectionException(e, request);
    }
  }

  private async pushConnectionWithClient(
    client: SupabaseClient,
    request: ConnectionPushRequest,
  ): Promise<boolean> {
    if (!(await this.connectionPreflight.validateConnectionPushSession(
      client,
      request,
      this.enqueueConnectionRetry,
    ))) {
      return false;
    }

    if (this.shouldRejectSelfLinkConnection(request)) {
      return false;
    }

    if (!(await this.ensureConnectionCanBePushed(client, request))) {
      return false;
    }

    await this.canonicalPrecheck.applyCanonicalEndpointPrecheck(client, request.projectId, request.connection);
    const execution = await this.executeConnectionPush(
      client,
      request.connection,
      request.projectId,
      request.fromRetryQueue,
      request.sourceUserId,
      request.operationId,
      request.requireSyncRpc === true,
    );
    return this.finalizeConnectionPushExecution(request.projectId, request.connection, execution);
  }

  private async handlePushConnectionException(e: unknown, request: ConnectionPushRequest): Promise<boolean> {
    if (isRetryDeferredError(e)) {
      throw e;
    }

    if (isBrowserNetworkSuspendedError(e) || isBrowserNetworkSuspendedWindow()) {
      return await this.connectionPreflight.preserveConnectionUpsertForBrowserSuspension(
        request,
        'pushConnection',
        this.enqueueConnectionRetry,
      );
    }

    return await this.handlePushConnectionError(
      e,
      request.connection,
      request.projectId,
      request.fromRetryQueue,
      request.sourceUserId,
      request.operationId,
    );
  }

  private shouldRejectSelfLinkConnection(request: ConnectionPushRequest): boolean {
    if (request.connection.source !== request.connection.target) {
      return false;
    }

    this.logger.warn('检测到无效自连接，已拒绝云端写入', {
      connectionId: request.connection.id,
      projectId: request.projectId,
      taskId: request.connection.source,
    });
    if (request.fromRetryQueue) {
      throw new PermanentFailureError(
        'Invalid self-link connection',
        undefined,
        { operation: 'pushConnection.invalidSelfLink', connectionId: request.connection.id, projectId: request.projectId }
      );
    }
    return true;
  }

  private finalizeConnectionPushExecution(
    projectId: string,
    connection: Connection,
    execution: ConnectionPushExecutionResult,
  ): boolean {
    if (execution.blockedBySyncRpc || !execution.pushed) {
      return false;
    }

    if (execution.persistedUpdatedAt) {
      this.canonicalIdentity.normalizeLocalConnectionUpdatedAt(
        projectId,
        connection,
        execution.persistedUpdatedAt,
      );
    }

    this.retryQueueService.recordCircuitSuccess();
    return true;
  }

  private async ensureConnectionCanBePushed(
    client: SupabaseClient,
    request: ConnectionPushRequest,
  ): Promise<boolean> {
    return await this.ensureConnectionNotTombstoned(client, request)
      && await this.ensureConnectionEndpointTasksExist(client, request);
  }

  private async ensureConnectionNotTombstoned(
    client: SupabaseClient,
    request: ConnectionPushRequest,
  ): Promise<boolean> {
    if (request.skipTombstoneCheck) {
      return true;
    }

    const tombstoneStatus = await this.connectionTombstones.checkConnectionTombstone(
      client,
      request.projectId,
      request.connection,
      request.fromRetryQueue,
    );

    if (tombstoneStatus.ok === false) {
      return this.handleFailedConnectionTombstoneStatus(tombstoneStatus, request);
    }

    if (!tombstoneStatus.tombstoneFound) {
      return true;
    }

    return this.handleRemoteConnectionTombstone(request);
  }

  private async ensureConnectionEndpointTasksExist(
    client: SupabaseClient,
    request: ConnectionPushRequest,
  ): Promise<boolean> {
    if (request.skipTaskExistenceCheck) {
      return true;
    }

    const validationResult = await this.connectionTaskValidation.validateTasksExist(
      client,
      request.projectId,
      request.connection,
      request.fromRetryQueue,
      (connection, projectId, reason) => this.terminalRejection.discardInvalidConnectionLocally(connection, projectId, reason),
    );

    if (validationResult.valid) {
      return true;
    }

    return this.handleInvalidConnectionTaskValidation(validationResult, request);
  }

  private handleRemoteConnectionTombstone(request: ConnectionPushRequest): false {
    this.logger.info('pushConnection: 跳过已删除连接（tombstone 防护）', {
      connectionId: request.connection.id,
      projectId: request.projectId
    });
    if (request.fromRetryQueue) {
      throw new PermanentFailureError(
        'Connection remote tombstoned',
        undefined,
        {
          operation: 'pushConnection.remoteTombstone',
          connectionId: request.connection.id,
          projectId: request.projectId,
        }
      );
    }
    return false;
  }

  private async handleFailedConnectionTombstoneStatus(
    tombstoneStatus: Extract<ConnectionTombstoneCheckResult, { ok: false }>,
    request: ConnectionPushRequest,
  ): Promise<boolean> {
    if (!tombstoneStatus.shouldRetry) {
      if (request.fromRetryQueue) {
        throw new PermanentFailureError(
          'Connection tombstone lookup denied',
          tombstoneStatus.error,
          {
            operation: 'pushConnection.connectionTombstoneLookup',
            connectionId: request.connection.id,
            projectId: request.projectId,
          }
        );
      }
      return false;
    }

    if (request.fromRetryQueue) {
      // 回放路径的可重试基础设施失败（含浏览器挂起/断网/超时/5xx）必须抛回
      // runner 的延后/熔断分类通道；吞成 false 会计入 retryCount，
      // 弱网 flap 数轮即把队列项烧进隔离区
      throw tombstoneStatus.error;
    }

    await this.enqueueConnectionRetry(
      request.connection,
      request.projectId,
      request.sourceUserId,
      false,
      request.operationId,
    );
    return false;
  }

  private async handleInvalidConnectionTaskValidation(
    validationResult: Extract<TaskValidationResult, { valid: false }>,
    request: ConnectionPushRequest,
  ): Promise<boolean> {
    if (!validationResult.shouldRetry) {
      if (request.fromRetryQueue) {
        throw new PermanentFailureError(
          validationResult.reason === 'permission-denied'
            ? 'Connection task validation denied'
            : 'Connection references deleted tasks',
          validationResult.error,
          {
            operation: 'pushConnection.validateTasksExist',
            connectionId: request.connection.id,
            projectId: request.projectId,
            source: request.connection.source,
            target: request.connection.target,
            reason: validationResult.reason,
          }
        );
      }
      return false;
    }

    if (request.fromRetryQueue && validationResult.error?.errorType === 'BrowserNetworkSuspendedError') {
      throw validationResult.error;
    }

    if (!request.fromRetryQueue) {
      await this.enqueueConnectionRetry(
        request.connection,
        request.projectId,
        request.sourceUserId,
        false,
        request.operationId,
      );
    }
    return false;
  }

  private async executeConnectionPush(
    client: SupabaseClient,
    connection: Connection,
    projectId: string,
    fromRetryQueue: boolean,
    sourceUserId: string | undefined,
    operationId: string | undefined,
    requireSyncRpc: boolean,
  ): Promise<ConnectionPushExecutionResult> {
    let result = createPendingConnectionPushExecutionResult();

    await this.throttle.execute(
      `push-connection:${connection.id}`,
      async () => {
        result = await this.executeConnectionPushWithRetry(
          client,
          connection,
          projectId,
          fromRetryQueue,
          sourceUserId,
          operationId,
          requireSyncRpc,
        );
      },
      { priority: 'normal', retries: 0, timeout: REQUEST_THROTTLE_CONFIG.INDIVIDUAL_OPERATION_TIMEOUT }
    );

    return result;
  }

  private async executeConnectionPushWithRetry(
    client: SupabaseClient,
    connection: Connection,
    projectId: string,
    fromRetryQueue: boolean,
    sourceUserId: string | undefined,
    operationId: string | undefined,
    requireSyncRpc: boolean,
  ): Promise<ConnectionPushExecutionResult> {
    let result = createPendingConnectionPushExecutionResult();

    await this.syncOpHelper.retryWithBackoff(async () => {
      if (shouldUseConnectionSyncRpc(this.syncRpcClient)) {
        if (operationId === undefined) {
          await this.deferConnectionPushMissingOperationId(connection, projectId, fromRetryQueue, sourceUserId);
          result = {
            pushed: false,
            blockedBySyncRpc: true,
            persistedUpdatedAt: null,
          };
          return;
        }
        result = await this.pushConnectionViaSyncRpc(connection, projectId, fromRetryQueue, sourceUserId, operationId);
        return;
      }

      if (operationId === undefined) {
        await this.deferConnectionPushMissingOperationId(connection, projectId, fromRetryQueue, sourceUserId);
        result = {
          pushed: false,
          blockedBySyncRpc: true,
          persistedUpdatedAt: null,
        };
        return;
      }

      if (!fromRetryQueue) {
        await this.enqueueConnectionRetry(connection, projectId, sourceUserId, false, operationId);
      }

      if (!fromRetryQueue || requireSyncRpc) {
        result = {
          pushed: false,
          blockedBySyncRpc: true,
          persistedUpdatedAt: null,
        };
        return;
      }

      result = await this.pushConnectionViaRest(client, connection, projectId);
    });

    return result;
  }

  private async deferConnectionPushMissingOperationId(
    connection: Connection,
    projectId: string,
    fromRetryQueue: boolean,
    sourceUserId: string | undefined,
  ): Promise<void> {
    this.logger.warn('pushConnection: 缺少 operationId，已延后到 RetryQueue 以避免临时 RPC 幂等键', {
      connectionId: connection.id,
      projectId,
      fromRetryQueue,
    });

    if (fromRetryQueue) {
      throw createRetryDeferredError(
        'Connection retry item is missing operationId; keeping it in RetryQueue until operationId repair can persist.',
      );
    }

    await this.enqueueConnectionRetry(
      connection,
      projectId,
      sourceUserId,
      false,
      createConnectionSyncRpcOperationId(),
    );
  }

  private async pushConnectionViaSyncRpc(
    connection: Connection,
    projectId: string,
    fromRetryQueue: boolean,
    sourceUserId: string | undefined,
    operationId: string,
  ): Promise<ConnectionPushExecutionResult> {
    const beforeVersion = connection.updatedAt ?? null;
    const lastSyncTimeBefore = this.syncStateService.syncState().lastSyncTime;
    const result = await this.syncRpcClient!.upsertConnection({
      operationId,
      connection,
      projectId,
      baseUpdatedAt: beforeVersion,
    });
    const audit = createConnectionRpcWriteAudit({
      operationId,
      sourceUserId,
      connection,
      result,
      beforeVersion,
      lastSyncTimeBefore,
    });

    try {
      const pushed = await this.connectionRpcResultHandler.handleConnectionSyncRpcResult(
        result,
        connection,
        projectId,
        fromRetryQueue,
        sourceUserId,
        this.createConnectionRpcResultHandlers(operationId, audit),
      );
      this.recordConnectionRpcWriteAudit(audit);

      return {
        pushed,
        blockedBySyncRpc: !pushed,
        persistedUpdatedAt: null,
      };
    } catch (error) {
      this.recordConnectionRpcWriteAudit(audit);
      throw await this.resolveConnectionRpcReplayError(error, {
        connection,
        projectId,
        fromRetryQueue,
        sourceUserId,
        operationId,
        result,
      });
    }
  }

  private async resolveConnectionRpcReplayError(
    error: unknown,
    input: {
      connection: Connection;
      projectId: string;
      fromRetryQueue: boolean;
      sourceUserId: string | undefined;
      operationId: string;
      result: SyncRpcResult;
    },
  ): Promise<unknown> {
    if (!input.fromRetryQueue) {
      return error;
    }

    const evidence = resolveRemoteVersionConflictEvidence(error, [
      'CONNECTION_REMOTE_NEWER',
      'CONNECTION_REMOTE_TOMBSTONE_NEWER',
    ]);
    if (!evidence) {
      return error;
    }

    const saved = await persistConnectionRpcReplayConflict({
      input,
      evidence,
      conflictStorage: this.conflictStorage,
      projectState: this.projectState,
      logger: this.logger,
    });
    if (saved) {
      return error;
    }

    this.logger.warn('connection RPC 冲突证据保存失败，保留 RetryQueue 项等待后续恢复', {
      connectionId: input.connection.id,
      projectId: input.projectId,
      operationId: input.operationId,
      code: evidence.code,
    });
    return createRetryDeferredError('Connection remote conflict evidence was not persisted; keeping retry item');
  }

  private createConnectionRpcResultHandlers(
    operationId: string,
    audit: ConnectionRpcWriteAudit,
  ) {
    return createConnectionSyncRpcResultHandlers({
      operationId,
      audit,
      normalizeLocalConnectionUpdatedAt: (projectId, connection, serverUpdatedAt) => {
        this.canonicalIdentity.normalizeLocalConnectionUpdatedAt(projectId, connection, serverUpdatedAt);
      },
      discardInvalidConnectionLocally: (connection, projectId, reason) => {
        this.terminalRejection.discardInvalidConnectionLocally(connection, projectId, reason);
      },
      enqueueConnectionRetry: this.enqueueConnectionRetry,
    });
  }

  private async pushConnectionViaRest(
    client: SupabaseClient,
    connection: Connection,
    projectId: string,
  ): Promise<ConnectionPushExecutionResult> {
    const remoteConnection = await this.connectionRestPersistence.loadRemoteConnectionFreshness(
      client,
      connection.id,
      projectId,
    );
    await this.restConflictRecovery.assertRemoteConnectionNotNewer(connection, projectId, remoteConnection);

    try {
      return {
        pushed: true,
        blockedBySyncRpc: false,
        persistedUpdatedAt: await this.connectionRestPersistence.upsertConnectionReturningUpdatedAt(
          client,
          connection,
          projectId,
          remoteConnection,
          createConnectionRestRemoteNewerConflict,
        ),
      };
    } catch (upsertError) {
      return await this.restConflictRecovery.recoverConnectionUpsertConflict(client, connection, projectId, upsertError);
    }
  }

  /** 处理 pushConnection 错误 */
  private async handlePushConnectionError(
    e: unknown,
    connection: Connection,
    projectId: string,
    fromRetryQueue: boolean,
    sourceUserId?: string,
    operationId?: string,
  ): Promise<boolean> {
    return await this.connectionPushErrors.handlePushConnectionError(
      e,
      connection,
      projectId,
      fromRetryQueue,
      sourceUserId,
      operationId,
      async (retryConnection, retryProjectId, retrySourceUserId, allowWhenSessionExpired, retryOperationId, lastFailure) => {
        return await this.enqueueConnectionRetry(
          retryConnection,
          retryProjectId,
          retrySourceUserId,
          allowWhenSessionExpired,
          retryOperationId ?? operationId,
          lastFailure,
        );
      },
    );
  }

  /** 获取项目的所有 connection tombstone ID，优先使用 TombstoneService 缓存。 */
  async getConnectionTombstoneIds(projectId: string): Promise<Set<string>> {
    return await this.connectionTombstones.getConnectionTombstoneIds(projectId, () => this.getSupabaseClient());
  }
}
