import { describe, expect, it } from 'vitest';

import {
  createRetryQueueSliceCompletionSummary,
  createRetryQueueSliceResult,
  shouldStopRetryQueueSliceForBudget,
  waitForManualRetryQueueResumeWindow,
} from './retry-queue-runner-slice.helpers';

describe('retry queue runner slice helpers', () => {
  it('creates slice results from queue state and elapsed time', () => {
    expect(createRetryQueueSliceResult({
      startedAt: 10,
      completed: true,
      remaining: 3,
      now: 35,
    })).toEqual({
      processed: 0,
      remaining: 3,
      durationMs: 25,
      completed: true,
    });
  });

  it('stops slices when item or elapsed-time budgets are exhausted', () => {
    expect(shouldStopRetryQueueSliceForBudget({
      processedCount: 2,
      maxItems: 2,
      startedAt: 100,
      maxDurationMs: 1000,
    }, 150)).toBe(true);

    expect(shouldStopRetryQueueSliceForBudget({
      processedCount: 1,
      maxItems: 5,
      startedAt: 100,
      maxDurationMs: 50,
    }, 150)).toBe(true);

    expect(shouldStopRetryQueueSliceForBudget({
      processedCount: 0,
      maxItems: 5,
      startedAt: 100,
      maxDurationMs: 50,
    }, 150)).toBe(false);
  });

  it('creates completion summaries with optional log payloads', () => {
    const runtime = {
      startedAt: 100,
      processedCount: 2,
      successfulReplayCount: 1,
      expiredIds: new Set(['expired-1']),
      maxItems: 5,
      maxDurationMs: Number.POSITIVE_INFINITY,
      stoppedByBudget: true,
    };

    expect(createRetryQueueSliceCompletionSummary(runtime, 3, 150)).toEqual({
      result: {
        processed: 2,
        remaining: 3,
        durationMs: 50,
        completed: false,
      },
      logEntry: {
        processedCount: 2,
        successCount: 1,
        expiredCount: 1,
        remainingCount: 3,
        maxItems: 5,
        maxDurationMs: null,
        durationMs: 50,
        stoppedByBudget: true,
      },
    });
  });

  it('skips suspended-window waiting for background retry attempts', async () => {
    let suspendedChecks = 0;

    await expect(waitForManualRetryQueueResumeWindow({
      isManualTrigger: false,
      isLifecycleClosed: () => false,
      isSuspendedWindow: () => {
        suspendedChecks += 1;
        return true;
      },
    })).resolves.toBe('continue');

    expect(suspendedChecks).toBe(0);
  });

  it('waits for manual retry attempts until the resume window clears', async () => {
    const waits: number[] = [];
    let suspendedChecks = 0;

    await expect(waitForManualRetryQueueResumeWindow({
      isManualTrigger: true,
      isLifecycleClosed: () => false,
      isSuspendedWindow: () => {
        suspendedChecks += 1;
        return suspendedChecks <= 2;
      },
      getRemainingDelayMs: () => 25,
      wait: async delayMs => {
        waits.push(delayMs);
      },
    })).resolves.toBe('continue');

    expect(waits).toEqual([25, 25]);
  });

  it('stops manual waiting when the owning runner closes during a delay', async () => {
    await expect(waitForManualRetryQueueResumeWindow({
      isManualTrigger: true,
      isLifecycleClosed: () => true,
      isSuspendedWindow: () => true,
      getRemainingDelayMs: () => 25,
      wait: async () => undefined,
    })).resolves.toBe('closed');
  });
});
