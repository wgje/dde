import { describe, expect, it } from 'vitest';
import {
  collectLegacyRetryReviewQueueIdentityOverlapErrors,
  mergeLegacyRetryReviewItems,
  parseLegacyRetryReviewItems,
  parseLegacyRetryReviewStorageValue,
} from './legacy-retry-review-backup.helpers';

function makeReviewItem(
  id: string,
  operationId: string,
  ownerUserId = 'user-1',
) {
  return {
    item: {
      id,
      operationId,
      sourceUserId: ownerUserId,
      type: 'task',
      operation: 'upsert',
      data: { id: `task-${id}`, content: 'review only' },
      retryCount: 3,
      createdAt: 1781539200000,
    },
    reason: 'terminal outcome requires review',
    quarantinedAt: '2026-06-16T00:00:00.000Z',
    ownerUserId,
  };
}

describe('legacy RetryQueue review backup helpers', () => {
  it('merges review records without changing IDs or operation IDs', () => {
    const existing = makeReviewItem('retry-existing', 'operation-existing');
    const incoming = makeReviewItem('retry-backup', 'operation-backup');
    const merged = mergeLegacyRetryReviewItems([existing], [incoming], 'user-1');

    expect(merged.map(record => [record.item.id, record.item.operationId])).toEqual([
      ['retry-existing', 'operation-existing'],
      ['retry-backup', 'operation-backup'],
    ]);
  });

  it('rejects owner mismatches, missing identity, and duplicate queue identity', () => {
    const foreign = makeReviewItem('retry-foreign', 'operation-foreign', 'user-2');
    expect(() => parseLegacyRetryReviewItems([foreign], 'user-1')).toThrow(/ownerUserId/);

    const missingOperationId = makeReviewItem('retry-missing-operation', 'operation-missing');
    delete (missingOperationId.item as { operationId?: string }).operationId;
    expect(() => parseLegacyRetryReviewItems([missingOperationId], 'user-1')).toThrow(/operationId/);

    const duplicate = makeReviewItem('retry-duplicate', 'operation-duplicate');
    expect(() => parseLegacyRetryReviewItems([duplicate, duplicate], 'user-1')).toThrow(/unique/);
  });

  it('rejects review identity that is also present in the active RetryQueue', () => {
    const review = makeReviewItem('retry-1', 'operation-1');
    const errors = collectLegacyRetryReviewQueueIdentityOverlapErrors(
      [{ id: 'retry-other', operationId: 'operation-1' }],
      [review],
    );

    expect(errors).toContain(
      'localState.legacyRetryReview[0].item.operationId also appears in localState.retryQueue',
    );
  });

  it('parses exact owner storage without synthesizing a new operation identity', () => {
    const review = makeReviewItem('retry-stored', 'operation-stored');

    expect(parseLegacyRetryReviewStorageValue(JSON.stringify([review]), 'user-1'))
      .toMatchObject([{ item: { id: 'retry-stored', operationId: 'operation-stored' } }]);
  });
});
