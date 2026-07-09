import { describe, expect, it, vi } from 'vitest';

import type { Task, TaskParkingMeta } from '../models';
import { ParkingMetaWriterController } from './parking-meta-writer.controller';

describe('ParkingMetaWriterController', () => {
  it('updates, clears, and restores parking meta through the task store', () => {
    const task = createTask();
    const setTask = vi.fn();
    const controller = new ParkingMetaWriterController({
      taskById: () => task,
      findProjectId: () => 'project-1',
      setTask,
      nowIso: () => '2026-02-23T10:01:00.000Z',
    });

    controller.update('task-1', parkingMeta({ state: 'focused' }));
    controller.clear('task-1');
    controller.restore('task-1', parkingMeta({ state: 'parked' }));

    expect(setTask).toHaveBeenNthCalledWith(1, expect.objectContaining({
      id: 'task-1',
      parkingMeta: expect.objectContaining({ state: 'focused' }),
      updatedAt: '2026-02-23T10:01:00.000Z',
    }), 'project-1');
    expect(setTask).toHaveBeenNthCalledWith(2, expect.objectContaining({
      id: 'task-1',
      parkingMeta: undefined,
      updatedAt: '2026-02-23T10:01:00.000Z',
    }), 'project-1');
    expect(setTask).toHaveBeenNthCalledWith(3, expect.objectContaining({
      id: 'task-1',
      parkingMeta: expect.objectContaining({ state: 'parked' }),
      updatedAt: '2026-02-23T10:01:00.000Z',
    }), 'project-1');
  });

  it('returns false when durable parking meta persistence fails', async () => {
    const task = createTask();
    const controller = new ParkingMetaWriterController({
      taskById: () => task,
      findProjectId: () => 'project-1',
      setTask: vi.fn().mockResolvedValue(false),
      nowIso: () => '2026-02-23T10:01:00.000Z',
    });

    await expect(controller.update('task-1', parkingMeta({ state: 'parked' }))).resolves.toBe(false);
  });

  it('does not write when the task or project id is missing', () => {
    const setTask = vi.fn();

    expect(new ParkingMetaWriterController({
      taskById: () => undefined,
      findProjectId: () => 'project-1',
      setTask,
    }).update('missing-task', parkingMeta())).toBe(false);

    expect(new ParkingMetaWriterController({
      taskById: () => createTask(),
      findProjectId: () => null,
      setTask,
    }).clear('task-1')).toBe(false);

    expect(setTask).not.toHaveBeenCalled();
  });
});

function createTask(): Task {
  return {
    id: 'task-1',
    title: 'Task',
    content: '',
    stage: 0,
    order: 0,
    status: 'active',
  } as Task;
}

function parkingMeta(overrides: Partial<TaskParkingMeta> = {}): TaskParkingMeta {
  return {
    state: 'parked',
    parkedAt: '2026-02-23T10:00:00.000Z',
    lastVisitedAt: '2026-02-23T10:00:00.000Z',
    contextSnapshot: null,
    reminder: null,
    pinned: false,
    ...overrides,
  };
}
