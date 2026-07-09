import { describe, expect, it } from 'vitest';
import type { Task } from '../models';
import { collectKeepBothTasks } from './conflict-resolution-keep-both.helpers';

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: overrides.id ?? 'task-1',
    title: overrides.title ?? 'Task',
    content: overrides.content ?? '',
    stage: overrides.stage ?? 1,
    parentId: overrides.parentId ?? null,
    order: overrides.order ?? 1,
    rank: overrides.rank ?? 1000,
    status: overrides.status ?? 'active',
    x: overrides.x ?? 0,
    y: overrides.y ?? 0,
    createdDate: overrides.createdDate ?? '2026-01-01T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-01-01T00:00:00.000Z',
    displayId: overrides.displayId ?? 'A',
    shortId: overrides.shortId,
  };
}

describe('conflict-resolution-keep-both.helpers', () => {
  it('以远程任务为基线并追加本地独有任务', () => {
    const remoteTask = task({ id: 'remote', title: 'Remote' });
    const localOnlyTask = task({ id: 'local-only', title: 'Local Only' });

    const result = collectKeepBothTasks([localOnlyTask], [remoteTask], {
      createId: () => 'copy-id',
      createShortId: () => 'copy-short',
      nowIso: () => '2026-01-02T00:00:00.000Z',
    });

    expect(result).toEqual({
      mergedTasks: [remoteTask, localOnlyTask],
      copiedCount: 0,
    });
  });

  it('同 ID 任务存在内容冲突时为本地任务创建副本', () => {
    const remoteTask = task({ id: 'same', title: 'Remote Title', content: 'remote' });
    const localTask = task({ id: 'same', title: 'Local Title', content: 'local', displayId: 'L' });

    const result = collectKeepBothTasks([localTask], [remoteTask], {
      createId: () => 'copy-id',
      createShortId: () => 'copy-short',
      nowIso: () => '2026-01-02T00:00:00.000Z',
    });

    expect(result.copiedCount).toBe(1);
    expect(result.mergedTasks).toEqual([
      remoteTask,
      {
        ...localTask,
        id: 'copy-id',
        title: 'Local Title (副本)',
        displayId: '',
        shortId: 'copy-short',
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
    ]);
  });
});
