import { describe, expect, it, vi } from 'vitest';
import type { Project, Task } from '../models';
import type { RemoteChangeHandlerService, RemoteTaskChangePayload } from './remote-change-handler.service';

type SpyFn = ReturnType<typeof vi.fn>;
type TaskChangeCallback = (payload: Partial<RemoteTaskChangePayload>) => void;

export interface RemoteChangeHandlerTaskRequestRaceSpecContext {
  service: () => RemoteChangeHandlerService;
  taskChangeCallback: () => TaskChangeCallback;
  localProjects: () => Project[];
  setLocalProjects: (projects: Project[]) => void;
  setCurrentUserId: (userId: string) => void;
  setSessionGeneration: (generation: number) => void;
  projectState: () => { activeProjectId: SpyFn; updateProjects: SpyFn };
  syncCoordinator: () => {
    core: { loadSingleProject: SpyFn };
    getTombstoneIds: SpyFn;
  };
  logger: () => { debug: SpyFn };
  permissionDeniedHandler: () => { handlePermissionDenied: SpyFn };
  toast: () => { warning: SpyFn };
}

export function registerRemoteChangeHandlerTaskRequestRaceSpecs(
  context: RemoteChangeHandlerTaskRequestRaceSpecContext,
): void {
  describe('task update request isolation', () => {
    it('discards a remote result after the session owner changes', async () => {
      let resolveRemoteProject!: (project: Project) => void;
      const remoteProject = new Promise<Project | null>(resolve => {
        resolveRemoteProject = resolve;
      });
      context.setLocalProjects([createProject({
        id: 'project-1',
        tasks: [createTask({ id: 'task-1', title: 'Owner A local' })],
      })]);
      context.projectState().activeProjectId.mockReturnValue('project-1');
      context.syncCoordinator().core.loadSingleProject.mockReturnValueOnce(remoteProject);
      context.service().setupCallbacks(vi.fn().mockResolvedValue(undefined));

      context.taskChangeCallback()({
        eventType: 'UPDATE', taskId: 'task-1', projectId: 'project-1',
      });

      context.setCurrentUserId('user-456');
      context.setSessionGeneration(2);
      context.setLocalProjects([createProject({
        id: 'project-1',
        tasks: [createTask({ id: 'task-1', title: 'Owner B local' })],
      })]);
      resolveRemoteProject(createProject({
        id: 'project-1',
        tasks: [createTask({ id: 'task-1', title: 'Owner A remote' })],
      }));
      await flushPromises();
      await flushPromises();

      expect(context.localProjects()[0].tasks[0].title).toBe('Owner B local');
      expect(context.projectState().updateProjects).not.toHaveBeenCalled();
      expect(context.syncCoordinator().getTombstoneIds).not.toHaveBeenCalled();
    });

    it('discards a permission error after the session owner changes', async () => {
      let rejectRemoteLoad!: (reason?: unknown) => void;
      const remoteLoad = new Promise<Project | null>((_resolve, reject) => {
        rejectRemoteLoad = reject;
      });
      context.setLocalProjects([createProject({
        id: 'project-1',
        tasks: [createTask({ id: 'task-1', title: 'Owner A local' })],
      })]);
      context.projectState().activeProjectId.mockReturnValue('project-1');
      context.syncCoordinator().core.loadSingleProject.mockReturnValueOnce(remoteLoad);
      context.service().setupCallbacks(vi.fn().mockResolvedValue(undefined));

      context.taskChangeCallback()({
        eventType: 'UPDATE', taskId: 'task-1', projectId: 'project-1',
      });

      context.setCurrentUserId('user-456');
      context.setSessionGeneration(2);
      context.setLocalProjects([createProject({
        id: 'project-1',
        tasks: [createTask({ id: 'task-1', title: 'Owner B local' })],
      })]);
      rejectRemoteLoad({
        error: { code: '42501', message: 'permission denied for table tasks' },
        status: 401,
      });
      await flushPromises();
      await flushPromises();

      expect(context.permissionDeniedHandler().handlePermissionDenied).not.toHaveBeenCalled();
      expect(context.toast().warning).not.toHaveBeenCalled();
      expect(context.localProjects()[0].tasks[0].title).toBe('Owner B local');
    });

    it('tombstone 加载期间其他 task 的新请求不应取消当前任务更新', async () => {
      const resolveTombstones = configureTaskRequestRace(context);

      context.taskChangeCallback()({
        eventType: 'UPDATE', taskId: 'task-1', projectId: 'project-1',
      });
      await flushPromises();
      context.taskChangeCallback()({
        eventType: 'UPDATE', taskId: 'task-2', projectId: 'project-1',
      });
      resolveTombstones(new Set());
      await flushPromises();

      expect(context.localProjects()[0].tasks[0].title).toBe('Remote title');
      expect(context.logger().debug).not.toHaveBeenCalledWith(
        '远程任务更新已被更新请求取代',
        expect.objectContaining({ requestId: 1 }),
      );
    });

    it('同一 project/task 的新请求仍应使旧请求结果失效', async () => {
      const resolveTombstones = configureTaskRequestRace(context);

      context.taskChangeCallback()({
        eventType: 'UPDATE', taskId: 'task-1', projectId: 'project-1',
      });
      await flushPromises();
      context.taskChangeCallback()({
        eventType: 'UPDATE', taskId: 'task-1', projectId: 'project-1',
      });
      resolveTombstones(new Set());
      await flushPromises();

      expect(context.localProjects()[0].tasks[0].title).toBe('Local title');
      expect(context.logger().debug).toHaveBeenCalledWith(
        '远程任务更新已被更新请求取代',
        expect.objectContaining({ requestId: 1, currentId: 2 }),
      );
    });
  });
}

function configureTaskRequestRace(
  context: RemoteChangeHandlerTaskRequestRaceSpecContext,
): (ids: Set<string>) => void {
  let resolveTombstones: (ids: Set<string>) => void = () => undefined;
  context.setLocalProjects([createProject({
    id: 'project-1',
    tasks: [createTask({
      id: 'task-1', title: 'Local title', updatedAt: '2026-01-01T00:00:00.000Z',
    })],
  })]);
  context.projectState().activeProjectId.mockReturnValue('project-1');
  context.syncCoordinator().core.loadSingleProject
    .mockResolvedValueOnce(createProject({
      id: 'project-1',
      tasks: [createTask({
        id: 'task-1', title: 'Remote title', updatedAt: '2026-02-01T00:00:00.000Z',
      })],
    }))
    .mockImplementationOnce(() => new Promise<Project | null>(() => undefined));
  context.syncCoordinator().getTombstoneIds.mockImplementationOnce(() => (
    new Promise<Set<string>>(resolve => { resolveTombstones = resolve; })
  ));
  context.service().setupCallbacks(vi.fn().mockResolvedValue(undefined));
  return ids => resolveTombstones(ids);
}

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: overrides.id ?? 'task-1',
    title: overrides.title ?? 'Task',
    content: overrides.content ?? '',
    stage: overrides.stage ?? 1,
    parentId: overrides.parentId ?? null,
    order: overrides.order ?? 1,
    rank: overrides.rank ?? 1000,
    status: overrides.status ?? 'active',
    x: overrides.x ?? 0,
    y: overrides.y ?? 0,
    createdDate: overrides.createdDate ?? '2026-01-01T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-01-01T00:00:00.000Z',
    displayId: overrides.displayId ?? '?',
    deletedAt: overrides.deletedAt,
  };
}

function createProject(overrides: Partial<Project> = {}): Project {
  return {
    id: overrides.id ?? 'project-1',
    name: overrides.name ?? 'Project',
    description: overrides.description ?? '',
    createdDate: overrides.createdDate ?? '2026-01-01T00:00:00.000Z',
    updatedAt: overrides.updatedAt,
    version: overrides.version,
    tasks: overrides.tasks ?? [],
    connections: overrides.connections ?? [],
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
