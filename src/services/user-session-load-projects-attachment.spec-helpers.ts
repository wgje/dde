import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AttachmentService } from './attachment.service';
import type { Project } from '../models';
import type { QueuedAction } from './action-queue.types';
import type { UserSessionServiceSpecContext } from './user-session.service.spec-context';

export function registerUserSessionLoadProjectsAndAttachmentSpecs(getContext: () => UserSessionServiceSpecContext): void {
  let context: UserSessionServiceSpecContext;

  beforeEach(() => {
    context = getContext();
  });

    describe('loadProjects 项目列表预同步', () => {
      it('首屏渲染后应先补齐缺失项目壳，而不是等待 idle 后台同步', async () => {
        vi.useFakeTimers();
        const originalRic = (window as Window & { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;

        Object.defineProperty(window, 'requestIdleCallback', {
          value: vi.fn(() => 1),
          configurable: true,
          writable: true,
        });

        context.userIdSignal.set('user-1');
        const localProject = context.createProject({
          id: 'proj-local',
          name: 'Local Project',
          syncSource: 'synced',
          tasks: [context.createTask({ id: 'task-local' })],
        });
        const remoteShellProject = context.createProject({
          id: 'proj-remote',
          name: 'Remote Project',
          syncSource: 'synced',
          pendingSync: false,
          tasks: [],
          connections: [],
        });

        (
          context.mockSyncCoordinator['core'] as {
            loadStartupOfflineSnapshot: ReturnType<typeof vi.fn>;
          }
        ).loadStartupOfflineSnapshot.mockResolvedValue({
          source: 'idb',
          projectCount: 1,
          bytes: 128,
          migratedLegacy: false,
          ownerUserId: 'user-1',
          projects: [localProject],
        });

        const syncProjectListMetadataSpy = vi.spyOn(
          context.service as unknown as {
            syncProjectListMetadata: (userId: string, sessionGuard?: unknown) => Promise<Set<string>>;
          },
          'syncProjectListMetadata'
        ).mockImplementation(async () => {
          (context.mockProjectState['setProjectsMetadataOnly'] as (projects: Project[]) => void)([
            localProject,
            remoteShellProject,
          ]);
          return new Set(['proj-local', 'proj-remote']);
        });

        const startBackgroundSyncSpy = vi.spyOn(
          context.service as unknown as {
            startBackgroundSync: (userId: string, previousActive: string | null, sessionGuard?: unknown) => Promise<void>;
          },
          'startBackgroundSync'
        ).mockResolvedValue(undefined);

        await context.service.loadProjects();
        await context.flushAsyncWork();

        expect(syncProjectListMetadataSpy).toHaveBeenCalledTimes(1);
        expect(startBackgroundSyncSpy).not.toHaveBeenCalled();

        const metadataOnlyCall = (context.mockProjectState['setProjectsMetadataOnly'] as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as Project[] | undefined;
        expect(metadataOnlyCall?.map((project: Project) => project.id)).toEqual(['proj-local', 'proj-remote']);

        Object.defineProperty(window, 'requestIdleCallback', {
          value: originalRic,
          configurable: true,
          writable: true,
        });
        vi.useRealTimers();
      });

      it('项目清单水位快路命中时不应提前重拉完整 metadata', async () => {
        vi.useFakeTimers();
        const originalRic = (window as Window & { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;

        Object.defineProperty(window, 'requestIdleCallback', {
          value: vi.fn(() => 1),
          configurable: true,
          writable: true,
        });

        context.userIdSignal.set('user-1');
        const localProject = context.createProject({
          id: 'proj-local',
          name: 'Local Project',
          syncSource: 'synced',
          tasks: [context.createTask({ id: 'task-local' })],
        });

        (
          context.mockSyncCoordinator['core'] as {
            loadStartupOfflineSnapshot: ReturnType<typeof vi.fn>;
          }
        ).loadStartupOfflineSnapshot.mockResolvedValue({
          source: 'idb',
          projectCount: 1,
          bytes: 128,
          migratedLegacy: false,
          ownerUserId: 'user-1',
          projects: [localProject],
        });
        (context.mockSyncCoordinator['refreshProjectManifestIfNeeded'] as ReturnType<typeof vi.fn>)
          .mockResolvedValueOnce({ skipped: true, watermark: '2026-05-27T01:00:00.000Z' });

        const syncProjectListMetadataSpy = vi.spyOn(
          context.service as unknown as {
            syncProjectListMetadata: (userId: string, sessionGuard?: unknown) => Promise<Set<string>>;
          },
          'syncProjectListMetadata'
        );
        const startBackgroundSyncSpy = vi.spyOn(
          context.service as unknown as {
            startBackgroundSync: (userId: string, previousActive: string | null, sessionGuard?: unknown) => Promise<void>;
          },
          'startBackgroundSync'
        ).mockResolvedValue(undefined);

        await context.service.loadProjects();
        await context.flushAsyncWork();

        expect(syncProjectListMetadataSpy).not.toHaveBeenCalled();
        expect(startBackgroundSyncSpy).not.toHaveBeenCalled();
        expect(context.service.canAuthoritativelyRejectProjectRoute()).toBe(true);
        expect(context.service.isProjectAuthoritativelyAccessible('proj-local')).toBe(true);

        Object.defineProperty(window, 'requestIdleCallback', {
          value: originalRic,
          configurable: true,
          writable: true,
        });
        vi.useRealTimers();
      });

      it('项目清单水位快路命中但本地目录为空时，应降级为 metadata sync', async () => {
        vi.useFakeTimers();
        const originalRic = (window as Window & { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;

        Object.defineProperty(window, 'requestIdleCallback', {
          value: vi.fn(() => 1),
          configurable: true,
          writable: true,
        });

        context.userIdSignal.set('user-1');
        (
          context.mockSyncCoordinator['core'] as {
            loadStartupOfflineSnapshot: ReturnType<typeof vi.fn>;
          }
        ).loadStartupOfflineSnapshot.mockResolvedValue({
          source: 'none',
          projectCount: 0,
          bytes: 0,
          migratedLegacy: false,
          ownerUserId: 'user-1',
          projects: [],
        });
        (context.mockSyncCoordinator['refreshProjectManifestIfNeeded'] as ReturnType<typeof vi.fn>)
          .mockResolvedValueOnce({ skipped: true, watermark: '2026-05-27T01:00:00.000Z' });

        const syncProjectListMetadataSpy = vi.spyOn(
          context.service as unknown as {
            syncProjectListMetadata: (userId: string, sessionGuard?: unknown) => Promise<Set<string>>;
          },
          'syncProjectListMetadata'
        ).mockResolvedValue(new Set(['proj-remote']));
        const startBackgroundSyncSpy = vi.spyOn(
          context.service as unknown as {
            startBackgroundSync: (userId: string, previousActive: string | null, sessionGuard?: unknown) => Promise<void>;
          },
          'startBackgroundSync'
        ).mockResolvedValue(undefined);

        await context.service.loadProjects();
        await context.flushAsyncWork();

        expect(syncProjectListMetadataSpy).toHaveBeenCalledTimes(1);
        expect(startBackgroundSyncSpy).not.toHaveBeenCalled();
        expect(context.service.canAuthoritativelyRejectProjectRoute()).toBe(false);

        Object.defineProperty(window, 'requestIdleCallback', {
          value: originalRic,
          configurable: true,
          writable: true,
        });
        vi.useRealTimers();
      });

      it('Supabase session 尚未切到当前用户时，不应在 prime fast path 提前建立 authoritative 状态', async () => {
        vi.useFakeTimers();
        const originalRic = (window as Window & { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;

        Object.defineProperty(window, 'requestIdleCallback', {
          value: vi.fn(() => 1),
          configurable: true,
          writable: true,
        });

        context.userIdSignal.set('user-1');
        context.mockSupabaseClientService.getSession.mockResolvedValue({
          data: { session: { user: { id: 'old-user' } } },
          error: null,
        });
        (
          context.mockSyncCoordinator['core'] as {
            loadStartupOfflineSnapshot: ReturnType<typeof vi.fn>;
          }
        ).loadStartupOfflineSnapshot.mockResolvedValue({
          source: 'idb',
          projectCount: 1,
          bytes: 128,
          migratedLegacy: false,
          ownerUserId: 'user-1',
          projects: [context.createProject({ id: 'proj-local', syncSource: 'synced' })],
        });

        const syncProjectListMetadataSpy = vi.spyOn(
          context.service as unknown as {
            syncProjectListMetadata: (userId: string, sessionGuard?: unknown, forceSnapshotPersist?: boolean) => Promise<Set<string>>;
          },
          'syncProjectListMetadata'
        );

        await context.service.loadProjects();
        await context.flushAsyncWork();

        expect(syncProjectListMetadataSpy).not.toHaveBeenCalled();
        expect(context.service.canAuthoritativelyRejectProjectRoute()).toBe(false);

        Object.defineProperty(window, 'requestIdleCallback', {
          value: originalRic,
          configurable: true,
          writable: true,
        });
        vi.useRealTimers();
      });

      it('启动渲染应叠加当前 owner 持久化的 project ActionQueue，避免刷新后未同步项目消失', async () => {
        vi.useFakeTimers();
        const originalRic = (window as Window & { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;

        Object.defineProperty(window, 'requestIdleCallback', {
          value: vi.fn(() => 1),
          configurable: true,
          writable: true,
        });

        context.userIdSignal.set('user-1');
        const snapshotProject = context.createProject({
          id: 'proj-snapshot',
          name: 'Snapshot Project',
          syncSource: 'synced',
        });
        const queuedProject = context.createProject({
          id: 'proj-queued-create',
          name: 'Queued Create',
          syncSource: 'synced',
          pendingSync: true,
        });
        const queuedTask = context.createTask({
          id: 'task-queued-create',
          title: 'Queued Task',
          content: 'Queued Task',
        });
        const queuedConnection = {
          id: 'connection-queued-create',
          source: snapshotProject.id,
          target: queuedTask.id,
          title: 'Queued Connection',
          updatedAt: '2026-06-28T00:00:00.000Z',
        };
        const queuedAction: QueuedAction = {
          id: 'action-project-create',
          operationId: 'op-project-create',
          type: 'create',
          entityType: 'project',
          entityId: queuedProject.id,
          payload: {
            project: queuedProject,
            sourceUserId: 'user-1',
          },
          timestamp: 2,
          localCommittedAt: 2,
          syncState: 'pending_sync',
          retryCount: 0,
          priority: 'critical',
        };
        const queuedTaskAction: QueuedAction = {
          id: 'action-task-create',
          operationId: 'op-task-create',
          type: 'create',
          entityType: 'task',
          entityId: queuedTask.id,
          payload: {
            task: queuedTask,
            projectId: queuedProject.id,
            sourceUserId: 'user-1',
          },
          timestamp: 3,
          localCommittedAt: 3,
          syncState: 'pending_sync',
          retryCount: 0,
        };
        const queuedConnectionAction: QueuedAction = {
          id: 'action-connection-create',
          operationId: 'op-connection-create',
          type: 'create',
          entityType: 'connection',
          entityId: queuedConnection.id,
          payload: {
            connection: queuedConnection,
            projectId: queuedProject.id,
            sourceUserId: 'user-1',
          },
          timestamp: 4,
          localCommittedAt: 4,
          syncState: 'pending_sync',
          retryCount: 0,
        };

        (
          context.mockSyncCoordinator['core'] as {
            loadStartupOfflineSnapshot: ReturnType<typeof vi.fn>;
          }
        ).loadStartupOfflineSnapshot.mockResolvedValue({
          source: 'idb',
          projectCount: 1,
          bytes: 128,
          migratedLegacy: false,
          ownerUserId: 'user-1',
          projects: [snapshotProject],
        });
        (
          (context.mockActionQueue['storage'] as Record<string, ReturnType<typeof vi.fn>>)
            ['loadQueueSnapshotForOwner']
        ).mockResolvedValue([queuedAction, queuedTaskAction, queuedConnectionAction]);
        vi.spyOn(
          context.service as unknown as {
            startBackgroundSync: (userId: string, previousActive: string | null, sessionGuard?: unknown) => Promise<void>;
          },
          'startBackgroundSync'
        ).mockResolvedValue(undefined);

        await context.service.loadProjects();
        await context.flushAsyncWork();

        expect(
          (context.mockActionQueue['storage'] as Record<string, ReturnType<typeof vi.fn>>)
            ['loadQueueSnapshotForOwner']
        ).toHaveBeenCalledWith('user-1');
        const renderedProjects = (context.mockProjectState['setProjects'] as ReturnType<typeof vi.fn>)
          .mock.calls.at(-1)?.[0] as Project[] | undefined;
        expect(renderedProjects?.map(project => project.id)).toEqual(['proj-snapshot', 'proj-queued-create']);
        expect(renderedProjects?.find(project => project.id === queuedProject.id)).toEqual(
          expect.objectContaining({
            name: 'Queued Create',
            pendingSync: true,
            tasks: [expect.objectContaining({ id: queuedTask.id, title: 'Queued Task' })],
            connections: [expect.objectContaining({ id: queuedConnection.id, source: snapshotProject.id, target: queuedTask.id })],
          }),
        );

        Object.defineProperty(window, 'requestIdleCallback', {
          value: originalRic,
          configurable: true,
          writable: true,
        });
        vi.useRealTimers();
      });
    });

    describe('Attachment 懒加载与降级', () => {
      it('项目无附件时不触发 AttachmentService 懒加载', async () => {
        context.userIdSignal.set('user-1');
        const spy = vi.spyOn(context.service, 'getAttachmentServiceLazy');

        const project = context.createProject({
          id: 'no-attachment',
          tasks: [context.createTask({ id: 'task-1', attachments: [] })],
        });

        await (
          context.service as unknown as {
            monitorProjectAttachments: (project: Project) => Promise<void>;
          }
        ).monitorProjectAttachments(project);

        expect(spy).not.toHaveBeenCalled();
        expect(context.mockAttachmentService['monitorAttachment']).not.toHaveBeenCalled();
      });

      it('项目有附件时仅初始化一次 AttachmentService（single-flight 缓存）', async () => {
        const inFlight = Promise.resolve(context.mockAttachmentService as unknown as AttachmentService);
        (context.service as unknown as { attachmentServicePromise: Promise<AttachmentService | null> | null })
          .attachmentServicePromise = inFlight;
        const first = context.service.getAttachmentServiceLazy();
        const second = context.service.getAttachmentServiceLazy();

        await expect(first).resolves.toBe(context.mockAttachmentService);
        await expect(second).resolves.toBe(context.mockAttachmentService);
        expect(
          (context.service as unknown as { attachmentServicePromise: Promise<AttachmentService | null> | null })
            .attachmentServicePromise
        ).toBe(inFlight);
      });

      it('项目有附件时会建立附件监控', async () => {
        context.userIdSignal.set('user-1');
        vi.spyOn(context.service, 'getAttachmentServiceLazy').mockResolvedValue(
          context.mockAttachmentService as unknown as AttachmentService
        );
        const project = context.createProject({
          id: 'with-attachment-monitor',
          tasks: [
            context.createTask({
              id: 'task-1',
              attachments: [context.createAttachment('00000000-0000-0000-0000-000000000001')],
            }),
          ],
        });

        await (
          context.service as unknown as {
            monitorProjectAttachments: (project: Project) => Promise<void>;
          }
        ).monitorProjectAttachments(project);

        expect(context.mockAttachmentService['clearMonitoredAttachments']).toHaveBeenCalled();
        expect(context.mockAttachmentService['monitorAttachment']).toHaveBeenCalledTimes(1);
      });

      it('懒加载失败时不抛异常且不阻断流程', async () => {
        context.userIdSignal.set('user-1');
        vi.spyOn(context.service, 'getAttachmentServiceLazy').mockResolvedValue(null);

        const project = context.createProject({
          id: 'with-attachment',
          tasks: [
            context.createTask({
              id: 'task-1',
              attachments: [context.createAttachment('00000000-0000-0000-0000-000000000001')],
            }),
          ],
        });

        await expect(
          (
            context.service as unknown as {
              monitorProjectAttachments: (project: Project) => Promise<void>;
            }
          ).monitorProjectAttachments(project)
        ).resolves.toBeUndefined();
      });

      it('销毁期间附件懒加载完成时应清理服务但不保留已销毁实例引用', async () => {
        const lazyLoad = context.service.getAttachmentServiceLazy();

        context.service.ngOnDestroy();
        await expect(lazyLoad).resolves.toBeNull();
        await context.flushAsyncWork();

        expect(context.mockAttachmentService['clearUrlRefreshCallback']).toHaveBeenCalledTimes(1);
        expect(context.mockAttachmentService['clearMonitoredAttachments']).toHaveBeenCalledTimes(1);
        await expect(context.service.getAttachmentServiceLazy()).resolves.toBeNull();
        expect(context.mockAttachmentService['clearUrlRefreshCallback']).toHaveBeenCalledTimes(1);
        expect(context.mockAttachmentService['clearMonitoredAttachments']).toHaveBeenCalledTimes(1);
      });
    });

}
