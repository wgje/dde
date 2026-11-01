import { Injectable, inject } from '@angular/core';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { Connection } from '../../../../models';
import { LoggerService } from '../../../../services/logger.service';
import { supabaseErrorToError, type EnhancedError } from '../../../../utils/supabase-error';
import {
  isBrowserNetworkSuspendedError,
  isBrowserNetworkSuspendedWindow,
} from '../../../../utils/browser-network-suspension';
import { fetchAllSupabaseKeysetPagesByCursor } from '../../../../utils/supabase-pagination';
import { isValidUUID } from '../../../../utils/validation';
import { RetryQueueService } from './retry-queue.service';
import { SessionManagerService } from './session-manager.service';
import { TombstoneService } from './tombstone.service';
import {
  getConnectionFreshnessTimestamp,
  isRemoteTombstoneAtLeastAsFresh,
} from './connection-sync-freshness.helpers';
import {
  assertConnectionReplayFenceCurrent,
  type ConnectionActionQueueReplayFence,
} from './connection-sync-operations.helpers';

export type ConnectionTombstoneCheckResult =
  | { ok: true; tombstoneFound: boolean }
  | { ok: false; shouldRetry: boolean; error: EnhancedError };

type ConnectionTombstoneQueryResult = {
  tombstoneFound: boolean;
  error: EnhancedError | null;
};

type ConnectionIdTombstoneRow = {
  connection_id: string;
  deleted_at?: string | null;
};

type ConnectionTombstonePageRow = {
  connection_id: string;
  deleted_at: string;
};

type ConnectionTombstonePageCursor = {
  connectionId: string;
  deletedAt: string;
};

function buildConnectionTombstoneKeysetOrFilter(
  cursor: ConnectionTombstonePageCursor,
): string {
  return `deleted_at.gt.${cursor.deletedAt},and(deleted_at.eq.${cursor.deletedAt},connection_id.gt.${cursor.connectionId})`;
}

function readConnectionTombstonePageCursor(
  row: ConnectionTombstonePageRow,
): ConnectionTombstonePageCursor {
  if (
    !isValidUUID(row.connection_id)
    || typeof row.deleted_at !== 'string'
    || !Number.isFinite(Date.parse(row.deleted_at))
  ) {
    throw new Error('connection tombstone page returned an invalid keyset cursor');
  }

  return {
    connectionId: row.connection_id,
    deletedAt: row.deleted_at,
  };
}

@Injectable({ providedIn: 'root' })
export class ConnectionTombstoneLookupService {
  private readonly logger = inject(LoggerService).category('ConnectionSyncOps');
  private readonly retryQueueService = inject(RetryQueueService);
  private readonly sessionManager = inject(SessionManagerService);
  private readonly tombstoneService = inject(TombstoneService);

  async checkConnectionTombstone(
    client: SupabaseClient,
    projectId: string,
    connection: Connection,
    fromRetryQueue: boolean,
    replayFence?: ConnectionActionQueueReplayFence,
  ): Promise<ConnectionTombstoneCheckResult> {
    assertConnectionReplayFenceCurrent(replayFence);
    let queryResult = await this.queryConnectionTombstone(client, projectId, connection, replayFence);
    assertConnectionReplayFenceCurrent(replayFence);
    let retriedAfterRefresh = false;

    if (!replayFence && queryResult.error && this.sessionManager.isSessionExpiredError(queryResult.error)) {
      const refreshed = await this.sessionManager.handleAuthErrorWithRefresh('pushConnection.connectionTombstoneLookup', {
        connectionId: connection.id,
        projectId,
        errorCode: queryResult.error.code,
      });
      if (refreshed) {
        retriedAfterRefresh = true;
        queryResult = await this.queryConnectionTombstone(client, projectId, connection);
      }
    }

    if (queryResult.error) {
      if (retriedAfterRefresh && this.sessionManager.isRlsPolicyViolation(queryResult.error)) {
        this.logger.info('刷新会话后 connection tombstone 查询仍无权限，停止重放陈旧连接', {
          connectionId: connection.id,
          projectId,
          errorCode: queryResult.error.code,
        });
        return { ok: false, shouldRetry: false, error: queryResult.error };
      }

      const logLevel: 'debug' | 'warn' = fromRetryQueue ? 'debug' : 'warn';
      this.logger[logLevel]('connection tombstone 查询失败，停止本次连接推送', {
        connectionId: connection.id,
        projectId,
        errorCode: queryResult.error.code,
        errorType: queryResult.error.errorType,
        message: queryResult.error.message,
        retriedAfterRefresh,
      });
      if (!replayFence) this.recordRetryableConnectionFailure(queryResult.error);
      return { ok: false, shouldRetry: true, error: queryResult.error };
    }

    return { ok: true, tombstoneFound: queryResult.tombstoneFound };
  }

  async getConnectionTombstoneIds(
    projectId: string,
    getClient: () => SupabaseClient | null,
  ): Promise<Set<string>> {
    const cached = this.tombstoneService.getConnectionTombstoneCache(projectId);
    if (cached) {
      return cached;
    }

    const tombstoneIds = new Set<string>();

    if (isBrowserNetworkSuspendedWindow()) {
      this.logger.debug('浏览器网络挂起，返回本地连接 tombstone 缓存', { projectId });
      return tombstoneIds;
    }

    const client = getClient();
    if (!client) {
      this.logger.info('getConnectionTombstoneIds: 离线模式，返回空集', { projectId });
      return tombstoneIds;
    }

    return await this.queryConnectionTombstoneIds(client, projectId, tombstoneIds);
  }

  private async queryConnectionTombstoneIds(
    client: SupabaseClient,
    projectId: string,
    tombstoneIds: Set<string>,
  ): Promise<Set<string>> {
    try {
      const { data, error } = await fetchAllSupabaseKeysetPagesByCursor<
        ConnectionTombstonePageRow,
        ConnectionTombstonePageCursor
      >((cursor) => {
        let query = client
          .from('connection_tombstones')
          .select('connection_id,deleted_at')
          .eq('project_id', projectId)
          .order('deleted_at', { ascending: true })
          .order('connection_id', { ascending: true });

        if (cursor) {
          query = query.or(buildConnectionTombstoneKeysetOrFilter(cursor));
        }

        return query;
      }, {
        readCursor: readConnectionTombstonePageCursor,
        cursorKey: (cursor) => `${cursor.deletedAt}:${cursor.connectionId}`,
        isCursorAfter: (previous, next) => next.deletedAt > previous.deletedAt || (next.deletedAt === previous.deletedAt && next.connectionId > previous.connectionId),
      });

      if (error) {
        return this.handleConnectionTombstoneIdsError(projectId, tombstoneIds, error);
      }

      this.cacheConnectionTombstoneIds(projectId, tombstoneIds, data ?? []);
      return tombstoneIds;
    } catch (error) {
      return this.handleConnectionTombstoneIdsException(projectId, tombstoneIds, error);
    }
  }

  private cacheConnectionTombstoneIds(
    projectId: string,
    tombstoneIds: Set<string>,
    rows: Array<{ connection_id: string }>,
  ): void {
    for (const tombstone of rows) {
      tombstoneIds.add(tombstone.connection_id);
    }

    this.tombstoneService.updateConnectionTombstoneCache(projectId, tombstoneIds);

    if (tombstoneIds.size > 0) {
      this.logger.debug('getConnectionTombstoneIds: 获取完成', {
        projectId,
        count: tombstoneIds.size,
      });
    }
  }

  private handleConnectionTombstoneIdsError(
    projectId: string,
    tombstoneIds: Set<string>,
    error: unknown,
  ): Set<string> {
    if (isBrowserNetworkSuspendedError(error) || isBrowserNetworkSuspendedWindow()) {
      this.logger.debug('浏览器网络挂起，返回本地连接 tombstone 缓存', { projectId });
      return tombstoneIds;
    }

    this.logger.warn('获取连接 tombstones 失败', error);
    return tombstoneIds;
  }

  private handleConnectionTombstoneIdsException(
    projectId: string,
    tombstoneIds: Set<string>,
    error: unknown,
  ): Set<string> {
    if (isBrowserNetworkSuspendedError(error) || isBrowserNetworkSuspendedWindow()) {
      this.logger.debug('浏览器网络挂起，返回本地连接 tombstone 缓存', { projectId });
      return tombstoneIds;
    }

    this.logger.warn('获取连接 tombstones 异常', error);
    return tombstoneIds;
  }

  private async queryConnectionTombstone(
    client: SupabaseClient,
    projectId: string,
    connection: Connection,
    replayFence?: ConnectionActionQueueReplayFence,
  ): Promise<ConnectionTombstoneQueryResult> {
    try {
      assertConnectionReplayFenceCurrent(replayFence);
      const localFreshnessTimestamp = getConnectionFreshnessTimestamp(connection.updatedAt, connection.deletedAt);
      const idResult = await this.queryConnectionIdTombstone(
        client, connection.id, localFreshnessTimestamp, replayFence,
      );
      assertConnectionReplayFenceCurrent(replayFence);
      if (idResult.error || idResult.tombstoneFound) return idResult;

      const endpointResult = await this.queryEndpointConnectionTombstone(
        client,
        projectId,
        connection,
        localFreshnessTimestamp,
        replayFence,
      );
      assertConnectionReplayFenceCurrent(replayFence);
      if (endpointResult.error || endpointResult.tombstoneFound) return endpointResult;

      const legacy = await this.queryLegacyEndpointlessConnectionTombstone(
        client, projectId, localFreshnessTimestamp, replayFence,
      );
      assertConnectionReplayFenceCurrent(replayFence);
      return legacy;
    } catch (error) {
      return { tombstoneFound: false, error: supabaseErrorToError(error) };
    }
  }

  private async queryConnectionIdTombstone(
    client: SupabaseClient,
    connectionId: string,
    localFreshnessTimestamp: number,
    replayFence?: ConnectionActionQueueReplayFence,
  ): Promise<ConnectionTombstoneQueryResult> {
    assertConnectionReplayFenceCurrent(replayFence);
    const { data, error } = await client
      .from('connection_tombstones')
      .select('connection_id,deleted_at')
      .eq('connection_id', connectionId)
      .maybeSingle() as { data: ConnectionIdTombstoneRow | null; error: unknown };
    assertConnectionReplayFenceCurrent(replayFence);

    if (error) {
      return { tombstoneFound: false, error: supabaseErrorToError(error) };
    }

    if (!data) {
      return { tombstoneFound: false, error: null };
    }

    if (!Object.prototype.hasOwnProperty.call(data, 'deleted_at')) {
      return { tombstoneFound: true, error: null };
    }

    return {
      tombstoneFound: isRemoteTombstoneAtLeastAsFresh(data.deleted_at, localFreshnessTimestamp),
      error: null,
    };
  }

  private async queryEndpointConnectionTombstone(
    client: SupabaseClient,
    projectId: string,
    connection: Connection,
    localFreshnessTimestamp: number,
    replayFence?: ConnectionActionQueueReplayFence,
  ): Promise<ConnectionTombstoneQueryResult> {
    assertConnectionReplayFenceCurrent(replayFence);
    const { data, error } = await client
      .from('connection_tombstones')
      .select('deleted_at')
      .eq('project_id', projectId)
      .eq('source_id', connection.source)
      .eq('target_id', connection.target)
      .order('deleted_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    assertConnectionReplayFenceCurrent(replayFence);

    if (error) {
      return { tombstoneFound: false, error: supabaseErrorToError(error) };
    }

    return {
      tombstoneFound: isRemoteTombstoneAtLeastAsFresh(data?.deleted_at, localFreshnessTimestamp),
      error: null,
    };
  }

  private async queryLegacyEndpointlessConnectionTombstone(
    client: SupabaseClient,
    projectId: string,
    localFreshnessTimestamp: number,
    replayFence?: ConnectionActionQueueReplayFence,
  ): Promise<ConnectionTombstoneQueryResult> {
    assertConnectionReplayFenceCurrent(replayFence);
    const { data, error } = await client
      .from('connection_tombstones')
      .select('deleted_at')
      .eq('project_id', projectId)
      .is('source_id', null)
      .is('target_id', null)
      .order('deleted_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    assertConnectionReplayFenceCurrent(replayFence);

    if (error) {
      return { tombstoneFound: false, error: supabaseErrorToError(error) };
    }

    return {
      tombstoneFound: isRemoteTombstoneAtLeastAsFresh(data?.deleted_at, localFreshnessTimestamp),
      error: null,
    };
  }

  private recordRetryableConnectionFailure(error?: EnhancedError): void {
    if (!error?.isRetryable) {
      return;
    }

    this.retryQueueService.recordCircuitFailure(error.errorType);
  }
}
