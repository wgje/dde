import type { Connection, Project, Task } from '../models';
import { getUnsafeTaskWriteFields } from '../utils/task-write-payload-integrity';
import type { TaskWriteIntent } from './sync-rpc-client.service';
import type {
  ConnectionPayload,
  ProjectDeletePayload,
  ProjectPayload,
  QueuedAction,
  TaskDeletePayload,
  TaskPayload,
} from './action-queue.types';

export interface PendingLocalActionProjection {
  projects: Project[];
  appliedCount: number;
}

const COMPLETED_SYNC_STATES = new Set(['synced', 'dead_letter']);
const TASK_WRITE_INTENTS = new Set<TaskWriteIntent>([
  'task_full_upsert',
  'task_text_update',
  'task_structure_update',
  'task_soft_delete',
  'task_attachment_update',
]);

function isReplayableProjectAction(action: QueuedAction): action is QueuedAction<ProjectPayload | ProjectDeletePayload> {
  return action.entityType === 'project'
    && !COMPLETED_SYNC_STATES.has(action.syncState ?? '');
}

function isReplayableTaskAction(action: QueuedAction): action is QueuedAction<TaskPayload | TaskDeletePayload> {
  return action.entityType === 'task'
    && !COMPLETED_SYNC_STATES.has(action.syncState ?? '');
}

function isReplayableConnectionAction(action: QueuedAction): action is QueuedAction<ConnectionPayload> {
  return action.entityType === 'connection'
    && !COMPLETED_SYNC_STATES.has(action.syncState ?? '');
}

function resolveDeletedProjectId(action: QueuedAction<ProjectPayload | ProjectDeletePayload>): string {
  const payload = action.payload as Partial<ProjectDeletePayload>;
  return payload.projectId ?? action.entityId;
}

function resolveQueuedProject(action: QueuedAction<ProjectPayload | ProjectDeletePayload>): Project | null {
  const payload = action.payload as Partial<ProjectPayload>;
  return payload.project?.id ? payload.project : null;
}

function upsertProject(projects: Project[], project: Project): Project[] {
  const existingIndex = projects.findIndex(candidate => candidate.id === project.id);
  if (existingIndex === -1) {
    return [...projects, project];
  }

  return projects.map((candidate, index) => index === existingIndex ? project : candidate);
}

function resolveTaskProjectId(action: QueuedAction<TaskPayload | TaskDeletePayload>): string | null {
  const payload = action.payload as Partial<TaskPayload & TaskDeletePayload>;
  return payload.projectId ?? null;
}

interface ResolvedQueuedTask {
  task: Task;
  writeIntent: TaskWriteIntent;
}

function isTaskWriteIntent(value: unknown): value is TaskWriteIntent {
  return typeof value === 'string' && TASK_WRITE_INTENTS.has(value as TaskWriteIntent);
}

function hasRequiredTaskIntentPayload(task: Task, writeIntent: TaskWriteIntent): boolean {
  if (writeIntent === 'task_attachment_update') return Array.isArray(task.attachments);
  if (writeIntent === 'task_soft_delete') return typeof task.deletedAt === 'string' && task.deletedAt.length > 0;
  return true;
}

function resolveQueuedTask(action: QueuedAction<TaskPayload | TaskDeletePayload>): ResolvedQueuedTask | null {
  const payload = action.payload as Partial<TaskPayload>;
  const task = payload.task;
  if (!task?.id || getUnsafeTaskWriteFields(task).length > 0) return null;

  const writeIntent = action.type === 'create' ? 'task_full_upsert' : payload.writeIntent;
  if (!isTaskWriteIntent(writeIntent) || !hasRequiredTaskIntentPayload(task, writeIntent)) return null;
  return { task, writeIntent };
}

function resolveDeletedTaskId(action: QueuedAction<TaskPayload | TaskDeletePayload>): string {
  const payload = action.payload as Partial<TaskDeletePayload>;
  return payload.taskId ?? action.entityId;
}

function mergeTaskByWriteIntent(existing: Task, task: Task, writeIntent: TaskWriteIntent): Task {
  const timestamped = { ...existing, updatedAt: task.updatedAt };
  switch (writeIntent) {
    case 'task_text_update':
      return { ...timestamped, title: task.title, content: task.content };
    case 'task_structure_update':
      return {
        ...timestamped,
        stage: task.stage,
        parentId: task.parentId,
        order: task.order,
        rank: task.rank,
        x: task.x,
        y: task.y,
      };
    case 'task_attachment_update':
      return { ...timestamped, attachments: task.attachments };
    case 'task_soft_delete':
      return { ...timestamped, deletedAt: task.deletedAt };
    case 'task_full_upsert':
      return task;
  }
}

function upsertTask(tasks: Task[], resolved: ResolvedQueuedTask): Task[] {
  const { task, writeIntent } = resolved;
  const existingIndex = tasks.findIndex(candidate => candidate.id === task.id);
  if (existingIndex === -1) {
    return [...tasks, task];
  }

  return tasks.map((candidate, index) => (
    index === existingIndex ? mergeTaskByWriteIntent(candidate, task, writeIntent) : candidate
  ));
}

function applyTaskAction(
  projects: Project[],
  action: QueuedAction<TaskPayload | TaskDeletePayload>,
): { projects: Project[]; applied: boolean } {
  const projectId = resolveTaskProjectId(action);
  if (!projectId) {
    return { projects, applied: false };
  }

  let applied = false;
  const nextProjects = projects.map(project => {
    if (project.id !== projectId) {
      return project;
    }

    applied = true;
    if (action.type === 'delete') {
      const taskId = resolveDeletedTaskId(action);
      return {
        ...project,
        tasks: (project.tasks ?? []).filter(task => task.id !== taskId),
        connections: (project.connections ?? []).filter(connection =>
          connection.source !== taskId && connection.target !== taskId
        ),
      };
    }

    const resolvedTask = resolveQueuedTask(action);
    if (!resolvedTask) {
      applied = false;
      return project;
    }

    return {
      ...project,
      tasks: upsertTask(project.tasks ?? [], resolvedTask),
    };
  });

  return { projects: nextProjects, applied };
}

function resolveConnectionProjectId(action: QueuedAction<ConnectionPayload>): string | null {
  return (action.payload as Partial<ConnectionPayload>).projectId ?? null;
}

function resolveQueuedConnection(action: QueuedAction<ConnectionPayload>): Connection | null {
  const payload = action.payload as Partial<ConnectionPayload>;
  return payload.connection?.id ? payload.connection : null;
}

function upsertConnection(connections: Connection[], connection: Connection): Connection[] {
  const existingIndex = connections.findIndex(candidate => candidate.id === connection.id);
  if (existingIndex === -1) {
    return [...connections, connection];
  }

  return connections.map((candidate, index) => index === existingIndex ? connection : candidate);
}

function applyConnectionAction(
  projects: Project[],
  action: QueuedAction<ConnectionPayload>,
): { projects: Project[]; applied: boolean } {
  const projectId = resolveConnectionProjectId(action);
  if (!projectId) {
    return { projects, applied: false };
  }

  const connection = resolveQueuedConnection(action);
  if (!connection) {
    return { projects, applied: false };
  }

  let applied = false;
  const nextProjects = projects.map(project => {
    if (project.id !== projectId) {
      return project;
    }

    applied = true;
    if (action.type === 'delete') {
      return {
        ...project,
        connections: (project.connections ?? []).filter(candidate => candidate.id !== connection.id),
      };
    }

    return {
      ...project,
      connections: upsertConnection(project.connections ?? [], connection),
    };
  });

  return { projects: nextProjects, applied };
}

export function applyPendingLocalActionsToSnapshot(
  snapshotProjects: Project[],
  actions: QueuedAction[],
): PendingLocalActionProjection {
  let projects = [...snapshotProjects];
  let appliedCount = 0;

  for (const action of actions) {
    if (isReplayableProjectAction(action)) {
      if (action.type === 'delete') {
        projects = projects.filter(project => project.id !== resolveDeletedProjectId(action));
        appliedCount += 1;
        continue;
      }

      const project = resolveQueuedProject(action);
      if (!project) {
        continue;
      }

      projects = upsertProject(projects, project);
      appliedCount += 1;
      continue;
    }

    if (isReplayableTaskAction(action)) {
      const result = applyTaskAction(projects, action);
      projects = result.projects;
      if (result.applied) {
        appliedCount += 1;
      }
      continue;
    }

    if (isReplayableConnectionAction(action)) {
      const result = applyConnectionAction(projects, action);
      projects = result.projects;
      if (result.applied) {
        appliedCount += 1;
      }
    }
  }

  return { projects, appliedCount };
}

export function applyPendingProjectActionsToSnapshot(
  snapshotProjects: Project[],
  actions: QueuedAction[],
): PendingLocalActionProjection {
  return applyPendingLocalActionsToSnapshot(snapshotProjects, actions);
}
