import { describe, expect, it, beforeEach } from 'vitest';
import {
  createDeferred,
  createProject,
  createProjectOperationServiceSpecContext,
  getLastProjectUpdater,
  getProjectUpdater,
  type ProjectOperationServiceSpecContext,
} from './project-operation.test-harness';
import {
  registerProjectOperationConflictStaleRemoteSpecs,
  type ProjectOperationConflictStaleRemoteSpecContext,
} from './project-operation-conflict-stale-remote.spec-helpers';
import {
  registerProjectOperationConflictResolutionSpecs,
  type ProjectOperationConflictResolutionSpecContext,
} from './project-operation-conflict-resolution.spec-helpers';
import {
  registerProjectOperationDeleteSpecs,
  type ProjectOperationDeleteSpecContext,
} from './project-operation-delete.spec-helpers';

describe('ProjectOperationService', () => {
  let service: ProjectOperationServiceSpecContext['service'];
  let projectConflict: ProjectOperationServiceSpecContext['projectConflict'];
  let mockProjectState: ProjectOperationServiceSpecContext['mockProjectState'];
  let mockSyncCoordinator: ProjectOperationServiceSpecContext['mockSyncCoordinator'];
  let mockUserSession: ProjectOperationServiceSpecContext['mockUserSession'];
  let mockWriteGuard: ProjectOperationServiceSpecContext['mockWriteGuard'];
  let mockActionQueue: ProjectOperationServiceSpecContext['mockActionQueue'];
  let mockRetryQueue: ProjectOperationServiceSpecContext['mockRetryQueue'];
  let mockConflictStorage: ProjectOperationServiceSpecContext['mockConflictStorage'];
  let mockOptimisticState: ProjectOperationServiceSpecContext['mockOptimisticState'];
  let mockChangeTracker: ProjectOperationServiceSpecContext['mockChangeTracker'];
  let mockToast: ProjectOperationServiceSpecContext['mockToast'];

  beforeEach(() => {
    ({
      service,
      projectConflict,
      mockProjectState,
      mockSyncCoordinator,
      mockUserSession,
      mockWriteGuard,
      mockActionQueue,
      mockRetryQueue,
      mockConflictStorage,
      mockOptimisticState,
      mockChangeTracker,
      mockToast,
    } = createProjectOperationServiceSpecContext());
  });

  function getConflictStaleRemoteSpecContext(): ProjectOperationConflictStaleRemoteSpecContext {
    return {
      service,
      mockProjectState,
      mockSyncCoordinator,
      mockUserSession,
      mockConflictStorage,
      mockActionQueue,
      mockToast,
    };
  }

  function getConflictResolutionSpecContext(): ProjectOperationConflictResolutionSpecContext {
    return {
      service,
      projectConflict,
      mockProjectState,
      mockSyncCoordinator,
      mockUserSession,
      mockConflictStorage,
      mockActionQueue,
      mockRetryQueue,
      mockChangeTracker,
      mockToast,
    };
  }

  function getDeleteSpecContext(): ProjectOperationDeleteSpecContext {
    return {
      service,
      mockProjectState,
      mockSyncCoordinator,
      mockUserSession,
      mockActionQueue,
      mockOptimisticState,
      mockToast,
    };
  }

  it('resolveConflict 在 backgroundPersist 模式下不应等待 saveProjectSmart 完成', async () => {
    const deferred = createDeferred();

    mockConflictStorage.getConflict.mockResolvedValueOnce({
      projectId: 'proj-bg',
      localProject: createProject({ id: 'proj-bg', name: 'Local Conflict' }),
      remoteProject: createProject({ id: 'proj-bg', name: 'Remote Conflict', version: 3 }),
      conflictedAt: '2026-03-30T00:00:00.000Z',
      localVersion: 1,
      remoteVersion: 3,
    });
    mockProjectState.getProject.mockReturnValue(createProject({ id: 'proj-bg', name: 'Local Conflict' }));
    mockSyncCoordinator.resolveConflict.mockResolvedValueOnce({
      ok: true,
      value: createProject({ id: 'proj-bg', name: 'Resolved Conflict', version: 4 }),
    });
    mockUserSession.currentUserId.mockReturnValue('user-1');
    mockSyncCoordinator.core.saveProjectSmart.mockReturnValueOnce(deferred.promise as never);

    const resolved = await service.resolveConflict('proj-bg', 'local', { backgroundPersist: true });

    expect(resolved).toBe(true);
    expect(mockSyncCoordinator.core.saveProjectSmart).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'proj-bg', name: 'Resolved Conflict' }),
      'user-1',
    );

    deferred.resolve({ success: true, newVersion: 10 });
    await Promise.resolve();
  });

  it('resolveConflict 在 backgroundPersist 模式下应先写入 durable 恢复点再关闭冲突', async () => {
    mockConflictStorage.getConflict.mockResolvedValueOnce({
      projectId: 'proj-bg-queue-fail',
      localProject: createProject({ id: 'proj-bg-queue-fail', name: 'Local Conflict' }),
      remoteProject: createProject({ id: 'proj-bg-queue-fail', name: 'Remote Conflict', version: 3 }),
      conflictedAt: '2026-03-30T00:00:00.000Z',
      localVersion: 1,
      remoteVersion: 3,
    });
    mockProjectState.getProject.mockReturnValue(createProject({ id: 'proj-bg-queue-fail', name: 'Local Conflict' }));
    mockSyncCoordinator.resolveConflict.mockResolvedValueOnce({
      ok: true,
      value: createProject({ id: 'proj-bg-queue-fail', name: 'Resolved Conflict', version: 4 }),
    });
    mockUserSession.currentUserId.mockReturnValue('user-1');
    mockActionQueue.enqueueDurably.mockResolvedValueOnce('');

    const resolved = await service.resolveConflict('proj-bg-queue-fail', 'local', { backgroundPersist: true });

    expect(resolved).toBe(false);
    expect(mockSyncCoordinator.core.saveProjectSmart).not.toHaveBeenCalled();
    expect(mockProjectState.updateProjects).not.toHaveBeenCalled();
    expect(mockConflictStorage.deleteConflict).not.toHaveBeenCalledWith('proj-bg-queue-fail', 'user-1');
    expect(mockSyncCoordinator.clearActiveConflict).not.toHaveBeenCalled();
    expect(mockToast.error).toHaveBeenCalledWith(
      '本地保存失败',
      '冲突解决结果未能写入离线同步队列，请释放浏览器存储空间后重试',
    );
  });

  it('本地模式创建项目失败时不应写入云端 ActionQueue', async () => {
    await service.addProject(createProject({ id: 'proj-local-only' }));

    expect(mockSyncCoordinator.core.saveProjectSmart).not.toHaveBeenCalled();
    expect(mockActionQueue.enqueue).not.toHaveBeenCalled();
    expect(mockOptimisticState.commitSnapshot).toHaveBeenCalled();
    expect(mockSyncCoordinator.markLocalChanges).toHaveBeenCalledWith('structure');
    expect(mockSyncCoordinator.schedulePersist).toHaveBeenCalled();
  });

  it('本地模式创建项目应先等待离线快照持久化再暴露 UI 新项目', async () => {
    const snapshotWrite = createDeferred<void>();
    mockSyncCoordinator.core.saveOfflineSnapshotAndWait.mockReturnValueOnce(snapshotWrite.promise);

    const resultPromise = service.addProject(createProject({ id: 'proj-local-durable-create' }));

    expect(mockSyncCoordinator.core.saveOfflineSnapshotAndWait).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 'proj-local-durable-create',
        syncSource: 'local-only',
        pendingSync: false,
      }),
    ]);
    expect(mockProjectState.updateProjects).not.toHaveBeenCalled();
    expect(mockProjectState.setActiveProjectId).not.toHaveBeenCalled();
    expect(mockOptimisticState.commitSnapshot).not.toHaveBeenCalled();

    snapshotWrite.resolve();
    await expect(resultPromise).resolves.toEqual({ success: true });

    expect(mockProjectState.updateProjects).toHaveBeenCalledOnce();
    const updater = getLastProjectUpdater(mockProjectState.updateProjects);
    expect(updater([])).toEqual([
      expect.objectContaining({ id: 'proj-local-durable-create' }),
    ]);
    expect(mockProjectState.setActiveProjectId).toHaveBeenCalledWith('proj-local-durable-create');
    expect(mockOptimisticState.commitSnapshot).toHaveBeenCalledWith('snap-1');
  });

  it('本地模式创建项目离线快照持久化失败时不应提交 UI 或成功结果', async () => {
    mockSyncCoordinator.core.saveOfflineSnapshotAndWait.mockRejectedValueOnce(new Error('idb unavailable'));

    const result = await service.addProject(createProject({ id: 'proj-local-create-failed' }));

    expect(result).toEqual({ success: false, error: '离线快照未能写入' });
    expect(mockProjectState.updateProjects).not.toHaveBeenCalled();
    expect(mockProjectState.setActiveProjectId).not.toHaveBeenCalled();
    expect(mockOptimisticState.rollbackSnapshot).toHaveBeenCalledWith('snap-1', false);
    expect(mockOptimisticState.commitSnapshot).not.toHaveBeenCalled();
    expect(mockToast.error).toHaveBeenCalledWith(
      '本地保存失败',
      '离线快照未能写入，请释放浏览器存储空间后重试',
    );
  });

  it('hint-only 启动占位下创建项目应被只读门控阻止', async () => {
    mockUserSession.isHintOnlyStartupPlaceholderVisible.mockReturnValue(true);

    const result = await service.addProject(createProject({ id: 'proj-hint-only' }));

    expect(result).toEqual({ success: false, error: '会话确认中，owner 确认完成前暂时只读' });
    expect(mockProjectState.updateProjects).not.toHaveBeenCalled();
    expect(mockOptimisticState.createSnapshot).not.toHaveBeenCalled();
    expect(mockToast.info).toHaveBeenCalledWith('会话确认中', '创建项目暂不可用，owner 确认完成前保持只读');
  });

  it('export-only 旧入口下应阻止本地项目写入', async () => {
    mockWriteGuard.isExportOnly.mockReturnValue(true);

    const result = await service.addProject(createProject({ id: 'proj-export-only' }));
    await service.updateProjectMetadata('proj-export-only', { description: 'blocked' });

    expect(result).toEqual({ success: false, error: '导出模式下禁止本地写入' });
    expect(mockProjectState.updateProjects).not.toHaveBeenCalled();
    expect(mockOptimisticState.createSnapshot).not.toHaveBeenCalled();
    expect(mockSyncCoordinator.markLocalChanges).not.toHaveBeenCalled();
    expect(mockToast.info).toHaveBeenCalledWith(
      '导出模式',
      '创建项目暂不可用，旧入口仅允许导出，请前往 https://nanoflow.pages.dev 继续编辑'
    );
    expect(mockToast.info).toHaveBeenCalledWith(
      '导出模式',
      '保存项目设置暂不可用，旧入口仅允许导出，请前往 https://nanoflow.pages.dev 继续编辑'
    );
  });

  it('认证用户创建项目时应先持久化 create 队列且不直接等待云端保存', async () => {
    mockUserSession.currentUserId.mockReturnValue('user-1');

    await service.addProject(createProject({ id: 'proj-cloud-offline' }));

    const updater = getProjectUpdater(mockProjectState.updateProjects, 0);
    const updatedProjects = updater([]);
    expect(updatedProjects[0]).toEqual(expect.objectContaining({
      id: 'proj-cloud-offline',
      syncSource: 'synced',
      pendingSync: true,
    }));
    expect(mockActionQueue.enqueueDurably).toHaveBeenCalledWith(expect.objectContaining({
      type: 'create',
      entityType: 'project',
      entityId: 'proj-cloud-offline',
      payload: expect.objectContaining({
        sourceUserId: 'user-1',
        project: expect.objectContaining({
          syncSource: 'synced',
          pendingSync: true,
        }),
      }),
    }));
    expect(mockSyncCoordinator.core.saveProjectSmart).not.toHaveBeenCalled();
    expect(mockActionQueue.enqueue).not.toHaveBeenCalled();
  });

  it('认证用户创建项目入队后应保持 pendingSync 等待后台同步确认', async () => {
    mockUserSession.currentUserId.mockReturnValue('user-1');

    const result = await service.addProject(createProject({ id: 'proj-cloud-success' }));

    expect(result).toEqual({ success: true });
    const updater = getProjectUpdater(mockProjectState.updateProjects, 0);
    expect(updater([])).toEqual([
      expect.objectContaining({
        id: 'proj-cloud-success',
        pendingSync: true,
        syncSource: 'synced',
      }),
    ]);
    expect(mockSyncCoordinator.core.saveProjectSmart).not.toHaveBeenCalled();
    expect(mockActionQueue.enqueueDurably).toHaveBeenCalledOnce();
  });

  it('认证用户创建项目本地持久成功后应立即保存离线快照', async () => {
    mockUserSession.currentUserId.mockReturnValue('user-1');

    const result = await service.addProject(createProject({ id: 'proj-create-snapshot' }));

    expect(result).toEqual({ success: true });
    expect(mockActionQueue.enqueueDurably).toHaveBeenCalledOnce();
    expect(mockProjectState.updateProjects).toHaveBeenCalledOnce();
    expect(mockOptimisticState.commitSnapshot).toHaveBeenCalledWith('snap-1');
    expect(mockSyncCoordinator.core.saveOfflineSnapshot).toHaveBeenCalledWith(mockProjectState.projects());
  });

  it('认证用户创建项目时应先持久化队列再暴露本地 UI 新项目', async () => {
    const queueWrite = createDeferred<string>();
    mockUserSession.currentUserId.mockReturnValue('user-1');
    mockActionQueue.enqueueDurably.mockReturnValueOnce(queueWrite.promise);

    const resultPromise = service.addProject(createProject({ id: 'proj-create-order' }));

    expect(mockActionQueue.enqueueDurably).toHaveBeenCalledOnce();
    expect(mockProjectState.updateProjects).not.toHaveBeenCalled();
    expect(mockProjectState.setActiveProjectId).not.toHaveBeenCalled();

    queueWrite.resolve('queued-action-id');
    await expect(resultPromise).resolves.toEqual({ success: true });

    expect(mockProjectState.updateProjects).toHaveBeenCalledOnce();
    const updater = getLastProjectUpdater(mockProjectState.updateProjects);
    expect(updater([])).toEqual([
      expect.objectContaining({
        id: 'proj-create-order',
        pendingSync: true,
        syncSource: 'synced',
      }),
    ]);
    expect(mockProjectState.setActiveProjectId).toHaveBeenCalledWith('proj-create-order');
    expect(mockOptimisticState.commitSnapshot).toHaveBeenCalledWith('snap-1');
  });

  it('认证用户创建项目应等待离线快照持久化后再暴露本地 UI 新项目', async () => {
    const queueWrite = createDeferred<string>();
    const snapshotWrite = createDeferred<void>();
    mockUserSession.currentUserId.mockReturnValue('user-1');
    mockActionQueue.enqueueDurably.mockReturnValueOnce(queueWrite.promise);
    mockSyncCoordinator.core.saveOfflineSnapshotAndWait.mockReturnValueOnce(snapshotWrite.promise);

    const resultPromise = service.addProject(createProject({ id: 'proj-cloud-snapshot-order' }));

    expect(mockActionQueue.enqueueDurably).toHaveBeenCalledOnce();
    expect(mockSyncCoordinator.core.saveOfflineSnapshotAndWait).not.toHaveBeenCalled();
    expect(mockProjectState.updateProjects).not.toHaveBeenCalled();

    queueWrite.resolve('queued-action-id');
    await Promise.resolve();

    expect(mockSyncCoordinator.core.saveOfflineSnapshotAndWait).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 'proj-cloud-snapshot-order',
        pendingSync: true,
        syncSource: 'synced',
      }),
    ]);
    expect(mockProjectState.updateProjects).not.toHaveBeenCalled();
    expect(mockProjectState.setActiveProjectId).not.toHaveBeenCalled();
    expect(mockOptimisticState.commitSnapshot).not.toHaveBeenCalled();

    snapshotWrite.resolve();
    await expect(resultPromise).resolves.toEqual({ success: true });

    expect(mockProjectState.updateProjects).toHaveBeenCalledOnce();
    expect(mockProjectState.setActiveProjectId).toHaveBeenCalledWith('proj-cloud-snapshot-order');
    expect(mockOptimisticState.commitSnapshot).toHaveBeenCalledWith('snap-1');
  });

  it('认证用户创建项目持久队列写入失败时应回滚本地状态', async () => {
    mockUserSession.currentUserId.mockReturnValue('user-1');
    mockActionQueue.enqueueDurably.mockResolvedValueOnce('');

    const result = await service.addProject(createProject({ id: 'proj-create-persist-failed' }));

    expect(result).toEqual({ success: false, error: '离线同步队列未能写入' });
    expect(mockActionQueue.enqueueDurably).toHaveBeenCalledWith(expect.objectContaining({
      type: 'create',
      entityType: 'project',
      entityId: 'proj-create-persist-failed',
    }));
    expect(mockSyncCoordinator.core.saveProjectSmart).not.toHaveBeenCalled();
    expect(mockOptimisticState.rollbackSnapshot).toHaveBeenCalledWith('snap-1', false);
    expect(mockOptimisticState.commitSnapshot).not.toHaveBeenCalled();
    expect(mockSyncCoordinator.markLocalChanges).not.toHaveBeenCalled();
    expect(mockSyncCoordinator.schedulePersist).not.toHaveBeenCalled();
    expect(mockToast.error).toHaveBeenCalledWith(
      '本地保存失败',
      '离线同步队列未能写入，请释放浏览器存储空间后重试',
    );
  });

  it('认证用户重命名项目时应持久化 update 队列', async () => {
    mockUserSession.currentUserId.mockReturnValue('user-1');
    mockProjectState.projects.mockReturnValue([
      createProject({ id: 'proj-rename', name: 'Old Name', syncSource: 'synced' }),
    ]);

    const result = await service.renameProject('proj-rename', '  New Name  ');

    expect(result).toBe(true);
    const updater = getLastProjectUpdater(mockProjectState.updateProjects);
    expect(updater([createProject({ id: 'proj-rename', name: 'Old Name', syncSource: 'synced' })])).toEqual([
      expect.objectContaining({
        id: 'proj-rename',
        name: 'New Name',
        pendingSync: true,
        syncSource: 'synced',
      }),
    ]);
    expect(mockActionQueue.enqueueDurably).toHaveBeenCalledWith(expect.objectContaining({
      type: 'update',
      entityType: 'project',
      entityId: 'proj-rename',
      payload: expect.objectContaining({
        sourceUserId: 'user-1',
        project: expect.objectContaining({
          id: 'proj-rename',
          name: 'New Name',
          pendingSync: true,
          syncSource: 'synced',
        }),
      }),
    }));
    expect(mockSyncCoordinator.core.saveProjectSmart).not.toHaveBeenCalled();
    expect(mockOptimisticState.commitSnapshot).toHaveBeenCalledWith('snap-1');
  });

  it('认证用户重命名项目时应先持久化队列再暴露本地 UI 变更', async () => {
    const queueWrite = createDeferred<string>();
    mockUserSession.currentUserId.mockReturnValue('user-1');
    mockProjectState.projects.mockReturnValue([
      createProject({ id: 'proj-rename-order', name: 'Old Name', syncSource: 'synced' }),
    ]);
    mockActionQueue.enqueueDurably.mockReturnValueOnce(queueWrite.promise);

    const resultPromise = service.renameProject('proj-rename-order', 'New Name');

    expect(mockActionQueue.enqueueDurably).toHaveBeenCalledOnce();
    expect(mockProjectState.updateProjects).not.toHaveBeenCalled();

    queueWrite.resolve('queued-action-id');
    await expect(resultPromise).resolves.toBe(true);

    expect(mockProjectState.updateProjects).toHaveBeenCalledOnce();
    const updater = getLastProjectUpdater(mockProjectState.updateProjects);
    expect(updater([
      createProject({ id: 'proj-rename-order', name: 'Old Name', syncSource: 'synced' }),
    ])).toEqual([
      expect.objectContaining({
        id: 'proj-rename-order',
        name: 'New Name',
        pendingSync: true,
        syncSource: 'synced',
      }),
    ]);
    expect(mockOptimisticState.commitSnapshot).toHaveBeenCalledWith('snap-1');
  });

  it('认证用户项目更新持久队列写入失败时应回滚本地状态', async () => {
    mockUserSession.currentUserId.mockReturnValue('user-1');
    mockProjectState.projects.mockReturnValue([
      createProject({ id: 'proj-rename-failed', name: 'Old Name', syncSource: 'synced' }),
    ]);
    mockActionQueue.enqueueDurably.mockResolvedValueOnce('');

    const result = await service.renameProject('proj-rename-failed', 'New Name');

    expect(result).toBe(false);
    expect(mockActionQueue.enqueueDurably).toHaveBeenCalledWith(expect.objectContaining({
      type: 'update',
      entityType: 'project',
      entityId: 'proj-rename-failed',
    }));
    expect(mockOptimisticState.rollbackSnapshot).toHaveBeenCalledWith('snap-1', false);
    expect(mockOptimisticState.commitSnapshot).not.toHaveBeenCalled();
    expect(mockToast.error).toHaveBeenCalledWith(
      '本地保存失败',
      '离线项目更新队列未能写入，请释放浏览器存储空间后重试',
    );
  });

  it('认证用户重命名项目离线快照失败时应撤销已持久化队列且不暴露 UI 变更', async () => {
    mockUserSession.currentUserId.mockReturnValue('user-1');
    mockProjectState.projects.mockReturnValue([
      createProject({ id: 'proj-rename-snapshot-failed', name: 'Old Name', syncSource: 'synced' }),
    ]);
    mockActionQueue.enqueueDurably.mockResolvedValueOnce('queued-rename-action');
    mockSyncCoordinator.core.saveOfflineSnapshotAndWait.mockRejectedValueOnce(new Error('idb full'));

    const result = await service.renameProject('proj-rename-snapshot-failed', 'New Name');

    expect(result).toBe(false);
    expect(mockActionQueue.discardActions).toHaveBeenCalledWith(expect.any(Function));
    const discardPredicate = mockActionQueue.discardActions.mock.calls[0][0] as (action: { id: string; operationId: string }) => boolean;
    expect(discardPredicate({ id: 'queued-rename-action', operationId: 'other-op' })).toBe(true);
    expect(discardPredicate({ id: 'other-action', operationId: 'queued-rename-action' })).toBe(true);
    expect(discardPredicate({ id: 'other-action', operationId: 'other-op' })).toBe(false);
    expect(mockProjectState.updateProjects).not.toHaveBeenCalled();
    expect(mockOptimisticState.rollbackSnapshot).toHaveBeenCalledWith('snap-1', false);
    expect(mockOptimisticState.commitSnapshot).not.toHaveBeenCalled();
    expect(mockToast.error).toHaveBeenCalledWith(
      '本地保存失败',
      '离线快照未能写入，请释放浏览器存储空间后重试',
    );
  });

  it('本地模式重命名项目应先等待离线快照持久化再暴露 UI 变更', async () => {
    const snapshotWrite = createDeferred<void>();
    mockProjectState.projects.mockReturnValue([
      createProject({ id: 'proj-local-rename', name: 'Old Name', syncSource: 'local-only' }),
    ]);
    mockSyncCoordinator.core.saveOfflineSnapshotAndWait.mockReturnValueOnce(snapshotWrite.promise);

    const resultPromise = service.renameProject('proj-local-rename', 'New Name');

    expect(mockSyncCoordinator.core.saveOfflineSnapshotAndWait).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 'proj-local-rename',
        name: 'New Name',
        syncSource: 'local-only',
        pendingSync: false,
      }),
    ]);
    expect(mockProjectState.updateProjects).not.toHaveBeenCalled();
    expect(mockOptimisticState.commitSnapshot).not.toHaveBeenCalled();

    snapshotWrite.resolve();
    await expect(resultPromise).resolves.toBe(true);

    expect(mockProjectState.updateProjects).toHaveBeenCalledOnce();
    const updater = getLastProjectUpdater(mockProjectState.updateProjects);
    expect(updater([
      createProject({ id: 'proj-local-rename', name: 'Old Name', syncSource: 'local-only' }),
    ])).toEqual([
      expect.objectContaining({ id: 'proj-local-rename', name: 'New Name' }),
    ]);
    expect(mockOptimisticState.commitSnapshot).toHaveBeenCalledWith('snap-1');
  });

  it('认证用户保存项目元数据时应持久化 update 队列', async () => {
    mockUserSession.currentUserId.mockReturnValue('user-1');
    mockProjectState.projects.mockReturnValue([
      createProject({ id: 'proj-metadata', description: 'old', syncSource: 'synced' }),
    ]);

    const result = await service.updateProjectMetadata('proj-metadata', { description: 'new description' });

    expect(result).toEqual({ success: true });
    expect(mockActionQueue.enqueueDurably).toHaveBeenCalledWith(expect.objectContaining({
      type: 'update',
      entityType: 'project',
      entityId: 'proj-metadata',
      payload: expect.objectContaining({
        sourceUserId: 'user-1',
        project: expect.objectContaining({
          id: 'proj-metadata',
          description: 'new description',
          pendingSync: true,
          syncSource: 'synced',
        }),
      }),
    }));
    expect(mockSyncCoordinator.markLocalChanges).toHaveBeenCalledWith('structure');
    expect(mockSyncCoordinator.schedulePersist).toHaveBeenCalled();
    expect(mockSyncCoordinator.core.saveOfflineSnapshot).toHaveBeenCalled();
  });

  it('认证用户更新流程图 URL 时应持久化 update 队列', async () => {
    mockUserSession.currentUserId.mockReturnValue('user-1');
    mockProjectState.projects.mockReturnValue([
      createProject({ id: 'proj-flow-url', syncSource: 'synced' }),
    ]);

    const result = await service.updateProjectFlowchartUrl('proj-flow-url', 'https://flow.example/full.png', 'https://flow.example/thumb.png');

    expect(result).toEqual({ success: true });
    expect(mockActionQueue.enqueueDurably).toHaveBeenCalledWith(expect.objectContaining({
      type: 'update',
      entityType: 'project',
      entityId: 'proj-flow-url',
      payload: expect.objectContaining({
        project: expect.objectContaining({
          id: 'proj-flow-url',
          flowchartUrl: 'https://flow.example/full.png',
          flowchartThumbnailUrl: 'https://flow.example/thumb.png',
          pendingSync: true,
        }),
      }),
    }));
  });

  it('认证用户导入新项目时应持久化 create 队列且不直接等待云端保存', async () => {
    mockUserSession.currentUserId.mockReturnValue('user-1');
    mockProjectState.getProject.mockReturnValue(undefined);

    const result = await service.upsertImportedProject(createProject({ id: 'proj-import-new', name: 'Imported New' }));

    expect(result).toEqual({ success: true });
    const updater = getLastProjectUpdater(mockProjectState.updateProjects);
    expect(updater([])).toEqual([
      expect.objectContaining({
        id: 'proj-import-new',
        name: 'Imported New',
        pendingSync: true,
        syncSource: 'synced',
      }),
    ]);
    expect(mockActionQueue.enqueueDurably).toHaveBeenCalledWith(expect.objectContaining({
      type: 'create',
      entityType: 'project',
      entityId: 'proj-import-new',
      payload: expect.objectContaining({
        sourceUserId: 'user-1',
        project: expect.objectContaining({
          id: 'proj-import-new',
          syncSource: 'synced',
          pendingSync: true,
        }),
      }),
    }));
    expect(mockSyncCoordinator.core.saveProjectSmart).not.toHaveBeenCalled();
    expect(mockActionQueue.enqueue).not.toHaveBeenCalled();
    expect(mockSyncCoordinator.core.saveOfflineSnapshot).toHaveBeenCalled();
  });

  it('认证用户导入项目本地持久成功后应标记并调度后台持久化', async () => {
    mockUserSession.currentUserId.mockReturnValue('user-1');
    mockProjectState.getProject.mockReturnValue(undefined);

    const result = await service.upsertImportedProject(createProject({ id: 'proj-import-persist' }));

    expect(result).toEqual({ success: true });
    expect(mockActionQueue.enqueueDurably).toHaveBeenCalledOnce();
    expect(mockOptimisticState.commitSnapshot).toHaveBeenCalledWith('snap-1');
    expect(mockSyncCoordinator.markLocalChanges).toHaveBeenCalledWith('structure');
    expect(mockSyncCoordinator.schedulePersist).toHaveBeenCalled();
    expect(mockSyncCoordinator.core.saveOfflineSnapshot).toHaveBeenCalled();
  });

  it('认证用户导入现有项目时应持久化 update 队列', async () => {
    mockUserSession.currentUserId.mockReturnValue('user-1');
    mockProjectState.getProject.mockReturnValue(createProject({ id: 'proj-import-existing', name: 'Existing' }));

    const result = await service.upsertImportedProject(createProject({ id: 'proj-import-existing', name: 'Imported Existing' }));

    expect(result).toEqual({ success: true });
    const updater = getLastProjectUpdater(mockProjectState.updateProjects);
    expect(updater([createProject({ id: 'proj-import-existing', name: 'Existing' })])).toEqual([
      expect.objectContaining({
        id: 'proj-import-existing',
        name: 'Imported Existing',
        pendingSync: true,
        syncSource: 'synced',
      }),
    ]);
    expect(mockActionQueue.enqueueDurably).toHaveBeenCalledWith(expect.objectContaining({
      type: 'update',
      entityType: 'project',
      entityId: 'proj-import-existing',
      payload: expect.objectContaining({
        sourceUserId: 'user-1',
        project: expect.objectContaining({
          id: 'proj-import-existing',
          syncSource: 'synced',
          pendingSync: true,
        }),
      }),
    }));
    expect(mockSyncCoordinator.core.saveProjectSmart).not.toHaveBeenCalled();
  });

  it('认证用户导入项目时应先持久化队列再暴露本地 UI 变更', async () => {
    const queueWrite = createDeferred<string>();
    mockUserSession.currentUserId.mockReturnValue('user-1');
    mockActionQueue.enqueueDurably.mockReturnValueOnce(queueWrite.promise);

    const resultPromise = service.upsertImportedProject(createProject({
      id: 'proj-import-order',
      name: 'Imported Order',
    }));

    expect(mockActionQueue.enqueueDurably).toHaveBeenCalledOnce();
    expect(mockProjectState.updateProjects).not.toHaveBeenCalled();

    queueWrite.resolve('queued-action-id');
    await expect(resultPromise).resolves.toEqual({ success: true });

    expect(mockProjectState.updateProjects).toHaveBeenCalledOnce();
    const updater = getLastProjectUpdater(mockProjectState.updateProjects);
    expect(updater([])).toEqual([
      expect.objectContaining({
        id: 'proj-import-order',
        name: 'Imported Order',
        pendingSync: true,
        syncSource: 'synced',
      }),
    ]);
    expect(mockOptimisticState.commitSnapshot).toHaveBeenCalledWith('snap-1');
  });

  it('认证用户导入项目持久队列写入失败时应回滚本地状态', async () => {
    mockUserSession.currentUserId.mockReturnValue('user-1');
    mockProjectState.getProject.mockReturnValue(createProject({ id: 'proj-import-failed', name: 'Existing' }));
    mockActionQueue.enqueueDurably.mockResolvedValueOnce('');

    const result = await service.upsertImportedProject(createProject({ id: 'proj-import-failed', name: 'Imported Failed' }));

    expect(result).toEqual({ success: false, error: '离线导入队列未能写入' });
    expect(mockActionQueue.enqueueDurably).toHaveBeenCalledWith(expect.objectContaining({
      type: 'update',
      entityType: 'project',
      entityId: 'proj-import-failed',
    }));
    expect(mockOptimisticState.rollbackSnapshot).toHaveBeenCalledWith('snap-1', false);
    expect(mockOptimisticState.commitSnapshot).not.toHaveBeenCalled();
    expect(mockToast.error).toHaveBeenCalledWith(
      '本地保存失败',
      '离线导入队列未能写入，请释放浏览器存储空间后重试',
    );
    expect(mockSyncCoordinator.core.saveOfflineSnapshot).toHaveBeenCalled();
  });

  it('本地模式导入项目不写入云端 ActionQueue', async () => {
    const result = await service.upsertImportedProject(createProject({ id: 'proj-import-local' }));

    expect(result).toEqual({ success: true });
    expect(mockActionQueue.enqueueDurably).not.toHaveBeenCalled();
    expect(mockSyncCoordinator.core.saveProjectSmart).not.toHaveBeenCalled();
    expect(mockOptimisticState.commitSnapshot).toHaveBeenCalledWith('snap-1');
    expect(mockSyncCoordinator.core.saveOfflineSnapshot).toHaveBeenCalled();
  });

  it('本地模式导入项目应先等待离线快照持久化再暴露 UI 变更', async () => {
    const snapshotWrite = createDeferred<void>();
    mockSyncCoordinator.core.saveOfflineSnapshotAndWait.mockReturnValueOnce(snapshotWrite.promise);

    const resultPromise = service.upsertImportedProject(createProject({
      id: 'proj-import-local-durable',
      name: 'Imported Local',
    }));

    expect(mockSyncCoordinator.core.saveOfflineSnapshotAndWait).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 'proj-import-local-durable',
        name: 'Imported Local',
        syncSource: 'local-only',
        pendingSync: false,
      }),
    ]);
    expect(mockProjectState.updateProjects).not.toHaveBeenCalled();
    expect(mockOptimisticState.commitSnapshot).not.toHaveBeenCalled();

    snapshotWrite.resolve();
    await expect(resultPromise).resolves.toEqual({ success: true });

    expect(mockProjectState.updateProjects).toHaveBeenCalledOnce();
    expect(mockOptimisticState.commitSnapshot).toHaveBeenCalledWith('snap-1');
  });

  registerProjectOperationConflictResolutionSpecs(getConflictResolutionSpecContext);

  registerProjectOperationConflictStaleRemoteSpecs(getConflictStaleRemoteSpecContext);

  registerProjectOperationDeleteSpecs(getDeleteSpecContext);
});
