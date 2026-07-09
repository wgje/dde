import { describe, expect, it } from 'vitest';

import type { Project } from '../models';
import type { ProjectOperationService } from './project-operation.service';
import {
  createDeferred,
  createProject,
  getLastProjectUpdater,
  type MockFn,
  type UpdateProjectsMock,
} from './project-operation.test-harness';

export interface ProjectOperationDeleteSpecContext {
  service: ProjectOperationService;
  mockProjectState: {
    projects: MockFn;
    updateProjects: UpdateProjectsMock;
    setActiveProjectId: MockFn;
    activeProjectId: MockFn;
  };
  mockSyncCoordinator: {
    markLocalChanges: MockFn;
    schedulePersist: MockFn;
    core: {
      deleteProjectFromCloud: MockFn;
      saveOfflineSnapshot: MockFn;
      saveOfflineSnapshotAndWait: MockFn;
    };
  };
  mockUserSession: {
    currentUserId: MockFn;
  };
  mockActionQueue: {
    enqueueDurably: MockFn;
  };
  mockOptimisticState: {
    commitSnapshot: MockFn;
    rollbackSnapshot: MockFn;
  };
  mockToast: {
    error: MockFn;
  };
}

export function registerProjectOperationDeleteSpecs(
  getContext: () => ProjectOperationDeleteSpecContext,
): void {
  describe('delete project persistence', () => {
    it('认证用户删除项目时应持久化 delete 队列且不直接等待云端删除', async () => {
      const {
        service,
        mockActionQueue,
        mockOptimisticState,
        mockSyncCoordinator,
        mockUserSession,
      } = getContext();
      mockUserSession.currentUserId.mockReturnValue('user-1');

      const result = await service.deleteProject('proj-delete-cloud');

      expect(result).toEqual({ success: true });
      expect(mockActionQueue.enqueueDurably).toHaveBeenCalledWith(expect.objectContaining({
        type: 'delete',
        entityType: 'project',
        entityId: 'proj-delete-cloud',
        payload: expect.objectContaining({
          projectId: 'proj-delete-cloud',
          userId: 'user-1',
          sourceUserId: 'user-1',
        }),
      }));
      expect(mockSyncCoordinator.core.deleteProjectFromCloud).not.toHaveBeenCalled();
      expect(mockOptimisticState.commitSnapshot).toHaveBeenCalledWith('snap-1');
      expect(mockOptimisticState.rollbackSnapshot).not.toHaveBeenCalled();
      expect(mockSyncCoordinator.core.saveOfflineSnapshot).toHaveBeenCalled();
    });

    it('认证用户删除项目本地持久成功后应标记并调度后台持久化', async () => {
      const {
        service,
        mockActionQueue,
        mockOptimisticState,
        mockSyncCoordinator,
        mockUserSession,
      } = getContext();
      mockUserSession.currentUserId.mockReturnValue('user-1');

      const result = await service.deleteProject('proj-delete-persist');

      expect(result).toEqual({ success: true });
      expect(mockActionQueue.enqueueDurably).toHaveBeenCalledOnce();
      expect(mockOptimisticState.commitSnapshot).toHaveBeenCalledWith('snap-1');
      expect(mockSyncCoordinator.markLocalChanges).toHaveBeenCalledWith('structure');
      expect(mockSyncCoordinator.schedulePersist).toHaveBeenCalled();
      expect(mockSyncCoordinator.core.saveOfflineSnapshot).toHaveBeenCalled();
    });

    it('认证用户删除项目时应先持久化队列再从本地 UI 移除项目', async () => {
      const {
        service,
        mockActionQueue,
        mockOptimisticState,
        mockProjectState,
        mockUserSession,
      } = getContext();
      const queueWrite = createDeferred<string>();
      mockUserSession.currentUserId.mockReturnValue('user-1');
      mockProjectState.projects.mockReturnValue([
        createProject({ id: 'proj-delete-order' }),
        createProject({ id: 'proj-stays' }),
      ]);
      mockProjectState.activeProjectId.mockReturnValue('proj-delete-order');
      mockActionQueue.enqueueDurably.mockReturnValueOnce(queueWrite.promise);

      const resultPromise = service.deleteProject('proj-delete-order');

      expect(mockActionQueue.enqueueDurably).toHaveBeenCalledOnce();
      expect(mockProjectState.updateProjects).not.toHaveBeenCalled();
      expect(mockProjectState.setActiveProjectId).not.toHaveBeenCalled();

      queueWrite.resolve('queued-action-id');
      await expect(resultPromise).resolves.toEqual({ success: true });

      expect(mockProjectState.updateProjects).toHaveBeenCalledOnce();
      const updater = getLastProjectUpdater(mockProjectState.updateProjects);
      expect(updater([
        createProject({ id: 'proj-delete-order' }),
        createProject({ id: 'proj-stays' }),
      ])).toEqual([
        expect.objectContaining({ id: 'proj-stays' }),
      ]);
      expect(mockProjectState.setActiveProjectId).toHaveBeenCalledWith('proj-stays');
      expect(mockOptimisticState.commitSnapshot).toHaveBeenCalledWith('snap-1');
    });

    it('认证用户删除项目持久队列写入失败时应回滚本地状态', async () => {
      const {
        service,
        mockActionQueue,
        mockOptimisticState,
        mockSyncCoordinator,
        mockToast,
        mockUserSession,
      } = getContext();
      mockUserSession.currentUserId.mockReturnValue('user-1');
      mockActionQueue.enqueueDurably.mockResolvedValueOnce('');

      const result = await service.deleteProject('proj-delete-persist-failed');

      expect(result).toEqual({ success: false, error: '离线删除队列未能写入' });
      expect(mockActionQueue.enqueueDurably).toHaveBeenCalledWith(expect.objectContaining({
        type: 'delete',
        entityType: 'project',
        entityId: 'proj-delete-persist-failed',
      }));
      expect(mockSyncCoordinator.core.deleteProjectFromCloud).not.toHaveBeenCalled();
      expect(mockOptimisticState.rollbackSnapshot).toHaveBeenCalledWith('snap-1', false);
      expect(mockOptimisticState.commitSnapshot).not.toHaveBeenCalled();
      expect(mockToast.error).toHaveBeenCalledWith(
        '本地保存失败',
        '离线删除队列未能写入，请释放浏览器存储空间后重试',
      );
      expect(mockSyncCoordinator.core.saveOfflineSnapshot).toHaveBeenCalled();
    });

    it('本地模式删除项目不写入云端 ActionQueue', async () => {
      const {
        service,
        mockActionQueue,
        mockOptimisticState,
        mockSyncCoordinator,
      } = getContext();

      const result = await service.deleteProject('proj-delete-local');

      expect(result).toEqual({ success: true });
      expect(mockActionQueue.enqueueDurably).not.toHaveBeenCalled();
      expect(mockSyncCoordinator.core.deleteProjectFromCloud).not.toHaveBeenCalled();
      expect(mockOptimisticState.commitSnapshot).toHaveBeenCalledWith('snap-1');
      expect(mockSyncCoordinator.core.saveOfflineSnapshot).toHaveBeenCalled();
    });

    it('本地模式删除项目应先等待离线快照持久化再从 UI 移除', async () => {
      const {
        service,
        mockOptimisticState,
        mockProjectState,
        mockSyncCoordinator,
      } = getContext();
      const snapshotWrite = createDeferred<void>();
      mockProjectState.projects.mockReturnValue([
        createProject({ id: 'proj-local-delete' }),
        createProject({ id: 'proj-local-stays' }),
      ]);
      mockProjectState.activeProjectId.mockReturnValue('proj-local-delete');
      mockSyncCoordinator.core.saveOfflineSnapshotAndWait.mockReturnValueOnce(snapshotWrite.promise);

      const resultPromise = service.deleteProject('proj-local-delete');

      expect(mockSyncCoordinator.core.saveOfflineSnapshotAndWait).toHaveBeenCalledWith([
        expect.objectContaining({ id: 'proj-local-stays' }),
      ]);
      expect(mockProjectState.updateProjects).not.toHaveBeenCalled();
      expect(mockProjectState.setActiveProjectId).not.toHaveBeenCalled();
      expect(mockOptimisticState.commitSnapshot).not.toHaveBeenCalled();

      snapshotWrite.resolve();
      await expect(resultPromise).resolves.toEqual({ success: true });

      expect(mockProjectState.updateProjects).toHaveBeenCalledOnce();
      const updater = getLastProjectUpdater(mockProjectState.updateProjects);
      expect(updater([
        createProject({ id: 'proj-local-delete' }),
        createProject({ id: 'proj-local-stays' }),
      ])).toEqual([
        expect.objectContaining({ id: 'proj-local-stays' }),
      ]);
      expect(mockProjectState.setActiveProjectId).toHaveBeenCalledWith('proj-local-stays');
      expect(mockOptimisticState.commitSnapshot).toHaveBeenCalledWith('snap-1');
    });
  });
}
