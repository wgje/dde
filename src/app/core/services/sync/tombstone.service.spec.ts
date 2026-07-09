import { Injector } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoggerService } from '../../../../services/logger.service';
import { RequestThrottleService } from '../../../../services/request-throttle.service';
import { AttachmentCleanupOutboxService } from '../../../../services/attachment-cleanup-outbox.service';
import { resetBrowserNetworkSuspensionTrackingForTests } from '../../../../utils/browser-network-suspension';
import { TombstoneService } from './tombstone.service';

function createPagedTombstoneQuery(
  rows: Array<{ task_id: string; deleted_at: string | null }>,
  ranges: Array<[number, number]>,
) {
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    order: vi.fn(),
    range: vi.fn(async (from: number, to: number) => {
      ranges.push([from, to]);
      return { data: rows.slice(from, to + 1), error: null };
    }),
  };

  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.order.mockReturnValue(query);

  return query;
}

describe('TombstoneService', () => {
  beforeEach(() => {
    resetBrowserNetworkSuspensionTrackingForTests();
    localStorage.clear();
    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    resetBrowserNetworkSuspensionTrackingForTests();
  });

  it('getTombstonesWithCache 应分页加载超过 1000 条 task tombstones', async () => {
    const rows = Array.from({ length: 1001 }, (_, index) => ({
      task_id: `task-${index}`,
      deleted_at: `2026-06-09T00:${String(index % 60).padStart(2, '0')}:00.000Z`,
    }));
    const ranges: Array<[number, number]> = [];
    const query = createPagedTombstoneQuery(rows, ranges);
    const client = {
      from: vi.fn((table: string) => {
        if (table === 'task_tombstones') return query;
        throw new Error(`unexpected table ${table}`);
      }),
    };

    const injector = Injector.create({
      providers: [
        { provide: TombstoneService, useClass: TombstoneService },
        {
          provide: LoggerService,
          useValue: {
            category: () => ({
              debug: vi.fn(),
              info: vi.fn(),
              warn: vi.fn(),
              error: vi.fn(),
            }),
          },
        },
        {
          provide: RequestThrottleService,
          useValue: {
            execute: vi.fn(async (_key: string, operation: () => Promise<unknown>) => operation()),
          },
        },
        {
          provide: AttachmentCleanupOutboxService,
          useValue: {
            enqueuePaths: vi.fn().mockResolvedValue([]),
            removePaths: vi.fn().mockResolvedValue(undefined),
          },
        },
      ],
    });

    const service = injector.get(TombstoneService);
    const result = await service.getTombstonesWithCache('project-1', client as never);

    expect(result.error).toBeNull();
    expect(result.data).toHaveLength(1001);
    expect(result.data?.[1000]?.task_id).toBe('task-1000');
    expect(ranges).toEqual([[0, 999], [1000, 1999]]);
    expect(query.order).toHaveBeenCalledWith('deleted_at', { ascending: true });
    expect(query.order).toHaveBeenCalledWith('task_id', { ascending: true });
  });

  it('deleteAttachmentFilesFromStorage client 缺失时仍先持久化附件清理 outbox', async () => {
    const enqueuePaths = vi.fn().mockResolvedValue([]);
    const removePaths = vi.fn().mockResolvedValue(undefined);
    const injector = Injector.create({
      providers: [
        { provide: TombstoneService, useClass: TombstoneService },
        {
          provide: LoggerService,
          useValue: {
            category: () => ({
              debug: vi.fn(),
              info: vi.fn(),
              warn: vi.fn(),
              error: vi.fn(),
            }),
          },
        },
        {
          provide: RequestThrottleService,
          useValue: {
            execute: vi.fn(async (_key: string, operation: () => Promise<unknown>) => operation()),
          },
        },
        { provide: AttachmentCleanupOutboxService, useValue: { enqueuePaths, removePaths } },
      ],
    });
    const service = injector.get(TombstoneService);

    await service.deleteAttachmentFilesFromStorage(null, [
      'user1/proj1/task1/attachment-a.png',
    ]);

    expect(enqueuePaths).toHaveBeenCalledWith([
      'user1/proj1/task1/attachment-a.png',
    ]);
    expect(removePaths).not.toHaveBeenCalled();
  });

  it('deleteAttachmentFilesFromStorage 远端失败时保留 cleanup outbox 待恢复', async () => {
    const enqueuePaths = vi.fn().mockResolvedValue([]);
    const removePaths = vi.fn().mockResolvedValue(undefined);
    const remove = vi.fn().mockResolvedValue({
      data: null,
      error: { message: 'storage timeout' },
    });
    const client = {
      storage: {
        from: vi.fn(() => ({ remove })),
      },
    };
    const injector = Injector.create({
      providers: [
        { provide: TombstoneService, useClass: TombstoneService },
        {
          provide: LoggerService,
          useValue: {
            category: () => ({
              debug: vi.fn(),
              info: vi.fn(),
              warn: vi.fn(),
              error: vi.fn(),
            }),
          },
        },
        {
          provide: RequestThrottleService,
          useValue: {
            execute: vi.fn(async (_key: string, operation: () => Promise<unknown>) => operation()),
          },
        },
        { provide: AttachmentCleanupOutboxService, useValue: { enqueuePaths, removePaths } },
      ],
    });
    const service = injector.get(TombstoneService);

    await service.deleteAttachmentFilesFromStorage(client as never, [
      'user1/proj1/task1/attachment-a.png',
    ]);

    expect(enqueuePaths).toHaveBeenCalledWith([
      'user1/proj1/task1/attachment-a.png',
    ]);
    expect(remove).toHaveBeenCalledWith([
      'user1/proj1/task1/attachment-a.png',
    ]);
    expect(removePaths).not.toHaveBeenCalled();
  });
});
