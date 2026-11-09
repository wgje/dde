import { describe, expect, it } from 'vitest';

import type { ParkingNoticeEvictionItem, Task, TaskParkingMeta } from '../models';
import {
  ParkingEvictionController,
  type ParkingEvictionControllerOptions,
} from './parking-eviction.controller';

describe('ParkingEvictionController', () => {
  it('creates eviction tokens with a full parking meta snapshot', () => {
    const controller = createController();
    const task = parkedTask();

    const token = controller.createToken(task);

    expect(token).toEqual({
      tokenId: 'id-1',
      taskId: 'task-1',
      taskTitle: 'Parked task',
      previousParkingMeta: task.parkingMeta,
      createdAt: 1_000,
      expiresAt: 6_000,
      usedAt: null,
    });
    expect(token?.previousParkingMeta).not.toBe(task.parkingMeta);
  });

  it('can create eviction tokens from an explicit pre-clear parking meta snapshot', () => {
    const controller = createController();
    const task = parkedTask();
    const previousParkingMeta = parkingMeta();
    const clearedTask = { ...task, parkingMeta: undefined };

    const token = controller.createToken(clearedTask, previousParkingMeta);

    expect(token).toMatchObject({
      taskId: 'task-1',
      taskTitle: 'Parked task',
      previousParkingMeta,
    });
    expect(token?.previousParkingMeta).not.toBe(previousParkingMeta);
  });

  it('does not create an eviction token when the task has no parking meta', () => {
    const controller = createController();
    const task = { ...parkedTask(), parkingMeta: undefined };

    expect(controller.createToken(task)).toBeNull();
  });

  it('marks tokens used only while they are valid and unused', () => {
    const controller = createController({ now: createClock([1_000, 2_000, 2_500]) });
    const token = controller.createToken(parkedTask());

    expect(controller.markTokenUsed(token!.tokenId)).toMatchObject({
      status: 'restored',
      token: { usedAt: 2_000 },
    });
    expect(controller.markTokenUsed(token!.tokenId)).toMatchObject({ status: 'used' });
    expect(controller.markTokenUsed('missing')).toEqual({ status: 'missing' });
  });

  it('removes expired tokens when they are read or pruned', () => {
    const controller = createController({ now: createClock([1_000, 7_000]) });
    const token = controller.createToken(parkedTask());

    expect(controller.getToken(token!.tokenId)).toBeNull();
    expect(controller.markTokenUsed(token!.tokenId)).toEqual({ status: 'missing' });
  });

  it('builds single and batch eviction notices', () => {
    const controller = createController({ idFactory: createIds(['notice-1', 'notice-2']) });
    const first = item('task-1', 'Task 1', 'token-1');
    const second = item('task-2', 'Task 2', 'token-2');

    expect(controller.createNotice([first])).toMatchObject({
      id: 'notice-1',
      type: 'eviction',
      taskId: 'task-1',
      taskTitle: 'Task 1',
      evictionTokenId: 'token-1',
      actions: [
        { key: 'undo-eviction', label: '撤回' },
        { key: 'keep-parked', label: '关闭' },
      ],
    });
    expect(controller.createNotice([first, second])).toMatchObject({
      id: 'notice-2',
      type: 'eviction',
      taskId: 'task-1',
      taskTitle: '2 个停泊任务已移回任务列表',
      evictionItems: [first, second],
      actions: [
        { key: 'keep-parked', label: '关闭' },
      ],
    });
  });
});

function createController(overrides: Partial<ParkingEvictionControllerOptions> = {}): ParkingEvictionController {
  return new ParkingEvictionController({
    undoTimeoutMs: 5_000,
    noticeMinVisibleMs: 2_500,
    noticeFallbackTimeoutMs: 15_000,
    now: () => 1_000,
    idFactory: createIds(['id-1', 'id-2', 'id-3']),
    ...overrides,
  });
}

function createIds(ids: string[]): () => string {
  let index = 0;
  return () => ids[index++] ?? `id-${index}`;
}

function createClock(values: number[]): () => number {
  let index = 0;
  return () => values[index++] ?? values[values.length - 1] ?? 0;
}

function item(
  taskId: string,
  taskTitle: string,
  evictionTokenId: string
): ParkingNoticeEvictionItem {
  return { taskId, taskTitle, evictionTokenId };
}

function parkedTask(): Task {
  return {
    id: 'task-1',
    title: 'Parked task',
    content: '',
    stage: 0,
    order: 0,
    status: 'active',
    parkingMeta: parkingMeta(),
  } as Task;
}

function parkingMeta(): TaskParkingMeta {
  return {
    state: 'parked',
    parkedAt: '2026-02-20T10:00:00.000Z',
    lastVisitedAt: '2026-02-20T11:00:00.000Z',
    contextSnapshot: null,
    reminder: null,
    pinned: false,
  };
}
