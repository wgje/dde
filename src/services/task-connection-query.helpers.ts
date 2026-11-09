import type { Project, Task } from '../models';

export interface TaskConnectionQueryResult {
  outgoing: { targetId: string; targetTask: Task | undefined; description?: string }[];
  incoming: { sourceId: string; sourceTask: Task | undefined; description?: string }[];
}

export function getTaskConnections(project: Project | null, taskId: string): TaskConnectionQueryResult {
  if (!project) {
    return { outgoing: [], incoming: [] };
  }

  const taskMap = new Map(project.tasks.map(task => [task.id, task] as const));
  const parentChildPairs = new Set(
    project.tasks
      .filter(task => task.parentId)
      .map(task => `${task.parentId}->${task.id}`),
  );

  return {
    outgoing: project.connections
      .filter(connection => connection.source === taskId && !parentChildPairs.has(`${connection.source}->${connection.target}`))
      .map(connection => ({
        targetId: connection.target,
        targetTask: taskMap.get(connection.target),
        description: connection.description,
      })),
    incoming: project.connections
      .filter(connection => connection.target === taskId && !parentChildPairs.has(`${connection.source}->${connection.target}`))
      .map(connection => ({
        sourceId: connection.source,
        sourceTask: taskMap.get(connection.source),
        description: connection.description,
      })),
  };
}
