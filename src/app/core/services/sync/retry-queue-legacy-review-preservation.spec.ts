import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRetryQueueServiceSpecHarness, type RetryQueueServiceSpecHarness } from './retry-queue-service.spec-fixture';
import { createTask } from './retry-queue-test-data.spec-helpers';
import type { RetryQueueItem, LegacyRetryReviewItem } from './retry-queue.types';
import { parseLegacyRetryReviewItems } from '../../../../services/legacy-retry-review-backup.helpers';

describe('legacy review evidence preservation', () => {
  let h: RetryQueueServiceSpecHarness;
  beforeEach(() => { h = createRetryQueueServiceSpecHarness(); });
  afterEach(async () => { await h.teardown(); });
  const access = () => h.service as unknown as {
    quarantineLegacyRetryItem(item: RetryQueueItem, reason: string): boolean;
    hasUnknownOwnerLegacyReview(): boolean;
    getLegacyReviewItems(): Array<LegacyRetryReviewItem & { retainedVersions?: LegacyRetryReviewItem[] }>;
  };
  const item = (id: string): RetryQueueItem => ({ id, operationId: crypto.randomUUID(), type: 'task', operation: 'upsert', data: createTask(id), sourceUserId: 'test-user', projectId: crypto.randomUUID(), retryCount: 0, createdAt: 1 });

  it('different items are preserved once, identical retries do not replace evidence or log another isolation', () => {
    const a = item('a'); const b = item('b');
    expect(access().quarantineLegacyRetryItem(a, 'missing write intent')).toBe(true);
    expect(access().quarantineLegacyRetryItem(b, 'missing write intent')).toBe(true);
    const first = JSON.stringify(access().getLegacyReviewItems());
    expect(access().quarantineLegacyRetryItem(a, 'missing write intent')).toBe(true);
    expect(JSON.stringify(access().getLegacyReviewItems())).toBe(first);
    expect(h.loggerCategory.warn.mock.calls.filter(c => c[0] === '检测到需人工确认的 legacy retry 项，已隔离保留')).toHaveLength(2);
  });

  it('same queue id with another operation or payload preserves original IDs and every inspectable/exportable version', () => {
    const a = item('same-id'); access().quarantineLegacyRetryItem(a, 'legacy');
    const b = { ...a, operationId: crypto.randomUUID(), data: { ...a.data, content: 'new content' } } as RetryQueueItem;
    access().quarantineLegacyRetryItem(b, 'legacy');
    const c = { ...b, data: { ...b.data, content: 'another content' } } as RetryQueueItem;
    access().quarantineLegacyRetryItem(c, 'legacy');
    access().quarantineLegacyRetryItem(b, 'legacy');
    const records = access().getLegacyReviewItems();
    expect(records).toHaveLength(1);
    expect(records[0].item).toEqual(a);
    expect(records[0].retainedVersions?.map(v => v.item)).toEqual([b, c]);
    expect(parseLegacyRetryReviewItems(records, 'test-user')[0]['retainedVersions']).toEqual(records[0].retainedVersions);
  });

  it('isolation storage failure retains pre-existing evidence and does not report successful quarantine', () => {
    const a = item('storage-held'); access().quarantineLegacyRetryItem(a, 'legacy');
    const key = 'nanoflow.retry-queue.legacy-review.test-user';
    const before = localStorage.getItem(key);
    const original = localStorage.setItem.bind(localStorage);
    localStorage.setItem = () => { throw new Error('quota'); };
    try {
      expect(access().quarantineLegacyRetryItem({ ...a, operationId: crypto.randomUUID() }, 'legacy')).toBe(false);
      expect(localStorage.getItem(key)).toBe(before);
    } finally { localStorage.setItem = original; }
  });

  it('identical evidence retries Black Box local conflict repair after the first repair failed', async () => {
    const a = item('blackbox-repair');
    a.type = 'blackbox';
    a.data = { ...a.data, userId: 'test-user' } as typeof a.data;
    h.blackBoxSyncMock.markEntrySyncConflict.mockRejectedValueOnce(new Error('local failure')).mockResolvedValue(undefined);
    access().quarantineLegacyRetryItem(a, 'legacy');
    await Promise.resolve();
    access().quarantineLegacyRetryItem(a, 'legacy');
    expect(h.blackBoxSyncMock.markEntrySyncConflict).toHaveBeenCalledTimes(2);
    expect(access().getLegacyReviewItems()).toHaveLength(1);
  });

  it('same payload with another reason retains both explanations', () => {
    const a = item('changed-reason');
    access().quarantineLegacyRetryItem(a, 'owner unknown');
    access().quarantineLegacyRetryItem(a, 'write intent unknown');
    expect(access().getLegacyReviewItems()[0].reason).toBe('owner unknown');
    expect(access().getLegacyReviewItems()[0].retainedVersions?.[0].reason).toBe('write intent unknown');
  });

  it('runner quarantines separate legacy items once and does not replay or re-isolate them on the second drain', async () => {
    h.setOnline(true);
    h.service.add('task', 'upsert', createTask('runner-a'), 'project-a', 'test-user');
    h.service.add('task', 'upsert', createTask('runner-b'), 'project-a', 'test-user');
    await h.service.processQueue(undefined, true);
    expect(h.service.length).toBe(0);
    expect(access().getLegacyReviewItems()).toHaveLength(2);
    const first = JSON.stringify(access().getLegacyReviewItems());
    await h.service.processQueue(undefined, true);
    expect(JSON.stringify(access().getLegacyReviewItems())).toBe(first);
    expect(h.handler.pushTask).not.toHaveBeenCalled();
    expect(h.loggerCategory.warn.mock.calls.filter(c => c[0] === '检测到需人工确认的 legacy retry 项，已隔离保留')).toHaveLength(2);
  });

  it('unknown-owner evidence exposes only existence, never joins current owner contents', () => {
    const a = item('unknown'); delete a.sourceUserId;
    access().quarantineLegacyRetryItem(a, 'no owner');
    expect(access().hasUnknownOwnerLegacyReview()).toBe(true);
    expect(access().getLegacyReviewItems()).toEqual([]);
    expect(h.service.legacyReviewCount()).toBe(0);
  });
});