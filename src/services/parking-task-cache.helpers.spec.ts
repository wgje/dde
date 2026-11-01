import { describe, expect, it } from 'vitest';

import type { Task } from '../models';
import {
  buildParkedTaskCacheEntries,
  mergeRemoteParkedTask,
  shouldApplyRemoteParkedTask,
} from './parking-task-cache.helpers';

describe('parking-task-cache.helpers', () => {
  it('builds parked task cache entries only when a project id exists', () => {
    const tasks = [
      task({ id: 'task-1' }),
      task({ id: 'task-2' }),
    ];

    expect(buildParkedTaskCacheEntries(tasks, (taskId) => taskId === 'task-1' ? 'project-1' : null)).toEqual([
      { task: tasks[0], projectId: 'project-1' },
    ]);
  });

  it('skips remote parked tasks when the local copy is newer', () => {
    expect(shouldApplyRemoteParkedTask(
      task({ updatedAt: '2026-02-23T10:01:00.000Z' }),
      task({ updatedAt: '2026-02-23T10:00:00.000Z' })
    )).toBe(false);
    expect(shouldApplyRemoteParkedTask(
      task({ updatedAt: '2026-02-23T10:00:00.000Z' }),
      task({ updatedAt: '2026-02-23T10:01:00.000Z' })
    )).toBe(true);
  });

  it('keeps the local parked task when revisions are equal', () => {
    const updatedAt = '2026-02-23T10:00:00.000Z';
    const local = task({
      stage: 2,
      parentId: 'parent-1',
      updatedAt,
    });
    const remote = task({
      stage: null,
      parentId: null,
      updatedAt,
    });

    expect(shouldApplyRemoteParkedTask(local, remote)).toBe(false);
  });

  it('applies only parking metadata from a newer remote snapshot to an existing task', () => {
    const local = task({
      title: 'Local title must survive',
      content: 'Local content must survive',
      stage: 2,
      parentId: 'parent-1',
      order: 7,
      rank: 70000,
      x: 120,
      y: 240,
      updatedAt: '2026-02-23T10:00:00.000Z',
    });
    const remote = task({
      title: 'stale remote title',
      content: '',
      stage: null,
      parentId: null,
      order: 0,
      rank: 0,
      x: 0,
      y: 0,
      updatedAt: '2026-02-23T10:01:00.000Z',
      parkingMeta: {
        state: 'focused',
        parkedAt: '2026-02-23T10:01:00.000Z',
        lastVisitedAt: '2026-02-23T10:01:00.000Z',
        contextSnapshot: null,
        reminder: null,
        pinned: true,
      },
    });

    expect(mergeRemoteParkedTask(local, remote)).toEqual({
      ...local,
      parkingMeta: remote.parkingMeta,
      updatedAt: remote.updatedAt,
    });
  });

  it('uses a complete remote task only when no local task exists', () => {
    const local = task({
      id: 'task-1',
      title: 'Local',
      displayId: 'A-1',
    });
    const remote = task({
      id: 'task-1',
      title: 'Remote',
      displayId: 'remote-display',
    });

    expect(mergeRemoteParkedTask(local, remote)).toMatchObject({
      id: 'task-1',
      title: 'Local',
      displayId: 'A-1',
    });
    expect(mergeRemoteParkedTask(null, remote)).toBe(remote);
  });
});

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Task',
    content: '',
    stage: 0,
    order: 0,
    status: 'active',
    parkingMeta: {
      state: 'parked',
      parkedAt: '2026-02-23T10:00:00.000Z',
      lastVisitedAt: '2026-02-23T10:00:00.000Z',
      contextSnapshot: null,
      reminder: null,
      pinned: false,
    },
    ...overrides,
  } as Task;
}
