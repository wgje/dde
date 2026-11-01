import { describe, expect, it, vi, type Mock } from 'vitest';

import type { Task } from '../models';
import {
  createRetryQueueServiceSpecHarness,
  type RetryQueueServiceSpecHarness,
} from '../app/core/services/sync/retry-queue-service.spec-fixture';
import type { RetryQueueService } from '../app/core/services/sync/retry-queue.service';
import type { PersistedRetryQueueItem } from '../app/core/services/sync/retry-queue.types';
import { buildActionQueuePayloadSignature } from './action-queue-identity.helpers';
import type { QueueProcessorContext } from './action-queue-processing.types';
import { buildAuthPendingRetryError, buildTaskSyncRetryError } from './action-queue-retry-errors';
import type { QueueRetryError } from './action-queue-storage.service';
import {
  getProcessor,
  mockActionQueueService,
  mockAuthService,
  mockConflictStorageService,
  mockProjectStateService,
  mockSyncService,
  mockToastService,
  mockUserSessionService,
  type QueuedAction,
} from './action-queue-processors.spec-helpers';

type TaskReplayInput = {
  actionId: string;
  actionOperationId: string;
  task: Task;
  projectId: string;
  sourceUserId: string;
  writeIntent?: string;
  leaseSignal: AbortSignal;
  isFenceCurrent: () => boolean;
};

type TaskReplayResult =
  | { outcome: 'applied' | 'handoff' | 'stale' | 'deferred' }
  | { outcome: 'conflict'; error: unknown };

type TaskReplayRetryQueue = RetryQueueService & {
  commitTaskReplay(input: TaskReplayInput & { payloadSignature: string }): Promise<{
    status: 'current' | 'committed' | 'deferred';
  }>;
};

type TaskReplayFailureInput = {
  actionType: 'task:create' | 'task:update';
  taskId: string;
  projectId: string;
};

type TaskReplayProcessorFailureCase = {
  label: string;
  source: 'returned' | 'thrown';
  createFailure(input: TaskReplayFailureInput): QueueRetryError;
  retryCount: number;
  syncState: 'syncing' | 'retry_scheduled' | 'blocked_by_auth';
};

export const taskReplayProcessorFailureCases = [
  exactTaskFailureCase('returned exact task failure', 'returned'),
  exactTaskFailureCase('synchronous exact task failure', 'thrown'),
  exactAuthFailureCase('synchronous exact auth pending'),
  mismatchedTaskFailureCase('taskId', ({ taskId }) => `${taskId}-other`),
  mismatchedTaskFailureCase('projectId', ({ projectId }) => `${projectId}-other`),
  mismatchedAuthFailureCase('entityId', ({ taskId }) => `${taskId}-other`),
  mismatchedTaskFailureCase('reason', () => 'forged-task-reason'),
  mismatchedTaskFailureCase('actionType', () => 'task:create'),
  {
    label: 'synchronous arbitrary error',
    source: 'thrown',
    createFailure: () => new Error('arbitrary synchronous failure'),
    retryCount: 1,
    syncState: 'retry_scheduled',
  },
] satisfies readonly TaskReplayProcessorFailureCase[];

export const mockPushTaskFromActionQueue = vi.fn() as Mock<
  (input: TaskReplayInput) => Promise<TaskReplayResult>
>;

export function resetActionQueueTaskReplayMocks(): void {
  mockPushTaskFromActionQueue.mockReset();
  mockPushTaskFromActionQueue.mockImplementation(async input => {
    const pushed = await mockSyncService.pushTask(
      input.task, input.projectId, false, false, input.sourceUserId, true,
      input.writeIntent, input.actionOperationId,
    );
    return pushed ? { outcome: 'applied' } : { outcome: 'deferred' };
  });
  (mockSyncService as typeof mockSyncService & {
    pushTaskFromActionQueue: typeof mockPushTaskFromActionQueue;
  }).pushTaskFromActionQueue = mockPushTaskFromActionQueue;
}

export function registerActionQueueProcessorsTaskReplayFenceSpecs(): void {
  describe('task ActionQueue replay fence', () => {
    it('defers a durable replay when the processor context is absent', async () => {
      const action = createTaskAction('missing-context');
      action.payload.sourceUserId = 'other-user';

      const result = await getProcessor('task:update')(action, undefined);

      expect(result).toEqual(expect.objectContaining({ outcome: 'defer-retry' }));
      expect(mockPushTaskFromActionQueue).not.toHaveBeenCalled();
      expect(mockActionQueueService.moveToDeadLetter).not.toHaveBeenCalled();
      expect(mockActionQueueService.markActionSyncedRemotely).not.toHaveBeenCalled();
    });

    it('passes the exact action identity and writer lease into the queue-only entry', async () => {
      const action = createTaskAction('exact-input');
      const context = createProcessorContext();
      mockPushTaskFromActionQueue.mockResolvedValueOnce({ outcome: 'applied' });

      await expect(getProcessor('task:update')(action, context)).resolves.toBe(true);

      expect(mockPushTaskFromActionQueue).toHaveBeenCalledWith(expect.objectContaining({
        actionId: action.id,
        actionOperationId: action.operationId,
        task: action.payload.task,
        projectId: action.payload.projectId,
        sourceUserId: action.payload.sourceUserId,
        writeIntent: action.payload.writeIntent,
        leaseSignal: context.leaseSignal,
        isFenceCurrent: expect.any(Function),
      }));
      expect(mockActionQueueService.markActionSyncedRemotely).toHaveBeenCalledWith(action.id);
    });

    it.each([
      ['owner', () => mockAuthService.currentUserId.mockReturnValue('other-user')],
      ['auth', () => mockAuthService.captureAuthIdentityFence.mockReturnValue('other-fence')],
      ['session', () => mockUserSessionService.isSessionContextCurrent.mockReturnValue(false)],
      ['queue', () => mockActionQueueService.isQueueViewCurrent.mockReturnValue(false)],
      ['project', () => mockActionQueueService.getProjectMutationViewGeneration.mockReturnValue(2)],
    ])('publishes nothing after %s drift during the awaited queue-only call', async (_label, drift) => {
      const action = createTaskAction(`drift-${_label}`);
      mockPushTaskFromActionQueue.mockImplementationOnce(async input => {
        expect(input.isFenceCurrent()).toBe(true);
        drift();
        expect(input.isFenceCurrent()).toBe(false);
        return { outcome: 'applied' };
      });

      const result = await getProcessor('task:update')(action, createProcessorContext());

      expect(result).toEqual(expect.objectContaining({ outcome: 'defer-retry' }));
      expect(mockActionQueueService.markActionSyncedRemotely).not.toHaveBeenCalled();
      expect(mockActionQueueService.markActionResolvedWithoutRemote).not.toHaveBeenCalled();
      expect(mockToastService.warning).not.toHaveBeenCalled();
    });

    it('makes an action/payload drift sticky across A-to-B-to-A replacement', async () => {
      const action = createTaskAction('aba');
      const originalTitle = action.payload.task.title;
      mockPushTaskFromActionQueue.mockImplementationOnce(async input => {
        action.payload.task.title = 'replacement';
        expect(input.isFenceCurrent()).toBe(false);
        action.payload.task.title = originalTitle;
        expect(input.isFenceCurrent()).toBe(false);
        return { outcome: 'applied' };
      });

      const result = await getProcessor('task:update')(action, createProcessorContext());

      expect(result).toEqual(expect.objectContaining({ outcome: 'defer-retry' }));
      expect(mockActionQueueService.markActionSyncedRemotely).not.toHaveBeenCalled();
    });

    it('makes action type drift sticky across the awaited queue-only call', async () => {
      const action = createTaskAction('type-drift');
      mockPushTaskFromActionQueue.mockImplementationOnce(async input => {
        action.type = 'create';
        expect(input.isFenceCurrent()).toBe(false);
        return { outcome: 'applied' };
      });

      await expect(getProcessor('task:update')(action, createProcessorContext()))
        .resolves.toEqual(expect.objectContaining({ outcome: 'defer-retry' }));
      expect(mockActionQueueService.markActionSyncedRemotely).not.toHaveBeenCalled();
    });

    it('acknowledges only an authoritative handoff outcome, not RetryQueue memory', async () => {
      const action = createTaskAction('handoff');
      mockPushTaskFromActionQueue.mockResolvedValueOnce({ outcome: 'handoff' });

      await expect(getProcessor('task:update')(action, createProcessorContext())).resolves.toBe(true);

      expect(mockActionQueueService.markActionSyncedRemotely).not.toHaveBeenCalled();
    });

    it.each(taskReplayProcessorFailureCases.filter(({ source }) => source === 'thrown'))(
      'preserves original $label provenance from the registered processor',
      async ({ createFailure, label }) => {
        const action = createTaskAction(`thrown-${label}`);
        const failure = createFailure(taskReplayFailureInput(action));
        mockPushTaskFromActionQueue.mockImplementationOnce(() => { throw failure; });

        await expect(getProcessor('task:update')(action, createProcessorContext())).rejects.toBe(failure);

        expect(mockActionQueueService.deferRetry).not.toHaveBeenCalled();
        expect(mockActionQueueService.markActionSyncedRemotely).not.toHaveBeenCalled();
      },
    );

    it('preserves an exact returned deferred directive', async () => {
      const action = createTaskAction('returned-directive');
      const directive = mockActionQueueService.deferRetry(
        buildTaskSyncRetryError('task:update', action.payload.task.id, action.payload.projectId),
      );
      mockActionQueueService.deferRetry.mockClear().mockReturnValueOnce(directive);
      mockPushTaskFromActionQueue.mockResolvedValueOnce({ outcome: 'deferred' });

      await expect(getProcessor('task:update')(action, createProcessorContext())).resolves.toBe(directive);

      expect(mockActionQueueService.deferRetry).toHaveBeenCalledOnce();
    });

    it('defers a synchronous exception after the replay fence becomes stale', async () => {
      const action = createTaskAction('stale-throw');
      const failure = new Error('stale synchronous failure');
      mockPushTaskFromActionQueue.mockImplementationOnce(input => {
        mockAuthService.captureAuthIdentityFence.mockReturnValue('changed-fence');
        expect(input.isFenceCurrent()).toBe(false);
        throw failure;
      });

      await expect(getProcessor('task:update')(action, createProcessorContext()))
        .resolves.toEqual(expect.objectContaining({ outcome: 'defer-retry' }));

      expect(mockActionQueueService.deferRetry).toHaveBeenCalledOnce();
      expect(mockActionQueueService.markActionSyncedRemotely).not.toHaveBeenCalled();
      expect(mockActionQueueService.markActionResolvedWithoutRemote).not.toHaveBeenCalled();
      expect(mockConflictStorageService.saveConflict).not.toHaveBeenCalled();
      expect(mockToastService.warning).not.toHaveBeenCalled();
    });

    it('does not publish a conflict when the fence changes during conflict persistence', async () => {
      const action = createTaskAction('conflict-drift');
      let resolveSave: (saved: boolean) => void = () => undefined;
      const saved = new Promise<boolean>(resolve => { resolveSave = resolve; });
      mockPushTaskFromActionQueue.mockResolvedValueOnce({
        outcome: 'conflict',
        error: createRemoteNewerError(action.payload.task.id),
      });
      mockConflictStorageService.saveConflict.mockReturnValueOnce(saved);
      const processing = getProcessor('task:update')(action, createProcessorContext());
      await vi.waitFor(() => expect(mockConflictStorageService.saveConflict).toHaveBeenCalledOnce());
      mockAuthService.captureAuthIdentityFence.mockReturnValue('changed-fence');
      resolveSave(true);

      expect(await processing).toEqual(expect.objectContaining({ outcome: 'defer-retry' }));
      expect(mockActionQueueService.markActionResolvedWithoutRemote).not.toHaveBeenCalled();
      expect(mockToastService.warning).not.toHaveBeenCalled();
    });
  });

  describe('RetryQueue task replay commit', () => {
    it('commits B only after authoritative IDB write and exact readonly readback', async () => {
      const harness = await createRealRetryQueueHarness();
      const task = createTask('idb-commit');
      configureCurrentActionQueueBridge(harness.service);
      try {
        const result = await asTaskReplayRetryQueue(harness.service).commitTaskReplay(
          createTaskCommitInput(task, 'op-idb-commit'),
        );

        expect(result).toEqual({ status: 'committed' });
        const reopened = await reopenRetryQueueHarness(harness);
        expect(reopened.service.findItemForOwner('task', task.id, 'test-user')).toEqual(
          expect.objectContaining({
            operationId: replayOperationId('op-idb-commit'),
            data: persistedTask(task),
          }),
        );
        await reopened.teardown();
      } finally {
        await harness.teardown();
      }
    });

    it('returns current for one exact durable B without writing again', async () => {
      const harness = await createRealRetryQueueHarness();
      const task = createTask('idb-current');
      configureCurrentActionQueueBridge(harness.service);
      harness.service.add(
        'task', 'upsert', task, 'project-1', 'test-user', undefined,
        'task_full_upsert', undefined, replayOperationId('op-idb-current'),
      );
      await expect(harness.service.persistNow()).resolves.toBe(true);
      const persistSpy = vi.spyOn(harness.service, 'persistNow');
      try {
        const result = await asTaskReplayRetryQueue(harness.service).commitTaskReplay(
          createTaskCommitInput(task, 'op-idb-current'),
        );
        expect(result).toEqual({ status: 'current' });
        expect(persistSpy).not.toHaveBeenCalled();
      } finally {
        persistSpy.mockRestore();
        await harness.teardown();
      }
    });

    it('rejects duplicate authoritative B candidates without writing', async () => {
      const harness = await createRealRetryQueueHarness();
      const task = createTask('idb-duplicate');
      configureCurrentActionQueueBridge(harness.service);
      await writePersistedRetryQueueItems([
        createPersistedTaskItem('retry-a', task, 'op-idb-duplicate'),
        createPersistedTaskItem('retry-b', task, 'op-idb-duplicate'),
      ]);
      const persistSpy = vi.spyOn(harness.service, 'persistNow');
      try {
        await expect(asTaskReplayRetryQueue(harness.service).commitTaskReplay(
          createTaskCommitInput(task, 'op-idb-duplicate'),
        )).resolves.toEqual({ status: 'deferred' });
        expect(persistSpy).not.toHaveBeenCalled();
      } finally {
        persistSpy.mockRestore();
        await harness.teardown();
      }
    });

    it('rejects fallback-only persistence without an authoritative IDB record', async () => {
      const harness = await createRealRetryQueueHarness();
      const task = createTask('fallback-only');
      configureCurrentActionQueueBridge(harness.service);
      const persistSpy = vi.spyOn(harness.service, 'persistNow').mockResolvedValue(true);
      try {
        await expect(asTaskReplayRetryQueue(harness.service).commitTaskReplay(
          createTaskCommitInput(task, 'op-fallback-only'),
        )).resolves.toEqual({ status: 'deferred' });
        expect(persistSpy).toHaveBeenCalledOnce();
      } finally {
        persistSpy.mockRestore();
        await harness.teardown();
      }
    });

    it('retains committed B but refuses acknowledgement when the fence drifts after commit', async () => {
      const harness = await createRealRetryQueueHarness();
      const task = createTask('commit-drift');
      configureCurrentActionQueueBridge(harness.service);
      let current = true;
      const originalPersist = harness.service.persistNow.bind(harness.service);
      const persistSpy = vi.spyOn(harness.service, 'persistNow').mockImplementation(async () => {
        const persisted = await originalPersist();
        current = false;
        return persisted;
      });
      const input = createTaskCommitInput(task, 'op-commit-drift');
      input.isFenceCurrent = () => current;
      try {
        await expect(asTaskReplayRetryQueue(harness.service).commitTaskReplay(input))
          .resolves.toEqual({ status: 'deferred' });
        const reopened = await reopenRetryQueueHarness(harness);
        expect(reopened.service.findItemForOwner('task', task.id, 'test-user')).toEqual(
          expect.objectContaining({
            operationId: replayOperationId('op-commit-drift'),
            data: persistedTask(task),
          }),
        );
        await reopened.teardown();
      } finally {
        persistSpy.mockRestore();
        await harness.teardown();
      }
    });

    it('rejects a transaction abort during the independent readonly readback', async () => {
      const harness = await createRealRetryQueueHarness();
      const task = createTask('readback-abort');
      configureCurrentActionQueueBridge(harness.service);
      const getAllSpy = abortRetryQueueGetAllTransactionOnCall(2);
      try {
        await expect(asTaskReplayRetryQueue(harness.service).commitTaskReplay(
          createTaskCommitInput(task, 'op-readback-abort'),
        )).resolves.toEqual({ status: 'deferred' });
      } finally {
        getAllSpy.mockRestore();
        await harness.teardown();
      }
    });
  });
}

function createProcessorContext(): QueueProcessorContext {
  return { leaseSignal: new AbortController().signal, isCurrent: () => true };
}

function taskReplayFailureInput(action: ReturnType<typeof createTaskAction>): TaskReplayFailureInput {
  return {
    actionType: 'task:update',
    taskId: action.payload.task.id,
    projectId: action.payload.projectId,
  };
}

function exactTaskFailureCase(
  label: string,
  source: TaskReplayProcessorFailureCase['source'],
): TaskReplayProcessorFailureCase {
  return {
    label,
    source,
    createFailure: ({ actionType, taskId, projectId }) =>
      buildTaskSyncRetryError(actionType, taskId, projectId),
    retryCount: 0,
    syncState: 'syncing',
  };
}

function exactAuthFailureCase(label: string): TaskReplayProcessorFailureCase {
  return {
    label,
    source: 'thrown',
    createFailure: ({ actionType, taskId }) => buildAuthPendingRetryError(actionType, taskId),
    retryCount: 0,
    syncState: 'syncing',
  };
}

function mismatchedTaskFailureCase(
  field: 'taskId' | 'projectId' | 'reason' | 'actionType',
  mismatch: (input: TaskReplayFailureInput) => string,
): TaskReplayProcessorFailureCase {
  return {
    label: `synchronous mismatched ${field}`,
    source: 'thrown',
    createFailure: input => withRetryDetail(
      buildTaskSyncRetryError(input.actionType, input.taskId, input.projectId),
      field,
      mismatch(input),
    ),
    retryCount: 1,
    syncState: 'retry_scheduled',
  };
}

function mismatchedAuthFailureCase(
  field: 'entityId',
  mismatch: (input: TaskReplayFailureInput) => string,
): TaskReplayProcessorFailureCase {
  return {
    label: `synchronous mismatched ${field}`,
    source: 'thrown',
    createFailure: input => withRetryDetail(
      buildAuthPendingRetryError(input.actionType, input.taskId),
      field,
      mismatch(input),
    ),
    retryCount: 0,
    syncState: 'blocked_by_auth',
  };
}

function withRetryDetail(
  error: QueueRetryError,
  field: string,
  value: unknown,
): QueueRetryError {
  return { ...error, details: { ...error.details, [field]: value } };
}

function createTaskAction(suffix: string) {
  const task = createTask(suffix);
  return {
    id: `action-${suffix}`,
    operationId: `op-${suffix}`,
    type: 'update',
    entityType: 'task',
    entityId: task.id,
    payload: {
      task,
      projectId: 'project-1',
      sourceUserId: 'test-user',
      writeIntent: 'task_full_upsert',
    },
  } as QueuedAction & { payload: {
    task: Task; projectId: string; sourceUserId: string; writeIntent: string;
  } };
}

function createTask(suffix: string): Task {
  const idTail = Array.from(suffix, char => char.charCodeAt(0).toString(16).padStart(2, '0'))
    .join('').padEnd(12, '0').slice(0, 12);
  return {
    id: `00000000-0000-4000-8000-${idTail}`,
    title: `Task ${suffix}`,
    content: 'content',
    stage: null,
    parentId: null,
    order: 0,
    rank: 0,
    status: 'active',
    x: 0,
    y: 0,
    displayId: `T-${suffix}`,
    createdDate: '2026-08-03T00:00:00.000Z',
    updatedAt: '2026-08-03T00:00:00.000Z',
  };
}

function createRemoteNewerError(taskId: string): Error {
  return Object.assign(new Error('remote newer'), {
    name: 'VersionConflictError',
    code: 'TASK_REMOTE_NEWER',
    details: { taskId, remoteUpdatedAt: '2026-08-03T01:00:00.000Z' },
  });
}

function asTaskReplayRetryQueue(service: RetryQueueService): TaskReplayRetryQueue {
  return service as TaskReplayRetryQueue;
}

function createTaskCommitInput(task: Task, actionOperationId: string) {
  actionOperationId = replayOperationId(actionOperationId);
  const projectedTask = persistedTask(task);
  const input = {
    actionId: `action-${task.id}`,
    actionOperationId,
    task,
    projectId: 'project-1',
    sourceUserId: 'test-user',
    writeIntent: 'task_full_upsert',
    leaseSignal: new AbortController().signal,
    isFenceCurrent: () => true,
  };
  return {
    ...input,
    payloadSignature: buildActionQueuePayloadSignature({
      task: projectedTask, projectId: input.projectId, sourceUserId: input.sourceUserId,
      writeIntent: input.writeIntent,
    }),
  };
}

function persistedTask(task: Task): Omit<Task, 'displayId'> {
  const { displayId: _displayId, ...persisted } = task;
  return persisted;
}

function configureCurrentActionQueueBridge(service: RetryQueueService): void {
  service.configureActionQueueSupersessionBridge({
    captureContext: ownerUserId => ({
      ownerUserId, queueGeneration: 1, sessionGeneration: 1, authFence: 'auth-fence',
    }),
    isContextCurrent: () => true,
    isOwnerStorageLoaded: () => true,
    restoreQueueSnapshot: async () => ({ recordFound: true, actions: [], savedAt: null }),
  });
}

async function createRealRetryQueueHarness(): Promise<RetryQueueServiceSpecHarness> {
  const harness = createRetryQueueServiceSpecHarness({ clearLocalStorage: false });
  harness.loadFromStorageSpy.mockRestore();
  harness.initDbSpy.mockRestore();
  await harness.service.reloadFromStorageForCurrentOwner();
  return harness;
}

async function reopenRetryQueueHarness(
  previous: RetryQueueServiceSpecHarness,
): Promise<RetryQueueServiceSpecHarness> {
  await previous.service.closeStorageConnections();
  return await createRealRetryQueueHarness();
}

function createPersistedTaskItem(
  id: string,
  task: Task,
  operationId: string,
): PersistedRetryQueueItem {
  return {
    id,
    type: 'task',
    operation: 'upsert',
    data: task,
    projectId: 'project-1',
    retryCount: 0,
    createdAt: Date.now(),
    sourceUserId: 'test-user',
    operationId: replayOperationId(operationId),
    writeIntent: 'task_full_upsert',
  };
}

function replayOperationId(value: string): string {
  const tail = Array.from(value, char => char.charCodeAt(0).toString(16).padStart(2, '0'))
    .join('').padEnd(12, '0').slice(0, 12);
  return `10000000-0000-4000-8000-${tail}`;
}

function abortRetryQueueGetAllTransactionOnCall(callNumber: number) {
  const originalGetAll = IDBObjectStore.prototype.getAll;
  let calls = 0;
  return vi.spyOn(IDBObjectStore.prototype, 'getAll').mockImplementation(function (
    this: IDBObjectStore,
  ) {
    const request = originalGetAll.call(this);
    if (++calls === callNumber) {
      request.addEventListener('success', () => request.transaction?.abort(), { once: true });
    }
    return request;
  });
}

async function writePersistedRetryQueueItems(items: PersistedRetryQueueItem[]): Promise<void> {
  const db = await openRetryQueueDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('offline_mutation_queue', 'readwrite');
    const store = transaction.objectStore('offline_mutation_queue');
    for (const item of items) store.put(item);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('RetryQueue write failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('RetryQueue write aborted'));
  }).finally(() => db.close());
}

function openRetryQueueDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('nanoflow-retry-queue');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('RetryQueue database open failed'));
  });
}
