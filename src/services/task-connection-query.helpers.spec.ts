import { describe, expect, it } from 'vitest';

import type { Project, Task } from '../models';
import { getTaskConnections } from './task-connection-query.helpers';

function createTask(overrides: Partial<Task>): Task {
  return {
    id: 'task',
    title: 'Task',
    content: '',
    stage: 1,
    parentId: null,
    order: 1,
    rank: 1000,
    status: 'active',
    x: 0,
    y: 0,
    createdDate: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    displayId: '1',
    hasIncompleteTask: false,
    ...overrides,
  };
}

function createProject(overrides: Partial<Project>): Project {
  return {
    id: 'project-1',
    name: 'Project',
    description: '',
    createdDate: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    tasks: [],
    connections: [],
    version: 1,
    ...overrides,
  };
}

describe('task-connection-query.helpers', () => {
  it('无项目时返回空连接集合', () => {
    expect(getTaskConnections(null, 'task-a')).toEqual({
      outgoing: [],
      incoming: [],
    });
  });

  it('返回跨树关联并排除父子结构边', () => {
    const source = createTask({ id: 'source' });
    const child = createTask({ id: 'child', parentId: 'source' });
    const target = createTask({ id: 'target' });
    const incoming = createTask({ id: 'incoming' });
    const project = createProject({
      tasks: [source, child, target, incoming],
      connections: [
        { id: 'parent-child', source: 'source', target: 'child' },
        { id: 'cross-out', source: 'source', target: 'target', description: 'blocks' },
        { id: 'cross-in', source: 'incoming', target: 'source', description: 'relates' },
      ],
    });

    const result = getTaskConnections(project, 'source');

    expect(result.outgoing).toEqual([
      {
        targetId: 'target',
        targetTask: target,
        description: 'blocks',
      },
    ]);
    expect(result.incoming).toEqual([
      {
        sourceId: 'incoming',
        sourceTask: incoming,
        description: 'relates',
      },
    ]);
  });
});
