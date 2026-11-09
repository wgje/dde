import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createProject, type ProjectOperationServiceSpecContext } from './project-operation.test-harness';

type Context = Pick<ProjectOperationServiceSpecContext,
  'projectConflict' | 'mockProjectState' | 'mockSyncCoordinator' | 'mockUserSession'
  | 'mockAuth' | 'mockConflictStorage' | 'mockProjectConflictDirectSync'
  | 'mockActionQueue' | 'mockToast'>;

export function registerProjectOperationConflictRetryOwnerFenceSpecs(
  getContext: () => Context,
): void {
  describe('conflict retry durable owner/Auth settlement', () => {
    let context: Context;

    beforeEach(() => {
      context = getContext();
      const localProject = createProject({ id: 'project-durable-retry', name: 'Local', version: 4 });
      const remoteProject = createProject({ id: localProject.id, name: 'Remote', version: 3 });
      const resolvedProject = createProject({ id: localProject.id, name: 'Resolved', version: 5 });
      context.mockUserSession.currentUserId.mockReturnValue('owner-a');
      context.mockUserSession.getCurrentSessionGeneration.mockReturnValue(4);
      context.mockUserSession.isSessionContextCurrent.mockReturnValue(true);
      context.mockAuth.currentUserId.mockReturnValue('owner-a');
      context.mockAuth.captureAuthIdentityFence.mockReturnValue('auth-fence-a');
      context.mockProjectState.getProject.mockReturnValue(localProject);
      context.mockProjectState.getProjectWithCurrentData.mockReturnValue(localProject);
      context.mockConflictStorage.getConflict.mockResolvedValue({
        projectId: localProject.id, ownerUserId: 'owner-a', localProject, remoteProject,
        remoteSnapshotFresh: true, conflictedAt: '2026-07-29T00:00:00.000Z',
        localVersion: 4, remoteVersion: 3, reason: 'version_mismatch', acknowledged: false,
      });
      context.mockSyncCoordinator.resolveConflict.mockResolvedValue({ ok: true, value: resolvedProject });
      context.mockProjectConflictDirectSync.executeDurably.mockResolvedValue({ status: 'complete' });
    });

    it('foreground captures owner, generation and opaque Auth fence for durable direct sync', async () => {
      await expect(context.projectConflict.resolveConflict('project-durable-retry', 'local'))
        .resolves.toBe(true);

      expect(context.mockProjectConflictDirectSync.executeDurably).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerUserId: 'owner-a', sessionGeneration: 4, authFence: 'auth-fence-a',
          resolvedProject: expect.objectContaining({ id: 'project-durable-retry', name: 'Resolved' }),
          conflictRecord: expect.objectContaining({
            projectId: 'project-durable-retry', ownerUserId: 'owner-a',
          }),
          background: false,
        }),
        expect.any(Function),
      );
      expect(context.mockSyncCoordinator.core.saveProjectSmart).not.toHaveBeenCalled();
    });

    it.each(['stale', 'storage-failed', 'deferred'] as const)(
      'foreground %s outcome preserves conflict evidence and suppresses local publication',
      async status => {
        context.mockProjectConflictDirectSync.executeDurably.mockResolvedValueOnce({ status });

        await expect(context.projectConflict.resolveConflict('project-durable-retry', 'local'))
          .resolves.toBe(false);

        expect(context.mockConflictStorage.deleteConflict).not.toHaveBeenCalled();
        expect(context.mockProjectState.updateProjects).not.toHaveBeenCalled();
        expect(context.mockActionQueue.discardActions).not.toHaveBeenCalled();
      },
    );

    it('background returns success only after durable executor confirms queued evidence', async () => {
      context.mockProjectConflictDirectSync.executeDurably.mockResolvedValueOnce({ status: 'queued' });

      await expect(context.projectConflict.resolveConflict(
        'project-durable-retry', 'local', { backgroundPersist: true },
      )).resolves.toBe(true);

      expect(context.mockProjectConflictDirectSync.executeDurably).toHaveBeenCalledWith(
        expect.objectContaining({ background: true }), expect.any(Function),
      );
      expect(context.mockConflictStorage.deleteConflict).not.toHaveBeenCalled();
      expect(context.mockProjectState.updateProjects).not.toHaveBeenCalled();
    });

    it('durable executor rejection fails closed without clearing conflict evidence', async () => {
      context.mockProjectConflictDirectSync.executeDurably.mockRejectedValueOnce(new Error('idb unavailable'));

      await expect(context.projectConflict.resolveConflict('project-durable-retry', 'local'))
        .resolves.toBe(false);

      expect(context.mockConflictStorage.deleteConflict).not.toHaveBeenCalled();
      expect(context.mockProjectState.updateProjects).not.toHaveBeenCalled();
      expect(context.mockToast.success).not.toHaveBeenCalled();
    });
  });
}
