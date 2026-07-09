import { AUTH_CONFIG, beforeEach, describe, expect, FEATURE_FLAGS, it, vi } from './sync-coordinator.service.spec-context';
import type { Project, SyncCoordinatorService, Task } from './sync-coordinator.service.spec-context';
import { registerSyncCoordinatorBlackBoxWatermarkSpecs } from './sync-coordinator-offline-merge-black-box-watermark.spec-helpers';

export interface SyncCoordinatorOfflineMergeSpecContext {
  service(): SyncCoordinatorService;
  mockSyncService(): any;
  mockProjectStateService(): any;
  mockAuthService(): any;
  mockProjectSyncOperationsService(): any;
  mockConflictService(): any;
  mockConflictStorageService(): any;
  mockLoggerCategory(): any;
  mockBlackBoxSyncService(): any;
  createTestProject(overrides?: Partial<Project>): Project;
  createTestTask(overrides?: Partial<Task>): Task;
}

export function registerSyncCoordinatorOfflineMergeSpecs(context: SyncCoordinatorOfflineMergeSpecContext): void {
  let service: SyncCoordinatorService;
  let mockSyncService: any;
  let mockProjectStateService: any;
  let mockAuthService: any;
  let mockProjectSyncOperationsService: any;
  let mockConflictService: any;
  let mockConflictStorageService: any;
  let mockLoggerCategory: any;

  const createTestProject = context.createTestProject;
  const createTestTask = context.createTestTask;

  beforeEach(() => {
    service = context.service();
    mockSyncService = context.mockSyncService();
    mockProjectStateService = context.mockProjectStateService();
    mockAuthService = context.mockAuthService();
    mockProjectSyncOperationsService = context.mockProjectSyncOperationsService();
    mockConflictService = context.mockConflictService();
    mockConflictStorageService = context.mockConflictStorageService();
    mockLoggerCategory = context.mockLoggerCategory();
  });

  // ==================== 离线数据合并 ====================

  describe('离线数据合并', () => {
    // Sprint 9: mergeOfflineDataOnReconnect 现在委托给 ProjectSyncOperationsService
    it('离线新建项目应该同步到云端', async () => {
      const offlineProject = createTestProject({ id: 'new-proj', name: 'Offline' });
      const cloudProjects: Project[] = [];
      
      // 配置 mock 返回值
      mockProjectSyncOperationsService.mergeOfflineDataOnReconnect.mockResolvedValueOnce({
        projects: [offlineProject],
        syncedCount: 1,
        conflictProjects: []
      });
      
      const result = await service.mergeOfflineDataOnReconnect(
        cloudProjects,
        [offlineProject],
        'user-123'
      );
      
      expect(result.syncedCount).toBe(1);
      expect(mockProjectSyncOperationsService.mergeOfflineDataOnReconnect).toHaveBeenCalledWith(
        cloudProjects,
        [offlineProject],
        'user-123',
        expect.any(Function),
        expect.any(Function)
      );
    });

    it('离线版本高于云端时应该同步', async () => {
      const cloudProject = createTestProject({ id: 'proj-1', version: 3 });
      const offlineProject = createTestProject({ id: 'proj-1', version: 5 });
      
      // 配置 mock 返回值
      mockProjectSyncOperationsService.mergeOfflineDataOnReconnect.mockResolvedValueOnce({
        projects: [offlineProject],
        syncedCount: 1,
        conflictProjects: []
      });
      
      const result = await service.mergeOfflineDataOnReconnect(
        [cloudProject],
        [offlineProject],
        'user-123'
      );
      
      expect(result.syncedCount).toBe(1);
    });

    it('云端版本高于离线时不应该同步', async () => {
      const cloudProject = createTestProject({ id: 'proj-1', version: 10 });
      const offlineProject = createTestProject({ id: 'proj-1', version: 3 });
      
      // 配置 mock 返回值 - 云端版本更高时 syncedCount 为 0
      mockProjectSyncOperationsService.mergeOfflineDataOnReconnect.mockResolvedValueOnce({
        projects: [cloudProject],
        syncedCount: 0,
        conflictProjects: []
      });
      
      const result = await service.mergeOfflineDataOnReconnect(
        [cloudProject],
        [offlineProject],
        'user-123'
      );
      
      expect(result.syncedCount).toBe(0);
    });

    it('冲突时应该发布冲突事件到 onConflict$', async () => {
      const cloudProject = createTestProject({ id: 'proj-1', version: 5 });
      const offlineProject = createTestProject({ id: 'proj-1', version: 6 });
      
      // 配置 mock 返回冲突项目
      mockProjectSyncOperationsService.mergeOfflineDataOnReconnect.mockImplementationOnce(
        async (
          _cloud: Project[],
          _offline: Project[],
          _userId: string,
          _getTombstone: () => Promise<Set<string>>,
          onConflict: (offlineProject: Project, cloudProject: Project) => void,
        ) => {
          // 模拟调用冲突回调
          onConflict(offlineProject, cloudProject);
          return {
            projects: [cloudProject],
            syncedCount: 0,
            conflictProjects: [offlineProject]
          };
        }
      );
      
      const onConflictSpy = vi.fn();
      const subscription = service.onConflict$.subscribe(onConflictSpy);
      
      await service.mergeOfflineDataOnReconnect(
        [cloudProject],
        [offlineProject],
        'user-123'
      );
      
      await vi.waitFor(() => {
        expect(onConflictSpy).toHaveBeenCalledWith({
          localProject: offlineProject,
          remoteProject: cloudProject,
          projectId: 'proj-1'
        });
        expect(service.hasConflict()).toBe(true);
      });
      expect(mockConflictStorageService.saveConflict).toHaveBeenCalled();
      expect(service.conflictData()).toEqual({
        local: offlineProject,
        remote: cloudProject,
        projectId: 'proj-1',
        conflictedAt: expect.any(String),
        pendingTaskDeleteIds: undefined,
        pendingTaskDeleteBaseUpdatedAtMap: undefined,
      });
      
      subscription.unsubscribe();
    });

    it('重复快照冲突不应重复发布 onConflict$ 或刷新 conflictedAt', async () => {
      const cloudProject = createTestProject({
        id: 'proj-dup',
        version: 5,
        updatedAt: '2026-05-12T14:20:00.000Z',
      });
      const offlineProject = createTestProject({
        id: 'proj-dup',
        version: 6,
        updatedAt: '2026-05-12T14:21:00.000Z',
      });
      const onConflictSpy = vi.fn();
      const subscription = service.onConflict$.subscribe(onConflictSpy);

      await service.captureConflict(offlineProject, cloudProject, 'user-123', ['task-delete-1']);
      const firstConflict = service.conflictData();

      await service.captureConflict(
        { ...offlineProject },
        { ...cloudProject },
        'user-123',
        ['task-delete-1'],
      );

      expect(onConflictSpy).toHaveBeenCalledTimes(1);
      expect(service.conflictData()).toEqual(firstConflict);
      expect(mockLoggerCategory.debug).toHaveBeenCalledWith('跳过重复冲突发布', { projectId: 'proj-dup' });

      subscription.unsubscribe();
    });

    it('待删除任务 CAS 基线变化时应发布新的冲突快照', async () => {
      const cloudProject = createTestProject({
        id: 'proj-dup-baseline',
        version: 5,
        updatedAt: '2026-05-12T14:20:00.000Z',
      });
      const offlineProject = createTestProject({
        id: 'proj-dup-baseline',
        version: 6,
        updatedAt: '2026-05-12T14:21:00.000Z',
      });
      const onConflictSpy = vi.fn();
      const subscription = service.onConflict$.subscribe(onConflictSpy);

      await service.captureConflict(
        offlineProject,
        cloudProject,
        'user-123',
        ['task-delete-1'],
        { 'task-delete-1': '2026-05-12T14:00:00.000Z' },
      );

      await service.captureConflict(
        { ...offlineProject },
        { ...cloudProject },
        'user-123',
        ['task-delete-1'],
        { 'task-delete-1': '2026-05-12T14:01:00.000Z' },
      );

      expect(onConflictSpy).toHaveBeenCalledTimes(2);
      expect(service.conflictData()).toEqual(expect.objectContaining({
        projectId: 'proj-dup-baseline',
        pendingTaskDeleteBaseUpdatedAtMap: {
          'task-delete-1': '2026-05-12T14:01:00.000Z',
        },
      }));

      subscription.unsubscribe();
    });

    it('相同项目元数据但任务内容变化时仍应发布新的冲突快照', async () => {
      const cloudProject = createTestProject({
        id: 'proj-dup-refresh',
        version: 5,
        updatedAt: '2026-05-12T14:20:00.000Z',
        tasks: [createTestTask({ id: 'task-1', title: 'Remote A', updatedAt: '2026-05-12T14:19:00.000Z' })],
      });
      const offlineProject = createTestProject({
        id: 'proj-dup-refresh',
        version: 6,
        updatedAt: '2026-05-12T14:21:00.000Z',
        tasks: [createTestTask({ id: 'task-1', title: 'Local A', updatedAt: '2026-05-12T14:21:00.000Z' })],
      });
      const refreshedOfflineProject = {
        ...offlineProject,
        tasks: [createTestTask({ id: 'task-1', title: 'Local B', updatedAt: '2026-05-12T14:21:00.000Z' })],
      };
      const onConflictSpy = vi.fn();
      const subscription = service.onConflict$.subscribe(onConflictSpy);

      await service.captureConflict(offlineProject, cloudProject, 'user-123');
      const firstConflict = service.conflictData();

      await service.captureConflict(refreshedOfflineProject, cloudProject, 'user-123');

      expect(onConflictSpy).toHaveBeenCalledTimes(2);
      expect(service.conflictData()).toEqual(expect.objectContaining({
        local: refreshedOfflineProject,
        remote: cloudProject,
        projectId: 'proj-dup-refresh',
      }));
      expect(service.conflictData()?.local.tasks[0]?.title).toBe('Local B');
      expect(firstConflict?.local.tasks[0]?.title).toBe('Local A');

      subscription.unsubscribe();
    });

    it('冲突时应记录冲突（LWW 冲突解决入口）', async () => {
      // Sprint 9: resyncActiveProject 现在委托给 ProjectSyncOperationsService
      const localProject = createTestProject({ id: 'proj-1', version: 2 });
      const remoteProject = createTestProject({ id: 'proj-1', version: 3 });

      mockProjectStateService.activeProject.set(localProject);
      mockProjectStateService.activeProjectId.set('proj-1');
      mockProjectStateService.projects.set([localProject]);

      mockAuthService.currentUserId.mockReturnValue('user-123');

      // 配置 mock 返回冲突检测结果
      mockProjectSyncOperationsService.resyncActiveProject.mockResolvedValueOnce({
        success: true,
        message: '已合并，1 处冲突已保存供稍后处理',
        conflictDetected: true
      });

      const result = await service.resyncActiveProject();

      expect(result.success).toBe(true);
      expect(result.conflictDetected).toBe(true);
      expect(mockProjectSyncOperationsService.resyncActiveProject).toHaveBeenCalledWith(
        expect.any(Function)
      );
    });

    it('refreshActiveProjectSilent 在远端水位未超过拉取游标时应走快路跳过远端拉取', async () => {
      (FEATURE_FLAGS as unknown as Record<string, boolean>).RESUME_WATERMARK_RPC_V1 = true;

      const localUpdatedAt = '2026-02-14T08:00:00.000Z';
      const localProject = createTestProject({
        id: 'proj-1',
        updatedAt: localUpdatedAt
      });

      mockProjectStateService.projects.set([localProject]);
      mockProjectStateService.activeProjectId.set('proj-1');
      mockAuthService.currentUserId.mockReturnValue('user-123');
      // 快路合法前提：该项目的增量拉取游标已经覆盖远端水位
      mockSyncService.ensureProjectSyncCursorLoaded.mockResolvedValueOnce({
        updatedAt: '2026-02-14T08:00:00.000Z',
        entityType: 'project',
        id: 'proj-1',
      });
      mockSyncService.getProjectSyncWatermark.mockResolvedValueOnce('2026-02-14T07:59:59.000Z');

      const result = await service.refreshActiveProjectSilent('resume:test');

      expect(result).toEqual({
        refreshed: false,
        skippedReason: 'watermark-not-newer',
        fastPathHit: true
      });
      expect(mockSyncService.commitProjectSyncTimestamp).toHaveBeenCalledWith('proj-1', '2026-02-14T07:59:59.000Z');
      expect(mockSyncService.loadFullProjectOptimized).not.toHaveBeenCalled();
    });

    it('refreshActiveProjectSilent 在本地模式下不应触发远端探测或项目拉取', async () => {
      (FEATURE_FLAGS as unknown as Record<string, boolean>).RESUME_WATERMARK_RPC_V1 = true;

      const localProject = createTestProject({
        id: 'proj-local',
        updatedAt: '2026-02-14T08:00:00.000Z',
      });

      mockProjectStateService.projects.set([localProject]);
      mockProjectStateService.activeProjectId.set('proj-local');
      mockAuthService.currentUserId.mockReturnValue(AUTH_CONFIG.LOCAL_MODE_USER_ID);

      const result = await service.refreshActiveProjectSilent('resume:local-mode');

      expect(result).toEqual({ refreshed: false, skippedReason: 'local-mode' });
      expect(mockSyncService.getAccessibleProjectProbe).not.toHaveBeenCalled();
      expect(mockSyncService.getProjectSyncWatermark).not.toHaveBeenCalled();
      expect(mockSyncService.loadFullProjectOptimized).not.toHaveBeenCalled();
    });

    it('refreshActiveProjectSilent 本地数据水位追平远端但拉取游标落后时不得走快路推进游标', async () => {
      // P0 回归：本机推送回显会把本地聚合水位抬到与远端相等，
      // 但拉取游标仍停在旧位置——中间可能有另一设备的未拉取行。
      // 快路若按"本地数据水位"判定并 commitProjectSyncTimestamp(远端水位)，
      // 该行将永远落在增量窗口之外（永久静默缺口）。
      (FEATURE_FLAGS as unknown as Record<string, boolean>).RESUME_WATERMARK_RPC_V1 = true;

      const localProject = createTestProject({
        id: 'proj-agg',
        updatedAt: '2026-02-14T08:00:00.000Z',
        tasks: [
          createTestTask({
            id: 'task-agg',
            // 本机推送回显：本地聚合水位 = 远端水位
            updatedAt: '2026-02-14T08:12:00.000Z'
          })
        ],
      });
      const remoteProject = createTestProject({
        id: 'proj-agg',
        updatedAt: '2026-02-14T08:12:00.000Z',
        tasks: [createTestTask({ id: 'task-agg', updatedAt: '2026-02-14T08:12:00.000Z' })],
      });

      mockProjectStateService.projects.set([localProject]);
      mockProjectStateService.activeProjectId.set('proj-agg');
      mockAuthService.currentUserId.mockReturnValue('user-123');
      // 拉取游标停在旧位置：07:58（07:59:20 的另一设备写入尚未拉取）
      mockSyncService.ensureProjectSyncCursorLoaded.mockResolvedValueOnce({
        updatedAt: '2026-02-14T07:58:00.000Z',
        entityType: 'project',
        id: 'proj-agg',
      });
      mockSyncService.getProjectSyncWatermark.mockResolvedValueOnce('2026-02-14T08:12:00.000Z');
      mockSyncService.loadFullProjectOptimized.mockResolvedValueOnce(remoteProject);
      mockConflictService.smartMerge.mockReturnValueOnce({
        project: remoteProject,
        issues: [],
        conflictCount: 0,
      });

      const result = await service.refreshActiveProjectSilent('resume:test:cursor-behind-watermark');

      expect(result.fastPathHit).not.toBe(true);
      expect(mockSyncService.loadFullProjectOptimized).toHaveBeenCalledWith('proj-agg');
      // 不得在未拉取的情况下用远端水位直接推进游标
      expect(mockSyncService.commitProjectSyncTimestamp).not.toHaveBeenCalled();
    });

    it('refreshActiveProjectSilent 拉取游标已覆盖远端水位时应命中快路', async () => {
      (FEATURE_FLAGS as unknown as Record<string, boolean>).RESUME_WATERMARK_RPC_V1 = true;

      const localProject = createTestProject({
        id: 'proj-agg',
        updatedAt: '2026-02-14T08:00:00.000Z',
        tasks: [
          createTestTask({
            id: 'task-agg',
            updatedAt: '2026-02-14T08:12:00.000Z'
          })
        ],
      });

      mockProjectStateService.projects.set([localProject]);
      mockProjectStateService.activeProjectId.set('proj-agg');
      mockAuthService.currentUserId.mockReturnValue('user-123');
      // 游标已覆盖远端水位：上次增量拉取推进到 08:11
      mockSyncService.ensureProjectSyncCursorLoaded.mockResolvedValueOnce({
        updatedAt: '2026-02-14T08:11:00.000Z',
        entityType: 'task',
        id: 'task-agg',
      });
      mockSyncService.getProjectSyncWatermark.mockResolvedValueOnce('2026-02-14T08:10:00.000Z');

      const result = await service.refreshActiveProjectSilent('resume:test:cursor-fastpath');

      expect(result).toEqual({
        refreshed: false,
        skippedReason: 'watermark-not-newer',
        fastPathHit: true
      });
      expect(mockSyncService.commitProjectSyncTimestamp).toHaveBeenCalledWith('proj-agg', '2026-02-14T08:10:00.000Z');
      expect(mockSyncService.loadFullProjectOptimized).not.toHaveBeenCalled();
    });

    it('refreshActiveProjectSilent 在远端水位更新时应加载并静默合并活动项目', async () => {
      (FEATURE_FLAGS as unknown as Record<string, boolean>).RESUME_WATERMARK_RPC_V1 = true;

      const localProject = createTestProject({
        id: 'proj-1',
        updatedAt: '2026-02-14T08:00:00.000Z',
        tasks: [createTestTask({ id: 'task-local', updatedAt: '2026-02-14T07:55:00.000Z' })],
      });
      const remoteProject = createTestProject({
        id: 'proj-1',
        updatedAt: '2026-02-14T08:10:00.000Z',
        tasks: [createTestTask({ id: 'task-remote' })],
      });

      mockProjectStateService.projects.set([localProject]);
      mockProjectStateService.activeProjectId.set('proj-1');
      mockAuthService.currentUserId.mockReturnValue('user-123');
      mockSyncService.getProjectSyncWatermark.mockResolvedValueOnce('2026-02-14T08:10:00.000Z');
      mockSyncService.loadFullProjectOptimized.mockResolvedValueOnce(remoteProject);
      mockConflictService.smartMerge.mockReturnValueOnce({
        project: remoteProject,
        issues: [],
        conflictCount: 0,
      });

      const calls: string[] = [];
      mockProjectStateService.updateProjects.mockImplementation((updater: (projects: Project[]) => Project[]) => {
        mockProjectStateService.projects.set(updater(mockProjectStateService.projects()));
        calls.push('merge');
      });
      mockSyncService.saveOfflineSnapshotAndWait.mockImplementation(async () => {
        calls.push('persist');
      });
      mockSyncService.commitProjectSyncCursor.mockImplementation(async () => {
        calls.push('commit');
      });

      const result = await service.refreshActiveProjectSilent('resume:test');

      expect(result.refreshed).toBe(true);
      expect(mockSyncService.loadFullProjectOptimized).toHaveBeenCalledWith('proj-1');
      expect(mockSyncService.saveOfflineSnapshotAndWait).toHaveBeenCalledWith([
        expect.objectContaining({ id: 'proj-1', updatedAt: '2026-02-14T08:10:00.000Z' })
      ]);
      expect(mockSyncService.commitProjectSyncCursor).toHaveBeenCalledWith('proj-1', {
        updatedAt: '2026-02-14T08:10:00.000Z',
        entityType: 'project',
        id: 'proj-1',
      });
      expect(calls).toEqual(['merge', 'persist', 'commit']);
      expect(mockProjectStateService.projects()[0]?.updatedAt).toBe('2026-02-14T08:10:00.000Z');
    });

    it('refreshActiveProjectSilent 远端加载期间出现新的本地编辑时不应用旧本地快照合并结果', async () => {
      (FEATURE_FLAGS as unknown as Record<string, boolean>).RESUME_WATERMARK_RPC_V1 = true;

      const localProject = createTestProject({
        id: 'proj-1',
        updatedAt: '2026-02-14T08:00:00.000Z',
        tasks: [
          createTestTask({
            id: 'task-draft',
            title: '请求前标题',
            content: '请求前正文',
            updatedAt: '2026-02-14T08:00:00.000Z',
          }),
        ],
      });
      const localProjectEditedDuringRequest = {
        ...localProject,
        updatedAt: '2026-02-14T08:12:00.000Z',
        tasks: [
          {
            ...localProject.tasks[0],
            title: '请求期间本地标题',
            content: '请求期间本地正文',
            updatedAt: '2026-02-14T08:12:00.000Z',
          },
        ],
      };
      const remoteProject = createTestProject({
        id: 'proj-1',
        updatedAt: '2026-02-14T08:10:00.000Z',
        tasks: [
          createTestTask({
            id: 'task-draft',
            title: '远端旧标题',
            content: '远端旧正文',
            updatedAt: '2026-02-14T08:10:00.000Z',
          }),
        ],
      });
      let resolveRemoteProject!: (project: Project) => void;
      const remoteProjectPromise = new Promise<Project>(resolve => {
        resolveRemoteProject = resolve;
      });

      mockProjectStateService.projects.set([localProject]);
      mockProjectStateService.activeProjectId.set('proj-1');
      mockAuthService.currentUserId.mockReturnValue('user-123');
      mockSyncService.getProjectSyncWatermark.mockResolvedValueOnce('2026-02-14T08:10:00.000Z');
      mockSyncService.loadFullProjectOptimized.mockReturnValueOnce(remoteProjectPromise);
      mockConflictService.smartMerge.mockImplementationOnce((local: Project, remote: Project) => ({
        project: {
          ...remote,
          tasks: local.tasks,
          updatedAt: local.updatedAt,
          pendingSync: true,
        },
        issues: [],
        conflictCount: 0,
      }));

      const refreshing = service.refreshActiveProjectSilent('resume:test:local-edit-during-refresh');
      await Promise.resolve();

      mockProjectStateService.projects.set([localProjectEditedDuringRequest]);
      resolveRemoteProject(remoteProject);

      const result = await refreshing;

      expect(result).toEqual({
        refreshed: false,
        skippedReason: 'local-project-changed-during-refresh',
      });
      expect(mockProjectStateService.updateProjects).not.toHaveBeenCalled();
      expect(mockSyncService.saveOfflineSnapshotAndWait).not.toHaveBeenCalled();
      expect(mockSyncService.commitProjectSyncCursor).not.toHaveBeenCalled();
      expect(mockProjectStateService.projects()[0]?.tasks[0]?.title).toBe('请求期间本地标题');
      expect(mockProjectStateService.projects()[0]?.tasks[0]?.content).toBe('请求期间本地正文');
    });

    it('refreshActiveProjectSilent 远端加载期间 active project 或 owner 变化时不应应用晚到结果', async () => {
      (FEATURE_FLAGS as unknown as Record<string, boolean>).RESUME_WATERMARK_RPC_V1 = true;

      const localProject = createTestProject({
        id: 'proj-1',
        updatedAt: '2026-02-14T08:00:00.000Z',
        tasks: [createTestTask({ id: 'task-local', updatedAt: '2026-02-14T07:55:00.000Z' })],
      });
      const otherProject = createTestProject({
        id: 'proj-2',
        updatedAt: '2026-02-14T08:01:00.000Z',
      });
      const remoteProject = createTestProject({
        id: 'proj-1',
        updatedAt: '2026-02-14T08:10:00.000Z',
        tasks: [createTestTask({ id: 'task-remote' })],
      });
      let resolveRemoteProject!: (project: Project) => void;
      const remoteProjectPromise = new Promise<Project>(resolve => {
        resolveRemoteProject = resolve;
      });

      mockProjectStateService.projects.set([localProject, otherProject]);
      mockProjectStateService.activeProjectId.set('proj-1');
      mockAuthService.currentUserId.mockReturnValue('user-123');
      mockSyncService.getProjectSyncWatermark.mockResolvedValueOnce('2026-02-14T08:10:00.000Z');
      mockSyncService.loadFullProjectOptimized.mockReturnValueOnce(remoteProjectPromise);
      mockConflictService.smartMerge.mockReturnValueOnce({
        project: remoteProject,
        issues: [],
        conflictCount: 0,
      });

      const refreshing = service.refreshActiveProjectSilent('resume:test:stale-active');
      await Promise.resolve();

      mockProjectStateService.activeProjectId.set('proj-2');
      mockAuthService.currentUserId.mockReturnValue('user-456');
      resolveRemoteProject(remoteProject);

      const result = await refreshing;

      expect(result).toEqual({
        refreshed: false,
        skippedReason: 'stale-active-project',
      });
      expect(mockProjectStateService.updateProjects).not.toHaveBeenCalled();
      expect(mockSyncService.saveOfflineSnapshotAndWait).not.toHaveBeenCalled();
      expect(mockSyncService.commitProjectSyncCursor).not.toHaveBeenCalled();
      expect(mockSyncService.commitProjectSyncTimestamp).not.toHaveBeenCalled();
      expect(mockProjectStateService.projects()[0]?.updatedAt).toBe('2026-02-14T08:00:00.000Z');
    });

    it('refreshProjectManifestIfNeeded 命中用户水位快路时应跳过头信息刷新', async () => {
      (FEATURE_FLAGS as unknown as Record<string, boolean>).USER_PROJECTS_WATERMARK_RPC_V1 = true;
      mockAuthService.currentUserId.mockReturnValue('user-123');
      localStorage.setItem('nanoflow.project-manifest-watermark.user-123', '2026-02-15T08:00:00.000Z');
      mockSyncService.getUserProjectsWatermark.mockResolvedValueOnce('2026-02-15T07:59:59.000Z');

      const result = await service.refreshProjectManifestIfNeeded('manifest:fast-path');

      expect(result).toEqual({
        skipped: true,
        watermark: '2026-02-15T07:59:59.000Z',
      });
      expect(mockSyncService.listProjectHeadsSince).not.toHaveBeenCalled();
    });

    it('refreshProjectManifestIfNeeded 使用预加载水位时不应重复调用 RPC', async () => {
      (FEATURE_FLAGS as unknown as Record<string, boolean>).USER_PROJECTS_WATERMARK_RPC_V1 = true;
      mockAuthService.currentUserId.mockReturnValue('user-123');
      localStorage.setItem('nanoflow.project-manifest-watermark.user-123', '2026-02-15T08:00:00.000Z');

      const result = await service.refreshProjectManifestIfNeeded('manifest:prefetched', {
        prefetchedRemoteWatermark: '2026-02-15T07:59:59.000Z',
      });

      expect(result).toEqual({
        skipped: true,
        watermark: '2026-02-15T07:59:59.000Z',
      });
      expect(mockSyncService.getUserProjectsWatermark).not.toHaveBeenCalled();
      expect(mockSyncService.listProjectHeadsSince).not.toHaveBeenCalled();
    });

    it('refreshProjectManifestIfNeeded 删除事件推动预加载 watermark 前进时不应命中快路', async () => {
      (FEATURE_FLAGS as unknown as Record<string, boolean>).USER_PROJECTS_WATERMARK_RPC_V1 = true;
      mockAuthService.currentUserId.mockReturnValue('user-123');
      localStorage.setItem('nanoflow.project-manifest-watermark.user-123', '2026-02-15T08:00:00.000Z');
      mockSyncService.listProjectHeadsSince.mockResolvedValueOnce([]);

      const result = await service.refreshProjectManifestIfNeeded('manifest:prefetched-delete', {
        prefetchedRemoteWatermark: '2026-02-15T08:20:00.000Z',
        deferCommit: true,
      });

      expect(result).toEqual({
        skipped: false,
        watermark: '2026-02-15T08:20:00.000Z',
      });
      expect(mockSyncService.getUserProjectsWatermark).not.toHaveBeenCalled();
      expect(mockSyncService.listProjectHeadsSince).toHaveBeenCalledWith('2026-02-15T08:00:00.000Z');
      expect(localStorage.getItem('nanoflow.project-manifest-watermark.user-123')).toBe('2026-02-15T08:00:00.000Z');
    });

    it('refreshProjectManifestIfNeeded 冷启动无本地水位时不应调用 heads RPC 且不跳过慢路', async () => {
      (FEATURE_FLAGS as unknown as Record<string, boolean>).USER_PROJECTS_WATERMARK_RPC_V1 = true;
      mockAuthService.currentUserId.mockReturnValue('user-123');
      mockSyncService.getUserProjectsWatermark.mockResolvedValueOnce('2026-02-15T08:20:00.000Z');

      const result = await service.refreshProjectManifestIfNeeded('manifest:cold-start');

      expect(result).toEqual({
        skipped: false,
        watermark: '2026-02-15T08:20:00.000Z',
      });
      expect(mockSyncService.listProjectHeadsSince).not.toHaveBeenCalled();
      expect(localStorage.getItem('nanoflow.project-manifest-watermark.user-123')).toBe('2026-02-15T08:20:00.000Z');
    });

    it('refreshProjectManifestIfNeeded 远端更新且 heads 为空时也不应跳过慢路', async () => {
      (FEATURE_FLAGS as unknown as Record<string, boolean>).USER_PROJECTS_WATERMARK_RPC_V1 = true;
      mockAuthService.currentUserId.mockReturnValue('user-123');
      localStorage.setItem('nanoflow.project-manifest-watermark.user-123', '2026-02-15T08:00:00.000Z');
      mockSyncService.getUserProjectsWatermark.mockResolvedValueOnce('2026-02-15T08:20:00.000Z');
      mockSyncService.listProjectHeadsSince.mockResolvedValueOnce([]);

      const result = await service.refreshProjectManifestIfNeeded('manifest:heads-empty');

      expect(result).toEqual({
        skipped: false,
        watermark: '2026-02-15T08:20:00.000Z',
      });
      expect(mockSyncService.listProjectHeadsSince).toHaveBeenCalledWith('2026-02-15T08:00:00.000Z');
    });

    it('refreshProjectManifestIfNeeded 远端有更新时应拉取头信息并更新本地水位', async () => {
      (FEATURE_FLAGS as unknown as Record<string, boolean>).USER_PROJECTS_WATERMARK_RPC_V1 = true;
      mockAuthService.currentUserId.mockReturnValue('user-123');
      localStorage.setItem('nanoflow.project-manifest-watermark.user-123', '2026-02-15T08:00:00.000Z');
      mockProjectStateService.projects.set([
        createTestProject({
          id: 'proj-1',
          updatedAt: '2026-02-15T08:00:00.000Z',
          version: 1,
        }),
      ]);
      mockSyncService.getUserProjectsWatermark.mockResolvedValueOnce('2026-02-15T08:20:00.000Z');
      mockSyncService.listProjectHeadsSince.mockResolvedValueOnce([
        {
          id: 'proj-1',
          updatedAt: '2026-02-15T08:19:00.000Z',
          version: 3,
        },
      ]);

      const result = await service.refreshProjectManifestIfNeeded('manifest:slow-path');

      expect(result).toEqual({
        skipped: false,
        watermark: '2026-02-15T08:20:00.000Z',
      });
      expect(mockSyncService.listProjectHeadsSince).toHaveBeenCalledWith('2026-02-15T08:00:00.000Z');
      const updated = mockProjectStateService.projects()[0];
      expect(updated?.updatedAt).toBe('2026-02-15T08:19:00.000Z');
      expect(updated?.version).toBe(3);
      expect(localStorage.getItem('nanoflow.project-manifest-watermark.user-123')).toBe('2026-02-15T08:20:00.000Z');
    });

    it('refreshProjectManifestIfNeeded 远端水位返回前 owner 变化时不应应用旧结果', async () => {
      (FEATURE_FLAGS as unknown as Record<string, boolean>).USER_PROJECTS_WATERMARK_RPC_V1 = true;
      localStorage.setItem('nanoflow.project-manifest-watermark.user-123', '2026-02-15T08:00:00.000Z');
      localStorage.setItem('nanoflow.project-manifest-watermark.user-456', '2026-02-15T09:00:00.000Z');
      mockProjectStateService.projects.set([
        createTestProject({
          id: 'proj-1',
          updatedAt: '2026-02-15T08:00:00.000Z',
          version: 1,
        }),
      ]);
      let resolveRemoteWatermark!: (watermark: string) => void;
      mockAuthService.currentUserId.mockReturnValue('user-123');
      mockSyncService.getUserProjectsWatermark.mockReturnValueOnce(new Promise<string>(resolve => {
        resolveRemoteWatermark = resolve;
      }));
      mockSyncService.listProjectHeadsSince.mockResolvedValueOnce([
        {
          id: 'proj-1',
          updatedAt: '2026-02-15T08:19:00.000Z',
          version: 3,
        },
      ]);

      const refreshing = service.refreshProjectManifestIfNeeded('manifest:stale-owner');
      await Promise.resolve();

      mockAuthService.currentUserId.mockReturnValue('user-456');
      resolveRemoteWatermark('2026-02-15T08:20:00.000Z');

      const result = await refreshing;

      expect(result).toEqual({
        skipped: true,
        watermark: '2026-02-15T08:20:00.000Z',
      });
      expect(mockSyncService.listProjectHeadsSince).not.toHaveBeenCalled();
      expect(mockProjectStateService.updateProjects).not.toHaveBeenCalled();
      expect(mockProjectStateService.projects()[0]?.updatedAt).toBe('2026-02-15T08:00:00.000Z');
      expect(localStorage.getItem('nanoflow.project-manifest-watermark.user-123')).toBe('2026-02-15T08:00:00.000Z');
      expect(localStorage.getItem('nanoflow.project-manifest-watermark.user-456')).toBe('2026-02-15T09:00:00.000Z');
    });

    it('refreshProjectManifestIfNeeded 并发刷新晚到时不应回退本地水位', async () => {
      (FEATURE_FLAGS as unknown as Record<string, boolean>).USER_PROJECTS_WATERMARK_RPC_V1 = true;
      mockAuthService.currentUserId.mockReturnValue('user-123');
      localStorage.setItem('nanoflow.project-manifest-watermark.user-123', '2026-02-15T08:00:00.000Z');
      let resolveFirstHeads!: (heads: unknown[]) => void;
      mockSyncService.getUserProjectsWatermark.mockReset();
      mockSyncService.listProjectHeadsSince.mockReset();
      mockSyncService.getUserProjectsWatermark
        .mockResolvedValueOnce('2026-02-15T08:10:00.000Z')
        .mockResolvedValueOnce('2026-02-15T08:20:00.000Z');
      let headsCall = 0;
      mockSyncService.listProjectHeadsSince.mockImplementation(() => {
        headsCall += 1;
        if (headsCall === 1) return new Promise(resolve => {
          resolveFirstHeads = resolve;
        });
        return Promise.resolve([]);
      });

      const first = service.refreshProjectManifestIfNeeded('manifest:race:first');
      await Promise.resolve();
      await Promise.resolve();
      expect(mockSyncService.listProjectHeadsSince).toHaveBeenCalledTimes(1);
      const second = service.refreshProjectManifestIfNeeded('manifest:race:second');

      await second;
      resolveFirstHeads([]);
      await first;

      expect(localStorage.getItem('nanoflow.project-manifest-watermark.user-123')).toBe('2026-02-15T08:20:00.000Z');
    });

    registerSyncCoordinatorBlackBoxWatermarkSpecs(context);
  });


}
