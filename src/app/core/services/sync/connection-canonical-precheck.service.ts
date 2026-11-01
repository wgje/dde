import { Injectable, inject } from '@angular/core';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { Connection } from '../../../../models';
import { LoggerService } from '../../../../services/logger.service';
import {
  ConnectionCanonicalIdentityService,
  type EndpointConnectionMatch,
} from './connection-canonical-identity.service';
import { pickNewestDeletedEndpointMatch } from './connection-sync-conflict.helpers';
import {
  assertConnectionReplayFenceCurrent,
  type ConnectionActionQueueReplayFence,
} from './connection-sync-operations.helpers';

@Injectable({ providedIn: 'root' })
export class ConnectionCanonicalPrecheckService {
  private readonly logger = inject(LoggerService).category('ConnectionSyncOps');
  private readonly canonicalIdentity = inject(ConnectionCanonicalIdentityService);

  async applyCanonicalEndpointPrecheck(
    client: SupabaseClient,
    projectId: string,
    connection: Connection,
    replayFence?: ConnectionActionQueueReplayFence,
  ): Promise<void> {
    assertConnectionReplayFenceCurrent(replayFence);
    const canonicalEndpointMatch = await this.lookupCanonicalEndpointMatch(
      client, projectId, connection, replayFence,
    );
    assertConnectionReplayFenceCurrent(replayFence);
    if (!canonicalEndpointMatch) {
      return;
    }

    if (canonicalEndpointMatch.id !== connection.id) {
      assertConnectionReplayFenceCurrent(replayFence);
      this.logger.info('检测到远端同端点连接，复用既有 id 继续同步', {
        connectionId: connection.id,
        existingConnectionId: canonicalEndpointMatch.id,
        projectId,
        source: connection.source,
        target: connection.target,
        remoteDeletedAt: canonicalEndpointMatch.deleted_at,
        localDeletedAt: connection.deletedAt,
      });
      this.canonicalIdentity.applyCanonicalConnectionIdentity(projectId, connection, canonicalEndpointMatch);
      return;
    }

    if (this.canonicalIdentity.isCanonicalMatchAtLeastAsFresh(canonicalEndpointMatch, connection)) {
      assertConnectionReplayFenceCurrent(replayFence);
      this.canonicalIdentity.applyCanonicalConnectionState(projectId, connection, canonicalEndpointMatch);
    }
  }

  async lookupCanonicalEndpointMatch(
    client: SupabaseClient,
    projectId: string,
    connection: Connection,
    replayFence?: ConnectionActionQueueReplayFence,
  ): Promise<EndpointConnectionMatch | null> {
    // canonical-match 查询是 upsert 前的软优化；网络/CORS 抛错时降级为未匹配，
    // 让 upsert 的唯一约束和后续 23505 分支继续兜底。
    let data: EndpointConnectionMatch[] | null = null;
    try {
      assertConnectionReplayFenceCurrent(replayFence);
      const response = await client
        .from('connections')
        .select('id,deleted_at,updated_at,title,description')
        .eq('project_id', projectId)
        .eq('source_id', connection.source)
        .eq('target_id', connection.target);
      assertConnectionReplayFenceCurrent(replayFence);

      if (response.error) {
        return null;
      }
      data = response.data as EndpointConnectionMatch[] | null;
    } catch {
      // eslint-disable-next-line no-restricted-syntax -- canonical 预检查是软优化；网络/CORS 异常必须降级为未匹配，让 upsert 兜底
      return null;
    }

    if (!Array.isArray(data) || data.length === 0) {
      return null;
    }

    const activeMatch = data.find(match => !match.deleted_at) ?? null;
    return activeMatch ?? pickNewestDeletedEndpointMatch(data);
  }
}
