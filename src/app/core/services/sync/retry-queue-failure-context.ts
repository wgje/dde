import { supabaseErrorToError, type EnhancedError } from '../../../../utils/supabase-error';
import type { RetryQueueLastFailure } from './retry-queue.service';

export function createRetryQueueLastFailure(
  error: EnhancedError,
  recordedAt = Date.now(),
): RetryQueueLastFailure | undefined {
  if (error.remoteOutcome !== 'unknown') {
    return undefined;
  }

  return {
    errorType: error.errorType,
    message: error.message,
    remoteOutcome: error.remoteOutcome,
    recordedAt,
  };
}

/**
 * 重放路径抛出的错误可能已是增强错误，也可能是原始对象；
 * 统一归一后再判定是否属于「远端结果未知」失败，用于回写 RetryQueueItem.lastFailure。
 */
export function createRetryQueueLastFailureFromUnknownError(
  error: unknown,
  recordedAt = Date.now(),
): RetryQueueLastFailure | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }

  const enhanced = typeof (error as { errorType?: unknown }).errorType === 'string'
    ? error as EnhancedError
    : supabaseErrorToError(error);
  return createRetryQueueLastFailure(enhanced, recordedAt);
}
