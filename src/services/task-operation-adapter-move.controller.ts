import type { OperationError, Result } from '../utils/result';

interface TaskMoveStageParams {
  taskId: string;
  newStage: number | null;
  beforeTaskId?: string | null;
  newParentId?: string | null;
}

interface TaskMoveAtPositionParams extends TaskMoveStageParams {
  x: number;
  y: number;
}

interface TaskMoveVisualTask {
  stage?: number | null;
  parentId?: string | null;
  rank?: number | null;
  x?: number | null;
  y?: number | null;
}

type TaskMoveVisualState = {
  stage: number | null;
  parentId: string | null;
  rank: number | null;
  x: number | null;
  y: number | null;
};

export interface TaskOperationAdapterMoveControllerOptions {
  blockLocalMutationResult<T>(actionLabel: string): Result<T, OperationError> | null;
  core: {
    moveTaskToStageDurably(params: TaskMoveStageParams): Promise<Result<void, OperationError>>;
    moveTaskToStageAtPositionDurably(
      params: TaskMoveAtPositionParams,
    ): Promise<Result<void, OperationError>>;
  };
  markStructureEditing(): void;
  optimisticState: {
    createTaskSnapshot(taskId: string, label: string): { id: string };
    discardSnapshot(snapshotId: string): void;
    rollbackSnapshot(snapshotId: string): void;
  };
  projectState: {
    activeProjectId(): string | null;
    getTask(taskId: string): TaskMoveVisualTask | null | undefined;
  };
  recorder: {
    setupSyncResultHandler(snapshotId: string): void;
    showUndoToast(message: string): void;
  };
  warn(message: string, data: Record<string, unknown>): void;
}

export class TaskOperationAdapterMoveController {
  constructor(private readonly options: TaskOperationAdapterMoveControllerOptions) {}

  async moveTaskToStage(
    taskId: string,
    newStage: number | null,
    beforeTaskId?: string | null,
    newParentId?: string | null,
  ): Promise<Result<void, OperationError>> {
    const blocked = this.options.blockLocalMutationResult<void>('移动任务');
    if (blocked) return blocked;

    this.options.markStructureEditing();

    const projectIdBefore = this.options.projectState.activeProjectId();
    const taskBefore = this.options.projectState.getTask(taskId);
    const stageBefore = taskBefore?.stage ?? null;
    const parentIdBefore = taskBefore?.parentId ?? null;
    const snapshot = this.options.optimisticState.createTaskSnapshot(taskId, '移动');
    const result = await this.options.core.moveTaskToStageDurably({
      taskId,
      newStage,
      beforeTaskId,
      newParentId,
    });

    if (!result.ok) {
      this.options.optimisticState.rollbackSnapshot(snapshot.id);
      return result;
    }

    const projectIdAfter = this.options.projectState.activeProjectId();
    if (projectIdAfter !== projectIdBefore) {
      this.options.warn('项目在操作期间被切换', { projectIdBefore, projectIdAfter, taskId });
      this.options.optimisticState.discardSnapshot(snapshot.id);
      return result;
    }

    const taskAfter = this.options.projectState.getTask(taskId);
    const stageAfter = taskAfter?.stage ?? null;
    const parentIdAfter = taskAfter?.parentId ?? null;
    const actuallyMoved = stageAfter !== stageBefore || parentIdAfter !== parentIdBefore;

    if (actuallyMoved) {
      this.showMoveUndoToast(newStage, snapshot.id);
    } else {
      this.options.optimisticState.discardSnapshot(snapshot.id);
    }

    return result;
  }

  async moveTaskToStageAtPosition(
    taskId: string,
    newStage: number | null,
    beforeTaskId: string | null | undefined,
    newParentId: string | null | undefined,
    x: number,
    y: number,
  ): Promise<Result<void, OperationError>> {
    const blocked = this.options.blockLocalMutationResult<void>('移动任务');
    if (blocked) return blocked;

    this.options.markStructureEditing();

    const projectIdBefore = this.options.projectState.activeProjectId();
    const stateBefore = this.readTaskMoveVisualState(taskId);
    const snapshot = this.options.optimisticState.createTaskSnapshot(taskId, '移动');
    const result = await this.options.core.moveTaskToStageAtPositionDurably({
      taskId,
      newStage,
      beforeTaskId,
      newParentId,
      x,
      y,
    });

    return this.finishMoveTaskAtPositionSnapshot({
      taskId,
      newStage,
      projectIdBefore,
      stateBefore,
      snapshotId: snapshot.id,
      result,
    });
  }

  private readTaskMoveVisualState(taskId: string): TaskMoveVisualState {
    const task = this.options.projectState.getTask(taskId);
    return {
      stage: task?.stage ?? null,
      parentId: task?.parentId ?? null,
      rank: task?.rank ?? null,
      x: task?.x ?? null,
      y: task?.y ?? null,
    };
  }

  private finishMoveTaskAtPositionSnapshot(context: {
    taskId: string;
    newStage: number | null;
    projectIdBefore: string | null;
    stateBefore: TaskMoveVisualState;
    snapshotId: string;
    result: Result<void, OperationError>;
  }): Result<void, OperationError> {
    const { taskId, newStage, projectIdBefore, stateBefore, snapshotId, result } = context;
    if (!result.ok) {
      this.options.optimisticState.rollbackSnapshot(snapshotId);
      return result;
    }

    const projectIdAfter = this.options.projectState.activeProjectId();
    if (projectIdAfter !== projectIdBefore) {
      this.options.warn('项目在操作期间被切换', { projectIdBefore, projectIdAfter, taskId });
      this.options.optimisticState.discardSnapshot(snapshotId);
      return result;
    }

    if (this.hasTaskMoveVisualStateChanged(stateBefore, this.readTaskMoveVisualState(taskId))) {
      this.showMoveUndoToast(newStage, snapshotId);
    } else {
      this.options.optimisticState.discardSnapshot(snapshotId);
    }
    return result;
  }

  private hasTaskMoveVisualStateChanged(
    before: TaskMoveVisualState,
    after: TaskMoveVisualState,
  ): boolean {
    return after.stage !== before.stage
      || after.parentId !== before.parentId
      || after.rank !== before.rank
      || after.x !== before.x
      || after.y !== before.y;
  }

  private showMoveUndoToast(newStage: number | null, snapshotId: string): void {
    const stageName = newStage === null ? '待分配区' : `阶段 ${newStage}`;
    this.options.recorder.showUndoToast(`已移动到${stageName}`);
    this.options.recorder.setupSyncResultHandler(snapshotId);
  }
}
