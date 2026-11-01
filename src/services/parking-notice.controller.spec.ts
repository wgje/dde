import { describe, expect, it } from 'vitest';

import type { ParkingNotice } from '../models';
import { ParkingNoticeController } from './parking-notice.controller';

describe('ParkingNoticeController', () => {
  it('queues eviction notices while gate is active and flushes them later', () => {
    const controller = new ParkingNoticeController({ reminderBadgeThreshold: 3 });
    const notice = evictionNotice('notice-1');

    controller.showNotice(notice, true);

    expect(controller.pendingNotices()).toEqual([]);

    controller.flushDeferredNotices();

    expect(controller.pendingNotices()).toEqual([notice]);
  });

  it('shows non-eviction notices immediately and consumes by id', () => {
    const controller = new ParkingNoticeController({ reminderBadgeThreshold: 3 });
    const notice: ParkingNotice = {
      id: 'notice-1',
      type: 'reminder',
      projectId: 'project-1',
      taskId: 'task-1',
      taskTitle: 'Task 1',
      minVisibleMs: 100,
      fallbackTimeoutMs: 1000,
      actions: [],
    };

    controller.showNotice(notice, true);
    expect(controller.pendingNotices()).toEqual([notice]);

    controller.consumeNotice('notice-1');
    expect(controller.pendingNotices()).toEqual([]);
  });

  it('adds and clears reminder badges after the configured fadeout threshold', () => {
    const controller = new ParkingNoticeController({ reminderBadgeThreshold: 2 });

    controller.recordReminderFadeout('task-1');
    expect(controller.badgedTaskIds().has('task-1')).toBe(false);

    controller.recordReminderFadeout('task-1');
    expect(controller.badgedTaskIds().has('task-1')).toBe(true);

    controller.clearBadge('task-1');
    expect(controller.badgedTaskIds().has('task-1')).toBe(false);
  });
});

function evictionNotice(id: string): ParkingNotice {
  return {
    id,
    type: 'eviction',
    taskId: 'task-1',
    taskTitle: 'Task 1',
    minVisibleMs: 100,
    fallbackTimeoutMs: 1000,
    reason: 'stale',
    actions: [],
  };
}
