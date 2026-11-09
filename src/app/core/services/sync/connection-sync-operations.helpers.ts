import type { Connection, Project } from '../../../../models';
import { AUTH_CONFIG } from '../../../../config/auth.config';
import { resolveRemoteVersionConflictEvidence } from '../../../../services/action-queue-operation-conflict.helpers';
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
import type { SyncResponseVersionSnapshot } from './sync-response-version-guard';
import type { RetryQueueLastFailure } from './retry-queue.types';

export type ConnectionActionQueueReplayFence = {
  actionId: string;
  actionOperationId: string;
  ownerUserId: string;
  projectId: string;
  connectionId: string;
  durableConnection: Connection;
  payloadSignature: string;
  leaseSignal: AbortSignal;
  isCurrent: () => boolean;
};

export type ConnectionActionQueueReplayInput = {
  actionId: string;
  actionOperationId: string;
  connection: Connection;
  projectId: string;
  sourceUserId: string;
  leaseSignal: AbortSignal;
  isFenceCurrent: () => boolean;
};

export type ConnectionActionQueueReplayResult = {
  outcome: 'applied' | 'handoff' | 'deferred';
} | {
  outcome: 'conflict';
  error: unknown;
};

export type ConnectionActionQueueReplayExecution = {
  pushed: boolean;
  handoff: boolean;
};

export function createConnectionActionQueuePushRequest(
  connection: Connection,
  replayFence: ConnectionActionQueueReplayFence,
) {
  return {
    connection,
    projectId: replayFence.projectId,
    skipTombstoneCheck: false,
    skipTaskExistenceCheck: false,
    fromRetryQueue: false,
    sourceUserId: replayFence.ownerUserId,
    operationId: replayFence.actionOperationId,
    requireSyncRpc: true,
    replayFence,
  };
}

export type ConnectionReplayRetryHandler = (
  connection: Connection,
  projectId: string,
  sourceUserId?: string,
  allowWhenSessionExpired?: boolean,
  operationId?: string,
  lastFailure?: RetryQueueLastFailure,
) => Promise<boolean>;

export function createConnectionReplayRetryHandler(options: {
  request: { replayFence?: ConnectionActionQueueReplayFence; replayHandoff?: boolean };
  enqueueRetry: ConnectionReplayRetryHandler;
  enqueueFromActionQueue: (
    fence: ConnectionActionQueueReplayFence,
  ) => Promise<{ status: 'current' | 'committed' | 'deferred' }>;
}): ConnectionReplayRetryHandler {
  return async (
    connection,
    projectId,
    sourceUserId,
    allowWhenSessionExpired = false,
    operationId,
    lastFailure,
  ) => {
    const fence = options.request.replayFence;
    if (!fence) {
      return await options.enqueueRetry(
        connection, projectId, sourceUserId, allowWhenSessionExpired, operationId, lastFailure,
      );
    }
    assertConnectionReplayFenceCurrent(fence);
    const result = await options.enqueueFromActionQueue(fence);
    assertConnectionReplayFenceCurrent(fence);
    options.request.replayHandoff = result.status === 'current' || result.status === 'committed';
    return options.request.replayHandoff;
  };
}

export async function runConnectionActionQueueReplay(
  input: ConnectionActionQueueReplayInput,
  execute: (
    connection: Connection,
    fence: ConnectionActionQueueReplayFence,
  ) => Promise<ConnectionActionQueueReplayExecution>,
): Promise<ConnectionActionQueueReplayResult> {
  const durableConnection = structuredClone(input.connection);
  const fence: ConnectionActionQueueReplayFence = {
    actionId: input.actionId,
    actionOperationId: input.actionOperationId,
    ownerUserId: input.sourceUserId,
    projectId: input.projectId,
    connectionId: durableConnection.id,
    durableConnection,
    payloadSignature: buildConnectionReplayPayloadSignature(
      durableConnection,
      input.projectId,
      input.sourceUserId,
    ),
    leaseSignal: input.leaseSignal,
    isCurrent: input.isFenceCurrent,
  };
  if (!isConnectionReplayFenceCurrent(fence)) return { outcome: 'deferred' };
  try {
    const result = await execute(structuredClone(durableConnection), fence);
    assertConnectionReplayFenceCurrent(fence);
    return result.pushed
      ? { outcome: 'applied' }
      : { outcome: result.handoff ? 'handoff' : 'deferred' };
  } catch (error) {
    if (!isConnectionReplayFenceCurrent(fence)) return { outcome: 'deferred' };
    return resolveRemoteVersionConflictEvidence(error, [
      'CONNECTION_REMOTE_NEWER', 'CONNECTION_REMOTE_TOMBSTONE_NEWER',
    ]) ? { outcome: 'conflict', error } : { outcome: 'deferred' };
  }
}

export function buildConnectionReplayPayloadSignature(
  connection: unknown,
  projectId: unknown,
  sourceUserId: unknown,
): string {
  return JSON.stringify(canonicalizeConnectionReplayValue({
    connection,
    projectId: typeof projectId === 'string' ? projectId : null,
    sourceUserId: typeof sourceUserId === 'string' ? sourceUserId : null,
  }));
}

export function isConnectionReplayFenceCurrent(
  fence: ConnectionActionQueueReplayFence | undefined,
): boolean {
  return fence !== undefined
    && !fence.leaseSignal.aborted
    && fence.actionId.length > 0
    && fence.actionOperationId.length > 0
    && fence.ownerUserId.length > 0
    && fence.projectId.length > 0
    && fence.connectionId === fence.durableConnection.id
    && fence.payloadSignature === buildConnectionReplayPayloadSignature(
      fence.durableConnection,
      fence.projectId,
      fence.ownerUserId,
    )
    && fence.isCurrent();
}

export function assertConnectionReplayFenceCurrent(
  fence: ConnectionActionQueueReplayFence | undefined,
): void {
  if (fence !== undefined && !isConnectionReplayFenceCurrent(fence)) {
    throw new Error('connection-action-queue-replay-fence-lost');
  }
}

export function combineConnectionReplayAbortSignals(
  throttleSignal: AbortSignal | undefined,
  leaseSignal: AbortSignal | undefined,
): { signal: AbortSignal | undefined; dispose: () => void } {
  if (!throttleSignal || !leaseSignal || throttleSignal === leaseSignal) {
    return { signal: throttleSignal ?? leaseSignal, dispose: () => undefined };
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  throttleSignal.addEventListener('abort', abort, { once: true });
  leaseSignal.addEventListener('abort', abort, { once: true });
  if (throttleSignal.aborted || leaseSignal.aborted) abort();
  return {
    signal: controller.signal,
    dispose: () => {
      throttleSignal.removeEventListener('abort', abort);
      leaseSignal.removeEventListener('abort', abort);
    },
  };
}

function canonicalizeConnectionReplayValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(item => canonicalizeConnectionReplayValue(item));
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort((left, right) => left.localeCompare(right))
      .map(key => [key, canonicalizeConnectionReplayValue(record[key])]),
  );
}

export {
  createRemoteNewerConflictError as createConnectionRestRemoteNewerConflict,
} from './connection-sync-conflict.helpers';

export type ConnectionPushExecutionResult = {
  pushed: boolean;
  blockedBySyncRpc: boolean;
  persistedUpdatedAt: string | null;
  requestVersion?: SyncResponseVersionSnapshot;
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
  projectState: Pick<ProjectStateService, 'getProjectWithCurrentData'>;
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
    requestVersion?: SyncResponseVersionSnapshot,
  ) => void;
  requestVersion?: SyncResponseVersionSnapshot;
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

export function createConnectionSyncRpcExecutionResult(
  pushed: boolean,
): ConnectionPushExecutionResult {
  return {
    pushed,
    blockedBySyncRpc: !pushed,
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
        if (options.requestVersion === undefined) {
          options.normalizeLocalConnectionUpdatedAt(projectId, connection, serverUpdatedAt);
          return;
        }

        options.normalizeLocalConnectionUpdatedAt(
          projectId,
          connection,
          serverUpdatedAt,
          options.requestVersion,
        );
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
  projectState: Pick<ProjectStateService, 'getProjectWithCurrentData'>,
  projectId: string,
  connection: Connection,
): Project {
  const currentProject = projectState.getProjectWithCurrentData(projectId);
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
