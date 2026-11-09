import { extractErrorMessage } from '../utils/result';
import type { QueueRetryError } from './action-queue-storage.service';

export type DeferredActionQueueRetry = {
  outcome: 'defer-retry';
  error: QueueRetryError;
};

export type FailedActionQueueRetry = {
  outcome: 'failed';
  error: QueueRetryError;
};

export type ActionQueueProcessorResult = boolean | DeferredActionQueueRetry | FailedActionQueueRetry;

export function buildDeferredActionQueueRetry(error: QueueRetryError): DeferredActionQueueRetry {
  return {
    outcome: 'defer-retry',
    error,
  };
}

export function buildFailedActionQueueRetry(error: QueueRetryError): FailedActionQueueRetry {
  return {
    outcome: 'failed',
    error,
  };
}

export function getProcessorRetryError(result: ActionQueueProcessorResult): QueueRetryError | null {
  if (isDeferredProcessorResult(result) || isFailedProcessorResult(result)) {
    return result.error;
  }

  return null;
}

export function toActionQueueRetryError(error: unknown): QueueRetryError {
  if (error && typeof error === 'object') {
    const maybeError = error as { code?: unknown; message?: unknown; details?: unknown };
    return {
      code: typeof maybeError.code === 'string' ? maybeError.code : undefined,
      message: extractErrorMessage(error),
      details: maybeError.details && typeof maybeError.details === 'object'
        ? maybeError.details as Record<string, unknown>
        : undefined,
    };
  }

  return { message: extractErrorMessage(error) };
}

function isDeferredProcessorResult(result: ActionQueueProcessorResult): result is DeferredActionQueueRetry {
  return typeof result === 'object' && result !== null && result.outcome === 'defer-retry';
}

function isFailedProcessorResult(result: ActionQueueProcessorResult): result is FailedActionQueueRetry {
  return typeof result === 'object' && result !== null && result.outcome === 'failed';
}
