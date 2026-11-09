import { TestBed } from '@angular/core/testing';
import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LoggerService } from '../../../../services/logger.service';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import { SupabaseClientService } from '../../../../services/supabase-client.service';
import { ToastService } from '../../../../services/toast.service';
import { RetryQueueService } from './retry-queue.service';
import { SessionManagerService } from './session-manager.service';
import { SyncOperationHelperService } from './sync-operation-helper.service';
import { SyncStateService } from './sync-state.service';

describe('SyncOperationHelperService', () => {
  let service: SyncOperationHelperService;
  let mockClient: SupabaseClient;
  let supabaseClientService: {
    isConfigured: boolean;
    client: ReturnType<typeof vi.fn>;
  };
  let logger: {
    debug: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  let retryQueue: {
    add: ReturnType<typeof vi.fn>;
    addDurably: ReturnType<typeof vi.fn>;
    checkCircuitBreaker: ReturnType<typeof vi.fn>;
  };
  let syncState: {
    isSessionExpired: ReturnType<typeof vi.fn>;
    setSessionExpired: ReturnType<typeof vi.fn>;
  };
  let sessionManager: {
    isSessionExpiredError: ReturnType<typeof vi.fn>;
    handleAuthErrorWithRefresh: ReturnType<typeof vi.fn>;
    tryRefreshSession: ReturnType<typeof vi.fn>;
    isRlsPolicyViolation: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    retryQueue = {
      add: vi.fn(() => true),
      addDurably: vi.fn(async () => true),
      checkCircuitBreaker: vi.fn(() => true),
    };
    syncState = {
      isSessionExpired: vi.fn(() => false),
      setSessionExpired: vi.fn(),
    };
    sessionManager = {
      isSessionExpiredError: vi.fn(() => false),
      handleAuthErrorWithRefresh: vi.fn(async () => false),
      tryRefreshSession: vi.fn(async () => false),
      isRlsPolicyViolation: vi.fn(() => false),
    };
    mockClient = {
      auth: {
        getSession: vi.fn(async () => ({
          data: { session: { user: { id: 'user-1' } } },
        })),
      },
    } as unknown as SupabaseClient;
    supabaseClientService = {
      isConfigured: true,
      client: vi.fn(() => mockClient),
    };

    TestBed.configureTestingModule({
      providers: [
        SyncOperationHelperService,
        { provide: SupabaseClientService, useValue: supabaseClientService },
        { provide: LoggerService, useValue: { category: vi.fn(() => logger) } },
        { provide: ToastService, useValue: { warning: vi.fn() } },
        { provide: SyncStateService, useValue: syncState },
        { provide: SessionManagerService, useValue: sessionManager },
        { provide: RetryQueueService, useValue: retryQueue },
        {
          provide: SentryLazyLoaderService,
          useValue: {
            captureException: vi.fn(),
            captureMessage: vi.fn(),
          },
        },
      ],
    });

    service = TestBed.inject(SyncOperationHelperService);
  });

  it('客户端不可用时应先持久化重试项，再返回跳过结果', async () => {
    supabaseClientService.isConfigured = false;
    const retryData = { id: 'task-no-client' };

    const result = await service.execute(
      vi.fn(async () => undefined),
      { operationName: 'pushTask', entityId: retryData.id, projectId: 'project-1' },
      {
        retryEntityType: 'task',
        retryOperation: 'upsert',
        retryData,
      },
    );

    expect(result).toEqual(expect.objectContaining({ success: false, skipped: true }));
    expect(retryQueue.addDurably).toHaveBeenCalledWith('task', 'upsert', retryData, 'project-1');
    expect(retryQueue.add).not.toHaveBeenCalled();
  });

  it('可重试错误应在持久化确认后记录已加入重试队列', async () => {
    const retryData = { id: 'task-network-error' };
    const operation = vi.fn(async () => {
      throw new Error('failed to fetch');
    });

    const result = await service.execute(
      operation,
      { operationName: 'pushTask', entityId: retryData.id, projectId: 'project-1' },
      {
        retryEntityType: 'task',
        retryOperation: 'upsert',
        retryData,
      },
    );

    expect(result.success).toBe(false);
    expect(retryQueue.addDurably).toHaveBeenCalledWith('task', 'upsert', retryData, 'project-1');
    expect(retryQueue.add).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith('pushTask: 已持久加入重试队列', { entityId: retryData.id });
  });

  it('持久化确认失败时不得记录重试项已保留', async () => {
    retryQueue.addDurably.mockResolvedValueOnce(false);
    const retryData = { id: 'task-persist-failed' };
    const operation = vi.fn(async () => {
      throw new Error('failed to fetch');
    });

    const result = await service.execute(
      operation,
      { operationName: 'pushTask', entityId: retryData.id, projectId: 'project-1' },
      {
        retryEntityType: 'task',
        retryOperation: 'upsert',
        retryData,
      },
    );

    expect(result.success).toBe(false);
    expect(logger.debug).not.toHaveBeenCalledWith('pushTask: 已持久加入重试队列', { entityId: retryData.id });
    expect(logger.warn).toHaveBeenCalledWith('pushTask: 重试队列未能持久化，操作未确认保留', {
      entityId: retryData.id,
    });
  });
});
