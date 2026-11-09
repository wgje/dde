import type { OperationError, Result } from '../utils/result';

interface TaskInsertBetweenParams {
  taskId: string;
  sourceId: string;
  targetId: string;
}

interface TaskInsertBetweenAtPositionParams extends TaskInsertBetweenParams {
  x: number;
  y: number;
}

export interface TaskOperationAdapterInsertControllerOptions {
  blockLocalMutationResult<T>(actionLabel: string): Result<T, OperationError> | null;
  core: {
    insertTaskBetweenDurably(
      params: TaskInsertBetweenParams,
    ): Promise<Result<void, OperationError>>;
    insertTaskBetweenAtPositionDurably(
      params: TaskInsertBetweenAtPositionParams,
    ): Promise<Result<void, OperationError>>;
  };
  markStructureEditing(): void;
  optimisticState: {
    createTaskSnapshot(taskId: string, label: string): { id: string };
    rollbackSnapshot(snapshotId: string): void;
  };
  recorder: {
    setupSyncResultHandler(snapshotId: string): void;
  };
}

export class TaskOperationAdapterInsertController {
  constructor(private readonly options: TaskOperationAdapterInsertControllerOptions) {}

  insertTaskBetween(
    taskId: string,
    sourceId: string,
    targetId: string,
  ): Promise<Result<void, OperationError>> {
    return this.runInsert(
      taskId,
      () => this.options.core.insertTaskBetweenDurably({ taskId, sourceId, targetId }),
    );
  }

  insertTaskBetweenAtPosition(
    taskId: string,
    sourceId: string,
    targetId: string,
    x: number,
    y: number,
  ): Promise<Result<void, OperationError>> {
    return this.runInsert(
      taskId,
      () => this.options.core.insertTaskBetweenAtPositionDurably({
        taskId,
        sourceId,
        targetId,
        x,
        y,
      }),
    );
  }

  private async runInsert(
    taskId: string,
    insert: () => Promise<Result<void, OperationError>>,
  ): Promise<Result<void, OperationError>> {
    const blocked = this.options.blockLocalMutationResult<void>('移动任务');
    if (blocked) return blocked;

    this.options.markStructureEditing();
    const snapshot = this.options.optimisticState.createTaskSnapshot(taskId, '移动');
    const result = await insert();

    if (result.ok) {
      this.options.recorder.setupSyncResultHandler(snapshot.id);
    } else {
      this.options.optimisticState.rollbackSnapshot(snapshot.id);
    }
    return result;
  }
}
