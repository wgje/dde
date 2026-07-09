import { Injectable, inject } from '@angular/core';
import { FLOATING_TREE_CONFIG } from '../../../../config';
import type { Task } from '../../../../models';
import { LoggerService } from '../../../../services/logger.service';
import type { TaskWriteIntent } from '../../../../services/sync-rpc-client.service';
import { TaskSyncDeleteService } from './task-sync-delete.service';
import type { TaskPurgeResult, TombstoneQueryResult, TopologicalSortFrame } from './task-sync-operations.types';
import { TaskSyncPositionService } from './task-sync-position.service';
import { TaskSyncPushService } from './task-sync-push.service';
import { TaskSyncQueryService } from './task-sync-query.service';

export type { TaskPurgeResult, TombstoneQueryResult } from './task-sync-operations.types';

@Injectable({
  providedIn: 'root'
})
export class TaskSyncOperationsService {
  private readonly pushOps = inject(TaskSyncPushService);
  private readonly positionOps = inject(TaskSyncPositionService);
  private readonly queryOps = inject(TaskSyncQueryService);
  private readonly deleteOps = inject(TaskSyncDeleteService);
  private readonly logger = inject(LoggerService).category('TaskSyncOps');

  async pushTask(
    task: Task,
    projectId: string,
    skipTombstoneCheck = false,
    fromRetryQueue = false,
    sourceUserId?: string,
    treatTombstoneAsPermanent = false,
    writeIntent?: TaskWriteIntent,
    operationId?: string,
  ): Promise<boolean> {
    return await this.pushOps.pushTask(
      task,
      projectId,
      skipTombstoneCheck,
      fromRetryQueue,
      sourceUserId,
      treatTombstoneAsPermanent,
      writeIntent,
      operationId,
    );
  }

  async pushTaskPosition(
    taskId: string,
    x: number,
    y: number,
    projectId?: string,
    fallbackTask?: Task,
    sourceUserId?: string,
    operationId?: string,
  ): Promise<boolean> {
    return operationId === undefined
      ? await this.positionOps.pushTaskPosition(taskId, x, y, projectId, fallbackTask, sourceUserId)
      : await this.positionOps.pushTaskPosition(taskId, x, y, projectId, fallbackTask, sourceUserId, operationId);
  }

  async pullTasks(projectId: string, since?: string): Promise<Task[]> {
    return await this.queryOps.pullTasks(projectId, since);
  }

  async deleteTask(
    taskId: string,
    projectId: string,
    sourceUserId?: string,
    fromRetryQueue = false,
    baseUpdatedAt?: string | null,
    operationId?: string,
  ): Promise<boolean> {
    return await this.deleteOps.deleteTask(taskId, projectId, sourceUserId, fromRetryQueue, baseUpdatedAt, operationId);
  }

  async softDeleteTasksBatch(
    projectId: string,
    taskIds: string[],
    tombstoneTimestamps?: Record<string, string | number | null | undefined>,
    baseUpdatedAtMap?: Record<string, string | null | undefined>,
    operationId?: string,
  ): Promise<number> {
    return await this.deleteOps.softDeleteTasksBatch(projectId, taskIds, tombstoneTimestamps, baseUpdatedAtMap, operationId);
  }

  async purgeTasksFromCloud(
    projectId: string,
    taskIds: string[],
    sourceUserId?: string,
    fromRetryQueue = false,
    baseUpdatedAtMap?: Record<string, string | null | undefined>,
    operationId?: string,
  ): Promise<boolean> {
    return await this.deleteOps.purgeTasksFromCloud(
      projectId,
      taskIds,
      sourceUserId,
      fromRetryQueue,
      baseUpdatedAtMap,
      operationId,
    );
  }

  async purgeTasksFromCloudDetailed(
    projectId: string,
    taskIds: string[],
    sourceUserId?: string,
    fromRetryQueue = false,
    baseUpdatedAtMap?: Record<string, string | null | undefined>,
    operationId?: string,
  ): Promise<TaskPurgeResult> {
    return await this.deleteOps.purgeTasksFromCloudDetailed(
      projectId,
      taskIds,
      sourceUserId,
      fromRetryQueue,
      baseUpdatedAtMap,
      operationId,
    );
  }

  async getTombstoneIds(projectId: string): Promise<Set<string>> {
    return await this.queryOps.getTombstoneIds(projectId);
  }

  async getTombstoneIdsWithStatus(projectId: string): Promise<TombstoneQueryResult> {
    return await this.queryOps.getTombstoneIdsWithStatus(projectId);
  }

  getLocalTombstones(projectId: string): Set<string> {
    return this.queryOps.getLocalTombstones(projectId);
  }

  addLocalTombstones(
    projectId: string,
    taskIds: string[],
    timestampsByTaskId?: Record<string, string | number | null | undefined>,
  ): void {
    this.queryOps.addLocalTombstones(projectId, taskIds, timestampsByTaskId);
  }

  exportLocalTombstones(): Record<string, string[]> {
    return this.queryOps.exportLocalTombstones();
  }

  /** 拓扑排序任务，确保父任务在子任务之前 */
  topologicalSortTasks(tasks: Task[]): Task[] {
    const taskMap = new Map(tasks.map(t => [t.id, t]));
    const sorted: Task[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();

    for (const task of tasks) {
      if (visited.has(task.id)) {
        continue;
      }

      this.visitTaskForTopologicalSort(task.id, taskMap, sorted, visited, visiting);
    }

    this.logger.debug('拓扑排序完成', {
      original: tasks.length,
      sorted: sorted.length
    });

    return sorted;
  }

  private visitTaskForTopologicalSort(
    taskId: string,
    taskMap: Map<string, Task>,
    sorted: Task[],
    visited: Set<string>,
    visiting: Set<string>,
  ): void {
    const stack: TopologicalSortFrame[] = [{ taskId, expanded: false, depth: 0 }];

    while (stack.length > 0) {
      const frame = stack.pop()!;
      const current = taskMap.get(frame.taskId);
      if (!current) continue;
      if (this.completeExpandedTopologicalFrame(frame, current, sorted, visited, visiting)) continue;
      if (visited.has(frame.taskId)) continue;
      if (this.addTopologicalDepthFallback(frame, current, sorted, visited)) continue;
      if (this.addTopologicalCycleFallback(frame, current, sorted, visited, visiting)) continue;

      visiting.add(frame.taskId);
      stack.push({ taskId: frame.taskId, expanded: true, depth: frame.depth });
      this.pushTopologicalParentFrame(current, taskMap, visited, stack, frame.depth);
    }
  }

  private completeExpandedTopologicalFrame(
    frame: TopologicalSortFrame,
    current: Task,
    sorted: Task[],
    visited: Set<string>,
    visiting: Set<string>,
  ): boolean {
    if (!frame.expanded) return false;
    visiting.delete(frame.taskId);
    if (!visited.has(frame.taskId)) {
      visited.add(frame.taskId);
      sorted.push(current);
    }
    return true;
  }

  private addTopologicalDepthFallback(
    frame: TopologicalSortFrame,
    current: Task,
    sorted: Task[],
    visited: Set<string>,
  ): boolean {
    if (frame.depth <= FLOATING_TREE_CONFIG.MAX_SUBTREE_DEPTH) return false;
    this.logger.error('拓扑排序深度超限，已降级为当前节点优先', {
      taskId: frame.taskId,
      depth: frame.depth,
      maxDepth: FLOATING_TREE_CONFIG.MAX_SUBTREE_DEPTH
    });
    visited.add(frame.taskId);
    sorted.push(current);
    return true;
  }

  private addTopologicalCycleFallback(
    frame: TopologicalSortFrame,
    current: Task,
    sorted: Task[],
    visited: Set<string>,
    visiting: Set<string>,
  ): boolean {
    if (!visiting.has(frame.taskId)) return false;
    this.logger.warn('检测到任务循环依赖，已降级断开循环', { taskId: frame.taskId });
    visited.add(frame.taskId);
    sorted.push(current);
    return true;
  }

  private pushTopologicalParentFrame(
    current: Task,
    taskMap: Map<string, Task>,
    visited: Set<string>,
    stack: TopologicalSortFrame[],
    depth: number,
  ): void {
    if (!current.parentId || !taskMap.has(current.parentId) || visited.has(current.parentId)) {
      return;
    }

    stack.push({
      taskId: current.parentId,
      expanded: false,
      depth: depth + 1
    });
  }
}
