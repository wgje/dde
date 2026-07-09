import { describe, expect, it } from 'vitest';
import type { Project, Task } from '../models';
import {
  applyTaskPlannerFieldsUpdate,
  applyTaskPlannerMinutesUpdate,
  resolveTaskPlannerFields,
} from './task-attribute-planner.helpers';

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: '任务',
    content: '',
    stage: 1,
    parentId: null,
    order: 0,
    rank: 0,
    status: 'active',
    x: 0,
    y: 0,
    createdDate: '2026-06-05T00:00:00.000Z',
    updatedAt: '2026-06-05T00:00:00.000Z',
    displayId: '1',
    expected_minutes: 30,
    wait_minutes: 20,
    cognitive_load: 'low',
    ...overrides,
  };
}

function createProject(task: Task): Project {
  return {
    id: 'project-1',
    name: '项目',
    description: '',
    createdDate: '2026-06-05T00:00:00.000Z',
    tasks: [task],
    connections: [],
  };
}

describe('task-attribute-planner.helpers', () => {
  it('resolves planner fields from current task and patch with wait-minute correction', () => {
    const fields = resolveTaskPlannerFields(createTask(), { waitMinutes: 90 });

    expect(fields).toEqual({
      expectedMinutes: 90,
      waitMinutes: 90,
      cognitiveLoad: 'low',
      adjusted: true,
    });
  });

  it('applies minutes-only planner updates without changing cognitive load', () => {
    const project = createProject(createTask({ cognitive_load: 'high' }));
    const fields = resolveTaskPlannerFields(project.tasks[0], { expectedMinutes: 60 });
    const updated = applyTaskPlannerMinutesUpdate(
      project,
      'task-1',
      fields,
      '2026-06-05T08:00:00.000Z',
    );

    expect(updated.tasks[0]).toEqual(expect.objectContaining({
      expected_minutes: 60,
      wait_minutes: 20,
      cognitive_load: 'high',
      updatedAt: '2026-06-05T08:00:00.000Z',
    }));
  });

  it('applies full planner updates including cognitive load', () => {
    const project = createProject(createTask({ cognitive_load: 'low' }));
    const fields = resolveTaskPlannerFields(project.tasks[0], {
      expectedMinutes: 45,
      cognitiveLoad: 'high',
    });
    const updated = applyTaskPlannerFieldsUpdate(
      project,
      'task-1',
      fields,
      '2026-06-05T08:00:00.000Z',
    );

    expect(updated.tasks[0]).toEqual(expect.objectContaining({
      expected_minutes: 45,
      wait_minutes: 20,
      cognitive_load: 'high',
      updatedAt: '2026-06-05T08:00:00.000Z',
    }));
  });
});
