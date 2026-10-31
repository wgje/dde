import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WritableSignal } from '@angular/core';

import { AUTH_CONFIG } from '../config/auth.config';
import type { Project } from '../models';
import type { UserSessionServiceSpecContext } from './user-session.service.spec-context';
import { registerUserSessionSetCurrentUserSnapshotOwnershipSpecs } from './user-session-set-current-user-snapshot-ownership.spec-helpers';

export function registerUserSessionSetCurrentUserSpecs(getContext: () => UserSessionServiceSpecContext): void {
  let context: UserSessionServiceSpecContext;

  beforeEach(() => {
    context = getContext();
  });

    describe('setCurrentUser', () => {
      it('设置用户 ID 为 null 时不从云端加载', async () => {
        await context.service.setCurrentUser(null);
        expect(context.mockSyncCoordinator['performDeltaSync']).not.toHaveBeenCalled();
      });

      it('切换用户成功后应清空 ChangeTracker，避免旧 owner 删除意图残留', async () => {
        context.userIdSignal.set('user-123');
        context.gateSnoozeCount.set(3);
        vi.spyOn(
          context.service as unknown as { loadUserData: (userId: string) => Promise<void> },
          'loadUserData'
        ).mockResolvedValue(undefined);

        await context.service.setCurrentUser('user-456');

        expect(context.mockSyncCoordinator['preparePendingPersistForOwnerChange']).toHaveBeenCalledWith(
          'user-123',
          'owner-switch:user-123->user-456',
        );
        expect(context.mockProjectState['clearData']).toHaveBeenCalledTimes(1);
        expect(context.mockChangeTracker['clearAllChanges']).toHaveBeenCalledTimes(1);
        expect(context.gateSnoozeCount()).toBe(0);
      });

      it('切换用户前 durable handoff 抛错时应中止切换并保留旧 owner 状态', async () => {
        context.userIdSignal.set('user-123');
        context.gateSnoozeCount.set(2);
        vi.spyOn(
          context.service as unknown as { loadUserData: (userId: string) => Promise<void> },
          'loadUserData'
        ).mockResolvedValue(undefined);
        (context.mockSyncCoordinator['preparePendingPersistForOwnerChange'] as ReturnType<typeof vi.fn>)
          .mockRejectedValueOnce(new Error('owner handoff failed'));

        await context.service.setCurrentUser('user-456');

        expect(context.userIdSignal()).toBe('user-123');
        expect(context.mockProjectState['clearData']).not.toHaveBeenCalled();
        expect(context.mockChangeTracker['clearAllChanges']).not.toHaveBeenCalled();
        expect(context.gateSnoozeCount()).toBe(2);
      });

      it('旧 owner change prepare 迟到完成后不得覆盖新代次的 cleanup 或 auth owner', async () => {
        context.userIdSignal.set('old-user');

        const preparePendingPersistForOwnerChange =
          context.mockSyncCoordinator['preparePendingPersistForOwnerChange'] as ReturnType<typeof vi.fn>;
        let releaseStalePrepare: ((value: boolean) => void) | null = null;
        let stalePrepareCompleted = false;
        preparePendingPersistForOwnerChange.mockImplementationOnce(async () => {
          const result = await new Promise<boolean>(resolve => {
            releaseStalePrepare = resolve;
          });
          stalePrepareCompleted = true;
          return result;
        });

        const clearData = context.mockProjectState['clearData'] as ReturnType<typeof vi.fn>;
        const setActiveProjectId = context.mockProjectState['setActiveProjectId'] as ReturnType<typeof vi.fn>;
        const clearAllChanges = context.mockChangeTracker['clearAllChanges'] as ReturnType<typeof vi.fn>;
        const clearAllState = context.mockUiState['clearAllState'] as ReturnType<typeof vi.fn>;
        const clearActionQueueView = context.mockActionQueue['clearCurrentView'] as ReturnType<typeof vi.fn>;
        const clearRetryQueueView = context.mockRetryQueue['clearCurrentView'] as ReturnType<typeof vi.fn>;
        const teardownRealtimeSubscription =
          context.mockSyncCoordinator['teardownRealtimeSubscription'] as ReturnType<typeof vi.fn>;

        const staleLoad = context.service.setCurrentUser('stale-user', { forceLoad: true });
        await vi.waitFor(() => {
          expect(preparePendingPersistForOwnerChange).toHaveBeenCalledWith(
            'old-user',
            'owner-switch:old-user->stale-user',
          );
        });

        expect(releaseStalePrepare).not.toBeNull();
        expect(clearData).not.toHaveBeenCalled();
        expect(clearActionQueueView).not.toHaveBeenCalled();
        expect(clearRetryQueueView).not.toHaveBeenCalled();
        expect(teardownRealtimeSubscription).not.toHaveBeenCalled();

        await context.service.setCurrentUser(null, { skipPersistentReload: true });

        expect(context.userIdSignal()).toBeNull();
        expect(preparePendingPersistForOwnerChange).toHaveBeenCalledTimes(1);

        const winnerCallCounts = {
          clearData: clearData.mock.calls.length,
          setActiveProjectId: setActiveProjectId.mock.calls.length,
          clearAllChanges: clearAllChanges.mock.calls.length,
          clearAllState: clearAllState.mock.calls.length,
          clearActionQueueView: clearActionQueueView.mock.calls.length,
          clearRetryQueueView: clearRetryQueueView.mock.calls.length,
          teardownRealtimeSubscription: teardownRealtimeSubscription.mock.calls.length,
        };

        releaseStalePrepare!(true);
        await staleLoad;

        expect(stalePrepareCompleted).toBe(true);
        expect(context.userIdSignal()).toBeNull();
        expect(clearData).toHaveBeenCalledTimes(winnerCallCounts.clearData);
        expect(setActiveProjectId).toHaveBeenCalledTimes(winnerCallCounts.setActiveProjectId);
        expect(clearAllChanges).toHaveBeenCalledTimes(winnerCallCounts.clearAllChanges);
        expect(clearAllState).toHaveBeenCalledTimes(winnerCallCounts.clearAllState);
        expect(clearActionQueueView).toHaveBeenCalledTimes(winnerCallCounts.clearActionQueueView);
        expect(clearRetryQueueView).toHaveBeenCalledTimes(winnerCallCounts.clearRetryQueueView);
        expect(teardownRealtimeSubscription).toHaveBeenCalledTimes(winnerCallCounts.teardownRealtimeSubscription);
      });

      it('runtime reset 失败时不得提交新 owner 或执行后续 owner cleanup', async () => {
        context.userIdSignal.set('old-user');
        const resetError = new Error('old runtime still active');
        context.mockSessionRuntimeReset.resetAll.mockReturnValueOnce({
          ok: false,
          reason: 'owner-change',
          attemptedOwners: ['broken-runtime', 'healthy-runtime'],
          failures: [{ owner: 'broken-runtime', error: resetError }],
        });
        const observedOwners: Array<string | null> = [];
        queueMicrotask(() => observedOwners.push(context.userIdSignal()));

        await expect(context.service.setCurrentUser('new-user', {
          forceLoad: true,
          skipPersistentReload: true,
        })).rejects.toThrow(AggregateError);
        await Promise.resolve();

        expect(context.userIdSignal()).toBe('old-user');
        expect(observedOwners).toEqual(['old-user']);
        expect(context.mockProjectState['setProjects']).not.toHaveBeenCalled();
        expect(context.mockActionQueue['clearCurrentView']).not.toHaveBeenCalled();
        expect(context.mockRetryQueue['clearCurrentView']).not.toHaveBeenCalled();
        expect(context.mockSyncCoordinator['teardownRealtimeSubscription']).not.toHaveBeenCalled();
      });

      it('clearLocalData 在 runtime reset 失败时仍应继续隔离并清除本地内存态', () => {
        context.mockSessionRuntimeReset.resetAll.mockReturnValueOnce({
          ok: false,
          reason: 'clear-local-data',
          attemptedOwners: ['broken-runtime'],
          failures: [{ owner: 'broken-runtime', error: new Error('reset failed') }],
        });

        expect(() => context.service.clearLocalData()).not.toThrow();

        expect(context.mockProjectState['clearData']).toHaveBeenCalled();
        expect(context.mockUiState['clearAllState']).toHaveBeenCalled();
        expect(context.mockUndoService['clearHistory']).toHaveBeenCalled();
        expect(context.mockChangeTracker['clearAllChanges']).toHaveBeenCalled();
      });

      it('skipPersistentReload 登出时不应重新加载本地快照或 owner-scoped 队列', async () => {
        context.userIdSignal.set('old-user');
        const loadFromCacheOrSeedSpy = vi.spyOn(
          context.service as unknown as {
            loadFromCacheOrSeed: () => Promise<void>;
          },
          'loadFromCacheOrSeed'
        ).mockResolvedValue(undefined);

        await context.service.setCurrentUser(null, { skipPersistentReload: true });

        expect(context.mockActionQueue['clearCurrentView']).toHaveBeenCalled();
        expect(context.mockRetryQueue['clearCurrentView']).toHaveBeenCalled();
        expect(context.mockActionQueue['reloadFromStorageForCurrentOwner']).not.toHaveBeenCalled();
        expect(context.mockRetryQueue['reloadFromStorageForCurrentOwner']).not.toHaveBeenCalled();
        expect(context.mockConflictStorage['refreshConflictCount']).toHaveBeenCalled();
        expect(loadFromCacheOrSeedSpy).not.toHaveBeenCalled();
        expect(context.mockSyncCoordinator['preparePendingPersistForOwnerChange']).not.toHaveBeenCalled();
      });

      it('加载当前用户本地数据前应先恢复中断的数据安全还原标记', async () => {
        const loadUserDataSpy = vi.spyOn(
          context.service as unknown as {
            loadUserData: (userId: string, sessionGuard?: unknown) => Promise<void>;
          },
          'loadUserData'
        ).mockResolvedValue(undefined);

        await context.service.setCurrentUser('restore-user', { forceLoad: true });

        expect(context.mockStorePersistence['recoverInterruptedDataSafetyRestore'])
          .toHaveBeenCalledWith('restore-user');
        expect(loadUserDataSpy).toHaveBeenCalledWith('restore-user', expect.any(Object));
        const recoveryCallOrder =
          (context.mockStorePersistence['recoverInterruptedDataSafetyRestore'] as ReturnType<typeof vi.fn>)
            .mock.invocationCallOrder[0];
        expect(recoveryCallOrder).toBeLessThan(
          (context.mockActionQueue['reloadFromStorageForCurrentOwner'] as ReturnType<typeof vi.fn>)
            .mock.invocationCallOrder[0],
        );
        expect(recoveryCallOrder).toBeLessThan(
          (context.mockRetryQueue['reloadFromStorageForCurrentOwner'] as ReturnType<typeof vi.fn>)
            .mock.invocationCallOrder[0],
        );
        expect(
          recoveryCallOrder
        ).toBeLessThan(loadUserDataSpy.mock.invocationCallOrder[0]);
      });

      it('应等待 RetryQueue 当前 owner 的持久化队列恢复完成后再加载会话数据', async () => {
        let resolveRetryReload!: () => void;
        const retryReload = new Promise<void>(resolve => {
          resolveRetryReload = resolve;
        });
        (context.mockRetryQueue['reloadFromStorageForCurrentOwner'] as ReturnType<typeof vi.fn>)
          .mockReturnValueOnce(retryReload);
        const loadUserDataSpy = vi.spyOn(
          context.service as unknown as {
            loadUserData: (userId: string, sessionGuard?: unknown) => Promise<void>;
          },
          'loadUserData',
        ).mockResolvedValue(undefined);

        const setCurrentUser = context.service.setCurrentUser('queue-owner', { forceLoad: true });
        await vi.waitFor(() => {
          expect(context.mockRetryQueue['reloadFromStorageForCurrentOwner']).toHaveBeenCalled();
        });

        expect(loadUserDataSpy).not.toHaveBeenCalled();
        resolveRetryReload();
        await expect(setCurrentUser).resolves.toBeUndefined();
        expect(loadUserDataSpy).toHaveBeenCalledWith('queue-owner', expect.any(Object));
      });

      it('skipPersistentReload 不应恢复中断的数据安全还原标记', async () => {
        await context.service.setCurrentUser(null, { skipPersistentReload: true });

        expect(context.mockStorePersistence['recoverInterruptedDataSafetyRestore']).not.toHaveBeenCalled();
      });

      it('数据安全还原返回未完成错误时应保留标记并停止加载当前用户数据', async () => {
        const recoveryErrors = ['restore rollback failed'];
        (context.mockStorePersistence['recoverInterruptedDataSafetyRestore'] as ReturnType<typeof vi.fn>)
          .mockResolvedValueOnce({ recovered: false, errors: recoveryErrors });
        const loadUserDataSpy = vi.spyOn(
          context.service as unknown as {
            loadUserData: (userId: string, sessionGuard?: unknown) => Promise<void>;
          },
          'loadUserData'
        ).mockResolvedValue(undefined);

        await expect(context.service.setCurrentUser('restore-user', { forceLoad: true }))
          .resolves.toBeUndefined();

        expect(context.mockLoggerCategory.warn).toHaveBeenCalledWith(
          '恢复中断的数据安全还原未完成，保留标记并停止加载本地数据',
          { ownerUserId: 'restore-user', errors: recoveryErrors },
        );
        expect(context.mockActionQueue['reloadFromStorageForCurrentOwner']).not.toHaveBeenCalled();
        expect(context.mockRetryQueue['reloadFromStorageForCurrentOwner']).not.toHaveBeenCalled();
        expect(context.mockConflictStorage['refreshConflictCount']).not.toHaveBeenCalled();
        expect(loadUserDataSpy).not.toHaveBeenCalled();
      });

      it('数据安全还原恢复抛错时应保留标记并停止加载当前用户数据', async () => {
        const recoveryError = new Error('restore recovery failed');
        (context.mockStorePersistence['recoverInterruptedDataSafetyRestore'] as ReturnType<typeof vi.fn>)
          .mockRejectedValueOnce(recoveryError);
        const loadUserDataSpy = vi.spyOn(
          context.service as unknown as {
            loadUserData: (userId: string, sessionGuard?: unknown) => Promise<void>;
          },
          'loadUserData'
        ).mockResolvedValue(undefined);

        await expect(context.service.setCurrentUser('restore-user', { forceLoad: true }))
          .resolves.toBeUndefined();

        expect(context.mockLoggerCategory.warn).toHaveBeenCalledWith(
          '恢复中断的数据安全还原失败，保留标记并停止加载本地数据',
          recoveryError,
        );
        expect(context.mockActionQueue['reloadFromStorageForCurrentOwner']).not.toHaveBeenCalled();
        expect(context.mockRetryQueue['reloadFromStorageForCurrentOwner']).not.toHaveBeenCalled();
        expect(context.mockConflictStorage['refreshConflictCount']).not.toHaveBeenCalled();
        expect(loadUserDataSpy).not.toHaveBeenCalled();
      });

      it('owner reload 时 ActionQueue 抛错也应继续重载 RetryQueue 并完成会话刷新', async () => {
        const reloadError = new Error('action reload failed');
        (context.mockActionQueue['reloadFromStorageForCurrentOwner'] as ReturnType<typeof vi.fn>)
          .mockImplementationOnce(() => {
            throw reloadError;
          });

        await expect(context.service.setCurrentUser(null)).resolves.toBeUndefined();

        expect(context.mockActionQueue['reloadFromStorageForCurrentOwner']).toHaveBeenCalled();
        expect(context.mockRetryQueue['reloadFromStorageForCurrentOwner']).toHaveBeenCalled();
        expect(context.mockConflictStorage['refreshConflictCount']).toHaveBeenCalled();
        expect(context.mockLoggerCategory.warn).toHaveBeenCalledWith(
          '重新加载 ActionQueue 持久化队列失败，静默继续',
          reloadError,
        );
      });

      it('skipPersistentReload 清理队列失败且日志失败时仍应清理另一个队列并完成会话刷新', async () => {
        const clearError = new Error('action clear failed');
        (context.mockActionQueue['clearCurrentView'] as ReturnType<typeof vi.fn>)
          .mockImplementationOnce(() => {
            throw clearError;
          });
        context.mockLoggerCategory.warn.mockImplementationOnce(() => {
          throw new Error('warn failed');
        });

        await expect(context.service.setCurrentUser(null, { skipPersistentReload: true })).resolves.toBeUndefined();

        expect(context.mockActionQueue['clearCurrentView']).toHaveBeenCalled();
        expect(context.mockRetryQueue['clearCurrentView']).toHaveBeenCalled();
        expect(context.mockConflictStorage['refreshConflictCount']).toHaveBeenCalled();
        expect(context.mockLoggerCategory.warn).toHaveBeenCalledWith(
          '清理 ActionQueue 当前队列视图失败，静默继续',
          clearError,
        );
      });

      it('冲突计数刷新失败且日志失败时仍应完成会话切换', async () => {
        const conflictError = new Error('conflict refresh failed');
        (context.mockConflictStorage['refreshConflictCount'] as ReturnType<typeof vi.fn>)
          .mockRejectedValueOnce(conflictError);
        context.mockLoggerCategory.warn.mockImplementationOnce(() => {
          throw new Error('warn failed');
        });

        await expect(context.service.setCurrentUser(null, { skipPersistentReload: true })).resolves.toBeUndefined();

        expect(context.mockConflictStorage['refreshConflictCount']).toHaveBeenCalled();
        expect(context.mockLoggerCategory.warn).toHaveBeenCalledWith(
          '刷新冲突计数失败，静默继续',
          conflictError,
        );
      });

      it('匿名态本地快照加载失败且日志失败时仍应完成会话切换', async () => {
        const cacheLoadError = new Error('cache load failed');
        const loadFromCacheOrSeedSpy = vi.spyOn(
          context.service as unknown as {
            loadFromCacheOrSeed: () => Promise<void>;
          },
          'loadFromCacheOrSeed'
        ).mockRejectedValueOnce(cacheLoadError);
        context.mockLoggerCategory.warn.mockImplementationOnce(() => {
          throw new Error('warn failed');
        });

        await expect(context.service.setCurrentUser(null)).resolves.toBeUndefined();

        expect(loadFromCacheOrSeedSpy).toHaveBeenCalled();
        expect(context.mockLoggerCategory.warn).toHaveBeenCalledWith(
          'loadFromCacheOrSeed 失败',
          cacheLoadError,
        );
      });

      it('登录态用户数据加载失败且日志失败时仍应执行种子降级', async () => {
        const userLoadError = new Error('user data load failed');
        const loadFromCacheOrSeedSpy = vi.spyOn(
          context.service as unknown as {
            loadFromCacheOrSeed: () => Promise<void>;
          },
          'loadFromCacheOrSeed'
        ).mockResolvedValue(undefined);
        vi.spyOn(
          context.service as unknown as {
            loadUserData: (userId: string, sessionGuard?: unknown) => Promise<void>;
          },
          'loadUserData'
        ).mockRejectedValueOnce(userLoadError);
        context.mockLoggerCategory.warn.mockImplementationOnce(() => {
          throw new Error('warn failed');
        });

        await expect(context.service.setCurrentUser('new-user', { forceLoad: true })).resolves.toBeUndefined();

        expect(context.mockLoggerCategory.warn).toHaveBeenCalledWith(
          'loadUserData 失败',
          userLoadError,
        );
        expect(loadFromCacheOrSeedSpy).toHaveBeenCalled();
      });

      it('session invalidated teardown 应清空旧 owner 视图但保留离线快照桶', async () => {
        (context.mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([
          context.createProject({ id: 'stale-project', name: 'Stale Project' }),
        ]);

        await context.service.setCurrentUser(null, {
          skipPersistentReload: true,
          previousUserIdHint: 'stale-user',
          preserveOfflineSnapshot: true,
        });

        expect(context.mockProjectState['setActiveProjectId']).toHaveBeenCalledWith(null);
        expect(context.mockProjectState['clearData']).toHaveBeenCalledTimes(1);
        expect(context.mockActionQueue['clearCurrentView']).toHaveBeenCalled();
        expect(context.mockRetryQueue['clearCurrentView']).toHaveBeenCalled();
        expect((context.mockSyncCoordinator['core'] as { saveOfflineSnapshot: ReturnType<typeof vi.fn> }).saveOfflineSnapshot)
          .toHaveBeenCalledWith(expect.any(Array), 'stale-user');
        expect((context.mockSyncCoordinator['core'] as { clearOfflineSnapshot: ReturnType<typeof vi.fn> }).clearOfflineSnapshot)
          .not.toHaveBeenCalled();
        expect(context.mockRetryQueue['clear']).not.toHaveBeenCalled();
      });

      it('hint-only 启动占位下的 session invalidated teardown 不应把占位壳回写旧 owner 快照', async () => {
        (context.mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([
          context.createProject({ id: 'hint-placeholder', name: 'Placeholder', syncSource: 'local-only' }),
        ]);
        context.mockStartupPlaceholderState.isHintOnlyActive.mockReturnValue(true);

        await context.service.setCurrentUser(null, {
          skipPersistentReload: true,
          previousUserIdHint: 'hint-user',
          preserveOfflineSnapshot: true,
        });

        expect((context.mockSyncCoordinator['core'] as { saveOfflineSnapshot: ReturnType<typeof vi.fn> }).saveOfflineSnapshot)
          .not.toHaveBeenCalled();
      });

      it('trusted launch snapshot 仅处于 partial 预填充态时不应回写旧 owner durable snapshot', async () => {
        (context.mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([
          context.createProject({ id: 'trusted-shell', name: 'Trusted Shell', tasks: [context.createTask({ title: 'Preview Task' })] }),
        ]);
        (
          context.service as unknown as {
            prehydratedSnapshotApplied: boolean;
            prehydratedSnapshotOwnerId: string | null;
            startupProjectCatalogStageState: WritableSignal<'unresolved' | 'partial' | 'resolved'>;
          }
        ).prehydratedSnapshotApplied = true;
        (
          context.service as unknown as {
            prehydratedSnapshotApplied: boolean;
            prehydratedSnapshotOwnerId: string | null;
            startupProjectCatalogStageState: WritableSignal<'unresolved' | 'partial' | 'resolved'>;
          }
        ).prehydratedSnapshotOwnerId = 'trusted-user';
        (
          context.service as unknown as {
            startupProjectCatalogStageState: WritableSignal<'unresolved' | 'partial' | 'resolved'>;
          }
        ).startupProjectCatalogStageState.set('partial');

        await context.service.setCurrentUser(null, {
          skipPersistentReload: true,
          previousUserIdHint: 'trusted-user',
          preserveOfflineSnapshot: true,
        });

        expect((context.mockSyncCoordinator['core'] as { saveOfflineSnapshot: ReturnType<typeof vi.fn> }).saveOfflineSnapshot)
          .not.toHaveBeenCalled();
      });

      it('session invalidated teardown 在保留旧 owner 快照失败时也应强制清空旧视图', async () => {
        (context.mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([
          context.createProject({ id: 'stale-project', name: 'Stale Project' }),
        ]);
        context.blackBoxEntriesMap.set(new Map([
          ['stale-entry', {
            id: 'stale-entry',
            projectId: 'stale-project',
            userId: 'stale-user',
            content: 'stale',
            date: '2026-03-18',
            createdAt: '2026-03-18T00:00:00.000Z',
            updatedAt: '2026-03-18T00:00:00.000Z',
            isRead: false,
            isCompleted: false,
            isArchived: false,
            deletedAt: null,
          }],
        ]));
        context.gateState.set('reviewing');
        (context.mockSyncCoordinator['core'] as { saveOfflineSnapshot: ReturnType<typeof vi.fn> }).saveOfflineSnapshot
          .mockRejectedValueOnce(new Error('save-offline-snapshot-failed'));

        await context.service.setCurrentUser(null, {
          skipPersistentReload: true,
          previousUserIdHint: 'stale-user',
          preserveOfflineSnapshot: true,
        });

        expect(context.mockProjectState['setActiveProjectId']).toHaveBeenCalledWith(null);
        expect(context.mockProjectState['clearData']).toHaveBeenCalledTimes(1);
        expect(context.mockUiState['clearAllState']).toHaveBeenCalled();
        expect(context.mockActionQueue['clearCurrentView']).toHaveBeenCalled();
        expect(context.mockRetryQueue['clearCurrentView']).toHaveBeenCalled();
        expect(context.mockChangeTracker['clearAllChanges']).toHaveBeenCalled();
        expect(context.blackBoxEntriesMap().size).toBe(0);
        expect(context.gateState()).toBe('checking');
      });

      it('local-user 遇到错误的云端 previousUserIdHint 时不应把本地草稿写进云端快照桶', async () => {
        context.userIdSignal.set(AUTH_CONFIG.LOCAL_MODE_USER_ID);
        (context.mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([
          context.createProject({ id: 'local-draft', name: 'Local Draft', syncSource: 'local-only' }),
        ]);

        await context.service.setCurrentUser(null, {
          skipPersistentReload: true,
          previousUserIdHint: 'cloud-user',
          preserveOfflineSnapshot: true,
        });

        const saveCalls = ((context.mockSyncCoordinator['core'] as {
          saveOfflineSnapshot: ReturnType<typeof vi.fn>;
        }).saveOfflineSnapshot).mock.calls;
        expect(saveCalls.some(([, ownerUserId]) => ownerUserId === 'cloud-user')).toBe(false);
        expect(saveCalls.some(([, ownerUserId]) => ownerUserId === AUTH_CONFIG.LOCAL_MODE_USER_ID)).toBe(true);
      });

      it('旧会话的 forceLoad 在 logout 后不应回灌项目或恢复 realtime', async () => {
        let resolveSnapshot: ((value: {
          source: 'idb';
          projectCount: number;
          bytes: number;
          migratedLegacy: boolean;
          projects: Project[];
        }) => void) | null = null;
        vi.spyOn(
          context.service as unknown as {
            loadStartupSnapshotResult: () => Promise<{
              source: 'idb';
              projectCount: number;
              bytes: number;
              migratedLegacy: boolean;
              projects: Project[];
            }>;
          },
          'loadStartupSnapshotResult'
        ).mockImplementation(() => new Promise(resolve => {
          resolveSnapshot = resolve;
        }));

        const staleLoad = context.service.setCurrentUser('stale-user', { forceLoad: true });
        await context.service.setCurrentUser(null, { skipPersistentReload: true });

        resolveSnapshot!({
          source: 'idb',
          projectCount: 1,
          bytes: 256,
          migratedLegacy: false,
          projects: [context.createProject({ id: 'stale-project', name: 'Stale Project' })],
        });
        await staleLoad;

        expect(context.mockProjectState['setProjects']).not.toHaveBeenCalledWith([
          expect.objectContaining({ id: 'stale-project' }),
        ]);
        expect((context.mockSyncCoordinator['core'] as { initRealtimeSubscription: ReturnType<typeof vi.fn> }).initRealtimeSubscription)
          .not.toHaveBeenCalledWith('stale-user');
      });

      it('本地模式 forceLoad 不应触发云端订阅、冲突重载或 activeProject 补水', async () => {
        context.userIdSignal.set('cloud-user');
        (context.mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>).mockReturnValue('cloud-project');
        (context.mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([
          context.createProject({ id: 'cloud-project', name: 'Cloud Project', syncSource: 'synced' }),
        ]);

        await context.service.setCurrentUser(AUTH_CONFIG.LOCAL_MODE_USER_ID, {
          forceLoad: true,
          previousUserIdHint: 'cloud-user',
          preserveOfflineSnapshot: true,
        });

        expect((context.mockSyncCoordinator['core'] as { initRealtimeSubscription: ReturnType<typeof vi.fn> }).initRealtimeSubscription)
          .not.toHaveBeenCalled();
        expect(context.mockSyncCoordinator['tryReloadConflictData']).not.toHaveBeenCalled();
        expect((context.mockSyncCoordinator['core'] as { getAccessibleProjectProbe: ReturnType<typeof vi.fn> }).getAccessibleProjectProbe)
          .not.toHaveBeenCalled();
        expect(context.mockSyncCoordinator['loadSingleProjectFromCloud']).not.toHaveBeenCalled();
      });

      it('切换账号时应清理 action queue', async () => {
        context.userIdSignal.set('old-user');

        await context.service.setCurrentUser('new-user');

        expect(context.mockSyncCoordinator['preparePendingPersistForOwnerChange']).toHaveBeenCalledWith(
          'old-user',
          'owner-switch:old-user->new-user'
        );
        expect((context.mockSyncCoordinator['preparePendingPersistForOwnerChange'] as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0])
          .toBeLessThan(((context.mockSyncCoordinator['core'] as { clearOfflineSnapshot: ReturnType<typeof vi.fn> }).clearOfflineSnapshot).mock.invocationCallOrder[0]);
        expect(context.mockActionQueue['clearCurrentView']).toHaveBeenCalled();
        expect(context.mockRetryQueue['clearCurrentView']).toHaveBeenCalled();
        expect((context.mockSyncCoordinator['core'] as { clearOfflineSnapshot: ReturnType<typeof vi.fn> }).clearOfflineSnapshot)
          .toHaveBeenCalledWith('old-user');
        expect((context.mockSyncCoordinator['core'] as { clearOfflineCache: ReturnType<typeof vi.fn> }).clearOfflineCache).not.toHaveBeenCalled();
        expect(context.mockConflictStorage['clearFallbackStorageForOwner']).not.toHaveBeenCalled();
        expect(context.mockActionQueue['reloadFromStorageForCurrentOwner']).toHaveBeenCalled();
        expect(context.mockRetryQueue['reloadFromStorageForCurrentOwner']).toHaveBeenCalled();
        expect(context.mockConflictStorage['refreshConflictCount']).toHaveBeenCalled();
      });

      it('auth signal 已是新用户时仍应清理 previousUserIdHint 对应离线快照', async () => {
        context.userIdSignal.set('new-user');
        (context.mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([
          context.createProject({ id: 'old-project', name: 'Old Project' }),
        ]);

        await context.service.setCurrentUser('new-user', {
          forceLoad: true,
          previousUserIdHint: 'old-user',
        });

        const clearOfflineSnapshot = (context.mockSyncCoordinator['core'] as {
          clearOfflineSnapshot: ReturnType<typeof vi.fn>;
        }).clearOfflineSnapshot;
        expect(clearOfflineSnapshot).toHaveBeenCalledWith('old-user');
        expect(clearOfflineSnapshot).not.toHaveBeenCalledWith('new-user');
      });

      it('切换账号前若 durable handoff 未完成，不应提前清空离线快照', async () => {
        context.userIdSignal.set('old-user');
        (context.mockSyncCoordinator['preparePendingPersistForOwnerChange'] as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);

        await context.service.setCurrentUser('new-user');

        expect(context.mockActionQueue['clearCurrentView']).toHaveBeenCalled();
        expect(context.mockRetryQueue['clearCurrentView']).toHaveBeenCalled();
        expect((context.mockSyncCoordinator['core'] as { clearOfflineSnapshot: ReturnType<typeof vi.fn> }).clearOfflineSnapshot).not.toHaveBeenCalled();
      });

      it('切换账号时 durable handoff 失败必须保留旧 owner 的完整内存视图', async () => {
        context.userIdSignal.set('old-user');
        (context.mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([
          context.createProject({ id: 'old-project', name: 'Old Project' }),
        ]);
        context.blackBoxEntriesMap.set(new Map([
          ['old-entry', {
            id: 'old-entry',
            projectId: 'old-project',
            userId: 'old-user',
            content: 'old',
            date: '2026-03-18',
            createdAt: '2026-03-18T00:00:00.000Z',
            updatedAt: '2026-03-18T00:00:00.000Z',
            isRead: false,
            isCompleted: false,
            isArchived: false,
            deletedAt: null,
          }],
        ]));
        context.gateState.set('reviewing');
        (context.mockSyncCoordinator['preparePendingPersistForOwnerChange'] as ReturnType<typeof vi.fn>)
          .mockRejectedValueOnce(new Error('prepare-pending-persist-failed'));
        vi.spyOn(
          context.service as unknown as {
            loadUserData: (userId: string, sessionGuard?: unknown) => Promise<void>;
          },
          'loadUserData'
        ).mockResolvedValue(undefined);

        await context.service.setCurrentUser('new-user');

        expect(context.userIdSignal()).toBe('old-user');
        expect(context.mockProjectState['setActiveProjectId']).not.toHaveBeenCalled();
        expect(context.mockProjectState['clearData']).not.toHaveBeenCalled();
        expect(context.mockUiState['clearAllState']).not.toHaveBeenCalled();
        expect(context.mockActionQueue['clearCurrentView']).not.toHaveBeenCalled();
        expect(context.mockRetryQueue['clearCurrentView']).not.toHaveBeenCalled();
        expect(context.mockChangeTracker['clearAllChanges']).not.toHaveBeenCalled();
        expect(context.blackBoxEntriesMap().size).toBe(1);
        expect(context.gateState()).toBe('reviewing');
      });
    });

  registerUserSessionSetCurrentUserSnapshotOwnershipSpecs(getContext);
}
