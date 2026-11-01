import { Injectable, inject } from '@angular/core';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { Connection } from '../../../../models';
import { LoggerService } from '../../../../services/logger.service';
import { ToastService } from '../../../../services/toast.service';
import { createBrowserNetworkSuspendedError, isBrowserNetworkSuspendedWindow } from '../../../../utils/browser-network-suspension';
import { RetryQueueService } from './retry-queue.service';
import { SessionManagerService } from './session-manager.service';
import { SyncStateService } from './sync-state.service';
import {
  assertConnectionReplayFenceCurrent,
  type ConnectionActionQueueReplayFence,
} from './connection-sync-operations.helpers';

export type ConnectionPushRequest = {
  connection: Connection;
  projectId: string;
  skipTombstoneCheck: boolean;
  skipTaskExistenceCheck: boolean;
  fromRetryQueue: boolean;
  sourceUserId?: string;
  operationId?: string;
  requireSyncRpc?: boolean;
  replayFence?: ConnectionActionQueueReplayFence;
  replayHandoff?: boolean;
};

export type ConnectionPreflightRetryEnqueueHandler = (
  connection: Connection,
  projectId: string,
  sourceUserId?: string,
  allowWhenSessionExpired?: boolean,
  operationId?: string,
) => Promise<boolean>;

@Injectable({ providedIn: 'root' })
export class ConnectionPushPreflightService {
  private readonly logger = inject(LoggerService).category('ConnectionSyncOps');
  private readonly retryQueueService = inject(RetryQueueService);
  private readonly sessionManager = inject(SessionManagerService);
  private readonly syncStateService = inject(SyncStateService);
  private readonly toast = inject(ToastService);

  async shouldDeferConnectionBeforeClientLookup(
    request: ConnectionPushRequest,
    enqueueRetry: ConnectionPreflightRetryEnqueueHandler,
  ): Promise<boolean> {
    assertConnectionReplayFenceCurrent(request.replayFence);
    return await this.shouldDeferConnectionForExpiredSession(request, enqueueRetry)
      || await this.shouldDeferConnectionForCircuitBreaker(request, enqueueRetry);
  }

  async shouldDeferConnectionForMissingClient(
    client: SupabaseClient | null,
    request: ConnectionPushRequest,
    enqueueRetry: ConnectionPreflightRetryEnqueueHandler,
  ): Promise<boolean> {
    assertConnectionReplayFenceCurrent(request.replayFence);
    if (client) {
      return false;
    }

    if (!request.fromRetryQueue) {
      await enqueueRetry(request.connection, request.projectId, request.sourceUserId, undefined, request.operationId);
      assertConnectionReplayFenceCurrent(request.replayFence);
    }
    return true;
  }

  async validateConnectionPushSession(
    client: SupabaseClient,
    request: ConnectionPushRequest,
    enqueueRetry: ConnectionPreflightRetryEnqueueHandler,
  ): Promise<boolean> {
    assertConnectionReplayFenceCurrent(request.replayFence);
    let sessionUserId = await this.getConnectionPushSessionUserId(client);
    assertConnectionReplayFenceCurrent(request.replayFence);
    if (!sessionUserId) {
      if (request.replayFence) return await this.handleMissingConnectionPushSession(request, enqueueRetry);
      const refreshed = await this.sessionManager.tryRefreshSession('pushConnection.getSession');
      if (refreshed) {
        sessionUserId = await this.getConnectionPushSessionUserId(client);
      }
      assertConnectionReplayFenceCurrent(request.replayFence);
    }

    if (!sessionUserId) {
      return await this.handleMissingConnectionPushSession(request, enqueueRetry);
    }

    return await this.validateConnectionPushOwner(request, sessionUserId, enqueueRetry);
  }

  async preserveConnectionUpsertForBrowserSuspension(
    request: ConnectionPushRequest,
    context: string,
    enqueueRetry: ConnectionPreflightRetryEnqueueHandler,
  ): Promise<boolean> {
    assertConnectionReplayFenceCurrent(request.replayFence);
    if (request.fromRetryQueue) {
      throw createBrowserNetworkSuspendedError();
    }

    await enqueueRetry(request.connection, request.projectId, request.sourceUserId, true, request.operationId);
    assertConnectionReplayFenceCurrent(request.replayFence);

    this.logger.info('浏览器网络挂起，延后连接同步', {
      connectionId: request.connection.id,
      projectId: request.projectId,
      context,
    });
    return false;
  }

  private async getConnectionPushSessionUserId(client: SupabaseClient): Promise<string | null> {
    const { data: { session } } = await client.auth.getSession();
    return session?.user?.id ?? null;
  }

  private async handleMissingConnectionPushSession(
    request: ConnectionPushRequest,
    enqueueRetry: ConnectionPreflightRetryEnqueueHandler,
  ): Promise<boolean> {
    if (request.replayFence) {
      await enqueueRetry(request.connection, request.projectId, request.sourceUserId, true, request.operationId);
      assertConnectionReplayFenceCurrent(request.replayFence);
      return false;
    }
    if (isBrowserNetworkSuspendedWindow()) {
      return await this.preserveConnectionUpsertForBrowserSuspension(
        request,
        'pushConnection.getSession',
        enqueueRetry,
      );
    }

    this.syncStateService.setSessionExpired(true);
    this.logger.warn('检测到会话丢失', { connectionId: request.connection.id, operation: 'pushConnection' });
    this.toast.warning('登录已过期', '请重新登录以继续同步数据');
    if (!request.fromRetryQueue) {
      await enqueueRetry(request.connection, request.projectId, request.sourceUserId, true, request.operationId);
    }
    return false;
  }

  private async validateConnectionPushOwner(
    request: ConnectionPushRequest,
    sessionUserId: string,
    enqueueRetry: ConnectionPreflightRetryEnqueueHandler,
  ): Promise<boolean> {
    assertConnectionReplayFenceCurrent(request.replayFence);
    if (!request.sourceUserId || sessionUserId === request.sourceUserId) {
      return true;
    }

    this.logger.warn('检测到连接同步归属与当前会话不匹配，已拒绝云端写入', {
      connectionId: request.connection.id,
      projectId: request.projectId,
      sourceUserId: request.sourceUserId,
      sessionUserId,
    });
    if (!request.fromRetryQueue) {
      await enqueueRetry(request.connection, request.projectId, request.sourceUserId, undefined, request.operationId);
      assertConnectionReplayFenceCurrent(request.replayFence);
    }
    return false;
  }

  private async shouldDeferConnectionForExpiredSession(
    request: ConnectionPushRequest,
    enqueueRetry: ConnectionPreflightRetryEnqueueHandler,
  ): Promise<boolean> {
    assertConnectionReplayFenceCurrent(request.replayFence);
    if (!this.syncStateService.isSessionExpired()) {
      return false;
    }

    this.logger.warn('会话已过期，连接同步被阻止', { connectionId: request.connection.id });
    if (!request.fromRetryQueue) {
      await enqueueRetry(request.connection, request.projectId, request.sourceUserId, true, request.operationId);
      assertConnectionReplayFenceCurrent(request.replayFence);
    }
    return true;
  }

  private async shouldDeferConnectionForCircuitBreaker(
    request: ConnectionPushRequest,
    enqueueRetry: ConnectionPreflightRetryEnqueueHandler,
  ): Promise<boolean> {
    assertConnectionReplayFenceCurrent(request.replayFence);
    if (this.retryQueueService.checkCircuitBreaker()) {
      return false;
    }

    this.logger.debug('Circuit Breaker: 熔断中，跳过连接推送', { connectionId: request.connection.id });
    if (!request.fromRetryQueue) {
      await enqueueRetry(request.connection, request.projectId, request.sourceUserId, undefined, request.operationId);
      assertConnectionReplayFenceCurrent(request.replayFence);
    }
    return true;
  }
}
