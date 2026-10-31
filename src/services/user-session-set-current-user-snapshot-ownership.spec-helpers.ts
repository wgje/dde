import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AUTH_CONFIG } from '../config/auth.config';
import type { Project } from '../models';
import {
  AuthOwnerTransitionController,
  bindAuthOwnerTransition,
} from './auth-owner-transition.controller';
import type {
  OwnerChangePreparation,
  SessionGuardContext,
  SetCurrentUserContext,
} from './user-session-base.service';
import type { UserSessionServiceSpecContext } from './user-session.service.spec-context';

interface OwnerTransitionLayer6Surface {
  invalidateSessionRequestGeneration: (reason: string) => void;
  prepareOwnerChange: (
    context: SetCurrentUserContext,
    sessionGuard: SessionGuardContext,
  ) => Promise<OwnerChangePreparation | null>;
  applyOwnerChangeCleanup: (
    context: SetCurrentUserContext,
    preparation: OwnerChangePreparation,
  ) => void;
  recoverInterruptedDataSafetyRestoreForCurrentUser: (
    context: SetCurrentUserContext,
    sessionGuard: SessionGuardContext,
  ) => Promise<boolean>;
  reloadCurrentOwnerQueues: (skipPersistentReload: boolean) => Promise<void>;
  loadSessionDataForCurrentUser: (
    context: SetCurrentUserContext,
    sessionGuard: SessionGuardContext,
  ) => Promise<void>;
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(promiseResolve => { resolve = promiseResolve; });
  return { promise, resolve };
}

export function registerUserSessionSetCurrentUserSnapshotOwnershipSpecs(getContext: () => UserSessionServiceSpecContext): void {
  let context: UserSessionServiceSpecContext;

  beforeEach(() => {
    context = getContext();
    let generation = 0;
    const ownerTransition = new AuthOwnerTransitionController({
      generation: () => generation,
      currentOwnerUserId: () => context.userIdSignal(),
      pendingOwnerUserId: () => null,
      advanceGeneration: () => { generation += 1; },
      publishTargetOwner: ownerUserId => context.userIdSignal.set(ownerUserId),
    });
    bindAuthOwnerTransition(context.mockAuthService, ownerTransition);
    context.mockAuthService['ownerTransitionForTest'] = ownerTransition;
    context.mockAuthService['ownerGenerationForTest'] = () => generation;
    context.mockAuthService['advanceOwnerForTest'] = (ownerUserId: string | null) => {
      context.userIdSignal.set(ownerUserId);
      ownerTransition.advanceGeneration();
    };
  });

    describe('setCurrentUser', () => {
      it('匿名态登录且存在 local-only 项目时应保留本地草稿快照并只清理歧义队列', async () => {
        const localOnlyProject = context.createProject({ id: 'local-only', syncSource: 'local-only' });
        let preservedProjects: Project[] = [];
        let preservedOwnerUserId: string | null = null;
        (context.mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([localOnlyProject]);
        (context.mockSyncCoordinator['core'] as { saveOfflineSnapshot: ReturnType<typeof vi.fn> }).saveOfflineSnapshot.mockImplementation((projects: Project[], ownerUserId?: string | null) => {
          preservedProjects = projects;
          preservedOwnerUserId = ownerUserId ?? null;
        });
        (context.mockSyncCoordinator['core'] as {
          loadStartupOfflineSnapshot: ReturnType<typeof vi.fn>;
        }).loadStartupOfflineSnapshot.mockImplementation(async () => ({
          source: 'idb',
          projectCount: preservedProjects.length,
          bytes: 128,
          migratedLegacy: false,
          ownerUserId: preservedOwnerUserId,
          projects: preservedProjects,
        }));

        await context.service.setCurrentUser('new-user', { forceLoad: true });

        expect(context.mockActionQueue['clearCurrentView']).toHaveBeenCalled();
        expect(context.mockRetryQueue['clearCurrentView']).toHaveBeenCalled();
        expect((context.mockSyncCoordinator['core'] as { saveOfflineSnapshot: ReturnType<typeof vi.fn> }).saveOfflineSnapshot).toHaveBeenCalledWith([
          expect.objectContaining({ id: 'local-only', syncSource: 'local-only' }),
        ], 'new-user');
        expect((context.mockSyncCoordinator['core'] as { clearOfflineSnapshot: ReturnType<typeof vi.fn> }).clearOfflineSnapshot).not.toHaveBeenCalled();
        expect(context.mockActionQueue['reloadFromStorageForCurrentOwner']).toHaveBeenCalled();
        expect(context.mockRetryQueue['reloadFromStorageForCurrentOwner']).toHaveBeenCalled();
        expect(context.mockProjectState['setProjects']).toHaveBeenCalledWith([
          expect.objectContaining({ id: 'local-only', syncSource: 'local-only', pendingSync: true }),
        ]);
      });

      it('local-user 登录真实账号时也应保留 local-only 草稿快照', async () => {
        const localOnlyProject = context.createProject({ id: 'local-mode-project', syncSource: 'local-only' });
        let preservedProjects: Project[] = [];
        let preservedOwnerUserId: string | null = null;
        context.userIdSignal.set(AUTH_CONFIG.LOCAL_MODE_USER_ID);
        (context.mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([localOnlyProject]);
        (context.mockSyncCoordinator['core'] as { saveOfflineSnapshot: ReturnType<typeof vi.fn> }).saveOfflineSnapshot.mockImplementation((projects: Project[], ownerUserId?: string | null) => {
          preservedProjects = projects;
          preservedOwnerUserId = ownerUserId ?? null;
        });
        (context.mockSyncCoordinator['core'] as {
          loadStartupOfflineSnapshot: ReturnType<typeof vi.fn>;
        }).loadStartupOfflineSnapshot.mockImplementation(async () => ({
          source: 'idb',
          projectCount: preservedProjects.length,
          bytes: 128,
          migratedLegacy: false,
          ownerUserId: preservedOwnerUserId,
          projects: preservedProjects,
        }));

        await context.service.setCurrentUser('new-user', { forceLoad: true });

        expect(context.mockRetryQueue['clearCurrentView']).toHaveBeenCalled();
        expect((context.mockSyncCoordinator['core'] as { saveOfflineSnapshot: ReturnType<typeof vi.fn> }).saveOfflineSnapshot).toHaveBeenCalledWith([
          expect.objectContaining({ id: 'local-mode-project', syncSource: 'local-only' }),
        ], 'new-user');
        expect((context.mockSyncCoordinator['core'] as { clearOfflineSnapshot: ReturnType<typeof vi.fn> }).clearOfflineSnapshot).not.toHaveBeenCalled();
        expect(context.mockActionQueue['reloadFromStorageForCurrentOwner']).toHaveBeenCalled();
        expect(context.mockRetryQueue['reloadFromStorageForCurrentOwner']).toHaveBeenCalled();
        expect(context.mockProjectState['setProjects']).toHaveBeenCalledWith([
          expect.objectContaining({ id: 'local-mode-project', syncSource: 'local-only', pendingSync: true }),
        ]);
      });

      it('hint-only 启动占位不应被当成 guest draft 迁移到目标 owner', async () => {
        const placeholderProject = context.createProject({
          id: 'hint-local-only',
          name: 'Placeholder Shell',
          syncSource: 'local-only',
        });
        context.mockStartupPlaceholderState.isHintOnlyActive.mockReturnValue(true);
        (context.mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([placeholderProject]);
        vi.spyOn(
          context.service as unknown as {
            loadUserData: (userId: string, sessionGuard?: unknown) => Promise<void>;
          },
          'loadUserData'
        ).mockResolvedValue(undefined);

        await context.service.setCurrentUser('new-user', { forceLoad: true });

        const saveCalls = ((context.mockSyncCoordinator['core'] as {
          saveOfflineSnapshot: ReturnType<typeof vi.fn>;
        }).saveOfflineSnapshot).mock.calls;
        expect(saveCalls.some(([projects, ownerUserId]) => {
          return ownerUserId === 'new-user'
            && Array.isArray(projects)
            && projects.some((project: Project) => project.id === 'hint-local-only');
        })).toBe(false);
      });

      it('启动快照尚未恢复到 store 时登录，也应先把游客草稿改写为目标 owner', async () => {
        const localOnlyProject = context.createProject({ id: 'bootstrapping-local-only', syncSource: 'local-only' });
        let preservedProjects: Project[] = [localOnlyProject];
        let preservedOwnerUserId: string | null = AUTH_CONFIG.LOCAL_MODE_USER_ID;
        (context.mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([]);
        (context.mockSyncCoordinator['core'] as { saveOfflineSnapshot: ReturnType<typeof vi.fn> }).saveOfflineSnapshot.mockImplementation((projects: Project[], ownerUserId?: string | null) => {
          preservedProjects = projects;
          preservedOwnerUserId = ownerUserId ?? null;
        });
        (context.mockSyncCoordinator['core'] as {
          loadStartupOfflineSnapshot: ReturnType<typeof vi.fn>;
        }).loadStartupOfflineSnapshot.mockImplementation(async () => ({
          source: 'idb',
          projectCount: preservedProjects.length,
          bytes: 128,
          migratedLegacy: false,
          ownerUserId: preservedOwnerUserId,
          projects: preservedProjects,
        }));

        await context.service.setCurrentUser('new-user', { forceLoad: true });

        expect((context.mockSyncCoordinator['core'] as { saveOfflineSnapshot: ReturnType<typeof vi.fn> }).saveOfflineSnapshot).toHaveBeenCalledWith([
          expect.objectContaining({ id: 'bootstrapping-local-only', syncSource: 'local-only' }),
        ], 'new-user');
        expect(context.mockProjectState['setProjects']).toHaveBeenCalledWith([
          expect.objectContaining({ id: 'bootstrapping-local-only', syncSource: 'local-only', pendingSync: true }),
        ]);
      });

      it('设置用户 ID 为 null 时应优先使用 startup snapshot 而不是种子数据', async () => {
        const restoredProject = context.createProject({ id: 'restored-idb-project', name: 'Recovered' });
        (
          context.mockSyncCoordinator['core'] as {
            loadStartupOfflineSnapshot: ReturnType<typeof vi.fn>;
          }
        ).loadStartupOfflineSnapshot.mockResolvedValue({
          source: 'idb',
          projectCount: 1,
          bytes: 256,
          migratedLegacy: false,
          ownerUserId: AUTH_CONFIG.LOCAL_MODE_USER_ID,
          projects: [restoredProject],
        });

        await context.service.setCurrentUser(null);

        expect(
          (context.mockSyncCoordinator['core'] as { loadStartupOfflineSnapshot: ReturnType<typeof vi.fn> }).loadStartupOfflineSnapshot
        ).toHaveBeenCalled();
        expect(context.mockProjectState['setProjects']).toHaveBeenCalledWith([expect.objectContaining({ id: 'restored-idb-project' })]);
      });

      it('owner 不匹配的 startup snapshot 不应在匿名态被恢复', async () => {
        (
          context.mockSyncCoordinator['core'] as {
            loadStartupOfflineSnapshot: ReturnType<typeof vi.fn>;
          }
        ).loadStartupOfflineSnapshot.mockResolvedValue({
          source: 'idb',
          projectCount: 1,
          bytes: 256,
          migratedLegacy: false,
          ownerUserId: 'user-123',
          projects: [context.createProject({ id: 'leaked-project', name: 'Leaked Project' })],
        });

        await context.service.setCurrentUser(null);

        expect(context.mockProjectState['setProjects']).not.toHaveBeenCalledWith([
          expect.objectContaining({ id: 'leaked-project' }),
        ]);
      });

      it('缺少 owner 元数据的 startup snapshot 不应在匿名态被恢复', async () => {
        (
          context.mockSyncCoordinator['core'] as {
            loadStartupOfflineSnapshot: ReturnType<typeof vi.fn>;
          }
        ).loadStartupOfflineSnapshot.mockResolvedValue({
          source: 'idb',
          projectCount: 1,
          bytes: 256,
          migratedLegacy: true,
          projects: [context.createProject({ id: 'ownerless-guest-project', name: 'Ownerless Guest Project' })],
        });

        await context.service.setCurrentUser(null);

        expect(context.mockProjectState['setProjects']).not.toHaveBeenCalledWith([
          expect.objectContaining({ id: 'ownerless-guest-project' }),
        ]);
      });

      it('空 startup snapshot 缺少 owner 元数据时不应输出误报警告', async () => {
        (
          context.mockSyncCoordinator['core'] as {
            loadStartupOfflineSnapshot: ReturnType<typeof vi.fn>;
          }
        ).loadStartupOfflineSnapshot.mockResolvedValue({
          source: 'none',
          projectCount: 0,
          bytes: 0,
          migratedLegacy: false,
          projects: [],
        });

        await context.service.setCurrentUser(null);

        expect(context.mockLoggerCategory.warn).not.toHaveBeenCalledWith(
          '检测到缺少 owner 元数据的离线快照，已忽略本次恢复',
          expect.anything(),
        );
      });

      it('owner 不匹配的 startup snapshot 不应在登录态被恢复', async () => {
        (
          context.mockSyncCoordinator['core'] as {
            loadStartupOfflineSnapshot: ReturnType<typeof vi.fn>;
          }
        ).loadStartupOfflineSnapshot.mockResolvedValue({
          source: 'idb',
          projectCount: 1,
          bytes: 256,
          migratedLegacy: false,
          ownerUserId: 'old-user',
          projects: [context.createProject({ id: 'wrong-owner-project', name: 'Wrong Owner Project' })],
        });

        await context.service.setCurrentUser('new-user', { forceLoad: true });

        expect(context.mockProjectState['setProjects']).not.toHaveBeenCalledWith([
          expect.objectContaining({ id: 'wrong-owner-project' }),
        ]);
      });

      it('缺少 owner 元数据的 startup snapshot 不应在登录态被恢复', async () => {
        (
          context.mockSyncCoordinator['core'] as {
            loadStartupOfflineSnapshot: ReturnType<typeof vi.fn>;
          }
        ).loadStartupOfflineSnapshot.mockResolvedValue({
          source: 'idb',
          projectCount: 1,
          bytes: 256,
          migratedLegacy: true,
          projects: [context.createProject({ id: 'ownerless-login-project', name: 'Ownerless Login Project' })],
        });

        await context.service.setCurrentUser('new-user', { forceLoad: true });

        expect(context.mockProjectState['setProjects']).not.toHaveBeenCalledWith([
          expect.objectContaining({ id: 'ownerless-login-project' }),
        ]);
      });

      it('用户切换时清理旧数据', async () => {
        // Set a previous userId through the signal
        context.userIdSignal.set('old-user');
        await context.service.getAttachmentServiceLazy();

        await context.service.setCurrentUser('new-user');

        expect(context.mockAttachmentService['clearMonitoredAttachments']).toHaveBeenCalled();
        expect(context.mockUndoService['clearHistory']).toHaveBeenCalled();
      });

      it('冷启动 forceLoad 时应保留预填充的 activeProjectId，避免首屏主内容掉空', async () => {
        const restoredProject = context.createProject({ id: 'proj-snapshot', name: 'Recovered' });
        (context.mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([restoredProject]);
        (context.mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>).mockReturnValue('proj-snapshot');
        (
          context.service as unknown as {
            prehydratedSnapshotApplied: boolean;
            prehydratedSnapshotOwnerId: string | null;
          }
        ).prehydratedSnapshotApplied = true;
        (
          context.service as unknown as {
            prehydratedSnapshotApplied: boolean;
            prehydratedSnapshotOwnerId: string | null;
          }
        ).prehydratedSnapshotOwnerId = 'new-user';

        vi.spyOn(
          context.service as unknown as {
            loadUserData: (userId: string) => Promise<void>;
          },
          'loadUserData'
        ).mockResolvedValue(undefined);

        await context.service.setCurrentUser('new-user', { forceLoad: true });

        expect(context.mockProjectState['setActiveProjectId']).not.toHaveBeenCalledWith(null);
      });

      it('冷启动 forceLoad 遇到未知或非当前用户的快照时应立即清空预填充内容', async () => {
        const restoredProject = context.createProject({ id: 'proj-snapshot', name: 'Recovered' });
        (context.mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([restoredProject]);
        (context.mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>).mockReturnValue('proj-snapshot');
        (
          context.service as unknown as {
            prehydratedSnapshotApplied: boolean;
            prehydratedSnapshotOwnerId: string | null;
          }
        ).prehydratedSnapshotApplied = true;
        (
          context.service as unknown as {
            prehydratedSnapshotApplied: boolean;
            prehydratedSnapshotOwnerId: string | null;
          }
        ).prehydratedSnapshotOwnerId = 'other-user';

        vi.spyOn(
          context.service as unknown as {
            loadUserData: (userId: string) => Promise<void>;
          },
          'loadUserData'
        ).mockResolvedValue(undefined);

        await context.service.setCurrentUser('new-user', { forceLoad: true });

        expect(context.mockProjectState['setActiveProjectId']).toHaveBeenCalledWith(null);
        expect(context.mockProjectState['clearData']).toHaveBeenCalledTimes(1);
      });

      it('deferred owner transition rejects an A to B to A auth generation without target publication', async () => {
        const layer6 = context.service as unknown as OwnerTransitionLayer6Surface;
        const prepared = createDeferred<void>();
        const release = createDeferred<void>();
        const originalPrepare = layer6.prepareOwnerChange.bind(layer6);
        let held = false;
        vi.spyOn(layer6, 'prepareOwnerChange').mockImplementation(async (...args) => {
          const result = await originalPrepare(...args);
          if (!held) {
            held = true;
            prepared.resolve();
            await release.promise;
          }
          return result;
        });
        const cleanup = vi.spyOn(layer6, 'applyOwnerChangeCleanup');
        const recover = vi.spyOn(
          layer6,
          'recoverInterruptedDataSafetyRestoreForCurrentUser',
        ).mockResolvedValue(true);
        const reload = vi.spyOn(layer6, 'reloadCurrentOwnerQueues').mockResolvedValue(undefined);
        const load = vi.spyOn(layer6, 'loadSessionDataForCurrentUser').mockResolvedValue(undefined);
        const advanceOwner = context.mockAuthService['advanceOwnerForTest'] as (
          ownerUserId: string | null,
        ) => void;
        context.userIdSignal.set('owner-a');

        const pending = context.service.setCurrentUser('owner-b', { forceLoad: true });
        await prepared.promise;
        advanceOwner('owner-b');
        advanceOwner('owner-a');
        release.resolve();
        await pending;

        expect(context.userIdSignal()).toBe('owner-a');
        expect(cleanup).not.toHaveBeenCalled();
        expect(recover).not.toHaveBeenCalled();
        expect(reload).not.toHaveBeenCalled();
        expect(load).not.toHaveBeenCalled();
      });

      it('same-owner setCurrentUser advances the auth owner generation', async () => {
        const generation = context.mockAuthService['ownerGenerationForTest'] as () => number;
        context.userIdSignal.set('owner-a');
        const before = generation();

        await context.service.setCurrentUser('owner-a', { skipPersistentReload: true });

        expect(context.userIdSignal()).toBe('owner-a');
        expect(generation()).toBe(before + 1);
      });

      it('reentrant auth transition during cleanup rejects the stale target and all target-side work', async () => {
        const layer6 = context.service as unknown as OwnerTransitionLayer6Surface;
        const advanceOwner = context.mockAuthService['advanceOwnerForTest'] as (
          ownerUserId: string | null,
        ) => void;
        context.userIdSignal.set('owner-a');
        vi.spyOn(layer6, 'applyOwnerChangeCleanup').mockImplementation(() => {
          advanceOwner('owner-c');
        });
        const recover = vi.spyOn(
          layer6,
          'recoverInterruptedDataSafetyRestoreForCurrentUser',
        ).mockResolvedValue(true);
        const reload = vi.spyOn(layer6, 'reloadCurrentOwnerQueues').mockResolvedValue(undefined);
        const load = vi.spyOn(layer6, 'loadSessionDataForCurrentUser').mockResolvedValue(undefined);

        await context.service.setCurrentUser('owner-b', { forceLoad: true });

        expect(context.userIdSignal()).toBe('owner-c');
        expect(recover).not.toHaveBeenCalled();
        expect(reload).not.toHaveBeenCalled();
        expect(load).not.toHaveBeenCalled();
      });

      it('capture-only reentrancy during cleanup rejects the older target and leaves the newer transition usable', async () => {
        const layer6 = context.service as unknown as OwnerTransitionLayer6Surface;
        const nestedPreparing = createDeferred<void>();
        const releaseNested = createDeferred<void>();
        const originalPrepare = layer6.prepareOwnerChange.bind(layer6);
        let prepareCount = 0;
        vi.spyOn(layer6, 'prepareOwnerChange').mockImplementation(async (...args) => {
          const result = await originalPrepare(...args);
          prepareCount += 1;
          if (prepareCount === 2) {
            nestedPreparing.resolve();
            await releaseNested.promise;
          }
          return result;
        });
        const originalCleanup = layer6.applyOwnerChangeCleanup.bind(layer6);
        let nested: Promise<void> | undefined;
        let cleanupCount = 0;
        vi.spyOn(layer6, 'applyOwnerChangeCleanup').mockImplementation((...args) => {
          cleanupCount += 1;
          if (cleanupCount === 1) {
            nested = context.service.setCurrentUser('owner-c', {
              forceLoad: true,
              skipPersistentReload: true,
            });
          }
          originalCleanup(...args);
        });
        const recover = vi.spyOn(
          layer6,
          'recoverInterruptedDataSafetyRestoreForCurrentUser',
        ).mockResolvedValue(true);
        const reload = vi.spyOn(layer6, 'reloadCurrentOwnerQueues').mockResolvedValue(undefined);
        const load = vi.spyOn(layer6, 'loadSessionDataForCurrentUser').mockResolvedValue(undefined);
        context.userIdSignal.set('owner-a');

        await context.service.setCurrentUser('owner-b', { forceLoad: true });
        expect(context.userIdSignal()).toBe('owner-a');
        await nestedPreparing.promise;
        releaseNested.resolve();
        await nested;

        expect(context.userIdSignal()).toBe('owner-c');
        expect(recover).not.toHaveBeenCalled();
        expect(reload).toHaveBeenCalledTimes(1);
        expect(load).not.toHaveBeenCalled();
      });

      it('discards the captured ticket when owner preparation returns null', async () => {
        const layer6 = context.service as unknown as OwnerTransitionLayer6Surface;
        const ownerTransition = context.mockAuthService['ownerTransitionForTest'] as AuthOwnerTransitionController;
        const discard = vi.spyOn(ownerTransition, 'discard');
        const generation = context.mockAuthService['ownerGenerationForTest'] as () => number;
        vi.spyOn(layer6, 'prepareOwnerChange').mockResolvedValue(null);
        const recover = vi.spyOn(layer6, 'recoverInterruptedDataSafetyRestoreForCurrentUser');
        const reload = vi.spyOn(layer6, 'reloadCurrentOwnerQueues');
        const load = vi.spyOn(layer6, 'loadSessionDataForCurrentUser');
        context.userIdSignal.set('owner-a');

        await context.service.setCurrentUser('owner-b', { forceLoad: true });

        expect(discard).toHaveBeenCalledOnce();
        expect(generation()).toBe(0);
        expect(context.userIdSignal()).toBe('owner-a');
        expect(recover).not.toHaveBeenCalled();
        expect(reload).not.toHaveBeenCalled();
        expect(load).not.toHaveBeenCalled();
      });

      it('discards the captured ticket when owner preparation becomes session-stale', async () => {
        const layer6 = context.service as unknown as OwnerTransitionLayer6Surface;
        const ownerTransition = context.mockAuthService['ownerTransitionForTest'] as AuthOwnerTransitionController;
        const discard = vi.spyOn(ownerTransition, 'discard');
        const prepared = createDeferred<void>();
        const release = createDeferred<void>();
        const originalPrepare = layer6.prepareOwnerChange.bind(layer6);
        vi.spyOn(layer6, 'prepareOwnerChange').mockImplementation(async (...args) => {
          const result = await originalPrepare(...args);
          prepared.resolve();
          await release.promise;
          return result;
        });
        const recover = vi.spyOn(layer6, 'recoverInterruptedDataSafetyRestoreForCurrentUser');
        const reload = vi.spyOn(layer6, 'reloadCurrentOwnerQueues');
        const load = vi.spyOn(layer6, 'loadSessionDataForCurrentUser');
        context.userIdSignal.set('owner-a');

        const pending = context.service.setCurrentUser('owner-b', { forceLoad: true });
        await prepared.promise;
        layer6.invalidateSessionRequestGeneration('owner-transition-spec');
        release.resolve();
        await pending;

        expect(discard).toHaveBeenCalledOnce();
        expect(context.userIdSignal()).toBe('owner-a');
        expect(recover).not.toHaveBeenCalled();
        expect(reload).not.toHaveBeenCalled();
        expect(load).not.toHaveBeenCalled();
      });

      it('discards the captured ticket and rethrows when owner preparation fails', async () => {
        const layer6 = context.service as unknown as OwnerTransitionLayer6Surface;
        const ownerTransition = context.mockAuthService['ownerTransitionForTest'] as AuthOwnerTransitionController;
        const discard = vi.spyOn(ownerTransition, 'discard');
        const failure = new Error('owner preparation failed');
        vi.spyOn(layer6, 'prepareOwnerChange').mockRejectedValue(failure);
        const recover = vi.spyOn(layer6, 'recoverInterruptedDataSafetyRestoreForCurrentUser');
        const reload = vi.spyOn(layer6, 'reloadCurrentOwnerQueues');
        const load = vi.spyOn(layer6, 'loadSessionDataForCurrentUser');
        context.userIdSignal.set('owner-a');

        await expect(context.service.setCurrentUser('owner-b', { forceLoad: true }))
          .rejects.toBe(failure);

        expect(discard).toHaveBeenCalledOnce();
        expect(context.userIdSignal()).toBe('owner-a');
        expect(recover).not.toHaveBeenCalled();
        expect(reload).not.toHaveBeenCalled();
        expect(load).not.toHaveBeenCalled();
      });

      it('cleanup failure is terminal and performs no target publication, queue reload, load, or recovery', async () => {
        const layer6 = context.service as unknown as OwnerTransitionLayer6Surface;
        const generation = context.mockAuthService['ownerGenerationForTest'] as () => number;
        const failure = new Error('owner cleanup failed');
        context.userIdSignal.set('owner-a');
        const before = generation();
        vi.spyOn(layer6, 'applyOwnerChangeCleanup').mockImplementation(() => { throw failure; });
        const recover = vi.spyOn(
          layer6,
          'recoverInterruptedDataSafetyRestoreForCurrentUser',
        ).mockResolvedValue(true);
        const reload = vi.spyOn(layer6, 'reloadCurrentOwnerQueues').mockResolvedValue(undefined);
        const load = vi.spyOn(layer6, 'loadSessionDataForCurrentUser').mockResolvedValue(undefined);

        await expect(context.service.setCurrentUser('owner-b', { forceLoad: true }))
          .rejects.toBe(failure);

        expect(generation()).toBe(before + 1);
        expect(context.userIdSignal()).toBe('owner-a');
        expect(recover).not.toHaveBeenCalled();
        expect(reload).not.toHaveBeenCalled();
        expect(load).not.toHaveBeenCalled();
      });

      it('accepted A to B owner mutation publishes B once and advances generation', async () => {
        const layer6 = context.service as unknown as OwnerTransitionLayer6Surface;
        const ownerTransition = context.mockAuthService['ownerTransitionForTest'] as AuthOwnerTransitionController;
        const generation = context.mockAuthService['ownerGenerationForTest'] as () => number;
        const commit = vi.spyOn(ownerTransition, 'commit');
        const recover = vi.spyOn(
          layer6,
          'recoverInterruptedDataSafetyRestoreForCurrentUser',
        ).mockResolvedValue(true);
        const reload = vi.spyOn(layer6, 'reloadCurrentOwnerQueues').mockResolvedValue(undefined);
        const load = vi.spyOn(layer6, 'loadSessionDataForCurrentUser').mockResolvedValue(undefined);
        context.userIdSignal.set('owner-a');
        const before = generation();

        await context.service.setCurrentUser('owner-b', { forceLoad: true });

        expect(context.userIdSignal()).toBe('owner-b');
        expect(generation()).toBe(before + 1);
        expect(commit).toHaveBeenCalledTimes(1);
        expect(recover).toHaveBeenCalledTimes(1);
        expect(reload).toHaveBeenCalledTimes(1);
        expect(load).toHaveBeenCalledTimes(1);
      });

      it('owner cleanup clearData runs inside commit before the target owner is published', async () => {
        const layer6 = context.service as unknown as OwnerTransitionLayer6Surface;
        const ownerTransition = context.mockAuthService['ownerTransitionForTest'] as AuthOwnerTransitionController;
        const generation = context.mockAuthService['ownerGenerationForTest'] as () => number;
        const clearData = context.mockProjectState['clearData'] as ReturnType<typeof vi.fn>;
        const originalCommit = ownerTransition.commit.bind(ownerTransition);
        let insideCommit = false;
        let insideDuringClear: boolean | null = null;
        vi.spyOn(ownerTransition, 'commit').mockImplementation((ticket, cleanup) => {
          insideCommit = true;
          try {
            return originalCommit(ticket, cleanup);
          } finally {
            insideCommit = false;
          }
        });
        context.userIdSignal.set('owner-a');
        const before = generation();
        let signalDuringClear: string | null = 'unset';
        clearData.mockImplementation(() => {
          signalDuringClear = context.userIdSignal();
          insideDuringClear = insideCommit;
        });

        await context.service.setCurrentUser('owner-b', { forceLoad: true });

        expect(signalDuringClear).toBe('owner-a');
        expect(insideDuringClear).toBe(true);
        expect(context.userIdSignal()).toBe('owner-b');
        expect(generation()).toBe(before + 1);
        expect(clearData).toHaveBeenCalledTimes(1);
      });

      it('skipPersistentReload logout commits null exactly once through the owner transition', async () => {
        const ownerTransition = context.mockAuthService['ownerTransitionForTest'] as AuthOwnerTransitionController;
        const generation = context.mockAuthService['ownerGenerationForTest'] as () => number;
        const commit = vi.spyOn(ownerTransition, 'commit');
        context.userIdSignal.set('owner-a');
        const before = generation();

        await context.service.setCurrentUser(null, { skipPersistentReload: true });

        expect(context.userIdSignal()).toBeNull();
        expect(generation()).toBe(before + 1);
        expect(commit).toHaveBeenCalledTimes(1);
        expect(context.mockProjectState['clearData']).toHaveBeenCalledTimes(1);
      });
    });
}
