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
import { PermanentFailureError } from '../../../../utils/permanent-failure-error';

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

  const mockSessionManager = {
    tryRefreshSession: vi.fn(async () => false),
    handleSessionExpired: vi.fn(),
    isSessionExpiredError: vi.fn(() => false),
    handleAuthErrorWithRefresh: vi.fn(async () => false),
    isRlsPolicyViolation: vi.fn(() => false),
  };

  const mockTombstoneService = {
    getLocalTombstones: vi.fn(() => new Set<string>()),
  };

  let connectionTombstoneResult: { data: { connection_id: string } | null; error: unknown | null };
  let taskExistenceResult: { data: Array<{ id: string }>; error: unknown | null };
  let endpointDedupResult: { data: { id: string } | null; error: unknown | null };
  let connectionUpsertResult: { error: unknown | null };
  const mockConnectionsUpsert = vi.fn();

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
    from: vi.fn((table: string) => {
      if (table === 'connection_tombstones') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: vi.fn(async () => connectionTombstoneResult),
            })),
          })),
        };
      }

      if (table === 'tasks') {
        return {
          select: vi.fn(() => ({
            in: vi.fn(() => ({
              eq: vi.fn(() => ({
                is: vi.fn(async () => taskExistenceResult),
              })),
            })),
          })),
        };
      }

      if (table === 'connections') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                eq: vi.fn(() => ({
                  maybeSingle: vi.fn(async () => endpointDedupResult),
                })),
              })),
            })),
          })),
          upsert: mockConnectionsUpsert,
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    }),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    connectionTombstoneResult = { data: null, error: null };
    taskExistenceResult = {
      data: [{ id: 'task-a' }, { id: 'task-b' }],
      error: null,
    };
    endpointDedupResult = { data: null, error: null };
    connectionUpsertResult = { error: null };
    mockConnectionsUpsert.mockImplementation(async () => connectionUpsertResult);

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
          useValue: mockSessionManager,
        },
        { provide: RetryQueueService, useValue: mockRetryQueue },
        { provide: SyncStateService, useValue: mockSyncState },
        { provide: TombstoneService, useValue: mockTombstoneService },
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

  it('引用已本地删除任务的连接不应继续入队', async () => {
    const connection: Connection = {
      id: 'connection-stale-after-task-delete',
      source: 'task-a',
      target: 'task-b',
    };
    taskExistenceResult = {
      data: [{ id: 'task-b' }],
      error: null,
    };
    mockTombstoneService.getLocalTombstones.mockReturnValueOnce(new Set(['task-a']));

    const result = await service.pushConnection(connection, 'project-1');

    expect(result).toBe(false);
    expect(mockRetryQueue.add).not.toHaveBeenCalled();
    expect(mockConnectionsUpsert).not.toHaveBeenCalled();
  });

  it('重试队列回放命中远端 connection tombstone 时应抛永久失败', async () => {
    const connection: Connection = {
      id: 'connection-remote-tombstoned',
      source: 'task-a',
      target: 'task-b',
    };
    connectionTombstoneResult = {
      data: { connection_id: connection.id },
      error: null,
    };

    await expect(service.pushConnection(connection, 'project-1', false, false, true, 'user-1'))
      .rejects.toBeInstanceOf(PermanentFailureError);
    expect(mockConnectionsUpsert).not.toHaveBeenCalled();
  });

  it('connection tombstone 查询失败时应 fail closed 并进入重试', async () => {
    const connection: Connection = {
      id: 'connection-tombstone-query-error',
      source: 'task-a',
      target: 'task-b',
    };
    connectionTombstoneResult = {
      data: null,
      error: { code: '503', message: 'Service unavailable' },
    };

    const result = await service.pushConnection(connection, 'project-1', false, false, false, 'user-1');

    expect(result).toBe(false);
    expect(mockRetryQueue.add).toHaveBeenCalledWith('connection', 'upsert', connection, 'project-1', 'user-1');
    expect(mockConnectionsUpsert).not.toHaveBeenCalled();
  });

  it('刷新后任务存在性查询仍为 RLS 违规时应抛永久失败供重试队列收口', async () => {
    const connection: Connection = {
      id: 'connection-permission-denied-after-refresh',
      source: 'task-a',
      target: 'task-b',
    };
    taskExistenceResult = {
      data: [],
      error: { code: '42501', message: 'RLS Policy Violation' },
    };
    mockSessionManager.isSessionExpiredError.mockImplementation((error: { code?: string | number }) => error.code === '42501');
    mockSessionManager.handleAuthErrorWithRefresh.mockResolvedValueOnce(true);
    mockSessionManager.isRlsPolicyViolation.mockImplementation((error: { code?: string | number }) => error.code === '42501');

    await expect(service.pushConnection(connection, 'project-1', false, false, true, 'user-1'))
      .rejects.toBeInstanceOf(PermanentFailureError);
    expect(mockRetryQueue.add).not.toHaveBeenCalled();
    expect(mockConnectionsUpsert).not.toHaveBeenCalled();
  });
});