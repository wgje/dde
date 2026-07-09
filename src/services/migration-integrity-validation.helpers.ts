import type { Project } from '../models';
import type { IntegrityCheckResult, IntegrityIssue } from './migration.types';

export function validateMigrationProjectIntegrity(projects: Project[]): IntegrityCheckResult {
  const context: IntegrityValidationContext = {
    issues: [],
    taskCount: 0,
    connectionCount: 0,
    projectIds: new Set(),
  };

  for (const project of projects) {
    validateProjectIntegrity(project, context);
  }

  const hasErrors = context.issues.some((issue) => issue.severity === 'error');
  return {
    valid: !hasErrors,
    issues: context.issues,
    projectCount: projects.length,
    taskCount: context.taskCount,
    connectionCount: context.connectionCount,
  };
}

interface IntegrityValidationContext {
  issues: IntegrityIssue[];
  taskCount: number;
  connectionCount: number;
  projectIds: Set<string>;
}

function validateProjectIntegrity(
  project: Project,
  context: IntegrityValidationContext,
): void {
  if (!recordProjectId(project, context)) {
    return;
  }

  const projectTaskIds = validateProjectTasks(project, context);
  validateTaskParents(project, projectTaskIds, context.issues);
  validateProjectConnections(project, projectTaskIds, context);
}

function recordProjectId(
  project: Project,
  context: IntegrityValidationContext,
): boolean {
  if (!project.id) {
    context.issues.push({
      type: 'missing-id',
      entityType: 'project',
      message: `项目缺少 ID: ${project.name || '未命名'}`,
      severity: 'error',
    });
    return false;
  }

  if (context.projectIds.has(project.id)) {
    context.issues.push({
      type: 'duplicate-id',
      entityType: 'project',
      entityId: project.id,
      message: `项目 ID 重复: ${project.id}`,
      severity: 'error',
    });
  }
  context.projectIds.add(project.id);
  return true;
}

function validateProjectTasks(
  project: Project,
  context: IntegrityValidationContext,
): Set<string> {
  const projectTaskIds = new Set<string>();
  for (const task of project.tasks || []) {
    context.taskCount++;

    if (!task.id) {
      context.issues.push({
        type: 'missing-id',
        entityType: 'task',
        message: `任务缺少 ID: ${task.title || '未命名'} (项目: ${project.name})`,
        severity: 'error',
      });
      continue;
    }

    recordTaskId(task.id, projectTaskIds, context.issues);
    if (typeof task.stage !== 'number' && task.stage !== null) {
      context.issues.push({
        type: 'invalid-field',
        entityType: 'task',
        entityId: task.id,
        message: `任务 stage 字段类型无效: ${typeof task.stage}`,
        severity: 'warning',
      });
    }
  }

  return projectTaskIds;
}

function recordTaskId(
  taskId: string,
  projectTaskIds: Set<string>,
  issues: IntegrityIssue[],
): void {
  if (projectTaskIds.has(taskId)) {
    issues.push({
      type: 'duplicate-id',
      entityType: 'task',
      entityId: taskId,
      message: `任务 ID 在项目内重复: ${taskId}`,
      severity: 'error',
    });
  }
  projectTaskIds.add(taskId);
}

function validateTaskParents(
  project: Project,
  projectTaskIds: Set<string>,
  issues: IntegrityIssue[],
): void {
  for (const task of project.tasks || []) {
    if (task.parentId && !projectTaskIds.has(task.parentId)) {
      issues.push({
        type: 'orphan-task',
        entityType: 'task',
        entityId: task.id,
        message: `任务 "${task.title || task.id}" 的父任务不存在: ${task.parentId}`,
        severity: 'warning',
      });
    }
  }
}

function validateProjectConnections(
  project: Project,
  projectTaskIds: Set<string>,
  context: IntegrityValidationContext,
): void {
  for (const connection of project.connections || []) {
    context.connectionCount++;

    if (!connection.id) {
      context.issues.push({
        type: 'missing-id',
        entityType: 'connection',
        message: `连接缺少 ID: ${connection.source} -> ${connection.target}`,
        severity: 'warning',
      });
    }

    validateConnectionEndpoint(connection.id, connection.source, '源', projectTaskIds, context.issues);
    validateConnectionEndpoint(connection.id, connection.target, '目标', projectTaskIds, context.issues);
  }
}

function validateConnectionEndpoint(
  connectionId: string,
  taskId: string,
  label: '源' | '目标',
  projectTaskIds: Set<string>,
  issues: IntegrityIssue[],
): void {
  if (projectTaskIds.has(taskId)) {
    return;
  }

  issues.push({
    type: 'broken-connection',
    entityType: 'connection',
    entityId: connectionId,
    message: `连接${label}任务不存在: ${taskId}`,
    severity: 'warning',
  });
}
