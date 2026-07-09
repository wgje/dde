import type { SyncRpcResult } from '../../../../services/sync-rpc-client.service';
import { supabaseErrorToError } from '../../../../utils/supabase-error';
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

interface TaskSoftDeleteQueryResult {
  data: unknown;
  error: unknown;
}

interface TaskSoftDeleteQueryLike extends PromiseLike<TaskSoftDeleteQueryResult> {}

interface TaskSoftDeleteUpdateChain {
  eq(column: string, value: string): TaskSoftDeleteUpdateChain;
  select(columns: string): {
    maybeSingle(): TaskSoftDeleteQueryLike;
  };
}

export interface TaskSoftDeleteClient {
  from(table: 'tasks'): {
    update(values: { deleted_at: string; updated_at: string }): TaskSoftDeleteUpdateChain;
  };
}

export interface SoftDeleteTasksWithBaseGuardOptions {
  client: TaskSoftDeleteClient;
  projectId: string;
  taskIds: readonly string[];
  baseUpdatedAtMap: Record<string, string | null | undefined>;
  deletedAt?: string;
  logger: {
    warn(message: string, context?: Record<string, unknown>): void;
    error(message: string, context?: Record<string, unknown>): void;
  };
}

export function createTaskPurgeResult(
  success: boolean,
  deletedTaskIds: string[],
  skippedTaskIds: string[],
  retriedTaskIds: string[],
): TaskPurgeResult {
  return { success, deletedTaskIds, skippedTaskIds, retriedTaskIds };
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
): TaskPurgeResult {
  return createTaskPurgeResult(
    skippedTaskIds.length === 0,
    deletedTaskIds,
    skippedTaskIds,
    retriedTaskIds,
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

export interface LegacyPurgeSoftDeleteFallbackSelectionOptions {
  taskIds: readonly string[];
  existingTaskIds: ReadonlySet<string>;
  updatedTaskIds: readonly string[];
}

export interface LegacyPurgeSoftDeleteFallbackSelection {
  softDeleteTaskIds: string[];
  skippedTaskIds: string[];
}

export function selectLegacyPurgeSoftDeleteFallbackIds(
  options: LegacyPurgeSoftDeleteFallbackSelectionOptions,
): LegacyPurgeSoftDeleteFallbackSelection {
  const softDeleteTaskIds = options.taskIds.filter(id => options.existingTaskIds.has(id));
  if (softDeleteTaskIds.length === 0) {
    return {
      softDeleteTaskIds,
      skippedTaskIds: [],
    };
  }

  const updatedSet = new Set(options.updatedTaskIds);
  return {
    softDeleteTaskIds,
    skippedTaskIds: softDeleteTaskIds.filter(id => !updatedSet.has(id)),
  };
}

export interface ResolveLegacyPurgeSoftDeleteFallbackIdsOptions {
  taskIds: readonly string[];
  existingTaskIds: ReadonlySet<string>;
  softDeleteExistingTaskIds(taskIds: string[]): Promise<readonly string[]>;
}

export interface LegacyPurgeSoftDeleteFallbackResult {
  updatedTaskIds: string[];
  skippedTaskIds: string[];
}

export async function resolveLegacyPurgeSoftDeleteFallbackIds(
  options: ResolveLegacyPurgeSoftDeleteFallbackIdsOptions,
): Promise<LegacyPurgeSoftDeleteFallbackResult> {
  const { softDeleteTaskIds } = selectLegacyPurgeSoftDeleteFallbackIds({
    taskIds: options.taskIds,
    existingTaskIds: options.existingTaskIds,
    updatedTaskIds: [],
  });

  if (softDeleteTaskIds.length === 0) {
    return {
      updatedTaskIds: [],
      skippedTaskIds: [],
    };
  }

  const rawUpdatedTaskIds = await options.softDeleteExistingTaskIds(softDeleteTaskIds);
  const selection = selectLegacyPurgeSoftDeleteFallbackIds({
    taskIds: options.taskIds,
    existingTaskIds: options.existingTaskIds,
    updatedTaskIds: rawUpdatedTaskIds,
  });
  const skippedSet = new Set(selection.skippedTaskIds);

  return {
    updatedTaskIds: selection.softDeleteTaskIds.filter(id => !skippedSet.has(id)),
    skippedTaskIds: selection.skippedTaskIds,
  };
}

export async function softDeleteTasksWithBaseGuard(
  options: SoftDeleteTasksWithBaseGuardOptions,
): Promise<string[]> {
  const {
    client,
    projectId,
    taskIds,
    baseUpdatedAtMap,
    deletedAt = new Date().toISOString(),
    logger,
  } = options;
  const updatedTaskIds: string[] = [];

  for (const taskId of taskIds) {
    const baseUpdatedAt = baseUpdatedAtMap[taskId];
    if (!baseUpdatedAt) {
      logger.warn('跳过缺少 updatedAt 基线的任务软删降级，避免陈旧删除覆盖远端', {
        projectId,
        taskId,
      });
      continue;
    }

    const { data, error } = await client
      .from('tasks')
      .update({ deleted_at: deletedAt, updated_at: deletedAt })
      .eq('project_id', projectId)
      .eq('id', taskId)
      .eq('updated_at', baseUpdatedAt)
      .select('id')
      .maybeSingle();

    if (error) {
      logger.error('任务软删降级失败', { projectId, taskId, error });
      throw supabaseErrorToError(error);
    }

    if (!data) {
      logger.warn('跳过远端已前进的任务软删降级', { projectId, taskId, baseUpdatedAt });
      continue;
    }

    updatedTaskIds.push(taskId);
  }

  return updatedTaskIds;
}
