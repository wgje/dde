import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearRetryQueuePendingUnknownOutcomeFence,
  createRetryQueuePendingUnknownOutcomeFence,
  pendingUnknownOutcomeFenceKey,
  readRetryQueuePendingUnknownOutcomeFences,
} from './retry-queue-pending-unknown-outcome-fence';
import { createTask, stableUUID } from './retry-queue-test-data.spec-helpers';

describe('RetryQueue pending unknown-outcome fence storage contract', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    sessionStorage.clear();
  });

  it('malformed owner fence is diagnosed and cannot be cleared or treated as writable state', () => {
    const key = pendingUnknownOutcomeFenceKey('owner-a');
    localStorage.setItem(key, '{malformed');
    const snapshot = readRetryQueuePendingUnknownOutcomeFences();
    expect(snapshot.records).toEqual([]);
    expect(snapshot.malformedKeys).toContain(`local:${key}`);

    const fence = createRetryQueuePendingUnknownOutcomeFence(
      {
        id: stableUUID('malformed-owner-queue'),
        type: 'task',
        operation: 'upsert',
        data: createTask('malformed-owner-fence'),
        retryCount: 0,
        createdAt: 1,
        operationId: stableUUID('malformed-owner-op'),
      },
      'owner-a',
    );
    expect(clearRetryQueuePendingUnknownOutcomeFence(fence)).toBe(false);
    expect(localStorage.getItem(key)).toBe('{malformed');
  });

  it('failed storage removal remains fail closed and retrying clear is idempotent after recovery', () => {
    const task = createTask('clear-failure');
    const fence = createRetryQueuePendingUnknownOutcomeFence(
      {
        id: stableUUID('clear-failure-queue'),
        type: 'task',
        operation: 'upsert',
        data: task,
        retryCount: 0,
        createdAt: 1,
        operationId: stableUUID('clear-failure-op'),
      },
      'owner-a',
    );
    const key = pendingUnknownOutcomeFenceKey('owner-a');
    localStorage.setItem(key, JSON.stringify(fence));
    const originalRemoveItem = localStorage.removeItem.bind(localStorage);
    const removeSpy = vi.spyOn(localStorage, 'removeItem').mockImplementation(function (storageKey: string) {
      if (storageKey === key) throw new Error('simulated storage removal failure');
      return originalRemoveItem(storageKey);
    });

    expect(clearRetryQueuePendingUnknownOutcomeFence(fence)).toBe(false);
    expect(localStorage.getItem(key)).not.toBeNull();
    expect(removeSpy).toHaveBeenCalledWith(key);

    removeSpy.mockRestore();
    expect(clearRetryQueuePendingUnknownOutcomeFence(fence)).toBe(true);
    expect(clearRetryQueuePendingUnknownOutcomeFence(fence)).toBe(true);
    expect(localStorage.getItem(key)).toBeNull();
  });
});
