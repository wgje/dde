const RETRY_DEFERRED_ERROR_NAME = 'RetryDeferredError';

export interface RetryDeferredError extends Error {
  readonly isRetryDeferred: true;
}

export function createRetryDeferredError(message: string): RetryDeferredError {
  const error = new Error(message) as RetryDeferredError;
  error.name = RETRY_DEFERRED_ERROR_NAME;
  Object.defineProperty(error, 'isRetryDeferred', {
    value: true,
    enumerable: true,
  });
  return error;
}

export function isRetryDeferredError(error: unknown): error is RetryDeferredError {
  return error instanceof Error
    && (
      error.name === RETRY_DEFERRED_ERROR_NAME
      || (error as { isRetryDeferred?: unknown }).isRetryDeferred === true
    );
}
