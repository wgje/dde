import type { Task } from '../models';
import {
  buildRemoteTaskDirtyFields,
  mergeRemoteTaskWithLocalDirtyFields,
  shouldKeepLocalDeletedTask,
} from './remote-change-handler.helpers';

export interface RemoteTaskMergePendingChange {
  changeType?: string | null;
  changedFields?: Iterable<string> | null;
}

export interface RemoteTaskMergeContext {
  taskId: string;
  targetProjectId: string;
}

export interface RemoteTaskMergeControllerOptions {
  getLockedFields: (taskId: string, projectId: string) => Iterable<string>;
  isEditing: () => boolean;
  logger: {
    debug(message: string, context?: unknown): void;
    info(message: string, context?: unknown): void;
  };
}

export interface RemoteTaskMergeInput {
  localTask: Task;
  remoteTask: Task;
  pending: RemoteTaskMergePendingChange | null | undefined;
  context: RemoteTaskMergeContext;
}

export class RemoteTaskMergeController {
  constructor(private readonly options: RemoteTaskMergeControllerOptions) {}

  mergeRemoteTask(input: RemoteTaskMergeInput): Task {
    this.logTaskMergeComparison(input.localTask, input.remoteTask, input.context.taskId);

    if (input.pending?.changeType === 'delete') {
      return input.localTask;
    }

    if (this.shouldKeepLocalDeletedTask(input.localTask, input.remoteTask, input.context.taskId)) {
      return input.localTask;
    }

    const dirtyFields = this.collectDirtyTaskFields(input);
    return dirtyFields.size > 0
      ? this.copyDirtyFieldsFromLocal(
        input.localTask,
        input.remoteTask,
        dirtyFields,
        input.context.taskId,
      )
      : input.remoteTask;
  }

  private logTaskMergeComparison(localTask: Task, remoteTask: Task, taskId: string): void {
    this.options.logger.debug('任务更新对比', {
      taskId,
      local: {
        status: localTask.status,
        stage: localTask.stage,
        x: localTask.x,
        y: localTask.y,
        updatedAt: localTask.updatedAt,
      },
      remote: {
        status: remoteTask.status,
        stage: remoteTask.stage,
        x: remoteTask.x,
        y: remoteTask.y,
        updatedAt: remoteTask.updatedAt,
      },
    });
  }

  private shouldKeepLocalDeletedTask(localTask: Task, remoteTask: Task, taskId: string): boolean {
    if (!shouldKeepLocalDeletedTask({ localTask, remoteTask })) return false;

    this.options.logger.info('保护本地删除状态（本地删除时间 > 远程更新时间）', {
      taskId,
      localDeletedAt: localTask.deletedAt,
      remoteUpdatedAt: remoteTask.updatedAt,
    });
    return true;
  }

  private collectDirtyTaskFields(input: RemoteTaskMergeInput): Set<string> {
    const lockedFields = [...this.options.getLockedFields(
      input.context.taskId,
      input.context.targetProjectId,
    )];
    for (const field of lockedFields) {
      this.options.logger.debug('字段被操作锁保护', {
        taskId: input.context.taskId,
        field,
      });
    }

    const localTime = input.localTask.updatedAt ? new Date(input.localTask.updatedAt).getTime() : 0;
    const remoteTime = input.remoteTask.updatedAt ? new Date(input.remoteTask.updatedAt).getTime() : 0;
    if (localTime >= remoteTime) {
      this.options.logger.info('LWW 保护本地字段（本地时间 >= 远程时间）', {
        taskId: input.context.taskId,
        localTime: input.localTask.updatedAt,
        remoteTime: input.remoteTask.updatedAt,
      });
    }

    return buildRemoteTaskDirtyFields({
      pendingChangedFields: input.pending?.changedFields,
      lockedFields,
      localTask: input.localTask,
      remoteTask: input.remoteTask,
      isEditing: this.options.isEditing(),
    });
  }

  private copyDirtyFieldsFromLocal(
    localTask: Task,
    remoteTask: Task,
    dirtyFields: Set<string>,
    taskId: string,
  ): Task {
    const result = mergeRemoteTaskWithLocalDirtyFields({ localTask, remoteTask, dirtyFields });
    for (const field of result.copiedFields) {
      this.options.logger.debug('保护本地字段值', {
        taskId,
        field,
        localValue: localTask[field as keyof Task],
      });
    }

    if (result.protectedDeletedAt) {
      this.options.logger.info('保护删除状态', {
        taskId,
        localDeletedAt: localTask.deletedAt,
        remoteDeletedAt: remoteTask.deletedAt,
      });
    }

    return result.task;
  }
}
