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
import { SyncRpcClientService, type SyncRpcResult } from '../../../../services/sync-rpc-client.service';
import { DataSafetyAuditPersistence } from '../../../../services/data-safety-audit-persistence';
import { Task } from '../../../../models';
import { TaskStore } from '../../state/stores';
import { TaskDeleteConflictCaptureService } from './task-delete-conflict-capture.service';
import { resetBrowserNetworkSuspensionTrackingForTests } from '../../../../utils/browser-network-suspension';
import {
  registerTaskSyncOperationsBrowserSuspensionSpecs,
  type TaskSyncOperationsBrowserSuspensionSpecContext,
} from './task-sync-operations-browser-suspension.spec-helpers';
import {
  registerTaskSyncOperationsDeleteRpcSpecs,
  type TaskSyncOperationsDeleteRpcSpecContext,
} from './task-sync-operations-delete-rpc.spec-helpers';
import {
  registerTaskSyncOperationsDirectUpsertSpecs,
  type TaskSyncOperationsDirectUpsertSpecContext,
} from './task-sync-operations-direct-upsert.spec-helpers';
import {
  registerTaskSyncOperationsRpcUpsertSpecs,
  type TaskSyncOperationsRpcUpsertSpecContext,
} from './task-sync-operations-rpc-upsert.spec-helpers';
import {
  registerTaskSyncOperationsRetryGuardSpecs,
  type TaskSyncOperationsRetryGuardSpecContext,
} from './task-sync-operations-retry-guard.spec-helpers';

function setVisibilityState(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: state,
  });
}

function createSyncRpcResult(overrides: Partial<SyncRpcResult> = {}): SyncRpcResult {
  return {
    status: 'applied',
    raw: {},
    ...overrides,
  };
}

const upsertTaskRpcMock = vi.fn<SyncRpcClientService['upsertTask']>();
const deleteTasksRpcMock = vi.fn<SyncRpcClientService['deleteTasks']>();
const checkProtocolMock = vi.fn<SyncRpcClientService['checkProtocol']>();
const isSyncRpcFeatureEnabledMock = vi.fn(() => false);
const isSyncRpcClientRejectedMock = vi.fn(() => false);

describe('TaskSyncOperationsService', () => {
  let service: TaskSyncOperationsService;
  let upsertPayload: Record<string, unknown> | null;
  let taskFreshnessResult: { data: { id: string; updated_at: string | null; deleted_at: string | null } | null; error: unknown | null };
  let taskInsertResult: { data: { updated_at: string } | null; error: unknown | null };
  let taskUpdateResult: { data: { updated_at: string } | null; error: unknown | null };
  let syncStateSnapshot: { lastSyncTime: string | null; pendingCount: number };
  const mockProjectDataService = {
    rowToTask: vi.fn((row: Task) => row),
  };
  const mockTombstoneService = {
    addLocalTombstones: vi.fn(),
    invalidateCache: vi.fn(),
    deleteAttachmentFilesFromStorage: vi.fn().mockResolvedValue(undefined),
    getTombstonesWithCache: vi.fn().mockResolvedValue({ data: [], error: null }),
    getLocalTombstones: vi.fn(() => new Set<string>()),
    getLocalTombstoneTimestamp: vi.fn((_projectId: string, _taskId: string): number | undefined => undefined),
    clearLocalTombstones: vi.fn(),
    shouldMaterializeTaskDeletion: vi.fn((updatedAt: string | undefined | null, tombstoneTimestamp?: number) => {
      if (tombstoneTimestamp === undefined) {
        return false;
      }
      if (!updatedAt) {
        return true;
      }
      return new Date(updatedAt).getTime() <= tombstoneTimestamp;
    }),
  };
  const mockRetryQueue = {
    checkCircuitBreaker: vi.fn(() => true),
    add: vi.fn(() => true),
    addDurably: vi.fn(async () => true),
    hasEntity: vi.fn((_type: string, _entityId: string) => false),
    length: 0,
    recordCircuitSuccess: vi.fn(),
    recordCircuitFailure: vi.fn(),
    removeByEntities: vi.fn((_entityType: string, _entityIds: string[]): string[] => []),
    removeConnectionsReferencingTasks: vi.fn((_projectId: string, _taskIds: string[]): string[] => []),
  };
  const mockSyncRpcClient: {
    isFeatureEnabled: typeof isSyncRpcFeatureEnabledMock;
    isClientRejected: typeof isSyncRpcClientRejectedMock;
    checkProtocol: typeof checkProtocolMock;
    upsertTask: typeof upsertTaskRpcMock;
    deleteTasks: typeof deleteTasksRpcMock;
  } = {
    isFeatureEnabled: isSyncRpcFeatureEnabledMock,
    isClientRejected: isSyncRpcClientRejectedMock,
    checkProtocol: checkProtocolMock,
    upsertTask: upsertTaskRpcMock,
    deleteTasks: deleteTasksRpcMock,
  };
  const mockSyncState = {
    isSessionExpired: vi.fn(() => false),
    syncState: vi.fn(() => syncStateSnapshot),
    advanceLastSyncTimeIfIdle: vi.fn((lastSyncTime: string) => {
      syncStateSnapshot = { ...syncStateSnapshot, lastSyncTime };
      return true;
    }),
    setPendingCount: vi.fn(),
    setSyncError: vi.fn(),
    setLastSyncTime: vi.fn((lastSyncTime: string | null) => {
      syncStateSnapshot = { ...syncStateSnapshot, lastSyncTime };
    }),
  };
  const mockTaskStore = {
    getTask: vi.fn(),
    setTask: vi.fn(),
  };
  const mockTaskDeleteConflictCapture = {
    capture: vi.fn(async () => true),
  };
  const mockSessionManager = {
    tryRefreshSession: vi.fn(async () => false),
    handleSessionExpired: vi.fn(() => {
      throw new Error('Session expired');
    }),
    isSessionExpiredError: vi.fn((_error?: any) => false),
    handleAuthErrorWithRefresh: vi.fn(async () => false),
    isRlsPolicyViolation: vi.fn((_error?: any) => false),
  };

  function getRetryGuardSpecContext(): TaskSyncOperationsRetryGuardSpecContext {
    return {
      service,
      getUpsertPayload: () => upsertPayload,
      mockClient,
      mockRetryQueue,
      mockSessionManager,
      mockSyncRpcClient,
      mockSyncState,
      mockTaskStore,
      deleteTasksRpcMock,
    };
  }

  function getBrowserSuspensionSpecContext(): TaskSyncOperationsBrowserSuspensionSpecContext {
    return {
      service,
      setVisibilityState,
      mockClient,
      mockLogger,
      mockRetryQueue,
      mockSessionManager,
      mockTombstoneService,
    };
  }

  function getDirectUpsertSpecContext(): TaskSyncOperationsDirectUpsertSpecContext {
    return {
      service,
      getUpsertPayload: () => upsertPayload,
      setUpsertPayload: payload => {
        upsertPayload = payload;
      },
      setTaskFreshnessResult: result => {
        taskFreshnessResult = result;
      },
      setTaskInsertResult: result => {
        taskInsertResult = result;
      },
      setTaskUpdateResult: result => {
        taskUpdateResult = result;
      },
      mockClient,
      mockRetryQueue,
      mockTaskStore,
    };
  }

  function getRpcUpsertSpecContext(): TaskSyncOperationsRpcUpsertSpecContext {
    return {
      service,
      getUpsertPayload: () => upsertPayload,
      loadDataSafetyAudit: ownerUserId => new DataSafetyAuditPersistence().load(ownerUserId),
      createSyncRpcResult,
      mockSyncRpcClient,
      mockRetryQueue,
      mockSyncState,
    };
  }

  function getDeleteRpcSpecContext(): TaskSyncOperationsDeleteRpcSpecContext {
    return {
      service,
      getUpsertPayload: () => upsertPayload,
      loadDataSafetyAudit: ownerUserId => new DataSafetyAuditPersistence().load(ownerUserId),
      createSyncRpcResult,
      mockClient,
      mockSyncRpcClient,
      mockTaskStore,
      mockTaskDeleteConflictCapture,
      mockRetryQueue,
      mockTombstoneService,
    };
  }

  const mockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  function defaultMockClientFrom(table: string) {
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
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            in: vi.fn(async (_column: string, ids: string[]) => ({
              data: ids.map(id => ({ id })),
              error: null,
            })),
            eq: vi.fn(() => ({
              maybeSingle: vi.fn(async () => taskFreshnessResult),
            })),
          })),
        })),
        update: vi.fn((payload: Record<string, unknown>) => {
          upsertPayload = payload;
          return {
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                eq: vi.fn(() => ({
                  select: vi.fn(() => ({
                    maybeSingle: vi.fn(async () => taskUpdateResult),
                  })),
                })),
              })),
            })),
          } as unknown as Record<string, unknown>;
        }),
        insert: vi.fn((payload: Record<string, unknown>) => {
          upsertPayload = payload;
          return {
            select: vi.fn(() => ({
              maybeSingle: vi.fn(async () => taskInsertResult),
            })),
          };
        }),
      };
    }

    throw new Error(`Unexpected table: ${table}`);
  }

  const mockClient = {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: { user: { id: 'user-1' } } } })),
    },
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      if (fn === 'purge_tasks_v3') {
        return {
          data: { purged_count: 1, attachment_paths: [] },
          error: null,
          args,
        };
      }

      if (fn === 'purge_tasks_v2') {
        return { data: 1, error: null, args };
      }

      throw new Error(`Unexpected rpc: ${fn}`);
    }),
    from: vi.fn(defaultMockClientFrom) as any,
  };

  beforeEach(() => {
    upsertPayload = null;
    syncStateSnapshot = { lastSyncTime: null, pendingCount: 0 };
    vi.clearAllMocks();
    localStorage.clear();
    resetBrowserNetworkSuspensionTrackingForTests();
    setVisibilityState('visible');
    mockClient.from.mockImplementation(defaultMockClientFrom);
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(false);
    mockSyncRpcClient.isClientRejected.mockReturnValue(false);
    mockSyncRpcClient.checkProtocol.mockImplementation(async () => null);
    taskFreshnessResult = { data: null, error: null };
    taskInsertResult = { data: { updated_at: new Date().toISOString() }, error: null };
    taskUpdateResult = { data: { updated_at: new Date().toISOString() }, error: null };
    const defaultUpsertTaskRpcResult: SyncRpcResult = createSyncRpcResult({ entityId: 'task-1' });
    mockSyncRpcClient.upsertTask.mockImplementation(async () => defaultUpsertTaskRpcResult);
    mockTaskStore.getTask.mockReturnValue(undefined);
    mockTaskStore.setTask.mockReset();
    const defaultDeleteTasksRpcResult: SyncRpcResult = createSyncRpcResult({
      entityId: 'project-1',
      affectedCount: 1,
      attachmentPaths: [] as string[],
    });
    mockSyncRpcClient.deleteTasks.mockImplementation(async () => defaultDeleteTasksRpcResult);
    mockClient.rpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
      if (fn === 'purge_tasks_v3') {
        return {
          data: { purged_count: 1, attachment_paths: [] },
          error: null,
          args,
        };
      }

      if (fn === 'purge_tasks_v2') {
        return { data: 1, error: null, args };
      }

      throw new Error(`Unexpected rpc: ${fn}`);
    });

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
        {
          provide: ClockSyncService,
          useValue: {
            isLocalNewer: vi.fn((left: string, right: string) => new Date(left).getTime() > new Date(right).getTime()),
            compareTimestamps: vi.fn((left: string, right: string) => new Date(left).getTime() - new Date(right).getTime()),
            ensureSynced: vi.fn().mockResolvedValue({ reliable: true }),
            recordServerTimestamp: vi.fn(),
          },
        },
        { provide: TaskStore, useValue: mockTaskStore },
        {
          provide: SyncOperationHelperService,
          useValue: {
            retryWithBackoff: vi.fn(async (fn: () => Promise<void>) => await fn()),
          },
        },
        {
          provide: SessionManagerService,
          useValue: mockSessionManager,
        },
        {
          provide: TombstoneService,
          useValue: mockTombstoneService,
        },
        { provide: ProjectDataService, useValue: mockProjectDataService },
        {
          provide: RetryQueueService,
          useValue: mockRetryQueue,
        },
        { provide: SyncRpcClientService, useValue: mockSyncRpcClient },
        { provide: TaskDeleteConflictCaptureService, useValue: mockTaskDeleteConflictCapture },
        {
          provide: SyncStateService,
          useValue: mockSyncState,
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

  it('pushTaskPosition 在 sync RPC 开启且有任务快照时应走受 CAS 保护的 task upsert', async () => {
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    const rpcResult: SyncRpcResult = createSyncRpcResult({
      entityId: 'task-position-rpc',
      serverUpdatedAt: '2026-04-30T08:00:00.000Z',
    });
    mockSyncRpcClient.upsertTask.mockImplementationOnce(async () => rpcResult);
    const fallbackTask = {
      id: 'task-position-rpc',
      title: 'Position task',
      content: 'Position task',
      x: 1,
      y: 2,
      updatedAt: '2026-04-30T07:00:00.000Z',
    } as Task;
    mockTaskStore.getTask.mockReturnValue({ ...fallbackTask });

    const result = await service.pushTaskPosition(
      'task-position-rpc',
      10,
      20,
      'project-1',
      fallbackTask,
      'user-1',
    );

    expect(result).toBe(true);
    expect(mockSyncRpcClient.upsertTask).toHaveBeenCalledWith(expect.objectContaining({
      task: expect.objectContaining({
        id: 'task-position-rpc',
        x: 10,
        y: 20,
      }),
      projectId: 'project-1',
      baseUpdatedAt: '2026-04-30T07:00:00.000Z',
      writeIntent: 'task_structure_update',
    }));
    expect(mockClient.from).not.toHaveBeenCalledWith('tasks');
    expect(fallbackTask.x).toBe(10);
    expect(fallbackTask.y).toBe(20);
    expect(fallbackTask.updatedAt).toBe('2026-04-30T08:00:00.000Z');
    expect(mockTaskStore.setTask).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'task-position-rpc',
        x: 10,
        y: 20,
        updatedAt: '2026-04-30T08:00:00.000Z',
      }),
      'project-1',
    );
  });

  it('pushTaskPosition 收到本地操作 operationId 时应复用同一个 RPC 幂等键', async () => {
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    const operationId = '11111111-1111-4111-8111-111111111111';
    const rpcResult: SyncRpcResult = createSyncRpcResult({
      entityId: 'task-position-rpc-operation-id',
      serverUpdatedAt: '2026-04-30T08:10:00.000Z',
    });
    mockSyncRpcClient.upsertTask.mockImplementationOnce(async () => rpcResult);
    const fallbackTask = {
      id: 'task-position-rpc-operation-id',
      title: 'Position task with operationId',
      content: 'Position task with operationId',
      x: 1,
      y: 2,
      updatedAt: '2026-04-30T08:00:00.000Z',
    } as Task;
    mockTaskStore.getTask.mockReturnValue({ ...fallbackTask });

    const result = await service.pushTaskPosition(
      'task-position-rpc-operation-id',
      30,
      40,
      'project-1',
      fallbackTask,
      'user-1',
      operationId,
    );

    expect(result).toBe(true);
    expect(mockSyncRpcClient.upsertTask).toHaveBeenCalledWith(expect.objectContaining({
      operationId,
      task: expect.objectContaining({
        id: 'task-position-rpc-operation-id',
        x: 30,
        y: 40,
      }),
      projectId: 'project-1',
      baseUpdatedAt: '2026-04-30T08:00:00.000Z',
      writeIntent: 'task_structure_update',
    }));
  });

  it('pushTaskPosition 直接更新成功后应把 x/y/rank 与服务端 canonical updated_at 写回 fallback 任务', async () => {
    const serverUpdatedAt = '2026-04-30T08:10:00.000Z';
    mockClient.from.mockImplementationOnce((table: string) => {
      if (table !== 'tasks') {
        throw new Error(`Unexpected table: ${table}`);
      }

      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: vi.fn(async () => ({
                data: {
                  id: 'task-position-direct',
                  updated_at: '2026-04-30T07:00:00.000Z',
                  deleted_at: null,
                },
                error: null,
              })),
            })),
          })),
        })),
      };
    });
    mockClient.from.mockImplementationOnce((table: string) => {
      if (table !== 'tasks') {
        throw new Error(`Unexpected table: ${table}`);
      }

      return {
        update: vi.fn((payload: Record<string, unknown>) => ({
          eq: vi.fn((firstColumn: string, firstValue: string) => ({
            eq: vi.fn((secondColumn: string, secondValue: string) => ({
              eq: vi.fn((thirdColumn: string, thirdValue: string) => ({
                select: vi.fn(async () => ({
                  data:
                    firstColumn === 'id'
                    && firstValue === 'task-position-direct'
                    && secondColumn === 'project_id'
                    && secondValue === 'project-1'
                    && thirdColumn === 'updated_at'
                    && thirdValue === '2026-04-30T07:00:00.000Z'
                    && payload['x'] === 10
                    && payload['y'] === 20
                    && payload['rank'] === 42
                      ? [{ updated_at: serverUpdatedAt }]
                      : [],
                  error: null,
                })),
              })),
            })),
          })),
        })),
      };
    });
    const fallbackTask = {
      id: 'task-position-direct',
      title: 'Position task',
      content: 'Position task',
      x: 1,
      y: 2,
      rank: 42,
      updatedAt: '2026-04-30T07:00:00.000Z',
    } as Task;
    mockTaskStore.getTask.mockReturnValueOnce({ ...fallbackTask });

    const result = await service.pushTaskPosition(
      'task-position-direct',
      10,
      20,
      'project-1',
      fallbackTask,
      'user-1',
    );

    expect(result).toBe(true);
    expect(fallbackTask.x).toBe(10);
    expect(fallbackTask.y).toBe(20);
    expect(fallbackTask.rank).toBe(42);
    expect(fallbackTask.updatedAt).toBe(serverUpdatedAt);
    expect(mockTaskStore.setTask).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'task-position-direct',
        x: 10,
        y: 20,
        rank: 42,
        updatedAt: serverUpdatedAt,
      }),
      'project-1',
    );
  });

  it('sourceUserId 与当前会话不匹配时应拒绝写云端并按原 owner 入队', async () => {
    const task: Task = {
      id: 'task-owner-mismatch',
      title: '任务 owner mismatch',
      content: '内容',
      stage: 0,
      parentId: null,
      order: 0,
      rank: 10000,
      status: 'active',
      x: 0,
      y: 0,
      displayId: 'T-2',
      createdDate: new Date().toISOString(),
      deletedAt: null,
    };
    mockClient.auth.getSession.mockResolvedValueOnce({
      data: { session: { user: { id: 'user-2' } } },
    });

    const result = await service.pushTask(task, 'project-1', false, false, 'user-1');

    expect(result).toBe(false);
    expect(upsertPayload).toBeNull();
    expect(mockRetryQueue.addDurably).toHaveBeenCalledWith(
      'task',
      'upsert',
      task,
      'project-1',
      'user-1',
      undefined,
      undefined,
      undefined,
      undefined,
    );
  });

  it('pushTask 缺少 operationId 时不应现场生成临时 RPC 写入，应先持久化到 RetryQueue', async () => {
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    const task: Task = {
      id: 'task-missing-operation-id',
      title: '缺少 operationId 的任务',
      content: '内容',
      stage: 0,
      parentId: null,
      order: 0,
      rank: 10000,
      status: 'active',
      x: 0,
      y: 0,
      displayId: 'T-MISSING-OP',
      createdDate: new Date().toISOString(),
      deletedAt: null,
      updatedAt: '2026-06-29T00:00:00.000Z',
    };

    const result = await service.pushTask(
      task,
      'project-1',
      true,
      false,
      'user-1',
      false,
      'task_structure_update',
    );

    expect(result).toBe(false);
    expect(mockSyncRpcClient.upsertTask).not.toHaveBeenCalled();
    expect(upsertPayload).toBeNull();
    expect(mockRetryQueue.addDurably).toHaveBeenCalledWith(
      'task',
      'upsert',
      task,
      'project-1',
      'user-1',
      undefined,
      'task_structure_update',
      undefined,
      expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
    );
  });

  it('pullTasks 不应把 updatedAt 晚于 tombstone deleted_at 的恢复任务重新标记为删除', async () => {
    const restoredTask = {
      id: 'task-restored',
      title: '任务',
      content: '内容',
      stage: 1,
      parentId: null,
      order: 0,
      rank: 10000,
      status: 'active',
      x: 0,
      y: 0,
      updatedAt: '2026-04-23T01:00:00.000Z',
      createdDate: '2026-04-23T00:00:00.000Z',
      deletedAt: null,
      displayId: 'T-RESTORE',
      attachments: [],
      tags: [],
    } satisfies Task;

    mockClient.from.mockImplementationOnce((table: string) => {
      if (table === 'tasks') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              range: vi.fn(async () => ({
                data: [restoredTask],
                error: null,
              })),
            })),
          })),
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    });
    mockTombstoneService.getTombstonesWithCache.mockResolvedValueOnce({
      data: [{ task_id: 'task-restored', deleted_at: '2026-04-23T00:00:00.000Z' }],
      error: null,
    });

    const result = await service.pullTasks('project-1');

    expect(result).toHaveLength(1);
    expect(result[0]?.deletedAt).toBeNull();
  });

  it('getTombstoneIdsWithStatus 应返回本地与远端 tombstone 的 deleted_at 水位', async () => {
    mockTombstoneService.getLocalTombstones.mockReturnValueOnce(new Set(['task-local']));
    mockTombstoneService.getLocalTombstoneTimestamp.mockReturnValueOnce(
      Date.parse('2026-04-22T00:00:00.000Z'),
    );
    mockTombstoneService.getTombstonesWithCache.mockResolvedValueOnce({
      data: [
        { task_id: 'task-remote', deleted_at: '2026-04-23T00:00:00.000Z' },
        { task_id: 'task-remote-missing-deleted-at', deleted_at: null },
      ],
      error: null,
    });

    const result = await service.getTombstoneIdsWithStatus('project-1');

    expect(result.ids).toEqual(new Set([
      'task-local',
      'task-remote',
      'task-remote-missing-deleted-at',
    ]));
    expect(result.deletedAtByTaskId?.get('task-local')).toBe(Date.parse('2026-04-22T00:00:00.000Z'));
    expect(result.deletedAtByTaskId?.get('task-remote')).toBe(Date.parse('2026-04-23T00:00:00.000Z'));
    expect(result.deletedAtByTaskId?.has('task-remote-missing-deleted-at')).toBe(false);
  });

  it('pullTasks 应读取完整 Supabase REST 分页', async () => {
    const rows = Array.from({ length: 1001 }, (_, index) => ({
      id: `task-${index.toString().padStart(4, '0')}`,
      title: `Task ${index}`,
      content: `Content ${index}`,
      updatedAt: new Date(Date.UTC(2026, 5, 9, 0, 1, index)).toISOString(),
    })) as Task[];
    const ranges: Array<[number, number]> = [];

    mockClient.from.mockImplementation((table: string) => {
      if (table === 'tasks') {
        return {
          select: vi.fn(() => {
            const query = {
              eq: vi.fn(() => query),
              gt: vi.fn(() => query),
              range: vi.fn(async (from: number, to: number) => {
                ranges.push([from, to]);
                return { data: rows.slice(from, to + 1), error: null };
              }),
            };
            return query;
          }),
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    });
    mockTombstoneService.getTombstonesWithCache.mockResolvedValueOnce({ data: [], error: null });

    const result = await service.pullTasks('project-1');

    expect(result).toHaveLength(1001);
    expect(result[0]?.id).toBe('task-0000');
    expect(result[1000]?.id).toBe('task-1000');
    expect(ranges).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
  });

  registerTaskSyncOperationsDirectUpsertSpecs(getDirectUpsertSpecContext);
  registerTaskSyncOperationsRpcUpsertSpecs(getRpcUpsertSpecContext);
  registerTaskSyncOperationsDeleteRpcSpecs(getDeleteRpcSpecContext);
  registerTaskSyncOperationsBrowserSuspensionSpecs(getBrowserSuspensionSpecContext);
  registerTaskSyncOperationsRetryGuardSpecs(getRetryGuardSpecContext);
});
