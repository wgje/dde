import type { Connection, Project, Task } from '../../../../models';

export interface ProjectSavePlanInput {
  taskIds: string[];
  connectionIds: string[];
  taskIdsToDelete: string[];
  connectionIdsToDelete: string[];
}

export interface ProjectSavePlan {
  taskUpsertIds: string[];
  taskDeleteIds: string[];
  connectionUpsertIds: string[];
  connectionDeleteIds: string[];
}

export interface ProjectSaveFailureInput {
  projectId: string;
  failedTaskIds: string[];
  failedConnectionIds: string[];
  retryEnqueued: string[];
  terminalTaskIds: string[];
  terminalConnectionIds: string[];
  projectPushed: boolean;
}

export interface ProjectSaveFailureClassification {
  failedTaskIds: string[];
  failedConnectionIds: string[];
  retryEnqueued: string[];
  hasTerminalConflicts: boolean;
  fullyResolved: boolean;
  partialRetryHandoff: boolean;
  failureReason: string;
}

export interface ProjectSaveChangeSummary {
  tasksToCreate: Pick<Task, 'id'>[];
  tasksToUpdate: Pick<Task, 'id'>[];
  taskIdsToDelete: string[];
  connectionsToCreate: Pick<Connection, 'id'>[];
  connectionsToUpdate: Pick<Connection, 'id'>[];
  connectionsToDelete: Pick<Connection, 'id'>[];
}

export interface ProjectSavePreparationInput {
  project: Project;
  changes: ProjectSaveChangeSummary;
  pendingTaskIdsToDelete: string[];
}

export interface ProjectSavePreparation {
  snapshot: Project;
  savePlan: ProjectSavePlan;
  changedTaskIds: Set<string>;
  changedConnectionIds: Set<string>;
  taskSnapshotById: Map<string, Task>;
  connectionSnapshotById: Map<string, Connection>;
}

export interface RemoteExistingTaskIdsQueryFailureInput {
  browserSuspendedError: boolean;
  browserSuspendedWindow: boolean;
}

export type RemoteExistingTaskIdsQueryFailureDecision =
  | { kind: 'defer-by-suspension' }
  | { kind: 'fallback-local-success-set' };

export interface RefreshedProjectSaveSessionInput {
  expectedUserId: string;
  sessionUserId: string | null;
  browserSuspendedWindow: boolean;
}

export type RefreshedProjectSaveSessionDecision =
  | { kind: 'continue' }
  | { kind: 'defer-by-suspension' }
  | { kind: 'session-expired' }
  | { kind: 'owner-mismatch' };

export interface PositionOnlyTaskPushFailureInput {
  browserSuspendedWindow: boolean;
}

export type PositionOnlyTaskPushFailureDecision =
  | { kind: 'defer-by-suspension' }
  | { kind: 'fallback-full-upsert' };

export interface ConnectionPushResultInput {
  success: boolean;
  retryEnqueued?: boolean;
}

export type ConnectionPushResultDecision =
  | { kind: 'clear-success' }
  | { kind: 'record-failure'; retryEnqueued: boolean };

function unique(ids: string[]): string[] {
  return Array.from(new Set(ids));
}

export function createProjectSaveSnapshot(project: Project): Project {
  return {
    ...project,
    tasks: project.tasks.map(task => ({ ...task })),
    connections: project.connections.map(connection => ({ ...connection })),
  };
}

export function buildProjectSavePlan(input: ProjectSavePlanInput): ProjectSavePlan {
  const taskDeleteIds = unique(input.taskIdsToDelete);
  const connectionDeleteIds = unique(input.connectionIdsToDelete);
  const taskDeleteIdSet = new Set(taskDeleteIds);
  const connectionDeleteIdSet = new Set(connectionDeleteIds);

  return {
    taskUpsertIds: input.taskIds.filter(id => !taskDeleteIdSet.has(id)),
    taskDeleteIds,
    connectionUpsertIds: input.connectionIds.filter(id => !connectionDeleteIdSet.has(id)),
    connectionDeleteIds,
  };
}

export function buildProjectSavePreparation(input: ProjectSavePreparationInput): ProjectSavePreparation {
  const snapshot = createProjectSaveSnapshot(input.project);
  const savePlan = buildProjectSavePlan({
    taskIds: snapshot.tasks.map(task => task.id),
    connectionIds: snapshot.connections.map(connection => connection.id),
    taskIdsToDelete: input.pendingTaskIdsToDelete,
    connectionIdsToDelete: snapshot.connections
      .filter(connection => !!connection.deletedAt)
      .map(connection => connection.id),
  });

  return {
    snapshot,
    savePlan,
    changedTaskIds: new Set([
      ...input.changes.tasksToCreate.map(task => task.id),
      ...input.changes.tasksToUpdate.map(task => task.id),
      ...input.changes.taskIdsToDelete,
    ]),
    changedConnectionIds: new Set([
      ...input.changes.connectionsToCreate.map(connection => connection.id),
      ...input.changes.connectionsToUpdate.map(connection => connection.id),
      ...input.changes.connectionsToDelete.map(connection => connection.id),
    ]),
    taskSnapshotById: new Map(snapshot.tasks.map(task => [task.id, task])),
    connectionSnapshotById: new Map(snapshot.connections.map(connection => [connection.id, connection])),
  };
}

export function decideRemoteExistingTaskIdsQueryFailure(
  input: RemoteExistingTaskIdsQueryFailureInput,
): RemoteExistingTaskIdsQueryFailureDecision {
  return input.browserSuspendedError || input.browserSuspendedWindow
    ? { kind: 'defer-by-suspension' }
    : { kind: 'fallback-local-success-set' };
}

export function decideRefreshedProjectSaveSession(
  input: RefreshedProjectSaveSessionInput,
): RefreshedProjectSaveSessionDecision {
  if (input.sessionUserId === input.expectedUserId) {
    return { kind: 'continue' };
  }

  if (!input.sessionUserId) {
    return input.browserSuspendedWindow
      ? { kind: 'defer-by-suspension' }
      : { kind: 'session-expired' };
  }

  return { kind: 'owner-mismatch' };
}

export function decidePositionOnlyTaskPushFailure(
  input: PositionOnlyTaskPushFailureInput,
): PositionOnlyTaskPushFailureDecision {
  return input.browserSuspendedWindow
    ? { kind: 'defer-by-suspension' }
    : { kind: 'fallback-full-upsert' };
}

export function decideConnectionPushResult(
  input: ConnectionPushResultInput,
): ConnectionPushResultDecision {
  return input.success
    ? { kind: 'clear-success' }
    : { kind: 'record-failure', retryEnqueued: input.retryEnqueued === true };
}

export function classifyProjectSaveFailures(input: ProjectSaveFailureInput): ProjectSaveFailureClassification {
  const failedTaskIds = unique(input.failedTaskIds);
  const failedConnectionIds = unique(input.failedConnectionIds);
  const retryEnqueued = unique(input.retryEnqueued);
  const terminalTaskIds = new Set(input.terminalTaskIds);
  const terminalConnectionIds = new Set(input.terminalConnectionIds);
  const retryEnqueuedSet = new Set(retryEnqueued);

  const hasTerminalConflicts =
    failedTaskIds.some(id => terminalTaskIds.has(id)) ||
    failedConnectionIds.some(id => terminalConnectionIds.has(id));
  const allTasksResolved = failedTaskIds.every(
    id => retryEnqueuedSet.has(`task:${id}`) || terminalTaskIds.has(id),
  );
  const allConnectionsResolved = failedConnectionIds.every(
    id => retryEnqueuedSet.has(`connection:${id}`) || terminalConnectionIds.has(id),
  );
  const projectHandedOff = input.projectPushed || retryEnqueuedSet.has(`project:${input.projectId}`);
  const fullyResolved = projectHandedOff && allTasksResolved && allConnectionsResolved;

  return {
    failedTaskIds,
    failedConnectionIds,
    retryEnqueued,
    hasTerminalConflicts,
    fullyResolved,
    partialRetryHandoff: !fullyResolved,
    failureReason: hasTerminalConflicts
      ? fullyResolved
        ? 'project batch sync finished with terminal conflicts'
        : 'project batch sync finished with terminal conflicts and partial retry handoff'
      : fullyResolved
        ? 'project batch sync delegated remaining work to retry queue'
        : 'project batch sync partially delegated; some failures did not enter retry queue',
  };
}
