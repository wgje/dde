import type { Connection, Project, Task } from '../models';
import type { EnqueueParams } from './action-queue.types';
import { TRACKED_CONNECTION_FIELDS, TRACKED_TASK_FIELDS } from './task-record-tracking-fields';

interface TaskRecordOutboxLogger {
  warn(message: string, data?: Record<string, unknown>): void;
  debug(message: string, data?: Record<string, unknown>): void;
}

export interface TaskRecordTrackingOutboxContext {
  sourceUserId: string | null | undefined;
  logger: TaskRecordOutboxLogger;
}

export interface CollectTaskRecordTrackingOutboxActionsInput {
  project: Project;
  beforeTaskMap: Map<string, Task>;
  beforeConnectionMap: Map<string, Connection>;
  sourceUserId: string | null | undefined;
  logger: TaskRecordOutboxLogger;
}

export interface HasTaskRecordTrackingOutboxMutationsInput {
  project: Project;
  beforeTaskMap: Map<string, Task>;
  beforeConnectionMap: Map<string, Connection>;
  logger: TaskRecordOutboxLogger;
}

export interface HasMissingRecoverableTaskRecordTrackingOutboxIntentInput
  extends HasTaskRecordTrackingOutboxMutationsInput {
  outboxActions: EnqueueParams[];
}

export function collectTaskRecordTrackingOutboxActions({
  project,
  beforeTaskMap,
  beforeConnectionMap,
  sourceUserId,
  logger,
}: CollectTaskRecordTrackingOutboxActionsInput): EnqueueParams[] {
  return [
    ...collectTaskOutboxActions(project, beforeTaskMap, sourceUserId, logger),
    ...collectConnectionOutboxActions(project, beforeConnectionMap, sourceUserId, logger),
  ];
}

export function buildTaskRecordTrackingTaskOutboxAction(
  project: Project,
  type: 'create' | 'update',
  task: Task,
  context: TaskRecordTrackingOutboxContext,
): EnqueueParams | null {
  return buildTaskOutboxAction(project, type, task, context.sourceUserId, context.logger);
}

export function buildTaskRecordTrackingTaskDeleteOutboxAction(
  project: Project,
  taskId: string,
  baseUpdatedAt: string | null | undefined,
  context: TaskRecordTrackingOutboxContext,
): EnqueueParams | null {
  return buildTaskDeleteOutboxAction(project, taskId, context.sourceUserId, context.logger, baseUpdatedAt);
}

export function buildTaskRecordTrackingConnectionOutboxAction(
  project: Project,
  type: 'create' | 'update' | 'delete',
  connection: Connection,
  context: TaskRecordTrackingOutboxContext,
): EnqueueParams | null {
  return buildConnectionOutboxAction(project, type, connection, context.sourceUserId, context.logger);
}

export function hasTaskRecordTrackingOutboxMutations({
  project,
  beforeTaskMap,
  beforeConnectionMap,
  logger,
}: HasTaskRecordTrackingOutboxMutationsInput): boolean {
  if (project.syncSource === 'local-only') {
    return false;
  }

  const afterTaskIds = new Set<string>();
  for (const task of project.tasks) {
    afterTaskIds.add(task.id);
    const beforeTask = beforeTaskMap.get(task.id);
    if (!beforeTask || getTaskRecordChangedFields(beforeTask, task).length > 0) {
      return true;
    }
  }

  for (const taskId of beforeTaskMap.keys()) {
    if (!afterTaskIds.has(taskId)) {
      return true;
    }
  }

  return hasTrackedConnectionMutations(project, beforeConnectionMap, logger);
}

export function hasMissingRecoverableTaskRecordTrackingOutboxIntent({
  project,
  beforeTaskMap,
  beforeConnectionMap,
  outboxActions,
  logger,
}: HasMissingRecoverableTaskRecordTrackingOutboxIntentInput): boolean {
  return outboxActions.length === 0 && hasTaskRecordTrackingOutboxMutations({
    project,
    beforeTaskMap,
    beforeConnectionMap,
    logger,
  });
}

export function createTaskRecordTrackingConnectionTombstone(connection: Connection): Connection {
  return createConnectionTombstone(connection);
}

export function getTaskRecordChangedFields(before: Task, after: Task): string[] {
  const fields = TRACKED_TASK_FIELDS.filter(field => before[field] !== after[field]);

  if (stringArrayChanged(before.tags, after.tags)) fields.push('tags');
  if (attachmentsChanged(before, after)) fields.push('attachments');
  if (jsonFieldChanged(before.attentionMeta ?? null, after.attentionMeta ?? null)) {
    fields.push('attentionMeta');
  }

  return fields;
}

function collectTaskOutboxActions(
  project: Project,
  beforeTaskMap: Map<string, Task>,
  sourceUserId: string | null | undefined,
  logger: TaskRecordOutboxLogger,
): EnqueueParams[] {
  const actions: EnqueueParams[] = [];
  const afterTaskIds = new Set<string>();

  for (const task of project.tasks) {
    afterTaskIds.add(task.id);
    const beforeTask = beforeTaskMap.get(task.id);
    const action = !beforeTask
      ? buildTaskOutboxAction(project, 'create', task, sourceUserId, logger)
      : buildChangedTaskOutboxAction(project, beforeTask, task, sourceUserId, logger);
    if (action) actions.push(action);
  }

  for (const [taskId, beforeTask] of beforeTaskMap) {
    if (!afterTaskIds.has(taskId)) {
      const action = buildTaskDeleteOutboxAction(project, taskId, sourceUserId, logger, beforeTask.updatedAt);
      if (action) actions.push(action);
    }
  }

  return actions;
}

function buildChangedTaskOutboxAction(
  project: Project,
  beforeTask: Task,
  task: Task,
  sourceUserId: string | null | undefined,
  logger: TaskRecordOutboxLogger,
): EnqueueParams | null {
  const changedFields = getTaskRecordChangedFields(beforeTask, task);
  if (changedFields.length === 0) return null;

  return !beforeTask.deletedAt && !!task.deletedAt
    ? buildTaskDeleteOutboxAction(project, task.id, sourceUserId, logger, beforeTask.updatedAt)
    : buildTaskOutboxAction(project, 'update', task, sourceUserId, logger);
}

function buildTaskOutboxAction(
  project: Project,
  type: 'create' | 'update',
  task: Task,
  sourceUserId: string | null | undefined,
  logger: TaskRecordOutboxLogger,
): EnqueueParams | null {
  if (!sourceUserId) {
    logger.warn('任务变更未写入 ActionQueue：用户认证状态尚未就绪', {
      projectId: project.id,
      taskId: task.id,
      type,
    });
    return null;
  }

  if (project.syncSource === 'local-only') {
    logger.debug('local-only 项目跳过任务 ActionQueue 入队', {
      projectId: project.id,
      taskId: task.id,
      type,
    });
    return null;
  }

  return {
    type,
    entityType: 'task',
    entityId: task.id,
    payload: {
      task,
      projectId: project.id,
      sourceUserId,
    },
  };
}

function buildTaskDeleteOutboxAction(
  project: Project,
  taskId: string,
  sourceUserId: string | null | undefined,
  logger: TaskRecordOutboxLogger,
  baseUpdatedAt?: string | null,
): EnqueueParams | null {
  if (!sourceUserId) {
    logger.warn('任务删除未写入 ActionQueue：用户认证状态尚未就绪', {
      projectId: project.id,
      taskId,
    });
    return null;
  }

  if (project.syncSource === 'local-only') {
    logger.debug('local-only 项目跳过任务删除 ActionQueue 入队', {
      projectId: project.id,
      taskId,
    });
    return null;
  }

  return {
    type: 'delete',
    entityType: 'task',
    entityId: taskId,
    payload: {
      taskId,
      projectId: project.id,
      sourceUserId,
      baseUpdatedAt,
    },
  };
}

function collectConnectionOutboxActions(
  project: Project,
  beforeConnectionMap: Map<string, Connection>,
  sourceUserId: string | null | undefined,
  logger: TaskRecordOutboxLogger,
): EnqueueParams[] {
  const actions: EnqueueParams[] = [];
  const afterConnectionMap = new Map<string, Connection>();

  for (const connection of project.connections) {
    if (!connection.id) continue;

    afterConnectionMap.set(connection.id, connection);
    const beforeConnection = beforeConnectionMap.get(connection.id);
    if (!beforeConnection) {
      const action = buildConnectionOutboxAction(project, 'create', connection, sourceUserId, logger);
      if (action) actions.push(action);
      continue;
    }

    if (hasTrackedConnectionFieldChanged(beforeConnection, connection)) {
      const action = buildConnectionOutboxAction(
        project,
        !beforeConnection.deletedAt && !!connection.deletedAt ? 'delete' : 'update',
        connection,
        sourceUserId,
        logger,
      );
      if (action) actions.push(action);
    }
  }

  for (const [connectionId, beforeConnection] of beforeConnectionMap) {
    if (!afterConnectionMap.has(connectionId)) {
      const action = buildConnectionOutboxAction(
        project,
        'delete',
        createConnectionTombstone(beforeConnection),
        sourceUserId,
        logger,
      );
      if (action) actions.push(action);
    }
  }

  return actions;
}

function buildConnectionOutboxAction(
  project: Project,
  type: 'create' | 'update' | 'delete',
  connection: Connection,
  sourceUserId: string | null | undefined,
  logger: TaskRecordOutboxLogger,
): EnqueueParams | null {
  if (!sourceUserId) {
    logger.warn('连接变更未写入 ActionQueue：用户认证状态尚未就绪', {
      projectId: project.id,
      connectionId: connection.id,
      type,
    });
    return null;
  }

  if (project.syncSource === 'local-only') {
    logger.debug('local-only 项目跳过连接 ActionQueue 入队', {
      projectId: project.id,
      connectionId: connection.id,
      type,
    });
    return null;
  }

  return {
    type,
    entityType: 'connection',
    entityId: connection.id,
    payload: {
      connection,
      projectId: project.id,
      sourceUserId,
    },
  };
}

export function hasTrackedConnectionFieldChanged(before: Connection, after: Connection): boolean {
  return TRACKED_CONNECTION_FIELDS.some(field => before[field] !== after[field]);
}

function hasTrackedConnectionMutations(
  project: Project,
  beforeConnectionMap: Map<string, Connection>,
  logger: TaskRecordOutboxLogger,
): boolean {
  const afterConnectionMap = new Map<string, Connection>();
  for (const connection of project.connections) {
    if (!connection.id) continue;

    afterConnectionMap.set(connection.id, connection);
    const beforeConnection = beforeConnectionMap.get(connection.id);
    if (!beforeConnection || hasTrackedConnectionFieldChanged(beforeConnection, connection)) {
      return true;
    }
  }

  for (const connectionId of beforeConnectionMap.keys()) {
    if (!afterConnectionMap.has(connectionId)) {
      logger.debug('检测到连接删除需要写入 ActionQueue', {
        projectId: project.id,
        connectionId,
      });
      return true;
    }
  }

  return false;
}

function createConnectionTombstone(connection: Connection): Connection {
  const deletedAt = connection.deletedAt ?? new Date().toISOString();
  return {
    ...connection,
    deletedAt,
    updatedAt: deletedAt,
  };
}

function stringArrayChanged(before?: string[], after?: string[]): boolean {
  return (before?.length ?? 0) !== (after?.length ?? 0) ||
    (before ?? []).some((value, index) => value !== (after ?? [])[index]);
}

function attachmentsChanged(before: Task, after: Task): boolean {
  return (before.attachments?.length ?? 0) !== (after.attachments?.length ?? 0) ||
    (before.attachments ?? []).some((attachment, index) => attachment.id !== (after.attachments ?? [])[index]?.id);
}

function jsonFieldChanged(before: unknown, after: unknown): boolean {
  return JSON.stringify(before) !== JSON.stringify(after);
}
