import type { Task } from '../../../../models';
import type { TaskStore } from '../../state/stores';
import {
  isSyncResponseVersionCurrent,
  type SyncResponseVersionSnapshot,
} from './sync-response-version-guard';

type TaskStoreSnapshotAccess = Pick<TaskStore, 'getTask' | 'setTask'>;

export interface TaskSyncPositionSnapshotRequest {
  taskId: string;
  projectId: string | undefined;
  fallbackTask: Task | undefined;
  x: number;
  y: number;
  serverUpdatedAt?: string | null;
  requestVersion?: SyncResponseVersionSnapshot;
}

export interface TaskSyncPositionSnapshotControllerOptions {
  taskStore?: TaskStoreSnapshotAccess | null;
  logDebug: (message: string, context: Record<string, unknown>) => void;
}

export class TaskSyncPositionSnapshotController {
  constructor(private readonly options: TaskSyncPositionSnapshotControllerOptions) {}

  applySnapshot(request: TaskSyncPositionSnapshotRequest): void {
    const rank = request.fallbackTask?.rank;
    const currentTask = this.resolveTask(request.taskId, request.projectId);
    if (!this.shouldApplySnapshot(request, currentTask)) {
      return;
    }

    this.writeToStore(
      currentTask,
      request.projectId,
      request.x,
      request.y,
      rank,
      request.serverUpdatedAt,
    );
    this.writeToFallbackTask(
      request.fallbackTask,
      request.x,
      request.y,
      request.serverUpdatedAt,
    );
  }

  private resolveTask(
    taskId: string,
    projectId: string | undefined,
  ): Task | undefined {
    return projectId ? this.options.taskStore?.getTask(taskId) : undefined;
  }

  private shouldApplySnapshot(
    request: TaskSyncPositionSnapshotRequest,
    currentTask: Task | undefined,
  ): boolean {
    if (!request.requestVersion) {
      return true;
    }

    const currentEntities = [
      ...(request.fallbackTask ? [request.fallbackTask] : []),
      ...(currentTask ? [currentTask] : []),
    ];
    if (
      currentEntities.length === 0
      || isSyncResponseVersionCurrent(request.requestVersion, currentEntities)
    ) {
      return true;
    }

    this.options.logDebug('跳过旧 task position 成功响应的本地快照回写', {
      taskId: request.taskId,
      projectId: request.projectId ?? null,
      requestUpdatedAt: request.requestVersion.updatedAt,
      requestDeletedAt: request.requestVersion.deletedAt,
      fallbackUpdatedAt: request.fallbackTask?.updatedAt ?? null,
      currentUpdatedAt: currentTask?.updatedAt ?? null,
      serverUpdatedAt: request.serverUpdatedAt ?? null,
    });
    return false;
  }

  private writeToStore(
    currentTask: Task | undefined,
    projectId: string | undefined,
    x: number,
    y: number,
    rank: Task['rank'] | undefined,
    serverUpdatedAt: string | null | undefined,
  ): void {
    if (!projectId || !currentTask) {
      return;
    }

    this.options.taskStore?.setTask({
      ...currentTask,
      x,
      y,
      ...(rank !== undefined ? { rank } : {}),
      ...(serverUpdatedAt ? { updatedAt: serverUpdatedAt } : {}),
    }, projectId);
  }

  private writeToFallbackTask(
    fallbackTask: Task | undefined,
    x: number,
    y: number,
    serverUpdatedAt: string | null | undefined,
  ): void {
    if (!fallbackTask) {
      return;
    }

    fallbackTask.x = x;
    fallbackTask.y = y;
    if (serverUpdatedAt) {
      fallbackTask.updatedAt = serverUpdatedAt;
    }
  }
}
