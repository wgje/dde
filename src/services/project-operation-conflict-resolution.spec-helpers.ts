import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Connection, Project, Task } from '../models';
import { AUTH_CONFIG } from '../config/auth.config';
import { createDeferred, createProject, getLastProjectUpdater, replayProjectUpdates } from './project-operation.test-harness';
import type { ProjectOperationConflictResolutionSpecContext } from './project-operation-conflict-resolution.spec-context';
import { registerProjectOperationConflictResolutionStaleCleanupSpecs } from './project-operation-conflict-resolution-stale-cleanup.spec-helpers';
import { isSyncOperationId } from '../utils/sync-operation-id';
import { getLocalBackupUiRestoreQuiescenceSentinelStorageKey } from './local-backup-ui-restore-writer-quiescence-tracker';
import { LocalBackupUiRestoreWriterQuiescenceService } from './local-backup-ui-restore-writer-quiescence.service';
type UpdateProjectsMock = Parameters<typeof replayProjectUpdates>[0];
export type { ProjectOperationConflictResolutionSpecContext } from './project-operation-conflict-resolution.spec-context';
export function registerProjectOperationConflictResolutionSpecs(
  getContext: () => ProjectOperationConflictResolutionSpecContext,
): void {
  let service: ProjectOperationConflictResolutionSpecContext['service'];
  let projectConflict: ProjectOperationConflictResolutionSpecContext['projectConflict'];
  let mockProjectState: ProjectOperationConflictResolutionSpecContext['mockProjectState'];
  let mockSyncCoordinator: ProjectOperationConflictResolutionSpecContext['mockSyncCoordinator'];
  let mockUserSession: ProjectOperationConflictResolutionSpecContext['mockUserSession'];
  let mockConflictStorage: ProjectOperationConflictResolutionSpecContext['mockConflictStorage'];
  let mockProjectConflictDirectSync: ProjectOperationConflictResolutionSpecContext['mockProjectConflictDirectSync'];
  let mockActionQueue: ProjectOperationConflictResolutionSpecContext['mockActionQueue'];
  let mockRetryQueue: ProjectOperationConflictResolutionSpecContext['mockRetryQueue'];
  let mockChangeTracker: ProjectOperationConflictResolutionSpecContext['mockChangeTracker'];
  let mockToast: ProjectOperationConflictResolutionSpecContext['mockToast'];
  function loadContext(): void {
    const context = getContext();
    service = context.service;
    projectConflict = context.projectConflict;
    mockProjectState = context.mockProjectState;
    mockSyncCoordinator = context.mockSyncCoordinator;
    mockUserSession = context.mockUserSession;
    mockConflictStorage = context.mockConflictStorage;
    mockProjectConflictDirectSync = context.mockProjectConflictDirectSync;
    mockActionQueue = context.mockActionQueue;
    mockRetryQueue = context.mockRetryQueue;
    mockChangeTracker = context.mockChangeTracker;
    mockToast = context.mockToast;
  }
  function updateProjectsMock(): UpdateProjectsMock {
    return mockProjectState.updateProjects as UpdateProjectsMock;
  }
  function expectDeleteTaskWithOperationId(taskId: string, projectId: string, userId: string, baseUpdatedAt?: string | null): string {
    const operationId = mockSyncCoordinator.core.deleteTask.mock.calls.at(-1)?.[5];
    if (!isSyncOperationId(operationId)) throw new Error('deleteTask operationId must be UUID-shaped');
    expect(mockSyncCoordinator.core.deleteTask).toHaveBeenCalledWith(taskId, projectId, userId, false, baseUpdatedAt, operationId);
    return operationId;
  }
  describe('conflict resolution persistence', () => {
    beforeEach(() => {
      vi.restoreAllMocks();
      loadContext();
    });
    it('冲突解决时若项目不在当前列表，应将 resolvedProject upsert 回本地状态', async () => {
      mockConflictStorage.getConflict.mockResolvedValueOnce({
        projectId: 'proj-missing',
        localProject: createProject({ id: 'proj-missing', name: 'Local Missing' }),
        remoteProject: createProject({ id: 'proj-missing', name: 'Remote Missing' }),
      });
      mockProjectState.getProject.mockReturnValue(undefined);
      mockSyncCoordinator.resolveConflict.mockResolvedValueOnce({
        ok: true,
        value: createProject({ id: 'proj-missing', name: 'Resolved Missing' }),
      });
      await service.resolveConflict('proj-missing', 'local');
      const finalProjects = replayProjectUpdates(updateProjectsMock());
      expect(finalProjects).toEqual([
        expect.objectContaining({ id: 'proj-missing', name: 'Resolved Missing' }),
      ]);
    });
    it('本地模式冲突解决应先等待离线快照持久化再提交 UI', async () => {
      const snapshotWrite = createDeferred<void>();
      const ownerUserId = AUTH_CONFIG.LOCAL_MODE_USER_ID;
      const sentinelKey = getLocalBackupUiRestoreQuiescenceSentinelStorageKey(ownerUserId);
      localStorage.removeItem(sentinelKey);
      const quiescenceService = new LocalBackupUiRestoreWriterQuiescenceService({ pollIntervalMs: 1 });
      const localProject = createProject({ id: 'proj-local-conflict', name: 'Local Conflict', syncSource: 'local-only' });
      const resolvedProject = createProject({ id: 'proj-local-conflict', name: 'Resolved Local Conflict', syncSource: 'local-only' });
      mockConflictStorage.getConflict.mockResolvedValue({
        projectId: 'proj-local-conflict',
        localProject,
      });
      mockProjectState.getProject.mockReturnValue(localProject);
      mockSyncCoordinator.resolveConflict.mockResolvedValueOnce({
        ok: true,
        value: resolvedProject,
      });
      mockSyncCoordinator.core.saveOfflineSnapshotAndWait?.mockReturnValueOnce(snapshotWrite.promise);
      let resultPromise: Promise<boolean> | null = null;
      let preparing: ReturnType<typeof quiescenceService.prepare> | null = null;
      let prepared: Awaited<ReturnType<typeof quiescenceService.prepare>> | null = null;
      let restorePrepared = false;
      try {
        resultPromise = service.resolveConflict('proj-local-conflict', 'local');
        await vi.waitFor(() => {
          expect(mockSyncCoordinator.core.saveOfflineSnapshotAndWait).toHaveBeenCalledWith([
            expect.objectContaining({
              id: 'proj-local-conflict',
              name: 'Resolved Local Conflict',
              pendingSync: false,
            }),
          ], ownerUserId);
        });
        expect(mockProjectState.updateProjects).not.toHaveBeenCalled();
        expect(mockConflictStorage.deleteConflict).not.toHaveBeenCalled();

        preparing = quiescenceService.prepare(ownerUserId).then(handle => {
          restorePrepared = true;
          return handle;
        });
        await vi.waitFor(() => expect(localStorage.getItem(sentinelKey)).not.toBeNull());
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(restorePrepared).toBe(false);

        snapshotWrite.resolve();
        await expect(resultPromise).resolves.toBe(true);
        expect(mockProjectState.updateProjects).toHaveBeenCalledOnce();
        expect(mockConflictStorage.deleteConflict).toHaveBeenCalledWith('proj-local-conflict', ownerUserId);
        prepared = await preparing;
        expect(restorePrepared).toBe(true);
      } finally {
        snapshotWrite.resolve();
        await resultPromise?.catch(() => false);
        if (preparing && !prepared) prepared = await preparing.catch(() => null);
        await prepared?.abortBeforeMutation();
      }
    });
    it('resolveConflict 选择本地版本时应向离线快照终态持久化全量 tasks 和 connections', async () => {
      const projectId = 'proj-authoritative-local';
      const taskAlpha: Task = {
        id: 'task-alpha',
        title: 'Alpha',
        content: 'authoritative local task alpha',
        stage: 1,
        parentId: null,
        order: 0,
        rank: 1,
        status: 'active',
        x: 0,
        y: 0,
        createdDate: '2026-04-10T08:00:00.000Z',
        updatedAt: '2026-04-10T08:00:00.000Z',
        displayId: '1',
      };
      const taskBeta: Task = {
        id: 'task-beta',
        title: 'Beta',
        content: 'authoritative local task beta',
        stage: 1,
        parentId: null,
        order: 1,
        rank: 2,
        status: 'active',
        x: 120,
        y: 0,
        createdDate: '2026-04-10T08:05:00.000Z',
        updatedAt: '2026-04-10T08:05:00.000Z',
        displayId: '2',
      };
      const connection: Connection = {
        id: 'conn-authoritative',
        source: 'task-alpha',
        target: 'task-beta',
      };
      const shellProject = createProject({
        id: projectId,
        name: 'Local Shell Only',
        pendingSync: true,
        tasks: [],
        connections: [],
      });
      let shellProjects = [shellProject];
      let authoritativeProjects = [createProject({
        id: projectId,
        name: 'Local Authoritative',
        pendingSync: true,
        tasks: [taskAlpha, taskBeta],
        connections: [connection],
      })];

      mockProjectState.projects.mockImplementation(() => shellProjects);
      mockProjectState.getProject.mockImplementation((id: string) =>
        shellProjects.find(project => project.id === id));
      mockProjectState.getProjectsWithCurrentData.mockImplementation(() => authoritativeProjects);
      mockProjectState.getProjectWithCurrentData.mockImplementation((id: string) =>
        authoritativeProjects.find(project => project.id === id));
      mockProjectState.updateProjects.mockImplementation((updater: (projects: Project[]) => Project[]) => {
        authoritativeProjects = updater(authoritativeProjects);
      });

      mockConflictStorage.getConflict.mockResolvedValueOnce({
        projectId,
        localProject: shellProject,
        remoteProject: createProject({ id: projectId, name: 'Remote Snapshot', version: 3 }),
      });
      mockUserSession.currentUserId.mockReturnValue('user-1');
      mockSyncCoordinator.resolveConflict.mockImplementationOnce(async (
        _resolvedProjectId: string,
        _choice: 'local' | 'remote' | 'merge',
        localProject: Project,
      ) => ({
        ok: true,
        value: {
          ...localProject,
          pendingSync: true,
          version: 4,
        },
      }));
      const resolved = await service.resolveConflict(projectId, 'local');

      expect(resolved).toBe(true);
      expect(mockProjectConflictDirectSync.executeDurably).toHaveBeenCalledWith(
        expect.objectContaining({
          resolvedProject: expect.objectContaining({
          id: projectId,
          tasks: [
            expect.objectContaining({
              id: 'task-alpha',
              content: 'authoritative local task alpha',
            }),
            expect.objectContaining({
              id: 'task-beta',
              content: 'authoritative local task beta',
            }),
          ],
          connections: [
            expect.objectContaining({
              id: 'conn-authoritative',
              source: 'task-alpha',
              target: 'task-beta',
            }),
          ],
          }),
        }),
        expect.any(Function),
      );
    });
    it('remote 解决冲突前应尝试补拉远端版本', async () => {
      mockSyncCoordinator.conflictData.mockReturnValue({
        projectId: 'proj-remote',
        local: createProject({ id: 'proj-remote', name: 'Local Only Conflict' }),
        remote: undefined,
      });
      mockConflictStorage.getConflict.mockResolvedValueOnce({
        projectId: 'proj-remote',
        localProject: createProject({ id: 'proj-remote', name: 'Local Only Conflict' }),
      });
      mockProjectState.getProject.mockReturnValue(undefined);
      mockSyncCoordinator.loadSingleProjectFromCloud.mockResolvedValueOnce(
        createProject({ id: 'proj-remote', name: 'Remote Reloaded', version: 5 })
      );
      mockSyncCoordinator.resolveConflict.mockResolvedValueOnce({
        ok: true,
        value: createProject({ id: 'proj-remote', name: 'Remote Reloaded', version: 5 }),
      });
      await service.resolveConflict('proj-remote', 'remote');
      expect(mockSyncCoordinator.loadSingleProjectFromCloud).toHaveBeenCalledWith('proj-remote');
      expect(mockSyncCoordinator.resolveConflict).toHaveBeenCalledWith(
        'proj-remote',
        'remote',
        expect.objectContaining({ id: 'proj-remote', name: 'Local Only Conflict' }),
        expect.objectContaining({ id: 'proj-remote', name: 'Remote Reloaded', version: 5 })
      );
      expect(mockSyncCoordinator.captureConflict).not.toHaveBeenCalled();
      expect(mockSyncCoordinator.clearActiveConflict).toHaveBeenCalled();
    });
    it('remote reload 刷新 stored conflict 后仍应清理最新冲突记录', async () => {
      const localProject = createProject({ id: 'proj-remote-refresh-cleanup', name: 'Local Reload Cleanup' });
      const refreshedRemote = createProject({ id: 'proj-remote-refresh-cleanup', name: 'Remote Reloaded Cleanup', version: 5 });
      mockUserSession.currentUserId.mockReturnValue('user-1');
      mockSyncCoordinator.conflictData.mockReturnValue({
        projectId: 'proj-remote-refresh-cleanup',
        local: localProject,
        remote: undefined,
        conflictedAt: '2026-03-30T00:00:00.000Z',
      });
      mockConflictStorage.getConflict
        .mockResolvedValueOnce({
          projectId: 'proj-remote-refresh-cleanup',
          localProject,
          conflictedAt: '2026-03-30T00:00:00.000Z',
          localVersion: 1,
          remoteVersion: 0,
        })
        .mockResolvedValueOnce({
          projectId: 'proj-remote-refresh-cleanup',
          localProject,
          remoteProject: refreshedRemote,
          remoteSnapshotFresh: true,
          ownerUserId: 'user-1',
          conflictedAt: '2026-03-30T00:01:00.000Z',
          localVersion: 1,
          remoteVersion: 5,
        })
        .mockResolvedValueOnce({
          projectId: 'proj-remote-refresh-cleanup',
          localProject,
          remoteProject: refreshedRemote,
          remoteSnapshotFresh: true,
          ownerUserId: 'user-1',
          conflictedAt: '2026-03-30T00:01:00.000Z',
          localVersion: 1,
          remoteVersion: 5,
        });
      mockProjectState.getProject.mockReturnValue(localProject);
      mockSyncCoordinator.loadSingleProjectFromCloud.mockResolvedValueOnce(refreshedRemote);
      mockSyncCoordinator.resolveConflict.mockResolvedValueOnce({
        ok: true,
        value: refreshedRemote,
      });
      const resolved = await service.resolveConflict('proj-remote-refresh-cleanup', 'remote');
      expect(resolved).toBe(true);
      expect(mockSyncCoordinator.loadSingleProjectFromCloud).toHaveBeenCalledWith('proj-remote-refresh-cleanup');
      expect(mockConflictStorage.deleteConflict).toHaveBeenCalledWith('proj-remote-refresh-cleanup', 'user-1');
    });
    it('cleanup 前若冲突已被更新版本替换，不应删除新的 stored 或 active conflict', async () => {
      const localProject = createProject({ id: 'proj-remote-refresh-guard', name: 'Local Reload Guard' });
      const refreshedRemote = createProject({ id: 'proj-remote-refresh-guard', name: 'Remote Reloaded Guard', version: 5 });
      const newerRemote = createProject({ id: 'proj-remote-refresh-guard', name: 'Remote Newer Guard', version: 6 });
      mockUserSession.currentUserId.mockReturnValue('user-1');
      mockSyncCoordinator.conflictData
        .mockReturnValueOnce({
          projectId: 'proj-remote-refresh-guard',
          local: localProject,
          remote: undefined,
          conflictedAt: '2026-03-30T00:00:00.000Z',
        })
        .mockReturnValue({
          projectId: 'proj-remote-refresh-guard',
          local: localProject,
          remote: newerRemote,
          conflictedAt: '2026-03-30T00:02:00.000Z',
        });
      mockConflictStorage.getConflict
        .mockResolvedValueOnce({
          projectId: 'proj-remote-refresh-guard',
          localProject,
          conflictedAt: '2026-03-30T00:00:00.000Z',
          localVersion: 1,
          remoteVersion: 0,
        })
        .mockResolvedValueOnce({
          projectId: 'proj-remote-refresh-guard',
          localProject,
          remoteProject: refreshedRemote,
          remoteSnapshotFresh: true,
          ownerUserId: 'user-1',
          conflictedAt: '2026-03-30T00:01:00.000Z',
          localVersion: 1,
          remoteVersion: 5,
        })
        .mockResolvedValueOnce({
          projectId: 'proj-remote-refresh-guard',
          localProject,
          remoteProject: newerRemote,
          remoteSnapshotFresh: true,
          ownerUserId: 'user-1',
          conflictedAt: '2026-03-30T00:02:00.000Z',
          localVersion: 1,
          remoteVersion: 6,
        });
      mockProjectState.getProject.mockReturnValue(localProject);
      mockSyncCoordinator.loadSingleProjectFromCloud.mockResolvedValueOnce(refreshedRemote);
      mockSyncCoordinator.resolveConflict.mockResolvedValueOnce({
        ok: true,
        value: refreshedRemote,
      });
      const resolved = await service.resolveConflict('proj-remote-refresh-guard', 'remote');
      expect(resolved).toBe(true);
      expect(mockConflictStorage.deleteConflict).not.toHaveBeenCalledWith('proj-remote-refresh-guard', 'user-1');
      expect(mockSyncCoordinator.clearActiveConflict).not.toHaveBeenCalled();
    });
    it('cleanup 前若冲突追加了操作级证据，不应删除新的 stored 或 active conflict', async () => {
      const projectId = 'proj-operation-conflict-guard';
      const localProject = createProject({ id: projectId, name: 'Local Operation Conflict', version: 1 });
      const remoteProject = createProject({ id: projectId, name: 'Remote Operation Conflict', version: 3 });
      const operationConflict = {
        actionId: 'action-task-update-1',
        actionType: 'task:update' as const,
        entityType: 'task' as const,
        entityId: 'task-operation-conflict',
        projectId,
        operationId: 'op-task-update-1',
        localEntity: { id: 'task-operation-conflict', title: 'Local Task' } as Project['tasks'][number],
        remoteEntity: { id: 'task-operation-conflict', title: 'Remote Task' } as Project['tasks'][number],
        message: '远端任务更新较新',
        conflictedAt: '2026-03-30T00:05:00.000Z',
        reason: 'remote-newer' as const,
      };
      const baseConflict = {
        projectId,
        ownerUserId: 'user-1',
        localProject,
        remoteProject,
        remoteSnapshotFresh: true,
        conflictedAt: '2026-03-30T00:00:00.000Z',
        localVersion: 1,
        remoteVersion: 3,
      };
      const activeConflict = {
        projectId,
        local: localProject,
        remote: remoteProject,
        conflictedAt: '2026-03-30T00:00:00.000Z',
      };
      mockUserSession.currentUserId.mockReturnValue('user-1');
      mockSyncCoordinator.conflictData
        .mockReturnValueOnce(activeConflict)
        .mockReturnValue({
          ...activeConflict,
          operationConflicts: [operationConflict],
        });
      mockConflictStorage.getConflict
        .mockResolvedValueOnce(baseConflict)
        .mockResolvedValueOnce(baseConflict)
        .mockResolvedValueOnce({
          ...baseConflict,
          operationConflicts: [operationConflict],
        });
      mockProjectState.getProject.mockReturnValue(localProject);
      mockSyncCoordinator.resolveConflict.mockResolvedValueOnce({
        ok: true,
        value: createProject({ id: projectId, name: 'Resolved Operation Conflict', version: 4 }),
      });
      mockSyncCoordinator.core.saveProjectSmart.mockResolvedValueOnce({
        success: true,
        newVersion: 10,
      });
      const resolved = await service.resolveConflict(projectId, 'local');
      expect(resolved).toBe(true);
      expect(mockConflictStorage.deleteConflict).not.toHaveBeenCalledWith(projectId, 'user-1');
      expect(mockSyncCoordinator.clearActiveConflict).not.toHaveBeenCalled();
    });
    it('resolveConflictWithPlan 应委托逐任务计划并清理冲突状态', async () => {
      const localProject = createProject({
        id: 'proj-plan',
        name: 'Local Plan',
        tasks: [{ id: 'task-delete-1' } as Project['tasks'][number]],
      });
      const remoteProject = createProject({
        id: 'proj-plan',
        name: 'Remote Plan',
        version: 3,
        tasks: [{ id: 'task-delete-1' } as Project['tasks'][number]],
      });
      mockSyncCoordinator.conflictData.mockReturnValue({
        projectId: 'proj-plan',
        conflictedAt: '2026-03-30T00:00:00.000Z',
        local: localProject,
        remote: remoteProject,
        pendingTaskDeleteIds: ['task-delete-1'],
      });
      mockConflictStorage.getConflict.mockResolvedValue({
        projectId: 'proj-plan',
        localProject,
        remoteProject,
        conflictedAt: '2026-03-30T00:00:00.000Z',
        localVersion: localProject.version ?? 0,
        remoteVersion: remoteProject.version ?? 0,
        pendingTaskDeleteIds: ['task-delete-1'],
      });
      mockProjectState.getProject.mockReturnValue(localProject);
      mockSyncCoordinator.resolveConflictWithPlan.mockResolvedValueOnce({
        ok: true,
        value: createProject({
          id: 'proj-plan',
          name: 'Resolved Plan',
          version: 4,
          tasks: [{ id: 'task-delete-1' } as Project['tasks'][number]],
        }),
      });
      const resolved = await service.resolveConflictWithPlan('proj-plan', {
        taskChoices: { 'task-delete-1': 'remote' },
        appliedBy: 'mixed',
      });
      const finalProjects = replayProjectUpdates(updateProjectsMock());
      expect(resolved).toBe(true);
      expect(mockSyncCoordinator.resolveConflictWithPlan).toHaveBeenCalledWith(
        'proj-plan',
        { taskChoices: { 'task-delete-1': 'remote' }, appliedBy: 'mixed' },
        expect.objectContaining({ id: 'proj-plan', name: 'Local Plan' }),
        expect.objectContaining({ id: 'proj-plan', name: 'Remote Plan', version: 3 }),
      );
      expect(mockSyncCoordinator.resolveConflict).not.toHaveBeenCalled();
      expect(finalProjects[0]?.tasks.some((task: { id: string }) => task.id === 'task-delete-1')).toBe(true);
      expect(mockConflictStorage.deleteConflict).toHaveBeenCalled();
      expect(mockSyncCoordinator.clearActiveConflict).toHaveBeenCalled();
    });
    it('resolveConflict 若会话已切换，不应继续回写本地状态或删除冲突', async () => {
      mockConflictStorage.getConflict.mockResolvedValueOnce({
        projectId: 'proj-switched',
        localProject: createProject({ id: 'proj-switched', name: 'Local Switched' }),
        remoteProject: createProject({ id: 'proj-switched', name: 'Remote Switched', version: 2 }),
      });
      mockUserSession.isSessionContextCurrent.mockReturnValueOnce(false);
      const result = await service.resolveConflict('proj-switched', 'local');
      expect(result).toBe(false);
      expect(mockSyncCoordinator.resolveConflict).not.toHaveBeenCalled();
      expect(mockProjectState.updateProjects).not.toHaveBeenCalled();
      expect(mockConflictStorage.deleteConflict).not.toHaveBeenCalled();
    });
    it('冲突解决成功后应回写同步状态并清理脏标记', async () => {
      mockSyncCoordinator.conflictData.mockReturnValueOnce({
        projectId: 'proj-success',
        local: createProject({ id: 'proj-success', name: 'Local Conflict', pendingSync: true }),
        remote: createProject({ id: 'proj-success', name: 'Remote Conflict', version: 3 }),
      });
      mockConflictStorage.getConflict.mockResolvedValueOnce({
        projectId: 'proj-success',
        localProject: createProject({ id: 'proj-success', name: 'Local Conflict', pendingSync: true }),
        remoteProject: createProject({ id: 'proj-success', name: 'Remote Conflict', version: 3 }),
        pendingTaskDeleteIds: ['task-delete-1'],
      });
      mockProjectState.getProject.mockReturnValue(createProject({ id: 'proj-success', name: 'Local Conflict', pendingSync: true }));
      mockSyncCoordinator.resolveConflict.mockResolvedValueOnce({
        ok: true,
        value: createProject({ id: 'proj-success', name: 'Resolved Success', version: 4, pendingSync: true }),
      });
      mockUserSession.currentUserId.mockReturnValue('user-1');
      await service.resolveConflict('proj-success', 'local');
      expect(mockProjectConflictDirectSync.executeDurably).toHaveBeenCalledWith(
        expect.objectContaining({
          resolvedProject: expect.objectContaining({ id: 'proj-success', name: 'Resolved Success' }),
          taskIdsToDelete: ['task-delete-1'],
        }),
        expect.any(Function),
      );
    });
    it('resolveConflict direct retry outcome keeps durable handoff pending', async () => {
      mockConflictStorage.getConflict.mockResolvedValue({
        projectId: 'proj-retry-resolve',
        localProject: createProject({ id: 'proj-retry-resolve', name: 'Local Conflict', pendingSync: true }),
        remoteProject: createProject({ id: 'proj-retry-resolve', name: 'Remote Conflict', version: 3 }),
        pendingTaskDeleteIds: ['task-delete-retry'],
      });
      mockProjectState.getProject.mockReturnValue(createProject({ id: 'proj-retry-resolve', name: 'Local Conflict', pendingSync: true }));
      mockSyncCoordinator.resolveConflict.mockResolvedValueOnce({
        ok: true,
        value: createProject({ id: 'proj-retry-resolve', name: 'Resolved Retry', version: 4, pendingSync: true }),
      });
      mockUserSession.currentUserId.mockReturnValue('user-1');
      mockProjectConflictDirectSync.executeDurably.mockResolvedValueOnce({ status: 'deferred' });
      const resolved = await service.resolveConflict('proj-retry-resolve', 'local');
      expect(resolved).toBe(false);
      expect(mockActionQueue.enqueue).not.toHaveBeenCalled();
      expect(mockActionQueue.enqueueDurably).not.toHaveBeenCalled();
      expect(mockProjectConflictDirectSync.executeDurably).toHaveBeenCalledWith(
        expect.objectContaining({ taskIdsToDelete: ['task-delete-retry'] }), expect.any(Function),
      );
    });
    it('resolveConflict 可重试同步失败但 durable 入队失败时应保留冲突记录', async () => {
      mockConflictStorage.getConflict.mockResolvedValue({
        projectId: 'proj-retry-queue-fail',
        localProject: createProject({ id: 'proj-retry-queue-fail', name: 'Local Conflict', pendingSync: true }),
        remoteProject: createProject({ id: 'proj-retry-queue-fail', name: 'Remote Conflict', version: 3 }),
      });
      mockProjectState.getProject.mockReturnValue(createProject({ id: 'proj-retry-queue-fail', name: 'Local Conflict', pendingSync: true }));
      mockSyncCoordinator.resolveConflict.mockResolvedValueOnce({
        ok: true,
        value: createProject({ id: 'proj-retry-queue-fail', name: 'Resolved Retry', version: 4, pendingSync: true }),
      });
      mockUserSession.currentUserId.mockReturnValue('user-1');
      mockProjectConflictDirectSync.executeDurably.mockResolvedValueOnce({ status: 'storage-failed' });
      const resolved = await service.resolveConflict('proj-retry-queue-fail', 'local');
      expect(resolved).toBe(false);
      expect(mockProjectState.updateProjects).not.toHaveBeenCalled();
      expect(mockConflictStorage.deleteConflict).not.toHaveBeenCalledWith('proj-retry-queue-fail', 'user-1');
      expect(mockChangeTracker.clearProjectFieldLocks).not.toHaveBeenCalledWith('proj-retry-queue-fail');
      expect(mockChangeTracker.clearProjectChanges).not.toHaveBeenCalledWith('proj-retry-queue-fail');
      expect(mockToast.error).toHaveBeenCalledWith(
        '本地保存失败',
        '冲突解决结果未能写入离线同步队列，请释放浏览器存储空间后重试',
      );
    });
    it('resolveConflict 可重试同步失败且 durable 入队抛错时应保留冲突记录', async () => {
      mockConflictStorage.getConflict.mockResolvedValue({
        projectId: 'proj-retry-queue-throw',
        localProject: createProject({ id: 'proj-retry-queue-throw', name: 'Local Conflict', pendingSync: true }),
        remoteProject: createProject({ id: 'proj-retry-queue-throw', name: 'Remote Conflict', version: 3 }),
      });
      mockProjectState.getProject.mockReturnValue(createProject({ id: 'proj-retry-queue-throw', name: 'Local Conflict', pendingSync: true }));
      mockSyncCoordinator.resolveConflict.mockResolvedValueOnce({
        ok: true,
        value: createProject({ id: 'proj-retry-queue-throw', name: 'Resolved Retry', version: 4, pendingSync: true }),
      });
      mockUserSession.currentUserId.mockReturnValue('user-1');
      mockProjectConflictDirectSync.executeDurably.mockRejectedValueOnce(new Error('idb unavailable'));
      const resolved = await service.resolveConflict('proj-retry-queue-throw', 'local');
      expect(resolved).toBe(false);
      expect(mockActionQueue.enqueueDurably).not.toHaveBeenCalled();
      expect(mockProjectState.updateProjects).not.toHaveBeenCalled();
      expect(mockConflictStorage.deleteConflict).not.toHaveBeenCalledWith('proj-retry-queue-throw', 'user-1');
      expect(mockChangeTracker.clearProjectFieldLocks).not.toHaveBeenCalledWith('proj-retry-queue-throw');
      expect(mockChangeTracker.clearProjectChanges).not.toHaveBeenCalledWith('proj-retry-queue-throw');
      expect(mockToast.error).toHaveBeenCalledWith(
        '本地保存失败',
        '冲突解决结果未能写入离线同步队列，请释放浏览器存储空间后重试',
      );
    });
    it('resolveConflict direct deferred outcome does not terminal-settle local evidence', async () => {
      const currentProject = createProject({ id: 'proj-terminal-resolve', name: 'Local Conflict', pendingSync: true });
      const resolvedProject = createProject({ id: 'proj-terminal-resolve', name: 'Resolved Terminal', version: 4, pendingSync: true });
      mockConflictStorage.getConflict.mockResolvedValue({
        projectId: 'proj-terminal-resolve',
        localProject: currentProject,
        remoteProject: createProject({ id: 'proj-terminal-resolve', name: 'Remote Conflict', version: 3 }),
        pendingTaskDeleteIds: ['task-delete-1'],
      });
      mockProjectState.getProjectWithCurrentData
        .mockReturnValueOnce(currentProject)
        .mockReturnValue(resolvedProject);
      mockSyncCoordinator.resolveConflict.mockResolvedValueOnce({
        ok: true,
        value: resolvedProject,
      });
      mockUserSession.currentUserId.mockReturnValue('user-1');
      mockProjectConflictDirectSync.executeDurably.mockResolvedValueOnce({ status: 'deferred' });
      const resolved = await service.resolveConflict('proj-terminal-resolve', 'local');
      expect(resolved).toBe(false);
      expect(mockActionQueue.enqueue).not.toHaveBeenCalled();
      expect(mockConflictStorage.deleteConflict).not.toHaveBeenCalled();
      expect(mockProjectState.updateProjects).not.toHaveBeenCalled();
    });
    it('resolveConflict live session terminal 且当前项目已继续演化时不应清空新变更', async () => {
      mockConflictStorage.getConflict.mockResolvedValue({
        projectId: 'proj-terminal-resolve-diverged',
        localProject: createProject({ id: 'proj-terminal-resolve-diverged', name: 'Local Conflict', pendingSync: true }),
        remoteProject: createProject({ id: 'proj-terminal-resolve-diverged', name: 'Remote Conflict', version: 3 }),
      });
      mockProjectState.getProjectWithCurrentData
        .mockReturnValueOnce(createProject({ id: 'proj-terminal-resolve-diverged', name: 'Local Conflict', pendingSync: true }))
        .mockReturnValue(createProject({ id: 'proj-terminal-resolve-diverged', name: 'Newest Local Conflict', version: 7, pendingSync: true, syncSource: 'synced' }));
      mockSyncCoordinator.resolveConflict.mockResolvedValueOnce({
        ok: true,
        value: createProject({ id: 'proj-terminal-resolve-diverged', name: 'Resolved Conflict', version: 4, pendingSync: true }),
      });
      mockUserSession.currentUserId.mockReturnValue('user-1');
      mockProjectConflictDirectSync.executeDurably.mockResolvedValueOnce({ status: 'deferred' });
      const resolved = await service.resolveConflict('proj-terminal-resolve-diverged', 'local');
      expect(resolved).toBe(false);
      expect(mockActionQueue.discardActions).not.toHaveBeenCalled();
      expect(mockConflictStorage.deleteConflict).not.toHaveBeenCalled();
      expect(mockProjectState.updateProjects).not.toHaveBeenCalled();
    });
    it('后置待删任务回放遇到会话切换时应把剩余删除意图写回原 owner 队列', async () => {
      mockUserSession.isSessionContextCurrent
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(false);
      await projectConflict.replayPendingTaskDeletes(
        createProject({ id: 'proj-replay-handoff', version: 9 }),
        ['task-delete-1', 'task-delete-2'],
        { ownerUserId: 'user-1', sessionGeneration: 1 },
      );
      expect(mockSyncCoordinator.core.deleteTask).toHaveBeenCalledTimes(1);
      expectDeleteTaskWithOperationId('task-delete-1', 'proj-replay-handoff', 'user-1');
      expect(mockActionQueue.enqueueForOwner).toHaveBeenCalledWith('user-1', expect.objectContaining({
        type: 'update',
        entityType: 'project',
        entityId: 'proj-replay-handoff',
        payload: expect.objectContaining({
          taskIdsToDelete: ['task-delete-2'],
        }),
      }));
    });
    it('后置待删任务回放在最后一次删除等待期间切换会话时应标记为 stale', async () => {
      const deleteTask = createDeferred<boolean>();
      const projectId = 'proj-replay-last-delete-session-switch';
      mockUserSession.currentUserId.mockReturnValue('user-a');
      mockUserSession.isSessionContextCurrent.mockReturnValue(true);
      mockSyncCoordinator.core.deleteTask.mockReturnValueOnce(deleteTask.promise);

      const replayPromise = projectConflict.replayPendingTaskDeletes(
        createProject({ id: projectId, version: 9 }),
        ['task-delete-last'],
        { ownerUserId: 'user-a', sessionGeneration: 1 },
      );
      await expect.poll(() => mockSyncCoordinator.core.deleteTask.mock.calls.length).toBe(1);

      mockUserSession.currentUserId.mockReturnValue('user-b');
      mockUserSession.isSessionContextCurrent.mockReturnValue(false);
      deleteTask.resolve(true);

      await expect(replayPromise).resolves.toEqual({ ok: true, sessionStale: true });
      expectDeleteTaskWithOperationId('task-delete-last', projectId, 'user-a');
      expect(mockActionQueue.enqueue).not.toHaveBeenCalled();
      expect(mockActionQueue.enqueueForOwner).not.toHaveBeenCalled();
    });
    it('后置待删任务回放应为同一待删意图传入稳定 operationId', async () => {
      const project = createProject({
        id: 'proj-replay-operation-id',
        version: 9,
        updatedAt: '2026-04-02T00:00:00.000Z',
      });
      const sessionContext = { ownerUserId: 'user-1', sessionGeneration: 1 };
      const baseUpdatedAtMap = {
        'task-delete-stable': '2026-04-01T00:00:00.000Z',
      };

      await projectConflict.replayPendingTaskDeletes(
        project,
        ['task-delete-stable'],
        sessionContext,
        baseUpdatedAtMap,
      );
      const firstOperationId = expectDeleteTaskWithOperationId(
        'task-delete-stable',
        'proj-replay-operation-id',
        'user-1',
        '2026-04-01T00:00:00.000Z',
      );

      mockSyncCoordinator.core.deleteTask.mockClear();
      await projectConflict.replayPendingTaskDeletes(
        project,
        ['task-delete-stable'],
        sessionContext,
        baseUpdatedAtMap,
      );

      expect(mockSyncCoordinator.core.deleteTask.mock.calls[0]?.[5]).toBe(firstOperationId);
    });
    it('resolveConflict 应优先使用 active conflict 中的 pendingTaskDeleteIds', async () => {
      mockSyncCoordinator.conflictData.mockReturnValueOnce({
        projectId: 'proj-active-pending-delete',
        local: createProject({ id: 'proj-active-pending-delete', name: 'Local Conflict' }),
        remote: createProject({ id: 'proj-active-pending-delete', name: 'Remote Conflict', version: 3 }),
        pendingTaskDeleteIds: ['task-delete-fast-click'],
        pendingTaskDeleteBaseUpdatedAtMap: {
          'task-delete-fast-click': '2026-04-01T00:00:00.000Z',
        },
      });
      mockConflictStorage.getConflict.mockResolvedValueOnce({
        projectId: 'proj-active-pending-delete',
        localProject: createProject({ id: 'proj-active-pending-delete', name: 'Local Conflict' }),
        remoteProject: createProject({ id: 'proj-active-pending-delete', name: 'Remote Conflict', version: 3 }),
      });
      mockProjectState.getProject.mockReturnValue(createProject({ id: 'proj-active-pending-delete', name: 'Local Conflict' }));
      mockSyncCoordinator.resolveConflict.mockResolvedValueOnce({
        ok: true,
        value: createProject({ id: 'proj-active-pending-delete', name: 'Resolved Conflict', version: 4 }),
      });
      mockUserSession.currentUserId.mockReturnValue('user-1');
      const resolved = await service.resolveConflict('proj-active-pending-delete', 'local');
      expect(resolved).toBe(true);
      expect(mockProjectConflictDirectSync.executeDurably).toHaveBeenCalledWith(
        expect.objectContaining({
          taskIdsToDelete: ['task-delete-fast-click'],
          taskDeleteBaseUpdatedAtMap: {
            'task-delete-fast-click': '2026-04-01T00:00:00.000Z',
          },
        }),
        expect.any(Function),
      );
    });
    registerProjectOperationConflictResolutionStaleCleanupSpecs(getContext);
  });
}
