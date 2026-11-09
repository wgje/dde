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
import {
  createConnectionSyncRpcExecutionResult,
  createConnectionRpcWriteAudit,
  createConnectionSyncRpcResultHandlers,
  createConnectionSyncRpcOperationId,
  buildConnectionReplayPayloadSignature,
  createConnectionReplayRetryHandler,
  createConnectionActionQueuePushRequest,
  createPendingConnectionPushExecutionResult,
  assertConnectionReplayFenceCurrent,
  combineConnectionReplayAbortSignals,
  persistConnectionRpcReplayConflict,
  runConnectionActionQueueReplay,
  shouldUseConnectionSyncRpc,
  type ConnectionRpcWriteAudit,
  type ConnectionPushExecutionResult,
  type ConnectionActionQueueReplayInput,
  type ConnectionActionQueueReplayResult,
} from './connection-sync-operations.helpers';
import { ConnectionCanonicalPrecheckService } from './connection-canonical-precheck.service';
import { ConnectionTerminalRejectionService } from './connection-terminal-rejection.service';
import { captureSyncResponseVersion, type SyncResponseVersionSnapshot } from './sync-response-version-guard';

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
  private readonly canonicalPrecheck = inject(ConnectionCanonicalPrecheckService);
  private readonly terminalRejection = inject(ConnectionTerminalRejectionService);
  private readonly conflictStorage = inject(ConflictStorageService);
  private readonly projectState = inject(ProjectStateService);
  private readonly dataSafetyWriteAudit = new DataSafetyWriteAuditService();
  readonly buildActionQueueReplayPayloadSignature = buildConnectionReplayPayloadSignature;

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

  private createConnectionRetryHandler(request: ConnectionPushRequest) {
    return createConnectionReplayRetryHandler({
      request,
      enqueueRetry: this.enqueueConnectionRetry,
      enqueueFromActionQueue: fence =>
        this.connectionRetryEnqueue.enqueueConnectionUpsertFromActionQueue(fence),
    });
  }

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
  private getSupabaseClient(reportFailure = true): SupabaseClient | null {
    if (!this.supabase.isConfigured) {
      const failure = classifySupabaseClientFailure(false);
      if (reportFailure) {
        this.logger.warn('无法获取 Supabase 客户端', failure);
        this.syncStateService.setSyncError(failure.message);
      }
      return null;
    }
    try {
      return this.supabase.client();
    } catch (error) {
      const failure = classifySupabaseClientFailure(true, error);
      if (reportFailure) {
        this.logger.warn('无法获取 Supabase 客户端', {
          category: failure.category,
          message: failure.message
        });
        this.syncStateService.setSyncError(failure.message);
      }
      // eslint-disable-next-line no-restricted-syntax -- 维持调用方约定：客户端不可用时返回 null 走降级链路
      return null;
    }
  }

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

    return await this.pushConnectionRequest(request, true);
  }

  async pushConnectionFromActionQueue(
    input: ConnectionActionQueueReplayInput,
  ): Promise<ConnectionActionQueueReplayResult> {
    return runConnectionActionQueueReplay(input, async (connection, replayFence) => {
      const request: ConnectionPushRequest = createConnectionActionQueuePushRequest(
        connection,
        replayFence,
      );
      const pushed = await this.pushConnectionRequest(request, false);
      return { pushed, handoff: request.replayHandoff === true };
    });
  }

  private async pushConnectionRequest(
    request: ConnectionPushRequest,
    handleErrors: boolean,
  ): Promise<boolean> {

    if (await this.connectionPreflight.shouldDeferConnectionBeforeClientLookup(
      request,
      this.createConnectionRetryHandler(request),
    )) {
      return false;
    }

    const client = this.getSupabaseClient(request.replayFence === undefined);
    if (await this.connectionPreflight.shouldDeferConnectionForMissingClient(
      client,
      request,
      this.createConnectionRetryHandler(request),
    )) {
      return false;
    }
    if (!client) {
      return false;
    }

    try {
      return await this.pushConnectionWithClient(client, request);
    } catch (e) {
      if (!handleErrors) throw e;
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
      this.createConnectionRetryHandler(request),
    ))) {
      return false;
    }

    if (this.shouldRejectSelfLinkConnection(request)) {
      return false;
    }

    if (!(await this.ensureConnectionCanBePushed(client, request))) {
      return false;
    }

    await this.canonicalPrecheck.applyCanonicalEndpointPrecheck(
      client,
      request.projectId,
      request.connection,
      request.replayFence,
    );
    const execution = await this.executeConnectionPush(request);
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
        this.createConnectionRetryHandler(request),
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
      if (execution.requestVersion) {
        this.canonicalIdentity.normalizeLocalConnectionUpdatedAt(
          projectId,
          connection,
          execution.persistedUpdatedAt,
          execution.requestVersion,
        );
      } else {
        this.logger.warn('连接写入成功但缺少请求版本快照，跳过 updatedAt 回写', {
          connectionId: connection.id,
          projectId,
          serverUpdatedAt: execution.persistedUpdatedAt,
        });
      }
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
      request.replayFence,
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
      (connection, projectId, reason) => {
        assertConnectionReplayFenceCurrent(request.replayFence);
        this.terminalRejection.discardInvalidConnectionLocally(connection, projectId, reason);
      },
      request.replayFence,
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

    await this.createConnectionRetryHandler(request)(
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
      await this.createConnectionRetryHandler(request)(
        request.connection,
        request.projectId,
        request.sourceUserId,
        false,
        request.operationId,
      );
    }
    return false;
  }

  private async executeConnectionPush(request: ConnectionPushRequest): Promise<ConnectionPushExecutionResult> {
    let result = createPendingConnectionPushExecutionResult();

    await this.throttle.execute(
      `push-connection:${request.connection.id}`,
      async throttleSignal => {
        assertConnectionReplayFenceCurrent(request.replayFence);
        const combined = combineConnectionReplayAbortSignals(
          throttleSignal,
          request.replayFence?.leaseSignal,
        );
        try {
          result = await this.executeConnectionPushWithRetry(request, combined.signal);
        } finally {
          combined.dispose();
        }
      },
      { priority: 'normal', retries: 0, timeout: REQUEST_THROTTLE_CONFIG.INDIVIDUAL_OPERATION_TIMEOUT }
    );
    assertConnectionReplayFenceCurrent(request.replayFence);
    return result;
  }

  private async executeConnectionPushWithRetry(
    request: ConnectionPushRequest,
    abortSignal?: AbortSignal,
  ): Promise<ConnectionPushExecutionResult> {
    let result = createPendingConnectionPushExecutionResult();

    await this.syncOpHelper.retryWithBackoff(async () => {
      assertConnectionReplayFenceCurrent(request.replayFence);
      if (shouldUseConnectionSyncRpc(this.syncRpcClient)) {
        if (request.operationId === undefined) {
          await this.deferConnectionPushMissingOperationId(request);
          result = {
            pushed: false,
            blockedBySyncRpc: true,
            persistedUpdatedAt: null,
          };
          return;
        }
        result = await this.pushConnectionViaSyncRpc(request, abortSignal);
        return;
      }

      if (request.operationId === undefined) {
        await this.deferConnectionPushMissingOperationId(request);
        result = {
          pushed: false,
          blockedBySyncRpc: true,
          persistedUpdatedAt: null,
        };
        return;
      }
      result = await this.resolveUnavailableConnectionSyncRpcPush(request);
    });
    assertConnectionReplayFenceCurrent(request.replayFence);
    return result;
  }

  private async resolveUnavailableConnectionSyncRpcPush(
    request: ConnectionPushRequest,
  ): Promise<ConnectionPushExecutionResult> {
    if (!request.fromRetryQueue) {
      await this.createConnectionRetryHandler(request)(
        request.connection, request.projectId, request.sourceUserId, false, request.operationId,
      );
      return {
        pushed: false,
        blockedBySyncRpc: true,
        persistedUpdatedAt: null,
      };
    }

    this.logger.warn('pushConnection: sync RPC 不可用，已禁止 connections 直接写入', {
      connectionId: request.connection.id,
      projectId: request.projectId,
      requireSyncRpc: request.requireSyncRpc,
    });
    throw createRetryDeferredError(
      'Connection sync RPC is unavailable; keeping the original RetryQueue item.',
    );
  }

  private async deferConnectionPushMissingOperationId(request: ConnectionPushRequest): Promise<void> {
    this.logger.warn('pushConnection: 缺少 operationId，已延后到 RetryQueue 以避免临时 RPC 幂等键', {
      connectionId: request.connection.id,
      projectId: request.projectId,
      fromRetryQueue: request.fromRetryQueue,
    });

    if (request.fromRetryQueue) {
      throw createRetryDeferredError(
        'Connection retry item is missing operationId; keeping it in RetryQueue until operationId repair can persist.',
      );
    }

    await this.createConnectionRetryHandler(request)(
      request.connection,
      request.projectId,
      request.sourceUserId,
      false,
      createConnectionSyncRpcOperationId(),
    );
  }

  private async pushConnectionViaSyncRpc(
    request: ConnectionPushRequest,
    abortSignal?: AbortSignal,
  ): Promise<ConnectionPushExecutionResult> {
    const operationId = request.operationId;
    if (operationId === undefined) return createPendingConnectionPushExecutionResult();
    const requestVersion = captureSyncResponseVersion(request.connection);
    const beforeVersion = requestVersion.updatedAt;
    const lastSyncTimeBefore = this.syncStateService.syncState().lastSyncTime;
    const result = await this.syncRpcClient!.upsertConnection({
      operationId,
      connection: request.connection,
      projectId: request.projectId,
      baseUpdatedAt: beforeVersion,
      abortSignal,
    });
    assertConnectionReplayFenceCurrent(request.replayFence);
    const audit = createConnectionRpcWriteAudit({
      operationId,
      sourceUserId: request.sourceUserId,
      connection: request.connection,
      result,
      beforeVersion,
      lastSyncTimeBefore,
    });

    try {
      const pushed = await this.connectionRpcResultHandler.handleConnectionSyncRpcResult(
        result,
        request.connection,
        request.projectId,
        request.fromRetryQueue,
        request.sourceUserId,
        this.createConnectionRpcResultHandlers(request, operationId, audit, requestVersion),
        request.replayFence,
      );
      this.recordConnectionRpcWriteAudit(audit);

      return createConnectionSyncRpcExecutionResult(pushed);
    } catch (error) {
      this.recordConnectionRpcWriteAudit(audit);
      throw await this.resolveConnectionRpcReplayError(error, {
        connection: request.connection,
        projectId: request.projectId,
        fromRetryQueue: request.fromRetryQueue,
        sourceUserId: request.sourceUserId,
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
    request: ConnectionPushRequest,
    operationId: string,
    audit: ConnectionRpcWriteAudit,
    requestVersion: SyncResponseVersionSnapshot,
  ) {
    return createConnectionSyncRpcResultHandlers({
      operationId,
      audit,
      requestVersion,
      normalizeLocalConnectionUpdatedAt: (projectId, connection, serverUpdatedAt, responseVersion?) => {
        assertConnectionReplayFenceCurrent(request.replayFence);
        this.canonicalIdentity.normalizeLocalConnectionUpdatedAt(
          projectId,
          connection,
          serverUpdatedAt,
          responseVersion,
        );
      },
      discardInvalidConnectionLocally: (connection, projectId, reason) => {
        assertConnectionReplayFenceCurrent(request.replayFence);
        this.terminalRejection.discardInvalidConnectionLocally(connection, projectId, reason);
      },
      enqueueConnectionRetry: this.createConnectionRetryHandler(request),
    });
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
