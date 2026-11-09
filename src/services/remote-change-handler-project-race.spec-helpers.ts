import { describe, expect, it, vi } from 'vitest';
import type { TombstoneQueryResult } from '../app/core/services/sync/task-sync-operations.types';
import type { Connection, Project, Task } from '../models';
import type { RemoteChangeHandlerService } from './remote-change-handler.service';

type SpyFn = ReturnType<typeof vi.fn>;
type ProjectChangeCallback = (payload: { eventType?: string; projectId?: string } | undefined) => Promise<void>;

export interface RemoteChangeHandlerProjectRaceSpecContext {
  service: () => RemoteChangeHandlerService;
  projectChangeCallback: () => ProjectChangeCallback;
  localProjects: () => Project[];
  setLocalProjects: (projects: Project[]) => void;
  setCurrentUserId: (userId: string | null) => void;
  setSessionGeneration: (generation: number) => void;
  syncCoordinator: () => {
    core: { loadSingleProject: SpyFn };
    validateAndRebalance: SpyFn;
    smartMerge: SpyFn;
  };
  taskSyncOps: () => { getTombstoneIdsWithStatus: SpyFn };
  projectState: () => { updateProjects: SpyFn };
  undoService: () => { clearOutdatedHistory: SpyFn };
}

export function registerRemoteChangeHandlerProjectRaceSpecs(
  context: RemoteChangeHandlerProjectRaceSpecContext,
): void {
  describe('项目远程加载会话边界', () => {
    it('loadFullProject 在 owner 切换后返回旧项目时不应写入新会话本地状态', async () => {
      let resolveRemoteProject: (project: Project | null) => void = () => undefined;
      context.syncCoordinator().core.loadSingleProject.mockImplementationOnce(() => (
        new Promise<Project | null>(resolve => { resolveRemoteProject = resolve; })
      ));
      context.service().setupCallbacks(vi.fn().mockResolvedValue(undefined));

      const pendingUpdate = context.projectChangeCallback()({
        eventType: 'UPDATE',
        projectId: 'project-1',
      });
      await flushPromises();
      context.setCurrentUserId('user-456');
      context.setSessionGeneration(2);
      context.setLocalProjects([]);

      resolveRemoteProject(createProject({ id: 'project-1', version: 2 }));
      await pendingUpdate;

      expect(context.localProjects()).toEqual([]);
      expect(context.projectState().updateProjects).not.toHaveBeenCalled();
      expect(context.syncCoordinator().validateAndRebalance).not.toHaveBeenCalled();
    });

    it('tombstone 加载期间 session generation 变化时不应产生部分删除或最终 merge', async () => {
      let resolveTombstones: (result: TombstoneQueryResult) => void = () => undefined;
      context.setLocalProjects([createProject({
        id: 'project-1',
        version: 1,
        tasks: [createTask({ id: 'task-local' })],
        connections: [createConnection({ id: 'conn-local', source: 'task-local' })],
      })]);
      context.syncCoordinator().core.loadSingleProject.mockResolvedValueOnce(createProject({
        id: 'project-1',
        version: 2,
        tasks: [createTask({ id: 'task-local', deletedAt: '2026-02-01T00:00:00.000Z' })],
        connections: [createConnection({
          id: 'conn-local',
          source: 'task-local',
          deletedAt: '2026-02-01T00:00:00.000Z',
        })],
      }));
      context.taskSyncOps().getTombstoneIdsWithStatus.mockImplementationOnce(() => (
        new Promise<TombstoneQueryResult>(resolve => { resolveTombstones = resolve; })
      ));
      context.service().setupCallbacks(vi.fn().mockResolvedValue(undefined));

      const pendingUpdate = context.projectChangeCallback()({
        eventType: 'UPDATE',
        projectId: 'project-1',
      });
      await flushPromises();
      context.setSessionGeneration(2);
      resolveTombstones(emptyTombstoneResult());
      await pendingUpdate;

      expect(context.localProjects()[0].tasks.map(task => task.id)).toEqual(['task-local']);
      expect(context.localProjects()[0].connections.map(connection => connection.id)).toEqual(['conn-local']);
      expect(context.projectState().updateProjects).not.toHaveBeenCalled();
      expect(context.undoService().clearOutdatedHistory).not.toHaveBeenCalled();
      expect(context.syncCoordinator().smartMerge).not.toHaveBeenCalled();
    });

    it('tombstone 加载期间本地版本前进时不应以旧远端项目覆盖新本地状态', async () => {
      let resolveTombstones: (result: TombstoneQueryResult) => void = () => undefined;
      context.setLocalProjects([createProject({ id: 'project-1', version: 1, name: 'Local v1' })]);
      context.syncCoordinator().core.loadSingleProject.mockResolvedValueOnce(createProject({
        id: 'project-1',
        version: 2,
        name: 'Remote v2',
      }));
      context.taskSyncOps().getTombstoneIdsWithStatus.mockImplementationOnce(() => (
        new Promise<TombstoneQueryResult>(resolve => { resolveTombstones = resolve; })
      ));
      context.service().setupCallbacks(vi.fn().mockResolvedValue(undefined));

      const pendingUpdate = context.projectChangeCallback()({
        eventType: 'UPDATE',
        projectId: 'project-1',
      });
      await flushPromises();
      context.setLocalProjects([createProject({ id: 'project-1', version: 3, name: 'Local v3' })]);
      resolveTombstones(emptyTombstoneResult());
      await pendingUpdate;

      expect(context.localProjects()[0].version).toBe(3);
      expect(context.localProjects()[0].name).toBe('Local v3');
      expect(context.projectState().updateProjects).not.toHaveBeenCalled();
      expect(context.syncCoordinator().smartMerge).not.toHaveBeenCalled();
    });

    it('tombstone 加载期间同 ID connection 更新时不应被旧远端删除清除', async () => {
      let resolveTombstones: (result: TombstoneQueryResult) => void = () => undefined;
      const originalConnection = createConnection({ id: 'conn-local', target: 'task-old' });
      context.setLocalProjects([createProject({
        id: 'project-1',
        version: 1,
        connections: [originalConnection],
      })]);
      context.syncCoordinator().core.loadSingleProject.mockResolvedValueOnce(createProject({
        id: 'project-1',
        version: 2,
        connections: [createConnection({
          id: 'conn-local',
          target: 'task-old',
          deletedAt: '2026-02-01T00:00:00.000Z',
        })],
      }));
      context.taskSyncOps().getTombstoneIdsWithStatus.mockImplementationOnce(() => (
        new Promise<TombstoneQueryResult>(resolve => { resolveTombstones = resolve; })
      ));
      context.syncCoordinator().smartMerge.mockImplementationOnce((local: Project) => ({
        project: local,
        conflictCount: 0,
      }));
      context.service().setupCallbacks(vi.fn().mockResolvedValue(undefined));

      const pendingUpdate = context.projectChangeCallback()({
        eventType: 'UPDATE',
        projectId: 'project-1',
      });
      await flushPromises();
      context.setLocalProjects([createProject({
        id: 'project-1',
        version: 1,
        connections: [createConnection({ id: 'conn-local', target: 'task-new' })],
      })]);
      resolveTombstones(emptyTombstoneResult());
      await pendingUpdate;

      expect(context.syncCoordinator().smartMerge).toHaveBeenCalledWith(
        expect.objectContaining({
          connections: [expect.objectContaining({ id: 'conn-local', target: 'task-new' })],
        }),
        expect.anything(),
        expect.anything(),
      );
      expect(context.localProjects()[0].connections).toEqual([
        expect.objectContaining({ id: 'conn-local', target: 'task-new' }),
      ]);
    });

    it('tombstone 加载期间未变化的 connection 仍应按远端删除收敛', async () => {
      let resolveTombstones: (result: TombstoneQueryResult) => void = () => undefined;
      context.setLocalProjects([createProject({
        id: 'project-1',
        version: 1,
        connections: [createConnection({ id: 'conn-local' })],
      })]);
      context.syncCoordinator().core.loadSingleProject.mockResolvedValueOnce(createProject({
        id: 'project-1',
        version: 2,
        connections: [createConnection({
          id: 'conn-local',
          deletedAt: '2026-02-01T00:00:00.000Z',
        })],
      }));
      context.taskSyncOps().getTombstoneIdsWithStatus.mockImplementationOnce(() => (
        new Promise<TombstoneQueryResult>(resolve => { resolveTombstones = resolve; })
      ));
      context.syncCoordinator().smartMerge.mockImplementationOnce((local: Project) => ({
        project: local,
        conflictCount: 0,
      }));
      context.service().setupCallbacks(vi.fn().mockResolvedValue(undefined));

      const pendingUpdate = context.projectChangeCallback()({
        eventType: 'UPDATE',
        projectId: 'project-1',
      });
      await flushPromises();
      resolveTombstones(emptyTombstoneResult());
      await pendingUpdate;

      expect(context.syncCoordinator().smartMerge).toHaveBeenCalledWith(
        expect.objectContaining({ connections: [] }),
        expect.anything(),
        expect.anything(),
      );
      expect(context.localProjects()[0].connections).toEqual([]);
    });
  });
}

function emptyTombstoneResult(): TombstoneQueryResult {
  return {
    ids: new Set(),
    deletedAtByTaskId: new Map(),
    fromRemote: true,
    localCacheOnly: false,
    timestamp: Date.now(),
  };
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

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
