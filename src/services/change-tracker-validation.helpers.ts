import { Task, Connection } from '../models';
import {
  ChangeValidationResult,
  DataLossRisk,
  ProjectChangeSummary,
} from './change-tracker.types';

export function validateProjectChanges(
  changes: ProjectChangeSummary,
  currentTasks: Task[],
): ChangeValidationResult {
  const warnings: string[] = [];
  const errors: string[] = [];
  const recommendations: string[] = [];

  if (!changes.hasChanges) {
    return { valid: true, warnings, errors, recommendations };
  }

  validateTaskChanges(changes, currentTasks, warnings, errors);
  validateConnectionTaskReferences(changes, currentTasks, errors);
  validateOrphanTaskChanges(changes, currentTasks, warnings, recommendations);
  addLargeChangeRecommendation(changes, currentTasks, recommendations);

  return {
    valid: errors.length === 0,
    warnings,
    errors,
    recommendations,
  };
}

export function buildChangeReport(changes: ProjectChangeSummary): string {
  if (!changes.hasChanges) {
    return `项目 ${changes.projectId}: 无待同步变更`;
  }

  const lines: string[] = [
    `项目 ${changes.projectId} 变更摘要:`,
    `  总变更数: ${changes.totalChanges}`,
    ``,
    `  任务变更:`,
    `    - 待创建: ${changes.tasksToCreate.length}`,
    `    - 待更新: ${changes.tasksToUpdate.length}`,
    `    - 待删除: ${changes.taskIdsToDelete.length}`,
    ``,
    `  连接变更:`,
    `    - 待创建: ${changes.connectionsToCreate.length}`,
    `    - 待更新: ${changes.connectionsToUpdate.length}`,
    `    - 待删除: ${changes.connectionsToDelete.length}`,
  ];

  if (changes.tasksToCreate.length > 0) {
    lines.push(``, `  待创建任务ID: ${changes.tasksToCreate.map(t => t.id).join(', ')}`);
  }

  if (changes.taskIdsToDelete.length > 0) {
    lines.push(``, `  待删除任务ID: ${changes.taskIdsToDelete.join(', ')}`);
  }

  return lines.join('\n');
}

export function collectDataLossRisks(
  changes: ProjectChangeSummary,
  currentTasks: Task[],
  currentConnections: Connection[],
): DataLossRisk[] {
  return [
    ...getMissingTaskRisks(changes, currentTasks),
    ...getOrphanConnectionRisks(changes, currentConnections),
    ...getParentChildInconsistencyRisks(changes, currentTasks),
    ...getDuplicateOperationRisks(changes, currentTasks),
  ];
}

function validateTaskChanges(
  changes: ProjectChangeSummary,
  currentTasks: Task[],
  warnings: string[],
  errors: string[],
): void {
  const currentTaskMap = new Map(currentTasks.map(t => [t.id, t]));

  for (const taskId of changes.taskIdsToDelete) {
    if (!currentTaskMap.has(taskId)) {
      warnings.push(`待删除的任务 ${taskId} 在当前项目中不存在，可能已被其他操作删除`);
    }
  }

  for (const task of changes.tasksToUpdate) {
    if (!currentTaskMap.has(task.id)) {
      errors.push(`待更新的任务 ${task.id} 在当前项目中不存在，无法执行更新操作`);
    }
  }

  for (const task of changes.tasksToCreate) {
    if (currentTaskMap.has(task.id)) {
      warnings.push(`待创建的任务 ${task.id} 已存在，将执行更新操作而非创建`);
    }
  }
}

function validateConnectionTaskReferences(
  changes: ProjectChangeSummary,
  currentTasks: Task[],
  errors: string[],
): void {
  const allTaskIds = getProjectedTaskIds(currentTasks, changes);

  for (const conn of changes.connectionsToCreate) {
    validateConnectionEndpoints(conn, allTaskIds, errors, '连接');
  }

  for (const conn of changes.connectionsToUpdate) {
    validateConnectionEndpoints(conn, allTaskIds, errors, '待更新连接');
  }
}

function getProjectedTaskIds(currentTasks: Task[], changes: ProjectChangeSummary): Set<string> {
  const allTaskIds = new Set(currentTasks.map(t => t.id));
  for (const task of changes.tasksToCreate) allTaskIds.add(task.id);
  for (const taskId of changes.taskIdsToDelete) allTaskIds.delete(taskId);
  return allTaskIds;
}

function validateConnectionEndpoints(
  conn: Connection,
  allTaskIds: Set<string>,
  errors: string[],
  label: '连接' | '待更新连接',
): void {
  if (!allTaskIds.has(conn.source)) {
    errors.push(`${label} ${conn.source}->${conn.target} 的源任务 ${conn.source} 不存在`);
  }

  if (!allTaskIds.has(conn.target)) {
    errors.push(`${label} ${conn.source}->${conn.target} 的目标任务 ${conn.target} 不存在`);
  }
}

function validateOrphanTaskChanges(
  changes: ProjectChangeSummary,
  currentTasks: Task[],
  warnings: string[],
  recommendations: string[],
): void {
  const deletedTaskIds = new Set(changes.taskIdsToDelete);

  for (const task of currentTasks) {
    if (!task.parentId || !deletedTaskIds.has(task.parentId) || deletedTaskIds.has(task.id)) continue;
    warnings.push(`任务 ${task.id} 的父任务 ${task.parentId} 将被删除，子任务将变为孤儿任务`);
    recommendations.push(`建议将任务 ${task.id} 一并删除，或重新指定父任务`);
  }
}

function addLargeChangeRecommendation(
  changes: ProjectChangeSummary,
  currentTasks: Task[],
  recommendations: string[],
): void {
  const totalTasks = currentTasks.length;
  const changeRatio = changes.totalChanges / Math.max(totalTasks, 1);

  if (changeRatio > 0.8 && totalTasks > 20) {
    recommendations.push(
      `变更比例过高 (${(changeRatio * 100).toFixed(1)}%)，建议考虑使用全量同步以提高可靠性`
    );
  }
}

function getMissingTaskRisks(changes: ProjectChangeSummary, currentTasks: Task[]): DataLossRisk[] {
  const currentTaskMap = new Map(currentTasks.map(t => [t.id, t]));
  const missingTasks = changes.tasksToUpdate.filter(t => !currentTaskMap.has(t.id));
  if (missingTasks.length === 0) return [];

  return [{
    type: 'task-missing',
    severity: 'high',
    description: '尝试更新不存在的任务，可能导致数据丢失',
    affectedEntities: missingTasks.map(t => t.id),
  }];
}

function getOrphanConnectionRisks(
  changes: ProjectChangeSummary,
  currentConnections: Connection[],
): DataLossRisk[] {
  const deletedTaskIds = new Set(changes.taskIdsToDelete);
  const orphanConnections = currentConnections.filter(
    c => deletedTaskIds.has(c.source) || deletedTaskIds.has(c.target)
  );
  if (orphanConnections.length === 0) return [];

  return [{
    type: 'connection-orphan',
    severity: 'medium',
    description: '任务删除后关联的连接将变为孤儿连接',
    affectedEntities: orphanConnections.map(c => `${c.source}->${c.target}`),
  }];
}

function getParentChildInconsistencyRisks(
  changes: ProjectChangeSummary,
  currentTasks: Task[],
): DataLossRisk[] {
  const deletedTaskIds = new Set(changes.taskIdsToDelete);
  const affectedEntities = currentTasks
    .filter(task => task.parentId && deletedTaskIds.has(task.parentId) && !deletedTaskIds.has(task.id))
    .map(task => task.id);
  if (affectedEntities.length === 0) return [];

  return [{
    type: 'parent-child-inconsistency',
    severity: 'medium',
    description: '父任务被删除但子任务保留，可能破坏层级结构',
    affectedEntities,
  }];
}

function getDuplicateOperationRisks(changes: ProjectChangeSummary, currentTasks: Task[]): DataLossRisk[] {
  const currentTaskMap = new Map(currentTasks.map(t => [t.id, t]));
  const duplicateCreates = changes.tasksToCreate.filter(t => currentTaskMap.has(t.id));
  if (duplicateCreates.length === 0) return [];

  return [{
    type: 'duplicate-operation',
    severity: 'low',
    description: '尝试创建已存在的任务，将自动转为更新操作',
    affectedEntities: duplicateCreates.map(t => t.id),
  }];
}
