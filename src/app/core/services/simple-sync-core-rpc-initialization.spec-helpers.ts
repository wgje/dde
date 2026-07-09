import {
  beforeEach,
  describe,
  expect,
  it,
  createMockProject,
  expectDeferredCallback,
} from './simple-sync.service.spec-context';
import type { BlackBoxEntry } from './simple-sync.service.spec-context';
import type { SimpleSyncCoreRpcSpecContext } from './simple-sync-core-rpc.spec-helpers';

export function registerSimpleSyncCoreRpcInitializationSpecs(
  context: SimpleSyncCoreRpcSpecContext,
): void {
  let service: any;
  let windowAddEventListenerSpy: any;
  let windowRemoveEventListenerSpy: any;
  let mockSupabase: any;
  let mockClient: any;
  let mockProjectData: any;
  let mockBlackBoxSync: any;
  let mockSessionManager: any;
  let mockRetryQueueService: any;
  let mockRealtimePolling: any;

  beforeEach(() => {
    service = context.service();
    windowAddEventListenerSpy = context.windowAddEventListenerSpy();
    windowRemoveEventListenerSpy = context.windowRemoveEventListenerSpy();
    mockSupabase = context.mockSupabase();
    mockClient = context.mockClient();
    mockProjectData = context.mockProjectData();
    mockBlackBoxSync = context.mockBlackBoxSync();
    mockSessionManager = context.mockSessionManager();
    mockRetryQueueService = context.mockRetryQueueService();
    mockRealtimePolling = context.mockRealtimePolling();
  });

  describe('初始化', () => {
    it('应该正确初始化状态', () => {
      expect(service.state().isSyncing).toBe(false);
      expect(service.state().pendingCount).toBe(0);
      expect(service.state().lastSyncTime).toBeNull();
    });

    it('黑匣子重试入队应保留条目 owner，避免 auth 恢复窗口写入变成无主 legacy 项', async () => {
      const handler = expectDeferredCallback(
        mockBlackBoxSync.setRetryQueueHandler.mock.calls[0]?.[0],
        'blackBox retry handler',
      );
      const entry = {
        id: crypto.randomUUID(),
        projectId: null,
        userId: 'user-1',
        content: 'entry',
        date: '2026-03-04',
        createdAt: '2026-03-04T00:00:00.000Z',
        updatedAt: '2026-03-04T00:00:00.000Z',
        isRead: false,
        isCompleted: false,
        isArchived: false,
        deletedAt: null,
        syncStatus: 'pending' as const,
      };

      await handler(entry);

      expect(mockRetryQueueService.addDurably).toHaveBeenCalledWith(
        'blackbox',
        'upsert',
        entry,
        undefined,
        'user-1',
        undefined,
        undefined,
        undefined,
        undefined,
      );
    });

    it('黑匣子重试 owner mismatch 应先修复本地 pending 再移除队列项', async () => {
      const retryHandlers = mockRetryQueueService.setOperationHandler.mock.calls[0]?.[0] as {
        pushBlackBoxEntry: (entry: BlackBoxEntry, sourceUserId?: string) => Promise<boolean>;
      };
      const entry = {
        id: crypto.randomUUID(),
        projectId: null,
        userId: 'user-1',
        content: 'entry',
        date: '2026-03-04',
        createdAt: '2026-03-04T00:00:00.000Z',
        updatedAt: '2026-03-04T00:00:00.000Z',
        isRead: false,
        isCompleted: false,
        isArchived: false,
        deletedAt: null,
        syncStatus: 'pending' as const,
      } as BlackBoxEntry;

      await expect(retryHandlers.pushBlackBoxEntry(entry, 'other-user')).resolves.toBe(true);

      expect(mockBlackBoxSync.pushToServer).not.toHaveBeenCalled();
      expect(mockBlackBoxSync.markEntrySyncConflict).toHaveBeenCalledWith(entry);
    });

    it('应该初始化网络状态为在线', () => {
      expect(service.state().isOnline).toBe(true);
    });

    it('便捷 computed 属性应该正常工作', () => {
      expect(service.isOnline()).toBe(true);
      expect(service.isSyncing()).toBe(false);
      expect(service.hasConflict()).toBe(false);
    });

    it('构造阶段不应启动 retry loop 或注册网络监听', () => {
      expect(mockRetryQueueService.startLoop).not.toHaveBeenCalled();
      expect(windowAddEventListenerSpy).not.toHaveBeenCalledWith('online', expect.any(Function));
      expect(windowAddEventListenerSpy).not.toHaveBeenCalledWith('offline', expect.any(Function));
    });

    it('startRuntime/stopRuntime 应显式控制 loop 与网络监听', () => {
      const runtimeService = service as {
        startRuntime: () => void;
        stopRuntime: () => void;
      };

      runtimeService.startRuntime();
      expect(mockRetryQueueService.startLoop).toHaveBeenCalledTimes(1);
      expect(mockRealtimePolling.initializeRuntime).toHaveBeenCalledTimes(1);
      expect(windowAddEventListenerSpy).toHaveBeenCalledWith('online', expect.any(Function));
      expect(windowAddEventListenerSpy).toHaveBeenCalledWith('offline', expect.any(Function));

      runtimeService.stopRuntime();
      expect(mockRetryQueueService.stopLoop).toHaveBeenCalledTimes(1);
      expect(mockRealtimePolling.teardownRuntime).toHaveBeenCalledTimes(1);
      expect(windowRemoveEventListenerSpy).toHaveBeenCalledWith('online', expect.any(Function));
      expect(windowRemoveEventListenerSpy).toHaveBeenCalledWith('offline', expect.any(Function));
    });

    it('saveOfflineSnapshot 应透传 ownerUserId 到 ProjectDataService', () => {
      const projects = [createMockProject({ id: 'project-owner-pass-through' })];

      service.saveOfflineSnapshot(projects, 'target-user');

      expect(mockProjectData.saveOfflineSnapshot).toHaveBeenCalledWith(projects, 'target-user');
    });

    it('saveOfflineSnapshotAndWait 应透传 ownerUserId 到 ProjectDataService', async () => {
      const projects = [createMockProject({ id: 'project-owner-pass-through-await' })];

      await service.saveOfflineSnapshotAndWait(projects, 'target-user');

      expect(mockProjectData.saveOfflineSnapshotAndWait)
        .toHaveBeenCalledWith(projects, 'target-user');
    });

    it('loadFullProjectOptimized 应透传 expectedUserId 到 ProjectDataService', async () => {
      await service.loadFullProjectOptimized('project-owner-pass-through-optimized', 'target-user');

      expect(mockProjectData.loadFullProjectOptimized)
        .toHaveBeenCalledWith('project-owner-pass-through-optimized', 'target-user');
    });

    it('loadSingleProject 应透传 userId 到 ProjectDataService', async () => {
      await service.loadSingleProject('project-owner-pass-through-single', 'target-user');

      expect(mockProjectData.loadFullProject)
        .toHaveBeenCalledWith('project-owner-pass-through-single', 'target-user');
    });

    it('pullProjects 应把旧门面契约委托给 ProjectDataService', async () => {
      mockSupabase.isConfigured = true;
      mockSupabase.clientAsync.mockResolvedValue(mockClient);
      mockSessionManager.getRecentValidationSnapshot.mockReturnValueOnce({
        valid: true,
        userId: 'user-1',
        at: Date.now(),
      });
      mockProjectData.pullProjects.mockImplementationOnce(async (
        since: string | undefined,
        dependencies: {
          getClient: () => Promise<unknown>;
          getRecentValidatedUserId: () => string | undefined;
          rowToProject: (row: Record<string, unknown>) => { id: string };
        },
      ) => {
        expect(since).toBe('2026-06-01T00:00:00.000Z');
        await expect(dependencies.getClient()).resolves.toBe(mockClient);
        expect(dependencies.getRecentValidatedUserId()).toBe('user-1');
        return [dependencies.rowToProject({
          id: 'project-1',
          title: 'Project 1',
          description: '',
          created_date: '2026-06-09T00:00:00.000Z',
          updated_at: '2026-06-09T00:00:00.000Z',
          version: 1,
        })];
      });

      const projects = await service.pullProjects('2026-06-01T00:00:00.000Z');

      expect(projects).toHaveLength(1);
      expect(projects[0].id).toBe('project-1');
      expect(mockProjectData.pullProjects).toHaveBeenCalledOnce();
    });
  });
}
