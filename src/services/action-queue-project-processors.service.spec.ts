import { Injector, runInInjectionContext } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ProjectDataService,
  ProjectDeleteCoordinatorService,
  ProjectSaveFlightCoordinatorService,
  RetryQueueService,
  TaskSyncOperationsService,
} from '../core-bridge';
import type { Project } from '../models';
import { ActionQueueProjectProcessorsService } from './action-queue-project-processors.service';
import { ActionQueueService, type ActionQueueProcessorResult } from './action-queue.service';
import type { ProjectDeletePayload, ProjectPayload, QueuedAction } from './action-queue.types';
import { AuthService } from './auth.service';
import { ConflictStorageService } from './conflict-storage.service';
import { LoggerService } from './logger.service';
import { ProjectStateService } from './project-state.service';
import { ToastService } from './toast.service';
import { createProject } from './project-operation.test-harness';
import { createDerivedSyncOperationId } from '../utils/sync-operation-id';

type QueueProcessor = (action: QueuedAction) => Promise<ActionQueueProcessorResult>;

describe('ActionQueueProjectProcessorsService', () => {
  const actionQueue = {
    registerProcessor: vi.fn(),
    getCurrentQueueViewGeneration: vi.fn(() => 1),
    getProjectMutationViewGeneration: vi.fn(() => 0),
    isQueueViewCurrent: vi.fn(() => true),
    markActionSyncedRemotely: vi.fn(),
    markActionResolvedWithoutRemote: vi.fn(),
    moveToDeadLetter: vi.fn(),
    deferRetry: vi.fn(error => ({ outcome: 'defer-retry' as const, error })),
    failRetry: vi.fn(error => ({ outcome: 'failed' as const, error })),
    settleProjectDeleteSuccessForOwner: vi.fn().mockResolvedValue(1),
    enqueueForOwner: vi.fn().mockResolvedValue('queued-owner-action'),
  };
  const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
  const projectSave = { save: vi.fn() };
  const projectDelete = { deleteProjectFromCloud: vi.fn() };
  const projectData = { loadFullProjectOptimized: vi.fn().mockResolvedValue(null) };
  const retryQueue = {
    removeByProjectId: vi.fn(),
    findItemForOwner: vi.fn(() => null),
  };
  const taskSyncOps = { deleteTask: vi.fn().mockResolvedValue(true) };
  const projectState = {
    getProject: vi.fn((): Project | undefined => undefined),
    updateProjects: vi.fn(),
  };
  const auth = { currentUserId: vi.fn((): string | null => 'user-1') };
  const conflictStorage = { saveConflict: vi.fn().mockResolvedValue(true) };
  const toast = { warning: vi.fn() };

  let service: ActionQueueProjectProcessorsService;

  function setup(): void {
    const injector = Injector.create({
      providers: [
        ActionQueueProjectProcessorsService,
        { provide: ActionQueueService, useValue: actionQueue },
        { provide: LoggerService, useValue: { category: () => logger } },
        { provide: TaskSyncOperationsService, useValue: taskSyncOps },
        { provide: ProjectSaveFlightCoordinatorService, useValue: projectSave },
        { provide: ProjectDeleteCoordinatorService, useValue: projectDelete },
        { provide: ProjectDataService, useValue: projectData },
        { provide: RetryQueueService, useValue: retryQueue },
        { provide: ProjectStateService, useValue: projectState },
        { provide: AuthService, useValue: auth },
        { provide: ConflictStorageService, useValue: conflictStorage },
        { provide: ToastService, useValue: toast },
      ],
    });

    service = runInInjectionContext(injector, () => injector.get(ActionQueueProjectProcessorsService));
    service.setupProcessors();
  }

  function processor(type: string): QueueProcessor {
    const registered = actionQueue.registerProcessor.mock.calls.find(call => call[0] === type)?.[1];
    if (!registered) {
      throw new Error(`Missing processor: ${type}`);
    }
    return registered as QueueProcessor;
  }

  function projectAction(
    type: 'create' | 'update',
    project: Project,
    overrides: Partial<QueuedAction<ProjectPayload>> = {},
  ): QueuedAction<ProjectPayload> {
    return {
      id: `action-${type}-${project.id}`,
      operationId: `op-${type}-${project.id}`,
      type,
      entityType: 'project',
      entityId: project.id,
      payload: { project, sourceUserId: 'user-1' },
      timestamp: 1,
      retryCount: 0,
      ...overrides,
    };
  }

  function projectDeleteAction(
    projectId: string,
    overrides: Partial<QueuedAction<ProjectDeletePayload>> = {},
  ): QueuedAction<ProjectDeletePayload> {
    return {
      id: `action-delete-${projectId}`,
      operationId: `op-delete-${projectId}`,
      type: 'delete',
      entityType: 'project',
      entityId: projectId,
      payload: { projectId, userId: 'user-1', sourceUserId: 'user-1' },
      timestamp: 1,
      retryCount: 0,
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    actionQueue.getCurrentQueueViewGeneration.mockReturnValue(1);
    actionQueue.getProjectMutationViewGeneration.mockReturnValue(0);
    actionQueue.isQueueViewCurrent.mockReturnValue(true);
    actionQueue.settleProjectDeleteSuccessForOwner.mockResolvedValue(1);
    actionQueue.enqueueForOwner.mockResolvedValue('queued-owner-action');
    auth.currentUserId.mockReturnValue('user-1');
    projectState.getProject.mockReturnValue(undefined);
    projectSave.save.mockResolvedValue({ success: true, newVersion: 7 });
    projectDelete.deleteProjectFromCloud.mockResolvedValue({ ok: true, value: undefined });
    projectData.loadFullProjectOptimized.mockResolvedValue(null);
    taskSyncOps.deleteTask.mockResolvedValue(true);
    retryQueue.findItemForOwner.mockReturnValue(null);
    setup();
  });

  it('registers project mutation and delete processors', () => {
    expect(actionQueue.registerProcessor.mock.calls.map(call => call[0])).toEqual([
      'project:update',
      'project:delete',
      'project:create',
    ]);
  });

  it('project:create 成功时应携带 operationId 保存并标记远端已同步', async () => {
    const project = createProject({ id: 'proj-create-queued', pendingSync: true, syncSource: 'synced' });
    const action = projectAction('create', project);

    const result = await processor('project:create')(action);

    expect(result).toBe(true);
    expect(projectSave.save).toHaveBeenCalledWith(project, 'user-1', undefined, undefined, 'op-create-proj-create-queued');
    expect(actionQueue.markActionSyncedRemotely).toHaveBeenCalledWith('action-create-proj-create-queued');
    expect(projectState.updateProjects).toHaveBeenCalled();
  });

  it('project:update 成功后重放 task delete 时应派生子 operationId', async () => {
    const project = createProject({ id: 'proj-delete-replay-op', pendingSync: true, syncSource: 'synced' });
    const action = projectAction('update', project, {
      operationId: 'op-project-delete-replay',
      payload: {
        project,
        sourceUserId: 'user-1',
        taskIdsToDelete: ['task-delete-op'],
        taskDeleteBaseUpdatedAtMap: {
          'task-delete-op': '2026-06-12T00:00:00.000Z',
        },
      },
    });
    const expectedDeleteOperationId = createDerivedSyncOperationId(
      'op-project-delete-replay',
      'project-task-delete:proj-delete-replay-op:task-delete-op:2026-06-12T00:00:00.000Z',
    );

    const result = await processor('project:update')(action);

    expect(result).toBe(true);
    expect(expectedDeleteOperationId).not.toBe(action.operationId);
    expect(taskSyncOps.deleteTask).toHaveBeenCalledWith(
      'task-delete-op',
      'proj-delete-replay-op',
      'user-1',
      false,
      '2026-06-12T00:00:00.000Z',
      expectedDeleteOperationId,
    );
  });

  it('project:update 队列视图过期转交剩余 task delete 时应派生 handoff operationId', async () => {
    const project = createProject({ id: 'proj-delete-handoff-op', pendingSync: true, syncSource: 'synced' });
    actionQueue.isQueueViewCurrent
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    const expectedReplayDeleteOperationId = createDerivedSyncOperationId(
      'op-project-delete-handoff',
      'project-task-delete:proj-delete-handoff-op:task-a:2026-06-12T00:00:00.000Z',
    );
    const expectedHandoffOperationId = createDerivedSyncOperationId(
      'op-project-delete-handoff',
      'project-task-delete-handoff:proj-delete-handoff-op|task-b:2026-06-12T00:01:00.000Z',
    );

    const result = await processor('project:update')(projectAction('update', project, {
      operationId: 'op-project-delete-handoff',
      payload: {
        project,
        sourceUserId: 'user-1',
        taskIdsToDelete: ['task-a', 'task-b'],
        taskDeleteBaseUpdatedAtMap: {
          'task-a': '2026-06-12T00:00:00.000Z',
          'task-b': '2026-06-12T00:01:00.000Z',
        },
      },
    }));

    expect(result).toBe(true);
    expect(taskSyncOps.deleteTask).toHaveBeenCalledWith(
      'task-a',
      'proj-delete-handoff-op',
      'user-1',
      false,
      '2026-06-12T00:00:00.000Z',
      expectedReplayDeleteOperationId,
    );
    expect(actionQueue.enqueueForOwner).toHaveBeenCalledWith('user-1', expect.objectContaining({
      operationId: expectedHandoffOperationId,
      type: 'update',
      entityType: 'project',
      entityId: 'proj-delete-handoff-op',
      payload: expect.objectContaining({
        taskIdsToDelete: ['task-b'],
        taskDeleteBaseUpdatedAtMap: {
          'task-b': '2026-06-12T00:01:00.000Z',
        },
      }),
    }));
  });

  it('project:update 项目视图过期时应写回剩余 task delete，避免删除意图丢失', async () => {
    const project = createProject({ id: 'proj-delete-project-stale', pendingSync: true, syncSource: 'synced' });
    actionQueue.getProjectMutationViewGeneration
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(1)
      .mockReturnValueOnce(1);
    const expectedHandoffOperationId = createDerivedSyncOperationId(
      'op-project-delete-project-stale',
      [
        'project-task-delete-handoff:proj-delete-project-stale',
        'task-stale-a:2026-06-12T00:00:00.000Z',
        'task-stale-b:2026-06-12T00:01:00.000Z',
      ].join('|'),
    );

    const result = await processor('project:update')(projectAction('update', project, {
      operationId: 'op-project-delete-project-stale',
      payload: {
        project,
        sourceUserId: 'user-1',
        taskIdsToDelete: ['task-stale-a', 'task-stale-b'],
        taskDeleteBaseUpdatedAtMap: {
          'task-stale-a': '2026-06-12T00:00:00.000Z',
          'task-stale-b': '2026-06-12T00:01:00.000Z',
        },
      },
    }));

    expect(result).toBe(true);
    expect(taskSyncOps.deleteTask).not.toHaveBeenCalled();
    expect(actionQueue.enqueueForOwner).toHaveBeenCalledWith('user-1', expect.objectContaining({
      operationId: expectedHandoffOperationId,
      type: 'update',
      entityType: 'project',
      entityId: 'proj-delete-project-stale',
      payload: expect.objectContaining({
        taskIdsToDelete: ['task-stale-a', 'task-stale-b'],
        taskDeleteBaseUpdatedAtMap: {
          'task-stale-a': '2026-06-12T00:00:00.000Z',
          'task-stale-b': '2026-06-12T00:01:00.000Z',
        },
      }),
    }));
    expect(actionQueue.markActionResolvedWithoutRemote).toHaveBeenCalledWith('action-update-proj-delete-project-stale');
  });

  it('project:update 冲突时应把双方数据交给统一冲突处理器', async () => {
    const project = createProject({ id: 'proj-conflict-queued', name: 'Local Import', pendingSync: true, syncSource: 'synced' });
    const remote = createProject({ id: 'proj-conflict-queued', name: 'Remote Import', version: 8 });
    const conflictHandler = vi.fn();
    service.setProjectConflictHandler(conflictHandler);
    projectSave.save.mockResolvedValueOnce({ success: false, conflict: true, remoteData: remote });

    const result = await processor('project:update')(projectAction('update', project));

    expect(result).toBe(true);
    expect(conflictHandler).toHaveBeenCalledWith(project, remote, 'user-1', undefined, undefined);
    expect(actionQueue.moveToDeadLetter).not.toHaveBeenCalled();
    expect(actionQueue.markActionSyncedRemotely).not.toHaveBeenCalled();
  });

  it('project:update terminal 失败应进入死信并停止重试', async () => {
    const project = createProject({ id: 'proj-terminal-queued', pendingSync: true, syncSource: 'synced' });
    const action = projectAction('update', project);
    projectSave.save.mockResolvedValueOnce({
      success: false,
      terminal: true,
      failureReason: '当前客户端同步协议已过期，请刷新后重试',
    });

    const result = await processor('project:update')(action);

    expect(result).toBe(true);
    expect(actionQueue.moveToDeadLetter).toHaveBeenCalledWith(
      action,
      '当前客户端同步协议已过期，请刷新后重试',
    );
    expect(actionQueue.failRetry).not.toHaveBeenCalled();
  });

  it('project:update 可重试失败应保留队列并返回 failed retry', async () => {
    const project = createProject({ id: 'proj-retry-queued', pendingSync: true, syncSource: 'synced' });
    projectSave.save.mockResolvedValueOnce({ success: false, conflict: false, failureReason: 'network down' });

    const result = await processor('project:update')(projectAction('update', project));

    expect(result).toEqual(expect.objectContaining({ outcome: 'failed' }));
    expect(actionQueue.failRetry).toHaveBeenCalledWith(expect.objectContaining({
      code: 'SYNC_PROJECT_WRITE_FAILED',
      message: expect.stringContaining('network down'),
    }));
    expect(actionQueue.markActionSyncedRemotely).not.toHaveBeenCalled();
  });

  it('project:delete 成功时应携带 operationId 并清理同项目挂起 mutation', async () => {
    const action = projectDeleteAction('proj-delete-queued');

    const result = await processor('project:delete')(action);

    expect(result).toBe(true);
    expect(projectDelete.deleteProjectFromCloud).toHaveBeenCalledWith(
      'proj-delete-queued',
      'user-1',
      'op-delete-proj-delete-queued',
    );
    expect(actionQueue.settleProjectDeleteSuccessForOwner).toHaveBeenCalledWith(
      'user-1',
      'proj-delete-queued',
      'action-delete-proj-delete-queued',
    );
    expect(retryQueue.removeByProjectId).toHaveBeenCalledWith('proj-delete-queued');
    expect(actionQueue.markActionSyncedRemotely).toHaveBeenCalledWith('action-delete-proj-delete-queued');
  });

  it('project:delete 未登录时应延后重试且不调用远端删除', async () => {
    auth.currentUserId.mockReturnValueOnce(null);
    const action = projectDeleteAction('proj-delete-auth-pending');

    const result = await processor('project:delete')(action);

    expect(result).toEqual({
      outcome: 'defer-retry',
      error: expect.objectContaining({
        code: 'SYNC_AUTH_PENDING',
        details: expect.objectContaining({
          reason: 'auth-pending',
          actionType: 'project:delete',
          entityId: 'proj-delete-auth-pending',
          projectId: 'proj-delete-auth-pending',
        }),
      }),
    });
    expect(actionQueue.deferRetry).toHaveBeenCalledWith(expect.objectContaining({
      code: 'SYNC_AUTH_PENDING',
    }));
    expect(projectDelete.deleteProjectFromCloud).not.toHaveBeenCalled();
    expect(actionQueue.settleProjectDeleteSuccessForOwner).not.toHaveBeenCalled();
    expect(actionQueue.markActionSyncedRemotely).not.toHaveBeenCalled();
  });
});
