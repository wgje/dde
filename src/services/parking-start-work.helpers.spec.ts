import { describe, expect, it } from 'vitest';

import type { Task, TaskParkingMeta } from '../models';
import { buildParkingStartWorkUpdates } from './parking-start-work.helpers';

function task(id: string, parkingMeta: TaskParkingMeta | null = null): Task {
  return {
    id,
    title: id,
    content: '',
    stage: null,
    parentId: null,
    order: 0,
    rank: 0,
    status: 'active',
    x: 0,
    y: 0,
    createdDate: '2026-06-15T00:00:00.000Z',
    updatedAt: '2026-06-15T00:00:00.000Z',
    displayId: id,
    parkingMeta,
  };
}

function meta(overrides: Partial<TaskParkingMeta> = {}): TaskParkingMeta {
  return {
    state: 'parked',
    parkedAt: '2026-06-14T00:00:00.000Z',
    lastVisitedAt: '2026-06-14T00:00:00.000Z',
    contextSnapshot: null,
    reminder: null,
    pinned: false,
    ...overrides,
  };
}

describe('parking-start-work.helpers', () => {
  it('将当前 focused 任务停回 parked，并将目标任务切换为 focused', () => {
    const now = '2026-06-15T00:10:00.000Z';

    expect(buildParkingStartWorkUpdates({
      currentFocused: task('focused', meta({ state: 'focused', pinned: true })),
      targetTask: task('target', meta({ state: 'parked', pinned: false })),
      now,
    })).toEqual([
      {
        taskId: 'focused',
        parkingMeta: {
          ...meta({ state: 'focused', pinned: true }),
          state: 'parked',
          parkedAt: now,
          lastVisitedAt: now,
        },
      },
      {
        taskId: 'target',
        parkingMeta: {
          ...meta({ state: 'parked', pinned: false }),
          state: 'focused',
          lastVisitedAt: now,
        },
      },
    ]);
  });

  it('目标任务没有 parkingMeta 时创建默认 focused meta', () => {
    const now = '2026-06-15T00:10:00.000Z';

    expect(buildParkingStartWorkUpdates({
      currentFocused: null,
      targetTask: task('target'),
      now,
    })).toEqual([
      {
        taskId: 'target',
        parkingMeta: {
          state: 'focused',
          parkedAt: null,
          lastVisitedAt: now,
          contextSnapshot: null,
          reminder: null,
          pinned: false,
        },
      },
    ]);
  });

  it('当前 focused 与目标相同时只更新目标任务', () => {
    const now = '2026-06-15T00:10:00.000Z';
    const sameTask = task('same', meta({ state: 'focused' }));

    expect(buildParkingStartWorkUpdates({
      currentFocused: sameTask,
      targetTask: sameTask,
      now,
    })).toEqual([
      {
        taskId: 'same',
        parkingMeta: {
          ...meta({ state: 'focused' }),
          lastVisitedAt: now,
        },
      },
    ]);
  });
});
