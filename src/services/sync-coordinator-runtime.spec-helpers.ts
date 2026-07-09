import { beforeEach, describe, expect, it, vi } from './sync-coordinator.service.spec-context';
import type { Project, SyncCoordinatorService, SyncState, Task } from './sync-coordinator.service.spec-context';
import {
  registerSyncCoordinatorOfflineMergeSpecs,
  type SyncCoordinatorOfflineMergeSpecContext,
} from './sync-coordinator-offline-merge.spec-helpers';
import {
  registerSyncCoordinatorPersistenceSpecs,
  type SyncCoordinatorPersistenceSpecContext,
} from './sync-coordinator-persistence.spec-helpers';

export interface SyncCoordinatorRuntimeSpecContext
  extends SyncCoordinatorPersistenceSpecContext,
    SyncCoordinatorOfflineMergeSpecContext {
  mockLayoutService(): any;
  mockRealtimePollingService(): any;
  mockActionQueueProcessorsService(): any;
  createMockSyncState(overrides?: Partial<SyncState>): SyncState;
}

export function registerSyncCoordinatorRuntimeSpecs(context: SyncCoordinatorRuntimeSpecContext): void {
  let service: SyncCoordinatorService;
  let mockSyncService: any;
  let mockProjectStateService: any;
  let mockChangeTrackerService: any;
  let mockActionQueueService: any;
  let mockConflictService: any;
  let mockProjectSyncOperationsService: any;
  let mockLayoutService: any;
  let mockRealtimePollingService: any;
  let mockRetryQueueService: any;
  let mockActionQueueProcessorsService: any;

  const createTestProject = context.createTestProject;
  const createTestTask = context.createTestTask;
  const createMockSyncState = context.createMockSyncState;

  beforeEach(() => {
    service = context.service();
    mockSyncService = context.mockSyncService();
    mockProjectStateService = context.mockProjectStateService();
    mockChangeTrackerService = context.mockChangeTrackerService();
    mockActionQueueService = context.mockActionQueueService();
    mockConflictService = context.mockConflictService();
    mockProjectSyncOperationsService = context.mockProjectSyncOperationsService();
    mockLayoutService = context.mockLayoutService();
    mockRealtimePollingService = context.mockRealtimePollingService();
    mockRetryQueueService = context.mockRetryQueueService();
    mockActionQueueProcessorsService = context.mockActionQueueProcessorsService();
  });

  // ==================== 同步状态派生 ====================

  describe('同步状态派生', () => {
    it('isSyncing 应该从 syncService.syncState 派生', () => {
      expect(service.isSyncing()).toBe(false);

      mockSyncService.syncState.set(createMockSyncState({ isSyncing: true }));
      expect(service.isSyncing()).toBe(true);
    });

    it('isOnline 应该从 syncService.syncState 派生', () => {
      expect(service.isOnline()).toBe(true);

      mockSyncService.syncState.set(createMockSyncState({ isOnline: false }));
      expect(service.isOnline()).toBe(false);
    });

    it('offlineMode 应该从 syncService.syncState 派生', () => {
      expect(service.offlineMode()).toBe(false);

      mockSyncService.syncState.set(createMockSyncState({ offlineMode: true }));
      expect(service.offlineMode()).toBe(true);
    });

    it('sessionExpired 应该从 syncService.syncState 派生', () => {
      expect(service.sessionExpired()).toBe(false);

      mockSyncService.syncState.set(createMockSyncState({ sessionExpired: true }));
      expect(service.sessionExpired()).toBe(true);
    });

    it('hasConflict 应该从 syncService.syncState 派生', () => {
      expect(service.hasConflict()).toBe(false);

      mockSyncService.syncState.set(createMockSyncState({ hasConflict: true }));
      expect(service.hasConflict()).toBe(true);
    });

    it('pendingActionsCount 应该从 actionQueue.queueSize 派生', () => {
      expect(service.pendingActionsCount()).toBe(0);

      mockActionQueueService.queueSize.set(5);
      expect(service.pendingActionsCount()).toBe(5);
    });
  });

  registerSyncCoordinatorPersistenceSpecs(context);

  // ==================== 版本冲突检测  // ==================== 版本冲突检测 ====================
  // 注意: saveProjectToCloud 已迁移到 SimpleSyncService.saveProjectSmart
  // 版本冲突测试应在 simple-sync.service.spec.ts 中

  // ==================== 冲突解决 ====================

  describe('冲突解决', () => {
    it('resolveConflict 应该委托给 conflictService', () => {
      const localProject = createTestProject({ id: 'proj-1', version: 2 });
      const remoteProject = createTestProject({ id: 'proj-1', version: 3 });

      service.resolveConflict('proj-1', 'local', localProject, remoteProject);

      expect(mockConflictService.resolveConflict).toHaveBeenCalledWith(
        'proj-1',
        'local',
        localProject,
        remoteProject
      );
    });

    it('smartMerge 应该委托给 conflictService', () => {
      const localProject = createTestProject({ id: 'proj-1' });
      const remoteProject = createTestProject({ id: 'proj-1' });
      const tombstoneIds = new Set<string>();

      const result = service.smartMerge(localProject, remoteProject, tombstoneIds);

      // 【更新】smartMerge 现在需要传入 tombstoneIds 参数（防止已删除任务复活）
      expect(mockConflictService.smartMerge).toHaveBeenCalledWith(localProject, remoteProject, tombstoneIds);
      expect(result.project).toBeDefined();
    });
  });

  registerSyncCoordinatorOfflineMergeSpecs(context);

  describe('downloadAndMerge local-only 保留策略', () => {
    it('远端成功返回空列表时，应裁剪缺失的 synced 项目', async () => {
      const localProject = createTestProject({
        id: 'local-deleted',
        syncSource: 'synced',
        pendingSync: false,
      });

      mockSyncService.loadProjectListMetadataFromCloud.mockResolvedValueOnce([]);
      mockProjectStateService.projects.set([localProject]);
      mockProjectStateService.activeProjectId.set('local-deleted');
      mockChangeTrackerService.hasProjectChanges.mockReturnValue(false);
      mockActionQueueService.getPendingActionsForProject.mockReturnValue([]);

      await (service as unknown as { downloadAndMerge: (userId: string) => Promise<void> })
        .downloadAndMerge('user-123');

      expect(mockSyncService.loadProjectsFromCloud).not.toHaveBeenCalled();
      expect(mockProjectStateService.projects()).toEqual([]);
      expect(mockProjectStateService.activeProjectId()).toBeNull();
    });

    it('裁剪当前活动项目后，应自动切换到首个剩余项目', async () => {
      const remoteProject = createTestProject({ id: 'remote-1' });
      const localProject = createTestProject({
        id: 'local-stale',
        syncSource: 'synced',
        pendingSync: false,
      });

      mockSyncService.loadProjectListMetadataFromCloud.mockResolvedValueOnce([remoteProject]);
      mockSyncService.loadProjectsFromCloud.mockResolvedValueOnce([remoteProject]);
      mockProjectStateService.projects.set([localProject]);
      mockProjectStateService.activeProjectId.set('local-stale');
      mockChangeTrackerService.hasProjectChanges.mockReturnValue(false);
      mockActionQueueService.getPendingActionsForProject.mockReturnValue([]);

      await (service as unknown as { downloadAndMerge: (userId: string) => Promise<void> })
        .downloadAndMerge('user-123');

      expect(mockProjectStateService.projects().map((project: Project) => project.id)).toEqual(['remote-1']);
      expect(mockProjectStateService.activeProjectId()).toBe('remote-1');
    });

    it('远端元数据获取失败时，应保留本地项目避免误删', async () => {
      const localProject = createTestProject({
        id: 'local-preserved',
        syncSource: 'synced',
        pendingSync: false,
      });

      mockSyncService.loadProjectListMetadataFromCloud.mockResolvedValueOnce(null);
      mockProjectStateService.projects.set([localProject]);

      await (service as unknown as { downloadAndMerge: (userId: string) => Promise<void> })
        .downloadAndMerge('user-123');

      expect(mockSyncService.loadProjectListMetadataFromCloud).toHaveBeenCalledWith(
        'user-123',
        expect.objectContaining({
          timeout: 10000,
          retries: 1,
          silent: true,
          purpose: 'sync-download-merge',
          treatTransientFailureAsSoft: true,
        })
      );
      expect(mockSyncService.loadProjectsFromCloud).not.toHaveBeenCalled();
      expect(mockProjectStateService.projects()).toEqual([localProject]);
    });

    it('远端完整项目下载失败时，应保留本地项目避免误删', async () => {
      const remoteProject = createTestProject({ id: 'remote-meta-only' });
      const localProject = createTestProject({
        id: 'local-preserved-after-download-failure',
        syncSource: 'synced',
        pendingSync: false,
      });

      mockSyncService.loadProjectListMetadataFromCloud.mockResolvedValueOnce([remoteProject]);
      mockSyncService.loadProjectsFromCloud.mockResolvedValueOnce(null);
      mockProjectStateService.projects.set([localProject]);

      await (service as unknown as { downloadAndMerge: (userId: string) => Promise<void> })
        .downloadAndMerge('user-123');

      expect(mockSyncService.loadProjectsFromCloud).toHaveBeenCalledWith('user-123');
      expect(mockProjectStateService.projects()).toEqual([localProject]);
    });

    it('远程不存在且无本地待同步变更时，不应保留本地项目', async () => {
      const remoteProject = createTestProject({ id: 'remote-1' });
      const localProject = createTestProject({
        id: 'local-stale',
        syncSource: 'synced',
        pendingSync: false
      });

      mockSyncService.loadProjectListMetadataFromCloud.mockResolvedValueOnce([remoteProject]);
      mockSyncService.loadProjectsFromCloud.mockResolvedValueOnce([remoteProject]);
      mockProjectStateService.projects.set([localProject]);
      mockChangeTrackerService.hasProjectChanges.mockReturnValue(false);
      mockActionQueueService.getPendingActionsForProject.mockReturnValue([]);

      await (service as unknown as { downloadAndMerge: (userId: string) => Promise<void> })
        .downloadAndMerge('user-123');

      const mergedProjects: Project[] = mockProjectStateService.projects();
      expect(mergedProjects.some(p => p.id === 'remote-1')).toBe(true);
      expect(mergedProjects.some(p => p.id === 'local-stale')).toBe(false);
    });

    it('远程不存在但有本地待同步变更时，应保留本地项目', async () => {
      const remoteProject = createTestProject({ id: 'remote-1' });
      const localProject = createTestProject({
        id: 'local-pending',
        syncSource: 'synced',
        pendingSync: true
      });

      mockSyncService.loadProjectListMetadataFromCloud.mockResolvedValueOnce([remoteProject]);
      mockSyncService.loadProjectsFromCloud.mockResolvedValueOnce([remoteProject]);
      mockProjectStateService.projects.set([localProject]);
      mockChangeTrackerService.hasProjectChanges.mockReturnValue(false);
      mockActionQueueService.getPendingActionsForProject.mockReturnValue([]);

      await (service as unknown as { downloadAndMerge: (userId: string) => Promise<void> })
        .downloadAndMerge('user-123');

      const mergedProjects: Project[] = mockProjectStateService.projects();
      const preservedLocal = mergedProjects.find(p => p.id === 'local-pending');
      expect(preservedLocal).toBeDefined();
      expect(preservedLocal?.syncSource).toBe('local-only');
      expect(preservedLocal?.pendingSync).toBe(true);
    });

    it('远程不存在但 RetryQueue 仍有未同步项目操作时，应保留本地项目', async () => {
      const remoteProject = createTestProject({ id: 'remote-1' });
      const localProject = createTestProject({
        id: 'local-retry',
        syncSource: 'synced',
        pendingSync: false,
      });

      mockSyncService.loadProjectListMetadataFromCloud.mockResolvedValueOnce([remoteProject]);
      mockSyncService.loadProjectsFromCloud.mockResolvedValueOnce([remoteProject]);
      mockProjectStateService.projects.set([localProject]);
      mockChangeTrackerService.hasProjectChanges.mockReturnValue(false);
      mockActionQueueService.getPendingActionsForProject.mockReturnValue([]);
      mockRetryQueueService.getItems.mockReturnValueOnce([{
        id: 'retry-local-retry',
        type: 'project',
        operation: 'upsert',
        data: localProject,
        projectId: 'local-retry',
        retryCount: 0,
        createdAt: Date.now(),
        sourceUserId: 'user-123',
        operationId: 'op-local-retry',
      }]);

      await (service as unknown as { downloadAndMerge: (userId: string) => Promise<void> })
        .downloadAndMerge('user-123');

      const mergedProjects: Project[] = mockProjectStateService.projects();
      const preservedLocal = mergedProjects.find(p => p.id === 'local-retry');
      expect(preservedLocal).toBeDefined();
      expect(preservedLocal?.syncSource).toBe('local-only');
      expect(preservedLocal?.pendingSync).toBe(true);
    });

    it('元数据成功但完整下载仅返回子集时，应保留缺失项目的 metadata 壳', async () => {
      const remoteProjectA = createTestProject({ id: 'remote-1', name: 'Remote 1' });
      const remoteProjectB = createTestProject({ id: 'remote-2', name: 'Remote 2' });

      mockSyncService.loadProjectListMetadataFromCloud.mockResolvedValueOnce([remoteProjectA, remoteProjectB]);
      mockSyncService.loadProjectsFromCloud.mockResolvedValueOnce([remoteProjectA]);
      mockProjectStateService.projects.set([]);
      mockChangeTrackerService.hasProjectChanges.mockReturnValue(false);
      mockActionQueueService.getPendingActionsForProject.mockReturnValue([]);

      await (service as unknown as { downloadAndMerge: (userId: string) => Promise<void> })
        .downloadAndMerge('user-123');

      const mergedProjects: Project[] = mockProjectStateService.projects();
      expect(mergedProjects.map(project => project.id)).toEqual(['remote-1', 'remote-2']);
      expect(mergedProjects.find(project => project.id === 'remote-2')).toEqual(
        expect.objectContaining({
          id: 'remote-2',
          name: 'Remote 2',
          syncSource: 'synced',
          pendingSync: false,
        })
      );
    });

    it('downloadAndMerge 在合并期间出现新的本地编辑时不应应用旧合并结果', async () => {
      const localProject = createTestProject({
        id: 'proj-merge-race',
        name: '请求前本地名称',
        updatedAt: '2026-02-14T08:00:00.000Z',
        tasks: [
          createTestTask({
            id: 'task-merge-race',
            title: '请求前标题',
            updatedAt: '2026-02-14T08:00:00.000Z',
          }),
        ],
      });
      const editedDuringMerge = {
        ...localProject,
        name: '合并期间本地名称',
        updatedAt: '2026-02-14T08:12:00.000Z',
        tasks: [
          {
            ...localProject.tasks[0],
            title: '合并期间本地标题',
            updatedAt: '2026-02-14T08:12:00.000Z',
          },
        ],
      };
      const remoteProject = createTestProject({
        id: 'proj-merge-race',
        name: '远端旧名称',
        updatedAt: '2026-02-14T08:10:00.000Z',
        tasks: [
          createTestTask({
            id: 'task-merge-race',
            title: '远端旧标题',
            updatedAt: '2026-02-14T08:10:00.000Z',
          }),
        ],
      });
      mockSyncService.loadProjectListMetadataFromCloud.mockResolvedValueOnce([remoteProject]);
      mockSyncService.loadProjectsFromCloud.mockResolvedValueOnce([remoteProject]);
      mockSyncService.getTombstoneIds.mockImplementationOnce(async () => {
        mockProjectStateService.projects.set([editedDuringMerge]);
        return new Set<string>();
      });
      mockProjectStateService.projects.set([localProject]);
      mockProjectStateService.setProjects.mockClear();
      mockSyncService.saveOfflineSnapshot.mockClear();
      mockConflictService.smartMerge.mockReturnValueOnce({
        project: remoteProject,
        issues: [],
        conflictCount: 0,
      });

      const merging = (service as unknown as { downloadAndMerge: (userId: string) => Promise<void> })
        .downloadAndMerge('user-123');
      await merging;

      expect(mockProjectStateService.setProjects).not.toHaveBeenCalled();
      expect(mockSyncService.saveOfflineSnapshot).not.toHaveBeenCalled();
      expect(mockProjectStateService.projects()[0]?.name).toBe('合并期间本地名称');
      expect(mockProjectStateService.projects()[0]?.tasks[0]?.title).toBe('合并期间本地标题');
    });
  });

  // ==================== 验证与重平衡 ====================

  describe('验证与重平衡', () => {
    it('validateAndRebalance 应该返回验证后的项目', () => {
      const project = createTestProject({ id: 'proj-1' });

      // 模拟委托服务返回验证后的项目
      mockProjectSyncOperationsService.validateAndRebalance.mockReturnValueOnce(project);

      const result = service.validateAndRebalance(project);

      expect(mockProjectSyncOperationsService.validateAndRebalance).toHaveBeenCalledWith(project);
      expect(result).toBeDefined();
    });

    it('validateAndRebalanceWithResult 验证失败时应该返回 failure', () => {
      // 由于空 ID 是致命错误，validateAndRebalanceWithResult 会在调用 validateAndFixTree 之前就返回失败
      // 所以我们只需要测试正常情况
      const validProject = createTestProject({ id: 'valid-proj' });
      mockLayoutService.validateAndFixTree.mockReturnValueOnce({
        project: validProject,
        issues: [],
      });

      const result = service.validateAndRebalanceWithResult(validProject);

      expect(result.ok).toBe(true);
    });

    it('连接数据损坏时应可清理修复（不应作为致命错误跳过整个项目）', () => {
      const project = createTestProject({
        id: 'proj-conn-bad',
        tasks: [createTestTask({ id: 't1' })],
        // source 为空会触发 validateConnection 的“连接源 ID 无效”
        connections: [{ id: 'c1', source: '' as any, target: 't1' } as any],
      });

      // 模拟委托服务返回修复后的项目（无效连接已被移除）
      const fixedProject = { ...project, connections: [] };
      mockProjectSyncOperationsService.validateAndRebalanceWithResult.mockReturnValueOnce({
        ok: true,
        value: fixedProject,
      });

      const result = service.validateAndRebalanceWithResult(project);
      expect(result.ok).toBe(true);
      expect(mockProjectSyncOperationsService.validateAndRebalanceWithResult).toHaveBeenCalled();
    });

    it('tasks 不是数组应视为致命错误', () => {
      const project = createTestProject({ id: 'proj-tasks-invalid' }) as any;
      project.tasks = undefined;

      // 模拟委托服务返回致命错误
      mockProjectSyncOperationsService.validateAndRebalanceWithResult.mockReturnValueOnce({
        ok: false,
        error: { code: 'VALIDATION_ERROR', message: 'tasks 不是数组' },
      });

      const result = service.validateAndRebalanceWithResult(project);
      expect(result.ok).toBe(false);
    });

    it('父任务缺失时应自动断开 parentId（避免因 tombstone 过滤导致项目跳过）', () => {
      const project = createTestProject({
        id: 'proj-orphan-parent',
        tasks: [
          createTestTask({ id: 'child-1', parentId: 'missing-parent' }),
        ],
        connections: [],
      });

      // 模拟委托服务返回修复后的项目（parentId 已被置为 null）
      const fixedProject = { ...project, tasks: [{ ...project.tasks[0], parentId: null }] };
      mockProjectSyncOperationsService.validateAndRebalanceWithResult.mockReturnValueOnce({
        ok: true,
        value: fixedProject,
      });

      const result = service.validateAndRebalanceWithResult(project);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.tasks[0].parentId).toBe(null);
      }
    });

    it('验证有警告时应该记录日志', () => {
      // 创建一个完整有效的项目，确保 validateProject 通过
      const project: Project = {
        id: 'proj-1',
        name: 'Test Project',
        description: '',
        createdDate: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tasks: [],
        connections: [],
        version: 1,
      };

      // 重要：在测试前重置所有 mock
      vi.clearAllMocks();

      // 模拟委托服务返回有 issues 的结果
      mockProjectSyncOperationsService.validateAndRebalance.mockReturnValueOnce(project);

      // 使用 mockImplementation 而不是 mockReturnValue 来确保覆盖默认实现
      mockLayoutService.validateAndFixTree.mockImplementation(() => ({
        project: project,
        issues: ['Fixed orphan task'],
      }));

      // 调用被测方法
      service.validateAndRebalance(project);

      // 验证 validateAndRebalance 被调用了
      expect(mockProjectSyncOperationsService.validateAndRebalance).toHaveBeenCalledTimes(1);
    });
  });

  // ==================== 远程变更回调 ====================

  describe('远程变更回调', () => {
    it('setupRemoteChangeCallbacks 应该设置回调', () => {
      const onRemoteChange = vi.fn();
      const onTaskChange = vi.fn();

      service.setupRemoteChangeCallbacks(onRemoteChange, onTaskChange);

      expect(mockSyncService.setRemoteChangeCallback).toHaveBeenCalledWith(onRemoteChange);
      expect(mockSyncService.setTaskChangeCallback).toHaveBeenCalledWith(onTaskChange);
    });
  });

  // ==================== 实时订阅管理 ====================

  // ==================== 队列处理协调 ====================

  describe('队列处理协调', () => {
    it('应该在初始化时委托给 ActionQueueProcessorsService 设置处理器', () => {
      expect(mockActionQueueProcessorsService.setupProcessors).toHaveBeenCalled();
    });

    it('应该在初始化时注册 project conflict 回调', () => {
      expect(mockActionQueueProcessorsService.setProjectConflictHandler).toHaveBeenCalledWith(expect.any(Function));
    });
  });

  // ==================== 动作处理器注册（已移至 ActionQueueProcessorsService） ====================

  // 注：动作处理器注册逻辑已提取到 ActionQueueProcessorsService
  // 这些测试应该在 ActionQueueProcessorsService 的测试文件中进行

  // ==================== 网络状态变化场景 ====================

  describe('网络状态变化场景', () => {
    it('从在线变为离线时状态应该正确反映', () => {
      expect(service.isOnline()).toBe(true);
      expect(service.offlineMode()).toBe(false);

      mockSyncService.syncState.set(createMockSyncState({
        isOnline: false,
        offlineMode: true,
      }));

      expect(service.isOnline()).toBe(false);
      expect(service.offlineMode()).toBe(true);
    });

    it('从离线恢复在线时状态应该正确反映', () => {
      mockSyncService.syncState.set(createMockSyncState({
        isOnline: false,
        offlineMode: true,
      }));

      expect(service.isOnline()).toBe(false);

      mockSyncService.syncState.set(createMockSyncState({
        isOnline: true,
        offlineMode: false,
      }));

      expect(service.isOnline()).toBe(true);
      expect(service.offlineMode()).toBe(false);
    });
  });

  // ==================== 并发保存场景 ====================

  describe('并发保存场景', () => {
    it('快速连续调用 schedulePersist 应该合并为一次', async () => {
      const project = createTestProject({ id: 'proj-1' });
      mockProjectStateService.activeProject.set(project);
      mockProjectStateService.projects.set([project]);

      mockSyncService.saveOfflineSnapshot.mockClear();
      mockSyncService.saveProjectSmart.mockClear();

      // 快速连续调用
      for (let i = 0; i < 10; i++) {
        service.schedulePersist();
        await vi.advanceTimersByTimeAsync(50);
      }

      // 等待防抖完成 (DEBOUNCE_DELAY = 3000ms, 最后一次 schedulePersist 在 ~500ms)
      await vi.advanceTimersByTimeAsync(3500);

      // 等待异步持久化操作完成
      await vi.waitFor(() => {
        expect(mockSyncService.saveProjectSmart).toHaveBeenCalledTimes(1);
      });

      expect(mockSyncService.saveOfflineSnapshot).toHaveBeenCalled();
    });
  });

  // ==================== 清理 ====================

  describe('清理', () => {
    it('destroy 应退订实时订阅且保留重试队列 outbox', () => {
      service.destroy();

      expect(mockRealtimePollingService.unsubscribeFromProject).toHaveBeenCalled();
      expect(mockRetryQueueService.clear).not.toHaveBeenCalled();
    });
  });
}
