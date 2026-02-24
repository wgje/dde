/**
 * TaskSyncOperationsService 单元测试
 */

import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TaskSyncOperationsService } from './task-sync-operations.service';
import { SupabaseClientService } from '../../../../services/supabase-client.service';
import { LoggerService } from '../../../../services/logger.service';
import { ToastService } from '../../../../services/toast.service';
import { RequestThrottleService } from '../../../../services/request-throttle.service';
import { ClockSyncService } from '../../../../services/clock-sync.service';
import { SyncOperationHelperService } from './sync-operation-helper.service';
import { SessionManagerService } from './session-manager.service';
import { TombstoneService } from './tombstone.service';
import { ProjectDataService } from './project-data.service';
import { RetryQueueService } from './retry-queue.service';
import { SyncStateService } from './sync-state.service';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import { Task } from '../../../../models';

describe('TaskSyncOperationsService', () => {
  let service: TaskSyncOperationsService;
  let upsertPayload: Record<string, unknown> | null;

  const mockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const mockClient = {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: { user: { id: 'user-1' } } } })),
    },
    from: vi.fn((table: string) => {
      if (table === 'task_tombstones') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: vi.fn(async () => ({ data: null, error: null })),
            })),
          })),
        };
      }

      if (table === 'tasks') {
        return {
          upsert: vi.fn((payload: Record<string, unknown>) => {
            upsertPayload = payload;
            return {
              select: vi.fn(() => ({
                single: vi.fn(async () => ({
                  data: { updated_at: new Date().toISOString() },
                  error: null,
                })),
              })),
            };
          }),
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    }),
  };

  beforeEach(() => {
    upsertPayload = null;
    vi.clearAllMocks();

    TestBed.configureTestingModule({
      providers: [
        TaskSyncOperationsService,
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
        { provide: ClockSyncService, useValue: { recordServerTimestamp: vi.fn() } },
        {
          provide: SyncOperationHelperService,
          useValue: {
            retryWithBackoff: vi.fn(async (fn: () => Promise<void>) => await fn()),
          },
        },
        {
          provide: SessionManagerService,
          useValue: {
            tryRefreshSession: vi.fn(async () => false),
            handleSessionExpired: vi.fn(),
            isSessionExpiredError: vi.fn(() => false),
            handleAuthErrorWithRefresh: vi.fn(async () => false),
          },
        },
        { provide: TombstoneService, useValue: {} },
        { provide: ProjectDataService, useValue: {} },
        {
          provide: RetryQueueService,
          useValue: {
            checkCircuitBreaker: vi.fn(() => true),
            add: vi.fn(() => true),
            length: 0,
            recordCircuitSuccess: vi.fn(),
            recordCircuitFailure: vi.fn(),
          },
        },
        {
          provide: SyncStateService,
          useValue: {
            isSessionExpired: vi.fn(() => false),
            setPendingCount: vi.fn(),
            setSyncError: vi.fn(),
            setLastSyncTime: vi.fn(),
          },
        },
        {
          provide: SentryLazyLoaderService,
          useValue: {
            captureException: vi.fn(),
            captureMessage: vi.fn(),
          },
        },
      ],
    });

    service = TestBed.inject(TaskSyncOperationsService);
  });

  it('pushTask 应将 parking_meta 上行到 Supabase', async () => {
    const parkingMeta = {
      state: 'parked' as const,
      parkedAt: new Date().toISOString(),
      lastVisitedAt: new Date().toISOString(),
      contextSnapshot: null,
      reminder: null,
      pinned: false,
    };

    const task: Task = {
      id: 'task-1',
      title: '任务',
      content: '内容',
      stage: 0,
      parentId: null,
      order: 0,
      rank: 10000,
      status: 'active',
      x: 0,
      y: 0,
      displayId: 'T-1',
      createdDate: new Date().toISOString(),
      deletedAt: null,
      parkingMeta,
    };

    const result = await service.pushTask(task, 'project-1');

    expect(result).toBe(true);
    expect(upsertPayload).toBeTruthy();
    expect(upsertPayload?.['parking_meta']).toEqual(parkingMeta);
  });
});
