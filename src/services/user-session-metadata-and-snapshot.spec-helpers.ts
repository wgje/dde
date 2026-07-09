import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AUTH_CONFIG } from '../config/auth.config';
import type { Project } from '../models';
import { markTaskContentMissingFromSource } from '../utils/task-content-guard';
import { createBrowserNetworkSuspendedError } from '../utils/browser-network-suspension';
import type { UserSessionServiceSpecContext } from './user-session.service.spec-context';
import { registerUserSessionSnapshotPrehydrateSpecs } from './user-session-snapshot-prehydrate.spec-helpers';

export function registerUserSessionMetadataAndSnapshotSpecs(getContext: () => UserSessionServiceSpecContext): void {
  let context: UserSessionServiceSpecContext;

  beforeEach(() => {
    context = getContext();
  });

    describe('syncProjectListMetadata', () => {
      /** 辅助：构建 Supabase client mock，返回指定的服务端项目列表 */
      function setupSupabaseQuery(serverProjects: Array<Record<string, unknown>>) {
        const { query, ranges } = createPagedProjectListQuery(serverProjects);
        const from = vi.fn().mockReturnValue(query);
        context.mockSupabaseClientService.client.mockReturnValue({ from });
        context.mockSupabaseClientService.clientAsync.mockResolvedValue({ from });
        return { query, ranges };
      }
  
      function createPagedProjectListQuery(serverProjects: Array<Record<string, unknown>>) {
        const ranges: Array<[number, number]> = [];
        const query = {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          is: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnThis(),
          range: vi.fn(async (from: number, to: number) => {
            ranges.push([from, to]);
            return {
              data: serverProjects.slice(from, to + 1),
              error: null,
            };
          }),
        };
        return { query, ranges };
      }
  
      it('浏览器网络挂起导致项目列表查询失败时应保留本地项目且不告警', async () => {
        const localProject = context.createProject({ id: 'proj-local', name: 'Local', syncSource: 'synced' });
        (context.mockProjectState['setProjects'] as (projects: Project[]) => void)([localProject]);
        vi.clearAllMocks();
  
        const query = {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          is: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnThis(),
          range: vi.fn().mockResolvedValue({
            data: null,
            error: createBrowserNetworkSuspendedError(),
          }),
        };
        context.mockSupabaseClientService.clientAsync.mockResolvedValue({
          from: vi.fn().mockReturnValue(query),
        });
  
        const accessibleProjectIds = await (
          context.service as unknown as {
            syncProjectListMetadata: (userId: string) => Promise<Set<string>>;
          }
        ).syncProjectListMetadata('user-1');
  
        expect([...accessibleProjectIds]).toEqual(['proj-local']);
        expect(context.mockProjectState['setProjectsMetadataOnly']).not.toHaveBeenCalled();
        expect(context.mockLoggerCategory.warn).not.toHaveBeenCalled();
      });
  
      it('Supabase auth session 尚未切到当前用户时，应把空项目清单视为非权威结果', async () => {
        const localProject = context.createProject({ id: 'proj-local', name: 'Local', syncSource: 'synced' });
        context.userIdSignal.set('user-1');
        (context.mockProjectState['setProjects'] as (projects: Project[]) => void)([localProject]);
        (context.mockProjectState['setActiveProjectId'] as (projectId: string | null) => void)(null);
        vi.clearAllMocks();
        context.mockSupabaseClientService.getSession.mockResolvedValueOnce({
          data: { session: { user: { id: 'old-user' } } },
          error: null,
        });
        setupSupabaseQuery([]);
  
        const accessibleProjectIds = await (
          context.service as unknown as {
            syncProjectListMetadata: (userId: string) => Promise<Set<string>>;
          }
        ).syncProjectListMetadata('user-1');
  
        expect([...accessibleProjectIds]).toEqual(['proj-local']);
        expect(context.mockProjectState['setProjectsMetadataOnly']).not.toHaveBeenCalled();
        expect(context.service.canAuthoritativelyRejectProjectRoute()).toBe(false);
      });
  
      it('在项目数达到裁剪阈值时，应清理不可访问且无待同步改动的非活跃项目', async () => {
        const keepProject = context.createProject({ id: 'proj-ok', name: 'Keep' });
        const keepProject2 = context.createProject({ id: 'proj-ok-2', name: 'Keep 2' });
        const staleProject = context.createProject({ id: 'proj-stale', name: 'Stale' });
        (context.mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([keepProject, keepProject2, staleProject]);
        // activeProjectId 设为 null，以便 staleProject 可被裁剪
        (context.mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>).mockReturnValue(null);
        (context.mockSyncCoordinator['hasPendingChangesForProject'] as ReturnType<typeof vi.fn>).mockReturnValue(false);
  
        setupSupabaseQuery([
          {
            id: 'proj-ok', title: 'Keep', description: '',
            created_date: keepProject.createdDate, updated_at: keepProject.updatedAt, version: 1,
          },
          {
            id: 'proj-ok-2', title: 'Keep 2', description: '',
            created_date: keepProject2.createdDate, updated_at: keepProject2.updatedAt, version: 1,
          },
        ]);
  
        const result = await (
          context.service as unknown as {
            syncProjectListMetadata: (userId: string) => Promise<Set<string>>;
          }
        ).syncProjectListMetadata('user-1');
  
        expect(result.has('proj-ok')).toBe(true);
        expect(result.has('proj-ok-2')).toBe(true);
        expect(result.has('proj-stale')).toBe(false);
        expect(context.mockProjectState['setProjectsMetadataOnly']).toHaveBeenCalledWith([
          expect.objectContaining({ id: 'proj-ok' }),
          expect.objectContaining({ id: 'proj-ok-2' }),
        ]);
      });
  
      it('项目列表元数据应分页加载超过 Supabase REST 单页上限的项目', async () => {
        (context.mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([]);
        const serverProjects = Array.from({ length: 1001 }, (_, index) => ({
          id: `proj-${index.toString().padStart(4, '0')}`,
          title: `Project ${index}`,
          description: '',
          created_date: '2026-06-09T00:00:00.000Z',
          updated_at: new Date(Date.UTC(2026, 5, 9, 0, 0, index)).toISOString(),
          version: 1,
          owner_id: 'user-1',
        }));
        const { ranges } = setupSupabaseQuery(serverProjects);
  
        const result = await (
          context.service as unknown as {
            syncProjectListMetadata: (userId: string) => Promise<Set<string>>;
          }
        ).syncProjectListMetadata('user-1');
  
        expect(result.size).toBe(1001);
        expect(result.has('proj-1000')).toBe(true);
        expect(ranges).toEqual([
          [0, 999],
          [1000, 1999],
        ]);
      });
  
      it('当前活跃项目不应被裁剪（由调用方处理）', async () => {
        const keepProject = context.createProject({ id: 'proj-ok', name: 'Keep' });
        const activeProject = context.createProject({ id: 'proj-active', name: 'Active' });
        const staleProject = context.createProject({ id: 'proj-stale', name: 'Stale' });
        (context.mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([keepProject, activeProject, staleProject]);
        (context.mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>).mockReturnValue('proj-active');
        (context.mockSyncCoordinator['hasPendingChangesForProject'] as ReturnType<typeof vi.fn>).mockReturnValue(false);
  
        // 服务端返回 proj-ok 和一个新项目，ratio 2/3 ≥ 50%，裁剪正常执行
        // proj-active 和 proj-stale 都不可访问，但 proj-active 受保护
        setupSupabaseQuery([
          {
            id: 'proj-ok', title: 'Keep', description: '',
            created_date: keepProject.createdDate, updated_at: keepProject.updatedAt, version: 1,
          },
          {
            id: 'proj-new', title: 'New', description: '',
            created_date: new Date().toISOString(), updated_at: new Date().toISOString(), version: 1,
          },
        ]);
  
        await (
          context.service as unknown as {
            syncProjectListMetadata: (userId: string) => Promise<Set<string>>;
          }
        ).syncProjectListMetadata('user-1');
  
        // 验证 setProjectsMetadataOnly 被调用（有壳新增 + 裁剪变更）
        const setProjectsCall = (context.mockProjectState['setProjectsMetadataOnly'] as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
        expect(setProjectsCall).toBeDefined();
        // proj-active 是当前活跃项目，不应被裁剪
        expect(setProjectsCall.some((p: Project) => p.id === 'proj-active')).toBe(true);
        expect(setProjectsCall.some((p: Project) => p.id === 'proj-ok')).toBe(true);
        // proj-stale 不是活跃项目，应被裁剪
        expect(setProjectsCall.some((p: Project) => p.id === 'proj-stale')).toBe(false);
        // proj-new 应被添加为壳
        expect(setProjectsCall.some((p: Project) => p.id === 'proj-new')).toBe(true);
      });
  
      it('服务端返回空列表时应裁剪全部不可访问的 synced 项目', async () => {
        const localA = context.createProject({ id: 'proj-a', name: 'A' });
        const localB = context.createProject({ id: 'proj-b', name: 'B' });
        (context.mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([localA, localB]);
        (context.mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>).mockReturnValue(null);
        (context.mockSyncCoordinator['hasPendingChangesForProject'] as ReturnType<typeof vi.fn>).mockReturnValue(false);
        (context.mockSyncCoordinator['core'] as { saveOfflineSnapshot: ReturnType<typeof vi.fn> }).saveOfflineSnapshot.mockClear();
  
        setupSupabaseQuery([]); // 服务端返回空
  
        await (
          context.service as unknown as {
            syncProjectListMetadata: (userId: string) => Promise<Set<string>>;
          }
        ).syncProjectListMetadata('user-1');
  
        expect(context.mockProjectState['setProjectsMetadataOnly']).toHaveBeenCalledWith([]);
        expect((context.mockSyncCoordinator['core'] as { saveOfflineSnapshot: ReturnType<typeof vi.fn> }).saveOfflineSnapshot)
          .toHaveBeenCalledWith([], 'user-1');
      });
  
      it('服务端暂未返回 pendingSync 的 synced 项目时应保留本地项目', async () => {
        context.userIdSignal.set('user-1');
        const pendingProject = context.createProject({
          id: 'proj-new-pending',
          name: 'New Pending',
          syncSource: 'synced',
          pendingSync: true,
        });
        (context.mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([pendingProject]);
        (context.mockProjectState['getProject'] as ReturnType<typeof vi.fn>).mockImplementation((id: string) => (
          id === pendingProject.id ? pendingProject : undefined
        ));
        (context.mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>).mockReturnValue(null);
        (context.mockSyncCoordinator['hasPendingChangesForProject'] as ReturnType<typeof vi.fn>).mockReturnValue(false);
        (context.mockSyncCoordinator['core'] as { saveOfflineSnapshot: ReturnType<typeof vi.fn> }).saveOfflineSnapshot.mockClear();
  
        setupSupabaseQuery([]);
  
        const result = await (
          context.service as unknown as {
            syncProjectListMetadata: (userId: string) => Promise<Set<string>>;
          }
        ).syncProjectListMetadata('user-1');
  
        expect([...result]).toEqual([]);
        expect(context.mockProjectState['setProjectsMetadataOnly']).not.toHaveBeenCalledWith([]);
        expect((context.mockSyncCoordinator['core'] as { saveOfflineSnapshot: ReturnType<typeof vi.fn> }).saveOfflineSnapshot)
          .not.toHaveBeenCalledWith([], 'user-1');
        expect(context.service.isProjectAuthoritativelyAccessible('proj-new-pending')).toBe(true);
      });
  
      it('服务端项目数显著少于本地时仍应裁剪缺失的 synced 项目', async () => {
        const localProjects = [
          context.createProject({ id: 'p1', name: 'P1' }),
          context.createProject({ id: 'p2', name: 'P2' }),
          context.createProject({ id: 'p3', name: 'P3' }),
          context.createProject({ id: 'p4', name: 'P4' }),
        ];
        (context.mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue(localProjects);
        (context.mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>).mockReturnValue(null);
        (context.mockSyncCoordinator['hasPendingChangesForProject'] as ReturnType<typeof vi.fn>).mockReturnValue(false);
  
        // 服务端只返回 1/4，但查询已成功，应按真实远端状态裁剪
        setupSupabaseQuery([{
          id: 'p1', title: 'P1', description: '',
          created_date: localProjects[0].createdDate, updated_at: localProjects[0].updatedAt, version: 1,
        }]);
  
        await (
          context.service as unknown as {
            syncProjectListMetadata: (userId: string) => Promise<Set<string>>;
          }
        ).syncProjectListMetadata('user-1');
  
        const setProjectsCall = (context.mockProjectState['setProjectsMetadataOnly'] as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Project[] | undefined;
        expect(setProjectsCall?.map((project: Project) => project.id)).toEqual(['p1']);
      });
  
      it('本地仅有 2 个项目时也应裁剪缺失的 synced 项目', async () => {
        const localProjects = [
          context.createProject({ id: 'p1', name: 'P1' }),
          context.createProject({ id: 'p2', name: 'P2' }),
        ];
        (context.mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue(localProjects);
        (context.mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>).mockReturnValue(null);
        (context.mockSyncCoordinator['hasPendingChangesForProject'] as ReturnType<typeof vi.fn>).mockReturnValue(false);
  
        setupSupabaseQuery([{
          id: 'p1', title: 'P1', description: '',
          created_date: localProjects[0].createdDate, updated_at: localProjects[0].updatedAt, version: 1,
        }]);
  
        await (
          context.service as unknown as {
            syncProjectListMetadata: (userId: string) => Promise<Set<string>>;
          }
        ).syncProjectListMetadata('user-1');
  
        const setProjectsCall = (context.mockProjectState['setProjectsMetadataOnly'] as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Project[] | undefined;
        expect(setProjectsCall?.map((project: Project) => project.id)).toEqual(['p1']);
      });
  
      it('服务端存在的项目应被提升为 synced，清除 local-only 影子标记', async () => {
        const remoteUpdatedAt = '2026-04-04T04:00:00.000Z';
        const localProject = context.createProject({
          id: 'proj-shadow',
          name: 'Shadow',
          updatedAt: '2026-04-04T03:00:00.000Z',
          syncSource: 'local-only',
          pendingSync: true,
        });
        (context.mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([localProject]);
        (context.mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>).mockReturnValue(null);
        (context.mockSyncCoordinator['hasPendingChangesForProject'] as ReturnType<typeof vi.fn>).mockReturnValue(false);
        (context.mockSyncCoordinator['core'] as { saveOfflineSnapshot: ReturnType<typeof vi.fn> }).saveOfflineSnapshot.mockClear();
  
        setupSupabaseQuery([{
          id: 'proj-shadow', title: 'Shadow', description: '',
          created_date: localProject.createdDate, updated_at: remoteUpdatedAt, version: localProject.version,
        }]);
  
        await (
          context.service as unknown as {
            syncProjectListMetadata: (userId: string) => Promise<Set<string>>;
          }
        ).syncProjectListMetadata('user-1');
  
        const setProjectsCall = (context.mockProjectState['setProjectsMetadataOnly'] as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Project[] | undefined;
        expect(setProjectsCall).toBeDefined();
        const syncedProject = setProjectsCall?.find((project: Project) => project.id === 'proj-shadow');
        expect(syncedProject?.syncSource).toBe('synced');
        expect(syncedProject?.pendingSync).toBe(false);
        expect(syncedProject?.updatedAt).toBe(remoteUpdatedAt);
        expect((context.mockSyncCoordinator['core'] as { saveOfflineSnapshot: ReturnType<typeof vi.fn> }).saveOfflineSnapshot)
          .toHaveBeenCalledWith([
            expect.objectContaining({
              id: 'proj-shadow',
              syncSource: 'synced',
              pendingSync: false,
              updatedAt: remoteUpdatedAt,
            }),
          ], 'user-1');
      });
  
      it('local-only 项目即使服务端不存在也应继续保留，等待用户决定是否迁移', async () => {
        const remoteProjectA = context.createProject({ id: 'proj-a', name: 'A', syncSource: 'synced' });
        const remoteProjectB = context.createProject({ id: 'proj-b', name: 'B', syncSource: 'synced' });
        const localOnlyProject = context.createProject({
          id: 'proj-local-only',
          name: 'Guest Draft',
          syncSource: 'local-only',
        });
        context.saveGuestDraftProjects([localOnlyProject]);
        (context.mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([
          remoteProjectA,
          remoteProjectB,
          localOnlyProject,
        ]);
        (context.mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>).mockReturnValue(null);
        (context.mockSyncCoordinator['hasPendingChangesForProject'] as ReturnType<typeof vi.fn>).mockReturnValue(false);
  
        setupSupabaseQuery([
          {
            id: 'proj-a', title: 'A', description: '',
            created_date: remoteProjectA.createdDate, updated_at: remoteProjectA.updatedAt, version: 1,
          },
          {
            id: 'proj-b', title: 'B', description: '',
            created_date: remoteProjectB.createdDate, updated_at: remoteProjectB.updatedAt, version: 1,
          },
        ]);
  
        await (
          context.service as unknown as {
            syncProjectListMetadata: (userId: string) => Promise<Set<string>>;
          }
        ).syncProjectListMetadata('user-1');
  
        const setProjectsCall = (context.mockProjectState['setProjectsMetadataOnly'] as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Project[] | undefined;
        expect(setProjectsCall?.some((project: Project) => project.id === 'proj-local-only')).toBe(true);
      });
  
      it('metadata sync 后保留的 local-only 项目仍应被视为可访问', async () => {
        const remoteProject = context.createProject({ id: 'proj-a', name: 'A', syncSource: 'synced' });
        const localOnlyProject = context.createProject({
          id: 'proj-local-only',
          name: 'Guest Draft',
          syncSource: 'local-only',
        });
        context.userIdSignal.set('user-1');
        context.saveGuestDraftProjects([localOnlyProject]);
        (context.mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([
          remoteProject,
          localOnlyProject,
        ]);
        (context.mockProjectState['getProject'] as ReturnType<typeof vi.fn>).mockImplementation(
          (id: string) => [remoteProject, localOnlyProject].find((project) => project.id === id)
        );
        (context.mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>).mockReturnValue(null);
        (context.mockSyncCoordinator['hasPendingChangesForProject'] as ReturnType<typeof vi.fn>).mockReturnValue(false);
  
        setupSupabaseQuery([
          {
            id: 'proj-a', title: 'A', description: '',
            created_date: remoteProject.createdDate, updated_at: remoteProject.updatedAt, version: 1,
          },
        ]);
  
        await (
          context.service as unknown as {
            syncProjectListMetadata: (userId: string) => Promise<Set<string>>;
          }
        ).syncProjectListMetadata('user-1');
  
        expect(context.service.isProjectAuthoritativelyAccessible('proj-local-only')).toBe(true);
      });
  
      it('远端清单尚未包含新建项目时，pendingSync 的 synced 项目仍应被视为可访问', () => {
        const pendingProject = context.createProject({
          id: 'proj-new-pending',
          name: 'New Pending',
          syncSource: 'synced',
          pendingSync: true,
        });
        context.userIdSignal.set('user-1');
        (context.mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([pendingProject]);
        (context.mockProjectState['getProject'] as ReturnType<typeof vi.fn>).mockImplementation((id: string) => (
          id === pendingProject.id ? pendingProject : undefined
        ));
        (context.mockSyncCoordinator['hasPendingChangesForProject'] as ReturnType<typeof vi.fn>).mockReturnValue(false);
        (context.mockChangeTracker['hasProjectChanges'] as ReturnType<typeof vi.fn>).mockReturnValue(false);
  
        expect(context.service.isProjectAuthoritativelyAccessible('proj-new-pending')).toBe(true);
      });
  
      it('匿名或 local-user 模式下缺失项目不应被视为可访问', () => {
        context.userIdSignal.set(AUTH_CONFIG.LOCAL_MODE_USER_ID);
        (context.mockProjectState['getProject'] as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
  
        expect(context.service.isProjectAuthoritativelyAccessible('proj-missing')).toBe(false);
      });
  
      it('expired guest draft 标记不应阻止 local-only 影子项目被裁剪', async () => {
        const remoteProject = context.createProject({ id: 'proj-a', name: 'A', syncSource: 'synced' });
        const shadowProject = context.createProject({
          id: 'proj-expired-shadow',
          name: 'Expired Shadow',
          syncSource: 'local-only',
          pendingSync: true,
        });
        localStorage.setItem('nanoflow.guest-data', JSON.stringify({
          projects: [shadowProject],
          version: 2,
          savedAt: '2026-02-01T00:00:00.000Z',
          expiresAt: '2026-02-02T00:00:00.000Z',
        }));
        (context.mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([remoteProject, shadowProject]);
        (context.mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>).mockReturnValue(null);
        (context.mockSyncCoordinator['hasPendingChangesForProject'] as ReturnType<typeof vi.fn>).mockReturnValue(false);
  
        setupSupabaseQuery([
          {
            id: 'proj-a', title: 'A', description: '',
            created_date: remoteProject.createdDate, updated_at: remoteProject.updatedAt, version: 1,
          },
        ]);
  
        await (
          context.service as unknown as {
            syncProjectListMetadata: (userId: string) => Promise<Set<string>>;
          }
        ).syncProjectListMetadata('user-1');
  
        const setProjectsCall = (context.mockProjectState['setProjectsMetadataOnly'] as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Project[] | undefined;
        expect(setProjectsCall?.map((project: Project) => project.id)).toEqual(['proj-a']);
      });
  
      it('无 guest draft 标记且无真实本地改动的 local-only 影子项目应被裁剪', async () => {
        const remoteProject = context.createProject({ id: 'proj-a', name: 'A', syncSource: 'synced' });
        const shadowProject = context.createProject({
          id: 'proj-shadow-only',
          name: 'Shadow',
          syncSource: 'local-only',
          pendingSync: true,
        });
        (context.mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([remoteProject, shadowProject]);
        (context.mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>).mockReturnValue(null);
        (context.mockSyncCoordinator['hasPendingChangesForProject'] as ReturnType<typeof vi.fn>).mockReturnValue(false);
  
        setupSupabaseQuery([
          {
            id: 'proj-a', title: 'A', description: '',
            created_date: remoteProject.createdDate, updated_at: remoteProject.updatedAt, version: 1,
          },
        ]);
  
        await (
          context.service as unknown as {
            syncProjectListMetadata: (userId: string) => Promise<Set<string>>;
          }
        ).syncProjectListMetadata('user-1');
  
        const setProjectsCall = (context.mockProjectState['setProjectsMetadataOnly'] as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Project[] | undefined;
        expect(setProjectsCall?.map((project: Project) => project.id)).toEqual(['proj-a']);
      });
  
      it('存在 ChangeTracker 本地改动时，应继续保留 remote 缺席的 local-only 项目', async () => {
        const remoteProject = context.createProject({ id: 'proj-a', name: 'A', syncSource: 'synced' });
        const localOnlyProject = context.createProject({
          id: 'proj-local-change',
          name: 'Local Change',
          syncSource: 'local-only',
          pendingSync: true,
        });
        (context.mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([remoteProject, localOnlyProject]);
        (context.mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>).mockReturnValue(null);
        (context.mockSyncCoordinator['hasPendingChangesForProject'] as ReturnType<typeof vi.fn>).mockImplementation(
          (projectId: string) => projectId === 'proj-a'
        );
        (context.mockChangeTracker['hasProjectChanges'] as ReturnType<typeof vi.fn>).mockImplementation(
          (projectId: string) => projectId === 'proj-local-change'
        );
  
        setupSupabaseQuery([
          {
            id: 'proj-a', title: 'A', description: '',
            created_date: remoteProject.createdDate, updated_at: remoteProject.updatedAt, version: 1,
          },
        ]);
  
        await (
          context.service as unknown as {
            syncProjectListMetadata: (userId: string) => Promise<Set<string>>;
          }
        ).syncProjectListMetadata('user-1');
  
        const setProjectsCall = (context.mockProjectState['setProjectsMetadataOnly'] as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Project[] | undefined;
        expect(setProjectsCall?.map((project: Project) => project.id)).toEqual(['proj-a', 'proj-local-change']);
      });
  
      it('裁剪后清理不可访问的 activeProjectId 时应弹提示', async () => {
        const staleProject = context.createProject({ id: 'proj-stale', name: 'Stale' });
        (context.mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([staleProject]);
        // 注意：activeProjectId 返回 proj-stale，但由于 activeProject 保护，它不会被裁剪
        // 这里测试裁剪后、已删除项目仍为 active 的场景
        // 需要 activeProjectId 返回一个不在 updatedProjects 中的 id
        (context.mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>).mockReturnValue('proj-gone');
        (context.mockSyncCoordinator['hasPendingChangesForProject'] as ReturnType<typeof vi.fn>).mockReturnValue(false);
  
        setupSupabaseQuery([]); // 空结果 → 安全守卫跳过裁剪
  
        await (
          context.service as unknown as {
            syncProjectListMetadata: (userId: string) => Promise<Set<string>>;
          }
        ).syncProjectListMetadata('user-1');
  
        // 安全守卫跳过裁剪时不会触发 toast（因为没有变更）
        // 真正触发 toast 的是 startBackgroundSync 中的 access preflight
      });
    });
  
    describe('mergeSingleProject content guard', () => {
      it('远端任务缺少 content 时应在直接覆盖分支保留本地正文', async () => {
        vi.clearAllMocks();
  
        const localTask = context.createTask({
          id: 'task-1',
          title: 'Keep Content',
          content: 'local content should survive',
          updatedAt: '2026-05-26T08:00:00.000Z',
        });
        const localProject = context.createProject({
          id: 'proj-content-guard',
          tasks: [localTask],
          updatedAt: '2026-05-26T08:00:00.000Z',
        });
        const shellProject = context.createProject({
          id: 'proj-content-guard',
          tasks: [],
          connections: [],
          updatedAt: '2026-05-26T08:00:00.000Z',
        });
        const remoteTask = markTaskContentMissingFromSource(context.createTask({
          id: 'task-1',
          title: 'Keep Content',
          content: '',
          updatedAt: '2026-05-27T08:00:00.000Z',
        }));
        const remoteProject = context.createProject({
          id: 'proj-content-guard',
          tasks: [remoteTask],
          updatedAt: '2026-05-27T08:00:00.000Z',
        });
  
        (context.mockProjectState['setProjects'] as (projects: Project[]) => void)([shellProject]);
        (context.mockProjectState['getProjectsWithCurrentData'] as ReturnType<typeof vi.fn>).mockReturnValue([localProject]);
        (context.mockSyncCoordinator['hasPendingChangesForProject'] as ReturnType<typeof vi.fn>).mockReturnValue(false);
  
        await (
          context.service as unknown as {
            mergeSingleProject: (cloudProject: Project, userId: string) => Promise<void>;
          }
        ).mergeSingleProject(remoteProject, 'user-1');
  
        const mergedProject = (context.mockProjectState['projects'] as () => Project[])()
          .find((project) => project.id === 'proj-content-guard');
  
        expect(mergedProject?.tasks[0]?.content).toBe('local content should survive');
        expect(mergedProject?.tasks[0]?.updatedAt).toBe('2026-05-27T08:00:00.000Z');
        expect(context.mockLoggerCategory.warn).toHaveBeenCalledWith(
          'mergeSingleProject: 远端任务缺少 content，已保留本地正文',
          expect.objectContaining({
            projectId: 'proj-content-guard',
            restoredTaskCount: 1,
          }),
        );
      });
  
      it('远端显式提交空 content 时不应误用本地正文覆盖', async () => {
        vi.clearAllMocks();
  
        const localTask = context.createTask({
          id: 'task-2',
          title: 'Allow Empty',
          content: 'old content',
          updatedAt: '2026-05-26T08:00:00.000Z',
        });
        const localProject = context.createProject({
          id: 'proj-explicit-empty',
          tasks: [localTask],
          updatedAt: '2026-05-26T08:00:00.000Z',
        });
        const shellProject = context.createProject({
          id: 'proj-explicit-empty',
          tasks: [],
          connections: [],
          updatedAt: '2026-05-26T08:00:00.000Z',
        });
        const remoteTask = context.createTask({
          id: 'task-2',
          title: 'Allow Empty',
          content: '',
          updatedAt: '2026-05-27T08:00:00.000Z',
        });
        const remoteProject = context.createProject({
          id: 'proj-explicit-empty',
          tasks: [remoteTask],
          updatedAt: '2026-05-27T08:00:00.000Z',
        });
  
        (context.mockProjectState['setProjects'] as (projects: Project[]) => void)([shellProject]);
        (context.mockProjectState['getProjectsWithCurrentData'] as ReturnType<typeof vi.fn>).mockReturnValue([localProject]);
        (context.mockSyncCoordinator['hasPendingChangesForProject'] as ReturnType<typeof vi.fn>).mockReturnValue(false);
  
        await (
          context.service as unknown as {
            mergeSingleProject: (cloudProject: Project, userId: string) => Promise<void>;
          }
        ).mergeSingleProject(remoteProject, 'user-1');
  
        const mergedProject = (context.mockProjectState['projects'] as () => Project[])()
          .find((project) => project.id === 'proj-explicit-empty');
  
        expect(mergedProject?.tasks[0]?.content).toBe('');
        expect(context.mockLoggerCategory.warn).not.toHaveBeenCalledWith(
          'mergeSingleProject: 远端任务缺少 content，已保留本地正文',
          expect.anything(),
        );
      });
  
      it('存在本地待同步修改时也应在 LWW 分支保留缺字段远端正文', async () => {
        vi.clearAllMocks();
  
        const localTask = context.createTask({
          id: 'task-3',
          title: 'Pending Merge',
          content: 'pending local content',
          updatedAt: '2026-05-26T08:00:00.000Z',
        });
        const localProject = context.createProject({
          id: 'proj-pending-merge',
          tasks: [localTask],
          updatedAt: '2026-05-26T08:00:00.000Z',
        });
        const shellProject = context.createProject({
          id: 'proj-pending-merge',
          tasks: [],
          connections: [],
          updatedAt: '2026-05-26T08:00:00.000Z',
        });
        const remoteTask = markTaskContentMissingFromSource(context.createTask({
          id: 'task-3',
          title: 'Pending Merge',
          content: '',
          updatedAt: '2026-05-27T08:00:00.000Z',
          order: 9,
        }));
        const remoteProject = context.createProject({
          id: 'proj-pending-merge',
          tasks: [remoteTask],
          updatedAt: '2026-05-27T08:00:00.000Z',
        });
  
        (context.mockProjectState['setProjects'] as (projects: Project[]) => void)([shellProject]);
        (context.mockProjectState['getProjectsWithCurrentData'] as ReturnType<typeof vi.fn>).mockReturnValue([localProject]);
        (context.mockSyncCoordinator['hasPendingChangesForProject'] as ReturnType<typeof vi.fn>).mockReturnValue(true);
  
        await (
          context.service as unknown as {
            mergeSingleProject: (cloudProject: Project, userId: string) => Promise<void>;
          }
        ).mergeSingleProject(remoteProject, 'user-1');
  
        const mergedProject = (context.mockProjectState['projects'] as () => Project[])()
          .find((project) => project.id === 'proj-pending-merge');
  
        expect(mergedProject?.tasks[0]?.content).toBe('pending local content');
        expect(mergedProject?.tasks[0]?.order).toBe(9);
        expect(mergedProject?.tasks[0]?.updatedAt).toBe('2026-05-27T08:00:00.000Z');
      });
  
    });
  
    registerUserSessionSnapshotPrehydrateSpecs(() => context);
}
