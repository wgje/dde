import { ConnectionPayload, QueuedAction, TaskDeletePayload, TaskPayload } from './action-queue.types';

export function getActionsForEntity(
  queue: QueuedAction[],
  entityType: string,
  entityId: string,
): QueuedAction[] {
  return queue.filter(action => action.entityType === entityType && action.entityId === entityId);
}

export function getPendingActionsForProject(queue: QueuedAction[], projectId: string): QueuedAction[] {
  return queue.filter(action => {
    if (action.entityType === 'project' && action.entityId === projectId) {
      return true;
    }
    if (action.entityType === 'task') {
      const payload = action.payload as TaskPayload | TaskDeletePayload;
      return 'projectId' in payload && payload.projectId === projectId;
    }
    if (action.entityType === 'connection') {
      const payload = action.payload as ConnectionPayload;
      return payload.projectId === projectId;
    }
    return false;
  });
}

export function hasUncompletedCreate(
  queue: QueuedAction[],
  entityType: string,
  entityId: string,
): boolean {
  return queue.some(action =>
    action.entityType === entityType &&
    action.entityId === entityId &&
    action.type === 'create'
  );
}

export function getBlockedActions(queue: QueuedAction[]): QueuedAction[] {
  const blocked: QueuedAction[] = [];

  for (const action of queue) {
    if (action.type === 'create') continue;

    if (hasUncompletedCreate(queue, action.entityType, action.entityId)) {
      blocked.push(action);
    }
  }

  return blocked;
}

export function shouldDiscardAfterProjectDeleteSuccess(
  action: QueuedAction,
  projectId: string,
  successfulDeleteActionId?: string,
): boolean {
  if (successfulDeleteActionId && action.id === successfulDeleteActionId) {
    return false;
  }

  if (action.entityType === 'project' && action.entityId === projectId) {
    return true;
  }

  if (action.entityType === 'task') {
    const payload = action.payload as TaskPayload | TaskDeletePayload;
    return payload.projectId === projectId;
  }

  if (action.entityType === 'connection') {
    const payload = action.payload as ConnectionPayload;
    return payload.projectId === projectId;
  }

  return false;
}
