import { describe, expect, it } from 'vitest';

import {
  createDeferred,
  createProject,
  type ProjectOperationServiceSpecContext,
} from './project-operation.test-harness';

export type ProjectOperationSessionRuntimeResetSpecContext = Pick<
  ProjectOperationServiceSpecContext,
  | 'service'
  | 'mockProjectState'
  | 'mockSyncCoordinator'
  | 'mockUserSession'
  | 'mockActionQueue'
  | 'mockOptimisticState'
  | 'mockToast'
>;

export function registerProjectOperationSessionRuntimeResetSpecs(
  getContext: () => ProjectOperationSessionRuntimeResetSpecContext,
): void {
  describe('session runtime reset', () => {
    it('离线快照写入完成前切换会话时不得提交旧项目到新会话', async () => {
      const {
        service,
        mockProjectState,
        mockSyncCoordinator,
        mockUserSession,
        mockOptimisticState,
        mockToast,
      } = getContext();
      const snapshotWrite = createDeferred<void>();
      mockSyncCoordinator.core.saveOfflineSnapshotAndWait.mockReturnValueOnce(snapshotWrite.promise);

      const resultPromise = service.addProject(createProject({ id: 'stale-local-create' }));
      mockUserSession.isSessionContextCurrent.mockReturnValue(false);
      snapshotWrite.resolve();

      await expect(resultPromise).resolves.toEqual({ success: false, error: '会话已切换' });
      expect(mockProjectState.updateProjects).not.toHaveBeenCalled();
      expect(mockProjectState.setActiveProjectId).not.toHaveBeenCalled();
      expect(mockOptimisticState.commitSnapshot).not.toHaveBeenCalled();
      expect(mockOptimisticState.rollbackSnapshot).not.toHaveBeenCalled();
      expect(mockOptimisticState.discardSnapshot).toHaveBeenCalledWith('snap-1');
      expect(mockToast.error).not.toHaveBeenCalled();
    });

    it('旧会话离线快照晚到失败时不得回滚或提示新会话', async () => {
      const {
        service,
        mockProjectState,
        mockSyncCoordinator,
        mockUserSession,
        mockOptimisticState,
        mockToast,
      } = getContext();
      const snapshotWrite = createDeferred<void>();
      mockSyncCoordinator.core.saveOfflineSnapshotAndWait.mockReturnValueOnce(snapshotWrite.promise);

      const resultPromise = service.addProject(createProject({ id: 'stale-local-failure' }));
      mockUserSession.isSessionContextCurrent.mockReturnValue(false);
      snapshotWrite.reject(new Error('late old owner failure'));

      await expect(resultPromise).resolves.toEqual({ success: false, error: '会话已切换' });
      expect(mockProjectState.updateProjects).not.toHaveBeenCalled();
      expect(mockOptimisticState.rollbackSnapshot).not.toHaveBeenCalled();
      expect(mockOptimisticState.discardSnapshot).toHaveBeenCalledWith('snap-1');
      expect(mockToast.error).not.toHaveBeenCalled();
    });

    it('云端 owner 的 durable enqueue 晚到失败时不得回滚新会话', async () => {
      const {
        service,
        mockSyncCoordinator,
        mockUserSession,
        mockActionQueue,
        mockOptimisticState,
        mockToast,
      } = getContext();
      const enqueue = createDeferred<string>();
      mockUserSession.currentUserId.mockReturnValue('cloud-user');
      mockActionQueue.enqueueDurably.mockReturnValueOnce(enqueue.promise);

      const resultPromise = service.addProject(createProject({ id: 'stale-cloud-create' }));
      mockUserSession.isSessionContextCurrent.mockReturnValue(false);
      enqueue.resolve('');

      await expect(resultPromise).resolves.toEqual({ success: false, error: '会话已切换' });
      expect(mockSyncCoordinator.core.saveOfflineSnapshotAndWait).not.toHaveBeenCalled();
      expect(mockOptimisticState.rollbackSnapshot).not.toHaveBeenCalled();
      expect(mockOptimisticState.discardSnapshot).toHaveBeenCalledWith('snap-1');
      expect(mockToast.error).not.toHaveBeenCalled();
    });
  });
}
