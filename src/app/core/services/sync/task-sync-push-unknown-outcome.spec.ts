/**
 * TaskSyncPushService.reconcileTaskPushUnknownOutcome 判定规则（目标3 离线弱网同步收口）
 *
 * 业务意图（§5.2 / §5.6）：timeout/abort 后服务端结果未知的 task upsert，重放前按 id
 * 拉取服务端完整 payload 进行对账，不能把 updated_at 当作 payload 身份证明：
 * - payload 一致 → settled；
 * - 不一致但具备 RPC 幂等边界或 REST CAS 基线 → replay；
 * - 查询失败 / 客户端不可用 / 既有远端行缺少本地 CAS 基线 → unknown。
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
import { SyncRpcClientService } from '../../../../services/sync-rpc-client.service';
import { TaskStore } from '../../state/stores';
import type { Task } from '../../../../models';

interface FreshnessRow extends Record<string, unknown> {
  id: string;
  updated_at: string | null;
  deleted_at: string | null;
}

describe('TaskSyncPushService unknown-outcome 对账判定', () => {
  let service: TaskSyncOperationsService;
  let freshnessResult: { data: FreshnessRow | null; error: unknown | null };
  let clientAvailable: boolean;
  let clockReliable: boolean;
  let syncRpcFeatureEnabled: boolean;

  const ensureSyncedMock = vi.fn(async () => ({ reliable: clockReliable }));
  const compareTimestampsMock = vi.fn(
    (left: string, right: string) => new Date(left).getTime() - new Date(right).getTime(),
  );

  const mockClient = {
    from: vi.fn((table: string) => {
      if (table !== 'tasks') {
        throw new Error(`Unexpected table: ${table}`);
      }
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: vi.fn(async () => freshnessResult),
            })),
          })),
        })),
      };
    }),
  };

  function createLocalTask(updatedAt?: string): Task {
    return {
      id: 'aaaaaaaa-0000-4000-8000-000000000001',
      title: 'unknown outcome task',
      content: '弱网收口测试内容',
      stage: null,
      parentId: null,
      order: 0,
      rank: 0,
      status: 'active',
      x: 0,
      y: 0,
      createdDate: '2026-07-01T00:00:00.000Z',
      displayId: 'T-1',
      ...(updatedAt === undefined ? {} : { updatedAt }),
    } as Task;
  }

  function createMatchingRemoteRow(task: Task, updatedAt: string): FreshnessRow {
    return {
      id: task.id,
      project_id: 'project-1',
      title: task.title,
      content: task.content,
      stage: task.stage,
      parent_id: task.parentId,
      order: task.order,
      rank: task.rank,
      status: task.status,
      x: task.x,
      y: task.y,
      short_id: task.shortId,
      priority: task.priority ?? null,
      due_date: task.dueDate ?? null,
      expected_minutes: task.expected_minutes ?? null,
      cognitive_load: task.cognitive_load ?? null,
      wait_minutes: task.wait_minutes ?? null,
      tags: task.tags ?? [],
      completed_at: task.completedAt ?? null,
      deleted_at: task.deletedAt ?? null,
      attachments: task.attachments ?? [],
      parking_meta: task.parkingMeta ?? null,
      attention_meta: task.attentionMeta ?? null,
      updated_at: updatedAt,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    freshnessResult = { data: null, error: null };
    clientAvailable = true;
    clockReliable = true;
    syncRpcFeatureEnabled = true;

    TestBed.configureTestingModule({
      providers: [
        TaskSyncOperationsService,
        {
          provide: SupabaseClientService,
          useValue: {
            isConfigured: true,
            getStorageKey: vi.fn(() => 'sb-unknown-outcome-test-auth-token'),
            client: vi.fn(() => {
              if (!clientAvailable) {
                throw new Error('supabase client unavailable');
              }
              return mockClient;
            }),
          },
        },
        {
          provide: LoggerService,
          useValue: {
            category: vi.fn(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
          },
        },
        { provide: ToastService, useValue: { warning: vi.fn() } },
        {
          provide: RequestThrottleService,
          useValue: { execute: vi.fn(async (_key: string, fn: () => Promise<void>) => await fn()) },
        },
        {
          provide: ClockSyncService,
          useValue: {
            ensureSynced: ensureSyncedMock,
            compareTimestamps: compareTimestampsMock,
            recordServerTimestamp: vi.fn(),
          },
        },
        { provide: TaskStore, useValue: { getTask: vi.fn(), setTask: vi.fn() } },
        {
          provide: SyncOperationHelperService,
          useValue: { retryWithBackoff: vi.fn(async (fn: () => Promise<void>) => await fn()) },
        },
        {
          provide: SessionManagerService,
          useValue: { isSessionExpiredError: vi.fn(() => false) },
        },
        { provide: TombstoneService, useValue: {} },
        { provide: ProjectDataService, useValue: {} },
        {
          provide: RetryQueueService,
          useValue: { checkCircuitBreaker: vi.fn(() => true), addDurably: vi.fn(async () => true), length: 0 },
        },
        {
          provide: SyncRpcClientService,
          useValue: {
            isFeatureEnabled: vi.fn(() => syncRpcFeatureEnabled),
            isClientRejected: vi.fn(() => false),
            checkProtocol: vi.fn(async () => undefined),
          },
        },
        {
          provide: SyncStateService,
          useValue: {
            isSessionExpired: vi.fn(() => false),
            setSyncError: vi.fn(),
            setPendingCount: vi.fn(),
            syncState: vi.fn(() => ({ lastSyncTime: null })),
          },
        },
        { provide: SentryLazyLoaderService, useValue: { captureException: vi.fn(), captureMessage: vi.fn() } },
      ],
    });

    service = TestBed.inject(TaskSyncOperationsService);
  });

  it('服务端 updated_at 晚于本地写入时间时仍应重放，由幂等/CAS 边界裁决', async () => {
    const task = createLocalTask('2026-07-09T08:00:00.000Z');
    freshnessResult = {
      data: { id: task.id, updated_at: '2026-07-09T08:00:05.000Z', deleted_at: null },
      error: null,
    };

    await expect(service.reconcileTaskPushUnknownOutcome(task, 'project-1')).resolves.toBe('replay');
    expect(ensureSyncedMock).not.toHaveBeenCalled();
  });

  it('服务端 updated_at 与本地写入时间相同也不能替代 payload digest 证明', async () => {
    const task = createLocalTask('2026-07-09T08:00:00.000Z');
    freshnessResult = {
      data: { id: task.id, updated_at: '2026-07-09T08:00:00.000Z', deleted_at: null },
      error: null,
    };

    await expect(service.reconcileTaskPushUnknownOutcome(task, 'project-1')).resolves.toBe('replay');
    expect(ensureSyncedMock).not.toHaveBeenCalled();
  });

  it('服务端 updated_at 早于本地写入时间时应正常重放（replay）', async () => {
    const task = createLocalTask('2026-07-09T08:00:10.000Z');
    freshnessResult = {
      data: { id: task.id, updated_at: '2026-07-09T08:00:00.000Z', deleted_at: null },
      error: null,
    };

    await expect(service.reconcileTaskPushUnknownOutcome(task, 'project-1')).resolves.toBe('replay');
  });

  it('服务端不存在该行时应正常重放（replay）', async () => {
    const task = createLocalTask('2026-07-09T08:00:00.000Z');
    freshnessResult = { data: null, error: null };

    await expect(service.reconcileTaskPushUnknownOutcome(task, 'project-1')).resolves.toBe('replay');
  });

  it('对账查询失败时应保持结果未知（unknown），不得判定为可重放', async () => {
    const task = createLocalTask('2026-07-09T08:00:00.000Z');
    freshnessResult = { data: null, error: { code: '503', message: 'service unavailable' } };

    await expect(service.reconcileTaskPushUnknownOutcome(task, 'project-1')).resolves.toBe('unknown');
  });

  it('不使用时钟先后关系冒充本次 payload 的身份凭据', async () => {
    clockReliable = false;
    const task = createLocalTask('2026-07-09T08:00:00.000Z');
    freshnessResult = {
      data: { id: task.id, updated_at: '2026-07-09T08:00:05.000Z', deleted_at: null },
      error: null,
    };

    await expect(service.reconcileTaskPushUnknownOutcome(task, 'project-1')).resolves.toBe('replay');
    expect(ensureSyncedMock).not.toHaveBeenCalled();
  });

  it('Supabase 客户端不可用时应保持结果未知（unknown）', async () => {
    clientAvailable = false;
    const task = createLocalTask('2026-07-09T08:00:00.000Z');

    await expect(service.reconcileTaskPushUnknownOutcome(task, 'project-1')).resolves.toBe('unknown');
  });

  it('sync RPC 不可用时远端完整 payload 一致应结算为 settled', async () => {
    syncRpcFeatureEnabled = false;
    const task = createLocalTask('2026-07-09T08:00:00.000Z');
    freshnessResult = {
      data: createMatchingRemoteRow(task, '2026-07-09T08:00:05.000Z'),
      error: null,
    };

    await expect(service.reconcileTaskPushUnknownOutcome(task, 'project-1')).resolves.toBe('settled');
    expect(mockClient.from).toHaveBeenCalledWith('tasks');
  });

  it('sync RPC 不可用时远端 payload 不同即使有本地版本基线也应保持 unknown', async () => {
    syncRpcFeatureEnabled = false;
    const task = createLocalTask('2026-07-09T08:00:00.000Z');
    freshnessResult = {
      data: {
        ...createMatchingRemoteRow(task, '2026-07-09T08:00:05.000Z'),
        title: 'another writer payload',
      },
      error: null,
    };

    await expect(service.reconcileTaskPushUnknownOutcome(task, 'project-1')).resolves.toBe('unknown');
  });

  it('sync RPC 不可用且远端行不存在时也应保持 unknown', async () => {
    syncRpcFeatureEnabled = false;
    const task = createLocalTask('2026-07-09T08:00:00.000Z');
    freshnessResult = { data: null, error: null };

    await expect(service.reconcileTaskPushUnknownOutcome(task, 'project-1')).resolves.toBe('unknown');
  });

  it('sync RPC 不可用时远端 payload 不同且无本地版本基线应保持 unknown', async () => {
    syncRpcFeatureEnabled = false;
    const task = createLocalTask(undefined);
    freshnessResult = {
      data: {
        ...createMatchingRemoteRow(task, '2026-07-09T08:00:05.000Z'),
        title: 'another writer payload',
      },
      error: null,
    };

    await expect(service.reconcileTaskPushUnknownOutcome(task, 'project-1')).resolves.toBe('unknown');
  });

  it('本地缺少 updatedAt 基线时按既有语义正常重放（replay）', async () => {
    const task = createLocalTask(undefined);

    await expect(service.reconcileTaskPushUnknownOutcome(task, 'project-1')).resolves.toBe('replay');
  });
});
