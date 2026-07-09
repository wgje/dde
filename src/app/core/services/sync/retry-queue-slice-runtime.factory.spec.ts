import { describe, expect, it, vi } from 'vitest';

import { createRetryQueueSliceRuntime } from './retry-queue-slice-runtime.factory';
import type { RetryQueueItem } from './retry-queue.types';

describe('createRetryQueueSliceRuntime', () => {
  it('initializes retry queue slice runtime state from prepared inputs', () => {
    const item = {
      id: 'retry-1',
      type: 'task',
      operation: 'upsert',
      data: { id: 'task-1' },
      retryCount: 0,
      createdAt: 1,
      sourceUserId: 'user-1',
    } as RetryQueueItem;
    const operationHandler = {
      pushTask: vi.fn(),
      deleteTask: vi.fn(),
      pushProject: vi.fn(),
      pushConnection: vi.fn(),
      pushBlackBoxEntry: vi.fn(),
      isSessionExpired: vi.fn(),
      isOnline: vi.fn(),
      onProcessingStateChange: vi.fn(),
    };
    const leaseHandle = {
      tabId: 'tab-test',
      lockName: 'nanoflow-sync:test:user-1:__global__',
      mode: 'memory-only' as const,
      release: vi.fn(),
    };

    const runtime = createRetryQueueSliceRuntime({
      options: { maxItems: 1 },
      startedAt: 100,
      generation: 3,
      itemsSnapshot: [item],
      maxItems: 1,
      maxDurationMs: 5000,
      operationHandler,
      leaseHandle,
    });

    expect(runtime).toEqual({
      options: { maxItems: 1 },
      startedAt: 100,
      generation: 3,
      initialQueueLength: 1,
      itemsSnapshot: [item],
      maxItems: 1,
      maxDurationMs: 5000,
      operationHandler,
      leaseHandle,
      hasNotifiedSyncStart: false,
      successfulReplayCount: 0,
      hadTerminalRemoval: false,
      stoppedByBudget: false,
      drainCompletedBySuccessfulReplay: false,
      expiredIds: expect.any(Set),
      processedIds: expect.any(Set),
      exceededCount: 0,
      processedCount: 0,
    });
    expect(runtime.expiredIds.size).toBe(0);
    expect(runtime.processedIds.size).toBe(0);
  });
});
