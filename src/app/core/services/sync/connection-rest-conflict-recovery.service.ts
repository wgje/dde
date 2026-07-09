import { Injectable, inject } from '@angular/core';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { Connection } from '../../../../models';
import { ClockSyncService } from '../../../../services/clock-sync.service';
import { LoggerService } from '../../../../services/logger.service';
import { ConnectionCanonicalIdentityService } from './connection-canonical-identity.service';
import { ConnectionCanonicalPrecheckService } from './connection-canonical-precheck.service';
import {
  createConnectionClockUncertainError,
  createRemoteNewerConflictError,
  isEndpointUniqueConnectionConflict,
} from './connection-sync-conflict.helpers';
import {
  ensureEnhancedConnectionSyncError,
  type ConnectionPushExecutionResult,
  type ConnectionRemoteConflict,
} from './connection-sync-operations.helpers';
import {
  ConnectionRestPersistenceService,
  type RemoteConnectionFreshness,
} from './connection-rest-persistence.service';

@Injectable({ providedIn: 'root' })
export class ConnectionRestConflictRecoveryService {
  private readonly canonicalIdentity = inject(ConnectionCanonicalIdentityService);
  private readonly canonicalPrecheck = inject(ConnectionCanonicalPrecheckService);
  private readonly clockSync = inject(ClockSyncService);
  private readonly connectionRestPersistence = inject(ConnectionRestPersistenceService);
  private readonly logger = inject(LoggerService).category('ConnectionSyncOps');

  async assertRemoteConnectionNotNewer(
    connection: Connection,
    projectId: string,
    remoteConnection: RemoteConnectionFreshness | null,
  ): Promise<void> {
    const conflict = await this.getRemoteConnectionConflict(connection, projectId, remoteConnection);
    if (!conflict) {
      return;
    }

    throw createRemoteNewerConflictError(
      connection.id,
      projectId,
      conflict.remoteUpdatedAt,
      conflict.reason,
    );
  }

  async recoverConnectionUpsertConflict(
    client: SupabaseClient,
    connection: Connection,
    projectId: string,
    upsertError: unknown,
  ): Promise<ConnectionPushExecutionResult> {
    const enhancedError = ensureEnhancedConnectionSyncError(upsertError);
    const code = enhancedError.code || (enhancedError as { code?: string }).code;

    if (isEndpointUniqueConnectionConflict(enhancedError, code)) {
      return await this.recoverEndpointUniqueConnectionConflict(client, connection, projectId);
    }

    if (code === '23505' || code === 23505) {
      throw createRemoteNewerConflictError(
        connection.id,
        projectId,
        connection.updatedAt ?? null,
        'remote-newer',
      );
    }

    throw enhancedError;
  }

  private async getRemoteConnectionConflict(
    connection: Connection,
    projectId: string,
    remoteConnection: RemoteConnectionFreshness | null,
  ): Promise<ConnectionRemoteConflict | null> {
    if (remoteConnection?.deleted_at && !connection.deletedAt) {
      return {
        reason: 'remote-tombstone',
        remoteUpdatedAt: remoteConnection.updated_at ?? remoteConnection.deleted_at,
      };
    }

    const remoteUpdatedAt = remoteConnection?.updated_at ?? null;
    const localUpdatedAt = connection.updatedAt ?? null;
    if (!remoteUpdatedAt || !localUpdatedAt) {
      return null;
    }

    return await this.getRemoteUpdatedAtConflict(connection, projectId, remoteUpdatedAt, localUpdatedAt);
  }

  private async getRemoteUpdatedAtConflict(
    connection: Connection,
    projectId: string,
    remoteUpdatedAt: string,
    localUpdatedAt: string,
  ): Promise<ConnectionRemoteConflict | null> {
    const rawRemoteMs = new Date(remoteUpdatedAt).getTime();
    const rawLocalMs = new Date(localUpdatedAt).getTime();
    const timestampsDiffer = Number.isFinite(rawRemoteMs)
      && Number.isFinite(rawLocalMs)
      && rawLocalMs !== rawRemoteMs;
    const clockSyncResult = timestampsDiffer
      ? await this.clockSync.ensureSynced().catch(() => null)
      : null;

    if (timestampsDiffer && !clockSyncResult?.reliable) {
      throw createConnectionClockUncertainError(connection.id, projectId, localUpdatedAt, remoteUpdatedAt);
    }

    const remoteIsNewer = clockSyncResult?.reliable
      ? this.clockSync.compareTimestamps(localUpdatedAt, remoteUpdatedAt) < 0
      : rawRemoteMs > rawLocalMs;

    return remoteIsNewer
      ? { reason: 'remote-newer', remoteUpdatedAt }
      : null;
  }

  private async recoverEndpointUniqueConnectionConflict(
    client: SupabaseClient,
    connection: Connection,
    projectId: string,
  ): Promise<ConnectionPushExecutionResult> {
    const racedCanonicalMatch = await this.canonicalPrecheck.lookupCanonicalEndpointMatch(client, projectId, connection);
    if (!racedCanonicalMatch) {
      const conflictRecoveryError = new Error('Unknown Supabase error: canonical connection lookup missed after 23505 conflict');
      conflictRecoveryError.name = 'UnknownServerError';
      throw conflictRecoveryError;
    }

    this.canonicalIdentity.applyCanonicalConnectionIdentity(projectId, connection, racedCanonicalMatch);
    const canonicalRemoteConnection = await this.connectionRestPersistence.loadRemoteConnectionFreshness(
      client,
      connection.id,
      projectId,
    );
    await this.assertRemoteConnectionNotNewer(connection, projectId, canonicalRemoteConnection);
    const persistedUpdatedAt = await this.connectionRestPersistence.upsertConnectionReturningUpdatedAt(
      client,
      connection,
      projectId,
      canonicalRemoteConnection,
      (connectionId, conflictProjectId, remoteUpdatedAt, reason) => createRemoteNewerConflictError(
        connectionId,
        conflictProjectId,
        remoteUpdatedAt,
        reason,
      ),
    );

    this.logger.info('连接已存在（幂等成功）', {
      connectionId: connection.id,
      source: connection.source,
      target: connection.target,
    });

    return {
      pushed: true,
      blockedBySyncRpc: false,
      persistedUpdatedAt,
    };
  }
}
