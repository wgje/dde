import { describe, expect, it } from 'vitest';

import { buildRefreshFingerprint } from './retry-queue-fingerprint';
import type { RetryQueueItem } from './retry-queue.types';

describe('retry-queue-fingerprint', () => {
  it('includes normalized task delete CAS baselines in the refresh fingerprint', () => {
    const baseItem: RetryQueueItem = {
      id: 'queue-item-1',
      type: 'project',
      operation: 'upsert',
      data: { id: 'project-1' } as RetryQueueItem['data'],
      retryCount: 0,
      createdAt: 123,
      sourceUserId: 'owner-a',
      operationId: 'test-retry-fingerprint',
      taskIdsToDelete: ['task-b', 'task-a'],
      taskDeleteBaseUpdatedAtMap: {
        'task-a': '2026-06-11T01:00:00.000Z',
        'task-b': undefined,
      },
    };

    expect(buildRefreshFingerprint({
      ...baseItem,
      taskDeleteBaseUpdatedAtMap: {
        'task-b': null,
        'task-a': '2026-06-11T01:00:00.000Z',
      },
    })).toBe(buildRefreshFingerprint(baseItem));

    expect(buildRefreshFingerprint({
      ...baseItem,
      taskDeleteBaseUpdatedAtMap: {
        'task-a': '2026-06-11T02:00:00.000Z',
        'task-b': undefined,
      },
    })).not.toBe(buildRefreshFingerprint(baseItem));
  });
});
