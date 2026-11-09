/**
 * project-save-keys
 *
 * 从 SimpleSyncService「下切」出的项目保存「单飞身份层」（纯函数）。
 *
 * - 单飞键：同一 (userId, projectId) 的保存请求合并到同一条飞行队列
 * - 变更签名：用于判定排队中的保存请求是否与当前请求等价（可复用进行中的飞行）
 *
 * 两者均为纯函数，迁出后可独立单测；门面直接调用本模块函数。
 */
import type { Project } from '../../../../models';

type TaskDeleteBaseUpdatedAtMap = Record<string, string | null | undefined>;

/** 构造项目保存单飞键：`${userId}:${projectId}`。 */
export function buildProjectSaveFlightKey(projectId: string, userId: string): string {
  return `${userId}:${projectId}`;
}

/**
 * 构造项目保存变更签名：稳定序列化 project + 排序后的待删除任务 id 列表 + 删除 CAS base map。
 * 用于比较两次保存请求是否等价（签名相同即可复用进行中的飞行）。
 */
export function buildProjectSaveSignature(
  project: Project,
  taskIdsToDelete?: string[],
  taskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap,
): string {
  const normalizedTaskIdsToDelete = [...(taskIdsToDelete ?? [])].sort();
  const normalizedTaskDeleteBaseUpdatedAtMap = normalizeTaskDeleteBaseUpdatedAtMap(taskDeleteBaseUpdatedAtMap);
  return JSON.stringify({
    project,
    taskIdsToDelete: normalizedTaskIdsToDelete,
    taskDeleteBaseUpdatedAtMap: normalizedTaskDeleteBaseUpdatedAtMap,
  });
}

function normalizeTaskDeleteBaseUpdatedAtMap(
  map: TaskDeleteBaseUpdatedAtMap | undefined,
): Array<[string, string | null]> {
  return Object.entries(map ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([taskId, baseUpdatedAt]) => [taskId, baseUpdatedAt ?? null]);
}
