/**
 * project-save-freshness
 *
 * 从 SimpleSyncService「下切」出的项目保存新鲜度比较（纯函数）。
 *
 * 用于项目云端持久化「单飞」队列中判定哪个待保存快照更新——纯读取 project 字段，
 * 不依赖任何 `this` 状态，迁出后可独立单测；门面直接调用本模块函数（无需 delegate）。
 */
import type { Project } from '../../../../models';

export interface ProjectSaveFreshness {
  /** 项目自身及其任务/连接的最大 updatedAt/deletedAt 毫秒时间戳 */
  updatedAtMs: number;
  /** 项目版本号 */
  version: number;
}

/** 计算项目保存新鲜度：取项目本体与全部任务/连接的最大时间戳 + 版本号。 */
export function getProjectSaveFreshness(project: Project): ProjectSaveFreshness {
  let updatedAtMs = project.updatedAt ? Date.parse(project.updatedAt) : 0;
  updatedAtMs = Number.isFinite(updatedAtMs) ? updatedAtMs : 0;

  for (const task of project.tasks) {
    const taskUpdatedAtMs = task.updatedAt ? Date.parse(task.updatedAt) : 0;
    const taskDeletedAtMs = task.deletedAt ? Date.parse(task.deletedAt) : 0;
    updatedAtMs = Math.max(
      updatedAtMs,
      Number.isFinite(taskUpdatedAtMs) ? taskUpdatedAtMs : 0,
      Number.isFinite(taskDeletedAtMs) ? taskDeletedAtMs : 0,
    );
  }

  for (const connection of project.connections) {
    const connectionUpdatedAtMs = connection.updatedAt ? Date.parse(connection.updatedAt) : 0;
    const connectionDeletedAtMs = connection.deletedAt ? Date.parse(connection.deletedAt) : 0;
    updatedAtMs = Math.max(
      updatedAtMs,
      Number.isFinite(connectionUpdatedAtMs) ? connectionUpdatedAtMs : 0,
      Number.isFinite(connectionDeletedAtMs) ? connectionDeletedAtMs : 0,
    );
  }

  return {
    updatedAtMs,
    version: project.version ?? 0,
  };
}

/**
 * 候选快照是否比当前快照更新：先比最大时间戳，再比版本号；
 * 完全相等时返回 true（保留「后到覆盖」语义，与历史实现一致）。
 */
export function isProjectSaveNewer(candidate: Project, current: Project): boolean {
  const candidateFreshness = getProjectSaveFreshness(candidate);
  const currentFreshness = getProjectSaveFreshness(current);

  if (candidateFreshness.updatedAtMs !== currentFreshness.updatedAtMs) {
    return candidateFreshness.updatedAtMs > currentFreshness.updatedAtMs;
  }

  if (candidateFreshness.version !== currentFreshness.version) {
    return candidateFreshness.version > currentFreshness.version;
  }

  return true;
}
