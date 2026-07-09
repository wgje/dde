import { beforeEach, describe, expect, it } from './sync-coordinator.service.spec-context';
import type { Project, SyncCoordinatorService, Task } from './sync-coordinator.service.spec-context';
import type { SyncCoordinatorPersistenceSpecContext } from './sync-coordinator-persistence.spec-helpers';

export function registerSyncCoordinatorOwnerHandoffSpecs(context: SyncCoordinatorPersistenceSpecContext): void {
  let service: SyncCoordinatorService;
  let mockSyncService: any;
  let mockProjectStateService: any;
  let mockChangeTrackerService: any;
  let mockActionQueueService: any;

  const createTestProject = context.createTestProject;
  const createTestTask = context.createTestTask;

  beforeEach(() => {
    service = context.service();
    mockSyncService = context.mockSyncService();
    mockProjectStateService = context.mockProjectStateService();
    mockChangeTrackerService = context.mockChangeTrackerService();
    mockActionQueueService = context.mockActionQueueService();
  });

  describe('owner 切换持久化转交', () => {
    it('preparePendingPersistForOwnerChange 在云端失败后应把项目转交给原 owner 队列', async () => {
      const project = createTestProject({ id: 'proj-owner-handoff', pendingSync: true });
      mockProjectStateService.activeProject.set(project);
      mockProjectStateService.projects.set([project]);
      mockSyncService.saveProjectSmart.mockResolvedValueOnce({ success: false });

      service.markLocalChanges('content');
      const prepared = await service.preparePendingPersistForOwnerChange('user-123', 'owner-switch:user-123->user-456');

      expect(prepared).toBe(true);
      expect(mockActionQueueService.enqueueForOwner).toHaveBeenCalledWith(
        'user-123',
        expect.objectContaining({
          type: 'update',
          entityType: 'project',
          entityId: 'proj-owner-handoff',
          payload: expect.objectContaining({
            sourceUserId: 'user-123',
            project: expect.objectContaining({
              id: 'proj-owner-handoff',
              pendingSync: true,
              syncSource: 'synced',
            }),
          }),
        })
      );
    });

    it('preparePendingPersistForOwnerChange 应将待删除任务并入 project:update payload durable 到原 owner 队列', async () => {
      const project = createTestProject({
        id: 'proj-owner-delete-handoff',
        pendingSync: true,
        tasks: [
          createTestTask({
            id: 'task-delete-a',
            updatedAt: '2026-05-14T09:20:00.000Z',
          }),
          createTestTask({
            id: 'task-delete-b',
            updatedAt: '2026-05-14T09:21:00.000Z',
          }),
        ],
      });
      mockProjectStateService.activeProject.set(project);
      mockProjectStateService.projects.set([project]);
      mockSyncService.saveProjectSmart.mockResolvedValueOnce({ success: false });
      mockChangeTrackerService.getProjectChanges.mockReturnValueOnce({
        projectId: 'proj-owner-delete-handoff',
        tasksToCreate: [],
        tasksToUpdate: [],
        taskIdsToDelete: ['task-delete-a', 'task-delete-b'],
        taskDeleteBaseUpdatedAtMap: {
          'task-delete-a': '2026-05-14T09:20:00.000Z',
          'task-delete-b': '2026-05-14T09:21:00.000Z',
        },
        connectionsToCreate: [],
        connectionsToUpdate: [],
        connectionsToDelete: [],
        hasChanges: true,
        totalChanges: 2,
        taskUpdateFieldsById: {},
      });

      service.markLocalChanges('content');
      const prepared = await service.preparePendingPersistForOwnerChange('user-123', 'owner-switch:user-123->user-456');

      expect(prepared).toBe(true);
      expect(mockActionQueueService.enqueueForOwner).toHaveBeenCalledTimes(1);
      expect(mockActionQueueService.enqueueForOwner).toHaveBeenNthCalledWith(1, 'user-123',
        expect.objectContaining({
          type: 'update',
          entityType: 'project',
          entityId: 'proj-owner-delete-handoff',
          payload: expect.objectContaining({
            sourceUserId: 'user-123',
            taskIdsToDelete: ['task-delete-a', 'task-delete-b'],
            taskDeleteBaseUpdatedAtMap: {
              'task-delete-a': '2026-05-14T09:20:00.000Z',
              'task-delete-b': '2026-05-14T09:21:00.000Z',
            },
          }),
        })
      );
    });

    it('preparePendingPersistForOwnerChange 应将非活动 dirty project 一并 durable handoff 到原 owner 队列', async () => {
      const inactiveProject = createTestProject({ id: 'proj-inactive-dirty', pendingSync: true });
      const activeProject = createTestProject({ id: 'proj-active-handoff', pendingSync: true });
      mockProjectStateService.activeProject.set(activeProject);
      mockProjectStateService.projects.set([inactiveProject, activeProject]);
      mockSyncService.saveProjectSmart.mockResolvedValueOnce({ success: false });
      mockChangeTrackerService.getChangedProjectIds.mockReturnValueOnce(['proj-inactive-dirty']);
      mockChangeTrackerService.getChangedProjectIds.mockReturnValueOnce(['proj-inactive-dirty']);
      mockChangeTrackerService.getProjectChanges.mockImplementationOnce((projectId: string) => ({
        tasksToCreate: [],
        tasksToUpdate: [],
        taskIdsToDelete: projectId === 'proj-inactive-dirty' ? ['task-inactive-delete'] : [],
        connectionsToCreate: [],
        connectionsToUpdate: [],
        connectionsToDelete: [],
        hasChanges: projectId === 'proj-inactive-dirty',
        totalChanges: projectId === 'proj-inactive-dirty' ? 1 : 0,
      }));
      mockChangeTrackerService.getProjectChanges.mockImplementationOnce((projectId: string) => ({
        tasksToCreate: [],
        tasksToUpdate: [],
        taskIdsToDelete: projectId === 'proj-active-handoff' ? [] : ['task-inactive-delete'],
        connectionsToCreate: [],
        connectionsToUpdate: [],
        connectionsToDelete: [],
        hasChanges: projectId === 'proj-inactive-dirty',
        totalChanges: projectId === 'proj-inactive-dirty' ? 1 : 0,
      }));

      service.markLocalChanges('content');
      const prepared = await service.preparePendingPersistForOwnerChange(
        'user-123',
        'owner-switch:user-123->user-456',
      );

      expect(prepared).toBe(true);
      expect(mockActionQueueService.enqueueForOwner).toHaveBeenCalledTimes(2);
      expect(mockActionQueueService.enqueueForOwner).toHaveBeenNthCalledWith(
        1,
        'user-123',
        expect.objectContaining({
          entityId: 'proj-inactive-dirty',
          payload: expect.objectContaining({ taskIdsToDelete: ['task-inactive-delete'] }),
        }),
      );
      expect(mockActionQueueService.enqueueForOwner).toHaveBeenNthCalledWith(
        2,
        'user-123',
        expect.objectContaining({ entityId: 'proj-active-handoff' }),
      );
    });

    it('preparePendingPersistForOwnerChange 在没有 active pending 时也应转交非活动 dirty project 的删除意图', async () => {
      const inactiveProject = createTestProject({ id: 'proj-inactive-only', pendingSync: true });
      mockProjectStateService.activeProject.set(null);
      mockProjectStateService.projects.set([inactiveProject]);
      mockChangeTrackerService.getChangedProjectIds.mockReturnValueOnce(['proj-inactive-only']);
      mockChangeTrackerService.getChangedProjectIds.mockReturnValueOnce(['proj-inactive-only']);
      mockChangeTrackerService.getProjectChanges.mockReturnValueOnce({
        tasksToCreate: [],
        tasksToUpdate: [],
        taskIdsToDelete: ['task-offline-delete-a', 'task-offline-delete-b'],
        connectionsToCreate: [],
        connectionsToUpdate: [],
        connectionsToDelete: [],
        hasChanges: true,
        totalChanges: 2,
      });

      const prepared = await service.preparePendingPersistForOwnerChange(
        'user-123',
        'owner-switch:user-123->user-456',
      );

      expect(prepared).toBe(true);
      expect(mockSyncService.saveProjectSmart).not.toHaveBeenCalled();
      expect(mockActionQueueService.enqueueForOwner).toHaveBeenCalledWith(
        'user-123',
        expect.objectContaining({
          entityId: 'proj-inactive-only',
          payload: expect.objectContaining({
            sourceUserId: 'user-123',
            taskIdsToDelete: ['task-offline-delete-a', 'task-offline-delete-b'],
          }),
        }),
      );
    });

    it('preparePendingPersistForOwnerChange 应使用当前 store 快照转交非活动 dirty project', async () => {
      const staleTask = createTestTask({
        id: 'task-inactive-stale',
        title: 'Stale Task',
        stage: null,
        updatedAt: '2026-05-14T09:20:00.000Z',
      });
      const staleConnection = {
        id: 'connection-inactive-stale',
        source: 'task-inactive-stale',
        target: 'task-inactive-target',
        title: 'Stale Connection',
        updatedAt: '2026-05-14T09:20:00.000Z',
      };
      const currentTask: Task = {
        ...staleTask,
        title: 'Current Task',
        stage: 3,
        updatedAt: '2026-05-14T09:22:00.000Z',
      };
      const currentConnection = {
        ...staleConnection,
        title: 'Current Connection',
        updatedAt: '2026-05-14T09:22:00.000Z',
      };
      const staleProject = createTestProject({
        id: 'proj-inactive-current-data',
        pendingSync: true,
        tasks: [staleTask],
        connections: [staleConnection],
      });
      const currentProject: Project = {
        ...staleProject,
        tasks: [currentTask],
        connections: [currentConnection],
      };

      mockProjectStateService.activeProject.set(null);
      mockProjectStateService.projects.set([staleProject]);
      mockProjectStateService.getProjectsWithCurrentData.mockImplementation(() => [currentProject]);
      mockChangeTrackerService.getChangedProjectIds.mockReturnValueOnce(['proj-inactive-current-data']);
      mockChangeTrackerService.getChangedProjectIds.mockReturnValueOnce(['proj-inactive-current-data']);
      mockChangeTrackerService.getProjectChanges.mockReturnValueOnce({
        tasksToCreate: [],
        tasksToUpdate: [],
        taskIdsToDelete: [],
        connectionsToCreate: [],
        connectionsToUpdate: [],
        connectionsToDelete: [],
        hasChanges: true,
        totalChanges: 1,
      });

      const prepared = await service.preparePendingPersistForOwnerChange(
        'user-123',
        'owner-switch:user-123->user-456',
      );

      expect(prepared).toBe(true);
      expect(mockSyncService.saveProjectSmart).not.toHaveBeenCalled();
      expect(mockActionQueueService.enqueueForOwner).toHaveBeenCalledWith(
        'user-123',
        expect.objectContaining({
          entityId: 'proj-inactive-current-data',
          payload: expect.objectContaining({
            project: expect.objectContaining({
              tasks: [currentTask],
              connections: [currentConnection],
            }),
          }),
        }),
      );

      mockProjectStateService.getProjectsWithCurrentData.mockImplementation(() => mockProjectStateService.projects());
    });
  });
}
