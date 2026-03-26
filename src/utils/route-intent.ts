import type { LaunchRouteIntent } from '../models/launch-shell';

/**
 * 从 URL 路径解析路由意图（项目列表 / 项目 / 文本 / 流程图 / 任务深链接）。
 * 供 LaunchSnapshotService 和 HandoffCoordinatorService 共用，
 * 避免正则逻辑重复维护。
 */
export function resolveRouteIntent(
  routeUrl: string | null,
  activeProjectId: string | null,
): LaunchRouteIntent {
  if (!routeUrl) {
    return {
      kind: activeProjectId ? 'project' : 'projects',
      projectId: activeProjectId,
      taskId: null,
    };
  }

  const taskMatch = routeUrl.match(/\/projects\/([^/?#]+)\/task\/([^/?#]+)/);
  if (taskMatch) {
    return { kind: 'task', projectId: taskMatch[1], taskId: taskMatch[2] };
  }

  const flowMatch = routeUrl.match(/\/projects\/([^/?#]+)\/flow$/);
  if (flowMatch) {
    return { kind: 'flow', projectId: flowMatch[1], taskId: null };
  }

  const textMatch = routeUrl.match(/\/projects\/([^/?#]+)\/text$/);
  if (textMatch) {
    return { kind: 'text', projectId: textMatch[1], taskId: null };
  }

  const projectMatch = routeUrl.match(/\/projects\/([^/?#]+)$/);
  if (projectMatch) {
    return { kind: 'project', projectId: projectMatch[1], taskId: null };
  }

  return { kind: 'projects', projectId: activeProjectId, taskId: null };
}
