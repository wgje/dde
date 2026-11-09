import { AUTH_CONFIG, beforeEach, describe, expect, FEATURE_FLAGS, it, vi } from './sync-coordinator.service.spec-context';
import type { Project, SyncCoordinatorService, Task } from './sync-coordinator.service.spec-context';
import { registerSyncCoordinatorBlackBoxWatermarkSpecs } from './sync-coordinator-offline-merge-black-box-watermark.spec-helpers';
import { registerSyncCoordinatorRefreshWatermarkSpecs } from './sync-coordinator-refresh-watermark.spec-helpers';

export interface SyncCoordinatorOfflineMergeSpecContext {
  service(): SyncCoordinatorService;
  mockSyncService(): any;
  mockTaskSyncOperationsService(): any;
  mockProjectStateService(): any;
  mockAuthService(): any;
  mockActionQueueService(): any;
  mockRetryQueueService(): any;
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

    registerSyncCoordinatorRefreshWatermarkSpecs(context);

    registerSyncCoordinatorBlackBoxWatermarkSpecs(context);
  });


}
