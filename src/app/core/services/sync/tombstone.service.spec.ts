import { Injector } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoggerService } from '../../../../services/logger.service';
import { RequestThrottleService } from '../../../../services/request-throttle.service';
import { AttachmentCleanupOutboxService } from '../../../../services/attachment-cleanup-outbox.service';
import { SessionRuntimeResetRegistry } from '../../../../services/session-runtime-reset.service';
import { resetBrowserNetworkSuspensionTrackingForTests } from '../../../../utils/browser-network-suspension';
import { TombstoneService } from './tombstone.service';

function createPagedTombstoneQuery(
  rows: Array<{ task_id: string; deleted_at: string | null }>,
  limits: number[],
) {
  let offset = 0;
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    or: vi.fn(),
    order: vi.fn(),
    limit: vi.fn(async (count: number) => {
      limits.push(count);
      const from = offset;
      offset += count;
      return { data: rows.slice(from, from + count), error: null };
    }),
  };

  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.or.mockReturnValue(query);
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
      task_id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      deleted_at: new Date(Date.UTC(2026, 5, 9, 0, 0, index)).toISOString(),
    }));
    const limits: number[] = [];
    const query = createPagedTombstoneQuery(rows, limits);
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
            removePendingCleanups: vi.fn().mockResolvedValue(undefined),
          },
        },
        SessionRuntimeResetRegistry,
      ],
    });

    const service = injector.get(TombstoneService);
    const result = await service.getTombstonesWithCache('project-1', client as never);

    expect(result.error).toBeNull();
    expect(result.data).toHaveLength(1001);
    expect(result.data?.[1000]?.task_id).toBe('00000000-0000-4000-8000-000000001000');
    expect(limits).toEqual([1000, 1000]);
    expect(query.order).toHaveBeenCalledWith('deleted_at', { ascending: true });
    expect(query.order).toHaveBeenCalledWith('task_id', { ascending: true });
  });

  it('deleteAttachmentFilesFromStorage client 缺失时仍先持久化附件清理 outbox', async () => {
    const enqueuePaths = vi.fn().mockResolvedValue([]);
    const removePendingCleanups = vi.fn().mockResolvedValue(undefined);
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
        { provide: AttachmentCleanupOutboxService, useValue: { enqueuePaths, removePendingCleanups } },
        SessionRuntimeResetRegistry,
      ],
    });
    const service = injector.get(TombstoneService);

    await service.deleteAttachmentFilesFromStorage(null, [
      'user1/proj1/task1/attachment-a.png',
    ]);

    expect(enqueuePaths).toHaveBeenCalledWith(
      ['user1/proj1/task1/attachment-a.png'],
      { ownerUserId: 'user1' },
    );
    expect(removePendingCleanups).not.toHaveBeenCalled();
  });

  it('deleteAttachmentFilesFromStorage 远端失败时保留 cleanup outbox 待恢复', async () => {
    const enqueuePaths = vi.fn().mockResolvedValue([]);
    const removePendingCleanups = vi.fn().mockResolvedValue(undefined);
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
        { provide: AttachmentCleanupOutboxService, useValue: { enqueuePaths, removePendingCleanups } },
        SessionRuntimeResetRegistry,
      ],
    });
    const service = injector.get(TombstoneService);

    await service.deleteAttachmentFilesFromStorage(client as never, [
      'user1/proj1/task1/attachment-a.png',
    ]);

    expect(enqueuePaths).toHaveBeenCalledWith(
      ['user1/proj1/task1/attachment-a.png'],
      { ownerUserId: 'user1' },
    );
    expect(remove).toHaveBeenCalledWith([
      'user1/proj1/task1/attachment-a.png',
    ]);
    expect(removePendingCleanups).not.toHaveBeenCalled();
  });
});
