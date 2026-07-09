import { Injector } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AttachmentCleanupOutboxService,
  type AttachmentCleanupStorageClient,
} from './attachment-cleanup-outbox.service';

describe('AttachmentCleanupOutboxService', () => {
  let service: AttachmentCleanupOutboxService;

  beforeEach(() => {
    service = Injector.create({
      providers: [
        { provide: AttachmentCleanupOutboxService, useClass: AttachmentCleanupOutboxService },
      ],
    }).get(AttachmentCleanupOutboxService);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await service.clearPendingCleanupsForTests();
  });

  it('persists unique cleanup paths and restores them across service instances', async () => {
    vi.spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000201')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000202');

    await service.enqueuePaths([
      'user-1/project-1/task-1/attachment-a.png',
      'user-1/project-1/task-1/attachment-a.png',
      'user-1/project-1/task-1/attachment-b.png',
      '',
      '   ',
    ], { createdAt: '2026-06-29T00:00:00.000Z' });

    const restoredService = Injector.create({
      providers: [
        { provide: AttachmentCleanupOutboxService, useClass: AttachmentCleanupOutboxService },
      ],
    }).get(AttachmentCleanupOutboxService);

    const pending = await restoredService.listPendingCleanups();

    expect(pending).toEqual([
      expect.objectContaining({
        path: 'user-1/project-1/task-1/attachment-a.png',
        operationId: '00000000-0000-4000-8000-000000000201',
        attemptCount: 0,
        createdAt: '2026-06-29T00:00:00.000Z',
      }),
      expect.objectContaining({
        path: 'user-1/project-1/task-1/attachment-b.png',
        operationId: '00000000-0000-4000-8000-000000000202',
        attemptCount: 0,
        createdAt: '2026-06-29T00:00:00.000Z',
      }),
    ]);
  });

  it('flushes pending cleanups in batches and deletes records only after remote success', async () => {
    await service.enqueuePaths([
      'user-1/project-1/task-1/attachment-a.png',
      'user-1/project-1/task-1/attachment-b.png',
    ]);
    const remove = vi.fn().mockResolvedValue({ data: [], error: null });
    const from = vi.fn(() => ({ remove }));
    const client = { storage: { from } } as unknown as AttachmentCleanupStorageClient;

    const result = await service.flushPendingCleanups(client, { batchSize: 1 });

    expect(result).toEqual({
      ok: true,
      deletedCount: 2,
      remainingCount: 0,
      errors: [],
    });
    expect(from).toHaveBeenCalledWith('attachments');
    expect(remove).toHaveBeenNthCalledWith(1, ['user-1/project-1/task-1/attachment-a.png']);
    expect(remove).toHaveBeenNthCalledWith(2, ['user-1/project-1/task-1/attachment-b.png']);
    expect(await service.listPendingCleanups()).toEqual([]);
  });

  it('并发 flush 应合流为单飞，不得对同一批路径重复发送 storage remove', async () => {
    // flappy 网络下两次 restore 扇出可能重叠：读-发-删无锁并发会重复删除请求
    await service.enqueuePaths(['user-1/project-1/task-1/attachment-single-flight.png']);
    let resolveRemove!: (value: { data: unknown[]; error: null }) => void;
    const remove = vi.fn(() => new Promise<{ data: unknown[]; error: null }>(resolve => {
      resolveRemove = resolve;
    }));
    const client = { storage: { from: vi.fn(() => ({ remove })) } } as unknown as AttachmentCleanupStorageClient;

    const first = service.flushPendingCleanups(client);
    const second = service.flushPendingCleanups(client);
    await vi.waitFor(() => expect(remove).toHaveBeenCalled());
    resolveRemove({ data: [], error: null });
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(remove).toHaveBeenCalledTimes(1);
    expect(firstResult).toEqual(secondResult);
    expect(await service.listPendingCleanups()).toEqual([]);
  });

  it('keeps pending cleanup records and records attempts when remote delete fails', async () => {
    await service.enqueuePaths(['user-1/project-1/task-1/attachment-a.png']);
    const remove = vi.fn().mockResolvedValue({
      data: null,
      error: { message: 'storage timeout' },
    });
    const client = { storage: { from: vi.fn(() => ({ remove })) } } as unknown as AttachmentCleanupStorageClient;

    const result = await service.flushPendingCleanups(client);

    expect(result).toEqual({
      ok: false,
      deletedCount: 0,
      remainingCount: 1,
      errors: ['storage timeout'],
    });
    expect(await service.listPendingCleanups()).toEqual([
      expect.objectContaining({
        path: 'user-1/project-1/task-1/attachment-a.png',
        attemptCount: 1,
        lastError: 'storage timeout',
      }),
    ]);
  });
});
