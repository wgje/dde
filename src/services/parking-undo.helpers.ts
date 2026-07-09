import type { Project } from '../models';

export function collectParkUndoProjectIds(
  taskIds: Array<string | null>,
  findProjectId: (taskId: string) => string | null
): string[] {
  const projectIds: string[] = [];
  const seen = new Set<string>();

  for (const taskId of taskIds) {
    if (!taskId) continue;
    const projectId = findProjectId(taskId);
    if (!projectId || seen.has(projectId)) continue;
    seen.add(projectId);
    projectIds.push(projectId);
  }

  return projectIds;
}

export function hasProjectSnapshotChanged(before: Partial<Project>, after: Partial<Project>): boolean {
  const beforeTasks = before.tasks ?? [];
  const afterTasks = after.tasks ?? [];
  if (beforeTasks.length !== afterTasks.length) return true;

  const beforeConnections = before.connections ?? [];
  const afterConnections = after.connections ?? [];
  if (beforeConnections.length !== afterConnections.length) return true;

  return JSON.stringify(beforeTasks) !== JSON.stringify(afterTasks)
    || JSON.stringify(beforeConnections) !== JSON.stringify(afterConnections);
}
