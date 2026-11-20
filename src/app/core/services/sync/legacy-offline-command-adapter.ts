import type { RetryQueueItem } from './retry-queue.types';
import type { SyncRpcResult } from '../../../../services/sync-rpc-client.service';
import type { QueuedAction } from '../../../../services/action-queue.types';
import {
  createOfflineSyncCommand,
  type HybridLogicalClock,
  type JsonObject,
  type JsonValue,
  type OfflineSyncCommandEnvelope,
  type OfflineSyncCommandStatus,
  type OfflineSyncEntityType,
  type OfflineSyncCommandKind,
  type OfflineSyncCommandRemoteResult,
} from '../../../../services/sync/offline-sync-command-envelope';

export interface LegacyOfflineCommandAdapterContext {
  readonly ownerUserId: string;
  readonly installationId: string;
  readonly deviceId: string;
  readonly previousLogicalClock?: HybridLogicalClock;
  readonly nowMs?: number;
}

export interface LegacyOfflineCommandAdapterResult {
  readonly source: 'retry-queue' | 'action-queue';
  readonly command: OfflineSyncCommandEnvelope;
}

export function retryQueueItemToOfflineCommand(
  item: RetryQueueItem,
  context: LegacyOfflineCommandAdapterContext,
): LegacyOfflineCommandAdapterResult {
  const entityType = mapRetryEntityType(item.type);
  const entityId = readEntityId(item.data);
  // RetryQueue uses the transport-neutral 'upsert' verb; the command registry uses explicit domain intents.
  const command = buildCommandKind(entityType, item.operation === 'upsert' ? 'update' : 'delete');
  const sourceUserId = item.sourceUserId ?? context.ownerUserId;
  const baseUpdatedAt = readBaseUpdatedAt(item);
  const status = item.lastFailure?.remoteOutcome === 'unknown' ? 'unknown' : 'pending';
  return {
    source: 'retry-queue',
    command: createOfflineSyncCommand({
      ...context,
      ownerUserId: sourceUserId,
      entityType,
      entityId,
      command,
      intent: {
        source: 'retry-queue',
        operation: item.operation,
        ...(item.writeIntent === undefined ? {} : { writeIntent: item.writeIntent }),
        ...(item.taskIdsToDelete === undefined ? {} : { taskIdsToDelete: item.taskIdsToDelete }),
      },
      normalizedResultPatch: item.operation === 'delete'
        ? { deleted: true }
        : toJsonObject(item.data),
      projectId: item.projectId,
      baseUpdatedAt,
      operationId: item.operationId,
      idempotencyKey: item.operationId,
      status,
      nowMs: context.nowMs ?? item.createdAt,
    }),
  };
}

export function queuedActionToOfflineCommand(
  action: QueuedAction,
  context: LegacyOfflineCommandAdapterContext,
): LegacyOfflineCommandAdapterResult {
  const entityType = mapActionEntityType(action.entityType);
  if (typeof action.entityId !== 'string' || action.entityId.length === 0) {
    throw new Error('ActionQueue action is missing an entity id');
  }
  const payload = toJsonObject(action.payload);
  const sourceUserId = readSourceUserId(action.payload) ?? context.ownerUserId;
  return {
    source: 'action-queue',
    command: createOfflineSyncCommand({
      ...context,
      ownerUserId: sourceUserId,
      entityType,
      entityId: action.entityId,
      command: buildCommandKind(entityType, action.type),
      intent: {
        source: 'action-queue',
        operationType: action.type,
        ...(action.syncState === undefined ? {} : { syncState: action.syncState }),
        ...(action.priority === undefined ? {} : { priority: action.priority }),
        ...(readPayloadString(payload, 'writeIntent') === undefined ? {} : { writeIntent: readPayloadString(payload, 'writeIntent')! }),
        ...(readPayloadStringArray(payload, 'fields') === undefined ? {} : { fields: readPayloadStringArray(payload, 'fields')! }),
      },
      normalizedResultPatch: payload,
      projectId: readActionProjectId(payload),
      baseUpdatedAt: readActionBaseUpdatedAt(payload),
      operationId: action.operationId,
      idempotencyKey: action.operationId,
      status: queuedActionStatus(action),
      nowMs: action.localCommittedAt ?? action.timestamp,
    }),
  };
}

export function applySyncRpcResultToOfflineCommand(
  command: OfflineSyncCommandEnvelope,
  result: SyncRpcResult,
): OfflineSyncCommandEnvelope {
  const remoteResult: OfflineSyncCommandRemoteResult = {
    ...(result.decision === undefined ? {} : { decision: result.decision }),
    ...(result.serverUpdatedAt === undefined ? {} : { acknowledgedAtIso: result.serverUpdatedAt }),
    ...(result.raw === undefined ? {} : { rawResponse: toJsonValue(result.raw) }),
  };
  return {
    ...command,
    status: statusFromSyncRpcResult(result),
    remoteResult,
  };
}

export function statusFromSyncRpcResult(result: SyncRpcResult): OfflineSyncCommandStatus {
  return result.status === 'applied' || result.status === 'idempotent-replay'
    ? 'acked'
    : 'rejected';
}

function mapRetryEntityType(type: RetryQueueItem['type']): OfflineSyncEntityType {
  return type === 'blackbox' ? 'black_box_entry' : type;
}

function mapActionEntityType(type: QueuedAction['entityType']): OfflineSyncEntityType {
  switch (type) {
    case 'focus-session': return 'focus_session';
    case 'routine-task': return 'routine_task';
    case 'routine-completion': return 'routine_completion';
    default: return type;
  }
}

function buildCommandKind(
  entityType: OfflineSyncEntityType,
  operation: string,
): OfflineSyncCommandKind {
  return `${entityType}.${operation}`;
}

function queuedActionStatus(action: QueuedAction): OfflineSyncCommandStatus {
  if (action.errorType === 'unknown' || action.errorType === 'timeout') return 'unknown';
  if (action.errorType === 'business' || action.errorType === 'permission') return 'rejected';
  if (action.syncState === 'synced') return 'acked';
  if (action.syncState === 'syncing') return 'sent';
  return 'pending';
}

function readEntityId(data: RetryQueueItem['data']): string {
  if (typeof data === 'object' && data !== null && 'id' in data && typeof data.id === 'string') {
    return data.id;
  }
  throw new Error('RetryQueue item is missing an entity id');
}

function readBaseUpdatedAt(item: RetryQueueItem): string | null | undefined {
  if (item.type === 'task' && item.operation === 'delete') {
    const data = item.data as { baseUpdatedAt?: string | null };
    return data.baseUpdatedAt;
  }
  if (typeof item.data === 'object' && item.data !== null && 'updatedAt' in item.data) {
    const updatedAt = item.data.updatedAt;
    return typeof updatedAt === 'string' ? updatedAt : undefined;
  }
  return undefined;
}

function readActionProjectId(payload: JsonObject): string | undefined {
  const topLevel = readPayloadString(payload, 'projectId') ?? readPayloadString(payload, 'project_id');
  if (topLevel) return topLevel;
  for (const key of ['task', 'project', 'connection', 'entry']) {
    const nested = payload[key];
    if (isJsonObject(nested)) {
      const nestedId = readPayloadString(nested, 'projectId') ?? readPayloadString(nested, 'project_id');
      if (nestedId) return nestedId;
    }
  }
  return undefined;
}

function readActionBaseUpdatedAt(payload: JsonObject): string | null | undefined {
  if (Object.prototype.hasOwnProperty.call(payload, 'baseUpdatedAt')) {
    const value = payload['baseUpdatedAt'];
    return typeof value === 'string' ? value : value === null ? null : undefined;
  }
  for (const key of ['task', 'project', 'connection', 'entry']) {
    const nested = payload[key];
    if (isJsonObject(nested) && typeof nested['updatedAt'] === 'string') return nested['updatedAt'];
  }
  return typeof payload['updatedAt'] === 'string' ? payload['updatedAt'] : undefined;
}

function readPayloadString(payload: JsonObject, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' ? value : undefined;
}

function readPayloadStringArray(payload: JsonObject, key: string): string[] | undefined {
  const value = payload[key];
  return Array.isArray(value) && value.every(item => typeof item === 'string') ? value : undefined;
}

function readSourceUserId(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('sourceUserId' in value)) return undefined;
  const sourceUserId = value.sourceUserId;
  return typeof sourceUserId === 'string' ? sourceUserId : undefined;
}

function toJsonObject(value: unknown): JsonObject {
  const json = toJsonValue(value);
  return isJsonObject(json) ? json : { value: json };
}

function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, toJsonValue(nested)]));
  }
  return String(value);
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}