import { Injectable, inject } from '@angular/core';

import type { Connection } from '../../../../models';
import { LoggerService } from '../../../../services/logger.service';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import type { SyncRpcResult } from '../../../../services/sync-rpc-client.service';
import { PermanentFailureError } from '../../../../utils/permanent-failure-error';
import { createRemoteNewerConflictError } from './connection-sync-conflict.helpers';
import { SyncStateService } from './sync-state.service';
import {
  assertConnectionReplayFenceCurrent,
  type ConnectionActionQueueReplayFence,
} from './connection-sync-operations.helpers';

export type ConnectionRpcNormalizeUpdatedAtHandler = (
  projectId: string,
  connection: Connection,
  serverUpdatedAt?: string | null,
) => void;

export type ConnectionRpcDiscardInvalidHandler = (
  connection: Connection,
  projectId: string,
  reason: string,
) => void;

export type ConnectionRpcRetryEnqueueHandler = (
  connection: Connection,
  projectId: string,
  sourceUserId?: string,
) => Promise<boolean>;

@Injectable({ providedIn: 'root' })
export class ConnectionSyncRpcResultHandlerService {
  private readonly logger = inject(LoggerService).category('ConnectionSyncOps');
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly syncStateService = inject(SyncStateService);

  async handleConnectionSyncRpcResult(
    result: SyncRpcResult,
    connection: Connection,
    projectId: string,
    fromRetryQueue: boolean,
    sourceUserId: string | undefined,
    handlers: {
      normalizeUpdatedAt: ConnectionRpcNormalizeUpdatedAtHandler;
      discardInvalid: ConnectionRpcDiscardInvalidHandler;
      enqueueRetry: ConnectionRpcRetryEnqueueHandler;
    },
    replayFence?: ConnectionActionQueueReplayFence,
  ): Promise<boolean> {
    assertConnectionReplayFenceCurrent(replayFence);
    if (result.status === 'applied' || result.status === 'idempotent-replay') {
      if (result.serverUpdatedAt) {
        handlers.normalizeUpdatedAt(projectId, connection, result.serverUpdatedAt);
      }
      this.logger.debug('pushConnection: sync RPC 写入成功', {
        connectionId: connection.id,
        projectId,
        status: result.status,
      });
      return true;
    }

    if (result.status === 'remote-newer') {
      await this.handleConnectionSyncRemoteNewer(
        result, connection, projectId, fromRetryQueue, sourceUserId, handlers.enqueueRetry, replayFence,
      );
      return false;
    }

    if (result.status === 'unauthorized' && this.isTerminalConnectionRejection(result.reason)) {
      handlers.discardInvalid(connection, projectId, result.reason ?? 'unknown');
      return false;
    }

    await this.handleConnectionSyncRejected(
      result, connection, projectId, fromRetryQueue, sourceUserId, handlers.enqueueRetry, replayFence,
    );
    return false;
  }

  private async handleConnectionSyncRemoteNewer(
    result: SyncRpcResult,
    connection: Connection,
    projectId: string,
    fromRetryQueue: boolean,
    sourceUserId: string | undefined,
    enqueueRetry: ConnectionRpcRetryEnqueueHandler,
    replayFence?: ConnectionActionQueueReplayFence,
  ): Promise<void> {
    assertConnectionReplayFenceCurrent(replayFence);
    if (replayFence) {
      const conflictError = createRemoteNewerConflictError(
        connection.id,
        projectId,
        result.remoteUpdatedAt ?? null,
        'remote-newer',
        { localConnection: connection },
      );
      throw new PermanentFailureError(
        'Connection remote is newer; conflict evidence must be persisted before ActionQueue settlement',
        conflictError,
        { operation: 'pushConnection.remoteNewer', connectionId: connection.id, projectId },
      );
    }
    this.logger.warn('pushConnection: sync RPC CAS 拒绝，远端版本更新', {
      connectionId: connection.id,
      projectId,
      remoteUpdatedAt: result.remoteUpdatedAt,
      reason: result.reason,
    });
    this.sentryLazyLoader.captureMessage('sync_rpc_connection_remote_newer', {
      level: 'warning',
      tags: { operation: 'pushConnection', entityType: 'connection', status: result.status },
      extra: { connectionId: connection.id, projectId, remoteUpdatedAt: result.remoteUpdatedAt, reason: result.reason },
    });
    if (fromRetryQueue) {
      const conflictError = createRemoteNewerConflictError(
        connection.id,
        projectId,
        result.remoteUpdatedAt ?? null,
        'remote-newer',
        { localConnection: connection },
      );
      throw new PermanentFailureError(
        'Connection remote is newer; conflict evidence must be persisted before retry removal',
        conflictError,
        {
          operation: 'pushConnection.remoteNewer',
          connectionId: connection.id,
          projectId,
          sourceUserId,
          remoteUpdatedAt: result.remoteUpdatedAt ?? null,
          reason: result.reason ?? 'remote-newer',
        },
      );
    }

    await this.enqueueConnectionRetryAfterRpcRejection(connection, projectId, fromRetryQueue, sourceUserId, enqueueRetry);
  }

  private async handleConnectionSyncRejected(
    result: SyncRpcResult,
    connection: Connection,
    projectId: string,
    fromRetryQueue: boolean,
    sourceUserId: string | undefined,
    enqueueRetry: ConnectionRpcRetryEnqueueHandler,
    replayFence?: ConnectionActionQueueReplayFence,
  ): Promise<void> {
    assertConnectionReplayFenceCurrent(replayFence);
    if (!replayFence) {
      this.syncStateService.setSyncError(this.getConnectionSyncRejectionMessage(result));
      this.logger.warn('pushConnection: sync RPC 拒绝写入', {
        connectionId: connection.id,
        projectId,
        status: result.status,
        reason: result.reason,
        minProtocolVersion: result.minProtocolVersion,
      });
      this.sentryLazyLoader.captureMessage('sync_rpc_connection_rejected', {
        level: 'warning',
        tags: { operation: 'pushConnection', entityType: 'connection', status: result.status },
        extra: { connectionId: connection.id, projectId, reason: result.reason, minProtocolVersion: result.minProtocolVersion },
      });
    }
    if (result.status === 'client-version-rejected') {
      return;
    }

    await this.enqueueConnectionRetryAfterRpcRejection(connection, projectId, fromRetryQueue, sourceUserId, enqueueRetry);
  }

  private getConnectionSyncRejectionMessage(result: SyncRpcResult): string {
    return result.status === 'client-version-rejected'
      ? '当前客户端同步协议已过期，请刷新后重试'
      : '同步写入被服务端拒绝，已保留本地变更等待重试';
  }

  private async enqueueConnectionRetryAfterRpcRejection(
    connection: Connection,
    projectId: string,
    fromRetryQueue: boolean,
    sourceUserId: string | undefined,
    enqueueRetry: ConnectionRpcRetryEnqueueHandler,
  ): Promise<void> {
    if (!fromRetryQueue) {
      await enqueueRetry(connection, projectId, sourceUserId);
    }
  }

  private isTerminalConnectionRejection(reason: string | undefined): boolean {
    if (!reason) return false;
    return (
      reason === 'connection_endpoint_not_in_project'
      || reason === 'connection_owned_by_other_project'
      || reason === 'endpoint_tombstone'
      || reason === 'legacy_endpointless_tombstone'
    );
  }
}
