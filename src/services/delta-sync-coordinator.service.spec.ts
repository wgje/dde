import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Injector, runInInjectionContext } from '@angular/core';
import { DeltaSyncCoordinatorService } from './delta-sync-coordinator.service';
import { ProjectSyncCursorService, ProjectDataService, RetryQueueService, TombstoneService } from '../core-bridge';
import { SYNC_CONFIG } from '../config';
import { ConflictDetectionService } from './conflict-detection.service';
import { ChangeTrackerService } from './change-tracker.service';
import { ProjectStateService } from './project-state.service';
import { LoggerService } from './logger.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { AuthService } from './auth.service';
import { ActionQueueService } from './action-queue.service';
import type {
  QueuedAction,
  RetryQueueSupersessionReservation,
  TaskPayload,
} from './action-queue.types';
import type { RetryQueueItem } from '../app/core/services/sync/retry-queue.types';
import { mockSentryLazyLoaderService } from '../test-setup.mocks';
import type { ChangeRecord } from './change-tracker.types';
import type { Connection, Project, Task } from '../models';
import { createBrowserNetworkSuspendedError } from '../utils/browser-network-suspension';

const mockLoggerCategory = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

const mockLoggerService = {
  category: vi.fn(() => mockLoggerCategory),
};

const mockSimpleSyncService = {
  checkForDrift: vi.fn(),
  saveOfflineSnapshotAndWait: vi.fn(),
  commitProjectSyncCursor: vi.fn(),
};

const mockConflictDetectionService = {
  mergeConnections: vi.fn((localConnections: Connection[], remoteConnections: Connection[]) => [
    ...localConnections,
    ...remoteConnections,
  ]),
};

const mockProjectStateService = {
  projects: vi.fn(),
  getProject: vi.fn(),
  getProjectWithCurrentData: vi.fn(),
  getProjectsWithCurrentData: vi.fn(),
  updateProjects: vi.fn(),
};

const mockChangeTrackerService = {
  getPendingChange: vi.fn(),
  getLockedFields: vi.fn(() => []),
};

const mockActionQueueService = {
  hasDurablePendingTaskMutation: vi.fn(() => false),
  getPendingActionsForProject: vi.fn((): QueuedAction[] => []),
  getProjectPendingWriteState: vi.fn((): 'pending' | 'clear' | 'unknown' => 'clear'),
};

const mockAuthService = {
  currentUserId: vi.fn(() => 'test-user'),
};

const mockRetryQueueService = {
  getOwnerItemsSnapshot: vi.fn<RetryQueueService['getOwnerItemsSnapshot']>(() => ({
    status: 'ready',
    items: [],
  })),
};

const mockTombstoneService = {
  getLocalTombstones: vi.fn(() => new Set<string>()),
  shouldRejectTaskUpsert: vi.fn(() => false),
};

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Task',
    content: 'Task content',
    stage: 1,
    parentId: null,
    order: 0,
    rank: 10000,
    status: 'active',
    x: 0,
    y: 0,
    createdDate: '2026-04-18T00:00:00.000Z',
    updatedAt: '2026-04-18T00:00:00.000Z',
    displayId: '1',
    shortId: 'aaaa',
    hasIncompleteTask: false,
    attachments: [],
    tags: [],
    ...overrides,
  };
}

function createProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-1',
    name: 'Project',
    description: '',
    tasks: [],
    connections: [],
    createdDate: '2026-04-18T00:00:00.000Z',
    version: 1,
    ...overrides,
  };
}

function createQueuedTaskMutation(
  task: Task,
  projectId: string,
  writeIntent?: TaskPayload['writeIntent'],
): QueuedAction<TaskPayload> {
  const payload: TaskPayload = {
    task,
    projectId,
    ...(writeIntent ? { writeIntent } : {}),
  };
  const now = Date.now();
  return {
    id: `action-${task.id}`,
    operationId: `operation-${task.id}`,
    type: 'update',
    entityType: 'task',
    entityId: task.id,
    payload,
    timestamp: now,
    localCommittedAt: now,
    syncState: 'pending_sync',
    retryCount: 0,
    priority: 'normal',
  };
}

describe('DeltaSyncCoordinatorService', () => {
  let service: DeltaSyncCoordinatorService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSimpleSyncService.saveOfflineSnapshotAndWait.mockResolvedValue(undefined);
    mockSimpleSyncService.commitProjectSyncCursor.mockResolvedValue(undefined);
    mockProjectStateService.projects.mockReturnValue([]);
    mockProjectStateService.getProjectWithCurrentData.mockImplementation(
      (projectId: string) => mockProjectStateService.getProject(projectId),
    );
    mockProjectStateService.getProjectsWithCurrentData.mockImplementation(
      () => mockProjectStateService.projects(),
    );
    mockActionQueueService.hasDurablePendingTaskMutation.mockReturnValue(false);
    mockActionQueueService.getPendingActionsForProject.mockReturnValue([]);
    mockActionQueueService.getProjectPendingWriteState.mockReturnValue('clear');
    mockAuthService.currentUserId.mockReturnValue('test-user');
    mockRetryQueueService.getOwnerItemsSnapshot.mockReturnValue({ status: 'ready', items: [] });

    const injector = Injector.create({
      providers: [
        DeltaSyncCoordinatorService,
        // 单一 mock 同时背书 ProjectSyncCursorService(checkForDrift + commitProjectSyncCursor)
        // 与 ProjectDataService(saveOfflineSnapshotAndWait)——原 SimpleSyncService 门面把两者转发为一。
        { provide: ProjectSyncCursorService, useValue: mockSimpleSyncService },
        { provide: ProjectDataService, useValue: mockSimpleSyncService },
        { provide: ConflictDetectionService, useValue: mockConflictDetectionService },
        { provide: ProjectStateService, useValue: mockProjectStateService },
        { provide: ChangeTrackerService, useValue: mockChangeTrackerService },
        { provide: ActionQueueService, useValue: mockActionQueueService },
        { provide: AuthService, useValue: mockAuthService },
        { provide: RetryQueueService, useValue: mockRetryQueueService },
        { provide: LoggerService, useValue: mockLoggerService },
        { provide: SentryLazyLoaderService, useValue: mockSentryLazyLoaderService },
        { provide: TombstoneService, useValue: mockTombstoneService },
      ],
    });

    service = runInInjectionContext(injector, () => injector.get(DeltaSyncCoordinatorService));
  });

  describe('hasProjectContentDifference', () => {
    it('should detect connection title or description changes with the same counts', () => {
      const project1 = createProject({
        connections: [{
          id: 'conn-1',
          source: 'task-a',
          target: 'task-b',
          title: '旧标题',
          description: '旧描述',
        }],
      });
      const project2 = createProject({
        connections: [{
          id: 'conn-1',
          source: 'task-a',
          target: 'task-b',
          title: '新标题',
          description: '新描述',
        }],
      });

      expect(service.hasProjectContentDifference(project1, project2)).toBe(true);
    });

    it('should not report a difference when connection content is unchanged', () => {
      const connections = [{
        id: 'conn-1',
        source: 'task-a',
        target: 'task-b',
        title: '标题',
        description: '描述',
        deletedAt: undefined,
      }];

      const project1 = createProject({ connections });
      const project2 = createProject({ connections: [{ ...connections[0] }] });

      expect(service.hasProjectContentDifference(project1, project2)).toBe(false);
    });
  });

  describe('performDeltaSync connection merge', () => {
    it('should defer browser network suspension without logging an error or reporting Sentry', async () => {
      mockSimpleSyncService.checkForDrift.mockRejectedValue(createBrowserNetworkSuspendedError());

      const result = await service.performDeltaSync('project-1');

      expect(result).toEqual({ taskChanges: 0, connectionChanges: 0 });
      expect(mockLoggerCategory.error).not.toHaveBeenCalled();
      expect(mockSentryLazyLoaderService.captureException).not.toHaveBeenCalled();
    });

    it('should preserve authoritative TaskStore tasks during a connection-only delta', async () => {
      const staleShell = createProject({
        tasks: [createTask({
          id: 'task-1',
          stage: null,
          rank: 0,
        })],
      });
      const currentProject = createProject({
        tasks: [
          createTask({
            id: 'task-1',
            stage: 2,
            rank: 2000,
            updatedAt: '2026-04-19T00:01:00.000Z',
          }),
          createTask({
            id: 'task-2',
            stage: 3,
            rank: 3000,
            updatedAt: '2026-04-19T00:02:00.000Z',
          }),
        ],
      });
      const remoteConnection: Connection = {
        id: 'conn-1',
        source: 'task-1',
        target: 'task-2',
        updatedAt: '2026-04-19T00:03:00.000Z',
      };

      mockProjectStateService.getProject.mockReturnValue(staleShell);
      mockProjectStateService.getProjectWithCurrentData.mockReturnValue(currentProject);
      mockSimpleSyncService.checkForDrift.mockResolvedValue({
        tasks: [],
        connections: [remoteConnection],
        nextCursor: null,
      });
      mockConflictDetectionService.mergeConnections.mockReturnValue([remoteConnection]);

      await service.performDeltaSync(currentProject.id);

      const updater = mockProjectStateService.updateProjects.mock.calls[0]?.[0] as
        | ((projects: Project[]) => Project[])
        | undefined;
      expect(updater).toBeDefined();
      const [updatedProject] = updater!([currentProject]);
      expect(updatedProject.tasks.map(task => task.id).sort()).toEqual(['task-1', 'task-2']);
      expect(updatedProject.tasks).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'task-1', stage: 2, rank: 2000 }),
        expect.objectContaining({ id: 'task-2', stage: 3, rank: 3000 }),
      ]));
      expect(mockProjectStateService.getProjectWithCurrentData).toHaveBeenCalledWith(currentProject.id);
    });

    it('should persist merged state before committing the returned cursor candidate', async () => {
      const currentProject = createProject({
        updatedAt: '2026-04-19T00:00:00.000Z',
        tasks: [createTask({ id: 'task-local', updatedAt: '2026-04-19T00:00:00.000Z' })],
      });
      const remoteTask = createTask({
        id: 'task-remote',
        updatedAt: '2026-04-19T00:01:00.000Z',
      });

      mockProjectStateService.getProject.mockReturnValue(currentProject);
      mockProjectStateService.projects.mockReturnValue([currentProject]);
      mockSimpleSyncService.checkForDrift.mockResolvedValue({
        tasks: [remoteTask],
        connections: [],
        nextCursor: {
          updatedAt: '2026-04-19T00:01:00.000Z',
          entityType: 'task',
          id: 'task-remote',
        },
      });
      const calls: string[] = [];
      mockProjectStateService.updateProjects.mockImplementation((updater: (projects: Project[]) => Project[]) => {
        const updated = updater([currentProject]);
        mockProjectStateService.projects.mockReturnValue(updated);
        calls.push('merge');
      });
      mockSimpleSyncService.saveOfflineSnapshotAndWait.mockImplementation(async () => {
        calls.push('persist');
      });
      mockSimpleSyncService.commitProjectSyncCursor.mockImplementation(() => {
        calls.push('commit');
      });

      const result = await service.performDeltaSync('project-1');

      expect(result).toEqual({ taskChanges: 1, connectionChanges: 0 });
      expect(mockSimpleSyncService.saveOfflineSnapshotAndWait).toHaveBeenCalledWith([
        expect.objectContaining({
          id: 'project-1',
          tasks: expect.arrayContaining([expect.objectContaining({ id: 'task-remote' })]),
        }),
      ]);
      expect(mockSimpleSyncService.commitProjectSyncCursor).toHaveBeenCalledWith('project-1', {
        updatedAt: '2026-04-19T00:01:00.000Z',
        entityType: 'task',
        id: 'task-remote',
      });
      expect(calls).toEqual(['merge', 'persist', 'commit']);
    });

    it('should retain persisted project and cursor state when snapshot persistence fails', async () => {
      const localTask = createTask({ id: 'task-local' });
      const currentProject = createProject({ tasks: [localTask] });
      const remoteTask = createTask({
        id: 'task-remote',
        updatedAt: '2026-04-19T00:01:00.000Z',
      });
      const nextCursor = {
        updatedAt: remoteTask.updatedAt!,
        entityType: 'task' as const,
        id: remoteTask.id,
      };
      let authoritativeProjects = [currentProject];
      let attemptedSnapshot: Project[] | null = null;
      const persistedState = {
        projects: [currentProject],
        cursor: { updatedAt: '2026-04-18T23:59:00.000Z', entityType: 'task', id: 'task-before' },
      };
      const persistedStateBefore = JSON.stringify(persistedState);
      const snapshotWriteOutcomes: Array<'failed' | 'saved'> = ['failed'];

      mockProjectStateService.getProjectWithCurrentData.mockReturnValue(currentProject);
      mockProjectStateService.getProjectsWithCurrentData.mockImplementation(() => authoritativeProjects);
      mockProjectStateService.updateProjects.mockImplementation((updater: (projects: Project[]) => Project[]) => {
        authoritativeProjects = updater(authoritativeProjects);
      });
      mockSimpleSyncService.checkForDrift.mockResolvedValue({
        tasks: [remoteTask],
        connections: [],
        nextCursor,
      });
      mockSimpleSyncService.saveOfflineSnapshotAndWait.mockImplementation(async (projects: Project[]) => {
        attemptedSnapshot = projects;
        if (snapshotWriteOutcomes.shift() === 'failed') {
          throw new Error('both offline snapshot mirrors failed');
        }
        persistedState.projects = projects;
      });
      mockSimpleSyncService.commitProjectSyncCursor.mockImplementation(async (_projectId: string, cursor: unknown) => {
        persistedState.cursor = cursor as typeof persistedState.cursor;
      });

      const result = await service.performDeltaSync(currentProject.id);

      expect(result).toEqual({ taskChanges: 0, connectionChanges: 0 });
      expect(attemptedSnapshot).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: currentProject.id,
          tasks: expect.arrayContaining([
            expect.objectContaining({ id: 'task-local' }),
            expect.objectContaining({ id: 'task-remote' }),
          ]),
        }),
      ]));
      expect(authoritativeProjects[0].tasks.map(task => task.id).sort()).toEqual([
        'task-local',
        'task-remote',
      ]);
      expect(JSON.stringify(persistedState)).toBe(persistedStateBefore);
      expect(mockSimpleSyncService.commitProjectSyncCursor).not.toHaveBeenCalled();
    });

    it('should persist authoritative sibling project data before committing the cursor', async () => {
      const currentProject = createProject({
        id: 'project-1',
        tasks: [createTask({ id: 'task-local' })],
      });
      const staleSiblingShell = createProject({
        id: 'project-2',
        tasks: [createTask({ id: 'sibling-task-1', stage: null, rank: 0 })],
      });
      const currentSibling = createProject({
        id: 'project-2',
        tasks: [
          createTask({ id: 'sibling-task-1', stage: 2, rank: 2000 }),
          createTask({ id: 'sibling-task-2', stage: 3, rank: 3000 }),
        ],
      });
      const remoteTask = createTask({
        id: 'task-remote',
        updatedAt: '2026-04-19T00:01:00.000Z',
      });
      let authoritativeProjects = [currentProject, currentSibling];

      mockProjectStateService.getProjectWithCurrentData.mockReturnValue(currentProject);
      mockProjectStateService.projects.mockReturnValue([currentProject, staleSiblingShell]);
      mockProjectStateService.getProjectsWithCurrentData.mockImplementation(() => authoritativeProjects);
      mockProjectStateService.updateProjects.mockImplementation((updater: (projects: Project[]) => Project[]) => {
        authoritativeProjects = updater(authoritativeProjects);
      });
      mockSimpleSyncService.checkForDrift.mockResolvedValue({
        tasks: [remoteTask],
        connections: [],
        nextCursor: {
          updatedAt: remoteTask.updatedAt!,
          entityType: 'task',
          id: remoteTask.id,
        },
      });

      await service.performDeltaSync(currentProject.id);

      expect(mockSimpleSyncService.saveOfflineSnapshotAndWait).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'project-2',
            tasks: expect.arrayContaining([
              expect.objectContaining({ id: 'sibling-task-1', stage: 2, rank: 2000 }),
              expect.objectContaining({ id: 'sibling-task-2', stage: 3, rank: 3000 }),
            ]),
          }),
        ]),
      );
    });

    it('should preserve local attentionMeta when it is pending during delta merge', async () => {
      const localAttentionMeta: Task['attentionMeta'] = {
        items: [{
          id: 'attention-local',
          text: '本地僚机',
          level: 'warning',
          done: false,
          createdAt: '2026-06-05T00:00:00.000Z',
          updatedAt: '2026-06-05T00:00:00.000Z',
        }],
        updatedAt: '2026-06-05T00:00:00.000Z',
      };
      const remoteAttentionMeta: Task['attentionMeta'] = {
        items: [{
          id: 'attention-remote',
          text: '远端僚机',
          level: 'info',
          done: false,
          createdAt: '2026-06-05T00:00:00.000Z',
          updatedAt: '2026-06-05T00:01:00.000Z',
        }],
        updatedAt: '2026-06-05T00:01:00.000Z',
      };
      const localTask = createTask({
        id: 'task-1',
        title: 'Local',
        attentionMeta: localAttentionMeta,
        updatedAt: '2026-06-05T00:00:00.000Z',
      });
      const remoteTask = createTask({
        id: 'task-1',
        title: 'Remote',
        attentionMeta: remoteAttentionMeta,
        updatedAt: '2026-06-05T00:01:00.000Z',
      });
      const currentProject = createProject({
        tasks: [localTask],
      });
      mockProjectStateService.getProject.mockReturnValue(currentProject);
      mockProjectStateService.projects.mockReturnValue([currentProject]);
      mockChangeTrackerService.getPendingChange.mockReturnValue({
        entityId: 'task-1',
        entityType: 'task',
        changeType: 'update',
        projectId: 'project-1',
        timestamp: Date.now(),
        changedFields: ['attentionMeta'],
        data: localTask,
      } satisfies ChangeRecord);
      mockSimpleSyncService.checkForDrift.mockResolvedValue({
        tasks: [remoteTask],
        connections: [],
        nextCursor: null,
      });

      await service.performDeltaSync('project-1');

      const updater = mockProjectStateService.updateProjects.mock.calls[0]?.[0] as
        | ((projects: Project[]) => Project[])
        | undefined;
      expect(updater).toBeDefined();
      const [mergedProject] = updater!([currentProject]);
      expect(mergedProject.tasks[0].attentionMeta).toEqual(localAttentionMeta);
      expect(mergedProject.tasks[0].title).toBe('Remote');
    });

    it('should reuse connection LWW merge instead of raw replacement', async () => {
      const currentProject = createProject({
        updatedAt: '2026-04-19T00:00:00.000Z',
        connections: [{
          id: 'conn-1',
          source: 'task-a',
          target: 'task-b',
          title: '本地标题',
          description: '本地描述',
          updatedAt: '2026-04-19T00:00:00.000Z',
        }],
      });
      const mergedConnections: Connection[] = [{
        id: 'conn-1',
        source: 'task-a',
        target: 'task-b',
        title: '本地标题',
        description: '本地描述',
        updatedAt: '2026-04-19T00:00:00.000Z',
      }];

      mockProjectStateService.getProject.mockReturnValue(currentProject);
      mockSimpleSyncService.checkForDrift.mockResolvedValue({
        tasks: [],
        connections: [{
          id: 'conn-1',
          source: 'task-a',
          target: 'task-b',
          updatedAt: '2026-04-19T00:00:00.000Z',
        }],
      });
      mockConflictDetectionService.mergeConnections.mockReturnValue(mergedConnections);

      await service.performDeltaSync('project-1');

      expect(mockConflictDetectionService.mergeConnections).toHaveBeenCalledWith(
        currentProject.connections,
        [{
          id: 'conn-1',
          source: 'task-a',
          target: 'task-b',
          updatedAt: '2026-04-19T00:00:00.000Z',
        }]
      );

      const updater = mockProjectStateService.updateProjects.mock.calls[0][0] as (projects: Project[]) => Project[];
      const [updatedProject] = updater([currentProject]);
      expect(updatedProject.connections).toEqual(mergedConnections);
    });

    it('should keep deleted connection tombstones in project state', async () => {
      const currentProject = createProject({
        updatedAt: '2026-04-19T00:00:00.000Z',
        connections: [{
          id: 'conn-1',
          source: 'task-a',
          target: 'task-b',
          updatedAt: '2026-04-19T00:00:00.000Z',
        }],
      });
      const deletedConnections: Connection[] = [{
        id: 'conn-1',
        source: 'task-a',
        target: 'task-b',
        deletedAt: '2026-04-19T00:01:00.000Z',
        updatedAt: '2026-04-19T00:01:00.000Z',
      }];

      mockProjectStateService.getProject.mockReturnValue(currentProject);
      mockSimpleSyncService.checkForDrift.mockResolvedValue({
        tasks: [],
        connections: deletedConnections,
      });
      mockConflictDetectionService.mergeConnections.mockReturnValue(deletedConnections);

      await service.performDeltaSync('project-1');

      const updater = mockProjectStateService.updateProjects.mock.calls[0][0] as (projects: Project[]) => Project[];
      const [updatedProject] = updater([currentProject]);
      expect(updatedProject.connections).toEqual(deletedConnections);
    });
  });

  describe('performDeltaSync task merge', () => {
    it('should preserve local completed status when a newer delta arrives while status is still pending', async () => {
      const localTask = createTask({
        status: 'completed',
        updatedAt: '2026-04-19T00:00:00.000Z',
      });
      const currentProject = createProject({
        updatedAt: '2026-04-19T00:00:00.000Z',
        tasks: [localTask],
      });
      const remoteTask = createTask({
        status: 'active',
        updatedAt: '2026-04-19T00:05:00.000Z',
      });
      const pendingChange = {
        entityId: localTask.id,
        entityType: 'task',
        changeType: 'update',
        projectId: currentProject.id,
        timestamp: Date.now(),
        revision: 1,
        changedFields: ['status'],
        data: localTask,
      } satisfies ChangeRecord;

      mockProjectStateService.getProject.mockReturnValue(currentProject);
      mockSimpleSyncService.checkForDrift.mockResolvedValue({
        tasks: [remoteTask],
        connections: [],
      });
      mockChangeTrackerService.getPendingChange.mockReturnValue(pendingChange);

      await service.performDeltaSync(currentProject.id);

      const updater = mockProjectStateService.updateProjects.mock.calls[0][0] as (projects: Project[]) => Project[];
      const [updatedProject] = updater([currentProject]);

      expect(updatedProject.tasks[0]).toMatchObject({
        id: localTask.id,
        status: 'completed',
        updatedAt: remoteTask.updatedAt,
      });
    });

    it('should preserve an expired dirty field while its durable queue mutation remains pending', async () => {
      const localTask = createTask({ status: 'completed', updatedAt: '2026-04-19T00:00:00.000Z' });
      const currentProject = createProject({ tasks: [localTask] });
      const remoteTask = createTask({ status: 'active', updatedAt: '2026-04-19T00:05:00.000Z' });
      const pendingChange = {
        entityId: localTask.id,
        entityType: 'task',
        changeType: 'update',
        projectId: currentProject.id,
        timestamp: Date.now() - 60 * 60 * 1000,
        revision: 1,
        changedFields: ['status'],
        data: localTask,
      } satisfies ChangeRecord;
      mockProjectStateService.getProject.mockReturnValue(currentProject);
      mockSimpleSyncService.checkForDrift.mockResolvedValue({ tasks: [remoteTask], connections: [] });
      mockActionQueueService.hasDurablePendingTaskMutation.mockReturnValue(true);
      mockChangeTrackerService.getPendingChange.mockImplementation(
        (_projectId, _entityType, _entityId, maxAgeMs) => (
          maxAgeMs === Number.POSITIVE_INFINITY ? pendingChange : undefined
        ),
      );

      await service.performDeltaSync(currentProject.id);

      const updater = mockProjectStateService.updateProjects.mock.calls[0][0] as (projects: Project[]) => Project[];
      const [updatedProject] = updater([currentProject]);
      expect(mockChangeTrackerService.getPendingChange).toHaveBeenCalledWith(
        currentProject.id, 'task', localTask.id, Number.POSITIVE_INFINITY,
      );
      expect(updatedProject.tasks[0].status).toBe('completed');
    });

    it('should preserve queued task writeIntent fields without an in-memory ChangeRecord', async () => {
      const localTask = createTask({
        title: 'Local title',
        content: 'Local content',
        status: 'active',
        updatedAt: '2026-04-19T00:00:00.000Z',
      });
      const currentProject = createProject({ tasks: [localTask] });
      const remoteTask = createTask({
        title: 'Remote title',
        content: 'Remote content',
        status: 'completed',
        updatedAt: '2026-04-19T00:05:00.000Z',
      });
      mockProjectStateService.getProject.mockReturnValue(currentProject);
      mockSimpleSyncService.checkForDrift.mockResolvedValue({ tasks: [remoteTask], connections: [] });
      mockActionQueueService.hasDurablePendingTaskMutation.mockReturnValue(true);
      mockActionQueueService.getProjectPendingWriteState.mockReturnValue('pending');
      mockActionQueueService.getPendingActionsForProject.mockReturnValue([
        createQueuedTaskMutation(localTask, currentProject.id, 'task_text_update'),
      ]);
      mockChangeTrackerService.getPendingChange.mockReturnValue(undefined);

      await service.performDeltaSync(currentProject.id);

      const updater = mockProjectStateService.updateProjects.mock.calls[0][0] as (projects: Project[]) => Project[];
      const [updatedProject] = updater([currentProject]);
      expect(mockChangeTrackerService.getPendingChange).toHaveBeenCalledWith(
        currentProject.id, 'task', localTask.id, Number.POSITIVE_INFINITY,
      );
      expect(mockActionQueueService.getPendingActionsForProject).toHaveBeenCalledWith(currentProject.id);
      expect(updatedProject.tasks[0]).toMatchObject({
        title: 'Local title',
        content: 'Local content',
        status: 'completed',
      });
    });

    it('should fail closed for a durable task mutation without a usable writeIntent', async () => {
      const localTask = createTask({
        title: 'Local title',
        expected_minutes: 90,
        updatedAt: '2026-04-19T00:00:00.000Z',
      });
      const currentProject = createProject({ tasks: [localTask] });
      const remoteTask = createTask({
        title: 'Remote title',
        expected_minutes: 20,
        updatedAt: '2026-04-19T00:05:00.000Z',
      });
      mockProjectStateService.getProject.mockReturnValue(currentProject);
      mockSimpleSyncService.checkForDrift.mockResolvedValue({ tasks: [remoteTask], connections: [] });
      mockActionQueueService.hasDurablePendingTaskMutation.mockReturnValue(true);
      mockActionQueueService.getProjectPendingWriteState.mockReturnValue('pending');
      mockActionQueueService.getPendingActionsForProject.mockReturnValue([
        createQueuedTaskMutation(localTask, currentProject.id),
      ]);
      mockChangeTrackerService.getPendingChange.mockReturnValue(undefined);

      await service.performDeltaSync(currentProject.id);

      const updater = mockProjectStateService.updateProjects.mock.calls[0][0] as (projects: Project[]) => Project[];
      const [updatedProject] = updater([currentProject]);
      expect(updatedProject.tasks[0]).toMatchObject({
        title: 'Local title',
        expected_minutes: 90,
      });
    });

    it('should preserve a reserved RetryQueue text mutation behind a newer ActionQueue structure action', async () => {
      const localTask = createTask({
        title: 'Local title',
        content: 'Local content',
        stage: 2,
        rank: 2000,
        updatedAt: '2026-04-19T00:00:00.000Z',
      });
      const currentProject = createProject({ tasks: [localTask] });
      const remoteTask = createTask({
        title: 'Remote title',
        content: 'Remote content',
        stage: 3,
        rank: 3000,
        updatedAt: '2026-04-19T00:05:00.000Z',
      });
      const reservation: RetryQueueSupersessionReservation = {
        token: 'reservation-1',
        ownerUserId: 'test-user',
        entityType: 'task',
        entityId: localTask.id,
        actionId: 'action-1',
        actionOperationId: 'action-operation-1',
        retryItems: [{ id: 'retry-item-1', operationId: 'retry-operation-1' }],
      };
      const retryItem: RetryQueueItem = {
        id: 'retry-item-1',
        type: 'task',
        operation: 'upsert',
        data: localTask,
        projectId: currentProject.id,
        retryCount: 0,
        createdAt: Date.now(),
        sourceUserId: 'test-user',
        operationId: 'retry-operation-1',
        writeIntent: 'task_text_update',
        actionQueueSupersessions: [reservation],
      };
      const action = createQueuedTaskMutation(localTask, currentProject.id, 'task_structure_update');
      action.id = reservation.actionId;
      action.operationId = reservation.actionOperationId;
      action.payload = {
        ...action.payload,
        sourceUserId: 'test-user',
      };
      action.retryQueueSupersessions = [reservation];
      const nextCursor = {
        updatedAt: remoteTask.updatedAt!,
        entityType: 'task' as const,
        id: remoteTask.id,
      };
      let workingProjects = [currentProject];
      let storedProjects = [currentProject];
      let storedCursor: unknown = null;
      mockProjectStateService.projects.mockImplementation(() => workingProjects);
      mockProjectStateService.getProject.mockImplementation((projectId: string) => (
        workingProjects.find(project => project.id === projectId)
      ));
      mockProjectStateService.getProjectsWithCurrentData.mockImplementation(() => workingProjects);
      mockProjectStateService.updateProjects.mockImplementation((updater: (projects: Project[]) => Project[]) => {
        workingProjects = updater(workingProjects);
      });
      mockSimpleSyncService.checkForDrift.mockResolvedValue({
        tasks: [remoteTask],
        connections: [],
        nextCursor,
      });
      mockSimpleSyncService.saveOfflineSnapshotAndWait.mockImplementation(async (projects: Project[]) => {
        storedProjects = projects;
      });
      mockSimpleSyncService.commitProjectSyncCursor.mockImplementation(async (_projectId: string, cursor: unknown) => {
        storedCursor = cursor;
      });
      mockActionQueueService.hasDurablePendingTaskMutation.mockReturnValue(true);
      mockActionQueueService.getProjectPendingWriteState.mockReturnValue('pending');
      mockActionQueueService.getPendingActionsForProject.mockReturnValue([action]);
      mockRetryQueueService.getOwnerItemsSnapshot.mockReturnValue({ status: 'ready', items: [retryItem] });
      mockChangeTrackerService.getPendingChange.mockReturnValue(undefined);

      const result = await service.performDeltaSync(currentProject.id);

      expect(mockLoggerCategory.error).not.toHaveBeenCalled();
      expect(result).toEqual({ taskChanges: 1, connectionChanges: 0 });
      expect(workingProjects[0].tasks[0]).toMatchObject({
        title: 'Local title',
        content: 'Local content',
        stage: 2,
        rank: 2000,
      });
      expect(storedProjects[0].tasks[0]).toMatchObject({
        title: 'Local title',
        content: 'Local content',
        stage: 2,
        rank: 2000,
      });
      expect(storedCursor).toEqual(nextCursor);
      expect(mockRetryQueueService.getOwnerItemsSnapshot).toHaveBeenCalledWith('test-user');
      expect(action.operationId).toBe('action-operation-1');
      expect(retryItem.operationId).toBe('retry-operation-1');
      expect(action.retryQueueSupersessions?.[0]?.retryItems).toEqual([
        { id: 'retry-item-1', operationId: 'retry-operation-1' },
      ]);
    });

    it('should defer DeltaSync while the owner RetryQueue snapshot is unknown', async () => {
      const currentProject = createProject({ tasks: [createTask({ id: 'task-owner-queue-unknown' })] });
      mockProjectStateService.getProject.mockReturnValue(currentProject);
      mockRetryQueueService.getOwnerItemsSnapshot.mockReturnValue({ status: 'unknown' });
      mockSimpleSyncService.checkForDrift.mockResolvedValue({
        tasks: [createTask({ id: 'task-owner-queue-unknown', title: 'Remote title' })],
        connections: [],
        nextCursor: {
          updatedAt: '2026-04-19T00:01:00.000Z',
          entityType: 'task',
          id: 'task-owner-queue-unknown',
        },
      });

      const result = await service.performDeltaSync(currentProject.id);

      expect(result).toEqual({ taskChanges: 0, connectionChanges: 0 });
      expect(mockSimpleSyncService.checkForDrift).not.toHaveBeenCalled();
      expect(mockProjectStateService.updateProjects).not.toHaveBeenCalled();
      expect(mockSimpleSyncService.saveOfflineSnapshotAndWait).not.toHaveBeenCalled();
      expect(mockSimpleSyncService.commitProjectSyncCursor).not.toHaveBeenCalled();
    });

    it('should protect a late unreserved owner RetryQueue text item after ActionQueue inspection', async () => {
      const localTask = createTask({
        title: 'Local title',
        content: 'Local content',
        stage: 2,
        rank: 2000,
        updatedAt: '2026-04-19T00:00:00.000Z',
      });
      const currentProject = createProject({ tasks: [localTask] });
      const remoteTask = createTask({
        title: 'Remote title',
        content: 'Remote content',
        stage: 3,
        rank: 3000,
        updatedAt: '2026-04-19T00:05:00.000Z',
      });
      const retryItem: RetryQueueItem = {
        id: 'late-retry-item',
        type: 'task',
        operation: 'upsert',
        data: localTask,
        projectId: currentProject.id,
        retryCount: 0,
        createdAt: Date.now(),
        sourceUserId: 'test-user',
        operationId: 'late-retry-operation',
        writeIntent: 'task_text_update',
      };
      const action = createQueuedTaskMutation(localTask, currentProject.id, 'task_structure_update');
      action.payload = { ...action.payload, sourceUserId: 'test-user' };
      expect(action.retryQueueSupersessions).toBeUndefined();
      const nextCursor = {
        updatedAt: remoteTask.updatedAt!,
        entityType: 'task' as const,
        id: remoteTask.id,
      };
      let retryQueueItems: RetryQueueItem[] = [];
      let workingProjects = [currentProject];
      let storedProjects = [currentProject];
      let storedCursor: unknown = null;
      mockProjectStateService.projects.mockImplementation(() => workingProjects);
      mockProjectStateService.getProject.mockImplementation((projectId: string) => (
        workingProjects.find(project => project.id === projectId)
      ));
      mockProjectStateService.getProjectsWithCurrentData.mockImplementation(() => workingProjects);
      mockProjectStateService.updateProjects.mockImplementation((updater: (projects: Project[]) => Project[]) => {
        workingProjects = updater(workingProjects);
      });
      mockSimpleSyncService.checkForDrift.mockResolvedValue({
        tasks: [remoteTask],
        connections: [],
        nextCursor,
      });
      mockSimpleSyncService.saveOfflineSnapshotAndWait.mockImplementation(async (projects: Project[]) => {
        storedProjects = projects;
      });
      mockSimpleSyncService.commitProjectSyncCursor.mockImplementation(async (_projectId: string, cursor: unknown) => {
        storedCursor = cursor;
      });
      mockActionQueueService.hasDurablePendingTaskMutation.mockReturnValue(false);
      mockActionQueueService.getProjectPendingWriteState.mockReturnValue('pending');
      mockActionQueueService.getPendingActionsForProject.mockImplementation(() => {
        const inspectedActions = [action];
        expect(inspectedActions[0]?.retryQueueSupersessions).toBeUndefined();
        retryQueueItems = [retryItem];
        return inspectedActions;
      });
      mockRetryQueueService.getOwnerItemsSnapshot.mockImplementation((ownerUserId: string) => (
        ownerUserId === 'test-user'
          ? { status: 'ready', items: retryQueueItems }
          : { status: 'unknown' }
      ));
      mockChangeTrackerService.getPendingChange.mockReturnValue(undefined);

      const result = await service.performDeltaSync(currentProject.id);

      expect(result).toEqual({ taskChanges: 1, connectionChanges: 0 });
      expect(mockActionQueueService.getPendingActionsForProject).toHaveBeenCalledOnce();
      expect(mockRetryQueueService.getOwnerItemsSnapshot).toHaveBeenCalledWith('test-user');
      expect(mockChangeTrackerService.getPendingChange).toHaveBeenCalledWith(
        currentProject.id, 'task', localTask.id, Number.POSITIVE_INFINITY,
      );
      expect(workingProjects[0].tasks[0]).toMatchObject({
        title: 'Local title',
        content: 'Local content',
        stage: 2,
        rank: 2000,
      });
      expect(storedProjects[0].tasks[0]).toMatchObject({
        title: 'Local title',
        content: 'Local content',
        stage: 2,
        rank: 2000,
      });
      expect(storedCursor).toEqual(nextCursor);
      expect(action.operationId).toBe('operation-task-1');
      expect(retryItem.operationId).toBe('late-retry-operation');
    });

    it('should fail closed when an owner task retry has an ambiguous project identity', async () => {
      const localTask = createTask({
        title: 'Local title',
        content: 'Local content',
        updatedAt: '2026-04-19T00:00:00.000Z',
      });
      const currentProject = createProject({ tasks: [localTask] });
      const remoteTask = createTask({
        title: 'Remote title',
        content: 'Remote content',
        updatedAt: '2026-04-19T00:05:00.000Z',
      });
      const retryItem: RetryQueueItem = {
        id: 'mismatched-project-retry-item',
        type: 'task',
        operation: 'upsert',
        data: localTask,
        projectId: 'another-project',
        retryCount: 0,
        createdAt: Date.now(),
        sourceUserId: 'test-user',
        operationId: 'mismatched-project-retry-operation',
        writeIntent: 'task_text_update',
      };
      const nextCursor = {
        updatedAt: remoteTask.updatedAt!,
        entityType: 'task' as const,
        id: remoteTask.id,
      };
      let workingProjects = [currentProject];
      let storedProjects = [currentProject];
      let storedCursor: unknown = null;
      mockProjectStateService.projects.mockImplementation(() => workingProjects);
      mockProjectStateService.getProject.mockImplementation((projectId: string) => (
        workingProjects.find(project => project.id === projectId)
      ));
      mockProjectStateService.getProjectsWithCurrentData.mockImplementation(() => workingProjects);
      mockProjectStateService.updateProjects.mockImplementation((updater: (projects: Project[]) => Project[]) => {
        workingProjects = updater(workingProjects);
      });
      mockSimpleSyncService.checkForDrift.mockResolvedValue({
        tasks: [remoteTask],
        connections: [],
        nextCursor,
      });
      mockSimpleSyncService.saveOfflineSnapshotAndWait.mockImplementation(async (projects: Project[]) => {
        storedProjects = projects;
      });
      mockSimpleSyncService.commitProjectSyncCursor.mockImplementation(async (_projectId: string, cursor: unknown) => {
        storedCursor = cursor;
      });
      mockActionQueueService.hasDurablePendingTaskMutation.mockReturnValue(false);
      mockRetryQueueService.getOwnerItemsSnapshot.mockReturnValue({ status: 'ready', items: [retryItem] });
      mockChangeTrackerService.getPendingChange.mockReturnValue(undefined);

      const result = await service.performDeltaSync(currentProject.id);

      expect(result).toEqual({ taskChanges: 1, connectionChanges: 0 });
      expect(workingProjects[0].tasks[0]).toMatchObject({
        title: 'Local title',
        content: 'Local content',
      });
      expect(storedProjects[0].tasks[0]).toMatchObject({
        title: 'Local title',
        content: 'Local content',
      });
      expect(storedCursor).toEqual(nextCursor);
    });

    it('should defer unknown owner queue state without changing stored projects or cursor, then retry after load', async () => {
      const localTask = createTask({ title: 'Local title', updatedAt: '2026-04-19T00:00:00.000Z' });
      const currentProject = createProject({ tasks: [localTask] });
      const remoteTask = createTask({ title: 'Remote title', updatedAt: '2026-04-19T00:05:00.000Z' });
      const previousCursor = {
        updatedAt: '2026-04-18T23:59:00.000Z',
        entityType: 'task' as const,
        id: 'task-before',
      };
      const nextCursor = {
        updatedAt: remoteTask.updatedAt!,
        entityType: 'task' as const,
        id: remoteTask.id,
      };
      let workingProjects = [currentProject];
      let storedProjects = [currentProject];
      let storedCursor: unknown = previousCursor;
      mockProjectStateService.projects.mockImplementation(() => workingProjects);
      mockProjectStateService.getProject.mockImplementation((projectId: string) => (
        workingProjects.find(project => project.id === projectId)
      ));
      mockProjectStateService.getProjectsWithCurrentData.mockImplementation(() => workingProjects);
      mockProjectStateService.updateProjects.mockImplementation((updater: (projects: Project[]) => Project[]) => {
        workingProjects = updater(workingProjects);
      });
      mockSimpleSyncService.checkForDrift.mockResolvedValue({
        tasks: [remoteTask],
        connections: [],
        nextCursor,
      });
      mockSimpleSyncService.saveOfflineSnapshotAndWait.mockImplementation(async (projects: Project[]) => {
        storedProjects = projects;
      });
      mockSimpleSyncService.commitProjectSyncCursor.mockImplementation(async (_projectId: string, cursor: unknown) => {
        storedCursor = cursor;
      });
      mockActionQueueService.getProjectPendingWriteState
        .mockReturnValueOnce('clear')
        .mockReturnValueOnce('unknown');

      const blockedResult = await service.performDeltaSync(currentProject.id);

      expect(blockedResult).toEqual({ taskChanges: 0, connectionChanges: 0 });
      expect(storedProjects).toEqual([currentProject]);
      expect(storedCursor).toEqual(previousCursor);
      expect(mockProjectStateService.updateProjects).not.toHaveBeenCalled();
      expect(mockSimpleSyncService.saveOfflineSnapshotAndWait).not.toHaveBeenCalled();
      expect(mockSimpleSyncService.commitProjectSyncCursor).not.toHaveBeenCalled();
      expect(mockSimpleSyncService.checkForDrift).toHaveBeenCalledOnce();

      const retryResult = await service.performDeltaSync(currentProject.id);

      expect(retryResult).toEqual({ taskChanges: 1, connectionChanges: 0 });
      expect(storedProjects[0].tasks[0]).toMatchObject({ title: 'Remote title' });
      expect(storedCursor).toEqual(nextCursor);
      expect(mockSimpleSyncService.saveOfflineSnapshotAndWait).toHaveBeenCalledOnce();
      expect(mockSimpleSyncService.commitProjectSyncCursor).toHaveBeenCalledWith(currentProject.id, nextCursor);
    });

    it('should keep the finite dirty window when no durable mutation remains', async () => {
      const localTask = createTask({ status: 'completed', updatedAt: '2026-04-19T00:00:00.000Z' });
      const currentProject = createProject({ tasks: [localTask] });
      const remoteTask = createTask({ status: 'active', updatedAt: '2026-04-19T00:05:00.000Z' });
      mockProjectStateService.getProject.mockReturnValue(currentProject);
      mockSimpleSyncService.checkForDrift.mockResolvedValue({ tasks: [remoteTask], connections: [] });
      mockChangeTrackerService.getPendingChange.mockReturnValue(undefined);

      await service.performDeltaSync(currentProject.id);

      const maxAgeMs = mockChangeTrackerService.getPendingChange.mock.calls[0][3];
      const updater = mockProjectStateService.updateProjects.mock.calls[0][0] as (projects: Project[]) => Project[];
      expect(maxAgeMs).toBe(SYNC_CONFIG.DIRTY_PROTECTION_WINDOW_MS);
      expect(updater([currentProject])[0].tasks[0].status).toBe('active');
    });

    it('should ignore an older remote tombstone returned by the delta lookback window', async () => {
      const localTask = createTask({
        status: 'active',
        updatedAt: '2026-04-19T00:05:00.000Z',
      });
      const currentProject = createProject({
        updatedAt: '2026-04-19T00:05:00.000Z',
        tasks: [localTask],
      });
      const staleRemoteDelete = createTask({
        updatedAt: '2026-04-19T00:01:00.000Z',
        deletedAt: '2026-04-19T00:01:00.000Z',
      });

      mockProjectStateService.getProject.mockReturnValue(currentProject);
      mockSimpleSyncService.checkForDrift.mockResolvedValue({
        tasks: [staleRemoteDelete],
        connections: [],
      });
      mockChangeTrackerService.getPendingChange.mockReturnValue(undefined);

      await service.performDeltaSync(currentProject.id);

      const updater = mockProjectStateService.updateProjects.mock.calls[0][0] as (projects: Project[]) => Project[];
      const [updatedProject] = updater([currentProject]);

      expect(updatedProject.tasks).toHaveLength(1);
      expect(updatedProject.tasks[0]).toMatchObject({
        id: localTask.id,
        updatedAt: localTask.updatedAt,
      });
      expect(updatedProject.tasks[0].deletedAt).toBeUndefined();
    });

    it('should accept a newer remote restore and clear the local tombstone', async () => {
      const localDeletedTask = createTask({
        updatedAt: '2026-04-19T00:01:00.000Z',
        deletedAt: '2026-04-19T00:01:00.000Z',
      });
      const currentProject = createProject({
        updatedAt: '2026-04-19T00:01:00.000Z',
        tasks: [localDeletedTask],
      });
      const remoteRestoredTask = createTask({
        updatedAt: '2026-04-19T00:05:00.000Z',
      });

      mockProjectStateService.getProject.mockReturnValue(currentProject);
      mockSimpleSyncService.checkForDrift.mockResolvedValue({
        tasks: [remoteRestoredTask],
        connections: [],
      });
      mockChangeTrackerService.getPendingChange.mockReturnValue(undefined);

      await service.performDeltaSync(currentProject.id);

      const updater = mockProjectStateService.updateProjects.mock.calls[0][0] as (projects: Project[]) => Project[];
      const [updatedProject] = updater([currentProject]);

      expect(updatedProject.tasks).toHaveLength(1);
      expect(updatedProject.tasks[0]).toMatchObject({
        id: localDeletedTask.id,
        updatedAt: remoteRestoredTask.updatedAt,
      });
      expect(updatedProject.tasks[0].deletedAt).toBeUndefined();
    });

    it('should apply a newer remote delete delta even when tombstone upserts are blocked', async () => {
      const localTask = createTask({
        updatedAt: '2026-04-19T00:01:00.000Z',
      });
      const currentProject = createProject({
        updatedAt: '2026-04-19T00:01:00.000Z',
        tasks: [localTask],
      });
      const remoteDelete = createTask({
        updatedAt: '2026-04-19T00:05:00.000Z',
        deletedAt: '2026-04-19T00:05:00.000Z',
      });

      mockProjectStateService.getProject.mockReturnValue(currentProject);
      mockSimpleSyncService.checkForDrift.mockResolvedValue({
        tasks: [remoteDelete],
        connections: [],
      });
      mockChangeTrackerService.getPendingChange.mockReturnValue(undefined);
      mockTombstoneService.shouldRejectTaskUpsert.mockReturnValue(true);

      await service.performDeltaSync(currentProject.id);

      const updater = mockProjectStateService.updateProjects.mock.calls[0][0] as (projects: Project[]) => Project[];
      const [updatedProject] = updater([currentProject]);

      expect(updatedProject.tasks).toHaveLength(1);
      expect(updatedProject.tasks[0]).toMatchObject({
        id: localTask.id,
        deletedAt: remoteDelete.deletedAt,
        updatedAt: remoteDelete.updatedAt,
      });
    });

    it('should keep a newer local soft delete in trash when an older remote restore arrives', async () => {
      const localDeletedTask = createTask({
        updatedAt: '2026-04-19T00:01:00.000Z',
        deletedAt: '2026-04-19T00:05:00.000Z',
      });
      const currentProject = createProject({
        updatedAt: '2026-04-19T00:05:00.000Z',
        tasks: [localDeletedTask],
      });
      const olderRemoteRestore = createTask({
        updatedAt: '2026-04-19T00:03:00.000Z',
      });

      mockProjectStateService.getProject.mockReturnValue(currentProject);
      mockSimpleSyncService.checkForDrift.mockResolvedValue({
        tasks: [olderRemoteRestore],
        connections: [],
      });
      mockChangeTrackerService.getPendingChange.mockReturnValue(undefined);

      await service.performDeltaSync(currentProject.id);

      const updater = mockProjectStateService.updateProjects.mock.calls[0][0] as (projects: Project[]) => Project[];
      const [updatedProject] = updater([currentProject]);

      expect(updatedProject.tasks).toHaveLength(1);
      expect(updatedProject.tasks[0]).toMatchObject({
        id: localDeletedTask.id,
        deletedAt: localDeletedTask.deletedAt,
        updatedAt: localDeletedTask.updatedAt,
      });
    });
  });
});
