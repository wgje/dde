import type { Connection } from '../../../../models';
import type { EnhancedError } from '../../../../utils/supabase-error';
import type { EndpointConnectionMatch } from './connection-canonical-identity.service';

export type RemoteNewerConflictFactoryOptions = {
  localConnection?: Connection;
  remoteConnection?: Connection;
};

export function pickNewestDeletedEndpointMatch(
  matches: EndpointConnectionMatch[],
): EndpointConnectionMatch | null {
  const deletedMatches = matches.filter(match => !!match.deleted_at);
  if (deletedMatches.length === 0) {
    return null;
  }

  return deletedMatches.reduce((latest, current) => {
    const latestTimestamp = Math.max(toTimestamp(latest.updated_at), toTimestamp(latest.deleted_at));
    const currentTimestamp = Math.max(toTimestamp(current.updated_at), toTimestamp(current.deleted_at));
    return currentTimestamp >= latestTimestamp ? current : latest;
  });
}

export function isEndpointUniqueConnectionConflict(enhancedError: EnhancedError, code: unknown): boolean {
  return code === '23505'
    && (
      enhancedError.message?.includes('connections_project_id_source_id_target_id')
      || enhancedError.message?.includes('uq_connections_project_source_target_active')
    );
}

export function createRemoteNewerConflictError(
  connectionId: string,
  projectId: string,
  remoteUpdatedAt: string | null,
  reason: 'remote-newer' | 'remote-tombstone',
  options: RemoteNewerConflictFactoryOptions = {},
): EnhancedError {
  const details = {
    connectionId,
    projectId,
    remoteUpdatedAt,
    reason,
    ...(options.localConnection ? { localConnection: options.localConnection } : {}),
    ...(options.remoteConnection
      ? {
        remoteConnection: options.remoteConnection,
        remoteEntity: options.remoteConnection,
      }
      : {}),
  };

  return Object.assign(
    new Error('版本冲突：数据已被修改，请刷新后重试'),
    {
      name: 'VersionConflictError',
      errorType: 'VersionConflictError',
      code: reason === 'remote-tombstone' ? 'CONNECTION_REMOTE_TOMBSTONE_NEWER' : 'CONNECTION_REMOTE_NEWER',
      isRetryable: false,
      details,
    },
  ) as unknown as EnhancedError;
}

export function createConnectionClockUncertainError(
  connectionId: string,
  projectId: string,
  localUpdatedAt: string | null,
  remoteUpdatedAt: string | null,
): EnhancedError {
  return Object.assign(
    new Error('无法确认本地时间基线，已延后同步以避免覆盖远端更新'),
    {
      name: 'ClockSyncUncertainError',
      errorType: 'ClockSyncUncertainError',
      code: 'CONNECTION_CLOCK_SYNC_UNCERTAIN',
      isRetryable: true,
      details: `connectionId=${connectionId}, projectId=${projectId}, localUpdatedAt=${localUpdatedAt ?? 'unknown'}, remoteUpdatedAt=${remoteUpdatedAt ?? 'unknown'}`,
    },
  ) as EnhancedError;
}

function toTimestamp(value?: string | null): number {
  if (!value) {
    return 0;
  }

  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? 0 : timestamp;
}
