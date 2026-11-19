import type { Task, Project, Connection, BlackBoxEntry, UserPreferences } from '../../../../models';
import type { FocusSessionRecord, RoutineCompletionMutation, RoutineTask } from '../../../../models/parking-dock';
import type {
  RetryOperationHandler,
  RetryQueueItem,
  RetryQueueUnknownOutcomeReconcileResult,
} from './retry-queue.types';
import type { SyncRpcResult, TaskWriteIntent } from '../../../../services/sync-rpc-client.service';
import type { OfflineCommandStore } from '../../../../services/sync/offline-command-store';
import {
  OFFLINE_SYNC_COMMAND_KINDS,
  type KnownOfflineSyncCommandKind,
  type OfflineSyncCommandEnvelope,
  type OfflineSyncEntityType,
} from '../../../../services/sync/offline-sync-command-envelope';

export interface OfflineSyncCommandReplayDispatchOutcome {
  readonly success: boolean;
  readonly decision?: string;
  readonly rawResponse?: unknown;
  readonly serverUpdatedAt?: string;
}

export type OfflineSyncCommandReplayResult =
  | { readonly status: 'acked' }
  | { readonly status: 'replayed'; readonly success: boolean; readonly decision?: string; readonly rawResponse?: unknown; readonly serverUpdatedAt?: string }
  | { readonly status: 'unknown' }
  | { readonly status: 'skipped'; readonly reason: 'terminal' | 'unsupported' };

export type OfflineSyncCommandFor<TEntity extends OfflineSyncEntityType> =
  Omit<OfflineSyncCommandEnvelope, 'entityType'> & { readonly entityType: TEntity };

export type OfflineSyncEntityReplayHandler<TEntity extends OfflineSyncEntityType> =
  (command: OfflineSyncCommandFor<TEntity>) => Promise<boolean | null>;

/**
 * Optional routes for durable entities handled outside the legacy RetryQueue.
 * Attachment callbacks should delegate to the existing attachment upload
 * outbox/processor; focus and preference callbacks should use their existing
 * SyncRpc/FocusConsole service paths.
 */
export interface OfflineSyncCommandEntityHandlers {
  readonly project?: OfflineSyncEntityReplayHandler<'project'>;
  readonly task?: OfflineSyncEntityReplayHandler<'task'>;
  readonly connection?: OfflineSyncEntityReplayHandler<'connection'>;
  readonly black_box_entry?: OfflineSyncEntityReplayHandler<'black_box_entry'>;
  readonly attachment?: OfflineSyncEntityReplayHandler<'attachment'>;
  readonly preference?: OfflineSyncEntityReplayHandler<'preference'>;
  readonly focus_routine?: OfflineSyncEntityReplayHandler<'focus_routine'>;
  readonly focus_session?: OfflineSyncEntityReplayHandler<'focus_session'>;
  readonly routine_task?: OfflineSyncEntityReplayHandler<'routine_task'>;
  readonly routine_completion?: OfflineSyncEntityReplayHandler<'routine_completion'>;
}

export type OfflineSyncCommandReplayDispatcher =
  (command: OfflineSyncCommandEnvelope) => Promise<boolean | null | OfflineSyncCommandReplayDispatchOutcome>;


export interface OfflineSyncCommandRpcReplayClient {
  upsertTask?(params: {
    operationId: string;
    task: Task;
    projectId?: string;
    baseUpdatedAt: string | null;
    writeIntent?: TaskWriteIntent;
  }): Promise<SyncRpcResult>;
  upsertProject?(params: {
    operationId: string;
    project: Project;
    ownerId: string;
    baseUpdatedAt: string | null;
  }): Promise<SyncRpcResult>;
  deleteProject?(params: {
    operationId: string;
    projectId: string;
    baseUpdatedAt: string | null;
  }): Promise<SyncRpcResult>;
  deleteTasks?(params: {
    operationId: string;
    projectId: string;
    taskIds: string[];
    baseUpdatedAt: string | null;
    deleteMode?: 'soft' | 'purge';
  }): Promise<SyncRpcResult>;
  upsertConnection?(params: {
    operationId: string;
    connection: Connection;
    projectId?: string;
    baseUpdatedAt: string | null;
  }): Promise<SyncRpcResult>;
  upsertBlackboxEntry?(params: {
    operationId: string;
    entry: BlackBoxEntry;
    baseUpdatedAt: string | null;
  }): Promise<SyncRpcResult>;
  upsertUserPreferences(params: {
    operationId: string;
    userId: string;
    baseUpdatedAt: string | null;
    preferences: Partial<UserPreferences>;
  }): Promise<SyncRpcResult>;
  upsertFocusSession(params: {
    operationId: string;
    record: FocusSessionRecord;
  }): Promise<SyncRpcResult>;
  upsertRoutineTask(params: {
    operationId: string;
    userId: string;
    task: RoutineTask;
  }): Promise<SyncRpcResult>;
  incrementRoutineCompletion(params: {
    operationId: string;
    mutation: RoutineCompletionMutation;
  }): Promise<SyncRpcResult>;
}

export interface OfflineSyncCommandEnvelopeRpcClient {
  applyOfflineCommand?(params: { operationId: string; command: Record<string, unknown> }): Promise<SyncRpcResult>;
  getOfflineCommandStatus?(params: { operationId: string }): Promise<SyncRpcResult>;
}

/**
 * Builds only the command routes backed by an existing idempotent Sync RPC.
 * Delete commands intentionally have no route until a matching tombstone RPC
 * exists; they therefore remain visible as unsupported/quarantined.
 */
/** Sends the full versioned envelope to the capability-gated server ingest RPC. */
export function createOfflineSyncCommandEnvelopeDispatcher(
  client: OfflineSyncCommandEnvelopeRpcClient,
): OfflineSyncCommandReplayDispatcher {
  return async (command): Promise<OfflineSyncCommandReplayDispatchOutcome | null> => {
    if (!client.applyOfflineCommand) return null;
    const ingest = await client.applyOfflineCommand({
      operationId: command.operationId,
      command: command as unknown as Record<string, unknown>,
    });
    if (ingest.status !== 'accepted-shadow' && ingest.status !== 'idempotent-replay') {
      return toReplayDispatchOutcome(ingest);
    }
    if (!client.getOfflineCommandStatus) {
      return {
        success: false,
        decision: 'domain-apply-status-unavailable',
        rawResponse: { ingest: ingest.raw },
      };
    }
    const confirmation = await client.getOfflineCommandStatus({ operationId: command.operationId });
    const domainStatus = confirmation.domainApplyStatus ?? 'missing';
    const success = confirmation.appliedToDomainTables === true
      && (domainStatus === 'applied' || domainStatus === 'idempotent-replay');
    return {
      success,
      decision: domainStatus,
      rawResponse: { ingest: ingest.raw, confirmation: confirmation.raw },
      ...(confirmation.serverUpdatedAt === undefined ? {} : { serverUpdatedAt: confirmation.serverUpdatedAt }),
    };
  };
}

/**
 * Only commands with a verified server domain-apply translation are routed to
 * the envelope endpoint. Registered intent alone does not imply server support.
 */
export const OFFLINE_SYNC_SERVER_DOMAIN_COMMANDS = [
  'project.create', 'project.update', 'project.delete', 'project.restore',
  'task.create', 'task.update', 'task.delete', 'task.permanently_delete', 'task.restore',
  'task.move', 'task.reorder', 'task.detach', 'task.assign', 'task.tags.update',
  'task.parking_meta.update', 'task.attention_items.update', 'task.todo.update',
  'connection.create', 'connection.update', 'connection.restore', 'connection.reorder',
  'black_box_entry.create', 'black_box_entry.update',
  'preference.create', 'preference.update',
  'focus_session.create', 'focus_session.update',
  'routine_task.create', 'routine_task.update', 'routine_completion.create',
] as const satisfies readonly KnownOfflineSyncCommandKind[];
/**
 * Registered intents without a verified v1 envelope replay route stay visible
 * in owner-scoped quarantine. Attachments continue through the Blob outbox.
 */
export const OFFLINE_SYNC_INTENTIONALLY_QUARANTINED_COMMANDS = [
  'attachment.create', 'attachment.update', 'attachment.delete',
  'black_box_entry.delete', 'connection.delete', 'focus_routine.update',
  'focus_session.delete', 'preference.delete', 'routine_completion.update',
  'routine_task.delete', 'task.attachments.update',
] as const satisfies readonly KnownOfflineSyncCommandKind[];

export function createOfflineSyncCommandEnvelopeDispatchers(
  client: OfflineSyncCommandEnvelopeRpcClient,
): Partial<Record<KnownOfflineSyncCommandKind, OfflineSyncCommandReplayDispatcher>> {
  const dispatcher = createOfflineSyncCommandEnvelopeDispatcher(client);
  return Object.fromEntries(OFFLINE_SYNC_SERVER_DOMAIN_COMMANDS.map(kind => [kind, dispatcher]));
}

export function createOfflineSyncCommandRpcDispatchers(
  client: OfflineSyncCommandRpcReplayClient,
): Partial<Record<KnownOfflineSyncCommandKind, OfflineSyncCommandReplayDispatcher>> {
  const taskUpsert = async (command: OfflineSyncCommandEnvelope): Promise<OfflineSyncCommandReplayDispatchOutcome | null> => {
    const task = readPayloadEntity<Task>(asRecord(command.normalizedResultPatch), 'task');
    if (!task || !client.upsertTask) return null;
    const writeIntent = readTaskWriteIntent(command);
    const result = await client.upsertTask({
      operationId: command.operationId,
      task,
      projectId: command.projectId,
      baseUpdatedAt: command.baseUpdatedAt ?? null,
      ...(writeIntent === undefined ? {} : { writeIntent }),
    });
    return toReplayDispatchOutcome(result);
  };

  const projectUpsert = async (command: OfflineSyncCommandEnvelope): Promise<OfflineSyncCommandReplayDispatchOutcome | null> => {
    const project = readPayloadEntity<Project>(asRecord(command.normalizedResultPatch), 'project');
    if (!project || !client.upsertProject) return null;
    const result = await client.upsertProject({
      operationId: command.operationId,
      project,
      ownerId: command.ownerUserId,
      baseUpdatedAt: command.baseUpdatedAt ?? null,
    });
    return toReplayDispatchOutcome(result);
  };
  const projectDelete = async (command: OfflineSyncCommandEnvelope): Promise<OfflineSyncCommandReplayDispatchOutcome | null> => {
    if (!client.deleteProject) return null;
    const result = await client.deleteProject({
      operationId: command.operationId,
      projectId: command.entityId,
      baseUpdatedAt: command.baseUpdatedAt ?? null,
    });
    return toReplayDispatchOutcome(result);
  };
  const taskDelete = async (command: OfflineSyncCommandEnvelope): Promise<OfflineSyncCommandReplayDispatchOutcome | null> => {
    const projectId = command.projectId;
    if (!client.deleteTasks || typeof projectId !== 'string' || projectId.length === 0) return null;
    const result = await client.deleteTasks({
      operationId: command.operationId,
      projectId,
      taskIds: [command.entityId],
      baseUpdatedAt: command.baseUpdatedAt ?? null,
      deleteMode: command.command === 'task.permanently_delete' ? 'purge' : 'soft',
    });
    return toReplayDispatchOutcome(result);
  };
  const connectionUpsert = async (command: OfflineSyncCommandEnvelope): Promise<OfflineSyncCommandReplayDispatchOutcome | null> => {
    const connection = readPayloadEntity<Connection>(asRecord(command.normalizedResultPatch), 'connection');
    if (!connection || !client.upsertConnection) return null;
    const result = await client.upsertConnection({
      operationId: command.operationId,
      connection,
      projectId: command.projectId,
      baseUpdatedAt: command.baseUpdatedAt ?? null,
    });
    return toReplayDispatchOutcome(result);
  };
  const blackboxUpsert = async (command: OfflineSyncCommandEnvelope): Promise<OfflineSyncCommandReplayDispatchOutcome | null> => {
    const entry = readPayloadEntity<BlackBoxEntry>(asRecord(command.normalizedResultPatch), 'entry');
    if (!entry || !client.upsertBlackboxEntry) return null;
    const result = await client.upsertBlackboxEntry({
      operationId: command.operationId,
      entry,
      baseUpdatedAt: command.baseUpdatedAt ?? null,
    });
    return toReplayDispatchOutcome(result);
  };
  const preference = async (command: OfflineSyncCommandEnvelope): Promise<OfflineSyncCommandReplayDispatchOutcome | null> => {
    const preferences = readPatchRecord(command, ['preferences', 'userPreferences', 'user_preferences']);
    if (!preferences) return null;
    const result = await client.upsertUserPreferences({
      operationId: command.operationId,
      userId: command.ownerUserId,
      baseUpdatedAt: command.baseUpdatedAt ?? null,
      preferences: preferences as Partial<UserPreferences>,
    });
    return toReplayDispatchOutcome(result);
  };
  const focusSession = async (command: OfflineSyncCommandEnvelope): Promise<OfflineSyncCommandReplayDispatchOutcome | null> => {
    const record = readFocusSession(command);
    if (!record) return null;
    const result = await client.upsertFocusSession({ operationId: command.operationId, record });
    return toReplayDispatchOutcome(result);
  };
  const routineTask = async (command: OfflineSyncCommandEnvelope): Promise<OfflineSyncCommandReplayDispatchOutcome | null> => {
    const task = readRoutineTask(command);
    if (!task) return null;
    const result = await client.upsertRoutineTask({
      operationId: command.operationId,
      userId: command.ownerUserId,
      task,
    });
    return toReplayDispatchOutcome(result);
  };
  const routineCompletion = async (command: OfflineSyncCommandEnvelope): Promise<boolean | null> => {
    const mutation = readRoutineCompletion(command);
    if (!mutation) return null;
    const result = await client.incrementRoutineCompletion({ operationId: command.operationId, mutation });
    return isAppliedRpcResult(result) ? true : false;
  };

  return {
    'task.create': taskUpsert,
    'task.update': taskUpsert,
    'task.delete': taskDelete,
    'task.permanently_delete': taskDelete,
    'task.restore': taskUpsert,
    'task.move': taskUpsert,
    'task.reorder': taskUpsert,
    'task.detach': taskUpsert,
    'task.assign': taskUpsert,
    'task.tags.update': taskUpsert,
    'task.attachments.update': taskUpsert,
    'task.parking_meta.update': taskUpsert,
    'task.attention_items.update': taskUpsert,
    'task.todo.update': taskUpsert,
    'project.create': projectUpsert,
    'project.update': projectUpsert,
    'project.restore': projectUpsert,
    'project.delete': projectDelete,
    'connection.create': connectionUpsert,
    'connection.update': connectionUpsert,
    'connection.restore': connectionUpsert,
    'connection.reorder': connectionUpsert,
    'black_box_entry.create': blackboxUpsert,
    'black_box_entry.update': blackboxUpsert,
    'preference.create': preference,
    'preference.update': preference,
    'focus_session.create': focusSession,
    'focus_session.update': focusSession,
    'routine_task.create': routineTask,
    'routine_task.update': routineTask,
    'routine_completion.create': routineCompletion,
  };
}

function isAppliedRpcResult(result: SyncRpcResult): boolean {
  return result.status === 'applied' || result.status === 'idempotent-replay';
}

function toReplayDispatchOutcome(result: SyncRpcResult): OfflineSyncCommandReplayDispatchOutcome {
  return {
    success: isAppliedRpcResult(result),
    decision: result.decision ?? result.status,
    ...(result.raw === undefined ? {} : { rawResponse: result.raw }),
    ...(result.serverUpdatedAt === undefined ? {} : { serverUpdatedAt: result.serverUpdatedAt }),
  };
}

function readPatchRecord(
  command: OfflineSyncCommandEnvelope,
  nestedKeys: readonly string[],
): Record<string, unknown> | null {
  const patch = asRecord(command.normalizedResultPatch);
  for (const key of nestedKeys) {
    const nested = asRecord(patch[key]);
    if (Object.keys(nested).length > 0) return nested;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

function readFocusSession(command: OfflineSyncCommandEnvelope): FocusSessionRecord | null {
  const patch = readPatchRecord(command, ['focusSession', 'focus_session', 'record']);
  if (!patch) return null;
  const record = {
    ...patch,
    id: typeof patch['id'] === 'string' ? patch['id'] : command.entityId,
    userId: typeof patch['userId'] === 'string' ? patch['userId'] : command.ownerUserId,
  };
  return typeof record.id === 'string' && typeof record.userId === 'string'
    ? record as unknown as FocusSessionRecord
    : null;
}

function readRoutineTask(command: OfflineSyncCommandEnvelope): RoutineTask | null {
  const patch = readPatchRecord(command, ['routineTask', 'routine_task', 'task']);
  if (!patch) return null;
  const task = {
    ...patch,
    routineId: typeof patch['routineId'] === 'string' ? patch['routineId'] : command.entityId,
  };
  return typeof task.routineId === 'string' ? task as unknown as RoutineTask : null;
}

function readRoutineCompletion(command: OfflineSyncCommandEnvelope): RoutineCompletionMutation | null {
  const patch = readPatchRecord(command, ['routineCompletion', 'routine_completion', 'mutation']);
  if (!patch) return null;
  const mutation = {
    ...patch,
    completionId: typeof patch['completionId'] === 'string' ? patch['completionId'] : command.entityId,
    userId: typeof patch['userId'] === 'string' ? patch['userId'] : command.ownerUserId,
  };
  return typeof mutation.completionId === 'string' && typeof mutation.userId === 'string'
    ? mutation as unknown as RoutineCompletionMutation
    : null;
}
export interface OfflineSyncCommandReplayOptions {
  /** Per-command routes take precedence over entity routes and legacy fallbacks. */
  readonly commands?: Partial<Record<KnownOfflineSyncCommandKind, OfflineSyncCommandReplayDispatcher>>;
  readonly entities?: OfflineSyncCommandEntityHandlers;
  /** Reconciles non-RetryQueue entities that have an unknown remote outcome. */
  readonly reconcileUnknownOutcome?: (
    command: OfflineSyncCommandEnvelope,
  ) => Promise<RetryQueueUnknownOutcomeReconcileResult>;
  /** Include RPC decision/response evidence in the replay result. */
  readonly captureRemoteEvidence?: boolean;
  /** Persist unsupported/unknown commands for export and later review. */
  readonly quarantineUnsupported?: (command: OfflineSyncCommandEnvelope, reason: string) => Promise<void>;
}

export async function replayOfflineSyncCommand(
  command: OfflineSyncCommandEnvelope,
  handler: RetryOperationHandler,
  options: OfflineSyncCommandReplayOptions = {},
): Promise<OfflineSyncCommandReplayResult> {
  if (command.status === 'acked' || command.status === 'rejected' || command.status === 'superseded') {
    return { status: 'skipped', reason: 'terminal' };
  }
  if (!isRegisteredCommand(command.command)) {
    await quarantineUnsupportedCommand(command, 'unknown-command-kind', options);
    return { status: 'skipped', reason: 'unsupported' };
  }

  if (command.status === 'unknown') {
    const reconcile = await reconcileUnknownCommand(command, handler, options);
    if (reconcile === 'settled') return { status: 'acked' };
    if (reconcile === 'unknown') return { status: 'unknown' };
  }

  const hasExplicitReplayHandler = Boolean(
    options.commands?.[command.command as KnownOfflineSyncCommandKind]
    || options.entities?.[command.entityType],
  );
  if (isIntentionallyQuarantinedCommand(command.command) && !hasExplicitReplayHandler) {
    await quarantineUnsupportedCommand(command, 'intentionally-quarantined-command', options);
    return { status: 'skipped', reason: 'unsupported' };
  }

  const success = await sendCommand(command, handler, options);
  if (success === null) {
    await quarantineUnsupportedCommand(command, 'no-replay-handler', options);
    return { status: 'skipped', reason: 'unsupported' };
  }
  if (typeof success === 'boolean' || !options.captureRemoteEvidence) {
    return { status: 'replayed', success: typeof success === 'boolean' ? success : success.success };
  }
  return { status: 'replayed', success: success.success,
    ...(success.decision === undefined ? {} : { decision: success.decision }),
    ...(success.rawResponse === undefined ? {} : { rawResponse: success.rawResponse }),
    ...(success.serverUpdatedAt === undefined ? {} : { serverUpdatedAt: success.serverUpdatedAt }),
  };
}

export function createOfflineSyncUnsupportedCommandQuarantiner(
  store: OfflineCommandStore,
  now: () => string = () => new Date().toISOString(),
): NonNullable<OfflineSyncCommandReplayOptions['quarantineUnsupported']> {
  return async (command, reason) => {
    await store.quarantine({
      ownerUserId: command.ownerUserId,
      reason,
      raw: command,
      quarantinedAt: now(),
      key: `${command.ownerUserId}:quarantine:unsupported:${command.operationId}`,
    });
  };
}

async function quarantineUnsupportedCommand(
  command: OfflineSyncCommandEnvelope,
  reason: string,
  options: OfflineSyncCommandReplayOptions,
): Promise<void> {
  await options.quarantineUnsupported?.(command, reason);
}

async function reconcileUnknownCommand(
  command: OfflineSyncCommandEnvelope,
  handler: RetryOperationHandler,
  options: OfflineSyncCommandReplayOptions,
): Promise<RetryQueueUnknownOutcomeReconcileResult> {
  if (options.reconcileUnknownOutcome) return options.reconcileUnknownOutcome(command);
  if (!isLegacyRetryEntity(command.entityType) || !handler.reconcileUnknownOutcome) return 'unknown';
  return handler.reconcileUnknownOutcome(toRetryQueueItem(command));
}

async function sendCommand(
  command: OfflineSyncCommandEnvelope,
  handler: RetryOperationHandler,
  options: OfflineSyncCommandReplayOptions,
): Promise<boolean | null | OfflineSyncCommandReplayDispatchOutcome> {
  const commandDispatcher = options.commands?.[command.command as KnownOfflineSyncCommandKind];
  if (commandDispatcher) return commandDispatcher(command);

  const entityDispatcher = options.entities?.[command.entityType] as
    | OfflineSyncEntityReplayHandler<OfflineSyncEntityType>
    | undefined;
  if (entityDispatcher) return entityDispatcher(command as OfflineSyncCommandFor<OfflineSyncEntityType>);

  return replayWithLegacyHandler(command, handler);
}

function replayWithLegacyHandler(
  command: OfflineSyncCommandEnvelope,
  handler: RetryOperationHandler,
): Promise<boolean> | null {
  const payload = asRecord(command.normalizedResultPatch);
  const ownerUserId = command.ownerUserId;
  const projectId = command.projectId ?? '';

  if (command.entityType === 'task') {
    if (isDeleteCommand(command)) {
      return handler.deleteTask(
        command.entityId,
        projectId,
        ownerUserId,
        true,
        command.baseUpdatedAt,
        command.operationId,
      );
    }
    const task = readPayloadEntity<Task>(payload, 'task');
    if (!task) return null;
    return handler.pushTask(task, projectId, ownerUserId, readWriteIntent(command), command.operationId);
  }

  if (command.entityType === 'project') {
    // RetryOperationHandler only exposes project upsert, not hard/soft delete.
    if (isDeleteCommand(command)) return null;
    const project = readPayloadEntity<Project>(payload, 'project');
    if (!project) return null;
    return handler.pushProject(project, ownerUserId, readStringArray(command.intent.taskIdsToDelete), undefined, command.operationId);
  }

  if (command.entityType === 'connection') {
    if (isDeleteCommand(command)) return null;
    const connection = readPayloadEntity<Connection>(payload, 'connection');
    if (!connection) return null;
    return handler.pushConnection(connection, projectId, ownerUserId, command.operationId);
  }

  if (command.entityType === 'black_box_entry') {
    if (!handler.pushBlackBoxEntry || isDeleteCommand(command)) return null;
    const entry = readPayloadEntity<BlackBoxEntry>(payload, 'entry');
    if (!entry) return null;
    return handler.pushBlackBoxEntry(entry, ownerUserId, command.operationId);
  }

  return null;
}

function toRetryQueueItem(command: OfflineSyncCommandEnvelope): RetryQueueItem {
  const legacyType = command.entityType === 'black_box_entry'
    ? 'blackbox'
    : command.entityType as RetryQueueItem['type'];
  return {
    id: command.operationId,
    type: legacyType,
    operation: isDeleteCommand(command) ? 'delete' : 'upsert',
    data: command.normalizedResultPatch as unknown as RetryQueueItem['data'],
    projectId: command.projectId,
    retryCount: 0,
    createdAt: Date.parse(command.createdAtIso) || 0,
    sourceUserId: command.ownerUserId,
    operationId: command.operationId,
    ...(command.status === 'unknown' ? {
      lastFailure: {
        errorType: 'unknown',
        message: 'offline command remote outcome unknown',
        recordedAt: Date.parse(command.createdAtIso) || 0,
        remoteOutcome: 'unknown' as const,
      },
    } : {}),
  };
}

function readTaskWriteIntent(command: OfflineSyncCommandEnvelope): TaskWriteIntent | undefined {
  if (command.command === 'task.attachments.update') return 'task_attachment_update';
  if (command.command === 'task.move' || command.command === 'task.reorder'
    || command.command === 'task.detach' || command.command === 'task.assign') {
    return 'task_structure_update';
  }
  if (command.command === 'task.todo.update') return 'task_text_update';
  return readWriteIntent(command) ?? 'task_full_upsert';
}

function readWriteIntent(command: OfflineSyncCommandEnvelope): TaskWriteIntent | undefined {
  const value = command.intent.writeIntent;
  return typeof value === 'string' ? value as TaskWriteIntent : undefined;
}

function isDeleteCommand(command: OfflineSyncCommandEnvelope): boolean {
  return command.command.endsWith('.delete') || command.command.endsWith('.permanently_delete');
}

function isLegacyRetryEntity(entityType: OfflineSyncEntityType): boolean {
  return entityType === 'task'
    || entityType === 'project'
    || entityType === 'connection'
    || entityType === 'black_box_entry';
}

function isRegisteredCommand(command: string): command is KnownOfflineSyncCommandKind {
  return (OFFLINE_SYNC_COMMAND_KINDS as readonly string[]).includes(command);
}

function isIntentionallyQuarantinedCommand(command: string): boolean {
  return (OFFLINE_SYNC_INTENTIONALLY_QUARANTINED_COMMANDS as readonly string[]).includes(command);
}
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readPayloadEntity<T>(payload: Record<string, unknown>, key: string): T | null {
  const nested = payload[key];
  const candidate = nested && typeof nested === 'object' && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : payload;
  return typeof candidate['id'] === 'string' ? candidate as T : null;
}

function readStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
    ? value
    : undefined;
}
