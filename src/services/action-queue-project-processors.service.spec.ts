import { Injector, runInInjectionContext, type StaticProvider } from '@angular/core';
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
import {
  createProjectProcessorConflictRecord as conflictRecord,
  createProjectProcessorHandoffAction as handoffAction,
  createProjectProcessorAction as projectAction,
  flushProjectProcessorRecoveryMicrotasks as flushRecoveryMicrotasks,
} from './action-queue-processing-lease.spec-helpers';
import { ActionQueueService, type ActionQueueProcessorResult } from './action-queue.service';
import type { LocalHandoffIdentity } from './action-queue-held-action.controller';
import { ActionQueueSyncWriterLeaseService } from './action-queue-sync-writer-lease.service';
import type { ProjectDeletePayload, ProjectPayload, QueuedAction } from './action-queue.types';
import { AuthService } from './auth.service';
import {
  ConflictStorageService,
  createProjectConflictRecordFingerprint,
  type ProjectConflictLocalHandoffReservationResult,
} from './conflict-storage.service';
import { LoggerService } from './logger.service';
import { ProjectConflictDirectSyncService } from './project-conflict-direct-sync.service';
import { ProjectStateService } from './project-state.service';
import { SyncCoordinatorService } from './sync-coordinator.service';
import { ToastService } from './toast.service';
import { UserSessionService } from './user-session.service';
import { createProject } from './project-operation.test-harness';
import type { QueueProcessorContext } from './action-queue-processing.types';
import {
  createProjectConflictHandoffPayloadDigest,
  createProjectConflictHandoffReservationId,
} from './project-operation-conflict-retry-settlement.controller';
import { createDerivedSyncOperationId } from '../utils/sync-operation-id';

type QueueProcessor = (action: QueuedAction, context?: QueueProcessorContext) => Promise<ActionQueueProcessorResult>;

describe('ActionQueueProjectProcessorsService', () => {
  let ownerStorageLoadListener: (() => void) | undefined;
  const actionQueue = {
    registerProcessor: vi.fn(),
    pendingActions: vi.fn((): QueuedAction[] => []),
    subscribeToOwnerStorageLoadStateChanges: vi.fn((listener: () => void) => {
      ownerStorageLoadListener = listener;
      return vi.fn();
    }),
    getCurrentOwnerStorageLoadState: vi.fn(() => 'loaded' as const),
    getCurrentQueueViewGeneration: vi.fn(() => 1),
    getProjectMutationViewGeneration: vi.fn(() => 0),
    isQueueViewCurrent: vi.fn(() => true),
    markActionSyncedRemotely: vi.fn(),
    markActionResolvedWithoutRemote: vi.fn(),
    moveToDeadLetter: vi.fn(),
    deferRetry: vi.fn(error => ({ outcome: 'defer-retry' as const, error })),
    failRetry: vi.fn(error => ({ outcome: 'failed' as const, error })),
    settleProjectDeleteSuccessForOwner: vi.fn().mockResolvedValue(1),
    settleExactCurrentProjectDeleteSuccess: vi.fn().mockResolvedValue({ status: 'current', removedCount: 0 }),
    enqueueForOwner: vi.fn().mockResolvedValue('queued-owner-action'),
    getPendingActionsForProject: vi.fn(() => []),
    transitionLocalHandoffStrictlyForOwner: vi.fn(),
    activateLocalHandoffStrictlyForOwner: vi.fn().mockResolvedValue({ status: 'committed' }),
    removeCompletedLocalHandoffStrictlyForOwner: vi.fn().mockResolvedValue({ status: 'committed' }),
    processQueue: vi.fn().mockResolvedValue(undefined),
  };
  const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
  const projectSave = { save: vi.fn() };
  const projectDelete = { deleteProjectFromCloud: vi.fn() };
  const projectData = {
    loadFullProjectOptimized: vi.fn().mockResolvedValue(null),
    saveOfflineSnapshotAndWait: vi.fn().mockResolvedValue(undefined),
  };
  const retryQueue = {
    removeByProjectIdDurablyForOwner: vi.fn().mockResolvedValue(true),
    findItemForOwner: vi.fn(() => null),
  };
  const taskSyncOps = { deleteTask: vi.fn().mockResolvedValue(true) };
  const projectState = {
    getProject: vi.fn((): Project | undefined => undefined),
    getProjectsWithCurrentData: vi.fn((): Project[] => []),
    updateProjects: vi.fn(),
  };
  const auth = {
    currentUserId: vi.fn((): string | null => 'user-1'),
    captureAuthIdentityFence: vi.fn(() => 'auth-fence-a'),
  };
  const userSession = {
    getCurrentSessionGeneration: vi.fn(() => 7),
    isSessionContextCurrent: vi.fn(() => true),
  };
  const conflictStorage = {
    saveConflict: vi.fn().mockResolvedValue(true),
    persistProjectConflictLocalHandoffRequirement: vi.fn().mockResolvedValue({ status: 'committed' }),
    reserveProjectConflictLocalHandoff: vi.fn(async (input): Promise<ProjectConflictLocalHandoffReservationResult> => ({
      status: 'committed' as const, reservationId: input.reservationId,
    })),
    verifyProjectConflictLocalHandoffReservation: vi.fn().mockResolvedValue({ status: 'committed' }),
    advanceProjectConflictLocalHandoff: vi.fn().mockResolvedValue({ status: 'committed' }),
    deleteCompletedProjectConflictLocalHandoff: vi.fn().mockResolvedValue({ status: 'committed' }),
  };
  const toast = { warning: vi.fn() };
  const directSync = { executeActivatedHandoff: vi.fn() };
  const resolveDirectSync = vi.fn(() => directSync);
  const recoveryLeaseRelease = vi.fn(async () => undefined);
  const syncWriterLease = { acquire: vi.fn(async () => ({
    mode: 'idb-lease', signal: new AbortController().signal, release: recoveryLeaseRelease,
  })) };

  let service: ActionQueueProjectProcessorsService;

  function createProcessorInjector(overrides: StaticProvider[] = []): Injector {
    return Injector.create({
      providers: [
        ActionQueueProjectProcessorsService,
        { provide: ActionQueueService, useValue: actionQueue },
        { provide: ActionQueueSyncWriterLeaseService, useValue: syncWriterLease },
        { provide: LoggerService, useValue: { category: () => logger } },
        { provide: TaskSyncOperationsService, useValue: taskSyncOps },
        { provide: ProjectSaveFlightCoordinatorService, useValue: projectSave },
        { provide: ProjectDeleteCoordinatorService, useValue: projectDelete },
        { provide: ProjectDataService, useValue: projectData },
        { provide: RetryQueueService, useValue: retryQueue },
        { provide: ProjectStateService, useValue: projectState },
        { provide: AuthService, useValue: auth },
        { provide: UserSessionService, useValue: userSession },
        { provide: ConflictStorageService, useValue: conflictStorage },
        { provide: ToastService, useValue: toast },
        { provide: ProjectConflictDirectSyncService, useFactory: resolveDirectSync },
        ...overrides,
      ],
    });
  }

  function setup(): void {
    const injector = createProcessorInjector();
    service = runInInjectionContext(injector, () => injector.get(ActionQueueProjectProcessorsService));
    service.setupProcessors();
  }

  function createStartupCycleInjector() {
    const resolveUserSession = vi.fn((_syncCoordinator: SyncCoordinatorService) => userSession);
    const injector = createProcessorInjector([
      { provide: UserSessionService, useFactory: resolveUserSession, deps: [SyncCoordinatorService] },
      {
        provide: SyncCoordinatorService,
        useFactory: (processors: ActionQueueProjectProcessorsService) => {
          processors.setupProcessors();
          return {};
        },
        deps: [ActionQueueProjectProcessorsService],
      },
    ]);
    return { injector, resolveUserSession };
  }

  function processor(type: string): QueueProcessor {
    const registered = actionQueue.registerProcessor.mock.calls.find(call => call[0] === type)?.[1];
    if (!registered) {
      throw new Error(`Missing processor: ${type}`);
    }
    return registered as QueueProcessor;
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
      payload: {
        projectId,
        userId: 'user-1',
        sourceUserId: 'user-1',
        baseUpdatedAt: '2026-07-14T01:00:00.000Z',
      },
      timestamp: 1,
      retryCount: 0,
      ...overrides,
    };
  }

  function mutationAction(
    input: LocalHandoffIdentity,
    state: NonNullable<QueuedAction['localHandoff']>['state'],
    syncState: QueuedAction['syncState'],
  ): QueuedAction {
    return {
      id: input.actionId, operationId: input.operationId, syncState,
      localHandoff: { kind: 'resolved-project-conflict', state, ...input },
    } as QueuedAction;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    ownerStorageLoadListener = undefined;
    actionQueue.getCurrentQueueViewGeneration.mockReturnValue(1);
    actionQueue.getProjectMutationViewGeneration.mockReturnValue(0);
    actionQueue.isQueueViewCurrent.mockReturnValue(true);
    actionQueue.transitionLocalHandoffStrictlyForOwner.mockImplementation(async input => ({
      status: 'committed', action: mutationAction(input, input.nextState, 'held'),
    }));
    actionQueue.activateLocalHandoffStrictlyForOwner.mockImplementation(async input => ({
      status: 'committed', action: mutationAction(input, 'reserved', 'pending_sync'),
    }));
    actionQueue.settleProjectDeleteSuccessForOwner.mockResolvedValue(1);
    actionQueue.settleExactCurrentProjectDeleteSuccess.mockResolvedValue({ status: 'current', removedCount: 0 });
    actionQueue.enqueueForOwner.mockResolvedValue('queued-owner-action');
    auth.currentUserId.mockReturnValue('user-1');
    auth.captureAuthIdentityFence.mockReturnValue('auth-fence-a');
    userSession.getCurrentSessionGeneration.mockReturnValue(7);
    userSession.isSessionContextCurrent.mockReturnValue(true);
    projectState.getProject.mockReturnValue(undefined);
    projectSave.save.mockResolvedValue({ success: true, newVersion: 7 });
    projectDelete.deleteProjectFromCloud.mockResolvedValue({ ok: true, value: undefined });
    projectData.loadFullProjectOptimized.mockResolvedValue(null);
    taskSyncOps.deleteTask.mockResolvedValue(true);
    retryQueue.removeByProjectIdDurablyForOwner.mockResolvedValue(true);
    retryQueue.findItemForOwner.mockReturnValue(null);
    directSync.executeActivatedHandoff.mockResolvedValue({ status: 'applied' });
    setup();
    await flushRecoveryMicrotasks();
  });

  it('registers project mutation and delete processors', () => {
    expect(actionQueue.registerProcessor.mock.calls.map(call => call[0])).toEqual([
      'project:update',
      'project:delete',
      'project:create',
    ]);
  });

  it('does not resolve direct-sync while processors and recovery are constructed', () => {
    expect(resolveDirectSync).not.toHaveBeenCalled();
  });

  it('defers UserSession resolution until SyncCoordinator construction completes and recovers once', async () => {
    const project = createProject({ id: 'proj-startup-cycle' });
    const record = conflictRecord(project, true);
    vi.clearAllMocks();
    actionQueue.pendingActions.mockReturnValueOnce([projectAction('update', project, {
      id: 'action-startup-cycle', operationId: 'operation-startup-cycle', syncState: 'held',
      payload: { project, sourceUserId: 'user-1', conflictHandoff: { conflictRecord: record } },
      localHandoff: {
        kind: 'resolved-project-conflict', state: 'required', ownerUserId: 'user-1',
        projectId: project.id, actionId: 'action-startup-cycle', operationId: 'operation-startup-cycle',
        payloadDigest: 'payload-startup-cycle',
        conflictFingerprint: createProjectConflictRecordFingerprint(record),
      },
    })]);
    const { injector, resolveUserSession } = createStartupCycleInjector();

    expect(() => injector.get(SyncCoordinatorService)).not.toThrow();
    expect(resolveUserSession).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(actionQueue.processQueue).toHaveBeenCalledOnce());
    expect(resolveUserSession).toHaveBeenCalledOnce();
    expect(actionQueue.activateLocalHandoffStrictlyForOwner).toHaveBeenCalledWith(
      expect.objectContaining({ actionId: 'action-startup-cycle', operationId: 'operation-startup-cycle' }),
    );
  });

  it.each([
    ['owner', (_action: QueuedAction) => auth.currentUserId.mockReturnValue('user-2')],
    ['session', (_action: QueuedAction) => userSession.isSessionContextCurrent.mockReturnValue(false)],
    ['queue', (_action: QueuedAction) => actionQueue.isQueueViewCurrent.mockReturnValue(false)],
    ['empty reservation', (action: QueuedAction) => { action.localHandoff!.reservationId = ''; }],
    ['reservation', (action: QueuedAction) => { action.localHandoff!.reservationId = 'noncanonical'; }],
  ])('deferred startup recovery schedules zero when %s identity or reservation mismatches', async (_name, makeStale) => {
    const project = createProject({ id: 'proj-startup-stale' });
    const record = conflictRecord(project, true);
    vi.clearAllMocks();
    const action = projectAction('update', project, {
      id: 'action-startup-stale', operationId: 'operation-startup-stale', syncState: 'held',
      payload: { project, sourceUserId: 'user-1', conflictHandoff: { conflictRecord: record } },
      localHandoff: {
        kind: 'resolved-project-conflict', state: 'required', ownerUserId: 'user-1',
        projectId: project.id, actionId: 'action-startup-stale', operationId: 'operation-startup-stale',
        payloadDigest: 'payload-startup-stale',
        conflictFingerprint: createProjectConflictRecordFingerprint(record),
      },
    });
    actionQueue.pendingActions.mockReturnValueOnce([action]);
    makeStale(action);
    const { injector } = createStartupCycleInjector();
    expect(() => injector.get(SyncCoordinatorService)).not.toThrow();
    await flushRecoveryMicrotasks();
    expect(conflictStorage.persistProjectConflictLocalHandoffRequirement).not.toHaveBeenCalled();
    expect(actionQueue.activateLocalHandoffStrictlyForOwner).not.toHaveBeenCalled();
    expect(actionQueue.processQueue).not.toHaveBeenCalled();
  });
  it('owner reload reconstructs durable conflict evidence before activating held A', async () => {
    const project = createProject({ id: 'proj-reload-handoff', name: 'Resolved after reload' });
    const record = conflictRecord(project, true);
    const fingerprint = createProjectConflictRecordFingerprint(record);
    actionQueue.pendingActions.mockReturnValueOnce([projectAction('update', project, {
      id: 'action-reload-a', operationId: 'operation-reload-a', syncState: 'held',
      payload: {
        project, sourceUserId: 'user-1',
        conflictHandoff: { conflictRecord: record },
      },
      localHandoff: {
        kind: 'resolved-project-conflict', state: 'required', ownerUserId: 'user-1',
        projectId: project.id, actionId: 'action-reload-a', operationId: 'operation-reload-a',
        payloadDigest: 'payload-reload-a', conflictFingerprint: fingerprint,
      },
    })]);

    expect(ownerStorageLoadListener).toBeTypeOf('function');
    ownerStorageLoadListener?.();
    await vi.waitFor(() => expect(actionQueue.processQueue).toHaveBeenCalledOnce());

    expect(conflictStorage.persistProjectConflictLocalHandoffRequirement).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerUserId: 'user-1', projectId: project.id, actionId: 'action-reload-a',
        operationId: 'operation-reload-a',
        conflictFingerprint: fingerprint,
        conflictRecord: expect.objectContaining({ projectId: project.id, ownerUserId: 'user-1' }),
      }),
    );
    expect(actionQueue.activateLocalHandoffStrictlyForOwner).toHaveBeenCalledWith(
      expect.objectContaining({ actionId: 'action-reload-a', operationId: 'operation-reload-a' }),
    );
  });

  it('recovers a held action when owner storage was already loaded before processor setup', async () => {
    const project = createProject({ id: 'proj-loaded-before-setup' });
    const record = conflictRecord(project, true);
    const fingerprint = createProjectConflictRecordFingerprint(record);
    vi.clearAllMocks();
    actionQueue.pendingActions.mockReturnValueOnce([projectAction('update', project, {
      id: 'action-loaded-before-setup', operationId: 'operation-loaded-before-setup', syncState: 'held',
      payload: { project, sourceUserId: 'user-1', conflictHandoff: { conflictRecord: record } },
      localHandoff: {
        kind: 'resolved-project-conflict', state: 'required', ownerUserId: 'user-1',
        projectId: project.id, actionId: 'action-loaded-before-setup',
        operationId: 'operation-loaded-before-setup', payloadDigest: 'payload-loaded-before-setup',
        conflictFingerprint: fingerprint,
      },
    })]);

    setup();

    await vi.waitFor(() => expect(actionQueue.processQueue).toHaveBeenCalledOnce());
    expect(conflictStorage.persistProjectConflictLocalHandoffRequirement).toHaveBeenCalledOnce();
    expect(actionQueue.activateLocalHandoffStrictlyForOwner).toHaveBeenCalledOnce();
  });

  it('owner reload Auth fence drift leaves held A inactive after requirement persistence', async () => {
    let resolveRequirement!: (value: { status: 'committed' }) => void;
    const requirement = new Promise<{ status: 'committed' }>(resolve => { resolveRequirement = resolve; });
    const project = createProject({ id: 'proj-reload-stale' });
    const record = conflictRecord(project);
    const fingerprint = createProjectConflictRecordFingerprint(record);
    conflictStorage.persistProjectConflictLocalHandoffRequirement.mockReturnValueOnce(requirement);
    actionQueue.pendingActions.mockReturnValueOnce([projectAction('update', project, {
      id: 'action-reload-stale', operationId: 'operation-reload-stale', syncState: 'held',
      payload: {
        project, sourceUserId: 'user-1',
        conflictHandoff: { conflictRecord: record },
      },
      localHandoff: {
        kind: 'resolved-project-conflict', state: 'required', ownerUserId: 'user-1',
        projectId: project.id, actionId: 'action-reload-stale', operationId: 'operation-reload-stale',
        payloadDigest: 'payload-reload-stale', conflictFingerprint: fingerprint,
      },
    })]);

    ownerStorageLoadListener?.();
    await vi.waitFor(() => expect(conflictStorage.persistProjectConflictLocalHandoffRequirement).toHaveBeenCalledOnce());
    auth.captureAuthIdentityFence.mockReturnValue('auth-fence-b');
    resolveRequirement({ status: 'committed' });
    await Promise.resolve();
    await Promise.resolve();

    expect(actionQueue.activateLocalHandoffStrictlyForOwner).not.toHaveBeenCalled();
    expect(actionQueue.processQueue).not.toHaveBeenCalled();
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

  it('project:update durable handoff completes local snapshot before publication and exact removal', async () => {
    const events: string[] = [];
    const leaseController = new AbortController();
    const project = createProject({ id: 'proj-handoff-success', name: 'Resolved A' });
    const record = conflictRecord(project, true);
    const action = projectAction('update', project, {
      id: 'action-handoff-a', operationId: 'operation-handoff-a',
      syncState: 'pending_sync',
      payload: { project, sourceUserId: 'user-1', conflictHandoff: { conflictRecord: record } },
      localHandoff: {
        kind: 'resolved-project-conflict', state: 'required', ownerUserId: 'user-1',
        projectId: project.id, actionId: 'action-handoff-a', operationId: 'operation-handoff-a',
        payloadDigest: 'payload-a', conflictFingerprint: 'fingerprint-a',
      },
    });
    projectData.saveOfflineSnapshotAndWait.mockImplementationOnce(async () => {
      events.push('snapshot');
    });
    projectState.updateProjects.mockImplementationOnce(() => events.push('publish'));
    conflictStorage.deleteCompletedProjectConflictLocalHandoff.mockImplementationOnce(async () => {
      events.push('clear-conflict');
      return { status: 'committed' };
    });
    actionQueue.removeCompletedLocalHandoffStrictlyForOwner.mockImplementationOnce(async () => {
      events.push('remove-action');
      return { status: 'committed' };
    });

    const result = await processor('project:update')(action, { leaseSignal: leaseController.signal });

    expect(result).toBe(true);
    expect(directSync.executeActivatedHandoff).toHaveBeenCalledWith(expect.objectContaining({
      action, abortSignal: leaseController.signal, ownerUserId: 'user-1',
      sessionGeneration: 7, authFence: 'auth-fence-a',
    }));
    expect(projectSave.save).not.toHaveBeenCalled();
    expect(taskSyncOps.deleteTask).not.toHaveBeenCalled();
    expect(events).toEqual(['snapshot', 'publish', 'clear-conflict', 'remove-action']);
    expect(actionQueue.removeCompletedLocalHandoffStrictlyForOwner).toHaveBeenCalledWith(
      expect.objectContaining({ actionId: action.id, operationId: action.operationId }),
    );
  });

  it('project:update canonical complete handoff performs strict cleanup without direct replay', async () => {
    const action = handoffAction(createProject({ id: 'proj-handoff-complete' }));
    const handoff = action.localHandoff;
    if (!handoff) throw new Error('Expected project handoff');
    handoff.state = 'complete';
    handoff.payloadDigest = createProjectConflictHandoffPayloadDigest(action.payload);
    handoff.reservationId = createProjectConflictHandoffReservationId(
      action.operationId, handoff.payloadDigest, handoff.conflictFingerprint,
    );
    conflictStorage.reserveProjectConflictLocalHandoff.mockResolvedValueOnce({ status: 'missing' });
    const result = await processor('project:update')(
      action, { leaseSignal: new AbortController().signal },
    );
    expect(result).toBe(true);
    expect(directSync.executeActivatedHandoff).not.toHaveBeenCalled();
    expect(projectData.saveOfflineSnapshotAndWait).not.toHaveBeenCalled();
    expect(projectState.updateProjects).not.toHaveBeenCalled();
    expect(actionQueue.removeCompletedLocalHandoffStrictlyForOwner).toHaveBeenCalledOnce();
  });

  it('project:update noncanonical complete handoff cannot replay or remove', async () => {
    const action = handoffAction(createProject({ id: 'proj-handoff-invalid-complete' }));
    const handoff = action.localHandoff;
    if (!handoff) throw new Error('Expected project handoff');
    handoff.state = 'complete';
    handoff.payloadDigest = createProjectConflictHandoffPayloadDigest(action.payload);
    handoff.reservationId = 'noncanonical';
    const result = await processor('project:update')(
      action, { leaseSignal: new AbortController().signal },
    );
    expect(result).toEqual(expect.objectContaining({ outcome: 'defer-retry' }));
    expect(directSync.executeActivatedHandoff).not.toHaveBeenCalled();
    expect(actionQueue.removeCompletedLocalHandoffStrictlyForOwner).not.toHaveBeenCalled();
  });

  it('project:update lease loss after snapshot suppresses publication and removal', async () => {
    const leaseController = new AbortController();
    const project = createProject({ id: 'proj-handoff-stale', name: 'Resolved A' });
    const record = conflictRecord(project, true);
    const action = projectAction('update', project, {
      id: 'action-handoff-stale', operationId: 'operation-handoff-stale',
      syncState: 'pending_sync',
      payload: { project, sourceUserId: 'user-1', conflictHandoff: { conflictRecord: record } },
      localHandoff: {
        kind: 'resolved-project-conflict', state: 'required', ownerUserId: 'user-1',
        projectId: project.id, actionId: 'action-handoff-stale', operationId: 'operation-handoff-stale',
        payloadDigest: 'payload-stale', conflictFingerprint: 'fingerprint-stale',
      },
    });
    projectData.saveOfflineSnapshotAndWait.mockImplementationOnce(async () => {
      leaseController.abort();
    });

    const result = await processor('project:update')(action, { leaseSignal: leaseController.signal });

    expect(result).toEqual(expect.objectContaining({ outcome: 'defer-retry' }));
    expect(projectState.updateProjects).not.toHaveBeenCalled();
    expect(conflictStorage.deleteCompletedProjectConflictLocalHandoff).not.toHaveBeenCalled();
    expect(actionQueue.removeCompletedLocalHandoffStrictlyForOwner).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined],
    ['aborted', (() => {
      const value = new AbortController();
      value.abort();
      return value.signal;
    })()],
  ])('project:update held A with %s lease signal retains A with zero route effects', async (_label, leaseSignal) => {
    const project = createProject({ id: 'proj-handoff-no-lease' });
    const record = conflictRecord(project, true);
    const action = projectAction('update', project, {
      payload: { project, sourceUserId: 'user-1', conflictHandoff: { conflictRecord: record } },
      localHandoff: {
        kind: 'resolved-project-conflict', state: 'required', ownerUserId: 'user-1',
        projectId: project.id, actionId: `action-update-${project.id}`,
        operationId: `op-update-${project.id}`, payloadDigest: 'payload-a',
        conflictFingerprint: createProjectConflictRecordFingerprint(record),
      },
    });

    const result = await processor('project:update')(action, { leaseSignal });

    expect(result).toEqual(expect.objectContaining({ outcome: 'defer-retry' }));
    expect(directSync.executeActivatedHandoff).not.toHaveBeenCalled();
    expect(projectSave.save).not.toHaveBeenCalled();
    expect(taskSyncOps.deleteTask).not.toHaveBeenCalled();
    expect(actionQueue.removeCompletedLocalHandoffStrictlyForOwner).not.toHaveBeenCalled();
  });
  it('project:update malformed held A retains evidence without public or raw routing', async () => {
    const project = createProject({ id: 'proj-handoff-malformed' });
    directSync.executeActivatedHandoff.mockResolvedValueOnce({ status: 'aborted' });
    const action = handoffAction(project);
    action.localHandoff!.reservationId = 'noncanonical';
    const result = await processor('project:update')(
      action, { leaseSignal: new AbortController().signal },
    );
    expect(result).toEqual(expect.objectContaining({ outcome: 'defer-retry' }));
    expect(directSync.executeActivatedHandoff).toHaveBeenCalledWith(expect.objectContaining({ action }));
    expect(projectSave.save).not.toHaveBeenCalled();
    expect(taskSyncOps.deleteTask).not.toHaveBeenCalled();
    expect(conflictStorage.reserveProjectConflictLocalHandoff).not.toHaveBeenCalled();
    expect(projectData.saveOfflineSnapshotAndWait).not.toHaveBeenCalled();
    expect(projectState.updateProjects).not.toHaveBeenCalled();
    expect(actionQueue.removeCompletedLocalHandoffStrictlyForOwner).not.toHaveBeenCalled();
  });

  it.each([
    ['conflict', () => directSync.executeActivatedHandoff.mockResolvedValueOnce({
      status: 'conflict', result: { status: 'remote-newer', raw: {} },
    })],
    ['partial', () => directSync.executeActivatedHandoff.mockResolvedValueOnce({
      status: 'partial', skippedIds: ['task-a'],
    })],
    ['settlement retry', () => conflictStorage.reserveProjectConflictLocalHandoff
      .mockResolvedValueOnce({ status: 'contended' })],
    ['settlement stale', () => directSync.executeActivatedHandoff.mockImplementationOnce(async () => {
      auth.captureAuthIdentityFence.mockReturnValue('auth-fence-b');
      return { status: 'applied' };
    })],
  ])('project:update held A retains exact action on %s', async (_label, arrange) => {
    const action = handoffAction(createProject({ id: 'proj-handoff-retained' }));
    arrange();

    const result = await processor('project:update')(
      action, { leaseSignal: new AbortController().signal },
    );

    expect(result).toEqual(expect.objectContaining({ outcome: 'defer-retry' }));
    expect(projectSave.save).not.toHaveBeenCalled();
    expect(actionQueue.removeCompletedLocalHandoffStrictlyForOwner).not.toHaveBeenCalled();
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
      '2026-07-14T01:00:00.000Z',
    );
    expect(actionQueue.settleExactCurrentProjectDeleteSuccess).toHaveBeenCalledWith(
      'user-1', 'proj-delete-queued',
      'action-delete-proj-delete-queued', 'op-delete-proj-delete-queued',
    );
    expect(retryQueue.removeByProjectIdDurablyForOwner).toHaveBeenCalledWith(
      'proj-delete-queued', 'user-1',
    );
    expect(actionQueue.markActionSyncedRemotely).toHaveBeenCalledWith('action-delete-proj-delete-queued');
  });

  it('project:delete 应透传 leaseSignal/isCurrent 与 operationId/baseUpdatedAt', async () => {
    const lease = new AbortController();
    const isCurrent = vi.fn(() => true);
    const action = projectDeleteAction('proj-delete-fenced');

    const result = await processor('project:delete')(action, {
      leaseSignal: lease.signal,
      isCurrent,
    });

    expect(result).toBe(true);
    expect(projectDelete.deleteProjectFromCloud).toHaveBeenCalledWith(
      'proj-delete-fenced',
      'user-1',
      'op-delete-proj-delete-fenced',
      '2026-07-14T01:00:00.000Z',
      { leaseSignal: lease.signal, isCurrent },
    );
  });

  it.each([
    ['stale before await', { leaseSignal: new AbortController().signal, isCurrent: vi.fn(() => false) }],
    ['aborted before await', (() => {
      const controller = new AbortController();
      controller.abort();
      return { leaseSignal: controller.signal, isCurrent: vi.fn(() => true) };
    })()],
  ])('project:delete %s leaves remote and local settlement untouched', async (_label, context) => {
    const action = projectDeleteAction('proj-delete-stale-before');

    const result = await processor('project:delete')(action, context);

    expect(result).toEqual(expect.objectContaining({ outcome: 'defer-retry' }));
    expect(projectDelete.deleteProjectFromCloud).not.toHaveBeenCalled();
    expect(retryQueue.removeByProjectIdDurablyForOwner).not.toHaveBeenCalled();
    expect(actionQueue.settleExactCurrentProjectDeleteSuccess).not.toHaveBeenCalled();
    expect(actionQueue.markActionSyncedRemotely).not.toHaveBeenCalled();
  });

  it('project:delete stale after awaited delete does not settle dependent queues or mark success', async () => {
    let current = true;
    const lease = new AbortController();
    const isCurrent = vi.fn(() => current);
    projectDelete.deleteProjectFromCloud.mockImplementationOnce(async () => {
      await Promise.resolve();
      current = false;
      return { ok: true, value: undefined };
    });
    const action = projectDeleteAction('proj-delete-stale-after');

    const result = await processor('project:delete')(action, {
      leaseSignal: lease.signal,
      isCurrent,
    });

    expect(result).toEqual(expect.objectContaining({ outcome: 'defer-retry' }));
    expect(retryQueue.removeByProjectIdDurablyForOwner).not.toHaveBeenCalled();
    expect(actionQueue.settleExactCurrentProjectDeleteSuccess).not.toHaveBeenCalled();
    expect(actionQueue.markActionSyncedRemotely).not.toHaveBeenCalled();
  });

  it('project:delete owner mismatch remains fail closed before remote delete', async () => {
    auth.currentUserId.mockReturnValue('user-2');
    const action = projectDeleteAction('proj-delete-owner-mismatch');

    const result = await processor('project:delete')(action, {
      leaseSignal: new AbortController().signal,
      isCurrent: vi.fn(() => true),
    });

    expect(result).toBe(true);
    expect(projectDelete.deleteProjectFromCloud).not.toHaveBeenCalled();
    expect(actionQueue.moveToDeadLetter).toHaveBeenCalledWith(
      action,
      expect.stringContaining('user-1'),
    );
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
    expect(actionQueue.settleExactCurrentProjectDeleteSuccess).not.toHaveBeenCalled();
    expect(actionQueue.markActionSyncedRemotely).not.toHaveBeenCalled();
  });
});
