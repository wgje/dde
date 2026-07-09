import { describe, expect, it, vi } from 'vitest';
import { ActionQueueDeadLetterNotifier } from './action-queue-dead-letter-notifier';
import { LOCAL_QUEUE_CONFIG } from './action-queue-storage.helpers';
import type { DeadLetterItem, QueuedAction } from './action-queue.types';

const logger = {
  warn: vi.fn(),
  error: vi.fn(),
};

const toast = {
  warning: vi.fn(),
  error: vi.fn(),
};

const sentryLazyLoader = {
  addBreadcrumb: vi.fn(),
  captureMessage: vi.fn(),
};

function createAction(overrides: Partial<QueuedAction> = {}): QueuedAction {
  return {
    id: 'action-1',
    type: 'update',
    entityType: 'task',
    entityId: 'task-1',
    payload: { task: { id: 'task-1' }, projectId: 'project-1' } as QueuedAction['payload'],
    timestamp: 1,
    retryCount: 0,
    priority: 'normal',
    ...overrides,
    operationId: overrides.operationId ?? 'op-action-1',
  };
}

function createDeadLetterItem(action = createAction(), reason = 'failed'): DeadLetterItem {
  return {
    action,
    failedAt: new Date(0).toISOString(),
    reason,
  };
}

function createNotifier(overrides: Partial<{
  failureCallbacks: Array<(item: DeadLetterItem) => void>;
  getFailureCallbacks: () => Array<(item: DeadLetterItem) => void>;
  deadLetterQueue: DeadLetterItem[];
  getDeadLetterQueue: () => DeadLetterItem[];
}> = {}): ActionQueueDeadLetterNotifier {
  vi.clearAllMocks();
  return new ActionQueueDeadLetterNotifier({
    logger,
    toast,
    sentryLazyLoader,
    getFailureCallbacks: overrides.getFailureCallbacks ?? (() => overrides.failureCallbacks ?? []),
    getDeadLetterQueue: overrides.getDeadLetterQueue ?? (() => overrides.deadLetterQueue ?? []),
    getActionDescription: (action) => `${action.type}:${action.entityType}`,
  });
}

describe('ActionQueueDeadLetterNotifier', () => {
  it('notifies failure callbacks and records a breadcrumb when an action moves to dead letter', () => {
    const failureCallback = vi.fn();
    const item = createDeadLetterItem();
    const notifier = createNotifier({
      failureCallbacks: [failureCallback],
      deadLetterQueue: [item],
    });

    notifier.handleDeadLetterMoved(item, 'failed');

    expect(failureCallback).toHaveBeenCalledWith(item);
    expect(sentryLazyLoader.addBreadcrumb).toHaveBeenCalledWith(expect.objectContaining({
      category: 'sync',
      message: 'Action moved to dead letter',
      data: expect.objectContaining({
        actionId: 'action-1',
        deadLetterSize: 1,
      }),
    }));
    expect(logger.warn).toHaveBeenCalledWith('Action moved to dead letter queue:', expect.any(Object));
  });

  it('isolates errors thrown by failure callbacks', () => {
    const error = new Error('callback failed');
    const item = createDeadLetterItem();
    const notifier = createNotifier({
      failureCallbacks: [vi.fn(() => { throw error; })],
      deadLetterQueue: [item],
    });

    notifier.handleDeadLetterMoved(item, 'failed');

    expect(logger.error).toHaveBeenCalledWith('Dead letter callback error', { error });
  });

  it('continues notifying later failure callbacks after one callback throws', () => {
    const error = new Error('first callback failed');
    const item = createDeadLetterItem();
    const firstCallback = vi.fn(() => {
      throw error;
    });
    const secondCallback = vi.fn();
    const notifier = createNotifier({
      failureCallbacks: [firstCallback, secondCallback],
      deadLetterQueue: [item],
    });

    notifier.handleDeadLetterMoved(item, 'failed');

    expect(firstCallback).toHaveBeenCalledWith(item);
    expect(secondCallback).toHaveBeenCalledWith(item);
    expect(logger.error).toHaveBeenCalledWith('Dead letter callback error', { error });
    expect(sentryLazyLoader.addBreadcrumb).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ actionId: item.action.id }),
    }));
  });

  it('continues notifying later callbacks when callback error logging fails', () => {
    const callbackError = new Error('first callback failed');
    const loggerError = new Error('logger failed');
    const item = createDeadLetterItem();
    const firstCallback = vi.fn(() => {
      throw callbackError;
    });
    const secondCallback = vi.fn();
    const notifier = createNotifier({
      failureCallbacks: [firstCallback, secondCallback],
      deadLetterQueue: [item],
    });
    logger.error.mockImplementationOnce(() => {
      throw loggerError;
    });

    expect(() => notifier.handleDeadLetterMoved(item, 'failed')).not.toThrow();

    expect(firstCallback).toHaveBeenCalledWith(item);
    expect(secondCallback).toHaveBeenCalledWith(item);
    expect(sentryLazyLoader.addBreadcrumb).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ actionId: item.action.id }),
    }));
    expect(logger.warn).toHaveBeenCalledWith('Action moved to dead letter queue:', expect.any(Object));
  });

  it('continues dead-letter logging and telemetry when the failure callback provider throws', () => {
    const error = new Error('callback provider failed');
    const item = createDeadLetterItem();
    const notifier = createNotifier({
      getFailureCallbacks: () => {
        throw error;
      },
      deadLetterQueue: [item],
    });

    expect(() => notifier.handleDeadLetterMoved(item, 'failed')).not.toThrow();

    expect(logger.error).toHaveBeenCalledWith('Dead letter callback provider error', { error });
    expect(sentryLazyLoader.addBreadcrumb).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        actionId: item.action.id,
        reason: 'failed',
      }),
    }));
    expect(logger.warn).toHaveBeenCalledWith('Action moved to dead letter queue:', expect.any(Object));
  });

  it('continues core dead-letter logging when the dead-letter queue provider throws', () => {
    const error = new Error('dead letter queue unavailable');
    const criticalItem = createDeadLetterItem(createAction({
      priority: 'critical',
    }));
    const notifier = createNotifier({
      getDeadLetterQueue: () => {
        throw error;
      },
    });

    expect(() => notifier.handleDeadLetterMoved(criticalItem, 'failed')).not.toThrow();

    expect(logger.error).toHaveBeenCalledWith('Dead letter queue provider error', { error });
    expect(logger.warn).toHaveBeenCalledWith('Action moved to dead letter queue:', expect.objectContaining({
      actionId: criticalItem.action.id,
      reason: 'failed',
    }));
  });

  it('isolates breadcrumb failures when an action moves to dead letter', () => {
    const error = new Error('breadcrumb failed');
    const item = createDeadLetterItem();
    const notifier = createNotifier({ deadLetterQueue: [item] });
    sentryLazyLoader.addBreadcrumb.mockImplementationOnce(() => {
      throw error;
    });

    expect(() => notifier.handleDeadLetterMoved(item, 'failed')).not.toThrow();

    expect(logger.error).toHaveBeenCalledWith('Dead letter breadcrumb error', { error });
    expect(logger.warn).toHaveBeenCalledWith('Action moved to dead letter queue:', expect.any(Object));
  });

  it('uses critical failure thresholds for user notifications', () => {
    const criticalItems = Array.from(
      { length: LOCAL_QUEUE_CONFIG.CRITICAL_FAILURE_NOTIFY_THRESHOLD },
      (_, index) => createDeadLetterItem(createAction({
        id: `critical-${index}`,
        priority: 'critical',
      })),
    );
    const notifier = createNotifier({ deadLetterQueue: criticalItems });

    notifier.handleDeadLetterMoved(criticalItems.at(-1)!, 'failed');

    expect(toast.error).toHaveBeenCalledWith(
      '同步失败',
      `有 ${LOCAL_QUEUE_CONFIG.CRITICAL_FAILURE_NOTIFY_THRESHOLD} 个重要操作无法完成同步，请检查网络或稍后重试`,
    );
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('continues dead-letter telemetry and core logging when the critical warning toast fails', () => {
    const criticalItem = createDeadLetterItem(createAction({
      priority: 'critical',
    }));
    const notifier = createNotifier({ deadLetterQueue: [criticalItem] });
    toast.warning.mockImplementationOnce(() => {
      throw new Error('toast failed');
    });

    expect(() => notifier.handleDeadLetterMoved(criticalItem, 'failed')).not.toThrow();

    expect(sentryLazyLoader.addBreadcrumb).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        actionId: criticalItem.action.id,
        reason: 'failed',
      }),
    }));
    expect(logger.warn).toHaveBeenCalledWith('Action moved to dead letter queue:', expect.objectContaining({
      actionId: criticalItem.action.id,
      reason: 'failed',
    }));
  });

  it('does not repeat the critical threshold toast for each additional dead letter', () => {
    const criticalItems = Array.from(
      { length: LOCAL_QUEUE_CONFIG.CRITICAL_FAILURE_NOTIFY_THRESHOLD },
      (_, index) => createDeadLetterItem(createAction({
        id: `critical-${index}`,
        priority: 'critical',
      })),
    );
    const notifier = createNotifier({ deadLetterQueue: criticalItems });

    notifier.handleDeadLetterMoved(criticalItems.at(-1)!, 'failed');
    criticalItems.push(createDeadLetterItem(createAction({
      id: 'critical-after-threshold',
      priority: 'critical',
    })));
    notifier.handleDeadLetterMoved(criticalItems.at(-1)!, 'failed again');

    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(sentryLazyLoader.addBreadcrumb).toHaveBeenCalledTimes(2);
  });

  it('reports dependent actions and warns when a critical action is blocked', () => {
    const notifier = createNotifier();
    const queue = [
      createAction({ id: 'create-1', type: 'create', priority: 'critical' }),
      createAction({ id: 'update-1', type: 'update', priority: 'critical' }),
    ];

    notifier.pauseDependentActions('task', 'task-1', queue);

    expect(logger.warn).toHaveBeenCalledWith('Create 失败，暂停依赖操作', expect.objectContaining({
      dependentCount: 1,
      dependentTypes: ['update'],
    }));
    expect(sentryLazyLoader.captureMessage).toHaveBeenCalledWith(
      'Create failed, dependent actions paused',
      expect.objectContaining({
        tags: { operation: 'pauseDependentActions', entityType: 'task' },
      }),
    );
    expect(toast.warning).toHaveBeenCalledWith('同步受阻', '有操作因前置操作失败而暂停，请检查网络连接');
  });
});
