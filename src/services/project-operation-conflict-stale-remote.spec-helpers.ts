import { expect, it } from 'vitest';

import type { Project } from '../models';
import type { ProjectOperationService } from './project-operation.service';
import { createProject, type MockFn } from './project-operation.test-harness';

export interface ProjectOperationConflictStaleRemoteSpecContext {
  service: ProjectOperationService;
  mockProjectState: {
    activeProjectId: MockFn;
    getProject: MockFn;
  };
  mockSyncCoordinator: {
    conflictData: MockFn;
    resolveConflict: MockFn;
    captureConflict: MockFn;
    clearActiveConflict: MockFn;
    loadSingleProjectFromCloud: MockFn;
    core: {
      saveProjectSmart: MockFn;
    };
  };
  mockUserSession: {
    currentUserId: MockFn;
    isSessionContextCurrent: MockFn;
  };
  mockConflictStorage: {
    getConflict: MockFn;
    saveConflict: MockFn;
  };
  mockActionQueue: {
    enqueueDurably: MockFn;
  };
  mockProjectConflictDirectSync: { executeDurably: MockFn };
  mockToast: {
    error: MockFn;
  };
}

export function registerProjectOperationConflictStaleRemoteSpecs(
  getContext: () => ProjectOperationConflictStaleRemoteSpecContext,
): void {
  it('解决冲突后二次冲突且缺少 remoteData 时应降级为 stale 冲突记录', async () => {
    const {
      service,
      mockConflictStorage,
      mockProjectState,
      mockSyncCoordinator,
      mockUserSession,
      mockProjectConflictDirectSync,
    } = getContext();
    const existingRemote = createProject({ id: 'proj-conflict', name: 'Remote Existing', version: 4 });
    mockSyncCoordinator.conflictData.mockReturnValueOnce({
      projectId: 'proj-conflict',
      local: createProject({ id: 'proj-conflict', name: 'Local Existing' }),
      remote: existingRemote,
    });
    mockConflictStorage.getConflict.mockResolvedValueOnce({
      projectId: 'proj-conflict',
      localProject: createProject({ id: 'proj-conflict', name: 'Local Existing' }),
      remoteProject: existingRemote,
      pendingTaskDeleteIds: ['task-delete-1'],
    });
    mockProjectState.getProject.mockReturnValue(createProject({ id: 'proj-conflict', name: 'Local Existing' }));
    mockProjectState.activeProjectId.mockReturnValue('proj-conflict');
    mockSyncCoordinator.resolveConflict.mockResolvedValueOnce({
      ok: true,
      value: createProject({ id: 'proj-conflict', name: 'Resolved Local', version: 5 }),
    });
    mockUserSession.currentUserId.mockReturnValue('user-1');
    mockProjectConflictDirectSync.executeDurably.mockResolvedValueOnce({ status: 'deferred' });

    await service.resolveConflict('proj-conflict', 'local');

    expect(mockConflictStorage.saveConflict).not.toHaveBeenCalled();
    expect(mockSyncCoordinator.captureConflict).not.toHaveBeenCalled();
    expect(mockSyncCoordinator.clearActiveConflict).not.toHaveBeenCalled();
  });

  it('解决冲突后的二次冲突若已属于旧会话，不应写入当前冲突链', async () => {
    const {
      service,
      mockConflictStorage,
      mockProjectState,
      mockSyncCoordinator,
      mockToast,
      mockUserSession,
    } = getContext();
    mockSyncCoordinator.conflictData.mockReturnValueOnce({
      projectId: 'proj-conflict-stale',
      local: createProject({ id: 'proj-conflict-stale', name: 'Local Existing' }),
      remote: createProject({ id: 'proj-conflict-stale', name: 'Remote Existing', version: 4 }),
    });
    mockConflictStorage.getConflict.mockResolvedValueOnce({
      projectId: 'proj-conflict-stale',
      localProject: createProject({ id: 'proj-conflict-stale', name: 'Local Existing' }),
      remoteProject: createProject({ id: 'proj-conflict-stale', name: 'Remote Existing', version: 4 }),
    });
    mockProjectState.getProject.mockReturnValue(createProject({ id: 'proj-conflict-stale', name: 'Local Existing' }));
    mockSyncCoordinator.resolveConflict.mockResolvedValueOnce({
      ok: true,
      value: createProject({ id: 'proj-conflict-stale', name: 'Resolved Local', version: 5 }),
    });
    mockUserSession.currentUserId.mockReturnValue('user-1');
    mockSyncCoordinator.core.saveProjectSmart.mockResolvedValueOnce({
      success: false,
      conflict: true,
      remoteData: createProject({ id: 'proj-conflict-stale', name: 'Remote Existing', version: 6 }),
    });
    mockUserSession.isSessionContextCurrent.mockReturnValueOnce(false);

    const result = await service.resolveConflict('proj-conflict-stale', 'local');

    expect(result).toBe(false);
    expect(mockSyncCoordinator.captureConflict).not.toHaveBeenCalled();
    expect(mockConflictStorage.saveConflict).not.toHaveBeenCalled();
    expect(mockToast.error).not.toHaveBeenCalledWith('同步冲突', expect.any(String));
  });

  it('冲突 fallback 落盘后若会话已切换，不应清空当前 active conflict', async () => {
    const {
      service,
      mockConflictStorage,
      mockProjectState,
      mockSyncCoordinator,
      mockToast,
      mockUserSession,
    } = getContext();
    const fallbackRemote = createProject({ id: 'proj-conflict-fallback-stale', name: 'Remote Existing', version: 4 });
    mockSyncCoordinator.conflictData.mockReturnValueOnce({
      projectId: 'proj-conflict-fallback-stale',
      local: createProject({ id: 'proj-conflict-fallback-stale', name: 'Local Existing' }),
      remote: fallbackRemote,
    });
    mockConflictStorage.getConflict.mockResolvedValueOnce({
      projectId: 'proj-conflict-fallback-stale',
      localProject: createProject({ id: 'proj-conflict-fallback-stale', name: 'Local Existing' }),
      remoteProject: fallbackRemote,
    });
    mockProjectState.getProject.mockReturnValue(createProject({ id: 'proj-conflict-fallback-stale', name: 'Local Existing' }));
    mockSyncCoordinator.resolveConflict.mockResolvedValueOnce({
      ok: true,
      value: createProject({ id: 'proj-conflict-fallback-stale', name: 'Resolved Local', version: 5 }),
    });
    mockUserSession.currentUserId.mockReturnValue('user-1');
    mockSyncCoordinator.core.saveProjectSmart.mockResolvedValueOnce({
      success: false,
      conflict: true,
    });
    mockSyncCoordinator.loadSingleProjectFromCloud.mockResolvedValueOnce(null);

    const sessionStates = [true, true, true, true, true, true, false];
    mockUserSession.isSessionContextCurrent.mockImplementation(() => sessionStates.shift() ?? false);

    const result = await service.resolveConflict('proj-conflict-fallback-stale', 'local');

    expect(result).toBe(true);
    expect(mockConflictStorage.saveConflict).not.toHaveBeenCalled();
    expect(mockSyncCoordinator.clearActiveConflict).not.toHaveBeenCalled();
    expect(mockToast.error).not.toHaveBeenCalledWith('同步冲突', expect.any(String));
  });

  it('stale remote 快照不应直接用于下一次 remote 解决', async () => {
    const {
      service,
      mockConflictStorage,
      mockProjectState,
      mockSyncCoordinator,
      mockToast,
    } = getContext();
    mockSyncCoordinator.conflictData.mockReturnValueOnce({
      projectId: 'proj-stale',
      local: createProject({ id: 'proj-stale', name: 'Local Stale' }),
      remote: undefined,
    });
    mockConflictStorage.getConflict.mockResolvedValueOnce({
      projectId: 'proj-stale',
      localProject: createProject({ id: 'proj-stale', name: 'Local Stale' }),
      remoteProject: createProject({ id: 'proj-stale', name: 'Old Remote', version: 4 }),
      remoteSnapshotFresh: false,
    });
    mockProjectState.getProject.mockReturnValue(createProject({ id: 'proj-stale', name: 'Local Stale' }));
    mockSyncCoordinator.loadSingleProjectFromCloud.mockResolvedValueOnce(null);

    await service.resolveConflict('proj-stale', 'remote');

    expect(mockSyncCoordinator.resolveConflict).not.toHaveBeenCalled();
    expect(mockToast.error).toHaveBeenCalledWith('冲突解决失败', '远端版本暂不可用，请稍后重试，或先保留本地版本');
  });

  it('缺少 freshness 标记的存量 remote 快照也应重新拉取', async () => {
    const {
      service,
      mockConflictStorage,
      mockProjectState,
      mockSyncCoordinator,
    } = getContext();
    mockSyncCoordinator.conflictData.mockReturnValueOnce({
      projectId: 'proj-unknown-freshness',
      local: createProject({ id: 'proj-unknown-freshness', name: 'Local Unknown' }),
      remote: undefined,
    });
    mockConflictStorage.getConflict.mockResolvedValueOnce({
      projectId: 'proj-unknown-freshness',
      localProject: createProject({ id: 'proj-unknown-freshness', name: 'Local Unknown' }),
      remoteProject: createProject({ id: 'proj-unknown-freshness', name: 'Old Remote', version: 4 }),
    });
    mockProjectState.getProject.mockReturnValue(createProject({ id: 'proj-unknown-freshness', name: 'Local Unknown' }));
    mockSyncCoordinator.loadSingleProjectFromCloud.mockResolvedValueOnce(null);

    await service.resolveConflict('proj-unknown-freshness', 'remote');

    expect(mockSyncCoordinator.loadSingleProjectFromCloud).toHaveBeenCalledWith('proj-unknown-freshness');
    expect(mockSyncCoordinator.resolveConflict).not.toHaveBeenCalled();
  });

  it('active conflict 自带 remote 快照时应优先使用，不受存量 freshness 标记影响', async () => {
    const {
      service,
      mockConflictStorage,
      mockProjectState,
      mockSyncCoordinator,
    } = getContext();
    mockSyncCoordinator.conflictData.mockReturnValueOnce({
      projectId: 'proj-active-remote',
      local: createProject({ id: 'proj-active-remote', name: 'Local Active' }),
      remote: createProject({ id: 'proj-active-remote', name: 'Fresh Active Remote', version: 6 }),
    });
    mockConflictStorage.getConflict.mockResolvedValueOnce({
      projectId: 'proj-active-remote',
      localProject: createProject({ id: 'proj-active-remote', name: 'Local Active' }),
      remoteProject: createProject({ id: 'proj-active-remote', name: 'Stale Stored Remote', version: 3 }),
    });
    mockProjectState.getProject.mockReturnValue(createProject({ id: 'proj-active-remote', name: 'Local Active' }));
    mockSyncCoordinator.resolveConflict.mockResolvedValueOnce({
      ok: true,
      value: createProject({ id: 'proj-active-remote', name: 'Fresh Active Remote', version: 6 }),
    });

    await service.resolveConflict('proj-active-remote', 'remote');

    expect(mockSyncCoordinator.loadSingleProjectFromCloud).not.toHaveBeenCalled();
    expect(mockSyncCoordinator.resolveConflict).toHaveBeenCalledWith(
      'proj-active-remote',
      'remote',
      expect.objectContaining({ id: 'proj-active-remote', name: 'Local Active' }),
      expect.objectContaining({ id: 'proj-active-remote', name: 'Fresh Active Remote', version: 6 }),
    );
  });

  it('导入前台不再直接处理 fresh remoteData 冲突，应写入后台队列', async () => {
    const {
      service,
      mockActionQueue,
      mockProjectState,
      mockSyncCoordinator,
      mockUserSession,
    } = getContext();
    mockUserSession.currentUserId.mockReturnValue('user-1');
    mockProjectState.getProject.mockReturnValue(createProject({ id: 'proj-1', name: 'Existing' }));
    mockSyncCoordinator.core.saveProjectSmart.mockResolvedValueOnce({
      success: false,
      conflict: true,
      remoteData: createProject({ id: 'proj-1', name: 'Remote Existing', version: 2 }),
    });

    const result = await service.upsertImportedProject(createProject({ id: 'proj-1', name: 'Imported' }));

    expect(result.success).toBe(true);
    expect(mockSyncCoordinator.core.saveProjectSmart).not.toHaveBeenCalled();
    expect(mockSyncCoordinator.captureConflict).not.toHaveBeenCalled();
    expect(mockActionQueue.enqueueDurably).toHaveBeenCalledWith(expect.objectContaining({
      type: 'update',
      entityType: 'project',
      entityId: 'proj-1',
      payload: expect.objectContaining({ sourceUserId: 'user-1' }),
    }));
  });
}
