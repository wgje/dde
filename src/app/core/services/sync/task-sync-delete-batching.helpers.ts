import { createDerivedSyncOperationId } from '../../../../utils/sync-operation-id';
import type { TaskPurgeResult } from './task-sync-operations.types';

export const SYNC_DELETE_TASKS_RPC_BATCH_LIMIT = 100;

type BaseUpdatedAtMap = Record<string, string | null | undefined>;
type TombstoneTimestampMap = Record<string, string | number | null | undefined>;

export interface TaskDeleteBatch {
  taskIds: string[];
  operationId: string;
  baseUpdatedAtMap?: BaseUpdatedAtMap;
  tombstoneTimestamps?: TombstoneTimestampMap;
}

export interface BuildTaskDeleteBatchesOptions {
  parentOperationId: string;
  projectId: string;
  deleteMode: 'soft' | 'purge';
  taskIds: string[];
  baseUpdatedAtMap?: BaseUpdatedAtMap;
  tombstoneTimestamps?: TombstoneTimestampMap;
}

export function buildTaskDeleteBatches(
  options: BuildTaskDeleteBatchesOptions,
): TaskDeleteBatch[] {
  const batches: TaskDeleteBatch[] = [];
  for (
    let offset = 0;
    offset < options.taskIds.length;
    offset += SYNC_DELETE_TASKS_RPC_BATCH_LIMIT
  ) {
    const chunkIndex = offset / SYNC_DELETE_TASKS_RPC_BATCH_LIMIT;
    const taskIds = options.taskIds.slice(offset, offset + SYNC_DELETE_TASKS_RPC_BATCH_LIMIT);
    const baseUpdatedAtMap = pickTaskDeleteMap(taskIds, options.baseUpdatedAtMap);
    batches.push({
      taskIds,
      baseUpdatedAtMap,
      tombstoneTimestamps: pickTaskDeleteMap(taskIds, options.tombstoneTimestamps),
      operationId: createTaskDeleteChunkOperationId(
        options.parentOperationId,
        options.projectId,
        options.deleteMode,
        chunkIndex,
        taskIds,
        baseUpdatedAtMap,
      ),
    });
  }
  return batches;
}

export async function executeTaskDeleteBatchesSequentially<T>(
  batches: TaskDeleteBatch[],
  execute: (batch: TaskDeleteBatch) => Promise<T>,
): Promise<T[]> {
  const results: T[] = [];
  for (const batch of batches) {
    results.push(await execute(batch));
  }
  return results;
}

export function sumTaskDeleteAffectedCounts(counts: number[]): number {
  return counts.some(count => count < 0)
    ? -1
    : counts.reduce((total, count) => total + count, 0);
}

export function mergeTaskPurgeResults(results: TaskPurgeResult[]): TaskPurgeResult {
  const conflictTaskIds = results.flatMap(result => result.conflictTaskIds ?? []);
  const merged: TaskPurgeResult = {
    success: results.every(result => result.success),
    deletedTaskIds: results.flatMap(result => result.deletedTaskIds),
    skippedTaskIds: results.flatMap(result => result.skippedTaskIds),
    retriedTaskIds: results.flatMap(result => result.retriedTaskIds),
  };

  if (conflictTaskIds.length > 0) {
    merged.conflictTaskIds = conflictTaskIds;
  }
  const conflictResults = results.filter(result => result.conflictPersisted !== undefined);
  if (conflictResults.length > 0) {
    merged.conflictPersisted = conflictResults.every(result => result.conflictPersisted === true);
  }
  return merged;
}

function pickTaskDeleteMap<T>(
  taskIds: string[],
  source: Record<string, T> | undefined,
): Record<string, T> | undefined {
  if (!source) return undefined;
  const selected: Record<string, T> = {};
  for (const taskId of taskIds) {
    if (Object.prototype.hasOwnProperty.call(source, taskId)) {
      selected[taskId] = source[taskId];
    }
  }
  return Object.keys(selected).length > 0 ? selected : undefined;
}

function createTaskDeleteChunkOperationId(
  parentOperationId: string,
  projectId: string,
  deleteMode: 'soft' | 'purge',
  chunkIndex: number,
  taskIds: string[],
  baseUpdatedAtMap: BaseUpdatedAtMap | undefined,
): string {
  const baselines = taskIds.map(taskId => [
    taskId,
    baseUpdatedAtMap && Object.prototype.hasOwnProperty.call(baseUpdatedAtMap, taskId)
      ? baseUpdatedAtMap[taskId] ?? null
      : 'missing',
  ]);
  return createDerivedSyncOperationId(
    parentOperationId,
    `sync-delete-tasks:${deleteMode}:${projectId}:${chunkIndex}:${JSON.stringify(baselines)}`,
  );
}
