import type { Task } from '../models';
import type { OperationError, Result } from '../utils/result';

interface ReplaceChildSubtreeResult {
  detachedSubtreeRootId: string | null;
}

export interface TaskOperationAdapterStructureControllerOptions {
  blockLocalMutation(actionLabel: string): boolean;
  blockLocalMutationResult<T>(actionLabel: string): Result<T, OperationError> | null;
  core: {
    assignUnassignedToTaskDurably(
      sourceTaskId: string,
      targetUnassignedId: string,
    ): Promise<Result<void, OperationError>>;
    detachTaskDurably(taskId: string): Promise<boolean>;
    detachTaskWithSubtreeDurably(taskId: string): Promise<Result<void, OperationError>>;
    getDirectChildren(taskId: string): Task[];
    getUnassignedParent(taskId: string): string | null;
    moveSubtreeToNewParentDurably(
      taskId: string,
      newParentId: string | null,
    ): Promise<Result<void, OperationError>>;
    reorderStageDurably(stage: number, orderedIds: string[]): Promise<boolean>;
    repairMissingStageOneDurably(): Promise<boolean>;
    replaceChildSubtreeWithUnassignedDurably(
      sourceTaskId: string,
      targetUnassignedId: string,
      specificChildId?: string,
    ): Promise<Result<ReplaceChildSubtreeResult, OperationError>>;
  };
  markStructureEditing(): void;
  optimisticState: {
    createTaskSnapshot(taskId: string, label: string): { id: string };
    discardSnapshot(snapshotId: string): void;
    rollbackSnapshot(snapshotId: string): void;
  };
  recorder: {
    setupSyncResultHandler(snapshotId: string): void;
    showUndoToast(message: string): void;
  };
}

export class TaskOperationAdapterStructureController {
  constructor(private readonly options: TaskOperationAdapterStructureControllerOptions) {}

  async moveSubtreeToNewParent(
    taskId: string,
    newParentId: string | null,
  ): Promise<Result<void, OperationError>> {
    const blocked = this.options.blockLocalMutationResult<void>('移动子树');
    if (blocked) return blocked;

    this.options.markStructureEditing();
    const snapshot = this.options.optimisticState.createTaskSnapshot(taskId, '移动');
    const result = await this.options.core.moveSubtreeToNewParentDurably(taskId, newParentId);

    if (result.ok) {
      this.options.recorder.showUndoToast('已移动子树');
      this.options.recorder.setupSyncResultHandler(snapshot.id);
    } else {
      this.options.optimisticState.rollbackSnapshot(snapshot.id);
    }
    return result;
  }

  async reorderStage(stage: number, orderedIds: string[]): Promise<boolean> {
    if (this.options.blockLocalMutation('重排任务')) {
      return false;
    }

    this.options.markStructureEditing();
    return this.options.core.reorderStageDurably(stage, orderedIds);
  }

  async detachTask(taskId: string): Promise<boolean> {
    if (this.options.blockLocalMutation('移动任务')) {
      return false;
    }

    this.options.markStructureEditing();
    return this.options.core.detachTaskDurably(taskId);
  }

  async detachTaskWithSubtree(taskId: string): Promise<Result<void, OperationError>> {
    const blocked = this.options.blockLocalMutationResult<void>('移动子树');
    if (blocked) return blocked;

    this.options.markStructureEditing();
    const result = await this.options.core.detachTaskWithSubtreeDurably(taskId);
    if (result.ok) {
      this.options.recorder.showUndoToast('已移动到待分配区');
    }
    return result;
  }

  async replaceChildSubtreeWithUnassigned(
    sourceTaskId: string,
    targetUnassignedId: string,
    specificChildId?: string,
  ): Promise<Result<ReplaceChildSubtreeResult, OperationError>> {
    const blocked = this.options.blockLocalMutationResult<ReplaceChildSubtreeResult>('重新挂载任务');
    if (blocked) return blocked;

    this.options.markStructureEditing();
    const snapshot = this.options.optimisticState.createTaskSnapshot(sourceTaskId, '移动');
    const result = await this.options.core.replaceChildSubtreeWithUnassignedDurably(
      sourceTaskId,
      targetUnassignedId,
      specificChildId,
    );

    if (result.ok) {
      const detachedInfo = result.value.detachedSubtreeRootId ? '，原子任务已移到待分配区' : '';
      this.options.recorder.showUndoToast(`已分配待分配块${detachedInfo}`);
      this.options.recorder.setupSyncResultHandler(snapshot.id);
    } else {
      this.options.optimisticState.rollbackSnapshot(snapshot.id);
    }
    return result;
  }

  async assignUnassignedToTask(
    sourceTaskId: string,
    targetUnassignedId: string,
  ): Promise<Result<void, OperationError>> {
    const blocked = this.options.blockLocalMutationResult<void>('重新挂载任务');
    if (blocked) return blocked;

    this.options.markStructureEditing();
    const snapshot = this.options.optimisticState.createTaskSnapshot(sourceTaskId, '移动');
    const result = await this.options.core.assignUnassignedToTaskDurably(sourceTaskId, targetUnassignedId);

    if (result.ok) {
      this.options.recorder.showUndoToast('已分配待分配块');
      this.options.recorder.setupSyncResultHandler(snapshot.id);
    } else {
      this.options.optimisticState.rollbackSnapshot(snapshot.id);
    }
    return result;
  }

  getUnassignedParent(taskId: string): string | null {
    return this.options.core.getUnassignedParent(taskId);
  }

  getDirectChildren(taskId: string): Task[] {
    return this.options.core.getDirectChildren(taskId);
  }

  async repairMissingStageOne(canPublishUi: () => boolean): Promise<boolean> {
    if (this.options.blockLocalMutation('恢复阶段')) {
      return false;
    }

    this.options.markStructureEditing();
    const snapshot = this.options.optimisticState.createTaskSnapshot('', '移动');
    const repaired = await this.options.core.repairMissingStageOneDurably();

    if (repaired) {
      if (canPublishUi()) this.options.recorder.showUndoToast('已补回阶段 1');
      this.options.recorder.setupSyncResultHandler(snapshot.id);
    } else {
      this.options.optimisticState.discardSnapshot(snapshot.id);
    }

    return repaired;
  }
}
