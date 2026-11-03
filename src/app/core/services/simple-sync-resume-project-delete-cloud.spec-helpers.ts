import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SimpleSyncService } from './simple-sync.service';
import type { SimpleSyncResumeProjectDeleteSpecContext } from './simple-sync-resume-project-delete.spec-helpers';
import { DataSafetyAuditPersistence } from '../../../services/data-safety-audit-persistence';

export function registerSimpleSyncStartupSnapshotAndProjectDeleteSpecs(
  context: SimpleSyncResumeProjectDeleteSpecContext,
): void {
  let service: SimpleSyncService;
  let mockSupabase: any;
  let mockSessionManager: any;
  let mockClient: any;
  let mockSyncRpcClient: any;
  let mockProjectStore: any;

  function loadContext(): void {
    service = context.service();
    mockSupabase = context.mockSupabase();
    mockSessionManager = context.mockSessionManager();
    mockClient = context.mockClient();
    mockSyncRpcClient = context.mockSyncRpcClient();
    mockProjectStore = typeof context.mockProjectStore === 'function'
      ? context.mockProjectStore()
      : { getProject: vi.fn(() => undefined) };
    mockProjectStore.getProject.mockReturnValue({
      id: 'project-1',
      updatedAt: '2026-07-14T00:00:00.000Z',
    });
    new DataSafetyAuditPersistence().save('user-1', { replayLog: [], lastWriteExplain: null });
  }

  describe('startup snapshot', () => {
    beforeEach(loadContext);
    it('SimpleSync 应转发新的 startup snapshot 元数据 API', async () => {
      const snapshot = await (service as unknown as {
        loadStartupOfflineSnapshot: () => Promise<{
          source: 'idb' | 'localStorage' | 'none';
          projectCount: number;
          bytes: number;
          migratedLegacy: boolean;
          projects: unknown[];
        }>;
      }).loadStartupOfflineSnapshot();

      expect(snapshot).toEqual({
        source: 'none',
        projectCount: 0,
        bytes: 0,
        migratedLegacy: false,
        projects: [],
      });
    });
  });

  // ==================== P0 修复：Session Refresh 自动恢复 ====================
  // 【技术债务重构】此测试组测试 pushProject 的错误处理逻辑
  // 需要根据新架构重新设计
  describe('项目软删除', () => {
    beforeEach(loadContext);
    it('deleteProjectFromCloud 缺少 operationId 时不应执行远端删除', async () => {
      mockSupabase.isConfigured = true;
      mockSupabase.clientAsync.mockResolvedValue(mockClient);
      mockClient.auth.getSession = vi.fn().mockResolvedValue({
        data: { session: { user: { id: 'user-1' } } },
      });
      mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
      mockSyncRpcClient.isClientRejected.mockReturnValue(false);
      mockSyncRpcClient.deleteProject.mockResolvedValueOnce({
        status: 'applied',
        entityId: 'project-missing-operation-id',
        serverUpdatedAt: '2026-06-29T00:00:00.000Z',
        raw: {},
      });
      mockClient.rpc = vi.fn().mockResolvedValue({ data: true, error: null });

      const result = await service.deleteProjectFromCloud('project-missing-operation-id', 'user-1');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SYNC_OFFLINE');
        expect(result.error.details?.['reason']).toBe('missing-operation-id');
        expect(result.error.details?.['retryable']).toBe(true);
      }
      expect(mockSyncRpcClient.deleteProject).not.toHaveBeenCalled();
      expect(mockClient.rpc).not.toHaveBeenCalledWith('soft_delete_project', expect.anything());
    });

    it('deleteProjectFromCloud 带 operationId 且 sync RPC 不可用时应保留重试且不调用旧删除 RPC', async () => {
      mockSupabase.isConfigured = true;
      mockSupabase.clientAsync.mockResolvedValue(mockClient);
      mockClient.auth.getSession = vi.fn().mockResolvedValue({
        data: { session: { user: { id: 'user-1' } } },
      });
      mockSyncRpcClient.isFeatureEnabled.mockReturnValue(false);
      mockSyncRpcClient.isClientRejected.mockReturnValue(false);
      mockSyncRpcClient.checkProtocol.mockResolvedValueOnce({ minProtocolVersion: 3, deploymentEpoch: 0 });

      mockClient.rpc = vi.fn().mockResolvedValue({ data: true, error: null });

      const result = await service.deleteProjectFromCloud('project-1', 'user-1', 'op-project-soft-delete-replay');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SYNC_OFFLINE');
        expect(result.error.details?.['reason']).toBe('sync-rpc-unavailable');
        expect(result.error.details?.['retryable']).toBe(true);
      }
      expect(mockSyncRpcClient.deleteProject).not.toHaveBeenCalled();
      expect(mockClient.rpc).not.toHaveBeenCalledWith('soft_delete_project', expect.anything());
    });

    it('deleteProjectFromCloud 缺少删除基线时应拒绝 RPC，避免刷新后无条件覆盖远端项目', async () => {
      mockSupabase.isConfigured = true;
      mockSupabase.clientAsync.mockResolvedValue(mockClient);
      mockClient.auth.getSession = vi.fn().mockResolvedValue({
        data: { session: { user: { id: 'user-1' } } },
      });
      mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
      mockSyncRpcClient.isClientRejected.mockReturnValue(false);
      mockProjectStore.getProject.mockReturnValueOnce(undefined);
      mockClient.rpc = vi.fn().mockResolvedValue({ data: true, error: null });

      const result = await service.deleteProjectFromCloud('project-1', 'user-1', 'op-project-sync-delete-replay');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SYNC_CONFLICT');
        expect(result.error.details).toEqual(expect.objectContaining({
          projectId: 'project-1',
          retryable: false,
          reason: 'missing_base_updated_at',
        }));
      }
      expect(mockSyncRpcClient.deleteProject).not.toHaveBeenCalled();
      expect(mockClient.rpc).not.toHaveBeenCalledWith('soft_delete_project', expect.anything());
    });

    it('deleteProjectFromCloud 应使用持久化队列传入的删除基线，不依赖已被本地移除的项目快照', async () => {
      mockSupabase.isConfigured = true;
      mockSupabase.clientAsync.mockResolvedValue(mockClient);
      mockClient.auth.getSession = vi.fn().mockResolvedValue({
        data: { session: { user: { id: 'user-1' } } },
      });
      mockProjectStore.getProject.mockReturnValueOnce(undefined);
      mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
      mockSyncRpcClient.isClientRejected.mockReturnValue(false);
      mockSyncRpcClient.deleteProject.mockResolvedValueOnce({
        status: 'applied',
        entityId: 'project-durable-delete-baseline',
        serverUpdatedAt: '2026-07-14T01:10:00.000Z',
        raw: {},
      });

      const result = await service.deleteProjectFromCloud(
        'project-durable-delete-baseline',
        'user-1',
        'op-project-durable-delete-baseline',
        '2026-07-14T01:00:00.000Z',
      );

      expect(result.ok).toBe(true);
      expect(mockSyncRpcClient.deleteProject).toHaveBeenCalledWith({
        operationId: 'op-project-durable-delete-baseline',
        projectId: 'project-durable-delete-baseline',
        baseUpdatedAt: '2026-07-14T01:00:00.000Z',
      });
    });

    it('deleteProjectFromCloud 应优先使用调用方传入的 operationId', async () => {
      mockSupabase.isConfigured = true;
      mockSupabase.clientAsync.mockResolvedValue(mockClient);
      mockClient.auth.getSession = vi.fn().mockResolvedValue({
        data: { session: { user: { id: 'user-1' } } },
      });
      mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
      mockSyncRpcClient.isClientRejected.mockReturnValue(false);
      mockSyncRpcClient.deleteProject.mockResolvedValueOnce({
        status: 'applied',
        entityId: 'project-1',
        serverUpdatedAt: '2026-06-13T00:00:00.000Z',
        raw: {},
      });

      const result = await service.deleteProjectFromCloud('project-1', 'user-1', 'queued-project-delete-op-1');

      expect(result.ok).toBe(true);
      expect(mockSyncRpcClient.deleteProject).toHaveBeenCalledWith(expect.objectContaining({
        operationId: 'queued-project-delete-op-1',
      }));
    });

    it('deleteProjectFromCloud sync RPC 成功后应持久化删除写入解释和 replay entry', async () => {
      mockSupabase.isConfigured = true;
      mockSupabase.clientAsync.mockResolvedValue(mockClient);
      mockClient.auth.getSession = vi.fn().mockResolvedValue({
        data: { session: { user: { id: 'user-1' } } },
      });
      mockProjectStore.getProject.mockReturnValueOnce({
        id: 'project-delete-audit',
        updatedAt: '2026-06-15T04:30:00.000Z',
      });
      mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
      mockSyncRpcClient.isClientRejected.mockReturnValue(false);
      mockSyncRpcClient.deleteProject.mockResolvedValueOnce({
        status: 'applied',
        entityId: 'project-delete-audit',
        serverUpdatedAt: '2026-06-15T05:00:00.000Z',
        raw: {},
      });

      const result = await service.deleteProjectFromCloud(
        'project-delete-audit',
        'user-1',
        'op-project-delete-audit',
      );

      expect(result.ok).toBe(true);
      const audit = new DataSafetyAuditPersistence().load('user-1');
      expect(audit.lastWriteExplain).toMatchObject({
        operationId: 'op-project-delete-audit',
        actor: { sourceUserId: 'user-1' },
        entity: { type: 'project', id: 'project-delete-audit' },
        operation: 'delete',
        updatedAtBaseline: '2026-06-15T04:30:00.000Z',
        beforeVersion: '2026-06-15T04:30:00.000Z',
        afterVersion: '2026-06-15T05:00:00.000Z',
        queueResult: { enteredRetryQueue: false, retryCount: 0 },
        rpcResult: { status: 'applied', serverUpdatedAt: '2026-06-15T05:00:00.000Z' },
        lwwDecision: { decision: 'local-applied', reason: 'applied' },
        lastSyncTime: { before: null, after: null, advanced: false },
      });
      expect(audit.replayLog[0]).toMatchObject({
        operationId: 'op-project-delete-audit',
        entityType: 'project',
        entityId: 'project-delete-audit',
        operation: 'delete',
        baseUpdatedAt: '2026-06-15T04:30:00.000Z',
        queue: { enteredRetryQueue: false, retryCount: 0 },
        rpc: { status: 'applied', serverUpdatedAt: '2026-06-15T05:00:00.000Z' },
        lww: { decision: 'local-applied', reason: 'applied' },
      });
    });

    it('deleteProjectFromCloud sync RPC 遇到 remote-newer 时应持久化 LWW 覆盖解释', async () => {
      mockSupabase.isConfigured = true;
      mockSupabase.clientAsync.mockResolvedValue(mockClient);
      mockClient.auth.getSession = vi.fn().mockResolvedValue({
        data: { session: { user: { id: 'user-1' } } },
      });
      mockProjectStore.getProject.mockReturnValueOnce({
        id: 'project-delete-remote-newer-audit',
        updatedAt: '2026-06-15T04:30:00.000Z',
      });
      mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
      mockSyncRpcClient.isClientRejected.mockReturnValue(false);
      mockSyncRpcClient.deleteProject.mockResolvedValueOnce({
        status: 'remote-newer',
        entityId: 'project-delete-remote-newer-audit',
        remoteUpdatedAt: '2026-06-15T05:00:00.000Z',
        reason: 'cas_mismatch',
        raw: {},
      });

      const result = await service.deleteProjectFromCloud(
        'project-delete-remote-newer-audit',
        'user-1',
        'op-project-delete-remote-newer-audit',
      );

      expect(result.ok).toBe(false);
      const audit = new DataSafetyAuditPersistence().load('user-1');
      expect(audit.lastWriteExplain).toMatchObject({
        operationId: 'op-project-delete-remote-newer-audit',
        actor: { sourceUserId: 'user-1' },
        entity: { type: 'project', id: 'project-delete-remote-newer-audit' },
        operation: 'delete',
        updatedAtBaseline: '2026-06-15T04:30:00.000Z',
        beforeVersion: '2026-06-15T04:30:00.000Z',
        afterVersion: '2026-06-15T05:00:00.000Z',
        queueResult: { enteredRetryQueue: false, retryCount: 0 },
        rpcResult: {
          status: 'remote-newer',
          remoteUpdatedAt: '2026-06-15T05:00:00.000Z',
          reason: 'cas_mismatch',
        },
        lwwDecision: { decision: 'remote-kept', reason: 'remote-newer' },
        lastSyncTime: { before: null, after: null, advanced: false },
      });
      expect(audit.replayLog[0]).toMatchObject({
        operationId: 'op-project-delete-remote-newer-audit',
        entityType: 'project',
        entityId: 'project-delete-remote-newer-audit',
        operation: 'delete',
        baseUpdatedAt: '2026-06-15T04:30:00.000Z',
        queue: { enteredRetryQueue: false, retryCount: 0 },
        rpc: { status: 'remote-newer', remoteUpdatedAt: '2026-06-15T05:00:00.000Z' },
        lww: { decision: 'remote-kept', reason: 'remote-newer' },
      });
    });

    it('deleteProjectFromCloud 在 feature 默认关闭但 probe 拒绝客户端时不应回退 soft_delete_project', async () => {
      mockSupabase.isConfigured = true;
      mockSupabase.clientAsync.mockResolvedValue(mockClient);
      mockClient.auth.getSession = vi.fn().mockResolvedValue({
        data: { session: { user: { id: 'user-1' } } },
      });
      mockSyncRpcClient.isFeatureEnabled.mockReturnValue(false);
      mockSyncRpcClient.isClientRejected.mockReturnValue(false);
      mockSyncRpcClient.checkProtocol.mockImplementationOnce(async () => {
        mockSyncRpcClient.isClientRejected.mockReturnValue(true);
        return { minProtocolVersion: 3, deploymentEpoch: 0 };
      });
      mockClient.rpc = vi.fn().mockResolvedValue({ data: true, error: null });

      const result = await service.deleteProjectFromCloud('project-1', 'user-1', 'op-project-delete-client-rejected');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.details?.retryable).toBe(false);
      }
      expect(service.state().syncError).toBe('当前客户端同步协议已过期，请刷新后重试');
      expect(mockSyncRpcClient.deleteProject).not.toHaveBeenCalled();
      expect(mockClient.rpc).not.toHaveBeenCalledWith('soft_delete_project', expect.anything());
    });

    it('deleteProjectFromCloud 应将已软删项目视为幂等成功', async () => {
      mockSupabase.isConfigured = true;
      mockSupabase.clientAsync.mockResolvedValue(mockClient);
      mockClient.auth.getSession = vi.fn().mockResolvedValue({
        data: { session: { user: { id: 'user-1' } } },
      });
      mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
      mockSyncRpcClient.isClientRejected.mockReturnValue(false);
      mockSyncRpcClient.deleteProject.mockResolvedValueOnce({
        status: 'idempotent-replay',
        entityId: 'project-1',
        serverUpdatedAt: '2026-06-29T00:00:00.000Z',
        raw: {},
      });
      mockClient.rpc = vi.fn().mockResolvedValue({ data: true, error: null });

      const result = await service.deleteProjectFromCloud('project-1', 'user-1', 'op-project-delete-idempotent');

      expect(result.ok).toBe(true);
      expect(mockSyncRpcClient.deleteProject).toHaveBeenCalledWith(expect.objectContaining({
        operationId: 'op-project-delete-idempotent',
        projectId: 'project-1',
      }));
      expect(mockClient.rpc).not.toHaveBeenCalledWith('soft_delete_project', expect.anything());
    });

    it('deleteProjectFromCloud 应在认证过期后刷新会话并重试一次', async () => {
      mockSupabase.isConfigured = true;
      mockSupabase.clientAsync.mockResolvedValue(mockClient);
      mockSessionManager.isSessionExpiredError.mockReturnValue(true);
      mockSessionManager.handleAuthErrorWithRefresh.mockResolvedValueOnce(true);
      mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
      mockSyncRpcClient.isClientRejected.mockReturnValue(false);
      mockSyncRpcClient.deleteProject
        .mockRejectedValueOnce({ code: '42501', message: 'RLS Policy Violation', name: 'AuthError' })
        .mockResolvedValueOnce({
          status: 'applied',
          entityId: 'project-1',
          serverUpdatedAt: '2026-06-29T00:01:00.000Z',
          raw: {},
        });

      mockClient.rpc = vi.fn().mockResolvedValue({ data: true, error: null });
      mockClient.auth.getSession = vi.fn().mockResolvedValue({
        data: { session: { user: { id: 'user-1' } } },
      });

      const result = await service.deleteProjectFromCloud('project-1', 'user-1', 'op-project-delete-auth-refresh');

      expect(result.ok).toBe(true);
      expect(mockSessionManager.handleAuthErrorWithRefresh).toHaveBeenCalledWith(
        'deleteProjectFromCloud',
        expect.objectContaining({ projectId: 'project-1', userId: 'user-1', errorCode: '42501' }),
      );
      expect(mockSyncRpcClient.deleteProject).toHaveBeenCalledTimes(2);
      expect(mockClient.rpc).not.toHaveBeenCalledWith('soft_delete_project', expect.anything());
    });

    it('deleteProjectFromCloud 应在恢复窗口内将 session 刷新失败视为可重试离线', async () => {
      mockSupabase.isConfigured = true;
      mockSupabase.clientAsync.mockResolvedValue(mockClient);
      mockClient.auth.getSession = vi.fn().mockResolvedValue({
        data: { session: null },
      });
      mockSessionManager.tryRefreshSession.mockImplementationOnce(async () => {
        Object.defineProperty(document, 'visibilityState', {
          configurable: true,
          value: 'hidden',
        });
        return false;
      });

      const result = await service.deleteProjectFromCloud('project-1', 'user-1', 'op-project-delete-browser-suspended');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SYNC_OFFLINE');
        expect(result.error.details?.['reason']).toBe('browser-network-suspended');
        expect(result.error.details?.['retryable']).toBe(true);
      }

      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: 'visible',
      });
    });
  });
}
