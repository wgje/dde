import { describe, expect, it } from 'vitest';
import { QUEUE_CONFIG } from '../config';
import { classifyQueueRetryError } from './action-queue-storage.helpers';
import { describeDeferredRetryReason, resolveDeferredRetryDelay } from './action-queue-retry-serialization';
import { createFailedActionSettlement } from './action-queue-owner-storage-failed-settlement.helpers';
import type { QueueRetryError } from './action-queue-storage.service';
import type { QueuedAction } from './action-queue.types';

const pending = (details: Record<string, unknown> = {}): QueueRetryError => ({
  code: 'FOCUS_CONSOLE_SAVE_FAILED', message: 'snapshot requires reconciliation',
  details: { reason: 'focus-snapshot-reconciliation-pending', retryable: true, deferred: true, ...details },
});

describe('Focus snapshot reconciliation deferral is exact and nonterminal', () => {
  it('uses the exact reason and fixed base delay, not browser suspension polling', () => {
    expect(classifyQueueRetryError(pending())).toBe('deferred');
    expect(describeDeferredRetryReason(pending())).toBe('focus-snapshot-reconciliation-pending');
    expect(resolveDeferredRetryDelay(pending())).toBe(QUEUE_CONFIG.RETRY_BASE_DELAY);
  });

  it.each([
    { retryable: false }, { deferred: false }, { retryable: undefined }, { deferred: undefined },
    { retryable: 'true' }, { deferred: 'true' },
    { reason: 'other-reconciliation-pending' }, { reason: 'FOCUS-SNAPSHOT-RECONCILIATION-PENDING' },
    { reason: undefined },
  ])('does not grant deferral for malformed or unrelated details %j', details => {
    expect(classifyQueueRetryError(pending(details))).toBe('unknown');
  });

  it.each(['stale-payload-preserved-remotely', 'operation_id_payload_mismatch'])(
    'retains structured terminal business precedence for %s', rpcReason => {
      const error = pending({ rpcReason });
      expect(classifyQueueRetryError(error)).toBe('business');
      expect(createFailedActionSettlement({ retryCount: 0 } as QueuedAction, error))
        .toMatchObject({ errorType: 'business', shouldDeadLetter: true });
    },
  );

  it('does not use up a retry budget even at its cap', () => {
    expect(createFailedActionSettlement({ retryCount: 999 } as QueuedAction, pending()))
      .toMatchObject({ errorType: 'deferred', shouldDeadLetter: false, syncState: 'retry_scheduled' });
  });
});
