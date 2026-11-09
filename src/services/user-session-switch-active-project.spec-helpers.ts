import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WritableSignal } from '@angular/core';
import type { Project } from '../models';
import type { UserSessionServiceSpecContext } from './user-session.service.spec-context';

export function registerUserSessionSwitchActiveProjectSpecs(
  getContext: () => UserSessionServiceSpecContext,
): void {
  let context: UserSessionServiceSpecContext;

  beforeEach(() => {
    context = getContext();
  });

  describe('switchActiveProject', () => {
    it('切换活动项目', () => {
      const proj = context.createProject({ id: 'p1' });
      (context.mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>).mockReturnValue(null);
      (context.mockProjectState['getActiveProject'] as ReturnType<typeof vi.fn>).mockReturnValue(proj);

      context.service.switchActiveProject('p1');

      expect(context.mockProjectState['setActiveProjectId']).toHaveBeenCalledWith('p1');
    });

    it('同一项目 ID 幂等返回', () => {
      (context.mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>).mockReturnValue('p1');

      context.service.switchActiveProject('p1');

      expect(context.mockProjectState['setActiveProjectId']).not.toHaveBeenCalled();
    });

    it('切换项目时清理搜索状态并 flush 撤销', () => {
      (context.mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>).mockReturnValue('old');

      context.service.switchActiveProject('new');

      expect(context.mockUiState['clearSearch']).toHaveBeenCalled();
      expect(context.mockUndoService['flushPendingAction']).toHaveBeenCalled();
      expect(context.mockUndoService['onProjectSwitch']).toHaveBeenCalled();
    });

    it('切换到 null 清除附件监控', async () => {
      (context.mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>).mockReturnValue('p1');
      await context.service.getAttachmentServiceLazy();

      context.service.switchActiveProject(null);

      expect(context.mockAttachmentService['clearMonitoredAttachments']).toHaveBeenCalled();
    });

    it('旧会话中的按需加载结果不应回写到已清空的会话', async () => {
      context.userIdSignal.set('user-1');
      const shellProject = context.createProject({ id: 'shell-1', name: 'Shell', tasks: [] });
      const seedProjects = context.mockProjectState['setProjects'] as unknown as (projects: Project[]) => void;
      seedProjects([shellProject]);

      let resolveLoad: ((project: Project | null) => void) | undefined;
      (context.mockSyncCoordinator['loadSingleProjectFromCloud'] as ReturnType<typeof vi.fn>).mockReturnValueOnce(
        new Promise<Project | null>((resolve) => {
          resolveLoad = resolve;
        })
      );

      vi.clearAllMocks();

      context.service.switchActiveProject('shell-1');
      context.service.clearLocalData();

      resolveLoad?.(context.createProject({
        id: 'shell-1',
        name: 'Loaded After Clear',
        tasks: [context.createTask({ id: 'task-after-clear' })],
      }));
      await context.flushAsyncWork();

      expect(context.mockProjectState['setProjects']).not.toHaveBeenCalled();
      expect((context.mockSyncCoordinator['core'] as { saveOfflineSnapshot: ReturnType<typeof vi.fn> }).saveOfflineSnapshot)
        .not.toHaveBeenCalled();
    });

    it('按需加载返回 transient null 时应允许后续重试', async () => {
      context.userIdSignal.set('user-1');
      const shellProject = context.createProject({ id: 'shell-1', name: 'Shell', tasks: [] });
      const seedProjects = context.mockProjectState['setProjects'] as unknown as (projects: Project[]) => void;
      seedProjects([shellProject]);
      vi.clearAllMocks();

      (context.mockSyncCoordinator['loadSingleProjectFromCloud'] as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(context.createProject({
          id: 'shell-1',
          name: 'Loaded On Retry',
          tasks: [context.createTask({ id: 'task-retry' })],
        }));
      (context.mockSyncCoordinator['core'] as { getAccessibleProjectProbe: ReturnType<typeof vi.fn> }).getAccessibleProjectProbe
        .mockResolvedValueOnce(null);

      context.service.switchActiveProject('shell-1');
      await context.flushAsyncWork();

      context.service.switchActiveProject(null);
      context.service.switchActiveProject('shell-1');
      await context.flushAsyncWork();

      expect(context.mockSyncCoordinator['loadSingleProjectFromCloud']).toHaveBeenCalledTimes(2);
      expect(context.mockProjectState['setProjects']).toHaveBeenCalledWith([
        expect.objectContaining({ id: 'shell-1', name: 'Loaded On Retry' }),
      ]);
    });

    it('已选中的项目只有启动快照预览任务时仍应重新补水', async () => {
      context.userIdSignal.set('user-1');
      const previewProject = context.createProject({
        id: 'preview-blocked-project',
        name: 'test errors',
        syncSource: 'synced',
        tasks: [context.createSnapshotPreviewTask({ id: 'preview-task', title: 'stage1' })],
        connections: [],
      });
      const remoteProject = context.createProject({
        id: 'preview-blocked-project',
        name: 'test errors',
        syncSource: 'synced',
        tasks: [context.createTask({ id: 'remote-task', title: 'remote restored', content: 'full content' })],
        connections: [],
      });
      const seedProjects = context.mockProjectState['setProjects'] as unknown as (projects: Project[]) => void;
      const setActiveProjectId = context.mockProjectState['setActiveProjectId'] as unknown as (projectId: string | null) => void;
      seedProjects([previewProject]);
      setActiveProjectId('preview-blocked-project');
      vi.clearAllMocks();

      (context.mockSyncCoordinator['loadSingleProjectFromCloud'] as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(remoteProject);

      context.service.switchActiveProject('preview-blocked-project');
      await context.flushAsyncWork();

      expect(context.mockSyncCoordinator['loadSingleProjectFromCloud']).toHaveBeenCalledWith('preview-blocked-project');
      expect(context.mockProjectState['setProjects']).toHaveBeenCalledWith([
        expect.objectContaining({
          id: 'preview-blocked-project',
          tasks: [expect.objectContaining({ id: 'remote-task', content: 'full content' })],
        }),
      ]);
      expect(context.mockLoggerCategory.warn).toHaveBeenCalledWith(
        '检测到启动快照预览任务阻塞项目补水，改为拉取云端完整项目',
        expect.objectContaining({ projectId: 'preview-blocked-project', localTaskCount: 1 }),
      );
    });

    it('已选中的项目已有真实任务时不应重复拉取云端', async () => {
      context.userIdSignal.set('user-1');
      const hydratedProject = context.createProject({
        id: 'already-hydrated-project',
        name: 'Loaded Project',
        syncSource: 'synced',
        tasks: [context.createTask({ id: 'real-task', title: 'real', content: 'real content' })],
        connections: [],
      });
      const seedProjects = context.mockProjectState['setProjects'] as unknown as (projects: Project[]) => void;
      const setActiveProjectId = context.mockProjectState['setActiveProjectId'] as unknown as (projectId: string | null) => void;
      seedProjects([hydratedProject]);
      setActiveProjectId('already-hydrated-project');
      vi.clearAllMocks();

      context.service.switchActiveProject('already-hydrated-project');
      await context.flushAsyncWork();

      expect(context.mockSyncCoordinator['loadSingleProjectFromCloud']).not.toHaveBeenCalled();
      expect(context.mockProjectState['setProjects']).not.toHaveBeenCalled();
    });

    it('首次补水返回空项目时应复核一次并采用非空复核结果', async () => {
      context.userIdSignal.set('user-1');
      const shellProject = context.createProject({
        id: 'proj-empty-confirm',
        name: 'Metadata Shell',
        tasks: [],
        connections: [],
      });
      const localProject = context.createProject({
        id: 'proj-empty-confirm',
        name: 'Local Snapshot',
        tasks: [context.createTask({ id: 'task-local-confirm', content: 'keep me' })],
      });
      const seedProjects = context.mockProjectState['setProjects'] as unknown as (projects: Project[]) => void;
      seedProjects([shellProject]);
      (context.mockProjectState['getProjectsWithCurrentData'] as ReturnType<typeof vi.fn>).mockReturnValue([localProject]);
      vi.clearAllMocks();

      (context.mockSyncCoordinator['loadSingleProjectFromCloud'] as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(context.createProject({
          id: 'proj-empty-confirm',
          name: 'Remote Empty First',
          tasks: [],
          connections: [],
        }))
        .mockResolvedValueOnce(context.createProject({
          id: 'proj-empty-confirm',
          name: 'Remote Confirmed',
          tasks: [context.createTask({ id: 'task-remote-confirm', content: 'confirmed' })],
          connections: [],
        }));

      const loadResult = await (
        context.service as unknown as {
          loadProjectForHydration: (projectId: string) => Promise<{ status: string; project?: Project }>;
        }
      ).loadProjectForHydration('proj-empty-confirm');

      expect(context.mockSyncCoordinator['loadSingleProjectFromCloud']).toHaveBeenCalledTimes(2);
      expect(loadResult).toEqual({
        status: 'loaded',
        project: expect.objectContaining({
          id: 'proj-empty-confirm',
          name: 'Remote Confirmed',
          tasks: [expect.objectContaining({ id: 'task-remote-confirm', content: 'confirmed' })],
        }),
      });
      expect(context.mockLoggerCategory.warn).toHaveBeenCalledWith(
        '按需加载首次返回空图数据，正在复核远端结果',
        expect.objectContaining({
          projectId: 'proj-empty-confirm',
          localTaskCount: 1,
        }),
      );
    });

    it('首次补水为空且复核仍为空时，应接受权威空远端结果', async () => {
      context.userIdSignal.set('user-1');
      const shellProject = context.createProject({
        id: 'proj-empty-authoritative',
        name: 'Metadata Shell',
        tasks: [],
        connections: [],
      });
      const localProject = context.createProject({
        id: 'proj-empty-authoritative',
        name: 'Local Snapshot',
        tasks: [context.createTask({ id: 'task-local-authoritative', content: 'stale local' })],
      });
      const seedProjects = context.mockProjectState['setProjects'] as unknown as (projects: Project[]) => void;
      seedProjects([shellProject]);
      (context.mockProjectState['getProjectsWithCurrentData'] as ReturnType<typeof vi.fn>).mockReturnValue([localProject]);
      vi.clearAllMocks();

      const emptyRemoteProject = context.createProject({
        id: 'proj-empty-authoritative',
        name: 'Remote Empty Confirmed',
        tasks: [],
        connections: [],
      });

      (context.mockSyncCoordinator['loadSingleProjectFromCloud'] as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(emptyRemoteProject)
        .mockResolvedValueOnce(emptyRemoteProject);

      const loadResult = await (
        context.service as unknown as {
          loadProjectForHydration: (projectId: string) => Promise<{ status: string; project?: Project }>;
        }
      ).loadProjectForHydration('proj-empty-authoritative');

      expect(context.mockSyncCoordinator['loadSingleProjectFromCloud']).toHaveBeenCalledTimes(2);
      expect(loadResult).toEqual({
        status: 'loaded',
        project: expect.objectContaining({
          id: 'proj-empty-authoritative',
          name: 'Remote Empty Confirmed',
          tasks: [],
          connections: [],
        }),
      });
    });

    it('首次空补水复核前若会话失效，不应发起第二次远端读取', async () => {
      context.userIdSignal.set('user-1');
      const localProject = context.createProject({
        id: 'proj-empty-stale',
        name: 'Local Snapshot',
        tasks: [context.createTask({ id: 'task-local-stale', content: 'keep me' })],
      });
      const sessionGuard = (
        context.service as unknown as {
          captureCurrentSessionGuard: () => { userId: string | null; generation: number };
        }
      ).captureCurrentSessionGuard();

      (context.mockProjectState['getProjectsWithCurrentData'] as ReturnType<typeof vi.fn>).mockImplementation(() => {
        context.userIdSignal.set('user-2');
        return [localProject];
      });

      (context.mockSyncCoordinator['loadSingleProjectFromCloud'] as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(context.createProject({
          id: 'proj-empty-stale',
          name: 'Remote Empty First',
          tasks: [],
          connections: [],
        }))
        .mockResolvedValueOnce(context.createProject({
          id: 'proj-empty-stale',
          name: 'Should Not Be Requested',
          tasks: [context.createTask({ id: 'task-unexpected' })],
        }));

      const loadResult = await (
        context.service as unknown as {
          loadProjectForHydration: (
            projectId: string,
            sessionGuard?: { userId: string | null; generation: number },
          ) => Promise<{ status: string; project?: Project }>;
        }
      ).loadProjectForHydration('proj-empty-stale', sessionGuard);

      expect(context.mockSyncCoordinator['loadSingleProjectFromCloud']).toHaveBeenCalledTimes(1);
      expect(loadResult).toEqual({ status: 'stale' });
    });

    it('首次补水为空且复核返回 null 时，应保留后续重试且不合并空结果', async () => {
      context.userIdSignal.set('user-1');
      const shellProject = context.createProject({
        id: 'proj-empty-confirm-null',
        name: 'Metadata Shell',
        tasks: [],
        connections: [],
      });
      const localProject = context.createProject({
        id: 'proj-empty-confirm-null',
        name: 'Local Snapshot',
        tasks: [context.createTask({ id: 'task-local-confirm-null', content: 'keep me' })],
      });
      const seedProjects = context.mockProjectState['setProjects'] as unknown as (projects: Project[]) => void;
      seedProjects([shellProject]);
      (context.mockProjectState['getProjectsWithCurrentData'] as ReturnType<typeof vi.fn>).mockReturnValue([localProject]);
      vi.clearAllMocks();

      (context.mockSyncCoordinator['loadSingleProjectFromCloud'] as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(context.createProject({
          id: 'proj-empty-confirm-null',
          name: 'Remote Empty First',
          tasks: [],
          connections: [],
        }))
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(context.createProject({
          id: 'proj-empty-confirm-null',
          name: 'Loaded After Retry',
          tasks: [context.createTask({ id: 'task-loaded-after-retry', content: 'remote ok' })],
          connections: [],
        }));

      context.service.switchActiveProject('proj-empty-confirm-null');
      await context.flushAsyncWork();

      expect(context.mockSyncCoordinator['loadSingleProjectFromCloud']).toHaveBeenCalledTimes(2);
      expect(context.mockProjectState['setProjects']).not.toHaveBeenCalled();
      expect((context.mockSyncCoordinator['core'] as { saveOfflineSnapshot: ReturnType<typeof vi.fn> }).saveOfflineSnapshot)
        .not.toHaveBeenCalled();

      context.service.switchActiveProject(null);
      context.service.switchActiveProject('proj-empty-confirm-null');
      await context.flushAsyncWork();

      expect(context.mockSyncCoordinator['loadSingleProjectFromCloud']).toHaveBeenCalledTimes(3);
      expect(context.mockProjectState['setProjects']).toHaveBeenCalledWith([
        expect.objectContaining({
          id: 'proj-empty-confirm-null',
          name: 'Loaded After Retry',
          tasks: [expect.objectContaining({ id: 'task-loaded-after-retry', content: 'remote ok' })],
        }),
      ]);
    });

    it('按需加载确认不可访问后应停止当前会话内重复重试', async () => {
      context.userIdSignal.set('user-1');
      const shellProject = context.createProject({ id: 'shell-1', name: 'Shell', syncSource: 'synced', tasks: [] });
      const seedProjects = context.mockProjectState['setProjects'] as unknown as (projects: Project[]) => void;
      seedProjects([shellProject]);
      (
        context.service as unknown as { lastProjectListMetadataSyncSucceededState: WritableSignal<boolean> }
      ).lastProjectListMetadataSyncSucceededState.set(true);
      (
        context.service as unknown as { authoritativelyAccessibleProjectIdsState: WritableSignal<ReadonlySet<string>> }
      ).authoritativelyAccessibleProjectIdsState.set(new Set(['shell-1']));
      vi.clearAllMocks();

      (context.mockSyncCoordinator['loadSingleProjectFromCloud'] as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      (context.mockSyncCoordinator['core'] as { getAccessibleProjectProbe: ReturnType<typeof vi.fn> }).getAccessibleProjectProbe
        .mockResolvedValue({ projectId: 'shell-1', accessible: false, watermark: null });

      context.service.switchActiveProject('shell-1');
      await context.flushAsyncWork();

      context.service.switchActiveProject(null);
      context.service.switchActiveProject('shell-1');
      await context.flushAsyncWork();

      expect(context.mockSyncCoordinator['loadSingleProjectFromCloud']).toHaveBeenCalledTimes(1);
      expect((context.mockSyncCoordinator['core'] as { getAccessibleProjectProbe: ReturnType<typeof vi.fn> }).getAccessibleProjectProbe)
        .toHaveBeenCalledTimes(1);
      expect(context.mockProjectState['setProjects']).toHaveBeenCalledWith([]);
      expect((context.mockSyncCoordinator['core'] as { saveOfflineSnapshot: ReturnType<typeof vi.fn> }).saveOfflineSnapshot)
        .toHaveBeenCalledWith([], 'user-1');
      expect(context.service.isProjectAuthoritativelyAccessible('shell-1')).toBe(false);
    });

    it('切号后应清空旧补水中的 in-flight 标记，允许新会话重新补水', async () => {
      context.userIdSignal.set('user-1');
      const shellProject = context.createProject({ id: 'shell-1', name: 'Shell', tasks: [] });
      const seedProjects = context.mockProjectState['setProjects'] as unknown as (projects: Project[]) => void;
      seedProjects([shellProject]);

      let resolveFirstLoad: ((project: Project | null) => void) | undefined;
      (context.mockSyncCoordinator['loadSingleProjectFromCloud'] as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(new Promise<Project | null>((resolve) => {
          resolveFirstLoad = resolve;
        }))
        .mockResolvedValueOnce(context.createProject({
          id: 'shell-1',
          name: 'Loaded In New Session',
          tasks: [context.createTask({ id: 'task-new-session' })],
        }));

      vi.clearAllMocks();

      context.service.switchActiveProject('shell-1');
      await context.flushAsyncWork();

      await context.service.setCurrentUser('user-2', { forceLoad: true, skipPersistentReload: true });
      seedProjects([shellProject]);

      context.service.switchActiveProject('shell-1');
      await context.flushAsyncWork();

      expect(context.mockSyncCoordinator['loadSingleProjectFromCloud']).toHaveBeenCalledTimes(2);

      resolveFirstLoad?.(context.createProject({
        id: 'shell-1',
        name: 'Stale Project',
        tasks: [context.createTask({ id: 'task-stale' })],
      }));
      await context.flushAsyncWork();
    });

    it('旧会话补水完成时不应清掉新会话同项目的 in-flight 标记', async () => {
      context.userIdSignal.set('user-1');
      const shellProject = context.createProject({ id: 'shell-1', name: 'Shell', tasks: [] });
      const seedProjects = context.mockProjectState['setProjects'] as unknown as (projects: Project[]) => void;
      seedProjects([shellProject]);

      let resolveFirstLoad: ((project: Project | null) => void) | undefined;
      let resolveSecondLoad: ((project: Project | null) => void) | undefined;
      (context.mockSyncCoordinator['loadSingleProjectFromCloud'] as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(new Promise<Project | null>((resolve) => {
          resolveFirstLoad = resolve;
        }))
        .mockReturnValueOnce(new Promise<Project | null>((resolve) => {
          resolveSecondLoad = resolve;
        }));

      vi.clearAllMocks();

      context.service.switchActiveProject('shell-1');
      await context.flushAsyncWork();

      await context.service.setCurrentUser('user-2', { forceLoad: true, skipPersistentReload: true });
      seedProjects([shellProject]);

      context.service.switchActiveProject('shell-1');
      await context.flushAsyncWork();

      resolveFirstLoad?.(context.createProject({
        id: 'shell-1',
        name: 'Stale Project',
        tasks: [context.createTask({ id: 'task-stale-race' })],
      }));
      await context.flushAsyncWork();

      context.service.switchActiveProject(null);
      context.service.switchActiveProject('shell-1');
      await context.flushAsyncWork();

      expect(context.mockSyncCoordinator['loadSingleProjectFromCloud']).toHaveBeenCalledTimes(2);

      resolveSecondLoad?.(context.createProject({
        id: 'shell-1',
        name: 'Loaded In New Session',
        tasks: [context.createTask({ id: 'task-new-session-race' })],
      }));
      await context.flushAsyncWork();
    });
  });

}
