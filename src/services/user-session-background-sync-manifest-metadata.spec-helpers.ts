import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WritableSignal } from '@angular/core';

import type { Project } from '../models';
import type { UserSessionServiceSpecContext } from './user-session.service.spec-context';

export function registerUserSessionBackgroundSyncManifestMetadataSpecs(getContext: () => UserSessionServiceSpecContext): void {
  let context: UserSessionServiceSpecContext;

  beforeEach(() => {
    context = getContext();
  });

    describe('startBackgroundSync', () => {
      it('项目清单快路命中时，owner 匹配的 local-only 恢复项目仍应补做元数据同步以恢复云同步', async () => {
        const localOnlyProject = context.createProject({
          id: 'proj-legacy-local-only',
          name: 'Recovered Project',
          syncSource: 'local-only',
          pendingSync: true,
        });
        (context.mockProjectState['setProjects'] as (...args: unknown[]) => void)([localOnlyProject]);
        (context.mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>).mockReturnValue('proj-legacy-local-only');
        (
          (context.mockSyncCoordinator['core'] as Record<string, unknown>)['getResumeRecoveryProbe'] as ReturnType<typeof vi.fn>
        ).mockResolvedValue({
          activeProjectId: null,
          activeAccessible: false,
          activeWatermark: null,
          projectsWatermark: '2026-02-17T10:02:00.000Z',
          blackboxWatermark: '2026-02-17T10:03:00.000Z',
          serverNow: '2026-02-17T10:03:01.000Z',
        });
        (context.mockSyncCoordinator['refreshProjectManifestIfNeeded'] as ReturnType<typeof vi.fn>)
          .mockResolvedValueOnce({ skipped: true, watermark: '2026-02-17T10:02:00.000Z' });

        const syncProjectListMetadataSpy = vi.spyOn(
          context.service as unknown as {
            syncProjectListMetadata: (userId: string) => Promise<Set<string>>;
          },
          'syncProjectListMetadata'
        ).mockImplementation(async () => {
          (context.mockProjectState['setProjects'] as (...args: unknown[]) => void)([
            {
              ...localOnlyProject,
              syncSource: 'synced',
              pendingSync: false,
              tasks: [context.createTask({ id: 'task-restored' })],
            },
          ]);
          return new Set(['proj-legacy-local-only']);
        });

        await (
          context.service as unknown as {
            startBackgroundSync: (userId: string, previousActive: string | null) => Promise<void>;
          }
        ).startBackgroundSync('user-1', null);

        expect(syncProjectListMetadataSpy).toHaveBeenCalledWith('user-1', undefined, true);
        expect(context.mockSyncCoordinator['performDeltaSync']).toHaveBeenCalledWith('proj-legacy-local-only');
        expect(context.mockSyncCoordinator['loadSingleProjectFromCloud']).not.toHaveBeenCalled();
      });

      it('探测到更高 manifest 水位时应重新拉取 metadata，而不是复用旧缓存', async () => {
        context.userIdSignal.set('user-1');
        const localProject = context.createProject({
          id: 'proj-cached',
          name: 'Cached',
          syncSource: 'synced',
          tasks: [context.createTask({ id: 'task-cached' })],
        });
        (context.mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([localProject]);
        (context.mockProjectState['getProject'] as ReturnType<typeof vi.fn>).mockImplementation((id: string) => {
          return id === localProject.id ? localProject : undefined;
        });
        (context.mockProjectState['getProjectsWithCurrentData'] as ReturnType<typeof vi.fn>).mockReturnValue([localProject]);
        (context.mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>).mockReturnValue(null);
        context.mockSupabaseClientService.getSession.mockResolvedValue({
          data: { session: { user: { id: 'user-1' } } },
          error: null,
        });

        const metadataSyncSucceededState = (
          context.service as unknown as { lastProjectListMetadataSyncSucceededState: WritableSignal<boolean> }
        ).lastProjectListMetadataSyncSucceededState;
        const metadataSyncDurableState = (
          context.service as unknown as { lastProjectListMetadataSyncDurableState: WritableSignal<boolean> }
        ).lastProjectListMetadataSyncDurableState;
        const syncProjectListMetadataSpy = vi.spyOn(
          context.service as unknown as {
            syncProjectListMetadata: (userId: string, sessionGuard?: unknown) => Promise<Set<string>>;
          },
          'syncProjectListMetadata'
        ).mockImplementation(async () => {
          metadataSyncSucceededState.set(true);
          metadataSyncDurableState.set(true);
          return new Set(['proj-cached']);
        });

        await (
          context.service as unknown as {
            ensureProjectListMetadataSynced: (
              userId: string,
              sessionGuard?: unknown,
              manifestWatermark?: string | null,
            ) => Promise<Set<string>>;
          }
        ).ensureProjectListMetadataSynced('user-1', undefined, '2026-05-27T01:00:00.000Z');

        (context.mockSyncCoordinator['refreshProjectManifestIfNeeded'] as ReturnType<typeof vi.fn>)
          .mockResolvedValueOnce({ skipped: false, watermark: '2026-05-27T02:00:00.000Z' });
        (context.mockSyncCoordinator['commitProjectManifestWatermark'] as ReturnType<typeof vi.fn>).mockClear();

        await (
          context.service as unknown as {
            startBackgroundSync: (userId: string, previousActive: string | null) => Promise<void>;
          }
        ).startBackgroundSync('user-1', null);

        expect(syncProjectListMetadataSpy).toHaveBeenCalledTimes(2);
        expect(context.mockSyncCoordinator['commitProjectManifestWatermark']).toHaveBeenCalledWith(
          '2026-05-27T02:00:00.000Z',
          'user-1'
        );
      });

      it('远端已删的 local-only 影子项目在无真实本地改动时应被移除', async () => {
        const shadowProject = context.createProject({
          id: 'proj-shadow-deleted',
          name: 'Shadow Deleted',
          syncSource: 'local-only',
          pendingSync: true,
        });
        (context.mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([shadowProject]);
        (context.mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>).mockReturnValue('proj-shadow-deleted');
        (context.mockSyncCoordinator['core'] as { saveOfflineSnapshot: ReturnType<typeof vi.fn> }).saveOfflineSnapshot.mockClear();
        (
          (context.mockSyncCoordinator['core'] as Record<string, unknown>)['getResumeRecoveryProbe'] as ReturnType<typeof vi.fn>
        ).mockResolvedValue({
          activeProjectId: 'proj-shadow-deleted',
          activeAccessible: false,
          activeWatermark: null,
          projectsWatermark: '2026-02-17T10:02:00.000Z',
          blackboxWatermark: '2026-02-17T10:03:00.000Z',
          serverNow: '2026-02-17T10:03:01.000Z',
        });
        (context.mockSyncCoordinator['refreshProjectManifestIfNeeded'] as ReturnType<typeof vi.fn>)
          .mockResolvedValueOnce({ skipped: true, watermark: '2026-02-17T10:02:00.000Z' });

        await (
          context.service as unknown as {
            startBackgroundSync: (userId: string, previousActive: string | null) => Promise<void>;
          }
        ).startBackgroundSync('user-1', null);

        expect(context.mockProjectState['setActiveProjectId']).toHaveBeenCalledWith(null);
        expect(context.mockProjectState['setProjects']).toHaveBeenCalledWith([]);
        expect((context.mockSyncCoordinator['core'] as { saveOfflineSnapshot: ReturnType<typeof vi.fn> }).saveOfflineSnapshot)
          .toHaveBeenCalledWith([], 'user-1');
        expect(context.mockSyncCoordinator['performDeltaSync']).not.toHaveBeenCalled();
        expect(context.mockSyncCoordinator['loadSingleProjectFromCloud']).not.toHaveBeenCalled();
      });

      it('项目元数据慢路成功后应提交 deferred manifest watermark', async () => {
        const durableProject = context.createProject({
          id: 'proj-ok',
          name: 'Keep',
          syncSource: 'synced',
          tasks: [context.createTask({
            id: 'task-durable-metadata-success',
            content: 'durable metadata snapshot baseline',
          })],
        });
        const query = {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          is: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue({
            data: [{
              id: 'proj-ok',
              title: 'Keep',
              description: '',
              created_date: '2026-02-17T10:00:00.000Z',
              updated_at: '2026-02-17T10:02:00.000Z',
              version: 1,
              owner_id: 'user-1',
            }],
            error: null,
          }),
        };
        context.mockSupabaseClientService.clientAsync.mockResolvedValue({
          from: vi.fn().mockReturnValue(query),
        });
        (context.mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([]);
        (context.mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>).mockReturnValue(null);
        (context.mockSyncCoordinator['refreshProjectManifestIfNeeded'] as ReturnType<typeof vi.fn>)
          .mockResolvedValueOnce({ skipped: false, watermark: '2026-02-17T10:05:00.000Z' });
        (
          context.mockSyncCoordinator['core'] as {
            loadStartupOfflineSnapshot: ReturnType<typeof vi.fn>;
          }
        ).loadStartupOfflineSnapshot.mockResolvedValue({
          source: 'idb',
          projectCount: 1,
          bytes: 256,
          migratedLegacy: false,
          ownerUserId: 'user-1',
          projects: [durableProject],
        });
        (context.mockSyncCoordinator['loadSingleProjectFromCloud'] as ReturnType<typeof vi.fn>).mockResolvedValue(
          durableProject
        );

        await (
          context.service as unknown as {
            startBackgroundSync: (userId: string, previousActive: string | null) => Promise<void>;
          }
        ).startBackgroundSync('user-1', null);

        expect(context.mockSyncCoordinator['commitProjectManifestWatermark']).toHaveBeenCalledWith(
          '2026-02-17T10:05:00.000Z',
          'user-1'
        );
      });

      it('项目元数据已更新但快照落盘失败时不应提交 deferred manifest watermark', async () => {
        const durableProject = context.createProject({
          id: 'proj-ok',
          name: 'Keep',
          syncSource: 'synced',
          tasks: [context.createTask({
            id: 'task-durable-metadata-failure',
            content: 'durable metadata snapshot baseline',
          })],
        });
        const query = {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          is: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue({
            data: [{
              id: 'proj-ok',
              title: 'Keep',
              description: '',
              created_date: '2026-02-17T10:00:00.000Z',
              updated_at: '2026-02-17T10:02:00.000Z',
              version: 1,
              owner_id: 'user-1',
            }],
            error: null,
          }),
        };
        context.mockSupabaseClientService.clientAsync.mockResolvedValue({
          from: vi.fn().mockReturnValue(query),
        });
        (context.mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([]);
        (context.mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>).mockReturnValue(null);
        (context.mockSyncCoordinator['refreshProjectManifestIfNeeded'] as ReturnType<typeof vi.fn>)
          .mockResolvedValueOnce({ skipped: false, watermark: '2026-02-17T10:05:00.000Z' });
        (
          context.mockSyncCoordinator['core'] as {
            loadStartupOfflineSnapshot: ReturnType<typeof vi.fn>;
          }
        ).loadStartupOfflineSnapshot.mockResolvedValue({
          source: 'idb',
          projectCount: 1,
          bytes: 256,
          migratedLegacy: false,
          ownerUserId: 'user-1',
          projects: [durableProject],
        });
        const saveSnapshotSpy = vi.spyOn(
          context.service as unknown as {
            saveProjectsToOfflineSnapshot: (projects: Project[], userId: string, options?: unknown) => Promise<void>;
          },
          'saveProjectsToOfflineSnapshot'
        ).mockRejectedValue(new Error('disk full'));

        await (
          context.service as unknown as {
            startBackgroundSync: (userId: string, previousActive: string | null) => Promise<void>;
          }
        ).startBackgroundSync('user-1', null);

        expect(saveSnapshotSpy).toHaveBeenCalled();
        expect(context.mockSyncCoordinator['commitProjectManifestWatermark']).not.toHaveBeenCalled();
      });

      it('项目元数据慢路失败时不应提交 deferred manifest watermark', async () => {
        const query = {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          is: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue({
            data: null,
            error: { message: 'boom' },
          }),
        };
        context.mockSupabaseClientService.clientAsync.mockResolvedValue({
          from: vi.fn().mockReturnValue(query),
        });
        (context.mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([]);
        (context.mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>).mockReturnValue(null);
        (context.mockSyncCoordinator['refreshProjectManifestIfNeeded'] as ReturnType<typeof vi.fn>)
          .mockResolvedValueOnce({ skipped: false, watermark: '2026-02-17T10:05:00.000Z' });

        await (
          context.service as unknown as {
            startBackgroundSync: (userId: string, previousActive: string | null) => Promise<void>;
          }
        ).startBackgroundSync('user-1', null);

        expect(context.mockSyncCoordinator['commitProjectManifestWatermark']).not.toHaveBeenCalled();
      });

      it('项目元数据查询失败且日志失败时仍应返回本地项目 fallback', async () => {
        const localProject = context.createProject({
          id: 'proj-local-fallback',
          name: 'Local Fallback',
          syncSource: 'synced',
        });
        const query = {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          is: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnThis(),
          limit: vi.fn().mockRejectedValue(new Error('metadata query failed')),
        };
        context.mockSupabaseClientService.clientAsync.mockResolvedValue({
          from: vi.fn().mockReturnValue(query),
        });
        context.mockSupabaseClientService.getSession.mockResolvedValue({
          data: { session: { user: { id: 'user-1' } } },
          error: null,
        });
        (context.mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([localProject]);
        context.mockLoggerCategory.warn.mockImplementationOnce(() => {
          throw new Error('warn failed');
        });

        await expect((
          context.service as unknown as {
            syncProjectListMetadata: (userId: string) => Promise<Set<string>>;
          }
        ).syncProjectListMetadata('user-1')).resolves.toEqual(new Set(['proj-local-fallback']));

        expect(context.mockLoggerCategory.warn).toHaveBeenCalledWith(
          '获取项目列表失败',
          { message: 'metadata query failed' }
        );
      });

      it('项目清单快路命中且 activeProject 缺席但有待同步改动时，应降级为 local-only 并立即落盘', async () => {
        const deniedProject = context.createProject({
          id: 'proj-denied',
          name: 'Denied',
          syncSource: 'synced',
          pendingSync: false,
        });
        const localOnlyProject = context.createProject({
          id: 'proj-local-only',
          name: 'Local Draft',
          syncSource: 'local-only',
          pendingSync: true,
        });
        const recoveredProject = context.createProject({
          id: 'proj-recovered',
          name: 'Recovered',
          syncSource: 'synced',
          pendingSync: false,
        });
        (context.mockProjectState['setProjects'] as (...args: unknown[]) => void)([deniedProject, localOnlyProject]);
        (context.mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>).mockReturnValue('proj-denied');
        (context.mockSyncCoordinator['hasPendingChangesForProject'] as ReturnType<typeof vi.fn>).mockImplementation(
          (projectId: string) => projectId === 'proj-denied'
        );
        (context.mockSyncCoordinator['core'] as { saveOfflineSnapshot: ReturnType<typeof vi.fn> }).saveOfflineSnapshot.mockClear();
        (
          (context.mockSyncCoordinator['core'] as Record<string, unknown>)['getResumeRecoveryProbe'] as ReturnType<typeof vi.fn>
        ).mockResolvedValue({
          activeProjectId: 'proj-denied',
          activeAccessible: true,
          activeWatermark: '2026-02-17T10:01:00.000Z',
          projectsWatermark: '2026-02-17T10:02:00.000Z',
          blackboxWatermark: '2026-02-17T10:03:00.000Z',
          serverNow: '2026-02-17T10:03:01.000Z',
        });
        (context.mockSyncCoordinator['refreshProjectManifestIfNeeded'] as ReturnType<typeof vi.fn>)
          .mockResolvedValueOnce({ skipped: true, watermark: '2026-02-17T10:02:00.000Z' });

        vi.spyOn(
          context.service as unknown as {
            syncProjectListMetadata: (userId: string) => Promise<Set<string>>;
          },
          'syncProjectListMetadata'
        ).mockImplementation(async () => {
          (context.mockProjectState['setProjects'] as (...args: unknown[]) => void)([deniedProject, recoveredProject]);
          return new Set(['proj-recovered']);
        });

        await (
          context.service as unknown as {
            startBackgroundSync: (userId: string, previousActive: string | null) => Promise<void>;
          }
        ).startBackgroundSync('user-1', null);

        expect(context.mockProjectState['setProjects']).toHaveBeenCalledWith([
          expect.objectContaining({ id: 'proj-denied', syncSource: 'local-only', pendingSync: true }),
          expect.objectContaining({ id: 'proj-recovered', syncSource: 'synced' }),
        ]);
        expect((context.mockSyncCoordinator['core'] as { saveOfflineSnapshot: ReturnType<typeof vi.fn> }).saveOfflineSnapshot)
          .toHaveBeenCalledWith([
            expect.objectContaining({ id: 'proj-denied', syncSource: 'local-only', pendingSync: true }),
            expect.objectContaining({ id: 'proj-recovered', syncSource: 'synced' }),
          ], 'user-1');
        expect(context.mockToastService['info']).not.toHaveBeenCalledWith('当前项目不可访问，已自动切换');
        // 注意：loadSingleProjectFromCloud 可能会被后台空壳项目加载调用，
        // 但不应用于已降级为 local-only 的项目
      });

      it('刚创建的 synced pending 项目暂未进入远端清单时，不应被不可访问复核移除', async () => {
        context.userIdSignal.set('user-1');
        const pendingProject = context.createProject({
          id: 'proj-new-pending',
          name: 'New Pending',
          syncSource: 'synced',
          pendingSync: true,
        });
        (context.mockProjectState['setProjects'] as (...args: unknown[]) => void)([pendingProject]);
        (context.mockProjectState['setActiveProjectId'] as (projectId: string | null) => void)('proj-new-pending');
        vi.clearAllMocks();

        const result = await (
          context.service as unknown as {
            reconcileInaccessibleActiveProject: (projectId: string, userId: string) => Promise<string | null>;
          }
        ).reconcileInaccessibleActiveProject('proj-new-pending', 'user-1');

        expect(result).toBe('proj-new-pending');
        expect(context.mockProjectState['setActiveProjectId']).not.toHaveBeenCalledWith(null);
        expect(context.mockProjectState['setProjects']).not.toHaveBeenCalledWith([]);
        expect(context.mockToastService['info']).not.toHaveBeenCalledWith('当前项目不可访问，已自动切换');
        expect(context.service.isProjectAuthoritativelyAccessible('proj-new-pending')).toBe(true);
      });
    });
}
