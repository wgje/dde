import { describe, expect, it } from 'vitest';
import {
  getActionEntityKey,
  getQueuedActionSkipDecision,
} from './action-queue-processing.helpers';
import type { QueuedAction } from './action-queue.types';

const queuedAction = (overrides: Partial<QueuedAction> = {}): QueuedAction => ({
  id: 'action-1',
  type: 'update',
  entityType: 'project',
  entityId: 'project-1',
  payload: {
    project: {
      id: 'project-1',
      name: 'Project',
      description: '',
      createdDate: '2026-01-01T00:00:00.000Z',
      tasks: [],
      connections: [],
    },
  },
  timestamp: 1,
  retryCount: 0,
  ...overrides,
} as QueuedAction);

describe('action-queue-processing.helpers', () => {
  it('生成队列处理依赖使用的实体键', () => {
    expect(getActionEntityKey(queuedAction({ entityType: 'task', entityId: 'task-1' }))).toBe('task:task-1');
  });

  it('当前 pending 队列已无该 action 时跳过', () => {
    const action = queuedAction({ id: 'removed-action' });

    expect(getQueuedActionSkipDecision({
      action,
      currentPendingActions: [],
      processQueueSnapshot: [action],
      failedCreateEntities: new Set(),
    })).toEqual({
      shouldSkip: true,
      reason: 'missing-current-action',
      entityKey: 'project:project-1',
    });
  });

  it('同实体 create 已失败时跳过后续 update/delete', () => {
    const action = queuedAction({ type: 'delete' });

    expect(getQueuedActionSkipDecision({
      action,
      currentPendingActions: [action],
      processQueueSnapshot: [action],
      failedCreateEntities: new Set(['project:project-1']),
    })).toEqual({
      shouldSkip: true,
      reason: 'failed-create',
      entityKey: 'project:project-1',
    });
  });

  it('同实体 create 仍在处理快照中时跳过非 create 操作', () => {
    const createAction = queuedAction({ id: 'create-project', type: 'create' });
    const updateAction = queuedAction({ id: 'update-project', type: 'update' });

    expect(getQueuedActionSkipDecision({
      action: updateAction,
      currentPendingActions: [updateAction],
      processQueueSnapshot: [createAction, updateAction],
      failedCreateEntities: new Set(),
    })).toEqual({
      shouldSkip: true,
      reason: 'pending-create',
      entityKey: 'project:project-1',
    });
  });

  it('create 操作本身不受同实体 create 依赖规则阻塞', () => {
    const action = queuedAction({ type: 'create' });

    expect(getQueuedActionSkipDecision({
      action,
      currentPendingActions: [action],
      processQueueSnapshot: [action],
      failedCreateEntities: new Set(['project:project-1']),
    })).toEqual({
      shouldSkip: false,
      reason: null,
      entityKey: 'project:project-1',
    });
  });

  it('durably held actions are skipped by queue processing until explicitly activated', () => {
    const action = queuedAction({ syncState: 'held' as never });

    expect(getQueuedActionSkipDecision({
      action,
      currentPendingActions: [action],
      processQueueSnapshot: [action],
      failedCreateEntities: new Set(),
    })).toEqual({
      shouldSkip: true,
      reason: 'held',
      entityKey: 'project:project-1',
    });
  });
});
