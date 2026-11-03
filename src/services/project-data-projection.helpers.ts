import type { Project } from '../models';

export function normalizeOfflineSnapshotProject(project: Project): Project {
  const allTasks = project.tasks || [];
  // Keep soft-deleted tasks during the retention window, but do not restore their visible edges.
  const activeTaskIds = new Set(
    allTasks
      .filter(task => !task.deletedAt)
      .map(task => task.id)
  );

  return {
    ...project,
    tasks: allTasks,
    connections: (project.connections || []).filter(connection =>
      activeTaskIds.has(connection.source) && activeTaskIds.has(connection.target)
    ),
  };
}
