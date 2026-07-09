import type { Connection, Project } from '../../../../models';
import { AUTH_CONFIG } from '../../../../config/auth.config';
import type { resolveRemoteVersionConflictEvidence } from '../../../../services/action-queue-operation-conflict.helpers';
import type { ConflictStorageService } from '../../../../services/conflict-storage.service';
import type { ProjectStateService } from '../../../../services/project-state.service';
import type {
  SyncRpcClientService,
  SyncRpcResult,
} from '../../../../services/sync-rpc-client.service';
import {
  EnhancedError,
  supabaseErrorToError,
} from '../../../../utils/supabase-error';
import { createSyncOperationId } from '../../../../utils/sync-operation-id';
import type {
  ConnectionRpcDiscardInvalidHandler,
  ConnectionRpcNormalizeUpdatedAtHandler,
  ConnectionRpcRetryEnqueueHandler,
} from './connection-sync-rpc-result-handler.service';

export {
  createRemoteNewerConflictError as createConnectionRestRemoteNewerConflict,
} from './connection-sync-conflict.helpers';

export type ConnectionPushExecutionResult = {
  pushed: boolean;
  blockedBySyncRpc: boolean;
  persistedUpdatedAt: string | null;
};

export type ConnectionRemoteConflict = {
  reason: 'remote-newer' | 'remote-tombstone';
  remoteUpdatedAt: string | null;
};

export type ConnectionRpcWriteAudit = {
  operationId: string;
  sourceUserId: string | undefined;
  connection: Connection;
  result: SyncRpcResult;
  localTimestamp: number;
  beforeVersion: string | null;
  enteredRetryQueue: boolean;
  retryCount: number;
  lastSyncTimeBefore: string | null;
};

type ConnectionRpcReplayConflictEvidence = NonNullable<ReturnType<typeof resolveRemoteVersionConflictEvidence>>;

type ConnectionRpcReplayConflictInput = {
  connection: Connection;
  projectId: string;
  sourceUserId: string | undefined;
  operationId: string;
  result: SyncRpcResult;
};

type ConnectionRpcReplayConflictLogger = {
  error(message: string, context: Record<string, unknown>): void;
};

type PersistConnectionRpcReplayConflictOptions = {
  input: ConnectionRpcReplayConflictInput;
  evidence: ConnectionRpcReplayConflictEvidence;
  conflictStorage: Pick<ConflictStorageService, 'saveConflict'>;
  projectState: Pick<ProjectStateService, 'getProject'>;
  logger: ConnectionRpcReplayConflictLogger;
};

export type ConnectionRpcResultHandlers = {
  normalizeUpdatedAt: ConnectionRpcNormalizeUpdatedAtHandler;
  discardInvalid: ConnectionRpcDiscardInvalidHandler;
  enqueueRetry: ConnectionRpcRetryEnqueueHandler;
};

export type CreateConnectionSyncRpcResultHandlersOptions = {
  operationId: string;
  audit: ConnectionRpcWriteAudit;
  normalizeLocalConnectionUpdatedAt: (
    projectId: string,
    connection: Connection,
    serverUpdatedAt: string,
  ) => void;
  discardInvalidConnectionLocally: ConnectionRpcDiscardInvalidHandler;
  enqueueConnectionRetry: (
    connection: Connection,
    projectId: string,
    sourceUserId: string | undefined,
    allowWhenSessionExpired: boolean,
    operationId: string,
  ) => Promise<boolean>;
};

export function createPendingConnectionPushExecutionResult(): ConnectionPushExecutionResult {
  return {
    pushed: false,
    blockedBySyncRpc: false,
    persistedUpdatedAt: null,
  };
}

export function shouldUseConnectionSyncRpc(syncRpcClient: SyncRpcClientService | null | undefined): boolean {
  return syncRpcClient?.isFeatureEnabled() === true && syncRpcClient.isClientRejected() === false;
}

export function createConnectionSyncRpcOperationId(): string {
  return createSyncOperationId();
}

export function createConnectionRpcWriteAudit(input: {
  operationId: string;
  sourceUserId: string | undefined;
  connection: Connection;
  result: SyncRpcResult;
  beforeVersion: string | null;
  lastSyncTimeBefore: string | null;
}): ConnectionRpcWriteAudit {
  return {
    operationId: input.operationId,
    sourceUserId: input.sourceUserId,
    connection: input.connection,
    result: input.result,
    localTimestamp: Date.now(),
    beforeVersion: input.beforeVersion,
    enteredRetryQueue: false,
    retryCount: 0,
    lastSyncTimeBefore: input.lastSyncTimeBefore,
  };
}

export function createConnectionSyncRpcResultHandlers(
  options: CreateConnectionSyncRpcResultHandlersOptions,
): ConnectionRpcResultHandlers {
  return {
    normalizeUpdatedAt: (projectId, connection, serverUpdatedAt) => {
      if (serverUpdatedAt) {
        options.normalizeLocalConnectionUpdatedAt(projectId, connection, serverUpdatedAt);
      }
    },
    discardInvalid: (connection, projectId, reason) => {
      options.discardInvalidConnectionLocally(connection, projectId, reason);
    },
    enqueueRetry: async (connection, projectId, sourceUserId) => {
      const enteredRetryQueue = await options.enqueueConnectionRetry(
        connection,
        projectId,
        sourceUserId,
        false,
        options.operationId,
      );
      options.audit.enteredRetryQueue = enteredRetryQueue;
      options.audit.retryCount = enteredRetryQueue ? 1 : 0;
      return enteredRetryQueue;
    },
  };
}

export function ensureEnhancedConnectionSyncError(error: unknown): EnhancedError {
  if (
    error instanceof Error
    && 'isRetryable' in error
    && 'errorType' in error
  ) {
    return error as EnhancedError;
  }

  return supabaseErrorToError(error);
}

export async function persistConnectionRpcReplayConflict(
  options: PersistConnectionRpcReplayConflictOptions,
): Promise<boolean> {
  const { input, evidence } = options;
  const conflictedAt = new Date().toISOString();
  const localProject = buildConnectionConflictProject(options.projectState, input.projectId, input.connection);
  const ownerUserId = input.sourceUserId ?? AUTH_CONFIG.LOCAL_MODE_USER_ID;
  const details = evidence.details ?? {
    connectionId: input.connection.id,
    projectId: input.projectId,
    remoteUpdatedAt: input.result.remoteUpdatedAt ?? null,
    reason: input.result.reason ?? evidence.reason,
  };

  return await options.conflictStorage.saveConflict({
    projectId: input.projectId,
    ownerUserId,
    localProject,
    conflictedAt,
    localVersion: localProject.version ?? 0,
    reason: 'version_mismatch',
    acknowledged: false,
    operationConflicts: [{
      actionType: input.connection.deletedAt ? 'connection:delete' : 'connection:update',
      entityType: 'connection',
      entityId: input.connection.id,
      projectId: input.projectId,
      operationId: input.operationId,
      localEntity: input.connection,
      remoteEntity: evidence.remoteEntity,
      code: evidence.code,
      message: evidence.message,
      details,
      conflictedAt,
      reason: evidence.reason,
    }],
  }).catch((saveError: unknown) => {
    options.logger.error('connection RPC 冲突证据保存异常', {
      error: saveError,
      connectionId: input.connection.id,
      projectId: input.projectId,
      operationId: input.operationId,
    });
    return false;
  });
}

function buildConnectionConflictProject(
  projectState: Pick<ProjectStateService, 'getProject'>,
  projectId: string,
  connection: Connection,
): Project {
  const currentProject = projectState.getProject(projectId);
  if (currentProject) {
    return {
      ...currentProject,
      tasks: currentProject.tasks ?? [],
      connections: upsertConnectionConflictSnapshot(currentProject.connections ?? [], connection),
    };
  }

  const now = connection.updatedAt ?? new Date().toISOString();
  return {
    id: projectId,
    name: '',
    description: '',
    createdDate: now,
    updatedAt: now,
    version: 0,
    tasks: [],
    connections: [connection],
  };
}

function upsertConnectionConflictSnapshot(
  connections: Connection[],
  localConnection: Connection,
): Connection[] {
  const existingIndex = connections.findIndex(connection => connection.id === localConnection.id);
  if (existingIndex < 0) {
    return [...connections, localConnection];
  }

  return connections.map(connection => connection.id === localConnection.id ? localConnection : connection);
}
