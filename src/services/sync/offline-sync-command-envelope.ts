/**
 * Versioned offline-first command envelope primitives.
 *
 * This module is intentionally storage- and transport-agnostic. Existing
 * RetryQueue/ActionQueue paths can adapt into this envelope without changing
 * their current persistence or replay behavior.
 */

export const OFFLINE_SYNC_COMMAND_SCHEMA_VERSION = 1 as const;
export const OFFLINE_SYNC_QUARANTINE_SCHEMA_VERSION = 1 as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type OfflineSyncEntityType =
  | 'project'
  | 'task'
  | 'connection'
  | 'black_box_entry'
  | 'focus_routine'
  | 'attachment'
  | 'preference'
  | 'focus_session'
  | 'routine_task'
  | 'routine_completion';

export const OFFLINE_SYNC_COMMAND_KINDS = [
  'project.create',
  'project.update',
  'project.delete',
  'project.restore',
  'task.create',
  'task.update',
  'task.delete',
  'task.restore',
  'task.permanently_delete',
  'task.move',
  'task.reorder',
  'task.detach',
  'task.assign',
  'task.tags.update',
  'task.attachments.update',
  'task.parking_meta.update',
  'task.attention_items.update',
  'task.todo.update',
  'connection.create',
  'connection.update',
  'connection.delete',
  'connection.restore',
  'connection.reorder',
  'black_box_entry.create',
  'black_box_entry.update',
  'black_box_entry.delete',
  'focus_routine.update',
  'attachment.create',
  'attachment.update',
  'attachment.delete',
  'preference.create',
  'preference.update',
  'preference.delete',
  'focus_session.create',
  'focus_session.update',
  'focus_session.delete',
  'routine_task.create',
  'routine_task.update',
  'routine_task.delete',
  'routine_completion.create',
  'routine_completion.update',
] as const;

export type KnownOfflineSyncCommandKind = typeof OFFLINE_SYNC_COMMAND_KINDS[number];
/** Forward-compatible command names are accepted for capability-negotiated extensions. */
export type OfflineSyncCommandKind = KnownOfflineSyncCommandKind | (string & {});

export type OfflineSyncCommandStatus =
  | 'pending'
  | 'sent'
  | 'acked'
  | 'unknown'
  | 'superseded'
  | 'rejected';

export interface HybridLogicalClock {
  readonly physicalMs: number;
  readonly logical: number;
}

export interface OfflineSyncCommandRemoteResult {
  readonly decision?: string;
  readonly acknowledgedAtIso?: string;
  readonly rawResponse?: JsonValue;
}

export interface OfflineSyncCommandEnvelope {
  readonly schemaVersion: typeof OFFLINE_SYNC_COMMAND_SCHEMA_VERSION;
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly ownerUserId: string;
  readonly installationId: string;
  readonly deviceId: string;
  readonly logicalClock: HybridLogicalClock;
  readonly entityType: OfflineSyncEntityType;
  readonly entityId: string;
  readonly projectId?: string;
  readonly command: OfflineSyncCommandKind;
  readonly intent: JsonObject;
  readonly baseVersion?: number | null;
  readonly baseUpdatedAt?: string | null;
  readonly normalizedResultPatch: JsonObject;
  readonly dependencyOperationIds: readonly string[];
  readonly status: OfflineSyncCommandStatus;
  readonly createdAtIso: string;
  readonly remoteResult?: OfflineSyncCommandRemoteResult;
}

export interface CreateOfflineSyncCommandInput {
  readonly ownerUserId: string;
  readonly installationId: string;
  readonly deviceId: string;
  readonly entityType: OfflineSyncEntityType;
  readonly entityId: string;
  readonly command: OfflineSyncCommandKind;
  readonly intent: JsonObject;
  readonly normalizedResultPatch: JsonObject;
  readonly projectId?: string;
  readonly baseVersion?: number | null;
  readonly baseUpdatedAt?: string | null;
  readonly dependencyOperationIds?: readonly string[];
  readonly operationId?: string;
  readonly idempotencyKey?: string;
  readonly logicalClock?: HybridLogicalClock;
  readonly previousLogicalClock?: HybridLogicalClock;
  readonly nowMs?: number;
  readonly createdAtIso?: string;
  readonly status?: OfflineSyncCommandStatus;
}

export interface OfflineSyncQuarantineRecord {
  readonly schemaVersion: typeof OFFLINE_SYNC_QUARANTINE_SCHEMA_VERSION;
  readonly quarantineId: string;
  readonly ownerUserId?: string;
  readonly source: 'command-envelope' | 'legacy-queue' | 'snapshot' | 'unknown';
  readonly reason: string;
  readonly raw: JsonValue;
  readonly capturedAtIso: string;
}

export type OfflineSyncCommandParseResult =
  | { readonly kind: 'valid'; readonly value: OfflineSyncCommandEnvelope }
  | { readonly kind: 'quarantined'; readonly quarantine: OfflineSyncQuarantineRecord };

export function createClientUuid(): string {
  const randomUuid = globalThis.crypto?.randomUUID;
  if (typeof randomUuid !== 'function') {
    throw new Error('crypto.randomUUID is required for offline sync identities');
  }
  return randomUuid.call(globalThis.crypto);
}

export function createHybridLogicalClock(
  previous: HybridLogicalClock | undefined,
  nowMs = Date.now(),
): HybridLogicalClock {
  const physicalMs = Math.max(nowMs, previous?.physicalMs ?? 0);
  const logical = previous && physicalMs === previous.physicalMs
    ? previous.logical + 1
    : 0;
  return { physicalMs, logical };
}

export function observeHybridLogicalClock(
  previous: HybridLogicalClock | undefined,
  remote: HybridLogicalClock | undefined,
  nowMs = Date.now(),
): HybridLogicalClock {
  const physicalMs = Math.max(nowMs, previous?.physicalMs ?? 0, remote?.physicalMs ?? 0);
  const localAtPhysical = previous?.physicalMs === physicalMs ? previous.logical : -1;
  const remoteAtPhysical = remote?.physicalMs === physicalMs ? remote.logical : -1;
  if (localAtPhysical >= 0 && remoteAtPhysical >= 0) {
    return { physicalMs, logical: Math.max(localAtPhysical, remoteAtPhysical) + 1 };
  }
  if (localAtPhysical >= 0) return { physicalMs, logical: localAtPhysical + 1 };
  if (remoteAtPhysical >= 0) return { physicalMs, logical: remoteAtPhysical + 1 };
  return { physicalMs, logical: 0 };
}

export function compareHybridLogicalClock(
  left: HybridLogicalClock,
  right: HybridLogicalClock,
): number {
  if (left.physicalMs !== right.physicalMs) return left.physicalMs - right.physicalMs;
  return left.logical - right.logical;
}

export function compareOfflineSyncCommandOrder(
  left: Pick<OfflineSyncCommandEnvelope, 'logicalClock' | 'deviceId' | 'operationId'>,
  right: Pick<OfflineSyncCommandEnvelope, 'logicalClock' | 'deviceId' | 'operationId'>,
): number {
  const clockComparison = compareHybridLogicalClock(left.logicalClock, right.logicalClock);
  if (clockComparison !== 0) return clockComparison;
  const deviceComparison = left.deviceId.localeCompare(right.deviceId);
  return deviceComparison !== 0 ? deviceComparison : left.operationId.localeCompare(right.operationId);
}

export function createOfflineSyncCommand(
  input: CreateOfflineSyncCommandInput,
): OfflineSyncCommandEnvelope {
  const operationId = input.operationId ?? createClientUuid();
  const idempotencyKey = input.idempotencyKey ?? operationId;
  const nowMs = input.nowMs ?? Date.now();
  const createdAtIso = input.createdAtIso ?? new Date(nowMs).toISOString();
  const logicalClock = input.logicalClock
    ?? createHybridLogicalClock(input.previousLogicalClock, nowMs);

  return {
    schemaVersion: OFFLINE_SYNC_COMMAND_SCHEMA_VERSION,
    operationId,
    idempotencyKey,
    ownerUserId: input.ownerUserId,
    installationId: input.installationId,
    deviceId: input.deviceId,
    logicalClock,
    entityType: input.entityType,
    entityId: input.entityId,
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    command: input.command,
    intent: input.intent,
    ...(input.baseVersion === undefined ? {} : { baseVersion: input.baseVersion }),
    ...(input.baseUpdatedAt === undefined ? {} : { baseUpdatedAt: input.baseUpdatedAt }),
    normalizedResultPatch: input.normalizedResultPatch,
    dependencyOperationIds: [...(input.dependencyOperationIds ?? [])],
    status: input.status ?? 'pending',
    createdAtIso,
  };
}

export function serializeOfflineSyncCommand(
  command: OfflineSyncCommandEnvelope,
): string {
  return JSON.stringify(command);
}

export function parseOfflineSyncCommand(
  raw: string,
  options: {
    readonly source?: OfflineSyncQuarantineRecord['source'];
    readonly ownerUserId?: string;
    readonly nowMs?: number;
  } = {},
): OfflineSyncCommandParseResult {
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(raw) as JsonValue;
  } catch {
    return quarantine(raw, 'invalid-json', options);
  }

  if (!isOfflineSyncCommandEnvelope(parsed)) {
    return quarantine(parsed, 'invalid-command-envelope', options);
  }

  return { kind: 'valid', value: parsed };
}

export function createQuarantineRecord(
  raw: JsonValue,
  reason: string,
  options: {
    readonly source?: OfflineSyncQuarantineRecord['source'];
    readonly ownerUserId?: string;
    readonly nowMs?: number;
    readonly quarantineId?: string;
  } = {},
): OfflineSyncQuarantineRecord {
  const nowMs = options.nowMs ?? Date.now();
  return {
    schemaVersion: OFFLINE_SYNC_QUARANTINE_SCHEMA_VERSION,
    quarantineId: options.quarantineId ?? createClientUuid(),
    ...(options.ownerUserId === undefined ? {} : { ownerUserId: options.ownerUserId }),
    source: options.source ?? 'unknown',
    reason,
    raw,
    capturedAtIso: new Date(nowMs).toISOString(),
  };
}

function quarantine(
  raw: string | JsonValue,
  reason: string,
  options: {
    readonly source?: OfflineSyncQuarantineRecord['source'];
    readonly ownerUserId?: string;
    readonly nowMs?: number;
  },
): OfflineSyncCommandParseResult {
  const rawValue: JsonValue = typeof raw === 'string' ? raw : raw;
  return {
    kind: 'quarantined',
    quarantine: createQuarantineRecord(rawValue, reason, options),
  };
}

function isOfflineSyncCommandEnvelope(value: unknown): value is OfflineSyncCommandEnvelope {
  if (!isJsonObject(value)) return false;
  return hasEnvelopeIdentity(value) && hasEnvelopePayload(value);
}

function hasEnvelopeIdentity(value: Record<string, unknown>): boolean {
  return value.schemaVersion === OFFLINE_SYNC_COMMAND_SCHEMA_VERSION
    && isNonEmptyString(value.operationId)
    && isNonEmptyString(value.idempotencyKey)
    && isNonEmptyString(value.ownerUserId)
    && isNonEmptyString(value.installationId)
    && isNonEmptyString(value.deviceId)
    && isHybridLogicalClock(value.logicalClock)
    && isEntityType(value.entityType)
    && isNonEmptyString(value.entityId)
    && isNonEmptyString(value.command);
}

function hasEnvelopePayload(value: Record<string, unknown>): boolean {
  return isJsonObject(value.intent)
    && (value.baseVersion === undefined || value.baseVersion === null || isFiniteNumber(value.baseVersion))
    && (value.baseUpdatedAt === undefined || value.baseUpdatedAt === null || isNonEmptyString(value.baseUpdatedAt))
    && isJsonObject(value.normalizedResultPatch)
    && Array.isArray(value.dependencyOperationIds)
    && value.dependencyOperationIds.every(isNonEmptyString)
    && isCommandStatus(value.status)
    && isNonEmptyString(value.createdAtIso)
    && (value.projectId === undefined || isNonEmptyString(value.projectId))
    && (value.remoteResult === undefined || isRemoteResult(value.remoteResult));
}

function isHybridLogicalClock(value: unknown): value is HybridLogicalClock {
  if (!isJsonObject(value)) return false;
  const physicalMs = value.physicalMs;
  const logical = value.logical;
  return isFiniteNumber(physicalMs)
    && isFiniteNumber(logical)
    && Number.isInteger(logical)
    && logical >= 0;
}

function isRemoteResult(value: unknown): value is OfflineSyncCommandRemoteResult {
  return isJsonObject(value)
    && (value.decision === undefined || typeof value.decision === 'string')
    && (value.acknowledgedAtIso === undefined || typeof value.acknowledgedAtIso === 'string')
    && (value.rawResponse === undefined || isJsonValue(value.rawResponse));
}

function isEntityType(value: unknown): value is OfflineSyncEntityType {
  return value === 'project'
    || value === 'task'
    || value === 'connection'
    || value === 'black_box_entry'
    || value === 'focus_routine'
    || value === 'attachment'
    || value === 'preference'
    || value === 'focus_session'
    || value === 'routine_task'
    || value === 'routine_completion';
}

function isCommandStatus(value: unknown): value is OfflineSyncCommandStatus {
  return value === 'pending'
    || value === 'sent'
    || value === 'acked'
    || value === 'unknown'
    || value === 'superseded'
    || value === 'rejected';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== 'object') return false;
  return Object.values(value as Record<string, unknown>).every(isJsonValue);
}
