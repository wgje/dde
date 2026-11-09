import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ConnectionSyncOperationsService } from './connection-sync-operations.service';
import { SupabaseClientService } from '../../../../services/supabase-client.service';
import { LoggerService } from '../../../../services/logger.service';
import { ToastService } from '../../../../services/toast.service';
import { RequestThrottleService } from '../../../../services/request-throttle.service';
import { ProjectStateService } from '../../../../services/project-state.service';
import { ClockSyncService } from '../../../../services/clock-sync.service';
import { SyncOperationHelperService } from './sync-operation-helper.service';
import { SessionManagerService } from './session-manager.service';
import { RetryQueueService } from './retry-queue.service';
import { SyncStateService } from './sync-state.service';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import { TombstoneService } from './tombstone.service';
import { SyncRpcClientService } from '../../../../services/sync-rpc-client.service';
import { DataSafetyAuditPersistence } from '../../../../services/data-safety-audit-persistence';
import { ConflictStorageService } from '../../../../services/conflict-storage.service';
import type { Connection } from '../../../../models';
import { PermanentFailureError } from '../../../../utils/permanent-failure-error';
import { resetBrowserNetworkSuspensionTrackingForTests } from '../../../../utils/browser-network-suspension';
import { buildConnectionUpsertQuery, createMockSyncRpcClient, expectConnectionRetryEnqueued, resetMockSyncRpcClient, setVisibilityState, type ConnectionEndpointTombstoneResult, type ConnectionFreshnessResult, type ConnectionTombstoneResult, type ConnectionWriteResult, type EndpointDedupResponse, type LegacyConnectionTombstoneResult, type ProjectConnectionState, type TaskExistenceResult } from './connection-sync-operations.test-harness';
import {
  registerConnectionSyncCanonicalRecoverySpecs,
  type ConnectionSyncCanonicalRecoverySpecContext,
} from './connection-sync-canonical-recovery.spec-helpers';
import {
  registerConnectionSyncCanonicalTombstoneSpecs,
  type ConnectionSyncCanonicalTombstoneSpecContext,
} from './connection-sync-canonical-tombstone.spec-helpers';
import {
  registerConnectionSyncSessionRecoverySpecs,
  type ConnectionSyncSessionRecoverySpecContext,
} from './connection-sync-session-recovery.spec-helpers';
import {
  registerConnectionSyncTerminalRejectionSpecs,
  type ConnectionSyncTerminalRejectionSpecContext,
} from './connection-sync-terminal-rejection.spec-helpers';
import {
  registerConnectionSyncRpcUpsertSpecs,
  type ConnectionSyncRpcUpsertSpecContext,
} from './connection-sync-rpc-upsert.spec-helpers';
import { registerConnectionSyncActionQueueReplaySpecs } from './connection-sync-action-queue-replay.spec-helpers';

describe('ConnectionSyncOperationsService', () => {
  let service: ConnectionSyncOperationsService;

  const mockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const mockRetryWithBackoff = vi.fn(async (fn: () => Promise<void>) => await fn());

  const mockRetryQueue = {
    checkCircuitBreaker: vi.fn(() => true),
    add: vi.fn(() => true),
    addDurably: vi.fn(async () => true),
    commitConnectionReplay: vi.fn(async () => ({ status: 'committed' as const })),
    recordCircuitFailure: vi.fn(),
    recordCircuitSuccess: vi.fn(),
    length: 0,
  };
  const mockSyncRpcClient = createMockSyncRpcClient();

  const mockSessionManager = {
    tryRefreshSession: vi.fn(async () => false),
    handleSessionExpired: vi.fn(),
    isSessionExpiredError: vi.fn(() => false),
    handleAuthErrorWithRefresh: vi.fn(async () => false),
    isRlsPolicyViolation: vi.fn(() => false),
  };

  const mockTombstoneService = {
    getLocalTombstones: vi.fn(() => new Set<string>()),
    getConnectionTombstoneCache: vi.fn(() => null),
    updateConnectionTombstoneCache: vi.fn(),
  };

  let connectionTombstoneResult: ConnectionTombstoneResult;
  let connectionEndpointTombstoneResult: ConnectionEndpointTombstoneResult;
  let legacyConnectionTombstoneResult: LegacyConnectionTombstoneResult;
  let taskExistenceResult: TaskExistenceResult;
  let endpointDedupResponses: EndpointDedupResponse[];
  let connectionFreshnessResult: ConnectionFreshnessResult;
  let connectionReadbackQueryCount: number;
  let connectionUpsertResult: ConnectionWriteResult;
  let connectionUpdateResult: ConnectionWriteResult;
  let syncStateSnapshot: { lastSyncTime: string | null; pendingCount: number };
  const mockConnectionsUpsert = vi.fn();
  let mockProjects: ProjectConnectionState[];

  const mockProjectState = {
    getProject: vi.fn((projectId: string) => mockProjects.find(project => project.id === projectId)),
    getProjectWithCurrentData: vi.fn((projectId: string) => mockProjects.find(project => project.id === projectId)),
    updateProjects: vi.fn((updater: (projects: ProjectConnectionState[]) => ProjectConnectionState[]) => {
      mockProjects = updater(mockProjects);
    }),
  };

  const mockConflictStorage = {
    saveConflict: vi.fn(async () => true),
  };

  const mockSyncState = {
    isSessionExpired: vi.fn(() => false),
    syncState: vi.fn(() => syncStateSnapshot),
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
          select: vi.fn((columns: string) => {
            if (columns === 'deleted_at') {
              return {
                eq: vi.fn(() => ({
                  eq: vi.fn(() => ({
                    eq: vi.fn(() => ({
                      order: vi.fn(() => ({
                        limit: vi.fn(() => ({
                          maybeSingle: vi.fn(async () => connectionEndpointTombstoneResult),
                        })),
                      })),
                    })),
                  })),
                  is: vi.fn(() => ({
                    is: vi.fn(() => ({
                      order: vi.fn(() => ({
                        limit: vi.fn(() => ({
                          maybeSingle: vi.fn(async () => legacyConnectionTombstoneResult),
                        })),
                      })),
                    })),
                  })),
                })),
              };
            }

            return {
              eq: vi.fn(() => ({
                maybeSingle: vi.fn(async () => connectionTombstoneResult),
              })),
            };
          }),
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
          select: vi.fn((columns: string) => {
            if (columns === 'id,updated_at,deleted_at') {
              return {
                eq: vi.fn(() => ({
                  eq: vi.fn(() => ({
                    maybeSingle: vi.fn(async () => connectionFreshnessResult),
                  })),
                })),
              };
            }

            if (columns === 'updated_at') {
              connectionReadbackQueryCount += 1;
              return {
                eq: vi.fn(() => ({
                  maybeSingle: vi.fn(async () => ({ data: null, error: null })),
                })),
              };
            }

            return {
              eq: vi.fn(() => ({
                eq: vi.fn(() => ({
                  eq: vi.fn(async () => {
                    if (endpointDedupResponses.length > 1) {
                      return endpointDedupResponses.shift()!;
                    }

                    return endpointDedupResponses[0] ?? { data: [], error: null };
                  }),
                })),
              })),
            };
          }),
          insert: (payload: unknown) => {
            const rawResult = mockConnectionsUpsert(payload, { onConflict: 'id', ignoreDuplicates: false });
            return buildConnectionUpsertQuery(rawResult === undefined ? connectionUpsertResult : rawResult);
          },
          update: (payload: unknown) => {
            const rawResult = mockConnectionsUpsert(payload, { mode: 'cas-update' });
            return {
              eq: vi.fn(() => ({
                eq: vi.fn(() => ({
                  eq: vi.fn(() => ({
                    select: vi.fn(() => ({
                      maybeSingle: vi.fn(async () => {
                        const resolved = await Promise.resolve(rawResult);
                        return (resolved === undefined ? connectionUpdateResult : resolved) as ConnectionWriteResult;
                      }),
                    })),
                  })),
                })),
              })),
            };
          },
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    }),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    resetBrowserNetworkSuspensionTrackingForTests();
    setVisibilityState('visible');
    resetMockSyncRpcClient(mockSyncRpcClient);
    syncStateSnapshot = { lastSyncTime: null, pendingCount: 0 };
    connectionTombstoneResult = { data: null, error: null };
    connectionEndpointTombstoneResult = { data: null, error: null };
    legacyConnectionTombstoneResult = { data: null, error: null };
    taskExistenceResult = {
      data: [{ id: 'task-a' }, { id: 'task-b' }],
      error: null,
    };
    endpointDedupResponses = [{ data: [], error: null }];
    connectionFreshnessResult = { data: null, error: null };
    connectionReadbackQueryCount = 0;
    connectionUpsertResult = {
      data: { updated_at: '2026-04-11T00:01:00.000Z' },
      error: null,
    };
    connectionUpdateResult = {
      data: { updated_at: '2026-04-11T00:01:00.000Z' },
      error: null,
    };
    mockClient.auth.getSession.mockResolvedValue({ data: { session: { user: { id: 'user-1' } } } });
    mockConnectionsUpsert.mockImplementation(() => undefined);
    mockConflictStorage.saveConflict.mockResolvedValue(true);
    mockRetryQueue.commitConnectionReplay.mockReset();
    mockRetryQueue.commitConnectionReplay.mockResolvedValue({ status: 'committed' });
    mockProjects = [{ id: 'project-1', connections: [], tasks: [] }];

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
        {
          provide: ClockSyncService,
          useValue: {
            isLocalNewer: vi.fn((left: string, right: string) => new Date(left).getTime() > new Date(right).getTime()),
            compareTimestamps: vi.fn((left: string, right: string) => new Date(left).getTime() - new Date(right).getTime()),
            ensureSynced: vi.fn().mockResolvedValue({ reliable: true }),
            recordServerTimestamp: vi.fn(),
          },
        },
        { provide: ProjectStateService, useValue: mockProjectState },
        { provide: SyncOperationHelperService, useValue: { retryWithBackoff: mockRetryWithBackoff } },
        {
          provide: SessionManagerService,
          useValue: mockSessionManager,
        },
        { provide: RetryQueueService, useValue: mockRetryQueue },
        { provide: SyncRpcClientService, useValue: mockSyncRpcClient },
        { provide: SyncStateService, useValue: mockSyncState },
        { provide: TombstoneService, useValue: mockTombstoneService },
        { provide: ConflictStorageService, useValue: mockConflictStorage },
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

  function loadDataSafetyAudit(ownerUserId: string) {
    return new DataSafetyAuditPersistence().load(ownerUserId);
  }

  function getCanonicalRecoverySpecContext(): ConnectionSyncCanonicalRecoverySpecContext {
    return {
      service,
      mockClient,
      mockConnectionsUpsert,
      mockRetryQueue,
      setTaskExistenceResult: (result: TaskExistenceResult) => {
        taskExistenceResult = result;
      },
    };
  }

  function getCanonicalTombstoneSpecContext(): ConnectionSyncCanonicalTombstoneSpecContext {
    return {
      service,
      mockSyncRpcClient,
      mockRetryQueue,
      setEndpointDedupResponses: (responses: EndpointDedupResponse[]) => {
        endpointDedupResponses = responses;
      },
      setMockProjects: (projects: ProjectConnectionState[]) => {
        mockProjects = projects;
      },
      getMockProjects: () => mockProjects,
      setConnectionTombstoneResult: (result: ConnectionTombstoneResult) => {
        connectionTombstoneResult = result;
      },
      setConnectionEndpointTombstoneResult: (result: ConnectionEndpointTombstoneResult) => {
        connectionEndpointTombstoneResult = result;
      },
      setLegacyConnectionTombstoneResult: (result: LegacyConnectionTombstoneResult) => {
        legacyConnectionTombstoneResult = result;
      },
    };
  }

  function getSessionRecoverySpecContext(): ConnectionSyncSessionRecoverySpecContext {
    return {
      service,
      mockClient,
      mockRetryQueue,
      mockSessionManager,
      mockSyncRpcClient,
      mockSyncState,
    };
  }

  function getTerminalRejectionSpecContext(): ConnectionSyncTerminalRejectionSpecContext {
    return {
      service,
      mockSyncRpcClient,
      mockConnectionsUpsert,
      mockRetryQueue,
      mockTombstoneService,
      mockSyncState,
      getMockProjects: () => mockProjects,
      setMockProjects: (projects: ProjectConnectionState[]) => {
        mockProjects = projects;
      },
      setTaskExistenceResult: (result: TaskExistenceResult) => {
        taskExistenceResult = result;
      },
      getSentryCaptureMessage: () => (
        TestBed.inject(SentryLazyLoaderService) as unknown as {
          captureMessage: ReturnType<typeof vi.fn>;
        }
      ).captureMessage,
    };
  }

  function getRpcUpsertSpecContext(): ConnectionSyncRpcUpsertSpecContext {
    return {
      service,
      mockSyncRpcClient,
      mockConnectionsUpsert,
      mockRetryQueue,
      mockConflictStorage,
      loadDataSafetyAudit,
      setMockProjects: projects => {
        mockProjects = projects;
      },
      getMockProjects: () => mockProjects,
    };
  }

  registerConnectionSyncRpcUpsertSpecs(getRpcUpsertSpecContext);
  registerConnectionSyncActionQueueReplaySpecs(() => ({
    service,
    mockClient,
    mockRetryQueue,
    mockSessionManager,
    mockSyncState,
    mockSyncRpcClient,
    setEndpointDedupResponses: responses => {
      endpointDedupResponses = responses;
    },
  }));

  it('sync RPC 不可用的 RetryQueue 回放应通过 retry helper 保留原队列项', async () => {
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(false);
    const operationId = '00000000-0000-4000-8000-000000000303';
    const connection: Connection = {
      id: 'connection-rpc-unavailable-retry-helper',
      source: 'task-a',
      target: 'task-b',
      updatedAt: '2026-07-15T00:00:00.000Z',
    };

    await expect(service.pushConnection(
      connection,
      'project-1',
      true,
      true,
      true,
      'user-1',
      operationId,
    )).rejects.toMatchObject({ isRetryDeferred: true });

    expect(mockRetryWithBackoff).toHaveBeenCalledTimes(1);
    expect(mockRetryQueue.addDurably).not.toHaveBeenCalled();
    expect(mockRetryQueue.add).not.toHaveBeenCalled();
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
    expectConnectionRetryEnqueued(mockRetryQueue, connection);
  });

  it('getConnectionTombstoneIds 在浏览器网络挂起时应延后且不告警', async () => {
    setVisibilityState('hidden');

    const tombstones = await service.getConnectionTombstoneIds('project-1');

    expect(tombstones.size).toBe(0);
    expect(mockClient.from).not.toHaveBeenCalledWith('connection_tombstones');
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  registerConnectionSyncTerminalRejectionSpecs(getTerminalRejectionSpecContext);

  function pushConnectionFromRetryQueue(
    connection: Connection,
    operationId = '00000000-0000-4000-8000-000000000501',
  ): Promise<boolean> {
    return service.pushConnection(connection, 'project-1', false, false, true, 'user-1', operationId);
  }

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
    expectConnectionRetryEnqueued(mockRetryQueue, connection);
    expect(mockConnectionsUpsert).not.toHaveBeenCalled();
  });

  it('重试队列回放 connection upsert 遇到可重试基础设施故障时应抛回延后通道而不是消耗重试预算', async () => {
    // P0 回归：回放中的 503/超时/断网类失败被吞成 false 会计入 retryCount，
    // 弱网 flap 数轮即把队列项烧进隔离区；必须抛出让 runner 按 server-pressure 延后。
    const connection: Connection = {
      id: 'connection-replay-infra-defer',
      source: 'task-a',
      target: 'task-b',
    };
    connectionTombstoneResult = {
      data: null,
      error: { code: '503', message: 'Service unavailable' },
    };

    await expect(pushConnectionFromRetryQueue(connection))
      .rejects.toMatchObject({ isRetryable: true });
    expect(mockRetryQueue.add).not.toHaveBeenCalled();
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
    mockSessionManager.isSessionExpiredError.mockImplementation(((error: { code?: string | number }) => error.code === '42501') as any);
    mockSessionManager.handleAuthErrorWithRefresh.mockResolvedValueOnce(true);
    mockSessionManager.isRlsPolicyViolation.mockImplementation(((error: { code?: string | number }) => error.code === '42501') as any);

    await expect(service.pushConnection(connection, 'project-1', false, false, true, 'user-1'))
      .rejects.toBeInstanceOf(PermanentFailureError);
    expect(mockRetryQueue.add).not.toHaveBeenCalled();
    expect(mockConnectionsUpsert).not.toHaveBeenCalled();
  });

  it('self-link 连接不应写入云端或进入重试队列', async () => {
    const connection: Connection = {
      id: 'connection-self-link',
      source: 'task-a',
      target: 'task-a',
    };

    const result = await service.pushConnection(connection, 'project-1', false, false, false, 'user-1');

    expect(result).toBe(false);
    expect(mockRetryQueue.add).not.toHaveBeenCalled();
    expect(mockConnectionsUpsert).not.toHaveBeenCalled();
  });

  registerConnectionSyncCanonicalTombstoneSpecs(getCanonicalTombstoneSpecContext);

  registerConnectionSyncCanonicalRecoverySpecs(getCanonicalRecoverySpecContext);

  registerConnectionSyncSessionRecoverySpecs(getSessionRecoverySpecContext);
});
