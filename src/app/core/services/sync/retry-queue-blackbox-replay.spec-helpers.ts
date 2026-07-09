import { expect, it, vi } from 'vitest';

import type { BlackBoxEntry } from '../../../../models/focus';
import type { RetryOperationHandler, RetryQueueService } from './retry-queue.service';

const SYNC_OPERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface RetryQueueBlackBoxReplaySpecContext {
  service: RetryQueueService;
  handler: RetryOperationHandler;
  setOnline(value: boolean): void;
  createBlackBoxEntry(label: string, overrides?: Partial<BlackBoxEntry>): BlackBoxEntry;
  stableUUID(label: string): string;
}

export function registerRetryQueueBlackBoxReplaySpecs(
  getContext: () => RetryQueueBlackBoxReplaySpecContext,
): void {
  it('处理中的旧 blackbox 快照成功后，不应删除同 id 的更新快照', async () => {
    const { service, handler, setOnline, createBlackBoxEntry, stableUUID } = getContext();
    const entryId = stableUUID('blackbox-refresh-during-processing');
    const olderEntry = createBlackBoxEntry('refresh-old', {
      id: entryId,
      updatedAt: '2026-04-21T00:00:00.000Z',
      isCompleted: false,
    });
    const newerEntry = createBlackBoxEntry('refresh-new', {
      id: entryId,
      updatedAt: '2026-04-21T00:00:05.000Z',
      isCompleted: true,
    });

    service.add('blackbox', 'upsert', olderEntry, undefined, 'test-user');
    setOnline(true);
    (handler.pushBlackBoxEntry as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      service.add('blackbox', 'upsert', newerEntry, undefined, 'test-user');
      return true;
    });

    const result = await service.processQueueSlice({ maxItems: 1, maxDurationMs: 1000 });

    expect(result.processed).toBe(1);
    expect(handler.pushBlackBoxEntry).toHaveBeenCalledWith(
      olderEntry,
      'test-user',
      expect.stringMatching(SYNC_OPERATION_ID_PATTERN),
    );
    expect(service.getItems()).toEqual([
      expect.objectContaining({
        type: 'blackbox',
        data: expect.objectContaining({
          id: entryId,
          updatedAt: newerEntry.updatedAt,
          isCompleted: true,
        }),
      }),
    ]);
  });

  it('处理中的 blackbox 快照被同 payload 重复入队时，不应刷新队列项导致下一轮重复回放', async () => {
    const { service, handler, setOnline, createBlackBoxEntry } = getContext();
    const entry = createBlackBoxEntry('same-payload-reentry', {
      updatedAt: '2026-04-21T00:00:05.000Z',
      syncStatus: 'pending',
    });

    service.add('blackbox', 'upsert', entry, undefined, 'test-user');
    setOnline(true);
    (handler.pushBlackBoxEntry as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      service.add('blackbox', 'upsert', { ...entry }, undefined, 'test-user');
      return true;
    });

    const result = await service.processQueueSlice({ maxItems: 1, maxDurationMs: 1000 });

    expect(result.processed).toBe(1);
    expect(handler.pushBlackBoxEntry).toHaveBeenCalledWith(
      entry,
      'test-user',
      expect.stringMatching(SYNC_OPERATION_ID_PATTERN),
    );
    expect(service.getItems()).toEqual([]);
  });

  it('更新同一 blackbox 重试项时，空正文不能覆盖已有完整正文', () => {
    const { service, createBlackBoxEntry, stableUUID } = getContext();
    const entryId = stableUUID('blackbox-preserve-content');
    const fullEntry = createBlackBoxEntry('content-full', {
      id: entryId,
      content: '完整黑匣子正文',
      updatedAt: '2026-04-21T00:00:00.000Z',
      isCompleted: false,
    });
    const blankStatusUpdate = createBlackBoxEntry('content-blank', {
      id: entryId,
      content: '',
      updatedAt: '2026-04-21T00:00:05.000Z',
      isCompleted: true,
    });

    service.add('blackbox', 'upsert', fullEntry, undefined, 'test-user');
    service.add('blackbox', 'upsert', blankStatusUpdate, undefined, 'test-user');

    expect(service.getItems()).toHaveLength(1);
    expect(service.getItems()[0]).toEqual(expect.objectContaining({
      type: 'blackbox',
      data: expect.objectContaining({
        id: entryId,
        content: '完整黑匣子正文',
        updatedAt: blankStatusUpdate.updatedAt,
        isCompleted: true,
      }),
    }));
  });
}
