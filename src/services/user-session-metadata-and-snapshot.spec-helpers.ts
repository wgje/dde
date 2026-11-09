import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AUTH_CONFIG } from '../config/auth.config';
import type { Project } from '../models';
import { createBrowserNetworkSuspendedError } from '../utils/browser-network-suspension';
import { registerUserSessionMergeSingleProjectContentSpecs } from './user-session-merge-single-project-content.spec-helpers';
import { registerUserSessionMetadataLocalProjectRetentionSpecs } from './user-session-metadata-local-project-retention.spec-helpers';
import type { UserSessionServiceSpecContext } from './user-session.service.spec-context';
import { registerUserSessionSnapshotPrehydrateSpecs } from './user-session-snapshot-prehydrate.spec-helpers';

export function registerUserSessionMetadataAndSnapshotSpecs(getContext: () => UserSessionServiceSpecContext): void {
  let context: UserSessionServiceSpecContext;

  beforeEach(() => {
    context = getContext();
  });

    describe('syncProjectListMetadata', () => {
      /** 辅助：构建 Supabase client mock，返回指定的服务端项目列表 */
      function setupSupabaseQuery(
        serverProjects: Array<Record<string, unknown>>,
        moveFirstProjectAfterPage = false,
      ) {
        const paged = createPagedProjectListQuery(serverProjects, moveFirstProjectAfterPage);
        const from = vi.fn(() => paged.createQuery());
        context.mockSupabaseClientService.client.mockReturnValue({ from });
        context.mockSupabaseClientService.clientAsync.mockResolvedValue({ from });
        return paged;
      }

      function createPagedProjectListQuery(
        serverProjects: Array<Record<string, unknown>>,
        moveFirstProjectAfterPage: boolean,
      ) {
        const ranges: Array<[number, number]> = [];
        const limitCursors: Array<string | null> = [];
        let pageRequests = 0;
        const createQuery = () => {
          let cursor: { updatedAt: string; id: string } | null = null;
          let updatedAtAscending = true;
          const readPage = (from: number, to: number) => {
            const ordered = serverProjects
              .filter((row) => {
                if (!cursor) return true;
                const updatedAt = String(row['updated_at'] ?? '');
                const id = String(row['id'] ?? '');
                const updatedOrder = updatedAt.localeCompare(cursor.updatedAt);
                return updatedAtAscending
                  ? updatedOrder > 0 || updatedOrder === 0 && id > cursor.id
                  : updatedOrder < 0 || updatedOrder === 0 && id > cursor.id;
              })
              .slice()
              .sort((left, right) => {
                const updatedOrder = String(left['updated_at']).localeCompare(String(right['updated_at']));
                if (updatedOrder !== 0) return updatedAtAscending ? updatedOrder : -updatedOrder;
                return String(left['id']).localeCompare(String(right['id']));
              });
            const page = ordered.slice(from, to + 1).map(row => ({ ...row }));
            if (moveFirstProjectAfterPage && pageRequests++ === 0) {
              serverProjects[0] = {
                ...serverProjects[0],
                title: 'Project 0 moved',
                updated_at: '2026-06-09T03:00:00.000Z',
              };
            }
            return Promise.resolve({ data: page, error: null });
          };
          const query = {
            select: vi.fn(() => query),
            eq: vi.fn(() => query),
            is: vi.fn(() => query),
            or: vi.fn((filters: string) => {
              const match = /^updated_at\.gt\.(.*),and\(updated_at\.eq\.(.*),id\.gt\.(.*)\)$/.exec(filters);
              if (match) cursor = { updatedAt: match[2], id: match[3] };
              return query;
            }),
            order: vi.fn((column: string, options?: { ascending?: boolean }) => {
              if (column === 'updated_at') updatedAtAscending = options?.ascending !== false;
              return query;
            }),
            limit: vi.fn((count: number) => {
              limitCursors.push(cursor ? `${cursor.updatedAt}|${cursor.id}` : null);
              return readPage(0, count - 1);
            }),
            range: vi.fn((from: number, to: number) => {
              ranges.push([from, to]);
              return readPage(from, to);
            }),
          };
          return query;
        };
        return { createQuery, ranges, limitCursors };
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
          limit: vi.fn().mockResolvedValue({
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

      it('项目列表元数据应使用 keyset 加载并发移动后的全部项目', async () => {
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
        const paged = setupSupabaseQuery(serverProjects, true);

        const result = await (
          context.service as unknown as {
            syncProjectListMetadata: (userId: string) => Promise<Set<string>>;
          }
        ).syncProjectListMetadata('user-1');

        expect(result.size).toBe(1001);
        expect(result.has('proj-0000')).toBe(true);
        expect(result.has('proj-1000')).toBe(true);
        expect(paged.limitCursors).toHaveLength(2);
        expect(paged.ranges).toEqual([]);
        expect(context.mockProjectState['setProjectsMetadataOnly']).toHaveBeenCalledWith(
          expect.arrayContaining([expect.objectContaining({ id: 'proj-0000', name: 'Project 0 moved' })]),
        );
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

      it('未 hydration 的 metadata shell 落盘前应继承已有离线快照实体', async () => {
        const durableTask = context.createTask({
          id: 'task-durable',
          title: 'Durable task',
          content: 'must survive metadata sync',
        });
        const durableConnection = {
          id: 'connection-durable',
          source: durableTask.id,
          target: 'task-target',
          updatedAt: '2026-07-15T01:00:00.000Z',
        };
        const durableProject = context.createProject({
          id: 'proj-durable',
          name: 'Before metadata sync',
          tasks: [durableTask],
          connections: [durableConnection],
          syncSource: 'synced',
          updatedAt: '2026-07-15T01:00:00.000Z',
        });
        const unhydratedShell = {
          ...durableProject,
          tasks: [],
          connections: [],
        };
        (context.mockProjectState['setProjects'] as (projects: Project[]) => void)([unhydratedShell]);
        (context.mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>).mockReturnValue(null);

        const syncCore = context.mockSyncCoordinator['core'] as {
          loadStartupOfflineSnapshot: ReturnType<typeof vi.fn>;
          saveOfflineSnapshot: ReturnType<typeof vi.fn>;
        };
        syncCore.loadStartupOfflineSnapshot.mockResolvedValue({
          source: 'idb',
          projectCount: 1,
          bytes: 512,
          migratedLegacy: false,
          ownerUserId: 'user-1',
          projects: [durableProject],
        });
        syncCore.saveOfflineSnapshot.mockClear();

        setupSupabaseQuery([{
          id: durableProject.id,
          title: 'After metadata sync',
          description: durableProject.description,
          created_date: durableProject.createdDate,
          updated_at: '2026-07-15T02:00:00.000Z',
          version: 2,
          owner_id: 'user-1',
        }]);

        await (
          context.service as unknown as {
            syncProjectListMetadata: (userId: string) => Promise<Set<string>>;
          }
        ).syncProjectListMetadata('user-1');

        expect(syncCore.loadStartupOfflineSnapshot).toHaveBeenCalledWith({ ownerUserId: 'user-1' });
        expect(syncCore.saveOfflineSnapshot).toHaveBeenCalledWith([
          expect.objectContaining({
            id: durableProject.id,
            name: 'After metadata sync',
            tasks: [durableTask],
            connections: [durableConnection],
          }),
        ], 'user-1');
      });

      it('未 hydration 项目已有较新内存实体时应与旧快照做保守 LWW 并集', async () => {
        const previousTask = context.createTask({
          id: 'task-shared',
          title: 'Previous task',
          content: 'previous durable content',
          updatedAt: '2026-07-15T01:00:00.000Z',
        });
        const previousOnlyTask = context.createTask({
          id: 'task-previous-only',
          title: 'Previous only',
          content: 'must not disappear by absence',
          updatedAt: '2026-07-15T01:30:00.000Z',
        });
        const currentTask = context.createTask({
          id: 'task-shared',
          title: 'Current task',
          content: 'newer delta content',
          updatedAt: '2026-07-15T03:00:00.000Z',
        });
        const previousProject = context.createProject({
          id: 'proj-lww-snapshot',
          name: 'Before metadata sync',
          tasks: [previousTask, previousOnlyTask],
          syncSource: 'synced',
          updatedAt: '2026-07-15T02:00:00.000Z',
        });
        const currentUnhydratedProject = context.createProject({
          ...previousProject,
          tasks: [currentTask],
          connections: [],
        });
        (context.mockProjectState['setProjects'] as (projects: Project[]) => void)([currentUnhydratedProject]);
        (context.mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>).mockReturnValue(null);

        const syncCore = context.mockSyncCoordinator['core'] as {
          loadStartupOfflineSnapshot: ReturnType<typeof vi.fn>;
          saveOfflineSnapshot: ReturnType<typeof vi.fn>;
        };
        syncCore.loadStartupOfflineSnapshot.mockResolvedValue({
          source: 'idb',
          projectCount: 1,
          bytes: 768,
          migratedLegacy: false,
          ownerUserId: 'user-1',
          projects: [previousProject],
        });
        syncCore.saveOfflineSnapshot.mockClear();

        setupSupabaseQuery([{
          id: previousProject.id,
          title: 'After metadata sync',
          description: previousProject.description,
          created_date: previousProject.createdDate,
          updated_at: '2026-07-15T04:00:00.000Z',
          version: 2,
          owner_id: 'user-1',
        }]);

        await (
          context.service as unknown as {
            syncProjectListMetadata: (userId: string) => Promise<Set<string>>;
          }
        ).syncProjectListMetadata('user-1');

        const persistedProjects = syncCore.saveOfflineSnapshot.mock.calls.at(-1)?.[0] as Project[] | undefined;
        const persistedTasks = persistedProjects?.[0]?.tasks ?? [];
        expect(persistedTasks).toHaveLength(2);
        expect(persistedTasks).toEqual(expect.arrayContaining([
          expect.objectContaining({
            id: currentTask.id,
            content: 'newer delta content',
            updatedAt: '2026-07-15T03:00:00.000Z',
          }),
          expect.objectContaining({
            id: previousOnlyTask.id,
            content: 'must not disappear by absence',
          }),
        ]));
      });

      it('无已验证实体来源的新 metadata shell 不应落盘或推进 manifest 水位', async () => {
        (context.mockProjectState['setProjects'] as (projects: Project[]) => void)([]);
        (context.mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>).mockReturnValue(null);

        const syncCore = context.mockSyncCoordinator['core'] as {
          loadStartupOfflineSnapshot: ReturnType<typeof vi.fn>;
          saveOfflineSnapshot: ReturnType<typeof vi.fn>;
        };
        syncCore.loadStartupOfflineSnapshot.mockResolvedValue({
          source: 'none',
          projectCount: 0,
          bytes: 0,
          migratedLegacy: false,
          ownerUserId: 'user-1',
          projects: [],
        });
        syncCore.saveOfflineSnapshot.mockClear();
        (context.mockSyncCoordinator['commitProjectManifestWatermark'] as ReturnType<typeof vi.fn>).mockClear();

        setupSupabaseQuery([{
          id: 'proj-new-shell',
          title: 'Remote project',
          description: '',
          created_date: '2026-07-15T01:00:00.000Z',
          updated_at: '2026-07-15T02:00:00.000Z',
          version: 1,
          owner_id: 'user-1',
        }]);

        await (
          context.service as unknown as {
            syncProjectListMetadata: (userId: string) => Promise<Set<string>>;
          }
        ).syncProjectListMetadata('user-1');
        (
          context.service as unknown as {
            commitProjectListMetadataPrimeManifest: (
              userId: string,
              sessionGuard: undefined,
              pendingManifestWatermark: string,
            ) => void;
          }
        ).commitProjectListMetadataPrimeManifest('user-1', undefined, 'manifest-watermark-1');

        expect(syncCore.saveOfflineSnapshot).not.toHaveBeenCalled();
        expect(context.mockSyncCoordinator['commitProjectManifestWatermark']).not.toHaveBeenCalled();
      });

      it('旧快照同样为空时不应把未 hydration shell 猜成权威空项目', async () => {
        const emptyShell = context.createProject({
          id: 'proj-empty-unverified',
          name: 'Before metadata sync',
          tasks: [],
          connections: [],
          syncSource: 'synced',
        });
        (context.mockProjectState['setProjects'] as (projects: Project[]) => void)([emptyShell]);
        (context.mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>).mockReturnValue(null);

        const syncCore = context.mockSyncCoordinator['core'] as {
          loadStartupOfflineSnapshot: ReturnType<typeof vi.fn>;
          saveOfflineSnapshot: ReturnType<typeof vi.fn>;
        };
        syncCore.loadStartupOfflineSnapshot.mockResolvedValue({
          source: 'idb',
          projectCount: 1,
          bytes: 128,
          migratedLegacy: false,
          ownerUserId: 'user-1',
          projects: [emptyShell],
        });
        syncCore.saveOfflineSnapshot.mockClear();
        (context.mockSyncCoordinator['commitProjectManifestWatermark'] as ReturnType<typeof vi.fn>).mockClear();

        setupSupabaseQuery([{
          id: emptyShell.id,
          title: 'After metadata sync',
          description: '',
          created_date: emptyShell.createdDate,
          updated_at: '2026-07-15T04:00:00.000Z',
          version: 2,
          owner_id: 'user-1',
        }]);

        await (
          context.service as unknown as {
            syncProjectListMetadata: (userId: string) => Promise<Set<string>>;
          }
        ).syncProjectListMetadata('user-1');
        (
          context.service as unknown as {
            commitProjectListMetadataPrimeManifest: (
              userId: string,
              sessionGuard: undefined,
              pendingManifestWatermark: string,
            ) => void;
          }
        ).commitProjectListMetadataPrimeManifest('user-1', undefined, 'manifest-empty-project');

        expect(syncCore.saveOfflineSnapshot).not.toHaveBeenCalled();
        expect(context.mockSyncCoordinator['commitProjectManifestWatermark']).not.toHaveBeenCalled();
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

      registerUserSessionMetadataLocalProjectRetentionSpecs({
        getContext: () => context,
        setupSupabaseQuery,
      });
    });

    registerUserSessionMergeSingleProjectContentSpecs(() => context);
    registerUserSessionSnapshotPrehydrateSpecs(() => context);
}
