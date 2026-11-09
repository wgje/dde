import { describe, expect, it, vi } from 'vitest';
import type { Project, Task } from '../models';
import type { ChangeRecord } from './change-tracker.types';
import type {
  RemoteChangeHandlerService,
  RemoteProjectChangePayload,
  RemoteTaskChangePayload,
} from './remote-change-handler.service';

type SpyFn = ReturnType<typeof vi.fn>;

export interface RemoteChangeHandlerDurableDirtyProtectionSpecContext {
  service: () => RemoteChangeHandlerService;
  projectChangeCallback: () => (payload: RemoteProjectChangePayload) => Promise<void>;
  taskChangeCallback: () => (payload: Partial<RemoteTaskChangePayload>) => void;
  localProjects: () => Project[];
  setLocalProjects: (projects: Project[]) => void;
  projectState: () => { activeProjectId: SpyFn };
  syncCoordinator: () => {
    core: { loadSingleProject: SpyFn };
    getTombstoneIds: SpyFn;
    hasPendingChangesForProject: SpyFn;
    smartMerge: SpyFn;
  };
  taskSyncOps: () => { getTombstoneIdsWithStatus: SpyFn };
  actionQueue: () => { hasDurablePendingTaskMutation: SpyFn };
  changeTracker: () => { getPendingChange: SpyFn; pruneExpiredChanges: SpyFn };
}

export function registerRemoteChangeHandlerDurableDirtyProtectionSpecs(
  context: RemoteChangeHandlerDurableDirtyProtectionSpecContext,
): void {
  describe('durable dirty protection', () => {
    it('skips a project upsert before remote load while the captured owner has durable writes', async () => {
      const localProject = createProject({ version: 1 });
      context.setLocalProjects([localProject]);
      context.syncCoordinator().hasPendingChangesForProject.mockReturnValue(true);
      context.syncCoordinator().core.loadSingleProject.mockResolvedValue(
        createProject({ version: 2, name: 'Remote project' }),
      );

      context.service().setupCallbacks(vi.fn().mockResolvedValue(undefined));
      await context.projectChangeCallback()({ eventType: 'UPDATE', projectId: localProject.id });

      expect(context.syncCoordinator().hasPendingChangesForProject).toHaveBeenCalledWith(
        localProject.id,
        'user-123',
      );
      expect(context.syncCoordinator().core.loadSingleProject).not.toHaveBeenCalled();
      expect(context.localProjects()).toEqual([localProject]);
    });

    it('does not apply a remote project loaded after the owner queue becomes pending', async () => {
      const localProject = createProject({ version: 1 });
      const remoteProject = createProject({ version: 2, name: 'Remote project' });
      let resolveRemoteProject!: (project: Project) => void;
      const remoteProjectPromise = new Promise<Project>(resolve => {
        resolveRemoteProject = resolve;
      });
      context.setLocalProjects([localProject]);
      context.syncCoordinator().hasPendingChangesForProject
        .mockReturnValueOnce(false)
        .mockReturnValue(true);
      context.syncCoordinator().core.loadSingleProject.mockReturnValue(remoteProjectPromise);

      context.service().setupCallbacks(vi.fn().mockResolvedValue(undefined));
      const handling = context.projectChangeCallback()({ eventType: 'UPDATE', projectId: localProject.id });
      await Promise.resolve();
      resolveRemoteProject(remoteProject);
      await handling;

      expect(context.syncCoordinator().hasPendingChangesForProject).toHaveBeenCalledTimes(2);
      expect(context.taskSyncOps().getTombstoneIdsWithStatus).not.toHaveBeenCalled();
      expect(context.syncCoordinator().smartMerge).not.toHaveBeenCalled();
      expect(context.localProjects()).toEqual([localProject]);
    });

    it('does not merge a remote project when the owner queue becomes pending during tombstone load', async () => {
      const localProject = createProject({ version: 1 });
      const remoteProject = createProject({ version: 2, name: 'Remote project' });
      let queuePending = false;
      let resolveTombstones!: (result: ReturnType<typeof createTombstoneResult>) => void;
      const tombstonePromise = new Promise<ReturnType<typeof createTombstoneResult>>(resolve => {
        resolveTombstones = resolve;
      });
      context.setLocalProjects([localProject]);
      context.syncCoordinator().hasPendingChangesForProject.mockImplementation(() => queuePending);
      context.syncCoordinator().core.loadSingleProject.mockResolvedValue(remoteProject);
      context.taskSyncOps().getTombstoneIdsWithStatus.mockReturnValue(tombstonePromise);

      context.service().setupCallbacks(vi.fn().mockResolvedValue(undefined));
      const handling = context.projectChangeCallback()({ eventType: 'UPDATE', projectId: localProject.id });
      await vi.waitFor(() => {
        expect(context.taskSyncOps().getTombstoneIdsWithStatus).toHaveBeenCalledWith(localProject.id);
      });
      queuePending = true;
      resolveTombstones(createTombstoneResult());
      await handling;

      expect(context.syncCoordinator().hasPendingChangesForProject).toHaveBeenLastCalledWith(
        localProject.id,
        'user-123',
      );
      expect(context.syncCoordinator().smartMerge).not.toHaveBeenCalled();
      expect(context.localProjects()).toEqual([localProject]);
    });

    it('keeps an expired dirty field while the task mutation remains durable', async () => {
      const { localTask, remoteTask, project } = configureTaskUpdate(context);
      const pendingChange = createPendingChange(project.id, localTask);
      context.actionQueue().hasDurablePendingTaskMutation.mockReturnValue(true);
      context.changeTracker().getPendingChange.mockImplementation(
        (_projectId, _entityType, _entityId, maxAgeMs) => (
          maxAgeMs === Number.POSITIVE_INFINITY ? pendingChange : undefined
        ),
      );

      context.service().setupCallbacks(vi.fn().mockResolvedValue(undefined));
      context.taskChangeCallback()({ eventType: 'UPDATE', taskId: localTask.id, projectId: project.id });
      await flushPromises();

      expect(context.changeTracker().pruneExpiredChanges).toHaveBeenCalledWith(
        expect.any(Number), expect.any(Function),
      );
      const preserveExpired = context.changeTracker().pruneExpiredChanges.mock.calls[0][1];
      expect(preserveExpired(pendingChange)).toBe(true);
      expect(context.changeTracker().getPendingChange).toHaveBeenCalledWith(
        project.id, 'task', localTask.id, Number.POSITIVE_INFINITY,
      );
      expect(context.localProjects()[0].tasks[0]).toMatchObject({
        status: 'completed',
        updatedAt: remoteTask.updatedAt,
      });
    });

    it('uses the finite dirty window once no durable mutation remains', async () => {
      const { localTask, project } = configureTaskUpdate(context);
      context.changeTracker().getPendingChange.mockReturnValue(undefined);

      context.service().setupCallbacks(vi.fn().mockResolvedValue(undefined));
      context.taskChangeCallback()({ eventType: 'UPDATE', taskId: localTask.id, projectId: project.id });
      await flushPromises();

      const preserveExpired = context.changeTracker().pruneExpiredChanges.mock.calls[0][1];
      const maxAgeMs = context.changeTracker().getPendingChange.mock.calls[0][3];
      expect(preserveExpired(createPendingChange(project.id, localTask))).toBe(false);
      expect(maxAgeMs).not.toBe(Number.POSITIVE_INFINITY);
      expect(context.localProjects()[0].tasks[0].status).toBe('active');
    });
  });
}

function createTombstoneResult() {
  return {
    ids: new Set<string>(),
    deletedAtByTaskId: new Map<string, number>(),
    fromRemote: true,
    localCacheOnly: false,
    timestamp: Date.now(),
  };
}

function configureTaskUpdate(context: RemoteChangeHandlerDurableDirtyProtectionSpecContext): {
  localTask: Task;
  remoteTask: Task;
  project: Project;
} {
  const localTask = createTask({ status: 'completed', updatedAt: '2026-04-19T00:00:00.000Z' });
  const remoteTask = createTask({ status: 'active', updatedAt: '2026-04-19T00:05:00.000Z' });
  const project = createProject({ tasks: [localTask] });
  context.setLocalProjects([project]);
  context.projectState().activeProjectId.mockReturnValue(project.id);
  context.syncCoordinator().core.loadSingleProject.mockResolvedValue(createProject({ tasks: [remoteTask] }));
  context.syncCoordinator().getTombstoneIds.mockResolvedValue(new Set());
  return { localTask, remoteTask, project };
}

function createPendingChange(projectId: string, task: Task): ChangeRecord {
  return {
    entityId: task.id,
    entityType: 'task',
    changeType: 'update',
    projectId,
    timestamp: Date.now() - 60 * 60 * 1000,
    revision: 1,
    changedFields: ['status'],
    data: task,
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
    createdDate: overrides.createdDate ?? '2026-04-18T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-04-18T00:00:00.000Z',
    displayId: overrides.displayId ?? '1',
  };
}

function createProject(overrides: Partial<Project> = {}): Project {
  return {
    id: overrides.id ?? 'project-1',
    name: overrides.name ?? 'Project',
    description: overrides.description ?? '',
    createdDate: overrides.createdDate ?? '2026-04-18T00:00:00.000Z',
    version: overrides.version ?? 1,
    tasks: overrides.tasks ?? [],
    connections: overrides.connections ?? [],
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
