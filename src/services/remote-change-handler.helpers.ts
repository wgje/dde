import { isSameRevision } from '../app/core/state/store-data-safety.helpers';
import type { Connection, Project, Task } from '../models';

export interface RemoteProjectDeletionSets {
  deletedTaskIds: Set<string>;
  deletedConnectionIds: Set<string>;
}

export type RemoteConnectionDeletionGuard = ReadonlyMap<string, Connection | undefined>;

export interface SkipRemoteProjectUpdateInput {
  isEditing: boolean;
  hasPendingLocalChanges: boolean;
  now: number;
  lastPersistAt: number;
  guardMs: number;
}

export interface SkipRemoteProjectUpdateResult {
  shouldSkip: boolean;
  timeSinceLastPersist: number;
  inEditGuard: boolean;
}

export interface SkipRemoteTaskUpdateInput {
  now: number;
  lastPersistAt: number;
  echoProtectionMs: number;
}

export interface TaskFreshnessInput {
  localTask: Pick<Task, 'updatedAt'> | null | undefined;
  remoteTask: Pick<Task, 'updatedAt'>;
}

export interface LocalDeleteProtectionInput {
  localTask: Pick<Task, 'deletedAt'>;
  remoteTask: Pick<Task, 'deletedAt' | 'updatedAt'>;
}

export interface ShouldAddRemoteTaskInput {
  taskId: string;
  pendingChangeType?: string | null;
  tombstoneIds: Set<string>;
}

export type ShouldAddRemoteTaskResult =
  | { shouldAdd: true; reason: 'allowed' }
  | { shouldAdd: false; reason: 'pending-delete' | 'tombstone' };

export interface BuildRemoteTaskDirtyFieldsInput {
  pendingChangedFields?: Iterable<string> | null;
  lockedFields?: Iterable<string> | null;
  localTask: Pick<Task, 'updatedAt'>;
  remoteTask: Pick<Task, 'updatedAt'>;
  isEditing: boolean;
}

export interface MergeRemoteTaskWithLocalDirtyFieldsInput {
  localTask: Task;
  remoteTask: Task;
  dirtyFields: Iterable<string>;
}

export interface MergeRemoteTaskWithLocalDirtyFieldsResult {
  task: Task;
  copiedFields: string[];
  protectedDeletedAt: boolean;
}

export interface ResolveRemoteTaskTargetProjectInput {
  eventType: 'INSERT' | 'UPDATE' | 'DELETE';
  taskId: string;
  projectId: string | null | undefined;
  projects: Array<Pick<Project, 'id' | 'tasks'>>;
}

export type ResolveRemoteTaskTargetProjectResult =
  | { targetProjectId: string; source: 'payload' | 'local-project-search' }
  | { targetProjectId: null; reason: 'missing-project-id' | 'delete-task-not-found' };

export interface RemoveRemoteTaskFromProjectResult {
  project: Project;
  removed: boolean;
  remainingTasks: number;
}

export interface RemoteTaskDeletionDecisionInput {
  localTask?: Pick<Task, 'updatedAt'> | null;
  tombstonePresent: boolean;
  tombstoneDeletedAt?: number;
}

export type RemoteTaskDeletionDecision =
  | { shouldDelete: true; reason: 'confirmed-tombstone' }
  | {
      shouldDelete: false;
      reason: 'missing-tombstone' | 'missing-tombstone-timestamp' | 'local-newer-than-tombstone';
    };

export interface CanApplyRemoteTaskUpdateResultInput {
  requestId: number;
  currentRequestId: number;
  isDestroyed: boolean;
  activeProjectId: string | null;
  originalProjectId: string | null;
}

export type CanApplyRemoteTaskUpdateResult =
  | { canApply: true }
  | { canApply: false; reason: 'superseded' | 'destroyed' | 'project-switched' };

const LWW_PROTECTED_TASK_FIELDS = ['status', 'stage', 'parentId', 'rank', 'order', 'title', 'content', 'deletedAt'] as const;

export function shouldSkipRemoteProjectUpdate(input: SkipRemoteProjectUpdateInput): SkipRemoteProjectUpdateResult {
  const timeSinceLastPersist = input.now - input.lastPersistAt;
  const inEditGuard = timeSinceLastPersist < input.guardMs;
  return {
    shouldSkip: input.isEditing || input.hasPendingLocalChanges || inEditGuard,
    timeSinceLastPersist,
    inEditGuard,
  };
}

export function shouldSkipRemoteTaskUpdate(input: SkipRemoteTaskUpdateInput): boolean {
  return input.now - input.lastPersistAt < input.echoProtectionMs;
}

export function decideRemoteTaskDeletion(
  input: RemoteTaskDeletionDecisionInput,
): RemoteTaskDeletionDecision {
  if (!input.tombstonePresent) {
    return { shouldDelete: false, reason: 'missing-tombstone' };
  }
  if (!Number.isFinite(input.tombstoneDeletedAt)) {
    return { shouldDelete: false, reason: 'missing-tombstone-timestamp' };
  }

  const localUpdatedAt = input.localTask?.updatedAt
    ? Date.parse(input.localTask.updatedAt)
    : Number.NaN;
  if (Number.isFinite(localUpdatedAt) && localUpdatedAt > input.tombstoneDeletedAt!) {
    return { shouldDelete: false, reason: 'local-newer-than-tombstone' };
  }

  return { shouldDelete: true, reason: 'confirmed-tombstone' };
}

export function collectRemoteProjectDeletionSets(remoteProject: Project): RemoteProjectDeletionSets {
  return {
    deletedTaskIds: new Set((remoteProject.tasks || []).filter(t => t.deletedAt).map(t => t.id)),
    deletedConnectionIds: new Set((remoteProject.connections || []).filter(c => c.deletedAt).map(c => c.id)),
  };
}

export function captureRemoteConnectionDeletionGuard(
  project: Pick<Project, 'connections'>,
  deletionSets: Pick<RemoteProjectDeletionSets, 'deletedConnectionIds'>,
): RemoteConnectionDeletionGuard {
  const connectionsById = new Map(project.connections.map(connection => [connection.id, connection]));
  return new Map(Array.from(deletionSets.deletedConnectionIds, connectionId => {
    const connection = connectionsById.get(connectionId);
    return [connectionId, connection ? { ...connection } : undefined] as const;
  }));
}

export function isRemoteConnectionDeletionStillCurrent(
  guard: RemoteConnectionDeletionGuard,
  currentConnection: Connection,
): boolean {
  return guard.has(currentConnection.id)
    && isSameRevision(guard.get(currentConnection.id), currentConnection);
}

export function removeDeletedRecords(remoteProject: Project): Project {
  return {
    ...remoteProject,
    tasks: (remoteProject.tasks || []).filter(t => !t.deletedAt),
    connections: (remoteProject.connections || []).filter(c => !c.deletedAt),
  };
}

export function removeRemoteTaskFromProject(project: Project, taskId: string): RemoveRemoteTaskFromProjectResult {
  const tasks = project.tasks.filter(task => task.id !== taskId);
  if (tasks.length === project.tasks.length) {
    return {
      project,
      removed: false,
      remainingTasks: project.tasks.length,
    };
  }

  return {
    project: {
      ...project,
      tasks,
    },
    removed: true,
    remainingTasks: tasks.length,
  };
}

export function shouldSkipStaleRemoteTask(input: TaskFreshnessInput): boolean {
  if (!input.localTask?.updatedAt || !input.remoteTask.updatedAt) {
    return false;
  }

  const localTime = new Date(input.localTask.updatedAt).getTime();
  const remoteTime = new Date(input.remoteTask.updatedAt).getTime();
  return remoteTime <= localTime;
}

export function shouldKeepLocalDeletedTask(input: LocalDeleteProtectionInput): boolean {
  if (!input.localTask.deletedAt || input.remoteTask.deletedAt) {
    return false;
  }

  const localDeleteTime = new Date(input.localTask.deletedAt).getTime();
  const remoteUpdateTime = input.remoteTask.updatedAt ? new Date(input.remoteTask.updatedAt).getTime() : 0;
  return localDeleteTime > remoteUpdateTime;
}

export function shouldAddRemoteTask(input: ShouldAddRemoteTaskInput): ShouldAddRemoteTaskResult {
  if (input.pendingChangeType === 'delete') {
    return { shouldAdd: false, reason: 'pending-delete' };
  }

  if (input.tombstoneIds.has(input.taskId)) {
    return { shouldAdd: false, reason: 'tombstone' };
  }

  return { shouldAdd: true, reason: 'allowed' };
}

export function buildRemoteTaskDirtyFields(input: BuildRemoteTaskDirtyFieldsInput): Set<string> {
  const dirtyFields = new Set(input.pendingChangedFields ?? []);
  for (const field of input.lockedFields ?? []) {
    dirtyFields.add(field);
  }

  const localTime = input.localTask.updatedAt ? new Date(input.localTask.updatedAt).getTime() : 0;
  const remoteTime = input.remoteTask.updatedAt ? new Date(input.remoteTask.updatedAt).getTime() : 0;
  if (localTime >= remoteTime) {
    for (const field of LWW_PROTECTED_TASK_FIELDS) {
      dirtyFields.add(field);
    }
  }

  if (input.isEditing) {
    dirtyFields.add('title');
    dirtyFields.add('content');
  }

  return dirtyFields;
}

export function mergeRemoteTaskWithLocalDirtyFields(
  input: MergeRemoteTaskWithLocalDirtyFieldsInput,
): MergeRemoteTaskWithLocalDirtyFieldsResult {
  const merged: Record<string, unknown> = { ...input.remoteTask };
  const copiedFields: string[] = [];
  for (const field of input.dirtyFields) {
    if (field in input.localTask) {
      merged[field] = input.localTask[field as keyof Task];
      copiedFields.push(field);
    }
  }

  const protectedDeletedAt = Boolean(input.remoteTask.deletedAt || input.localTask.deletedAt);
  if (protectedDeletedAt) {
    merged.deletedAt = input.remoteTask.deletedAt || input.localTask.deletedAt;
  }

  return {
    task: merged as unknown as Task,
    copiedFields,
    protectedDeletedAt,
  };
}

export function resolveRemoteTaskTargetProject(
  input: ResolveRemoteTaskTargetProjectInput,
): ResolveRemoteTaskTargetProjectResult {
  if (input.projectId) {
    return { targetProjectId: input.projectId, source: 'payload' };
  }

  if (input.eventType !== 'DELETE') {
    return { targetProjectId: null, reason: 'missing-project-id' };
  }

  const project = input.projects.find(item => item.tasks.some(task => task.id === input.taskId));
  if (!project) {
    return { targetProjectId: null, reason: 'delete-task-not-found' };
  }

  return { targetProjectId: project.id, source: 'local-project-search' };
}

export function canApplyRemoteTaskUpdateResult(
  input: CanApplyRemoteTaskUpdateResultInput,
): CanApplyRemoteTaskUpdateResult {
  if (input.requestId !== input.currentRequestId) {
    return { canApply: false, reason: 'superseded' };
  }

  if (input.isDestroyed) {
    return { canApply: false, reason: 'destroyed' };
  }

  if (input.activeProjectId !== input.originalProjectId) {
    return { canApply: false, reason: 'project-switched' };
  }

  return { canApply: true };
}
