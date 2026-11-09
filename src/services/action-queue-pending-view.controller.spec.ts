import { signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';

import { ActionQueuePendingViewController } from './action-queue-pending-view.controller';
import type { QueuedAction } from './action-queue.types';

function createAction(id: string): QueuedAction {
  return {
    id,
    operationId: `operation-${id}`,
    type: 'update',
    entityType: 'task',
    entityId: `task-${id}`,
    payload: {
      task: {
        id: `task-${id}`,
        title: `Task ${id}`,
        content: '',
        stage: 1,
        parentId: null,
        order: 0,
        rank: 500,
        status: 'active',
        x: 0,
        y: 0,
        createdDate: '2026-06-15T00:00:00.000Z',
        displayId: id,
      },
      projectId: 'project-1',
    },
    timestamp: 1,
    localCommittedAt: 1,
    syncState: 'pending_sync',
    retryCount: 0,
    priority: 'normal',
  };
}

describe('ActionQueuePendingViewController', () => {
  it('sets the queue and keeps queueSize in sync', () => {
    const pendingActions = signal<QueuedAction[]>([]);
    const queueSize = signal(0);
    const controller = new ActionQueuePendingViewController({
      pendingActions,
      queueSize,
      setProcessing: vi.fn(),
    });

    controller.setQueue([createAction('a'), createAction('b')]);

    expect(pendingActions()).toHaveLength(2);
    expect(queueSize()).toBe(2);
  });

  it('filters queue entries without updating signals when nothing is removed', () => {
    const first = createAction('a');
    const pendingActions = signal<QueuedAction[]>([first]);
    const queueSize = signal(1);
    const controller = new ActionQueuePendingViewController({
      pendingActions,
      queueSize,
      setProcessing: vi.fn(),
    });
    const previousQueue = pendingActions();

    const removed = controller.filterQueue(action => action.id !== 'missing');

    expect(removed).toBe(0);
    expect(pendingActions()).toBe(previousQueue);
    expect(queueSize()).toBe(1);
  });

  it('maps matching entries and leaves unmatched queues untouched', () => {
    const first = createAction('a');
    const second = createAction('b');
    const pendingActions = signal<QueuedAction[]>([first, second]);
    const queueSize = signal(2);
    const controller = new ActionQueuePendingViewController({
      pendingActions,
      queueSize,
      setProcessing: vi.fn(),
    });

    const changed = controller.mapQueue(action => (
      action.id === 'b'
        ? { ...action, syncState: 'pending_sync' }
        : action
    ));

    expect(changed).toBe(true);
    expect(pendingActions()[0]).toBe(first);
    expect(pendingActions()[1]).not.toBe(second);
    expect(queueSize()).toBe(2);
  });

  it('clears pending queue state and resets processing state', () => {
    const pendingActions = signal<QueuedAction[]>([createAction('a')]);
    const queueSize = signal(1);
    const setProcessing = vi.fn();
    const controller = new ActionQueuePendingViewController({
      pendingActions,
      queueSize,
      setProcessing,
    });

    controller.resetQueueView();

    expect(pendingActions()).toEqual([]);
    expect(queueSize()).toBe(0);
    expect(setProcessing).toHaveBeenCalledWith(false);
  });
});
