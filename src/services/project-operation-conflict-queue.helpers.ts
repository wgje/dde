import type { ActionPayload, QueuedAction, TaskDeletePayload, TaskPayload } from './action-queue.types';

export function isProjectMutationForProject(action: QueuedAction<ActionPayload>, projectId: string): boolean {
  if (action.entityType === 'project') {
    return action.entityId === projectId;
  }

  if (action.entityType === 'task') {
    return hasTaskProjectPayload(action.payload) && action.payload.projectId === projectId;
  }

  return false;
}

function hasTaskProjectPayload(payload: ActionPayload): payload is TaskPayload | TaskDeletePayload {
  return typeof (payload as { projectId?: unknown }).projectId === 'string';
}
