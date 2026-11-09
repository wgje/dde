import {
  getRemainingBrowserNetworkResumeDelayMs,
  isBrowserNetworkSuspendedWindow,
} from '../../../../utils/browser-network-suspension';
import type {
  RetryQueueSliceResult,
  RetryQueueSliceRuntime,
} from './retry-queue.types';

export interface RetryQueueSliceResultParams {
  startedAt: number;
  completed: boolean;
  processed?: number;
  remaining: number;
  now?: number;
}

export function createRetryQueueSliceResult({
  startedAt,
  completed,
  processed = 0,
  remaining,
  now = Date.now(),
}: RetryQueueSliceResultParams): RetryQueueSliceResult {
  return {
    processed,
    remaining,
    durationMs: now - startedAt,
    completed,
  };
}

export function shouldStopRetryQueueSliceForBudget(
  runtime: Pick<RetryQueueSliceRuntime, 'processedCount' | 'maxItems' | 'startedAt' | 'maxDurationMs'>,
  now = Date.now(),
): boolean {
  return runtime.processedCount >= runtime.maxItems ||
    (now - runtime.startedAt >= runtime.maxDurationMs && runtime.processedCount > 0);
}

export interface RetryQueueSliceCompletionLogEntry {
  processedCount: number;
  successCount: number;
  expiredCount: number;
  remainingCount: number;
  maxItems: number | null;
  maxDurationMs: number | null;
  durationMs: number;
  stoppedByBudget: boolean;
}

export interface RetryQueueSliceCompletionSummary {
  result: RetryQueueSliceResult;
  logEntry: RetryQueueSliceCompletionLogEntry | null;
}

type RetryQueueSliceCompletionRuntime = Pick<
  RetryQueueSliceRuntime,
  | 'startedAt'
  | 'processedCount'
  | 'successfulReplayCount'
  | 'expiredIds'
  | 'maxItems'
  | 'maxDurationMs'
  | 'stoppedByBudget'
>;

export function createRetryQueueSliceCompletionSummary(
  runtime: RetryQueueSliceCompletionRuntime,
  remaining: number,
  now = Date.now(),
): RetryQueueSliceCompletionSummary {
  const durationMs = now - runtime.startedAt;

  return {
    result: {
      processed: runtime.processedCount,
      remaining,
      durationMs,
      completed: !runtime.stoppedByBudget,
    },
    logEntry: runtime.processedCount > 0
      ? {
          processedCount: runtime.processedCount,
          successCount: runtime.successfulReplayCount,
          expiredCount: runtime.expiredIds.size,
          remainingCount: remaining,
          maxItems: Number.isFinite(runtime.maxItems) ? runtime.maxItems : null,
          maxDurationMs: Number.isFinite(runtime.maxDurationMs) ? runtime.maxDurationMs : null,
          durationMs,
          stoppedByBudget: runtime.stoppedByBudget,
        }
      : null,
  };
}

export interface RetryQueueManualResumeWaitOptions {
  isManualTrigger: boolean;
  isLifecycleClosed: () => boolean;
  isSuspendedWindow?: () => boolean;
  getRemainingDelayMs?: () => number;
  wait?: (delayMs: number) => Promise<void>;
}

export type RetryQueueManualResumeWaitResult = 'continue' | 'closed';

function waitForDelay(delayMs: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, delayMs));
}

export async function waitForManualRetryQueueResumeWindow({
  isManualTrigger,
  isLifecycleClosed,
  isSuspendedWindow = isBrowserNetworkSuspendedWindow,
  getRemainingDelayMs = getRemainingBrowserNetworkResumeDelayMs,
  wait = waitForDelay,
}: RetryQueueManualResumeWaitOptions): Promise<RetryQueueManualResumeWaitResult> {
  if (!isManualTrigger) {
    return 'continue';
  }

  while (isSuspendedWindow()) {
    const delayMs = Math.max(0, getRemainingDelayMs());
    if (delayMs <= 0) {
      break;
    }
    await wait(delayMs);
    if (isLifecycleClosed()) {
      return 'closed';
    }
  }

  return 'continue';
}
