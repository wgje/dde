import { describe, expect, it } from 'vitest';

import { createDeferred, createProject } from './project-operation.test-harness';
import type { ProjectOperationConflictResolutionSpecContext } from './project-operation-conflict-resolution.spec-context';

export function registerProjectOperationConflictResolutionStaleCleanupSpecs(
  getContext: () => ProjectOperationConflictResolutionSpecContext,
): void {
  describe('durable conflict retry stale cleanup', () => {
    it('local snapshot persistence finishing after an owner switch does not publish resolved state', async () => {
      const {
        service, mockAuth, mockUserSession, mockProjectState, mockSyncCoordinator,
        mockConflictStorage,
      } = getContext();
      const projectId = 'project-local-snapshot-owner-switch';
      const localProject = createProject({ id: projectId, name: 'Local', version: 4 });
      const remoteProject = createProject({ id: projectId, name: 'Remote', version: 3 });
      const resolvedProject = createProject({ id: projectId, name: 'Resolved', version: 5 });
      const snapshotWrite = createDeferred<void>();
      mockUserSession.currentUserId.mockReturnValue('local-user');
      mockUserSession.getCurrentSessionGeneration.mockReturnValue(4);
      mockUserSession.isSessionContextCurrent.mockReturnValue(true);
      mockAuth.currentUserId.mockReturnValue('local-user');
      mockAuth.captureAuthIdentityFence.mockReturnValue('fence-local');
      mockProjectState.getProjectWithCurrentData.mockReturnValue(localProject);
      mockConflictStorage.getConflict.mockResolvedValue({
        projectId, ownerUserId: 'local-user', localProject, remoteProject,
        remoteSnapshotFresh: true, conflictedAt: '2026-07-29T00:00:00.000Z',
        localVersion: 4, remoteVersion: 3, reason: 'version_mismatch', acknowledged: false,
      });
      mockSyncCoordinator.resolveConflict.mockResolvedValue({ ok: true, value: resolvedProject });
      mockSyncCoordinator.core.saveOfflineSnapshotAndWait.mockReturnValueOnce(snapshotWrite.promise);

      const resultPromise = service.resolveConflict(projectId, 'local');
      await expect.poll(() => mockSyncCoordinator.core.saveOfflineSnapshotAndWait.mock.calls.length).toBe(1);
      mockUserSession.currentUserId.mockReturnValue('owner-b');
      mockUserSession.getCurrentSessionGeneration.mockReturnValue(5);
      mockAuth.currentUserId.mockReturnValue('owner-b');
      mockAuth.captureAuthIdentityFence.mockReturnValue('fence-b');
      snapshotWrite.resolve(undefined);

      await expect(resultPromise).resolves.toBe(false);
      expect(mockSyncCoordinator.core.saveOfflineSnapshotAndWait).toHaveBeenCalledWith(
        expect.any(Array),
        'local-user',
      );
      expect(mockProjectState.updateProjects).not.toHaveBeenCalled();
      expect(mockConflictStorage.deleteConflict).not.toHaveBeenCalled();
    });

    it('A to B during conflict cleanup read preserves the new owner active conflict', async () => {
      const {
        service, mockAuth, mockUserSession, mockProjectState, mockSyncCoordinator,
        mockConflictStorage,
      } = getContext();
      const projectId = 'project-owner-switch-during-conflict-read';
      const localProject = createProject({ id: projectId, name: 'Local', version: 4 });
      const remoteProject = createProject({ id: projectId, name: 'Remote', version: 3 });
      const resolvedProject = createProject({ id: projectId, name: 'Resolved', version: 5 });
      const storedConflict = {
        projectId, ownerUserId: 'owner-a', localProject, remoteProject,
        remoteSnapshotFresh: true, conflictedAt: '2026-07-29T00:00:00.000Z',
        localVersion: 4, remoteVersion: 3, reason: 'version_mismatch', acknowledged: false,
      };
      const activeConflict = {
        projectId, local: localProject, remote: remoteProject,
        conflictedAt: storedConflict.conflictedAt,
      };
      const cleanupRead = createDeferred<typeof storedConflict | null>();
      mockUserSession.currentUserId.mockReturnValue('owner-a');
      mockUserSession.getCurrentSessionGeneration.mockReturnValue(4);
      mockUserSession.isSessionContextCurrent.mockReturnValue(true);
      mockAuth.currentUserId.mockReturnValue('owner-a');
      mockAuth.captureAuthIdentityFence.mockReturnValue('fence-a');
      mockProjectState.getProjectWithCurrentData.mockReturnValue(localProject);
      mockSyncCoordinator.conflictData.mockReturnValue(activeConflict);
      mockConflictStorage.getConflict
        .mockResolvedValueOnce(storedConflict)
        .mockResolvedValueOnce(storedConflict)
        .mockReturnValueOnce(cleanupRead.promise);
      mockSyncCoordinator.resolveConflict.mockResolvedValue({ ok: true, value: resolvedProject });
      const resultPromise = service.resolveConflict(projectId, 'remote');
      await expect.poll(() => mockConflictStorage.getConflict.mock.calls.length).toBe(3);
      mockUserSession.currentUserId.mockReturnValue('owner-b');
      mockUserSession.getCurrentSessionGeneration.mockReturnValue(5);
      mockAuth.currentUserId.mockReturnValue('owner-b');
      mockAuth.captureAuthIdentityFence.mockReturnValue('fence-b');
      cleanupRead.resolve(storedConflict);

      await expect(resultPromise).resolves.toBe(false);
      expect(mockConflictStorage.deleteConflict).not.toHaveBeenCalled();
      expect(mockSyncCoordinator.clearActiveConflict).not.toHaveBeenCalled();
    });

    it('A to B during conflict deletion does not clear the new owner active conflict', async () => {
      const {
        service, mockAuth, mockUserSession, mockProjectState, mockSyncCoordinator,
        mockConflictStorage,
      } = getContext();
      const projectId = 'project-owner-switch-during-conflict-delete';
      const localProject = createProject({ id: projectId, name: 'Local', version: 4 });
      const remoteProject = createProject({ id: projectId, name: 'Remote', version: 3 });
      const resolvedProject = createProject({ id: projectId, name: 'Resolved', version: 5 });
      const storedConflict = {
        projectId, ownerUserId: 'owner-a', localProject, remoteProject,
        remoteSnapshotFresh: true, conflictedAt: '2026-07-29T00:00:00.000Z',
        localVersion: 4, remoteVersion: 3, reason: 'version_mismatch', acknowledged: false,
      };
      const activeConflict = {
        projectId, local: localProject, remote: remoteProject,
        conflictedAt: storedConflict.conflictedAt,
      };
      const conflictDelete = createDeferred<boolean>();
      mockUserSession.currentUserId.mockReturnValue('owner-a');
      mockUserSession.getCurrentSessionGeneration.mockReturnValue(4);
      mockUserSession.isSessionContextCurrent.mockReturnValue(true);
      mockAuth.currentUserId.mockReturnValue('owner-a');
      mockAuth.captureAuthIdentityFence.mockReturnValue('fence-a');
      mockProjectState.getProjectWithCurrentData.mockReturnValue(localProject);
      mockSyncCoordinator.conflictData.mockReturnValue(activeConflict);
      mockConflictStorage.getConflict.mockResolvedValue(storedConflict);
      mockConflictStorage.deleteConflict.mockReturnValueOnce(conflictDelete.promise);
      mockSyncCoordinator.resolveConflict.mockResolvedValue({ ok: true, value: resolvedProject });
      const resultPromise = service.resolveConflict(projectId, 'remote');
      await expect.poll(() => mockConflictStorage.deleteConflict.mock.calls.length).toBe(1);
      mockUserSession.currentUserId.mockReturnValue('owner-b');
      mockUserSession.getCurrentSessionGeneration.mockReturnValue(5);
      mockAuth.currentUserId.mockReturnValue('owner-b');
      mockAuth.captureAuthIdentityFence.mockReturnValue('fence-b');
      conflictDelete.resolve(true);

      await expect(resultPromise).resolves.toBe(false);
      expect(mockConflictStorage.deleteConflict).toHaveBeenCalledWith(projectId, 'owner-a');
      expect(mockSyncCoordinator.clearActiveConflict).not.toHaveBeenCalled();
    });

    it('same-owner relogin after durable executor await preserves conflict and local state', async () => {
      const {
        service, mockAuth, mockUserSession, mockProjectState, mockSyncCoordinator,
        mockConflictStorage, mockProjectConflictDirectSync, mockActionQueue,
      } = getContext();
      const projectId = 'project-relogin-after-durable';
      const localProject = createProject({ id: projectId, name: 'Local', version: 4 });
      const remoteProject = createProject({ id: projectId, name: 'Remote', version: 3 });
      const completion = createDeferred<{ status: 'complete' }>();
      mockUserSession.currentUserId.mockReturnValue('owner-a');
      mockUserSession.getCurrentSessionGeneration.mockReturnValue(4);
      mockUserSession.isSessionContextCurrent.mockReturnValue(true);
      mockAuth.captureAuthIdentityFence.mockReturnValue('fence-a');
      mockProjectState.getProject.mockReturnValue(localProject);
      mockProjectState.getProjectWithCurrentData.mockReturnValue(localProject);
      mockConflictStorage.getConflict.mockResolvedValue({
        projectId, ownerUserId: 'owner-a', localProject, remoteProject,
        remoteSnapshotFresh: true, conflictedAt: '2026-07-29T00:00:00.000Z',
        localVersion: 4, remoteVersion: 3, reason: 'version_mismatch', acknowledged: false,
      });
      mockSyncCoordinator.resolveConflict.mockResolvedValue({
        ok: true, value: createProject({ id: projectId, name: 'Resolved', version: 5 }),
      });
      mockProjectConflictDirectSync.executeDurably.mockReturnValueOnce(completion.promise);

      const resultPromise = service.resolveConflict(projectId, 'local');
      await expect.poll(() => mockProjectConflictDirectSync.executeDurably.mock.calls.length).toBe(1);
      mockAuth.captureAuthIdentityFence.mockReturnValue('fence-b');
      completion.resolve({ status: 'complete' });

      await expect(resultPromise).resolves.toBe(false);
      expect(mockConflictStorage.deleteConflict).not.toHaveBeenCalled();
      expect(mockProjectState.updateProjects).not.toHaveBeenCalled();
      expect(mockActionQueue.discardActions).not.toHaveBeenCalled();
    });

    it('A to B after durable executor returns stale without settling either owner', async () => {
      const {
        service, mockAuth, mockUserSession, mockProjectState, mockSyncCoordinator,
        mockConflictStorage, mockProjectConflictDirectSync, mockActionQueue,
      } = getContext();
      const projectId = 'project-owner-switch-after-durable';
      const localProject = createProject({ id: projectId, name: 'Local', version: 4 });
      mockUserSession.currentUserId.mockReturnValue('owner-a');
      mockUserSession.getCurrentSessionGeneration.mockReturnValue(4);
      mockUserSession.isSessionContextCurrent.mockReturnValue(true);
      mockAuth.captureAuthIdentityFence.mockReturnValue('fence-a');
      mockProjectState.getProject.mockReturnValue(localProject);
      mockProjectState.getProjectWithCurrentData.mockReturnValue(localProject);
      mockConflictStorage.getConflict.mockResolvedValue({
        projectId, ownerUserId: 'owner-a', localProject,
        conflictedAt: '2026-07-29T00:00:00.000Z', localVersion: 4,
        reason: 'version_mismatch', acknowledged: false,
      });
      mockSyncCoordinator.resolveConflict.mockResolvedValue({
        ok: true, value: createProject({ id: projectId, name: 'Resolved', version: 5 }),
      });
      mockProjectConflictDirectSync.executeDurably.mockImplementationOnce(async () => {
        mockUserSession.currentUserId.mockReturnValue('owner-b');
        mockAuth.captureAuthIdentityFence.mockReturnValue('fence-b');
        return { status: 'stale' };
      });

      await expect(service.resolveConflict(projectId, 'local')).resolves.toBe(false);
      expect(mockConflictStorage.deleteConflict).not.toHaveBeenCalled();
      expect(mockProjectState.updateProjects).not.toHaveBeenCalled();
      expect(mockActionQueue.discardActions).not.toHaveBeenCalled();
    });
  });
}
