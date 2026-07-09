import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WritableSignal } from '@angular/core';

import type { Project } from '../models';
import type { UserSessionServiceSpecContext } from './user-session.service.spec-context';
import { registerUserSessionLoadProjectsAndAttachmentSpecs } from './user-session-load-projects-attachment.spec-helpers';

export function registerUserSessionLoadAndSyncSpecs(getContext: () => UserSessionServiceSpecContext): void {
  let context: UserSessionServiceSpecContext;

  beforeEach(() => {
    context = getContext();
  });

  registerUserSessionLoadProjectsAndAttachmentSpecs(getContext);

    describe('startBackgroundSync', () => {
      it('Supabase auth session 尚未切到当前用户时，不应按不可访问裁剪 activeProject', async () => {
        context.userIdSignal.set('user-1');
        const activeProject = context.createProject({ id: 'proj-active', name: 'Active', syncSource: 'synced' });
        (context.mockProjectState['setProjects'] as (projects: Project[]) => void)([activeProject]);
        (context.mockProjectState['setActiveProjectId'] as (projectId: string | null) => void)('proj-active');
        vi.clearAllMocks();

        context.mockSupabaseClientService.getSession.mockResolvedValueOnce({
          data: { session: { user: { id: 'old-user' } } },
          error: null,
        });
        (
          (context.mockSyncCoordinator['core'] as Record<string, unknown>)['getResumeRecoveryProbe'] as ReturnType<typeof vi.fn>
        ).mockResolvedValue({
          activeProjectId: 'proj-active',
          activeAccessible: false,
          activeWatermark: null,
          projectsWatermark: '2026-02-17T10:02:00.000Z',
          blackboxWatermark: null,
          serverNow: '2026-02-17T10:03:01.000Z',
        });
        (
          (context.mockSyncCoordinator['core'] as Record<string, unknown>)['getAccessibleProjectProbe'] as ReturnType<typeof vi.fn>
        ).mockResolvedValue({
          projectId: 'proj-active',
          accessible: false,
          watermark: null,
        });

        await (
          context.service as unknown as {
            startBackgroundSync: (userId: string, previousActive: string | null) => Promise<void>;
          }
        ).startBackgroundSync('user-1', null);

        expect(
          (context.mockSyncCoordinator['core'] as Record<string, unknown>)['getResumeRecoveryProbe']
        ).not.toHaveBeenCalled();
        expect(
          (context.mockSyncCoordinator['core'] as Record<string, unknown>)['getAccessibleProjectProbe']
        ).not.toHaveBeenCalled();
        expect(context.mockProjectState['setActiveProjectId']).not.toHaveBeenCalledWith(null);
        expect(context.mockToastService['info']).not.toHaveBeenCalledWith('当前项目不可访问，已自动切换');
      });

      it('activeProject 首次补水返回空项目时也应复核一次，避免假空覆盖本地数据', async () => {
        context.userIdSignal.set('user-1');
        const activeShell = context.createProject({
          id: 'proj-active-empty',
          name: 'Active Shell',
          syncSource: 'synced',
          tasks: [],
          connections: [],
        });
        const localProject = context.createProject({
          id: 'proj-active-empty',
          name: 'Local Snapshot',
          syncSource: 'synced',
          tasks: [context.createTask({ id: 'task-local-active-empty', content: 'keep me' })],
          connections: [],
        });
        (context.mockProjectState['setProjects'] as (projects: Project[]) => void)([activeShell]);
        (context.mockProjectState['setActiveProjectId'] as (projectId: string | null) => void)('proj-active-empty');
        (context.mockProjectState['getProjectsWithCurrentData'] as ReturnType<typeof vi.fn>).mockReturnValue([localProject]);
        vi.clearAllMocks();

        vi.spyOn(
          context.service as unknown as {
            ensureProjectListMetadataSynced: (userId: string, sessionGuard?: unknown, pendingWatermark?: string | null) => Promise<Set<string>>;
          },
          'ensureProjectListMetadataSynced'
        ).mockResolvedValue(new Set(['proj-active-empty']));
        vi.spyOn(
          context.service as unknown as {
            hydrateShellProjectsInBackground: (userId: string, activeProjectId: string | null, sessionGuard?: unknown) => Promise<void>;
          },
          'hydrateShellProjectsInBackground'
        ).mockResolvedValue(undefined);

        (context.mockSyncCoordinator['loadSingleProjectFromCloud'] as ReturnType<typeof vi.fn>)
          .mockResolvedValueOnce(context.createProject({
            id: 'proj-active-empty',
            name: 'Remote Empty First',
            syncSource: 'synced',
            tasks: [],
            connections: [],
          }))
          .mockResolvedValueOnce(context.createProject({
            id: 'proj-active-empty',
            name: 'Remote Confirmed',
            syncSource: 'synced',
            tasks: [context.createTask({ id: 'task-remote-active-empty', content: 'remote ok' })],
            connections: [],
          }));

        await (
          context.service as unknown as {
            startBackgroundSync: (userId: string, previousActive: string | null) => Promise<void>;
          }
        ).startBackgroundSync('user-1', null);

        expect(context.mockSyncCoordinator['loadSingleProjectFromCloud']).toHaveBeenCalledTimes(2);
        expect(context.mockProjectState['setProjects']).toHaveBeenCalledWith([
          expect.objectContaining({
            id: 'proj-active-empty',
            name: 'Remote Confirmed',
            tasks: [expect.objectContaining({ id: 'task-remote-active-empty', content: 'remote ok' })],
          }),
        ]);
        expect(context.mockLoggerCategory.warn).toHaveBeenCalledWith(
          '按需加载首次返回空图数据，正在复核远端结果',
          expect.objectContaining({
            projectId: 'proj-active-empty',
            localTaskCount: 1,
          }),
        );
      });

      it('已水合的 activeProject 再次遇到空补水时仍应复核，避免会话内后续假空覆盖', async () => {
        context.userIdSignal.set('user-1');
        const activeProject = context.createProject({
          id: 'proj-active-hydrated-empty',
          name: 'Hydrated Local',
          syncSource: 'synced',
          tasks: [context.createTask({ id: 'task-local-hydrated-empty', content: 'keep me hydrated' })],
          connections: [],
        });
        (context.mockProjectState['setProjects'] as (projects: Project[]) => void)([activeProject]);
        (context.mockProjectState['setActiveProjectId'] as (projectId: string | null) => void)('proj-active-hydrated-empty');
        (context.mockProjectState['getProjectsWithCurrentData'] as ReturnType<typeof vi.fn>).mockReturnValue([activeProject]);
        (
          context.service as unknown as {
            hydratedProjectIds: Set<string>;
          }
        ).hydratedProjectIds.add('proj-active-hydrated-empty');
        vi.clearAllMocks();

        vi.spyOn(
          context.service as unknown as {
            ensureProjectListMetadataSynced: (userId: string, sessionGuard?: unknown, pendingWatermark?: string | null) => Promise<Set<string>>;
          },
          'ensureProjectListMetadataSynced'
        ).mockResolvedValue(new Set(['proj-active-hydrated-empty']));
        vi.spyOn(
          context.service as unknown as {
            hydrateShellProjectsInBackground: (userId: string, activeProjectId: string | null, sessionGuard?: unknown) => Promise<void>;
          },
          'hydrateShellProjectsInBackground'
        ).mockResolvedValue(undefined);

        (context.mockSyncCoordinator['loadSingleProjectFromCloud'] as ReturnType<typeof vi.fn>)
          .mockResolvedValueOnce(context.createProject({
            id: 'proj-active-hydrated-empty',
            name: 'Remote Empty First',
            syncSource: 'synced',
            tasks: [],
            connections: [],
          }))
          .mockResolvedValueOnce(context.createProject({
            id: 'proj-active-hydrated-empty',
            name: 'Remote Confirmed Later',
            syncSource: 'synced',
            tasks: [context.createTask({ id: 'task-remote-hydrated-empty', content: 'remote ok later' })],
            connections: [],
          }));

        await (
          context.service as unknown as {
            startBackgroundSync: (userId: string, previousActive: string | null) => Promise<void>;
          }
        ).startBackgroundSync('user-1', null);

        expect(context.mockSyncCoordinator['loadSingleProjectFromCloud']).toHaveBeenCalledTimes(2);
        expect(context.mockProjectState['setProjects']).toHaveBeenCalledWith([
          expect.objectContaining({
            id: 'proj-active-hydrated-empty',
            name: 'Remote Confirmed Later',
            tasks: [expect.objectContaining({ id: 'task-remote-hydrated-empty', content: 'remote ok later' })],
          }),
        ]);
        expect(context.mockLoggerCategory.warn).toHaveBeenCalledWith(
          '按需加载首次返回空图数据，正在复核远端结果',
          expect.objectContaining({
            projectId: 'proj-active-hydrated-empty',
            localTaskCount: 1,
          }),
        );
      });

      it('activeProject 不可访问时应清理并跳过项目同步', async () => {
        const deniedProject = context.createProject({ id: 'proj-denied', name: 'Denied', syncSource: 'synced' });
        const keepProject = context.createProject({
          id: 'proj-ok',
          name: 'Keep',
          syncSource: 'synced',
          tasks: [context.createTask({ id: 'task-keep' })],
        });
        (context.mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([deniedProject, keepProject]);
        (context.mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>).mockReturnValue('proj-denied');
        (context.mockSyncCoordinator['core'] as { saveOfflineSnapshot: ReturnType<typeof vi.fn> }).saveOfflineSnapshot.mockClear();
        (context.mockSyncCoordinator['loadSingleProjectFromCloud'] as ReturnType<typeof vi.fn>).mockResolvedValue(keepProject);
        vi.spyOn(
          context.service as unknown as {
            syncProjectListMetadata: (userId: string) => Promise<Set<string>>;
          },
          'syncProjectListMetadata'
        ).mockResolvedValue(new Set(['proj-ok']));

        await (
          context.service as unknown as {
            startBackgroundSync: (userId: string, previousActive: string | null) => Promise<void>;
          }
        ).startBackgroundSync('user-1', null);

        expect(context.mockProjectState['setActiveProjectId']).toHaveBeenCalledWith(null);
        expect(context.mockProjectState['setProjects']).toHaveBeenCalledWith([
          expect.objectContaining({ id: 'proj-ok' }),
        ]);
        expect((context.mockSyncCoordinator['core'] as { saveOfflineSnapshot: ReturnType<typeof vi.fn> }).saveOfflineSnapshot)
          .toHaveBeenCalledWith([
            expect.objectContaining({ id: 'proj-ok' }),
          ], 'user-1');
        expect(context.mockToastService['info']).toHaveBeenCalledWith('当前项目不可访问，已自动切换');
        expect(context.mockSyncCoordinator['loadSingleProjectFromCloud']).toHaveBeenCalledWith('proj-ok');
        expect(context.mockSyncCoordinator['performDeltaSync']).not.toHaveBeenCalled();
      });

      it('activeProject probe 不可访问时应提前清理，避免后续 full-project 路径', async () => {
        const deniedProject = context.createProject({ id: 'proj-denied', name: 'Denied', syncSource: 'synced' });
        const keepProject = context.createProject({
          id: 'proj-ok',
          name: 'Keep',
          syncSource: 'synced',
          tasks: [context.createTask({ id: 'task-keep' })],
        });
        (context.mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([deniedProject, keepProject]);
        (context.mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>).mockReturnValue('proj-denied');
        (context.mockSyncCoordinator['core'] as { saveOfflineSnapshot: ReturnType<typeof vi.fn> }).saveOfflineSnapshot.mockClear();
        (
          (context.mockSyncCoordinator['core'] as Record<string, unknown>)['getAccessibleProjectProbe'] as ReturnType<typeof vi.fn>
        ).mockResolvedValue({
          projectId: 'proj-denied',
          accessible: false,
          watermark: null,
        });
        (context.mockSyncCoordinator['refreshProjectManifestIfNeeded'] as ReturnType<typeof vi.fn>)
          .mockResolvedValueOnce({ skipped: true, watermark: '2026-02-17T10:02:00.000Z' });
        vi.spyOn(
          context.service as unknown as {
            syncProjectListMetadata: (userId: string) => Promise<Set<string>>;
          },
          'syncProjectListMetadata'
        ).mockResolvedValue(new Set(['proj-ok']));

        await (
          context.service as unknown as {
            startBackgroundSync: (userId: string, previousActive: string | null) => Promise<void>;
          }
        ).startBackgroundSync('user-1', null);

        expect(context.mockProjectState['setActiveProjectId']).toHaveBeenCalledWith(null);
        expect(context.mockProjectState['setProjects']).toHaveBeenCalledWith([
          expect.objectContaining({ id: 'proj-ok' }),
        ]);
        expect((context.mockSyncCoordinator['core'] as { saveOfflineSnapshot: ReturnType<typeof vi.fn> }).saveOfflineSnapshot)
          .toHaveBeenCalledWith([
            expect.objectContaining({ id: 'proj-ok' }),
          ], 'user-1');
        expect(context.mockSyncCoordinator['loadSingleProjectFromCloud']).not.toHaveBeenCalled();
        expect(context.mockSyncCoordinator['performDeltaSync']).not.toHaveBeenCalled();
      });

      it('composite probe 命中时应优先使用预加载水位，避免重复 RPC', async () => {
        (context.mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>).mockReturnValue('proj-1');
        (
          (context.mockSyncCoordinator['core'] as Record<string, unknown>)['getResumeRecoveryProbe'] as ReturnType<typeof vi.fn>
        ).mockResolvedValue({
          activeProjectId: 'proj-1',
          activeAccessible: true,
          activeWatermark: '2026-02-17T10:00:00.000Z',
          projectsWatermark: '2026-02-17T10:02:00.000Z',
          blackboxWatermark: '2026-02-17T10:03:00.000Z',
          serverNow: '2026-02-17T10:03:01.000Z',
        });
        (context.mockSyncCoordinator['refreshProjectManifestIfNeeded'] as ReturnType<typeof vi.fn>)
          .mockResolvedValueOnce({ skipped: false, watermark: '2026-02-17T10:02:00.000Z' });

        await (
          context.service as unknown as {
            startBackgroundSync: (userId: string, previousActive: string | null) => Promise<void>;
          }
        ).startBackgroundSync('user-1', null);

        expect(
          (context.mockSyncCoordinator['core'] as Record<string, unknown>)['setLastSyncTime']
        ).not.toHaveBeenCalled();
        expect(context.mockSyncCoordinator['refreshProjectManifestIfNeeded']).toHaveBeenCalledWith(
          'session-background-sync',
          { prefetchedRemoteWatermark: '2026-02-17T10:02:00.000Z', deferCommit: true }
        );
        expect(context.mockSyncCoordinator['refreshBlackBoxWatermarkIfNeeded']).toHaveBeenCalledWith(
          'session-background-sync',
          { prefetchedRemoteWatermark: '2026-02-17T10:03:00.000Z' }
        );
        expect(
          (context.mockSyncCoordinator['core'] as Record<string, unknown>)['getAccessibleProjectProbe']
        ).not.toHaveBeenCalled();
      });

      it('项目清单快路命中时仍应执行黑匣子快路，并仅保留当前项目的 Delta Sync', async () => {
        (context.mockProjectState['setProjects'] as (...args: unknown[]) => void)([
          context.createProject({ id: 'proj-1', syncSource: 'synced', tasks: [context.createTask({ id: 'task-1' })] }),
        ]);
        (context.mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>).mockReturnValue('proj-1');
        (
          (context.mockSyncCoordinator['core'] as Record<string, unknown>)['getResumeRecoveryProbe'] as ReturnType<typeof vi.fn>
        ).mockResolvedValue({
          activeProjectId: 'proj-1',
          activeAccessible: true,
          activeWatermark: '2026-02-17T10:00:00.000Z',
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
        );

        await (
          context.service as unknown as {
            startBackgroundSync: (userId: string, previousActive: string | null) => Promise<void>;
          }
        ).startBackgroundSync('user-1', null);

        expect(syncProjectListMetadataSpy).not.toHaveBeenCalled();
        expect(context.mockSyncCoordinator['performDeltaSync']).toHaveBeenCalledWith('proj-1');
        expect(context.mockSyncCoordinator['loadSingleProjectFromCloud']).not.toHaveBeenCalled();
        expect(context.mockSyncCoordinator['refreshBlackBoxWatermarkIfNeeded']).toHaveBeenCalledWith(
          'session-background-sync',
          { prefetchedRemoteWatermark: '2026-02-17T10:03:00.000Z' }
        );
      });

      it('项目清单快路命中但 Delta Sync 失败且日志失败时仍应完成后台同步', async () => {
        const deltaError = new Error('delta failed');
        (context.mockProjectState['setProjects'] as (...args: unknown[]) => void)([
          context.createProject({ id: 'proj-delta-fastpath', syncSource: 'synced', tasks: [context.createTask({ id: 'task-fastpath' })] }),
        ]);
        (context.mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>).mockReturnValue('proj-delta-fastpath');
        (
          (context.mockSyncCoordinator['core'] as Record<string, unknown>)['getResumeRecoveryProbe'] as ReturnType<typeof vi.fn>
        ).mockResolvedValue({
          activeProjectId: 'proj-delta-fastpath',
          activeAccessible: true,
          activeWatermark: '2026-02-17T10:00:00.000Z',
          projectsWatermark: '2026-02-17T10:02:00.000Z',
          blackboxWatermark: '2026-02-17T10:03:00.000Z',
          serverNow: '2026-02-17T10:03:01.000Z',
        });
        (context.mockSyncCoordinator['refreshProjectManifestIfNeeded'] as ReturnType<typeof vi.fn>)
          .mockResolvedValueOnce({ skipped: true, watermark: '2026-02-17T10:02:00.000Z' });
        (context.mockSyncCoordinator['performDeltaSync'] as ReturnType<typeof vi.fn>)
          .mockRejectedValueOnce(deltaError);
        context.mockLoggerCategory.warn.mockImplementationOnce(() => {
          throw new Error('warn failed');
        });

        await expect((
          context.service as unknown as {
            startBackgroundSync: (userId: string, previousActive: string | null) => Promise<void>;
          }
        ).startBackgroundSync('user-1', null)).resolves.toBeUndefined();

        expect(context.mockSyncCoordinator['performDeltaSync']).toHaveBeenCalledWith('proj-delta-fastpath');
        expect(context.mockLoggerCategory.warn).toHaveBeenCalledWith('Delta Sync 失败', deltaError);
      });

      it('并行元数据同步中的 Delta Sync rejection 且日志失败时仍应完成后台同步', async () => {
        const deltaError = new Error('parallel delta failed');
        (context.mockProjectState['setProjects'] as (...args: unknown[]) => void)([
          context.createProject({ id: 'proj-parallel-delta', syncSource: 'synced', tasks: [context.createTask({ id: 'task-parallel' })] }),
        ]);
        (context.mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>).mockReturnValue('proj-parallel-delta');
        (
          (context.mockSyncCoordinator['core'] as Record<string, unknown>)['getResumeRecoveryProbe'] as ReturnType<typeof vi.fn>
        ).mockResolvedValue({
          activeProjectId: 'proj-parallel-delta',
          activeAccessible: true,
          activeWatermark: '2026-02-17T10:00:00.000Z',
          projectsWatermark: null,
          blackboxWatermark: null,
          serverNow: '2026-02-17T10:03:01.000Z',
        });
        (context.mockSyncCoordinator['refreshProjectManifestIfNeeded'] as ReturnType<typeof vi.fn>)
          .mockResolvedValueOnce({ skipped: false, watermark: null });
        vi.spyOn(
          context.service as unknown as {
            ensureProjectListMetadataSynced: (
              userId: string,
              sessionGuard?: unknown,
              pendingWatermark?: string | null,
            ) => Promise<Set<string>>;
          },
          'ensureProjectListMetadataSynced'
        ).mockResolvedValue(new Set(['proj-parallel-delta']));
        (context.mockSyncCoordinator['performDeltaSync'] as ReturnType<typeof vi.fn>)
          .mockRejectedValueOnce(deltaError);
        context.mockLoggerCategory.warn.mockImplementationOnce(() => {
          throw new Error('warn failed');
        });

        await expect((
          context.service as unknown as {
            startBackgroundSync: (userId: string, previousActive: string | null) => Promise<void>;
          }
        ).startBackgroundSync('user-1', null)).resolves.toBeUndefined();

        expect(context.mockSyncCoordinator['performDeltaSync']).toHaveBeenCalledWith('proj-parallel-delta');
        expect(context.mockLoggerCategory.warn).toHaveBeenCalledWith('Delta Sync 失败', deltaError);
      });

      it('项目清单水位快路失败且日志失败时仍应降级为常规后台同步', async () => {
        const manifestError = new Error('manifest probe failed');
        const result = {
          skipProjectSyncSlowPath: false,
          pendingProjectManifestWatermark: null,
        };
        (context.mockSyncCoordinator['refreshProjectManifestIfNeeded'] as ReturnType<typeof vi.fn>)
          .mockRejectedValueOnce(manifestError);
        context.mockLoggerCategory.warn.mockImplementationOnce(() => {
          throw new Error('warn failed');
        });

        await expect((
          context.service as unknown as {
            refreshBackgroundProjectManifestWatermark: (
              resumeProbe: null,
              watermarkResult: typeof result,
            ) => Promise<void>;
          }
        ).refreshBackgroundProjectManifestWatermark(null, result)).resolves.toBeUndefined();

        expect(result).toEqual({
          skipProjectSyncSlowPath: false,
          pendingProjectManifestWatermark: null,
        });
        expect(context.mockLoggerCategory.warn).toHaveBeenCalledWith(
          '项目清单水位快路失败，降级为常规后台同步',
          manifestError
        );
      });

      it('黑匣子水位快路失败且日志失败时仍应降级为常规流程', async () => {
        const blackboxError = new Error('blackbox probe failed');
        (context.mockSyncCoordinator['refreshBlackBoxWatermarkIfNeeded'] as ReturnType<typeof vi.fn>)
          .mockRejectedValueOnce(blackboxError);
        context.mockLoggerCategory.warn.mockImplementationOnce(() => {
          throw new Error('warn failed');
        });

        await expect((
          context.service as unknown as {
            refreshBackgroundBlackBoxWatermark: (resumeProbe: null) => Promise<void>;
          }
        ).refreshBackgroundBlackBoxWatermark(null)).resolves.toBeUndefined();

        expect(context.mockLoggerCategory.warn).toHaveBeenCalledWith(
          '黑匣子水位快路失败，降级为常规流程',
          blackboxError
        );
      });

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
        const query = {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          is: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnThis(),
          range: vi.fn().mockResolvedValue({
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
        (context.mockSyncCoordinator['loadSingleProjectFromCloud'] as ReturnType<typeof vi.fn>).mockResolvedValue(
          context.createProject({ id: 'proj-ok', name: 'Keep', syncSource: 'synced' })
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
        const query = {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          is: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnThis(),
          range: vi.fn().mockResolvedValue({
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
        vi.spyOn(
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

        expect(context.mockSyncCoordinator['commitProjectManifestWatermark']).not.toHaveBeenCalled();
      });

      it('项目元数据慢路失败时不应提交 deferred manifest watermark', async () => {
        const query = {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          is: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnThis(),
          range: vi.fn().mockResolvedValue({
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
          range: vi.fn().mockRejectedValue(new Error('metadata query failed')),
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
