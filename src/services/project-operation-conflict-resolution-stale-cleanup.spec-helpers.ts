import { expect, it, vi } from 'vitest';
import { createProject, getLastProjectUpdater, type UpdateProjectsMock } from './project-operation.test-harness';
import type { ProjectOperationConflictResolutionSpecContext } from './project-operation-conflict-resolution.spec-context';

export function registerProjectOperationConflictResolutionStaleCleanupSpecs(
  getContext: () => ProjectOperationConflictResolutionSpecContext,
): void {
  it('resolveConflict 在 saveProjectSmart 成功后若会话已过期，应先回写 pendingTaskDeleteIds 到原 owner 队列', async () => {
    const {
      service,
      projectConflict,
      mockProjectState,
      mockSyncCoordinator,
      mockUserSession,
      mockConflictStorage,
      mockActionQueue,
      mockChangeTracker,
    } = getContext();
    mockSyncCoordinator.conflictData.mockReturnValueOnce({
      projectId: 'proj-stale-after-save',
      conflictedAt: '2026-03-30T00:00:00.000Z',
      local: createProject({ id: 'proj-stale-after-save', name: 'Local Conflict' }),
      remote: createProject({ id: 'proj-stale-after-save', name: 'Remote Conflict', version: 3 }),
      pendingTaskDeleteIds: ['task-delete-stale'],
      pendingTaskDeleteBaseUpdatedAtMap: {
        'task-delete-stale': '2026-04-01T00:00:00.000Z',
      },
    });
    mockConflictStorage.getConflict.mockResolvedValue({
      projectId: 'proj-stale-after-save',
      localProject: createProject({ id: 'proj-stale-after-save', name: 'Local Conflict' }),
      remoteProject: createProject({ id: 'proj-stale-after-save', name: 'Remote Conflict', version: 3 }),
      conflictedAt: '2026-03-30T00:00:00.000Z',
      localVersion: 1,
      remoteVersion: 3,
      pendingTaskDeleteIds: ['task-delete-stale'],
      pendingTaskDeleteBaseUpdatedAtMap: {
        'task-delete-stale': '2026-04-01T00:00:00.000Z',
      },
    });
    mockProjectState.getProject.mockReturnValue(createProject({ id: 'proj-stale-after-save', name: 'Local Conflict' }));
    mockSyncCoordinator.resolveConflict.mockResolvedValueOnce({
      ok: true,
      value: createProject({ id: 'proj-stale-after-save', name: 'Resolved Conflict', version: 4 }),
    });
    mockUserSession.currentUserId.mockReturnValue('user-1');
    mockSyncCoordinator.core.saveProjectSmart.mockResolvedValueOnce({
      success: true,
      newVersion: 10,
    });
    vi.spyOn(projectConflict, 'isProjectSessionContextCurrent').mockImplementation(
      (_context, stage) => stage !== 'resolveConflict:saveProjectSmart',
    );
    const resolved = await service.resolveConflict('proj-stale-after-save', 'local');
    expect(resolved).toBe(true);
    const updater = getLastProjectUpdater(mockProjectState.updateProjects as UpdateProjectsMock);
    expect(mockActionQueue.enqueueForOwner).toHaveBeenCalledWith('user-1', expect.objectContaining({
      type: 'update',
      entityType: 'project',
      entityId: 'proj-stale-after-save',
      payload: expect.objectContaining({
        taskIdsToDelete: ['task-delete-stale'],
        taskDeleteBaseUpdatedAtMap: {
          'task-delete-stale': '2026-04-01T00:00:00.000Z',
        },
      }),
    }));
    expect(mockConflictStorage.deleteConflict).toHaveBeenCalledWith('proj-stale-after-save', 'user-1');
    expect(mockChangeTracker.clearProjectFieldLocks).toHaveBeenCalledWith('proj-stale-after-save');
    expect(mockChangeTracker.clearProjectChanges).not.toHaveBeenCalledWith('proj-stale-after-save');
    expect(mockSyncCoordinator.core.deleteTask).not.toHaveBeenCalled();
    expect(updater([createProject({ id: 'proj-stale-after-save', name: 'Newest Local Conflict', pendingSync: false, syncSource: 'synced' })])).toEqual([
      expect.objectContaining({
        id: 'proj-stale-after-save',
        name: 'Newest Local Conflict',
        version: 10,
        pendingSync: true,
        syncSource: 'synced',
      }),
    ]);
  });

  it('resolveConflict 在 saveProjectSmart terminal 且同 owner stale 时仍应清理冲突记录和锁', async () => {
    const {
      service,
      projectConflict,
      mockProjectState,
      mockSyncCoordinator,
      mockUserSession,
      mockConflictStorage,
      mockActionQueue,
      mockChangeTracker,
    } = getContext();
    mockSyncCoordinator.conflictData.mockReturnValueOnce({
      projectId: 'proj-stale-terminal-resolve',
      conflictedAt: '2026-03-30T00:00:00.000Z',
      local: createProject({ id: 'proj-stale-terminal-resolve', name: 'Local Conflict', pendingSync: true }),
      remote: createProject({ id: 'proj-stale-terminal-resolve', name: 'Remote Conflict', version: 3 }),
    });
    mockConflictStorage.getConflict.mockResolvedValue({
      projectId: 'proj-stale-terminal-resolve',
      localProject: createProject({ id: 'proj-stale-terminal-resolve', name: 'Local Conflict', pendingSync: true }),
      remoteProject: createProject({ id: 'proj-stale-terminal-resolve', name: 'Remote Conflict', version: 3 }),
      conflictedAt: '2026-03-30T00:00:00.000Z',
      localVersion: 1,
      remoteVersion: 3,
    });
    mockProjectState.getProject
      .mockReturnValueOnce(createProject({ id: 'proj-stale-terminal-resolve', name: 'Local Conflict', pendingSync: true }))
      .mockReturnValue(createProject({ id: 'proj-stale-terminal-resolve', name: 'Resolved Conflict', version: 4, pendingSync: true, syncSource: 'synced' }));
    mockSyncCoordinator.resolveConflict.mockResolvedValueOnce({
      ok: true,
      value: createProject({ id: 'proj-stale-terminal-resolve', name: 'Resolved Conflict', version: 4, pendingSync: true }),
    });
    mockUserSession.currentUserId.mockReturnValue('user-1');
    mockSyncCoordinator.core.saveProjectSmart.mockResolvedValueOnce({
      success: false,
      terminal: true,
      failureReason: '当前客户端同步协议已过期，请刷新后重试',
    });
    vi.spyOn(projectConflict, 'isProjectSessionContextCurrent').mockImplementation(
      (_context, stage) => stage !== 'resolveConflict:saveProjectSmart',
    );
    const resolved = await service.resolveConflict('proj-stale-terminal-resolve', 'local');
    expect(resolved).toBe(true);
    const updater = getLastProjectUpdater(mockProjectState.updateProjects as UpdateProjectsMock);
    expect(mockConflictStorage.deleteConflict).toHaveBeenCalledWith('proj-stale-terminal-resolve', 'user-1');
    expect(mockChangeTracker.clearProjectFieldLocks).toHaveBeenCalledWith('proj-stale-terminal-resolve');
    expect(mockChangeTracker.clearProjectChanges).toHaveBeenCalledWith('proj-stale-terminal-resolve');
    expect(mockActionQueue.enqueue).not.toHaveBeenCalled();
    expect(updater([createProject({ id: 'proj-stale-terminal-resolve', name: 'Newest Local Conflict', pendingSync: true, syncSource: 'synced' })])).toEqual([
      expect.objectContaining({
        id: 'proj-stale-terminal-resolve',
        name: 'Newest Local Conflict',
        pendingSync: false,
        syncSource: 'synced',
      }),
    ]);
  });

  it('resolveConflict 在 delete-conflict gate 才变 stale 且同 owner 时仍应清理冲突记录', async () => {
    const {
      service,
      projectConflict,
      mockProjectState,
      mockSyncCoordinator,
      mockUserSession,
      mockConflictStorage,
      mockChangeTracker,
    } = getContext();
    mockSyncCoordinator.conflictData.mockReturnValueOnce({
      projectId: 'proj-late-stale-cleanup',
      conflictedAt: '2026-03-30T00:00:00.000Z',
      local: createProject({ id: 'proj-late-stale-cleanup', name: 'Local Conflict', pendingSync: true }),
      remote: createProject({ id: 'proj-late-stale-cleanup', name: 'Remote Conflict', version: 3 }),
    });
    mockConflictStorage.getConflict.mockResolvedValue({
      projectId: 'proj-late-stale-cleanup',
      localProject: createProject({ id: 'proj-late-stale-cleanup', name: 'Local Conflict', pendingSync: true }),
      remoteProject: createProject({ id: 'proj-late-stale-cleanup', name: 'Remote Conflict', version: 3 }),
      conflictedAt: '2026-03-30T00:00:00.000Z',
      localVersion: 1,
      remoteVersion: 3,
    });
    mockProjectState.getProject.mockReturnValue(createProject({ id: 'proj-late-stale-cleanup', name: 'Local Conflict', pendingSync: true }));
    mockSyncCoordinator.resolveConflict.mockResolvedValueOnce({
      ok: true,
      value: createProject({ id: 'proj-late-stale-cleanup', name: 'Resolved Conflict', version: 4, pendingSync: true }),
    });
    mockUserSession.currentUserId.mockReturnValue('user-1');
    mockSyncCoordinator.core.saveProjectSmart.mockResolvedValueOnce({
      success: true,
      newVersion: 11,
    });
    vi.spyOn(projectConflict, 'isProjectSessionContextCurrent').mockImplementation(
      (_context, stage) => stage !== 'resolveConflict:delete-conflict',
    );
    const resolved = await service.resolveConflict('proj-late-stale-cleanup', 'local');
    expect(resolved).toBe(true);
    expect(mockConflictStorage.deleteConflict).toHaveBeenCalledWith('proj-late-stale-cleanup', 'user-1');
    expect(mockChangeTracker.clearProjectFieldLocks).toHaveBeenCalledWith('proj-late-stale-cleanup');
    expect(mockChangeTracker.clearProjectChanges).toHaveBeenCalledWith('proj-late-stale-cleanup');
  });
}
