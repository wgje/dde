import {
  runTaskDurableFieldMutation,
  type TaskDurableFieldMutationRuntime,
} from './task-operation-durable-field.helpers';

export type TaskPriorityValue = 'low' | 'medium' | 'high' | 'urgent' | undefined;
export type TaskCognitiveLoadValue = 'high' | 'low' | null;

export interface TaskPlannerFieldsPatch {
  expectedMinutes?: number | null;
  waitMinutes?: number | null;
  cognitiveLoad?: TaskCognitiveLoadValue;
}

export interface TaskOperationPlannerCore {
  updateTaskPriorityDurably(taskId: string, priority: TaskPriorityValue): Promise<boolean>;
  updateTaskDueDateDurably(taskId: string, dueDate: string | null): Promise<boolean>;
  updateTaskExpectedMinutesDurably(taskId: string, expectedMinutes: number | null): Promise<boolean>;
  updateTaskPlannerFieldsDurably(taskId: string, patch: TaskPlannerFieldsPatch): Promise<boolean>;
  updateTaskCognitiveLoadDurably(taskId: string, load: TaskCognitiveLoadValue): Promise<boolean>;
  updateTaskWaitMinutesDurably(taskId: string, waitMinutes: number | null): Promise<boolean>;
}

export type TaskOperationPlannerFieldRuntime = TaskDurableFieldMutationRuntime;

export function runTaskPriorityMutation(
  core: TaskOperationPlannerCore,
  runtime: TaskOperationPlannerFieldRuntime,
  taskId: string,
  priority: TaskPriorityValue,
): Promise<boolean> {
  return runTaskDurableFieldMutation({
    actionLabel: '更新任务优先级',
    failureMessage: '任务优先级本地持久化失败，未提交 UI 更新',
    failureData: { taskId, priority },
    mutate: () => core.updateTaskPriorityDurably(taskId, priority),
  }, runtime);
}

export function runTaskDueDateMutation(
  core: TaskOperationPlannerCore,
  runtime: TaskOperationPlannerFieldRuntime,
  taskId: string,
  dueDate: string | null,
): Promise<boolean> {
  return runTaskDurableFieldMutation({
    actionLabel: '更新任务截止时间',
    failureMessage: '任务截止时间本地持久化失败，未提交 UI 更新',
    failureData: { taskId, dueDate },
    mutate: () => core.updateTaskDueDateDurably(taskId, dueDate),
  }, runtime);
}

export function runTaskExpectedMinutesMutation(
  core: TaskOperationPlannerCore,
  runtime: TaskOperationPlannerFieldRuntime,
  taskId: string,
  expectedMinutes: number | null,
): Promise<boolean> {
  return runTaskDurableFieldMutation({
    actionLabel: '更新任务预估时长',
    failureMessage: '任务预估时长本地持久化失败，未提交 UI 更新',
    failureData: { taskId, expectedMinutes },
    mutate: () => core.updateTaskExpectedMinutesDurably(taskId, expectedMinutes),
  }, runtime);
}

export function runTaskPlannerFieldsMutation(
  core: TaskOperationPlannerCore,
  runtime: TaskOperationPlannerFieldRuntime,
  taskId: string,
  patch: TaskPlannerFieldsPatch,
): Promise<boolean> {
  return runTaskDurableFieldMutation({
    actionLabel: '更新任务规划字段',
    failureMessage: '任务规划字段本地持久化失败，未提交 UI 更新',
    failureData: { taskId, ...patch },
    mutate: () => core.updateTaskPlannerFieldsDurably(taskId, patch),
  }, runtime);
}

export function runTaskCognitiveLoadMutation(
  core: TaskOperationPlannerCore,
  runtime: TaskOperationPlannerFieldRuntime,
  taskId: string,
  load: TaskCognitiveLoadValue,
): Promise<boolean> {
  return runTaskDurableFieldMutation({
    actionLabel: '更新任务认知负荷',
    failureMessage: '任务认知负荷本地持久化失败，未提交 UI 更新',
    failureData: { taskId, load },
    mutate: () => core.updateTaskCognitiveLoadDurably(taskId, load),
  }, runtime);
}

export function runTaskWaitMinutesMutation(
  core: TaskOperationPlannerCore,
  runtime: TaskOperationPlannerFieldRuntime,
  taskId: string,
  waitMinutes: number | null,
): Promise<boolean> {
  return runTaskDurableFieldMutation({
    actionLabel: '更新任务等待时长',
    failureMessage: '任务等待时长本地持久化失败，未提交 UI 更新',
    failureData: { taskId, waitMinutes },
    mutate: () => core.updateTaskWaitMinutesDurably(taskId, waitMinutes),
  }, runtime);
}
