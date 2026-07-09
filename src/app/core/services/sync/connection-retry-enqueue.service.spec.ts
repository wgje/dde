import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Connection } from '../../../../models';
import { LoggerService } from '../../../../services/logger.service';
import { ConnectionRetryEnqueueService } from './connection-retry-enqueue.service';
import { RetryQueueService, type RetryQueueLastFailure } from './retry-queue.service';
import { SyncStateService } from './sync-state.service';

describe('ConnectionRetryEnqueueService', () => {
  const connection: Connection = {
    id: 'connection-1',
    source: 'source-task',
    target: 'target-task',
  };
  const logger = {
    warn: vi.fn(),
  };
  const retryQueue = {
    addDurably: vi.fn(async () => true),
    length: 3,
  };
  const syncState = {
    isSessionExpired: vi.fn(() => false),
    setPendingCount: vi.fn(),
    setSyncError: vi.fn(),
  };

  let service: ConnectionRetryEnqueueService;

  beforeEach(() => {
    vi.clearAllMocks();
    retryQueue.addDurably.mockResolvedValue(true);
    retryQueue.length = 3;
    syncState.isSessionExpired.mockReturnValue(false);

    TestBed.configureTestingModule({
      providers: [
        ConnectionRetryEnqueueService,
        {
          provide: LoggerService,
          useValue: {
            category: vi.fn(() => logger),
          },
        },
        { provide: RetryQueueService, useValue: retryQueue },
        { provide: SyncStateService, useValue: syncState },
      ],
    });

    service = TestBed.inject(ConnectionRetryEnqueueService);
  });

  it('adds connection upserts durably and refreshes pending count', async () => {
    const lastFailure: RetryQueueLastFailure = {
      errorType: 'TimeoutError',
      message: 'timed out',
      remoteOutcome: 'unknown',
      recordedAt: 123,
    };

    const enqueued = await service.enqueueConnectionUpsert(
      connection,
      'project-1',
      'user-1',
      false,
      'operation-1',
      lastFailure,
    );

    expect(enqueued).toBe(true);
    expect(retryQueue.addDurably).toHaveBeenCalledWith(
      'connection',
      'upsert',
      connection,
      'project-1',
      'user-1',
      undefined,
      undefined,
      undefined,
      'operation-1',
      lastFailure,
    );
    expect(syncState.setPendingCount).toHaveBeenCalledWith(3);
    expect(syncState.setSyncError).not.toHaveBeenCalled();
  });

  it('skips enqueue while the session is expired unless explicitly allowed', async () => {
    syncState.isSessionExpired.mockReturnValue(true);

    const enqueued = await service.enqueueConnectionUpsert(connection, 'project-1');

    expect(enqueued).toBe(false);
    expect(retryQueue.addDurably).not.toHaveBeenCalled();
  });

  it('sets a sync error when the durable queue rejects the item', async () => {
    retryQueue.addDurably.mockResolvedValue(false);

    const enqueued = await service.enqueueConnectionUpsert(connection, 'project-1');

    expect(enqueued).toBe(false);
    expect(syncState.setSyncError).toHaveBeenCalledWith('同步队列已满，暂未写入重试队列');
    expect(syncState.setPendingCount).not.toHaveBeenCalled();
  });

  it('rejects invalid connection enqueue requests before durable storage', async () => {
    const enqueued = await service.enqueueConnectionUpsert(
      { ...connection, id: '' },
      'project-1',
    );

    expect(enqueued).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      'enqueueConnectionUpsert: 跳过无效连接（缺少 id）',
      { operation: 'upsert' },
    );
    expect(retryQueue.addDurably).not.toHaveBeenCalled();
  });
});
