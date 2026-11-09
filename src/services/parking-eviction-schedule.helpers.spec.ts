import { describe, expect, it } from 'vitest';

import type { Task } from '../models';
import { selectStaleParkingEvictionCandidates } from './parking-eviction-schedule.helpers';

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Task 1',
    description: '',
    status: 'todo',
    priority: 'medium',
    dependencies: [],
    subtasks: [],
    tags: [],
    createdAt: '2026-03-31T00:00:00.000Z',
    updatedAt: '2026-03-31T00:00:00.000Z',
    ...overrides,
  } as Task;
}

describe('selectStaleParkingEvictionCandidates', () => {
  const now = Date.parse('2026-03-31T12:00:00.000Z');
  const staleThresholdMs = 60 * 60 * 1000;

  it('selects parked tasks whose last visit is older than the stale threshold', () => {
    const staleTask = createTask({
      id: 'stale',
      parkingMeta: {
        state: 'parked',
        lastVisitedAt: '2026-03-31T10:00:00.000Z',
      } as Task['parkingMeta'],
    });
    const freshTask = createTask({
      id: 'fresh',
      parkingMeta: {
        state: 'parked',
        lastVisitedAt: '2026-03-31T11:30:00.000Z',
      } as Task['parkingMeta'],
    });

    expect(selectStaleParkingEvictionCandidates([staleTask, freshTask], now, staleThresholdMs))
      .toEqual([staleTask]);
  });

  it('uses parkedAt when lastVisitedAt is absent', () => {
    const staleTask = createTask({
      id: 'stale-parked-at',
      parkingMeta: {
        state: 'parked',
        parkedAt: '2026-03-31T09:00:00.000Z',
      } as Task['parkingMeta'],
    });

    expect(selectStaleParkingEvictionCandidates([staleTask], now, staleThresholdMs))
      .toEqual([staleTask]);
  });

  it('keeps focused, pinned, timestamp-less, and invalid timestamp tasks out of eviction', () => {
    const tasks = [
      createTask({
        id: 'focused',
        parkingMeta: {
          state: 'focused',
          lastVisitedAt: '2026-03-31T09:00:00.000Z',
        } as Task['parkingMeta'],
      }),
      createTask({
        id: 'pinned',
        parkingMeta: {
          state: 'parked',
          pinned: true,
          lastVisitedAt: '2026-03-31T09:00:00.000Z',
        } as Task['parkingMeta'],
      }),
      createTask({
        id: 'timestamp-less',
        parkingMeta: {
          state: 'parked',
        } as Task['parkingMeta'],
      }),
      createTask({
        id: 'invalid',
        parkingMeta: {
          state: 'parked',
          lastVisitedAt: 'not-a-date',
        } as Task['parkingMeta'],
      }),
      createTask({ id: 'no-meta' }),
    ];

    expect(selectStaleParkingEvictionCandidates(tasks, now, staleThresholdMs)).toEqual([]);
  });
});
