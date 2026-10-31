import type { DataSafetyWriteAuditInput } from '../../../../services/data-safety-write-audit.service';
import { createProjectTaskDeleteOperationId } from '../../../../services/project-operation-child-operation-id';
import type { SyncRpcResult } from '../../../../services/sync-rpc-client.service';
import type { TaskPurgeResult } from './task-sync-operations.types';

export interface TaskBaseUpdatedAtSource {
  updatedAt?: string | null;
}
export interface BuildTaskBaseUpdatedAtMapOptions {
  taskIds: readonly string[];
  overrideMap?: Record<string, string | null | undefined>;
  getTask?: (taskId: string) => TaskBaseUpdatedAtSource | undefined;
}

export interface SingleTaskBaseUpdatedAtOverrideSource {
  taskId: string;
  baseUpdatedAt?: string | null;
}

export interface TaskDeleteSessionClient {
  auth: {
    getSession(): Promise<{
      data: {
        session: {
          user?: {
            id?: string | null;
          } | null;
        } | null;
      };
    }>;
  };
}

export interface TaskDeleteSessionRefresher {
  tryRefreshSession(context: string): Promise<boolean>;
}

export interface ResolveRejectedTaskDeleteConflictPurgeResultOptions {
  taskIds: string[];
  conflictTaskIds: string[];
  hasRetryEntity(taskId: string): boolean;
  removeConflictRetries(taskIds: string[]): void;
  captureConflict(): Promise<boolean>;
}

export interface SettledLocalTaskDeleteWriteAuditRecorder {
  recordWrite(input: DataSafetyWriteAuditInput): unknown;
}

export interface RecordSettledLocalTaskDeleteWriteAuditOptions {
  dataSafetyWriteAudit: SettledLocalTaskDeleteWriteAuditRecorder;
  projectId: string;
  ownerUserId: string | null | undefined;
  operationId: string;
  taskIds: string[];
  localTimestamp: number;
  baseUpdatedAtMap?: Record<string, string | null | undefined>;
  getTask?: (taskId: string) => TaskBaseUpdatedAtSource | undefined;
  lastSyncTimeBefore: string | null;
  lastSyncTimeAfter: string | null;
}

export function createTaskPurgeResult(
  success: boolean,
  deletedTaskIds: string[],
  skippedTaskIds: string[],
  retriedTaskIds: string[],
  conflictTaskIds: string[] = [],
): TaskPurgeResult {
  return conflictTaskIds.length > 0
    ? { success, deletedTaskIds, skippedTaskIds, retriedTaskIds, conflictTaskIds }
    : { success, deletedTaskIds, skippedTaskIds, retriedTaskIds };
}

export function createRejectedTaskPurgeResult(
  taskIds: string[],
  retriedTaskIds: string[] = [],
): TaskPurgeResult {
  return createTaskPurgeResult(false, [], taskIds, retriedTaskIds);
}

export function createSettledTaskPurgeResult(
  deletedTaskIds: string[],
  skippedTaskIds: string[],
  retriedTaskIds: string[] = [],
  conflictTaskIds: string[] = [],
): TaskPurgeResult {
  return createTaskPurgeResult(
    skippedTaskIds.length === 0,
    deletedTaskIds,
    skippedTaskIds,
    retriedTaskIds,
    conflictTaskIds,
  );
}

export function createRetryTrackedTaskPurgeResult(
  deletedTaskIds: string[],
  skippedTaskIds: string[],
  hasRetryEntity: (taskId: string) => boolean,
): TaskPurgeResult {
  return createSettledTaskPurgeResult(
    deletedTaskIds,
    skippedTaskIds,
    collectRetriedTaskIds(skippedTaskIds, hasRetryEntity),
  );
}

export function createRetryTrackedRejectedTaskPurgeResult(
  taskIds: string[],
  hasRetryEntity: (taskId: string) => boolean,
): TaskPurgeResult {
  return createRetryTrackedTaskPurgeResult([], taskIds, hasRetryEntity);
}

export async function resolveRejectedTaskDeleteConflictPurgeResult(
  options: ResolveRejectedTaskDeleteConflictPurgeResultOptions,
): Promise<TaskPurgeResult> {
  const rejectedResult = createRetryTrackedRejectedTaskPurgeResult(
    options.taskIds,
    options.hasRetryEntity,
  );
  if (options.conflictTaskIds.length === 0) {
    return rejectedResult;
  }

  const conflictPersisted = await options.captureConflict();
  if (conflictPersisted) {
    options.removeConflictRetries(options.conflictTaskIds);
  }
  return {
    ...rejectedResult,
    retriedTaskIds: conflictPersisted ? [] : rejectedResult.retriedTaskIds,
    conflictTaskIds: [...options.conflictTaskIds],
    conflictPersisted,
  };
}

export function recordSettledLocalTaskDeleteWriteAudit(
  options: RecordSettledLocalTaskDeleteWriteAuditOptions,
): void {
  const shouldDeriveChildOperationIds = options.taskIds.length > 1;
  for (const taskId of options.taskIds) {
    const retryBaseUpdatedAt = resolveTaskDeleteRetryBaseUpdatedAt(
      taskId,
      options.baseUpdatedAtMap,
      options.getTask,
    );
    const baseUpdatedAt = retryBaseUpdatedAt ?? null;
    const operationId = shouldDeriveChildOperationIds
      ? createProjectTaskDeleteOperationId(
        options.operationId,
        options.projectId,
        taskId,
        retryBaseUpdatedAt,
      )
      : options.operationId;

    options.dataSafetyWriteAudit.recordWrite({
      ownerUserId: options.ownerUserId,
      operationId,
      sourceUserId: options.ownerUserId ?? undefined,
      entityType: 'task',
      entityId: taskId,
      operation: 'delete',
      writeIntent: 'task_soft_delete',
      localTimestamp: options.localTimestamp,
      updatedAtBaseline: baseUpdatedAt,
      beforeVersion: baseUpdatedAt,
      rpcResult: {
        status: 'applied',
        decision: 'local-only-task-delete',
        affectedCount: 1,
        raw: { source: 'local-only-task-delete' },
      },
      enteredRetryQueue: true,
      retryCount: 1,
      lastSyncTimeBefore: options.lastSyncTimeBefore,
      lastSyncTimeAfter: options.lastSyncTimeAfter,
    });
  }
}

function resolveTaskDeleteRetryBaseUpdatedAt(
  taskId: string,
  baseUpdatedAtMap: Record<string, string | null | undefined> | undefined,
  getTask: ((taskId: string) => TaskBaseUpdatedAtSource | undefined) | undefined,
): string | null | undefined {
  const mappedBaseUpdatedAt = baseUpdatedAtMap?.[taskId];
  if (mappedBaseUpdatedAt !== undefined) {
    return mappedBaseUpdatedAt;
  }

  const updatedAt = getTask?.(taskId)?.updatedAt;
  if (typeof updatedAt === 'string' && updatedAt.length > 0) {
    return updatedAt;
  }
  return updatedAt === null ? null : undefined;
}

export function collectRetriedTaskIds(
  taskIds: readonly string[],
  hasRetryEntity: (taskId: string) => boolean,
): string[] {
  return taskIds.filter(taskId => hasRetryEntity(taskId));
}

export function buildTaskBaseUpdatedAtMap(
  options: BuildTaskBaseUpdatedAtMapOptions,
): Record<string, string | null> | undefined {
  const { taskIds, overrideMap, getTask } = options;
  if (taskIds.length === 0) return undefined;

  const map: Record<string, string | null> = {};
  for (const id of taskIds) {
    if (overrideMap && Object.prototype.hasOwnProperty.call(overrideMap, id)) {
      map[id] = overrideMap[id] ?? null;
      continue;
    }

    const updatedAt = getTask?.(id)?.updatedAt;
    map[id] = typeof updatedAt === 'string' && updatedAt.length > 0
      ? updatedAt
      : null;
  }
  return map;
}

export function buildSingleTaskBaseUpdatedAtOverride(
  request: SingleTaskBaseUpdatedAtOverrideSource,
): Record<string, string | null> | undefined {
  if (request.baseUpdatedAt === undefined) return undefined;
  return { [request.taskId]: request.baseUpdatedAt };
}

export async function resolveTaskDeleteSessionUserId(
  client: TaskDeleteSessionClient,
  sessionRefresher: TaskDeleteSessionRefresher,
  refreshContext: string,
): Promise<string | null> {
  const { data: { session } } = await client.auth.getSession();
  const sessionUserId = session?.user?.id ?? null;
  if (sessionUserId) {
    return sessionUserId;
  }

  const refreshed = await sessionRefresher.tryRefreshSession(refreshContext);
  if (!refreshed) {
    return null;
  }

  const { data: { session: newSession } } = await client.auth.getSession();
  return newSession?.user?.id ?? null;
}

export function getSkippedTaskDeleteIds(
  result: Pick<SyncRpcResult, 'skippedIds'>,
  taskIds: readonly string[],
): string[] {
  const requestedIds = new Set(taskIds);
  return Array.from(new Set((result.skippedIds ?? []).filter(id => requestedIds.has(id))));
}

export interface AppliedTaskDeleteIdSelection {
  deletedTaskIds: string[];
  skippedTaskIds: string[];
}

export function selectAppliedTaskDeleteIds(
  result: Pick<SyncRpcResult, 'skippedIds'>,
  taskIds: readonly string[],
): AppliedTaskDeleteIdSelection {
  const skippedTaskIds = getSkippedTaskDeleteIds(result, taskIds);
  if (skippedTaskIds.length === 0) {
    return {
      deletedTaskIds: [...taskIds],
      skippedTaskIds,
    };
  }

  const skippedSet = new Set(skippedTaskIds);
  return {
    deletedTaskIds: taskIds.filter(id => !skippedSet.has(id)),
    skippedTaskIds,
  };
}
