import {
  beforeEach,
  describe,
  expect,
  it,
  createMockProject,
  expectDeferredCallback,
  PermanentFailureError,
} from './simple-sync.service.spec-context';
import type { Project } from './simple-sync.service.spec-context';
import { registerSimpleSyncCoreRpcCursorSpecs } from './simple-sync-core-rpc-cursor.spec-helpers';
import { registerSimpleSyncCoreRpcInitializationSpecs } from './simple-sync-core-rpc-initialization.spec-helpers';
import { DataSafetyAuditPersistence } from '../../../services/data-safety-audit-persistence';

export interface SimpleSyncCoreRpcSpecContext {
  service(): any;
  windowAddEventListenerSpy(): any;
  windowRemoveEventListenerSpy(): any;
  mockSupabase(): any;
  mockClient(): any;
  mockProjectData(): any;
  mockSyncRpcClient(): any;
  mockBlackBoxSync(): any;
  mockProjectStore(): any;
  mockSyncCursorPersistence(): any;
  mockSessionManager(): any;
  mockRetryQueueService(): any;
  mockRealtimePolling(): any;
  mockToast(): any;
  mockCaptureMessage(): any;
  mockCaptureException(): any;
  mockThrottle(): any;
}

export function registerSimpleSyncCoreRpcSpecs(context: SimpleSyncCoreRpcSpecContext): void {
  let service: any;
  let mockSupabase: any;
  let mockClient: any;
  let mockSyncRpcClient: any;
  let mockBlackBoxSync: any;
  let mockProjectStore: any;
  let mockSessionManager: any;
  let mockRetryQueueService: any;
  let mockToast: any;
  let mockCaptureMessage: any;

  function loadContext(): void {
    service = context.service();
    mockSupabase = context.mockSupabase();
    mockClient = context.mockClient();
    mockSyncRpcClient = context.mockSyncRpcClient();
    mockBlackBoxSync = context.mockBlackBoxSync();
    mockProjectStore = context.mockProjectStore();
    mockSessionManager = context.mockSessionManager();
    mockRetryQueueService = context.mockRetryQueueService();
    mockToast = context.mockToast();
    mockCaptureMessage = context.mockCaptureMessage();
  }

  beforeEach(loadContext);

  registerSimpleSyncCoreRpcInitializationSpecs(context);
  registerSimpleSyncCoreRpcCursorSpecs(context);

    describe('Project sync RPC guards', () => {
      beforeEach(() => {
        mockSupabase.isConfigured = true;
        mockSupabase.clientAsync.mockResolvedValue(mockClient);
        mockClient.auth.getSession = vi.fn().mockResolvedValue({
          data: { session: { user: { id: 'test-user-id' } } },
        });
        mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
        mockSyncRpcClient.isClientRejected.mockReturnValue(false);
        mockCaptureMessage.mockClear();
        new DataSafetyAuditPersistence().save('test-user-id', { replayLog: [], lastWriteExplain: null });
      });

      it('pushProject 在 sync RPC 开启时应使用 sync_upsert_project 而不是 PostgREST upsert', async () => {
        const operationId = 'op-project-rpc';
        const project = createMockProject({
          id: 'project-rpc',
          updatedAt: '2026-04-30T05:00:00.000Z',
        });

        const result = await service.pushProject(project, false, 'test-user-id', undefined, undefined, operationId);

        expect(result).toBe(true);
        expect(mockSyncRpcClient.upsertProject).toHaveBeenCalledWith(expect.objectContaining({
          operationId,
          project,
          ownerId: 'test-user-id',
          baseUpdatedAt: '2026-04-30T05:00:00.000Z',
        }));
        expect(mockClient.from).not.toHaveBeenCalledWith('projects');
        expect(project.updatedAt).toBe('2026-04-30T06:00:00.000Z');
      });

      it('pushProject 应优先使用调用方传入的 operationId', async () => {
        const project = createMockProject({
          id: 'project-rpc-operation-id',
          updatedAt: '2026-06-13T00:00:00.000Z',
        });

        const result = await service.pushProject(
          project,
          false,
          'test-user-id',
          undefined,
          undefined,
          'queued-project-op-1',
        );

        expect(result).toBe(true);
        expect(mockSyncRpcClient.upsertProject).toHaveBeenCalledWith(expect.objectContaining({
          operationId: 'queued-project-op-1',
        }));
      });

      it('pushProject 未传 operationId 时应自动生成幂等 key 并立即执行 sync RPC', async () => {
        const generatedOperationId = '00000000-0000-4000-8000-000000000601';
        vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce(generatedOperationId);
        const project = createMockProject({
          id: 'project-rpc-generated-operation-id',
          updatedAt: '2026-06-13T00:05:00.000Z',
        });

        const result = await service.pushProject(project, false, 'test-user-id');

        expect(result).toBe(true);
        expect(mockSyncRpcClient.upsertProject).toHaveBeenCalledWith(expect.objectContaining({
          operationId: generatedOperationId,
          project,
          ownerId: 'test-user-id',
          baseUpdatedAt: '2026-06-13T00:05:00.000Z',
        }));
        expect(mockRetryQueueService.addDurably).not.toHaveBeenCalled();
        expect(mockClient.from).not.toHaveBeenCalledWith('projects');
      });

      it('pushProject 带 operationId 且 sync RPC 不可用时应保留 RetryQueue 并禁止直接 projects table upsert', async () => {
        const project = createMockProject({
          id: 'project-rpc-unavailable-operation-id',
          updatedAt: '2026-06-13T00:00:00.000Z',
        });
        const operationId = 'queued-project-rpc-unavailable-op';
        mockSyncRpcClient.isFeatureEnabled.mockReturnValue(false);
        mockSyncRpcClient.checkProtocol.mockResolvedValueOnce(null);
        mockRetryQueueService.addDurably.mockResolvedValueOnce(true);
        const projectsQueryMock = {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                maybeSingle: vi.fn(async () => ({ data: null, error: null })),
              })),
            })),
          })),
          insert: vi.fn(() => ({
            select: vi.fn(() => ({
              maybeSingle: vi.fn(async () => ({
                data: { updated_at: '2026-06-13T00:00:05.000Z' },
                error: null,
              })),
            })),
          })),
          update: vi.fn(),
        };
        mockClient.from = vi.fn().mockImplementation((table: string) => {
          if (table === 'projects') return projectsQueryMock;
          return {};
        });

        const result = await service.pushProject(
          project,
          false,
          'test-user-id',
          undefined,
          undefined,
          operationId,
        );

        expect(result).toBe(false);
        expect(mockSyncRpcClient.upsertProject).not.toHaveBeenCalled();
        expect(mockClient.from).not.toHaveBeenCalledWith('projects');
        expect(projectsQueryMock.insert).not.toHaveBeenCalled();
        expect(projectsQueryMock.update).not.toHaveBeenCalled();
        expect(mockRetryQueueService.addDurably).toHaveBeenCalledWith(
          'project',
          'upsert',
          project,
          undefined,
          'test-user-id',
          undefined,
          undefined,
          undefined,
          operationId,
        );
      });

      it('pushProject sync RPC 成功后应持久化最近写入解释和 replay entry', async () => {
        const operationId = 'op-project-rpc-audit';
        const serverUpdatedAt = '2026-06-16T02:00:05.000Z';
        mockSyncRpcClient.upsertProject.mockResolvedValueOnce({
          status: 'applied',
          entityId: 'project-rpc-audit',
          serverUpdatedAt,
          raw: {},
        });
        const project = createMockProject({
          id: 'project-rpc-audit',
          updatedAt: '2026-06-16T02:00:00.000Z',
        });

        const result = await service.pushProject(
          project,
          false,
          'test-user-id',
          undefined,
          undefined,
          operationId,
        );

        expect(result).toBe(true);
        const audit = new DataSafetyAuditPersistence().load('test-user-id');
        expect(audit.lastWriteExplain).toMatchObject({
          operationId,
          actor: { sourceUserId: 'test-user-id' },
          entity: { type: 'project', id: 'project-rpc-audit' },
          operation: 'upsert',
          updatedAtBaseline: '2026-06-16T02:00:00.000Z',
          beforeVersion: '2026-06-16T02:00:00.000Z',
          afterVersion: serverUpdatedAt,
          queueResult: { enteredRetryQueue: false, retryCount: 0 },
          rpcResult: { status: 'applied', serverUpdatedAt },
          lwwDecision: { decision: 'local-applied', reason: 'applied' },
          lastSyncTime: { before: null, after: null, advanced: false },
        });
        expect(audit.replayLog[0]).toMatchObject({
          operationId,
          entityType: 'project',
          entityId: 'project-rpc-audit',
          operation: 'upsert',
          baseUpdatedAt: '2026-06-16T02:00:00.000Z',
          queue: { enteredRetryQueue: false, retryCount: 0 },
          rpc: { status: 'applied', serverUpdatedAt },
          lww: { decision: 'local-applied', reason: 'applied' },
        });
      });

      it('pushProject 在 feature 默认关闭但探测到 RPC 可用时仍应走 sync_upsert_project', async () => {
        const operationId = 'op-project-rpc-probed';
        const project = createMockProject({
          id: 'project-rpc-probed',
          updatedAt: '2026-04-30T05:30:00.000Z',
        });

        mockSyncRpcClient.isFeatureEnabled.mockReturnValueOnce(false);
        mockSyncRpcClient.checkProtocol.mockImplementationOnce(async () => {
          mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
          return { minProtocolVersion: 1, deploymentEpoch: 0 };
        });

        const result = await service.pushProject(project, false, 'test-user-id', undefined, undefined, operationId);

        expect(result).toBe(true);
        expect(mockSyncRpcClient.checkProtocol).toHaveBeenCalledTimes(1);
        expect(mockSyncRpcClient.upsertProject).toHaveBeenCalledWith(expect.objectContaining({
          operationId,
          project,
          ownerId: 'test-user-id',
          baseUpdatedAt: '2026-04-30T05:30:00.000Z',
        }));
        expect(mockClient.from).not.toHaveBeenCalledWith('projects');
      });

      it('pushProject 直接 upsert 成功后应把服务端 canonical updated_at 写回本地项目', async () => {
        const operationId = 'op-project-direct-canonical';
        const serverUpdatedAt = '2026-04-30T06:15:00.000Z';
        mockSyncRpcClient.isFeatureEnabled.mockReturnValue(false);
        const projectsQueryMock = {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                maybeSingle: vi.fn(async () => ({ data: null, error: null })),
              })),
            })),
          })),
          insert: vi.fn((payload: Record<string, unknown>) => ({
            select: vi.fn(() => ({
              maybeSingle: vi.fn(async () => ({
                data: { updated_at: serverUpdatedAt },
                error: null,
                payload,
              })),
            })),
          })),
          update: vi.fn(),
        };
        mockClient.from = vi.fn().mockImplementation((table: string) => {
          if (table === 'projects') return projectsQueryMock;
          return {};
        });
        const project = createMockProject({
          id: 'project-direct-canonical',
          updatedAt: '2026-04-30T05:00:00.000Z',
        });
        mockProjectStore.getProject.mockReturnValueOnce(project);

        const result = await service.pushProject(project, true, 'test-user-id', undefined, undefined, operationId);

        expect(result).toBe(true);
        expect(project.updatedAt).toBe(serverUpdatedAt);
        expect(mockProjectStore.setProject).toHaveBeenCalledWith(expect.objectContaining({
          id: 'project-direct-canonical',
          updatedAt: serverUpdatedAt,
        }));
        const payload = projectsQueryMock.insert.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(payload['updated_at']).toBeUndefined();
      });

      it('pushProject 直接 upsert 前若远端项目更新更晚则应抛出版本冲突并阻止覆盖', async () => {
        const operationId = 'op-project-direct-conflict';
        mockSyncRpcClient.isFeatureEnabled.mockReturnValue(false);
        const projectsQueryMock = {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                maybeSingle: vi.fn(async () => ({
                  data: {
                    id: 'project-direct-conflict',
                    updated_at: '2026-04-30T06:45:00.000Z',
                    deleted_at: null,
                  },
                  error: null,
                })),
              })),
            })),
          })),
          upsert: vi.fn(),
          insert: vi.fn(),
          update: vi.fn(),
        };
        mockClient.from = vi.fn().mockImplementation((table: string) => {
          if (table === 'projects') return projectsQueryMock;
          return {};
        });
        const project = createMockProject({
          id: 'project-direct-conflict',
          updatedAt: '2026-04-30T05:00:00.000Z',
        });

        await expect(service.pushProject(project, true, 'test-user-id', undefined, undefined, operationId))
          .rejects.toBeInstanceOf(PermanentFailureError);

        expect(projectsQueryMock.insert).not.toHaveBeenCalled();
        expect(projectsQueryMock.update).not.toHaveBeenCalled();
        expect(mockRetryQueueService.addDurably).not.toHaveBeenCalled();
      });

      it('pushProject 直接写入在 preflight 后发生并发更新时应抛出版本冲突', async () => {
        const operationId = 'op-project-direct-cas-miss';
        mockSyncRpcClient.isFeatureEnabled.mockReturnValue(false);
        const projectsQueryMock = {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                maybeSingle: vi.fn(async () => ({
                  data: {
                    id: 'project-direct-cas-miss',
                    updated_at: '2026-04-30T06:15:00.000Z',
                    deleted_at: null,
                  },
                  error: null,
                })),
              })),
            })),
          })),
          update: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                eq: vi.fn(() => ({
                  select: vi.fn(() => ({
                    maybeSingle: vi.fn(async () => ({ data: null, error: null })),
                  })),
                })),
              })),
            })),
          })),
          insert: vi.fn(),
        };
        mockClient.from = vi.fn().mockImplementation((table: string) => {
          if (table === 'projects') return projectsQueryMock;
          return {};
        });
        const project = createMockProject({
          id: 'project-direct-cas-miss',
          updatedAt: '2026-04-30T06:15:00.000Z',
        });

        await expect(service.pushProject(project, true, 'test-user-id', undefined, undefined, operationId))
          .rejects.toBeInstanceOf(PermanentFailureError);

        expect(projectsQueryMock.insert).not.toHaveBeenCalled();
        expect(mockRetryQueueService.addDurably).not.toHaveBeenCalled();
      });

      it('pushProject 直接 insert 在写回未返回行时应抛出版本冲突，避免 406 冒泡', async () => {
        const operationId = 'op-project-direct-insert-empty';
        mockSyncRpcClient.isFeatureEnabled.mockReturnValue(false);
        const projectsQueryMock = {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                maybeSingle: vi.fn(async () => ({ data: null, error: null })),
              })),
            })),
          })),
          insert: vi.fn(() => ({
            select: vi.fn(() => ({
              maybeSingle: vi.fn(async () => ({ data: null, error: null })),
            })),
          })),
          update: vi.fn(),
        };
        mockClient.from = vi.fn().mockImplementation((table: string) => {
          if (table === 'projects') return projectsQueryMock;
          return {};
        });
        const project = createMockProject({
          id: 'project-direct-insert-empty',
          updatedAt: '2026-04-30T05:00:00.000Z',
        });

        await expect(service.pushProject(project, true, 'test-user-id', undefined, undefined, operationId))
          .rejects.toBeInstanceOf(PermanentFailureError);

        expect(projectsQueryMock.insert).toHaveBeenCalled();
        expect(mockRetryQueueService.addDurably).not.toHaveBeenCalled();
      });

      it('pushProject 命中 remote-newer 时应抛出版本冲突而不是写入 RetryQueue', async () => {
        const operationId = 'op-project-rpc-conflict';
        const project = createMockProject({
          id: 'project-rpc-conflict',
          updatedAt: '2026-04-30T05:00:00.000Z',
        });
        mockSyncRpcClient.upsertProject.mockResolvedValueOnce({
          status: 'remote-newer',
          remoteUpdatedAt: '2026-04-30T06:30:00.000Z',
          reason: 'cas_mismatch',
          raw: {},
        });

        await expect(service.pushProject(project, false, 'test-user-id', undefined, undefined, operationId))
          .rejects.toBeInstanceOf(PermanentFailureError);

        expect(mockRetryQueueService.addDurably).not.toHaveBeenCalled();
        expect(mockToast.warning).toHaveBeenCalledWith('版本冲突', '数据已被修改，请刷新后重试');
        expect(mockCaptureMessage).toHaveBeenCalledWith(
          'sync_rpc_project_remote_newer',
          expect.objectContaining({
            level: 'warning',
            tags: expect.objectContaining({ entityType: 'project', status: 'remote-newer' }),
          }),
        );
      });

      it('pushProject sync RPC 遇到 remote-newer 时应持久化 LWW 覆盖解释', async () => {
        const operationId = 'op-project-rpc-remote-newer';
        const remoteUpdatedAt = '2026-04-30T06:30:00.000Z';
        const project = createMockProject({
          id: 'project-rpc-conflict-audit',
          updatedAt: '2026-04-30T05:00:00.000Z',
        });
        mockSyncRpcClient.upsertProject.mockResolvedValueOnce({
          status: 'remote-newer',
          remoteUpdatedAt,
          reason: 'cas_mismatch',
          raw: {},
        });

        await expect(service.pushProject(
          project,
          false,
          'test-user-id',
          undefined,
          undefined,
          operationId,
        )).rejects.toBeInstanceOf(PermanentFailureError);

        const audit = new DataSafetyAuditPersistence().load('test-user-id');
        expect(audit.lastWriteExplain).toMatchObject({
          operationId,
          actor: { sourceUserId: 'test-user-id' },
          entity: { type: 'project', id: 'project-rpc-conflict-audit' },
          operation: 'upsert',
          updatedAtBaseline: '2026-04-30T05:00:00.000Z',
          beforeVersion: '2026-04-30T05:00:00.000Z',
          afterVersion: remoteUpdatedAt,
          queueResult: { enteredRetryQueue: false, retryCount: 0 },
          rpcResult: { status: 'remote-newer', remoteUpdatedAt, reason: 'cas_mismatch' },
          lwwDecision: { decision: 'remote-kept', reason: 'remote-newer' },
          lastSyncTime: { before: null, after: null, advanced: false },
        });
        expect(audit.replayLog[0]).toMatchObject({
          operationId,
          entityType: 'project',
          entityId: 'project-rpc-conflict-audit',
          operation: 'upsert',
          queue: { enteredRetryQueue: false, retryCount: 0 },
          rpc: { status: 'remote-newer', remoteUpdatedAt },
          lww: { decision: 'remote-kept', reason: 'remote-newer' },
        });
      });

      it('黑匣子重试入队应跳过空 owner，避免生成无主重试项', () => {
        const handler = expectDeferredCallback(
          mockBlackBoxSync.setRetryQueueHandler.mock.calls[0]?.[0],
          'blackBox retry handler'
        );

        handler({
          id: crypto.randomUUID(),
          projectId: null,
          userId: '   ',
          content: 'entry',
          date: '2026-03-04',
          createdAt: '2026-03-04T00:00:00.000Z',
          updatedAt: '2026-03-04T00:00:00.000Z',
          isRead: false,
          isCompleted: false,
          isArchived: false,
          deletedAt: null,
          syncStatus: 'pending' as const,
        });

        expect(mockRetryQueueService.add).not.toHaveBeenCalled();
      });

      it('pushProjectWithResult 应将 project RPC 协议拒绝标记为 terminal 结果', async () => {
        const operationId = 'op-project-rpc-protocol-rejected';
        const project = createMockProject({
          id: 'project-rpc-protocol-rejected',
          updatedAt: '2026-04-30T05:00:00.000Z',
        });
        mockSyncRpcClient.upsertProject.mockResolvedValueOnce({
          status: 'client-version-rejected',
          minProtocolVersion: 3,
          reason: 'protocol_version_below_min',
          raw: {},
        });

        const result = await (service as unknown as {
          pushProjectWithResult: (project: Project, fromRetryQueue?: boolean, sourceUserId?: string, taskIdsToDelete?: string[], taskDeleteBaseUpdatedAtMap?: unknown, operationId?: string) => Promise<{ success: boolean; conflict?: boolean; remoteData?: Project; retryEnqueued?: boolean; failureReason?: string; terminal?: boolean }>;
        }).pushProjectWithResult(project, false, 'test-user-id', undefined, undefined, operationId);

        expect(result).toEqual({
          success: false,
          retryEnqueued: false,
          failureReason: '当前客户端同步协议已过期，请刷新后重试',
          terminal: true,
        });
        expect(mockRetryQueueService.addDurably).not.toHaveBeenCalled();
        expect(service.state().syncError).toBe('当前客户端同步协议已过期，请刷新后重试');
      });

      it('pushProjectWithResult 在 feature 默认关闭但 probe 拒绝客户端时不应回退旧项目写入路径', async () => {
        const project = createMockProject({
          id: 'project-rpc-probe-rejected',
          updatedAt: '2026-04-30T05:20:00.000Z',
        });

        mockSyncRpcClient.isFeatureEnabled.mockReturnValue(false);
        mockSyncRpcClient.isClientRejected.mockReturnValue(false);
        mockSyncRpcClient.checkProtocol.mockImplementationOnce(async () => {
          mockSyncRpcClient.isClientRejected.mockReturnValue(true);
          return { minProtocolVersion: 3, deploymentEpoch: 0 };
        });

        const result = await (service as unknown as {
          pushProjectWithResult: (project: Project, fromRetryQueue?: boolean, sourceUserId?: string, taskIdsToDelete?: string[]) => Promise<{ success: boolean; conflict?: boolean; remoteData?: Project; retryEnqueued?: boolean; failureReason?: string; terminal?: boolean }>;
        }).pushProjectWithResult(project, false, 'test-user-id');

        expect(result).toEqual({
          success: false,
          retryEnqueued: true,
          failureReason: 'project sync queued for retry',
        });
        expect(mockSyncRpcClient.upsertProject).not.toHaveBeenCalled();
        expect(mockClient.from).not.toHaveBeenCalledWith('projects');
      });

      it('pushProjectWithResult 在 RPC 返回 supabase_client_unavailable 时应继续写入 RetryQueue', async () => {
        const operationId = 'op-project-rpc-client-unavailable';
        const project = createMockProject({
          id: 'project-rpc-client-unavailable',
          updatedAt: '2026-04-30T05:10:00.000Z',
        });
        mockRetryQueueService.addDurably.mockResolvedValueOnce(true);
        mockSyncRpcClient.upsertProject.mockResolvedValueOnce({
          status: 'unauthorized',
          reason: 'supabase_client_unavailable',
          raw: {},
        });

        const result = await (service as unknown as {
          pushProjectWithResult: (project: Project, fromRetryQueue?: boolean, sourceUserId?: string, taskIdsToDelete?: string[], taskDeleteBaseUpdatedAtMap?: unknown, operationId?: string) => Promise<{ success: boolean; conflict?: boolean; remoteData?: Project; retryEnqueued?: boolean; failureReason?: string; terminal?: boolean }>;
        }).pushProjectWithResult(project, false, 'test-user-id', undefined, undefined, operationId);

        expect(result).toEqual(expect.objectContaining({
          success: false,
          retryEnqueued: true,
          failureReason: 'project sync queued for retry',
        }));
        expect(result.terminal).toBeUndefined();
        expect(mockRetryQueueService.addDurably).toHaveBeenCalled();
        expect(service.state().syncError).toBeNull();
      });

      it('pushProjectWithResult 在会话刷新后遇到可重试网络错误时应写入 RetryQueue', async () => {
        const operationId = 'op-project-rpc-refresh-network-retry';
        const project = createMockProject({
          id: 'project-rpc-refresh-network-retry',
          updatedAt: '2026-04-30T05:12:00.000Z',
        });
        mockClient.auth.getSession = vi.fn()
          .mockRejectedValueOnce(new Error('JWT expired'))
          .mockResolvedValueOnce({
            data: { session: { user: { id: 'test-user-id' } } },
          });
        mockSessionManager.isSessionExpiredError.mockImplementation(
          (error: unknown) => error instanceof Error && error.message === 'JWT expired',
        );
        mockSessionManager.handleAuthErrorWithRefresh.mockResolvedValueOnce(true);
        mockSyncRpcClient.upsertProject.mockRejectedValueOnce(new Error('Failed to fetch'));

        const result = await (service as unknown as {
          pushProjectWithResult: (project: Project, fromRetryQueue?: boolean, sourceUserId?: string, taskIdsToDelete?: string[], taskDeleteBaseUpdatedAtMap?: unknown, operationId?: string) => Promise<{ success: boolean; conflict?: boolean; remoteData?: Project; retryEnqueued?: boolean; failureReason?: string; terminal?: boolean }>;
        }).pushProjectWithResult(project, false, 'test-user-id', undefined, undefined, operationId);

        expect(result).toEqual(expect.objectContaining({
          success: false,
          retryEnqueued: true,
        }));
        expect(result.terminal).toBeUndefined();
        expect(result.failureReason).toContain('Failed to fetch');
        expect(mockRetryQueueService.addDurably).toHaveBeenCalledWith(
          'project',
          'upsert',
          project,
          undefined,
          'test-user-id',
          undefined,
          undefined,
          undefined,
          operationId,
        );
      });

      it('pushProjectWithResult 在会话刷新后遇到写入 timeout 时应持久化远端结果未知标记', async () => {
        const operationId = 'op-project-rpc-refresh-timeout';
        const project = createMockProject({
          id: 'project-rpc-refresh-timeout-unknown-outcome',
          updatedAt: '2026-04-30T05:13:00.000Z',
        });
        const timeoutError = new Error('请求超时 (30000ms): push-project:project-rpc-refresh-timeout-unknown-outcome');
        timeoutError.name = 'TimeoutError';
        mockClient.auth.getSession = vi.fn()
          .mockRejectedValueOnce(new Error('JWT expired'))
          .mockResolvedValueOnce({
            data: { session: { user: { id: 'test-user-id' } } },
          });
        mockSessionManager.isSessionExpiredError.mockImplementation(
          (error: unknown) => error instanceof Error && error.message === 'JWT expired',
        );
        mockSessionManager.handleAuthErrorWithRefresh.mockResolvedValueOnce(true);
        mockSyncRpcClient.upsertProject.mockRejectedValueOnce(timeoutError);

        const result = await (service as unknown as {
          pushProjectWithResult: (project: Project, fromRetryQueue?: boolean, sourceUserId?: string, taskIdsToDelete?: string[], taskDeleteBaseUpdatedAtMap?: unknown, operationId?: string) => Promise<{ success: boolean; conflict?: boolean; remoteData?: Project; retryEnqueued?: boolean; failureReason?: string; terminal?: boolean }>;
        }).pushProjectWithResult(project, false, 'test-user-id', undefined, undefined, operationId);

        expect(result).toEqual(expect.objectContaining({
          success: false,
          retryEnqueued: true,
        }));
        expect(result.terminal).toBeUndefined();
        expect(mockRetryQueueService.addDurably).toHaveBeenCalledWith(
          'project',
          'upsert',
          project,
          undefined,
          'test-user-id',
          undefined,
          undefined,
          undefined,
          operationId,
          expect.objectContaining({
            errorType: 'TimeoutError',
            message: timeoutError.message,
            remoteOutcome: 'unknown',
          }),
        );
      });

      it('pushProjectWithResult 应将真实 unauthorized project RPC 结果标记为 terminal', async () => {
        const operationId = 'op-project-rpc-unauthorized-terminal';
        const project = createMockProject({
          id: 'project-rpc-unauthorized-terminal',
          updatedAt: '2026-04-30T05:20:00.000Z',
        });
        mockSyncRpcClient.upsertProject.mockResolvedValueOnce({
          status: 'unauthorized',
          reason: 'jwt_invalid',
          raw: {},
        });

        const result = await (service as unknown as {
          pushProjectWithResult: (project: Project, fromRetryQueue?: boolean, sourceUserId?: string, taskIdsToDelete?: string[], taskDeleteBaseUpdatedAtMap?: unknown, operationId?: string) => Promise<{ success: boolean; conflict?: boolean; remoteData?: Project; retryEnqueued?: boolean; failureReason?: string; terminal?: boolean }>;
        }).pushProjectWithResult(project, false, 'test-user-id', undefined, undefined, operationId);

        expect(result).toEqual({
          success: false,
          retryEnqueued: false,
          failureReason: '项目同步权限校验失败，请重新登录后重试',
          terminal: true,
        });
        expect(mockRetryQueueService.addDurably).not.toHaveBeenCalled();
        expect(service.state().syncError).toBe('项目同步权限校验失败，请重新登录后重试');
      });
    });
}
