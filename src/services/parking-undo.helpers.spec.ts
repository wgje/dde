import { describe, expect, it } from 'vitest';

import type { Connection, Project, Task } from '../models';
import {
  collectParkUndoProjectIds,
  hasProjectSnapshotChanged,
} from './parking-undo.helpers';

describe('parking-undo.helpers', () => {
  it('collects unique project ids for task ids that can be resolved', () => {
    const ids = collectParkUndoProjectIds(
      ['task-1', null, 'task-2', 'task-1', 'missing'],
      (taskId) => taskId === 'missing' ? null : `project-${taskId}`,
    );

    expect(ids).toEqual(['project-task-1', 'project-task-2']);
  });

  it('detects project snapshot changes by task or connection content', () => {
    const base = snapshot({
      tasks: [task({ id: 'task-1', title: 'Before' })],
      connections: [connection({ id: 'conn-1' })],
    });

    expect(hasProjectSnapshotChanged(base, snapshot({
      tasks: [task({ id: 'task-1', title: 'Before' })],
      connections: [connection({ id: 'conn-1' })],
    }))).toBe(false);
    expect(hasProjectSnapshotChanged(base, snapshot({
      tasks: [task({ id: 'task-1', title: 'After' })],
      connections: [connection({ id: 'conn-1' })],
    }))).toBe(true);
    expect(hasProjectSnapshotChanged(base, snapshot({
      tasks: [task({ id: 'task-1', title: 'Before' })],
      connections: [connection({ id: 'conn-1' }), connection({ id: 'conn-2' })],
    }))).toBe(true);
  });
});

function task(overrides: Partial<Task>): Task {
  return {
    id: 'task',
    title: 'Task',
    content: '',
    stage: null,
    parentId: null,
    order: 0,
    rank: 0,
    status: 'active',
    x: 0,
    y: 0,
    createdDate: '2026-01-01T00:00:00.000Z',
    displayId: 'T-1',
    ...overrides,
  };
}

function connection(overrides: Partial<Connection>): Connection {
  return {
    id: 'connection',
    source: 'task-1',
    target: 'task-2',
    ...overrides,
  };
}

function snapshot(overrides: Partial<Project> = {}): Partial<Project> {
  return {
    tasks: [],
    connections: [],
    ...overrides,
  } as Partial<Project>;
}
