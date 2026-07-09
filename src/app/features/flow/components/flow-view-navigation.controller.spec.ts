import { describe, expect, it, vi } from 'vitest';

import { FlowViewNavigationController } from './flow-view-navigation.controller';
import type { Task } from '../../../../models';

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Task',
    content: '',
    stage: 1,
    parentId: null,
    order: 1,
    rank: 1000,
    status: 'active',
    x: 0,
    y: 0,
    createdDate: '2026-06-14T00:00:00.000Z',
    updatedAt: '2026-06-14T00:00:00.000Z',
    displayId: '1',
    ...overrides,
  };
}

function createController(task: Task | undefined | null) {
  const centerOnNode = vi.fn();
  const warn = vi.fn();
  const controller = new FlowViewNavigationController({
    centerOnNode,
    getTask: () => task,
    warn,
  });
  return { centerOnNode, controller, warn };
}

describe('FlowViewNavigationController', () => {
  it('centers an active task through the command service', () => {
    const { centerOnNode, controller, warn } = createController(createTask());

    controller.centerOnNode('task-1', false);

    expect(centerOnNode).toHaveBeenCalledWith('task-1', false);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ['missing task', undefined],
    ['archived task', createTask({ status: 'archived' })],
    ['deleted task', createTask({ deletedAt: '2026-06-14T00:00:00.000Z' })],
  ])('ignores %s links without dispatching a center command', (_label, task) => {
    const { centerOnNode, controller, warn } = createController(task);

    controller.centerOnNode('task-1', true);

    expect(centerOnNode).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('目标任务不存在，忽略流程图链接跳转', { taskId: 'task-1' });
  });
});
