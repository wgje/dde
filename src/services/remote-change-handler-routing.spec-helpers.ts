import { describe, expect, it, vi } from 'vitest';
import type { Connection, Project, Task } from '../models';
import type {
  RemoteChangeHandlerService,
  RemoteProjectChangePayload,
  RemoteTaskChangePayload,
} from './remote-change-handler.service';

type SpyFn = ReturnType<typeof vi.fn>;
type ProjectChangeCallbackPayload = { eventType?: string; projectId?: string } | undefined;
type ProjectChangeCallback = (payload: ProjectChangeCallbackPayload) => Promise<void>;
type TaskChangeCallback = (payload: Partial<RemoteTaskChangePayload>) => void;

export interface RemoteChangeHandlerRoutingSpecContext {
  service: () => RemoteChangeHandlerService;
  projectChangeCallback: () => ProjectChangeCallback;
  taskChangeCallback: () => TaskChangeCallback | null;
  syncCoordinator: () => {
    setupRemoteChangeCallbacks: SpyFn;
    smartMerge: SpyFn;
    core: { loadSingleProject: SpyFn };
  };
  logger: () => { warn: SpyFn };
  actionQueue: () => { getPendingActionsForProject: SpyFn; hasPendingActions: SpyFn };
  localProjects: () => Project[];
  setLocalProjects: (projects: Project[]) => void;
}

export function registerRemoteChangeHandlerRoutingSpecs(
  context: RemoteChangeHandlerRoutingSpecContext,
): void {
  describe('setupCallbacks', () => {
    it('应正确设置回调', () => {
      const onLoadProjects = vi.fn().mockResolvedValue(undefined);

      context.service().setupCallbacks(onLoadProjects);

      expect(context.syncCoordinator().setupRemoteChangeCallbacks).toHaveBeenCalled();
      expect(context.projectChangeCallback()).toBeTruthy();
      expect(context.taskChangeCallback()).toBeTruthy();
    });

    it('重复调用应记录警告并跳过', () => {
      const onLoadProjects = vi.fn().mockResolvedValue(undefined);

      context.service().setupCallbacks(onLoadProjects);
      context.service().setupCallbacks(onLoadProjects);

      expect(context.logger().warn).toHaveBeenCalledWith(
        'setupCallbacks 已被调用过，跳过重复初始化'
      );
      // 只应调用一次
      expect(context.syncCoordinator().setupRemoteChangeCallbacks).toHaveBeenCalledTimes(1);
    });
  });

  describe('Polling 事件路由', () => {
    it('polling 事件应调用 onLoadProjects 而非 handleIncrementalUpdate', async () => {
      const onLoadProjects = vi.fn().mockResolvedValue(undefined);

      context.service().setupCallbacks(onLoadProjects);

      // 模拟 polling 事件
      const pollingPayload = { eventType: 'polling', projectId: 'project-1' };
      await context.projectChangeCallback()(pollingPayload);

      expect(onLoadProjects).toHaveBeenCalled();
      // 不应调用 loadSingleProject（handleIncrementalUpdate 的标志）
      expect(context.syncCoordinator().core.loadSingleProject).not.toHaveBeenCalled();
    });

    it('配置 onRefreshActiveProject 时应优先走活动项目静默刷新', async () => {
      const onLoadProjects = vi.fn().mockResolvedValue(undefined);
      const onRefreshActiveProject = vi.fn().mockResolvedValue(undefined);

      context.service().setupCallbacks({
        onLoadProjects,
        onRefreshActiveProject,
      });

      await context.projectChangeCallback()({ eventType: 'polling', projectId: 'project-1' });

      expect(onRefreshActiveProject).toHaveBeenCalledWith('remote:polling');
      expect(onLoadProjects).not.toHaveBeenCalled();
      expect(context.syncCoordinator().core.loadSingleProject).not.toHaveBeenCalled();
    });

    it('无 eventType 的事件应调用 onLoadProjects', async () => {
      const onLoadProjects = vi.fn().mockResolvedValue(undefined);

      context.service().setupCallbacks(onLoadProjects);

      // 模拟无 eventType 的事件
      const payload = { projectId: 'project-1' };
      await context.projectChangeCallback()(payload);

      expect(onLoadProjects).toHaveBeenCalled();
    });
  });

  describe('Realtime 事件路由', () => {
    it('INSERT 事件应调用 handleIncrementalUpdate', async () => {
      const onLoadProjects = vi.fn().mockResolvedValue(undefined);

      context.service().setupCallbacks(onLoadProjects);

      // 模拟 INSERT 事件
      const insertPayload: RemoteProjectChangePayload = {
        eventType: 'INSERT',
        projectId: 'project-1'
      };
      await context.projectChangeCallback()(insertPayload);

      // handleIncrementalUpdate 会调用 loadSingleProject
      expect(context.syncCoordinator().core.loadSingleProject).toHaveBeenCalledWith('project-1', 'user-123');
      // 不应调用 onLoadProjects
      expect(onLoadProjects).not.toHaveBeenCalled();
    });

    it('UPDATE 事件应调用 handleIncrementalUpdate', async () => {
      const onLoadProjects = vi.fn().mockResolvedValue(undefined);

      context.service().setupCallbacks(onLoadProjects);

      const updatePayload: RemoteProjectChangePayload = {
        eventType: 'UPDATE',
        projectId: 'project-1'
      };
      await context.projectChangeCallback()(updatePayload);

      expect(context.syncCoordinator().core.loadSingleProject).toHaveBeenCalled();
      expect(onLoadProjects).not.toHaveBeenCalled();
    });

    it('stale project UPDATE 不应在版本检查前应用远端删除集合', async () => {
      context.setLocalProjects([
        createProject({
          id: 'project-1',
          version: 5,
          tasks: [
            createTask({ id: 'task-still-local' }),
            createTask({ id: 'task-other' }),
          ],
          connections: [
            createConnection({
              id: 'conn-still-local',
              source: 'task-still-local',
              target: 'task-other',
            }),
          ],
        }),
      ]);
      context.syncCoordinator().core.loadSingleProject.mockResolvedValueOnce(createProject({
        id: 'project-1',
        version: 4,
        tasks: [
          createTask({
            id: 'task-still-local',
            deletedAt: '2026-02-01T00:00:00.000Z',
          }),
          createTask({ id: 'task-other' }),
        ],
        connections: [
          createConnection({
            id: 'conn-still-local',
            source: 'task-still-local',
            target: 'task-other',
            deletedAt: '2026-02-01T00:00:00.000Z',
          }),
        ],
      }));

      context.service().setupCallbacks(vi.fn().mockResolvedValue(undefined));

      await context.projectChangeCallback()({
        eventType: 'UPDATE',
        projectId: 'project-1',
      });

      expect(context.localProjects()[0].tasks.map(task => task.id)).toEqual([
        'task-still-local',
        'task-other',
      ]);
      expect(context.localProjects()[0].connections.map(connection => connection.id)).toEqual([
        'conn-still-local',
      ]);
      expect(context.syncCoordinator().smartMerge).not.toHaveBeenCalled();
    });

    it('DELETE 事件应调用 handleIncrementalUpdate', async () => {
      const onLoadProjects = vi.fn().mockResolvedValue(undefined);
      context.setLocalProjects([
        createProject({ id: 'project-1' }),
        createProject({ id: 'project-2' }),
      ]);

      context.service().setupCallbacks(onLoadProjects);

      const deletePayload: RemoteProjectChangePayload = {
        eventType: 'DELETE',
        projectId: 'project-1'
      };
      await context.projectChangeCallback()(deletePayload);

      // DELETE 事件不调用 loadSingleProject，而是直接从本地删除
      // 但也不应调用 onLoadProjects
      expect(context.localProjects().map(project => project.id)).toEqual(['project-2']);
      expect(context.actionQueue().getPendingActionsForProject).toHaveBeenCalledWith('project-1');
      expect(onLoadProjects).not.toHaveBeenCalled();
    });

    it('目标项目存在当前 owner 的 durable action 时不应应用远程 DELETE', async () => {
      context.setLocalProjects([createProject({ id: 'project-1' })]);
      context.actionQueue().getPendingActionsForProject.mockReturnValueOnce([{}]);
      context.service().setupCallbacks(vi.fn().mockResolvedValue(undefined));

      await context.projectChangeCallback()({
        eventType: 'DELETE',
        projectId: 'project-1',
      });

      expect(context.actionQueue().getPendingActionsForProject).toHaveBeenCalledWith('project-1');
      expect(context.localProjects().map(project => project.id)).toEqual(['project-1']);
    });

    it('仅其他项目存在 durable action 时不应阻断目标项目远程 DELETE', async () => {
      context.setLocalProjects([
        createProject({ id: 'project-1' }),
        createProject({ id: 'project-2' }),
      ]);
      context.actionQueue().hasPendingActions.mockReturnValueOnce(true);
      context.service().setupCallbacks(vi.fn().mockResolvedValue(undefined));

      await context.projectChangeCallback()({
        eventType: 'DELETE',
        projectId: 'project-1',
      });

      expect(context.actionQueue().getPendingActionsForProject).toHaveBeenCalledWith('project-1');
      expect(context.localProjects().map(project => project.id)).toEqual(['project-2']);
    });
  });
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

function createConnection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: overrides.id ?? 'conn-1',
    source: overrides.source ?? 'task-1',
    target: overrides.target ?? 'task-2',
    deletedAt: overrides.deletedAt,
    updatedAt: overrides.updatedAt,
  };
}
