import {
  buildTaskBaseUpdatedAtMap,
  type TaskBaseUpdatedAtSource,
} from './task-sync-delete.helpers';

export interface TaskDeleteBaseUpdatedAtTaskStore {
  getTask(taskId: string): TaskBaseUpdatedAtSource | undefined;
}

/**
 * 构造 `sync_delete_tasks.base_updated_at_map`：从 TaskStore 取每个 task 的本地 updated_at 快照。
 * 服务端据此识别"已被远端改动"的 task 并跳过删除，保护用户在新设备上做过的合法变更。
 */
export function buildTaskDeleteBaseUpdatedAtMap(
  taskIds: readonly string[],
  overrideMap?: Record<string, string | null | undefined>,
  taskStore?: TaskDeleteBaseUpdatedAtTaskStore | null,
): Record<string, string | null> | undefined {
  return buildTaskBaseUpdatedAtMap({
    taskIds,
    overrideMap,
    getTask: taskStore ? taskId => taskStore.getTask(taskId) : undefined,
  });
}
