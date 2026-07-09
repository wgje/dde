import type { Project, Task } from '../models';
import {
  sanitizePlannerFields,
  type PlannerCognitiveLoad,
  type PlannerFieldSet,
} from '../utils/planner-fields';

export interface TaskPlannerPatch {
  expectedMinutes?: number | null;
  waitMinutes?: number | null;
  cognitiveLoad?: PlannerCognitiveLoad;
}

type TaskPlannerSource = Pick<Task, 'expected_minutes' | 'wait_minutes' | 'cognitive_load'>;

export function resolveTaskPlannerFields(
  currentTask: TaskPlannerSource,
  patch: TaskPlannerPatch,
): PlannerFieldSet {
  return sanitizePlannerFields({
    expectedMinutes:
      'expectedMinutes' in patch ? patch.expectedMinutes : currentTask.expected_minutes,
    waitMinutes:
      'waitMinutes' in patch ? patch.waitMinutes : currentTask.wait_minutes,
    cognitiveLoad:
      'cognitiveLoad' in patch ? patch.cognitiveLoad : currentTask.cognitive_load,
  });
}

export function applyTaskPlannerMinutesUpdate(
  project: Project,
  taskId: string,
  fields: PlannerFieldSet,
  now: string,
): Project {
  return {
    ...project,
    tasks: project.tasks.map(task =>
      task.id === taskId
        ? {
            ...task,
            expected_minutes: fields.expectedMinutes,
            wait_minutes: fields.waitMinutes,
            updatedAt: now,
          }
        : task,
    ),
  };
}

export function applyTaskPlannerFieldsUpdate(
  project: Project,
  taskId: string,
  fields: PlannerFieldSet,
  now: string,
): Project {
  return {
    ...project,
    tasks: project.tasks.map(task =>
      task.id === taskId
        ? {
            ...task,
            expected_minutes: fields.expectedMinutes,
            wait_minutes: fields.waitMinutes,
            cognitive_load: fields.cognitiveLoad,
            updatedAt: now,
          }
        : task,
    ),
  };
}
