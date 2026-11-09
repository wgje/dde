import { describe, expect, it, vi } from 'vitest';

import type { Task } from '../models';
import type { EnqueueParams } from './action-queue.types';
import { warnIfActionQueueFrozen } from './action-queue-frozen-warning.helpers';

const createTask = (): Task => ({
  id: 'task-1',
  title: 'Task 1',
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
});

const createAction = (): EnqueueParams => ({
  type: 'create',
  entityType: 'task',
  entityId: 'task-1',
  payload: {
    projectId: 'project-1',
    task: createTask(),
  },
});

describe('warnIfActionQueueFrozen', () => {
  it('does not notify when the queue is available', () => {
    const warn = vi.fn();
    const notifyQueuePressureOnce = vi.fn();

    warnIfActionQueueFrozen({
      action: createAction(),
      isQueueFrozen: () => false,
      getFreezeReason: () => 'quota',
      warn,
      notifyQueuePressureOnce,
    });

    expect(warn).not.toHaveBeenCalled();
    expect(notifyQueuePressureOnce).not.toHaveBeenCalled();
  });

  it('warns and notifies once when the queue is frozen', () => {
    const warn = vi.fn();
    const notifyQueuePressureOnce = vi.fn();

    warnIfActionQueueFrozen({
      action: createAction(),
      isQueueFrozen: () => true,
      getFreezeReason: () => 'quota',
      warn,
      notifyQueuePressureOnce,
    });

    expect(warn).toHaveBeenCalledWith('队列处于冻结状态，拒绝未持久化写入', {
      type: 'create',
      entityType: 'task',
      entityId: 'task-1',
      reason: 'quota',
    });
    expect(notifyQueuePressureOnce).toHaveBeenCalledWith(
      '同步队列已暂停',
      '当前浏览器存储不可用，本次操作未写入本地队列。请先导出或释放存储空间。',
    );
  });

  it('still notifies when warning logging fails', () => {
    const warn = vi.fn(() => {
      throw new Error('logger unavailable');
    });
    const notifyQueuePressureOnce = vi.fn();

    expect(() => warnIfActionQueueFrozen({
      action: createAction(),
      isQueueFrozen: () => true,
      getFreezeReason: () => 'quota',
      warn,
      notifyQueuePressureOnce,
    })).not.toThrow();

    expect(warn).toHaveBeenCalledOnce();
    expect(notifyQueuePressureOnce).toHaveBeenCalledWith(
      '同步队列已暂停',
      '当前浏览器存储不可用，本次操作未写入本地队列。请先导出或释放存储空间。',
    );
  });

  it('swallows notification failures after warning the frozen queue', () => {
    const warn = vi.fn();
    const notifyQueuePressureOnce = vi.fn(() => {
      throw new Error('toast unavailable');
    });

    expect(() => warnIfActionQueueFrozen({
      action: createAction(),
      isQueueFrozen: () => true,
      getFreezeReason: () => 'quota',
      warn,
      notifyQueuePressureOnce,
    })).not.toThrow();

    expect(warn).toHaveBeenCalledWith('队列处于冻结状态，拒绝未持久化写入', expect.objectContaining({
      entityId: 'task-1',
      reason: 'quota',
    }));
    expect(notifyQueuePressureOnce).toHaveBeenCalledOnce();
  });
});
