import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ConnectionSyncOperationsService } from './connection-sync-operations.service';
import { SupabaseClientService } from '../../../../services/supabase-client.service';
import { LoggerService } from '../../../../services/logger.service';
import { ToastService } from '../../../../services/toast.service';
import { RequestThrottleService } from '../../../../services/request-throttle.service';
import { SyncOperationHelperService } from './sync-operation-helper.service';
import { SessionManagerService } from './session-manager.service';
import { RetryQueueService } from './retry-queue.service';
import { SyncStateService } from './sync-state.service';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import { TombstoneService } from './tombstone.service';
import type { Connection } from '../../../../models';

describe('ConnectionSyncOperationsService', () => {
  let service: ConnectionSyncOperationsService;

  const mockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const mockRetryQueue = {
    checkCircuitBreaker: vi.fn(() => true),
    add: vi.fn(() => true),
    length: 0,
  };

  const mockSyncState = {
    isSessionExpired: vi.fn(() => false),
    setPendingCount: vi.fn(),
    setSyncError: vi.fn(),
    setSessionExpired: vi.fn(),
  };

  const mockClient = {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: { user: { id: 'user-1' } } } })),
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();

    TestBed.configureTestingModule({
      providers: [
        ConnectionSyncOperationsService,
        {
          provide: SupabaseClientService,
          useValue: {
            isConfigured: true,
            client: vi.fn(() => mockClient),
          },
        },
        {
          provide: LoggerService,
          useValue: {
            category: vi.fn(() => mockLogger),
          },
        },
        { provide: ToastService, useValue: { warning: vi.fn() } },
        {
          provide: RequestThrottleService,
          useValue: {
            execute: vi.fn(async (_key: string, fn: () => Promise<void>) => await fn()),
          },
        },
        { provide: SyncOperationHelperService, useValue: { retryWithBackoff: vi.fn(async (fn: () => Promise<void>) => await fn()) } },
        {
          provide: SessionManagerService,
          useValue: {
            tryRefreshSession: vi.fn(async () => false),
            handleSessionExpired: vi.fn(),
            isSessionExpiredError: vi.fn(() => false),
            handleAuthErrorWithRefresh: vi.fn(async () => false),
          },
        },
        { provide: RetryQueueService, useValue: mockRetryQueue },
        { provide: SyncStateService, useValue: mockSyncState },
        { provide: TombstoneService, useValue: {} },
        {
          provide: SentryLazyLoaderService,
          useValue: {
            captureException: vi.fn(),
            captureMessage: vi.fn(),
          },
        },
      ],
    });

    service = TestBed.inject(ConnectionSyncOperationsService);
  });

  it('sourceUserId 与当前会话不匹配时应拒绝写云端并按原 owner 入队', async () => {
    const connection: Connection = {
      id: 'connection-owner-mismatch',
      source: 'task-a',
      target: 'task-b',
    };
    mockClient.auth.getSession.mockResolvedValueOnce({
      data: { session: { user: { id: 'user-2' } } },
    });

    const result = await service.pushConnection(connection, 'project-1', false, false, false, 'user-1');

    expect(result).toBe(false);
    expect(mockRetryQueue.add).toHaveBeenCalledWith('connection', 'upsert', connection, 'project-1', 'user-1');
  });
});