import type { ProjectChangeSummary } from '../../../../services/change-tracker.types';
import type { Project } from '../../../../models';

export function setVisibilityState(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: state,
  });
}

export function createProject(overrides: Partial<Project> = {}): Project {
  const now = '2026-03-31T00:00:00.000Z';
  return {
    id: overrides.id ?? 'project-1',
    name: overrides.name ?? 'Project 1',
    description: overrides.description ?? '',
    createdDate: overrides.createdDate ?? now,
    updatedAt: overrides.updatedAt ?? now,
    version: overrides.version ?? 1,
    tasks: overrides.tasks ?? [],
    connections: overrides.connections ?? [],
    ...overrides,
  };
}

export function createProjectChanges(
  overrides: Partial<ProjectChangeSummary> = {},
): ProjectChangeSummary {
  return {
    projectId: overrides.projectId ?? 'project-1',
    tasksToCreate: overrides.tasksToCreate ?? [],
    tasksToUpdate: overrides.tasksToUpdate ?? [],
    taskIdsToDelete: overrides.taskIdsToDelete ?? [],
    taskDeleteBaseUpdatedAtMap: overrides.taskDeleteBaseUpdatedAtMap ?? {},
    connectionsToCreate: overrides.connectionsToCreate ?? [],
    connectionsToUpdate: overrides.connectionsToUpdate ?? [],
    connectionsToDelete: overrides.connectionsToDelete ?? [],
    hasChanges: overrides.hasChanges ?? true,
    totalChanges: overrides.totalChanges ?? 0,
    taskUpdateFieldsById: overrides.taskUpdateFieldsById ?? {},
  };
}
