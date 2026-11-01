type DeleteSnapshotType = '删除';

interface SnapshotRef {
  id: string;
}

interface DurableDeleteResultLike {
  deletedTaskIds: Set<string>;
  saved: boolean;
}

interface DurableRestoreResultLike {
  saved: boolean;
  blockedReason?: 'missing-deleted-meta';
  blockedTaskIds?: Set<string>;
}

export type TaskOperationUiOwner = () => boolean;

export interface ProjectUiOwner {
  readonly projectId: string;
  readonly generation: number;
}

export interface TaskOperationTrashAdapterControllerOptions {
  blockLocalMutation: (actionLabel: string) => boolean;
  core: {
    calculateBatchDeleteImpact(explicitIds: string[]): {
      total: number;
      explicit: number;
      cascaded: number;
    };
    deleteTaskDurably(taskId: string): Promise<DurableDeleteResultLike>;
    deleteTaskKeepChildrenDurably(taskId: string): Promise<DurableDeleteResultLike>;
    deleteTasksBatchDurably(explicitIds: string[]): Promise<DurableDeleteResultLike>;
    emptyTrashDurably(): Promise<DurableDeleteResultLike>;
    permanentlyDeleteTaskDurably(taskId: string): Promise<DurableDeleteResultLike>;
    restoreTaskDurably(taskId: string): Promise<DurableRestoreResultLike>;
  };
  logger: {
    warn(message: string, data: Record<string, unknown>): void;
  };
  markEditing: () => void;
  optimisticState: {
    createTaskSnapshot(taskId: string, type: DeleteSnapshotType): SnapshotRef;
  };
  projectState: {
    activeProjectId(): string | null;
    getTask(taskId: string): { title?: string | null } | null | undefined;
  };
  recorder: {
    lastUpdateType: 'content' | 'structure' | 'position';
    setupSyncResultHandler(snapshotId: string): void;
    showUndoToast(message: string): void;
    triggerServerSideDelete(
      projectId: string, explicitIds: string[], snapshotId: string,
      canPublishUi?: TaskOperationUiOwner,
    ): void;
  };
  rollbackSnapshotAfterDurableFailure(
    snapshotId: string,
    message: string,
    data: Record<string, unknown>,
    canPublishUi?: TaskOperationUiOwner,
  ): void;
}

export class TaskOperationTrashAdapterController {
  constructor(private readonly options: TaskOperationTrashAdapterControllerOptions) {}

  async deleteTask(taskId: string): Promise<boolean> {
    if (this.options.blockLocalMutation('删除任务')) {
      return false;
    }

    this.markStructureEditing();
    const task = this.options.projectState.getTask(taskId);
    const taskTitle = task?.title || '任务';
    const snapshot = this.createDeleteSnapshot(taskId);
    const result = await this.options.core.deleteTaskDurably(taskId);
    if (!result.saved) {
      this.options.rollbackSnapshotAfterDurableFailure(
        snapshot.id,
        '任务删除本地持久化失败，未提交 UI 更新',
        { taskId },
      );
      return false;
    }

    this.options.recorder.showUndoToast(`已删除 "${taskTitle}"`);
    this.options.recorder.setupSyncResultHandler(snapshot.id);
    return true;
  }

  async permanentlyDeleteTask(
    taskId: string, canPublishUi: TaskOperationUiOwner = () => true,
  ): Promise<boolean> {
    if (this.options.blockLocalMutation('删除任务')) {
      return false;
    }

    this.markStructureEditing();
    const snapshot = this.createDeleteSnapshot(taskId);
    const result = await this.options.core.permanentlyDeleteTaskDurably(taskId);
    if (!result.saved) {
      this.options.rollbackSnapshotAfterDurableFailure(
        snapshot.id,
        '任务永久删除本地持久化失败，未提交 UI 更新',
        { taskId },
        canPublishUi,
      );
      return false;
    }

    this.options.recorder.setupSyncResultHandler(snapshot.id);
    return true;
  }

  async deleteTasksBatch(
    explicitIds: string[], canPublishUi: TaskOperationUiOwner = () => true,
  ): Promise<number> {
    if (explicitIds.length === 0) return 0;
    const projectId = this.options.projectState.activeProjectId();
    if (!projectId) return 0;
    if (this.options.blockLocalMutation('删除任务')) {
      return 0;
    }

    this.markStructureEditing();
    const snapshot = this.createDeleteSnapshot(explicitIds[0]);
    const result = await this.options.core.deleteTasksBatchDurably(explicitIds);
    if (!result.saved) {
      this.options.rollbackSnapshotAfterDurableFailure(
        snapshot.id,
        '批量删除本地持久化失败，未提交 UI 更新',
        { explicitIds },
        canPublishUi,
      );
      return 0;
    }

    const deletedCount = result.deletedTaskIds.size;
    this.options.recorder.triggerServerSideDelete(projectId, explicitIds, snapshot.id, canPublishUi);
    const publishUi = canPublishUi();
    if (publishUi) this.options.recorder.showUndoToast(`已删除 ${deletedCount} 个任务`);
    this.options.recorder.setupSyncResultHandler(snapshot.id);
    return publishUi ? deletedCount : 0;
  }

  calculateBatchDeleteImpact(explicitIds: string[]): {
    total: number;
    explicit: number;
    cascaded: number;
  } {
    return this.options.core.calculateBatchDeleteImpact(explicitIds);
  }

  async restoreTask(taskId: string): Promise<boolean> {
    if (this.options.blockLocalMutation('恢复任务')) {
      return false;
    }

    this.markStructureEditing();
    const result = await this.options.core.restoreTaskDurably(taskId);
    if (!result.saved) {
      if (result.blockedReason === 'missing-deleted-meta') {
        this.options.logger.warn('任务恢复被数据安全门禁阻止', {
          taskId,
          reason: result.blockedReason,
          blockedTaskIds: [...(result.blockedTaskIds ?? [])],
        });
        return false;
      }

      this.options.logger.warn('任务恢复本地持久化失败，未提交 UI 更新', { taskId });
      return false;
    }

    return true;
  }

  async emptyTrash(canPublishUi: TaskOperationUiOwner = () => true): Promise<boolean> {
    if (this.options.blockLocalMutation('清空回收站')) {
      return false;
    }

    this.markStructureEditing();
    const snapshot = this.createDeleteSnapshot('');
    const result = await this.options.core.emptyTrashDurably();
    if (!result.saved) {
      this.options.rollbackSnapshotAfterDurableFailure(
        snapshot.id,
        '清空回收站本地持久化失败，未提交 UI 更新',
        {},
        canPublishUi,
      );
      return false;
    }

    this.options.recorder.setupSyncResultHandler(snapshot.id);
    return true;
  }

  async deleteTaskKeepChildren(taskId: string): Promise<boolean> {
    if (this.options.blockLocalMutation('删除任务')) {
      return false;
    }

    this.markStructureEditing();
    const task = this.options.projectState.getTask(taskId);
    const taskTitle = task?.title || '任务';
    const snapshot = this.createDeleteSnapshot(taskId);
    const result = await this.options.core.deleteTaskKeepChildrenDurably(taskId);
    if (!result.saved) {
      this.options.rollbackSnapshotAfterDurableFailure(
        snapshot.id,
        '保留子任务删除本地持久化失败，未提交 UI 更新',
        { taskId },
      );
      return false;
    }

    this.options.recorder.showUndoToast(`已删除 "${taskTitle}"（保留子任务）`);
    this.options.recorder.setupSyncResultHandler(snapshot.id);
    return true;
  }

  private markStructureEditing(): void {
    this.options.markEditing();
    this.options.recorder.lastUpdateType = 'structure';
  }

  private createDeleteSnapshot(taskId: string): SnapshotRef {
    return this.options.optimisticState.createTaskSnapshot(taskId, '删除');
  }
}
