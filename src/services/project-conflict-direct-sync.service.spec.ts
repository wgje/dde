import { Injector, runInInjectionContext } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ProjectDataService,
  ProjectDeleteCoordinatorService,
  ProjectSaveFlightCoordinatorService,
  RetryQueueService,
  TaskSyncOperationsService,
} from '../core-bridge';
import type { Connection, Project, Task } from '../models';
import {
  createProjectConnectionUpsertOperationId,
  createProjectTaskDeleteBatchOperationId,
  createProjectTaskUpsertOperationId,
} from './project-operation-child-operation-id';
import { createProjectConflictHandoffReservationId } from './project-operation-conflict-retry-settlement.controller';
import { ProjectConflictDirectSyncService } from './project-conflict-direct-sync.service';
import { ActionQueueProjectProcessorsService } from './action-queue-project-processors.service';
import { ActionQueueService } from './action-queue.service';
import type { LocalHandoffIdentity } from './action-queue-held-action.controller';
import { ActionQueueSyncWriterLeaseService } from './action-queue-sync-writer-lease.service';
import type { ProjectPayload, QueuedAction } from './action-queue.types';
import { AuthService } from './auth.service';
import {
  ConflictStorageService,
  createProjectConflictRecordFingerprint,
  type ConflictRecord,
} from './conflict-storage.service';
import { SyncRpcClientService, type SyncRpcResult } from './sync-rpc-client.service';
import { SyncWriterLeaseService, type LeaseHandle } from './sync-writer-lease.service';
import { UserSessionService } from './user-session.service';
import { LoggerService } from './logger.service';
import { ProjectStateService } from './project-state.service';
import { ToastService } from './toast.service';

describe('ProjectConflictDirectSyncService', () => {
  const calls: string[] = [];
  const rpc = {
    upsertProject: vi.fn(async () => applied()),
    upsertTask: vi.fn(async ({ task }: { task: Task }) => {
      calls.push(`task:${task.id}`);
      return applied();
    }),
    deleteTasks: vi.fn(async () => applied()),
    upsertConnection: vi.fn(async ({ connection }: { connection: Connection }) => {
      calls.push(`connection:${connection.id}`);
      return applied();
    }),
  };
  let service: ProjectConflictDirectSyncService;

  beforeEach(() => {
    vi.clearAllMocks();
    calls.length = 0;
    rpc.upsertProject.mockImplementation(async () => {
      calls.push('project');
      return applied();
    });
    rpc.upsertTask.mockImplementation(async ({ task }) => {
      calls.push(`task:${task.id}`);
      return applied();
    });
    rpc.deleteTasks.mockImplementation(async () => {
      calls.push('delete');
      return applied();
    });
    rpc.upsertConnection.mockImplementation(async ({ connection }) => {
      calls.push(`connection:${connection.id}`);
      return applied();
    });
    const injector = Injector.create({
      providers: [
        ProjectConflictDirectSyncService,
        { provide: SyncRpcClientService, useValue: rpc },
        { provide: ActionQueueService, useValue: {} },
        { provide: ConflictStorageService, useValue: {} },
        { provide: AuthService, useValue: {
          currentUserId: () => 'owner-a',
          captureAuthIdentityFence: () => 'fence-a',
        } },
        { provide: UserSessionService, useValue: {
          isSessionContextCurrent: (generation: number, userId: string) =>
            generation === 4 && userId === 'owner-a',
        } },
        { provide: SyncWriterLeaseService, useValue: {} },
      ],
    });
    service = runInInjectionContext(injector, () => injector.get(ProjectConflictDirectSyncService));
  });

  it('uses deterministic A child IDs and dependency-safe route order', async () => {
    const abortController = new AbortController();
    const input = request(abortController.signal);

    const result = await service.execute(input);

    expect(result.status).toBe('applied');
    expect(calls).toEqual(['project', 'task:task-a', 'task:task-b', 'delete', 'connection:connection-a']);
    expect(rpc.upsertProject).toHaveBeenCalledWith(expect.objectContaining({
      operationId: input.operationId,
      abortSignal: abortController.signal,
    }));
    expect(rpc.upsertTask).toHaveBeenNthCalledWith(1, expect.objectContaining({
      operationId: createProjectTaskUpsertOperationId(input.operationId, input.resolvedProject.id, input.resolvedProject.tasks[0]),
      abortSignal: abortController.signal,
    }));
    expect(rpc.deleteTasks).toHaveBeenCalledWith(expect.objectContaining({
      operationId: createProjectTaskDeleteBatchOperationId(
        input.operationId, input.resolvedProject.id, input.taskIdsToDelete,
        input.taskDeleteBaseUpdatedAtMap,
      ),
      abortSignal: abortController.signal,
    }));
    expect(rpc.upsertConnection).toHaveBeenCalledWith(expect.objectContaining({
      operationId: createProjectConnectionUpsertOperationId(
        input.operationId, input.resolvedProject.id, input.resolvedProject.connections[0],
      ),
      abortSignal: abortController.signal,
    }));
  });

  it('stops all child routes after project conflict', async () => {
    rpc.upsertProject.mockResolvedValueOnce(conflict());

    const result = await service.execute(request(new AbortController().signal));

    expect(result.status).toBe('conflict');
    expect(rpc.upsertTask).not.toHaveBeenCalled();
    expect(rpc.deleteTasks).not.toHaveBeenCalled();
    expect(rpc.upsertConnection).not.toHaveBeenCalled();
  });

  it('stops deletes and connections after task conflict', async () => {
    rpc.upsertTask.mockResolvedValueOnce(conflict());

    const result = await service.execute(request(new AbortController().signal));

    expect(result.status).toBe('conflict');
    expect(rpc.deleteTasks).not.toHaveBeenCalled();
    expect(rpc.upsertConnection).not.toHaveBeenCalled();
  });

  it('treats skipped task deletion as partial and suppresses connections', async () => {
    rpc.deleteTasks.mockResolvedValueOnce({ ...applied(), skippedIds: ['task-delete'] });

    const result = await service.execute(request(new AbortController().signal));

    expect(result).toEqual(expect.objectContaining({ status: 'partial', skippedIds: ['task-delete'] }));
    expect(rpc.upsertConnection).not.toHaveBeenCalled();
  });

  it('fails closed before the first route when the lease signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await service.execute(request(controller.signal));

    expect(result.status).toBe('aborted');
    expect(rpc.upsertProject).not.toHaveBeenCalled();
  });

  it('replays canonical activated A with its exact operation identity and granted signal', async () => {
    const controller = new AbortController();
    const input = activatedReplayRequest(controller.signal);

    await expect(service.executeActivatedHandoff(input)).resolves.toEqual({ status: 'applied' });

    expect(rpc.upsertProject).toHaveBeenCalledWith(expect.objectContaining({
      operationId: input.action.operationId,
      project: input.action.payload.project,
      abortSignal: controller.signal,
    }));
  });

  it('snapshots canonical activated payload and CAS inputs before the first awaited route', async () => {
    const projectGate = deferred<SyncRpcResult>();
    rpc.upsertProject.mockReturnValueOnce(projectGate.promise);
    const input = activatedReplayRequest(new AbortController().signal);
    const canonicalProject = structuredClone(input.action.payload.project);
    const canonicalDeleteMap = structuredClone(input.action.payload.taskDeleteBaseUpdatedAtMap!);
    const canonicalRemote = structuredClone(
      input.action.payload.conflictHandoff!.conflictRecord.remoteProject!,
    );
    const processing = service.executeActivatedHandoff(input);
    await vi.waitFor(() => expect(rpc.upsertProject).toHaveBeenCalledOnce());

    input.action.payload.project.tasks[0].title = 'drifted-task';
    input.action.payload.project.tasks.push(task('task-drift'));
    input.action.payload.taskIdsToDelete!.push('task-drift');
    input.action.payload.taskDeleteBaseUpdatedAtMap!['task-delete'] = 'drifted-cas';
    input.action.payload.conflictHandoff!.conflictRecord.remoteProject!.tasks[0].updatedAt = 'drifted-base';
    projectGate.resolve(applied());
    await expect(processing).resolves.toEqual({ status: 'applied' });

    expect(rpc.upsertTask).toHaveBeenCalledTimes(canonicalProject.tasks.length);
    expect(rpc.upsertTask).toHaveBeenNthCalledWith(1, expect.objectContaining({
      task: canonicalProject.tasks[0],
      baseUpdatedAt: canonicalRemote.tasks[0].updatedAt,
      operationId: createProjectTaskUpsertOperationId(
        input.action.operationId, canonicalProject.id, canonicalProject.tasks[0],
      ),
    }));
    expect(rpc.deleteTasks).toHaveBeenCalledWith(expect.objectContaining({
      taskIds: ['task-delete'], baseUpdatedAtMap: canonicalDeleteMap,
    }));
  });

  it('rejects malformed activated handoff evidence before any raw RPC', async () => {
    const input = activatedReplayRequest(new AbortController().signal);
    input.action.payload = { project: input.action.payload.project, sourceUserId: 'owner-a' };

    await expect(service.executeActivatedHandoff(input)).resolves.toEqual({ status: 'aborted' });

    expect(rpc.upsertProject).not.toHaveBeenCalled();
  });

  it.each([
    ['empty', ''],
    ['mismatched', 'reservation-from-another-operation'],
  ])('rejects an %s activated reservation before any raw RPC', async (_label, reservationId) => {
    const input = activatedReplayRequest(new AbortController().signal);
    input.action.localHandoff = {
      ...input.action.localHandoff!,
      reservationId,
    };

    await expect(service.executeActivatedHandoff(input)).resolves.toEqual({ status: 'aborted' });

    expect(rpc.upsertProject).not.toHaveBeenCalled();
  });

  it('rejects an activated handoff missing its canonical reservation before any raw RPC', async () => {
    const input = activatedReplayRequest(new AbortController().signal);
    delete input.action.localHandoff!.reservationId;

    await expect(service.executeActivatedHandoff(input)).resolves.toEqual({ status: 'aborted' });

    expect(rpc.upsertProject).not.toHaveBeenCalled();
  });

  it('registered project:update reaches the real direct preflight for missing reservation evidence', async () => {
    const leaseController = new AbortController();
    const input = activatedReplayRequest(leaseController.signal);
    delete input.action.localHandoff!.reservationId;
    const registerProcessor = vi.fn();
    const publicSave = vi.fn();
    const taskDelete = vi.fn();
    const reserve = vi.fn();
    const snapshot = vi.fn();
    const publish = vi.fn();
    const clearConflict = vi.fn();
    const remove = vi.fn();
    const queue = {
      registerProcessor,
      subscribeToOwnerStorageLoadStateChanges: vi.fn(() => vi.fn()),
      getCurrentOwnerStorageLoadState: vi.fn(() => 'loading'),
      pendingActions: vi.fn(() => []),
      getCurrentQueueViewGeneration: vi.fn(() => 1),
      getProjectMutationViewGeneration: vi.fn(() => 0),
      isQueueViewCurrent: vi.fn(() => true),
      getPendingActionsForProject: vi.fn(() => []),
      deferRetry: vi.fn(error => ({ outcome: 'defer-retry' as const, error })),
      failRetry: vi.fn(error => ({ outcome: 'defer-retry' as const, error })),
      removeCompletedLocalHandoffStrictlyForOwner: remove,
    };
    const injector = Injector.create({ providers: [
      ActionQueueProjectProcessorsService,
      { provide: ActionQueueService, useValue: queue },
      { provide: ActionQueueSyncWriterLeaseService, useValue: { acquire: vi.fn() } },
      { provide: LoggerService, useValue: { category: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) } },
      { provide: TaskSyncOperationsService, useValue: { deleteTask: taskDelete } },
      { provide: ProjectSaveFlightCoordinatorService, useValue: { save: publicSave } },
      { provide: ProjectDeleteCoordinatorService, useValue: {} },
      { provide: ProjectDataService, useValue: { saveOfflineSnapshotAndWait: snapshot } },
      { provide: RetryQueueService, useValue: {} },
      { provide: ProjectStateService, useValue: { getProject: vi.fn(() => undefined), getProjectsWithCurrentData: () => [], updateProjects: publish } },
      { provide: AuthService, useValue: { currentUserId: () => 'owner-a', captureAuthIdentityFence: () => 'fence-a' } },
      { provide: UserSessionService, useValue: { getCurrentSessionGeneration: () => 4, isSessionContextCurrent: () => true } },
      { provide: ConflictStorageService, useValue: { reserveProjectConflictLocalHandoff: reserve, deleteCompletedProjectConflictLocalHandoff: clearConflict } },
      { provide: ToastService, useValue: {} },
      { provide: ProjectConflictDirectSyncService, useValue: service },
    ] });
    const processors = runInInjectionContext(injector, () => injector.get(ActionQueueProjectProcessorsService));
    processors.setupProcessors();
    const processor = registerProcessor.mock.calls.find(call => call[0] === 'project:update')?.[1];
    if (!processor) throw new Error('Missing registered project:update processor');

    const result = await processor(input.action, { leaseSignal: leaseController.signal });

    expect(result).toEqual(expect.objectContaining({ outcome: 'defer-retry' }));
    for (const effect of [rpc.upsertProject, rpc.upsertTask, rpc.deleteTasks, rpc.upsertConnection,
      publicSave, taskDelete, reserve, snapshot, publish, clearConflict, remove]) expect(effect).not.toHaveBeenCalled();
  });
});

describe('ProjectConflictDirectSyncService durable handoff', () => {
  const owner = { userId: 'owner-a', generation: 4, authFence: 'fence-a' };
  const rpc = {
    upsertProject: vi.fn(async () => applied()),
    upsertTask: vi.fn(async () => applied()),
    deleteTasks: vi.fn(async () => applied()),
    upsertConnection: vi.fn(async () => applied()),
  };
  const actionQueue = {
    enqueueHeldDurablyForOwner: vi.fn(),
    transitionLocalHandoffStrictlyForOwner: vi.fn(),
    activateLocalHandoffStrictlyForOwner: vi.fn(),
    processQueue: vi.fn(),
  };
  const conflictStorage = {
    persistProjectConflictLocalHandoffRequirement: vi.fn(),
    reserveProjectConflictLocalHandoff: vi.fn(),
  };
  const auth = {
    currentUserId: vi.fn((): string | null => owner.userId),
    captureAuthIdentityFence: vi.fn(() => owner.authFence),
  };
  const session = {
    currentUserId: vi.fn((): string => owner.userId),
    getCurrentSessionGeneration: vi.fn(() => owner.generation),
    isSessionContextCurrent: vi.fn((generation: number, userId: string) =>
      generation === owner.generation && userId === owner.userId),
  };
  const writerLease = { requestLease: vi.fn() };
  const settlement = vi.fn();
  let service: ProjectConflictDirectSyncService;

  beforeEach(() => {
    vi.clearAllMocks();
    owner.userId = 'owner-a';
    owner.generation = 4;
    owner.authFence = 'fence-a';
    actionQueue.enqueueHeldDurablyForOwner.mockResolvedValue({
      actionId: 'action-a', operationId: '11111111-1111-4111-8111-111111111111',
    });
    actionQueue.activateLocalHandoffStrictlyForOwner.mockImplementation(async input => ({
      status: 'committed' as const, action: handoffMutationAction(input, 'reserved', 'pending_sync'),
    }));
    actionQueue.transitionLocalHandoffStrictlyForOwner.mockImplementation(async input => ({
      status: 'committed' as const, action: handoffMutationAction(input, input.nextState, 'held'),
    }));
    actionQueue.processQueue.mockResolvedValue(undefined);
    conflictStorage.persistProjectConflictLocalHandoffRequirement.mockResolvedValue({ status: 'committed' });
    conflictStorage.reserveProjectConflictLocalHandoff.mockImplementation(async input => ({
      status: 'committed' as const, reservationId: input.reservationId,
    }));
    writerLease.requestLease.mockResolvedValue(lease());
    settlement.mockResolvedValue('complete');
    const injector = Injector.create({ providers: [
      ProjectConflictDirectSyncService,
      { provide: SyncRpcClientService, useValue: rpc },
      { provide: ActionQueueService, useValue: actionQueue },
      { provide: ConflictStorageService, useValue: conflictStorage },
      { provide: AuthService, useValue: auth },
      { provide: UserSessionService, useValue: session },
      { provide: SyncWriterLeaseService, useValue: writerLease },
    ] });
    service = runInInjectionContext(injector, () => injector.get(ProjectConflictDirectSyncService));
  });

  it('uses the canonical held receipt through lease, RPC and strict settlement', async () => {
    const result = await service.executeDurably(durableRequest(), settlement);

    expect(result).toEqual({ status: 'complete' });
    expect(actionQueue.enqueueHeldDurablyForOwner).toHaveBeenCalledWith(
      'owner-a', expect.objectContaining({ type: 'update', entityId: 'project-a' }), expect.any(Object),
    );
    expect(actionQueue.enqueueHeldDurablyForOwner.mock.calls[0]?.[1]).not.toHaveProperty('operationId');
    expect(writerLease.requestLease).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'owner-a', projectId: 'project-a',
    }));
    expect(rpc.upsertProject).toHaveBeenCalledWith(expect.objectContaining({
      operationId: '11111111-1111-4111-8111-111111111111',
    }));
    expect(settlement).toHaveBeenCalledWith(expect.objectContaining({
      actionId: 'action-a', operationId: '11111111-1111-4111-8111-111111111111',
      ownerUserId: 'owner-a', sessionGeneration: 4, authFence: 'fence-a',
    }), expect.any(Function));
  });

  it('rejects a memory-only lease and activates durable A without cloud effects', async () => {
    writerLease.requestLease.mockResolvedValueOnce(lease('memory-only'));

    await expect(service.executeDurably(durableRequest(), settlement))
      .resolves.toEqual({ status: 'deferred' });

    expect(rpc.upsertProject).not.toHaveBeenCalled();
    expect(settlement).not.toHaveBeenCalled();
    expect(conflictStorage.reserveProjectConflictLocalHandoff).toHaveBeenCalledOnce();
    expect(actionQueue.transitionLocalHandoffStrictlyForOwner).toHaveBeenCalledWith(
      expect.objectContaining({ expectedState: 'required', nextState: 'reserved' }),
    );
    expect(actionQueue.activateLocalHandoffStrictlyForOwner).toHaveBeenCalledOnce();
    expect(conflictStorage.reserveProjectConflictLocalHandoff.mock.invocationCallOrder[0])
      .toBeLessThan(actionQueue.transitionLocalHandoffStrictlyForOwner.mock.invocationCallOrder[0]);
    expect(actionQueue.transitionLocalHandoffStrictlyForOwner.mock.invocationCallOrder[0])
      .toBeLessThan(actionQueue.activateLocalHandoffStrictlyForOwner.mock.invocationCallOrder[0]);
    expect(actionQueue.processQueue).toHaveBeenCalledOnce();
  });

  it('A to B after held persistence leaves A held with zero later effects', async () => {
    const held = deferred<{ actionId: string; operationId: string } | null>();
    actionQueue.enqueueHeldDurablyForOwner.mockReturnValueOnce(held.promise);

    const resultPromise = service.executeDurably(durableRequest(), settlement);
    owner.userId = 'owner-b';
    owner.generation = 5;
    owner.authFence = 'fence-b';
    held.resolve({ actionId: 'action-a', operationId: '11111111-1111-4111-8111-111111111111' });

    await expect(resultPromise).resolves.toEqual({ status: 'stale' });
    expect(conflictStorage.persistProjectConflictLocalHandoffRequirement).not.toHaveBeenCalled();
    expect(writerLease.requestLease).not.toHaveBeenCalled();
    expect(rpc.upsertProject).not.toHaveBeenCalled();
    expect(actionQueue.activateLocalHandoffStrictlyForOwner).not.toHaveBeenCalled();
    expect(settlement).not.toHaveBeenCalled();
  });

  it.each([
    ['A to B to A', () => {
      owner.userId = 'owner-b'; owner.generation = 5; owner.authFence = 'fence-b';
      owner.userId = 'owner-a';
    }],
    ['same-owner relogin', () => {
      owner.generation = 5; owner.authFence = 'fence-relogin';
    }],
  ])('%s after held persistence leaves A held with zero later effects', async (_label, changeIdentity) => {
    const held = deferred<{ actionId: string; operationId: string } | null>();
    actionQueue.enqueueHeldDurablyForOwner.mockReturnValueOnce(held.promise);

    const resultPromise = service.executeDurably(durableRequest(), settlement);
    changeIdentity();
    held.resolve({ actionId: 'action-a', operationId: '11111111-1111-4111-8111-111111111111' });

    await expect(resultPromise).resolves.toEqual({ status: 'stale' });
    expect(conflictStorage.persistProjectConflictLocalHandoffRequirement).not.toHaveBeenCalled();
    expect(writerLease.requestLease).not.toHaveBeenCalled();
    expect(rpc.upsertProject).not.toHaveBeenCalled();
    expect(settlement).not.toHaveBeenCalled();
  });

  it.each([
    ['owner', () => { owner.userId = 'owner-b'; }],
    ['session generation', () => { owner.generation = 5; }],
    ['opaque Auth fence', () => { owner.authFence = 'fence-relogin'; }],
  ])('%s drift after project await suppresses all child routes', async (_label, drift) => {
    const projectResult = deferred<SyncRpcResult>();
    const input = durableRequestWithRoutes();
    rpc.upsertProject.mockReturnValueOnce(projectResult.promise);

    const resultPromise = service.executeDurably(input, settlement);
    await vi.waitFor(() => expect(rpc.upsertProject).toHaveBeenCalledOnce());
    drift();
    projectResult.resolve(applied());

    await expect(resultPromise).resolves.toEqual({ status: 'stale' });
    expect(rpc.upsertProject).toHaveBeenCalledWith(expect.objectContaining({
      operationId: '11111111-1111-4111-8111-111111111111',
    }));
    expect(rpc.upsertTask).not.toHaveBeenCalled();
    expect(rpc.deleteTasks).not.toHaveBeenCalled();
    expect(rpc.upsertConnection).not.toHaveBeenCalled();
    expect(settlement).not.toHaveBeenCalled();
    expect(actionQueue.activateLocalHandoffStrictlyForOwner).not.toHaveBeenCalled();
    expect(actionQueue.processQueue).not.toHaveBeenCalled();
  });

  it('opaque Auth drift after task await suppresses later tasks, deletes and connections', async () => {
    const taskResult = deferred<SyncRpcResult>();
    const input = durableRequestWithRoutes();
    rpc.upsertTask.mockReturnValueOnce(taskResult.promise);

    const resultPromise = service.executeDurably(input, settlement);
    await vi.waitFor(() => expect(rpc.upsertTask).toHaveBeenCalledOnce());
    owner.authFence = 'fence-relogin';
    taskResult.resolve(applied());

    await expect(resultPromise).resolves.toEqual({ status: 'stale' });
    expect(rpc.upsertTask).toHaveBeenCalledWith(expect.objectContaining({
      operationId: createProjectTaskUpsertOperationId(
        '11111111-1111-4111-8111-111111111111',
        input.resolvedProject.id,
        input.resolvedProject.tasks[0],
      ),
    }));
    expect(rpc.upsertTask).toHaveBeenCalledOnce();
    expect(rpc.deleteTasks).not.toHaveBeenCalled();
    expect(rpc.upsertConnection).not.toHaveBeenCalled();
    expect(settlement).not.toHaveBeenCalled();
    expect(actionQueue.activateLocalHandoffStrictlyForOwner).not.toHaveBeenCalled();
    expect(actionQueue.processQueue).not.toHaveBeenCalled();
  });

  it('session drift after delete await suppresses connection routes', async () => {
    const deleteResult = deferred<SyncRpcResult>();
    const input = durableRequestWithRoutes();
    rpc.deleteTasks.mockReturnValueOnce(deleteResult.promise);

    const resultPromise = service.executeDurably(input, settlement);
    await vi.waitFor(() => expect(rpc.deleteTasks).toHaveBeenCalledOnce());
    owner.generation = 5;
    deleteResult.resolve(applied());

    await expect(resultPromise).resolves.toEqual({ status: 'stale' });
    expect(rpc.deleteTasks).toHaveBeenCalledWith(expect.objectContaining({
      operationId: createProjectTaskDeleteBatchOperationId(
        '11111111-1111-4111-8111-111111111111',
        input.resolvedProject.id,
        input.taskIdsToDelete,
        input.taskDeleteBaseUpdatedAtMap,
      ),
    }));
    expect(rpc.upsertConnection).not.toHaveBeenCalled();
    expect(settlement).not.toHaveBeenCalled();
    expect(actionQueue.activateLocalHandoffStrictlyForOwner).not.toHaveBeenCalled();
    expect(actionQueue.processQueue).not.toHaveBeenCalled();
  });

  it('background mode returns queued after handoff evidence and before remote completion', async () => {
    const remote = deferred<SyncRpcResult>();
    rpc.upsertProject.mockReturnValueOnce(remote.promise);

    await expect(service.executeDurably({ ...durableRequest(), background: true }, settlement))
      .resolves.toEqual({ status: 'queued' });

    expect(conflictStorage.persistProjectConflictLocalHandoffRequirement).toHaveBeenCalledOnce();
    expect(rpc.upsertProject).toHaveBeenCalledOnce();
    expect(settlement).not.toHaveBeenCalled();
    remote.resolve(applied());
    await vi.waitFor(() => expect(settlement).toHaveBeenCalledOnce());
  });

  it('lease loss during RPC suppresses settlement and local publication', async () => {
    const controller = new AbortController();
    const remote = deferred<SyncRpcResult>();
    writerLease.requestLease.mockResolvedValueOnce(lease('idb-lease', controller));
    rpc.upsertProject.mockReturnValueOnce(remote.promise);

    const resultPromise = service.executeDurably(durableRequestWithRoutes(), settlement);
    await vi.waitFor(() => expect(rpc.upsertProject).toHaveBeenCalledOnce());
    controller.abort();
    remote.resolve(applied());

    await expect(resultPromise).resolves.toEqual({ status: 'stale' });
    expect(rpc.upsertTask).not.toHaveBeenCalled();
    expect(rpc.deleteTasks).not.toHaveBeenCalled();
    expect(rpc.upsertConnection).not.toHaveBeenCalled();
    expect(settlement).not.toHaveBeenCalled();
    expect(actionQueue.activateLocalHandoffStrictlyForOwner).not.toHaveBeenCalled();
  });

  it('activates exact A and schedules normal replay once when settlement requests retry', async () => {
    settlement.mockResolvedValueOnce('retry');

    await expect(service.executeDurably(durableRequest(), settlement))
      .resolves.toEqual({ status: 'deferred' });

    expect(actionQueue.activateLocalHandoffStrictlyForOwner).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerUserId: 'owner-a', projectId: 'project-a', actionId: 'action-a',
        operationId: '11111111-1111-4111-8111-111111111111',
      }),
    );
    expect(actionQueue.activateLocalHandoffStrictlyForOwner).toHaveBeenCalledOnce();
    expect(actionQueue.processQueue).toHaveBeenCalledOnce();
  });
  it('retains A when settlement retry cannot restore conflict reservation', async () => {
    settlement.mockResolvedValueOnce('retry');
    conflictStorage.reserveProjectConflictLocalHandoff.mockResolvedValueOnce({ status: 'missing' });
    await expect(service.executeDurably(durableRequest(), settlement)).resolves.toEqual({ status: 'deferred' });
    expect(actionQueue.transitionLocalHandoffStrictlyForOwner).not.toHaveBeenCalled();
    expect(actionQueue.activateLocalHandoffStrictlyForOwner).not.toHaveBeenCalled();
    expect(actionQueue.processQueue).not.toHaveBeenCalled();
  });

  it('leaves A held when settlement retry becomes stale', async () => {
    settlement.mockImplementationOnce(async () => {
      owner.authFence = 'fence-relogin';
      return 'retry';
    });

    await expect(service.executeDurably(durableRequest(), settlement))
      .resolves.toEqual({ status: 'stale' });

    expect(actionQueue.activateLocalHandoffStrictlyForOwner).not.toHaveBeenCalled();
    expect(actionQueue.processQueue).not.toHaveBeenCalled();
  });

  it.each(['storage-failed', 'identity-mismatch'] as const)(
    'leaves A held when settlement retry activation returns %s',
    async status => {
      settlement.mockResolvedValueOnce('retry');
      actionQueue.activateLocalHandoffStrictlyForOwner.mockResolvedValueOnce({ status });

      await expect(service.executeDurably(durableRequest(), settlement))
        .resolves.toEqual({ status: 'deferred' });

      expect(actionQueue.activateLocalHandoffStrictlyForOwner).toHaveBeenCalledOnce();
      expect(actionQueue.processQueue).not.toHaveBeenCalled();
    },
  );

  it('leaves A held when settlement retry activation rejects', async () => {
    settlement.mockResolvedValueOnce('retry');
    actionQueue.activateLocalHandoffStrictlyForOwner.mockRejectedValueOnce(
      new Error('activation unavailable'),
    );

    await expect(service.executeDurably(durableRequest(), settlement))
      .resolves.toEqual({ status: 'deferred' });

    expect(actionQueue.activateLocalHandoffStrictlyForOwner).toHaveBeenCalledOnce();
    expect(actionQueue.processQueue).not.toHaveBeenCalled();
  });

  it('lease loss inside settlement invalidates its nested fence and returns stale', async () => {
    const controller = new AbortController();
    writerLease.requestLease.mockResolvedValueOnce(lease('idb-lease', controller));
    settlement.mockImplementationOnce(async (_input, isCurrent: () => boolean) => {
      expect(isCurrent()).toBe(true);
      controller.abort();
      expect(isCurrent()).toBe(false);
      return 'stale';
    });

    await expect(service.executeDurably(durableRequest(), settlement))
      .resolves.toEqual({ status: 'stale' });

    expect(settlement).toHaveBeenCalledOnce();
    expect(actionQueue.activateLocalHandoffStrictlyForOwner).not.toHaveBeenCalled();
  });
});

function durableRequest() {
  const resolvedProject = project({ id: 'project-a', tasks: [], connections: [] });
  const remoteProject = project({ id: 'project-a', tasks: [], connections: [], version: 3 });
  const conflictRecord: ConflictRecord = {
    projectId: 'project-a', ownerUserId: 'owner-a', localProject: resolvedProject,
    remoteProject, remoteSnapshotFresh: true, conflictedAt: '2026-07-29T00:00:00.000Z',
    localVersion: 4, remoteVersion: 3, reason: 'version_mismatch', acknowledged: false,
  };
  return {
    resolvedProject, remoteProject, ownerUserId: 'owner-a', sessionGeneration: 4,
    authFence: 'fence-a', conflictRecord, taskIdsToDelete: [], taskDeleteBaseUpdatedAtMap: {},
    background: false,
  };
}

function durableRequestWithRoutes() {
  const resolvedProject = project();
  const remoteProject = project({
    tasks: resolvedProject.tasks.map(item => ({ ...item, updatedAt: `base-${item.id}` })),
    connections: resolvedProject.connections.map(item => ({ ...item, updatedAt: `base-${item.id}` })),
    version: 3,
  });
  const input = durableRequest();
  return {
    ...input,
    resolvedProject,
    remoteProject,
    conflictRecord: {
      ...input.conflictRecord,
      localProject: resolvedProject,
      remoteProject,
    },
    taskIdsToDelete: ['task-delete'],
    taskDeleteBaseUpdatedAtMap: { 'task-delete': '2026-07-29T00:00:00.000Z' },
  };
}

function lease(
  mode: LeaseHandle['mode'] = 'idb-lease',
  controller = new AbortController(),
): LeaseHandle {
  return {
    mode, signal: controller.signal, tabId: 'tab-a', lockName: 'lease-a', release: vi.fn(),
  };
}

function handoffMutationAction(
  input: LocalHandoffIdentity,
  state: NonNullable<QueuedAction['localHandoff']>['state'],
  syncState: QueuedAction['syncState'],
): QueuedAction {
  return {
    id: input.actionId, operationId: input.operationId, syncState,
    localHandoff: {
      kind: 'resolved-project-conflict', state,
      ownerUserId: input.ownerUserId, projectId: input.projectId,
      actionId: input.actionId, operationId: input.operationId,
      payloadDigest: input.payloadDigest, conflictFingerprint: input.conflictFingerprint,
      reservationId: input.reservationId,
    },
  } as QueuedAction;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

function request(abortSignal: AbortSignal) {
  const resolvedProject = project();
  return {
    resolvedProject,
    remoteProject: project({
      tasks: resolvedProject.tasks.map(task => ({ ...task, updatedAt: `base-${task.id}` })),
      connections: resolvedProject.connections.map(connection => ({ ...connection, updatedAt: `base-${connection.id}` })),
    }),
    ownerUserId: 'owner-a',
    sessionGeneration: 4,
    authFence: 'fence-a',
    operationId: '11111111-1111-4111-8111-111111111111',
    taskIdsToDelete: ['task-delete'],
    taskDeleteBaseUpdatedAtMap: { 'task-delete': '2026-07-29T00:00:00.000Z' },
    abortSignal,
  };
}

function activatedReplayRequest(abortSignal: AbortSignal) {
  const resolvedProject = project();
  const conflictRecord: ConflictRecord = {
    projectId: resolvedProject.id, ownerUserId: 'owner-a', localProject: resolvedProject,
    remoteProject: project({ version: 3 }), remoteSnapshotFresh: true,
    conflictedAt: '2026-07-29T00:00:00.000Z', localVersion: 5, remoteVersion: 3,
    reason: 'version_mismatch', acknowledged: false,
  };
  const payload: ProjectPayload = {
    project: resolvedProject, sourceUserId: 'owner-a', taskIdsToDelete: ['task-delete'],
    taskDeleteBaseUpdatedAtMap: { 'task-delete': '2026-07-29T00:00:00.000Z' },
    conflictHandoff: { conflictRecord },
  };
  const operationId = '11111111-1111-4111-8111-111111111111';
  const payloadDigest = stableStringify(payload);
  const conflictFingerprint = createProjectConflictRecordFingerprint(conflictRecord);
  const action: QueuedAction<ProjectPayload> = {
    id: 'action-a', operationId,
    type: 'update', entityType: 'project', entityId: resolvedProject.id,
    payload, timestamp: 1, syncState: 'syncing', retryCount: 0,
    localHandoff: {
      kind: 'resolved-project-conflict', state: 'reserved', ownerUserId: 'owner-a',
      projectId: resolvedProject.id, actionId: 'action-a',
      operationId, payloadDigest, conflictFingerprint,
      reservationId: createProjectConflictHandoffReservationId(
        operationId, payloadDigest, conflictFingerprint,
      ),
    },
  };
  return {
    action, ownerUserId: 'owner-a', sessionGeneration: 4,
    authFence: 'fence-a', abortSignal,
  };
}

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-a', name: 'Resolved', description: '',
    createdDate: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-29T00:01:00.000Z', version: 5,
    tasks: [task('task-a'), task('task-b')],
    connections: [connection('connection-a')],
    ...overrides,
  };
}

function task(id: string): Task {
  return {
    id, title: id, content: '', stage: 1, parentId: null, order: 1, rank: 1000,
    status: 'active', x: 0, y: 0, createdDate: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-29T00:01:00.000Z', displayId: id,
  };
}

function connection(id: string): Connection {
  return {
    id, source: 'task-a', target: 'task-b',
    updatedAt: '2026-07-29T00:01:00.000Z',
  };
}

function applied(): SyncRpcResult {
  return { status: 'applied', raw: {} };
}

function conflict(): SyncRpcResult {
  return { status: 'remote-newer', raw: {} };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort()
      .map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}
