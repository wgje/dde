/**
 * UserSessionService 的「云端任务正文恢复」纯函数模块。
 *
 * 从 UserSessionService「下切」出的无状态合并助手：当远端任务行缺少 content
 * （列裁剪 / 旧 schema 拉取）时，用本地同 id 任务的正文回填，避免合并后正文丢失。
 *
 * 职责单一、纯函数（无 `this`、无副作用）：
 * - restoreMissingCloudTaskContent：逐个云端任务检查是否缺正文，缺则用本地正文回填，
 *   返回回填后的任务列表与回填计数。
 *
 * 为什么抽离：AGENTS.md §12 单文件 ≤ 800 行硬线；UserSessionService 长期越界，
 * 该纯合并助手自洽且零依赖服务态，适合先行下切。
 */
import { Task } from '../models';
import { hasTaskContentMissingFromSource } from '../utils/task-content-guard';

export function restoreMissingCloudTaskContent(localTasks: Task[], cloudTasks: Task[]): {
  tasks: Task[];
  restoredTaskCount: number;
} {
  const localTasksById = new Map(localTasks.map((task) => [task.id, task] as const));
  let restoredTaskCount = 0;

  const tasks = cloudTasks.map((cloudTask) => {
    if (!hasTaskContentMissingFromSource(cloudTask)) {
      return cloudTask;
    }

    const localTask = localTasksById.get(cloudTask.id);
    if (!localTask || localTask.content === cloudTask.content) {
      return cloudTask;
    }

    restoredTaskCount += 1;
    return {
      ...cloudTask,
      content: localTask.content,
    };
  });

  return { tasks, restoredTaskCount };
}
