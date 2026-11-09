import { describe, expect, it } from 'vitest';

import { extractRestorableDeadLetters } from './action-queue-owner-dead-letter-restore.helpers';
import type { DeadLetterItem, QueuedAction } from './action-queue.types';

describe('action queue owner dead-letter restore helpers', () => {
  it('skips entries whose owner resolver throws while restoring later valid dead letters', () => {
    const badItem = createDeadLetterItem('bad-owner-source');
    const validItem = createDeadLetterItem('valid-owner-source');

    const restored = extractRestorableDeadLetters(
      [badItem, validItem],
      'user-a',
      item => {
        if (item.action.id === badItem.action.id) {
          throw new Error('owner resolver failed');
        }
        return 'user-a';
      },
    );

    expect(restored).toHaveLength(1);
    expect(restored[0]?.action.id).toBe(validItem.action.id);
    expect(restored[0]?.action.syncState).toBe('dead_letter');
  });
});

function createDeadLetterItem(id: string): DeadLetterItem {
  return {
    action: createQueuedAction(id),
    failedAt: new Date().toISOString(),
    reason: 'failed',
  };
}

function createQueuedAction(id: string): QueuedAction {
  return {
    entityId: 'task-1',
    entityType: 'task',
    id,
    operationId: `operation-${id}`,
    payload: {
      projectId: 'project-1',
      task: { id: 'task-1', title: id } as never,
    },
    priority: 'normal',
    retryCount: 0,
    syncState: 'dead_letter',
    timestamp: Date.now(),
    type: 'update',
  };
}
