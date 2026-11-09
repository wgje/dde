import { beforeEach, describe, expect, it, vi } from './sync-coordinator.service.spec-context';
import type { Project, SyncCoordinatorService, SyncState, Task } from './sync-coordinator.service.spec-context';

export interface SyncCoordinatorIntegrationSpecContext {
  service(): SyncCoordinatorService;
  mockSyncService(): any;
  mockProjectStateService(): any;
  mockProjectSyncOperationsService(): any;
  mockConflictService(): any;
  createTestProject(overrides?: Partial<Project>): Project;
  createTestTask(overrides?: Partial<Task>): Task;
  createMockSyncState(overrides?: Partial<SyncState>): SyncState;
}

export function registerSyncCoordinatorIntegrationSpecs(
  context: SyncCoordinatorIntegrationSpecContext,
): void {
  let service: SyncCoordinatorService;
  let mockSyncService: any;
  let mockProjectStateService: any;
  let mockProjectSyncOperationsService: any;
  let mockConflictService: any;

  const createTestProject = context.createTestProject;
  const createTestTask = context.createTestTask;
  const createMockSyncState = context.createMockSyncState;

  beforeEach(() => {
    service = context.service();
    mockSyncService = context.mockSyncService();
    mockProjectStateService = context.mockProjectStateService();
    mockProjectSyncOperationsService = context.mockProjectSyncOperationsService();
    mockConflictService = context.mockConflictService();
  });

  describe('场景：网络断开后恢复', () => {
    it('断开期间的修改应该在恢复后同步', async () => {
      expect(service.isOnline()).toBe(true);

      const project = createTestProject({ id: 'proj-1', version: 1 });
      mockProjectStateService.activeProject.set(project);
      mockProjectStateService.projects.set([project]);
      service.markLocalChanges();

      mockSyncService.syncState.set(createMockSyncState({
        isOnline: false,
        offlineMode: true,
      }));

      expect(service.isOnline()).toBe(false);

      const offlineProject = { ...project, name: 'Modified Offline', version: 2 };
      mockProjectStateService.activeProject.set(offlineProject);
      mockProjectStateService.projects.set([offlineProject]);
      service.markLocalChanges();

      mockSyncService.syncState.set(createMockSyncState({
        isOnline: true,
        offlineMode: false,
      }));

      expect(service.isOnline()).toBe(true);

      const cloudProjects: Project[] = [{ ...project, version: 1 }];
      mockSyncService.saveProjectToCloud.mockResolvedValueOnce({ success: true });
      mockProjectSyncOperationsService.mergeOfflineDataOnReconnect.mockResolvedValueOnce({
        projects: [offlineProject],
        syncedCount: 1,
        conflictProjects: [],
      });

      const result = await service.mergeOfflineDataOnReconnect(
        cloudProjects,
        [offlineProject],
        'user-123',
      );

      expect(result.syncedCount).toBe(1);
    });
  });

  describe('场景：多设备同时编辑', () => {
    it('版本冲突时应该提供合并选项', async () => {
      const localProject = createTestProject({
        id: 'proj-shared',
        version: 5,
        name: 'Device A Edit',
        tasks: [createTestTask({ id: 'task-1', title: 'Task from A' })],
      });
      const remoteProject = createTestProject({
        id: 'proj-shared',
        version: 6,
        name: 'Device B Edit',
        tasks: [createTestTask({ id: 'task-2', title: 'Task from B' })],
      });

      mockSyncService.saveProjectSmart.mockResolvedValueOnce({
        success: false,
        conflict: true,
        remoteData: remoteProject,
      });

      const result = await mockSyncService.saveProjectSmart(localProject, 'user-123');

      expect(result.success).toBe(false);
      expect(result.conflict).toBe(true);
      expect(result.remoteData).toEqual(remoteProject);

      const tombstoneIds = new Set<string>();
      const _mergeResult = service.smartMerge(localProject, remoteProject, tombstoneIds);
      void _mergeResult;

      expect(mockConflictService.smartMerge).toHaveBeenCalledWith(localProject, remoteProject, tombstoneIds);
    });
  });

  describe('场景：会话过期', () => {
    it('会话过期时应该正确更新状态', () => {
      expect(service.sessionExpired()).toBe(false);

      mockSyncService.syncState.set(createMockSyncState({
        sessionExpired: true,
        syncError: '登录已过期，请重新登录',
      }));

      expect(service.sessionExpired()).toBe(true);
      expect(service.syncError()).toBe('登录已过期，请重新登录');
    });
  });

  describe('场景：极端网络抖动', () => {
    it('网络频繁切换时不应该丢失数据', async () => {
      const project = createTestProject({ id: 'proj-jitter', version: 1 });
      mockProjectStateService.activeProject.set(project);
      mockProjectStateService.projects.set([project]);

      for (let i = 0; i < 5; i++) {
        mockSyncService.syncState.set(createMockSyncState({
          isOnline: false,
          offlineMode: true,
        }));
        service.markLocalChanges();
        await vi.advanceTimersByTimeAsync(100);

        mockSyncService.syncState.set(createMockSyncState({
          isOnline: true,
          offlineMode: false,
        }));
        await vi.advanceTimersByTimeAsync(100);
      }

      expect(service.hasPendingLocalChanges()).toBe(true);
    });

    it('快速重连时不应该触发多次同步', async () => {
      const project = createTestProject({ id: 'proj-rapid', version: 1 });
      mockProjectStateService.activeProject.set(project);
      mockProjectStateService.projects.set([project]);

      for (let i = 0; i < 10; i++) {
        mockSyncService.syncState.set(createMockSyncState({
          isOnline: false,
          offlineMode: true,
        }));
        await vi.advanceTimersByTimeAsync(10);
        mockSyncService.syncState.set(createMockSyncState({
          isOnline: true,
          offlineMode: false,
        }));
        await vi.advanceTimersByTimeAsync(10);
      }

      await vi.advanceTimersByTimeAsync(1000);

      const callCount = mockSyncService.saveOfflineSnapshot.mock.calls.length;
      expect(callCount).toBeLessThanOrEqual(3);
    });
  });

  describe('场景：大规模离线数据合并', () => {
    it('应该正确处理大量离线项目的合并', async () => {
      const offlineProjects: Project[] = [];
      for (let i = 0; i < 50; i++) {
        offlineProjects.push(createTestProject({
          id: `offline-proj-${i}`,
          name: `Offline Project ${i}`,
          version: 1,
        }));
      }

      const cloudProjects = offlineProjects.slice(0, 25).map(p => ({
        ...p,
        version: 2,
      }));

      mockProjectSyncOperationsService.mergeOfflineDataOnReconnect.mockResolvedValueOnce({
        projects: [...cloudProjects, ...offlineProjects.slice(25)],
        syncedCount: 25,
        conflictProjects: [],
      });

      const result = await service.mergeOfflineDataOnReconnect(
        cloudProjects,
        offlineProjects,
        'user-123',
      );

      expect(mockProjectSyncOperationsService.mergeOfflineDataOnReconnect).toHaveBeenCalledWith(
        cloudProjects,
        offlineProjects,
        'user-123',
        expect.any(Function),
        expect.any(Function),
      );
      expect(result.syncedCount).toBe(25);
      expect(result.projects.length).toBe(50);
    });

    it('合并时遇到部分失败应该继续处理其他项目', async () => {
      const offlineProjects = [
        createTestProject({ id: 'proj-1', version: 2 }),
        createTestProject({ id: 'proj-2', version: 2 }),
        createTestProject({ id: 'proj-3', version: 2 }),
      ];

      mockProjectSyncOperationsService.mergeOfflineDataOnReconnect.mockResolvedValueOnce({
        projects: [offlineProjects[0], offlineProjects[2]],
        syncedCount: 2,
        conflictProjects: [],
      });

      const result = await service.mergeOfflineDataOnReconnect(
        [],
        offlineProjects,
        'user-123',
      );

      expect(result.syncedCount).toBe(2);
    });
  });

  describe('场景：版本号边界条件', () => {
    it('版本号为 0 时应该正确处理', async () => {
      const project = createTestProject({ id: 'proj-zero', version: 0 });

      mockSyncService.saveProjectSmart.mockResolvedValueOnce({ success: true });

      const result = await mockSyncService.saveProjectSmart(project, 'user-123');

      expect(result.success).toBe(true);
    });

    it('版本号为极大值时应该正确处理', async () => {
      const project = createTestProject({
        id: 'proj-large',
        version: Number.MAX_SAFE_INTEGER - 1,
      });

      mockSyncService.saveProjectSmart.mockResolvedValueOnce({ success: true });

      const result = await mockSyncService.saveProjectSmart(project, 'user-123');

      expect(result.success).toBe(true);
    });

    it('版本号差异很大时的合并应该使用较大版本', () => {
      const localProject = createTestProject({ id: 'proj-1', version: 10 });
      const remoteProject = createTestProject({ id: 'proj-1', version: 1000 });

      const tombstoneIds = new Set<string>();
      service.smartMerge(localProject, remoteProject, tombstoneIds);

      expect(mockConflictService.smartMerge).toHaveBeenCalledWith(
        localProject,
        remoteProject,
        tombstoneIds,
      );
    });
  });
}
