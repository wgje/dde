import { expect, it, vi } from 'vitest';
import { Injector, signal, type DestroyRef } from '@angular/core';

import type { Connection, Project, Task } from '../../../../models';
import type { BlackBoxEntry } from '../../../../models/focus';
import type { QueuedAction } from '../../../../services/action-queue.types';
import { ActionQueueService } from '../../../../services/action-queue.service';
import {
  ActionQueueRetrySupersessionController,
  type ActionQueueRetrySupersessionControllerOptions,
} from '../../../../services/action-queue-retry-supersession.controller';
import { createActionQueueServiceTestInjector } from '../../../../services/action-queue-service-test-harness.spec-helpers';
import { AuthService } from '../../../../services/auth.service';
import type { LeaseHandle } from '../../../../services/sync-writer-lease.service';
import { UserSessionService } from '../../../../services/user-session.service';
import { createDerivedSyncOperationId, isSyncOperationId } from '../../../../utils/sync-operation-id';
import type { RetryQueueActionQueueSupersessionBridge } from './retry-queue-action-queue-supersession.controller';
import type { RetryOperationHandler, RetryQueueItem, RetryQueueService } from './retry-queue.service';

const LEGACY_RETRY_QUEUE_OPERATION_ID_PURPOSE = 'legacy-retry-queue-operation-id';

type MockFn = ReturnType<typeof vi.fn>;

export interface RetryQueueOperationIdSpecContext {
  service: RetryQueueService;
  handler: RetryOperationHandler;
  authServiceMock: {
    currentUserId: MockFn;
  };
  setOnline(value: boolean): void;
  loadFromStorageSpy: ReturnType<typeof vi.spyOn>;
  saveToStorageSpy: ReturnType<typeof vi.spyOn>;
  createTask(label: string): Task;
  createProject(label: string): Project;
  createConnection(label: string, sourceLabel?: string, targetLabel?: string): Connection;
  createBlackBoxEntry(label: string, overrides?: Partial<BlackBoxEntry>): BlackBoxEntry;
  stableUUID(label: string): string;
}

export const currentSupersessionIdentity = {
  getSessionGeneration: () => 1,
  captureAuthFence: () => 'auth-current',
  isSessionContextCurrent: () => true,
} satisfies Pick<ActionQueueRetrySupersessionControllerOptions,
  'getSessionGeneration' | 'captureAuthFence' | 'isSessionContextCurrent'>;

export function createSupersessionLease(
  leaseSignal = new AbortController().signal,
): LeaseHandle {
  return {
    tabId: 'tab-a',
    lockName: 'global-owner-a',
    mode: 'idb-lease',
    signal: leaseSignal,
    release: vi.fn().mockResolvedValue(undefined),
  };
}

export function createSupersessionActionQueueTestInjector(
  ownerUserId: string,
  destroyRef: DestroyRef,
): Injector {
  const currentUserId = signal<string | null>(ownerUserId);
  const parent = createActionQueueServiceTestInjector(currentUserId, destroyRef);
  return Injector.create({
    parent,
    providers: [
      ActionQueueService,
      {
        provide: AuthService,
        useValue: {
          currentUserId,
          captureAuthIdentityFence: () => `1:${ownerUserId}:`,
        },
      },
      {
        provide: UserSessionService,
        useValue: {
          getCurrentSessionGeneration: () => 1,
          isSessionContextCurrent: (generation: number, owner: string) =>
            generation === 1 && owner === ownerUserId,
        },
      },
    ],
  });
}

export function createRetryQueueActionQueueSupersessionBridge(
  ownerUserId: string,
  actions: QueuedAction[] | null,
  isContextCurrent: () => boolean = () => true,
): RetryQueueActionQueueSupersessionBridge {
  return {
    captureContext: vi.fn(() => ({
      ownerUserId, queueGeneration: 7, sessionGeneration: 1, authFence: 'auth-current',
    })),
    isContextCurrent: vi.fn(isContextCurrent),
    isOwnerStorageLoaded: vi.fn(() => true),
    restoreQueueSnapshot: vi.fn().mockResolvedValue(actions === null ? null : {
      recordFound: true, actions, savedAt: '2026-07-30T00:00:00.000Z',
    }),
  };
}

export function registerEmptyRetrySelectionSupersessionSpecs(
  ownerUserId: string,
  createAction: () => QueuedAction,
): void {
  const createCase = (outcome: 'committed' | 'commit-failed' | 'readback-failed') => {
    const events: string[] = [];
    const handle = createSupersessionLease();
    handle.release = vi.fn(async () => { events.push('release'); });
    const queued = createAction();
    delete queued.retryQueueSupersessions;
    let storedQueue: QueuedAction[] = [];
    let committed = false;
    const persistQueueMutationStrictlyForOwner = vi.fn(async (
      _owner: string,
      updater: (queue: QueuedAction[]) => QueuedAction[],
    ) => {
      events.push('b-persist');
      if (outcome === 'commit-failed') return { status: 'storage-failed' } as const;
      storedQueue = updater(storedQueue);
      committed = true;
      return { status: 'committed', queue: storedQueue } as const;
    });
    const restoreQueueSnapshot = vi.fn(async () => {
      if (committed) events.push('readback');
      if (committed && outcome === 'readback-failed') return null;
      return { recordFound: true, actions: storedQueue, savedAt: 'now' };
    });
    const persistWithoutSupersession = vi.fn().mockResolvedValue([queued]);
    const controller = new ActionQueueRetrySupersessionController({
      ...currentSupersessionIdentity,
      getCurrentOwnerUserId: () => ownerUserId,
      getQueueGeneration: () => 2,
      isQueueContextCurrent: () => true,
      isOwnerStorageLoaded: () => true,
      acquireWriterLease: vi.fn(async () => {
        events.push('lease');
        return handle;
      }),
      restoreQueueSnapshot,
      persistQueueMutationStrictlyForOwner,
      inspectRetryTargets: () => ({ status: 'ready', retryItems: [] }),
      reserveRetrySupersession: vi.fn(),
      settleRetrySupersessions: vi.fn(),
      applyPersistedCurrentOwnerQueue: vi.fn(),
      warn: vi.fn(),
    });
    const persist = () => controller.persistMutation({
      ownerUserId,
      mutateQueue: queue => [...queue, queued],
      getCandidateActionIds: () => [queued.id],
      persistWithoutSupersession,
    });
    return {
      events,
      handle,
      persist,
      persistQueueMutationStrictlyForOwner,
      persistWithoutSupersession,
      queued,
    };
  };

  it('requires strict B commit and exact readback for an authoritative empty RetryQueue selection', async () => {
    const testCase = createCase('committed');

    await expect(testCase.persist()).resolves.toEqual([testCase.queued]);
    expect(testCase.persistQueueMutationStrictlyForOwner).toHaveBeenCalledOnce();
    expect(testCase.persistWithoutSupersession).not.toHaveBeenCalled();
    expect(testCase.events).toEqual(['lease', 'b-persist', 'readback', 'release']);
  });

  it.each(['commit-failed', 'readback-failed'] as const)(
    'defers empty RetryQueue selection when strict B %s despite fallback success', async outcome => {
      const testCase = createCase(outcome);

      await expect(testCase.persist()).resolves.toBeNull();
      expect(testCase.persistQueueMutationStrictlyForOwner).toHaveBeenCalledOnce();
      expect(testCase.persistWithoutSupersession).not.toHaveBeenCalled();
      expect(testCase.handle.release).toHaveBeenCalledOnce();
    },
  );
}

export function registerRetryQueueOperationIdReplayLeadSpecs(
  getContext: () => RetryQueueOperationIdSpecContext,
): void {
  it('task upsert 重试项应持久保留并重放 operationId', async () => {
    const { service, handler, setOnline, createTask, stableUUID } = getContext();
    const task = createTask('task-replay-operation-id');
    const operationId = stableUUID('retry-op-task-upsert');
    const addWithOperationId = service.add.bind(service) as unknown as (
      type: 'task',
      operation: 'upsert',
      data: Task,
      projectId: string,
      sourceUserId: string,
      taskIdsToDelete: undefined,
      writeIntent: 'task_text_update',
      taskDeleteBaseUpdatedAtMap: undefined,
      operationId: string,
    ) => boolean;

    addWithOperationId(
      'task',
      'upsert',
      task,
      'p-operation-id',
      'test-user',
      undefined,
      'task_text_update',
      undefined,
      operationId,
    );
    setOnline(true);

    expect(service.getItems()[0]?.operationId).toBe(operationId);
    await service.processQueueSlice({ maxItems: 1, maxDurationMs: 1000 });
    expect(handler.pushTask).toHaveBeenCalledWith(
      task,
      'p-operation-id',
      'test-user',
      'task_text_update',
      operationId,
    );
  });

  it('project 重试项应持久保留并重放 operationId', async () => {
    const { service, handler, authServiceMock, setOnline, createProject, stableUUID } = getContext();
    const project = createProject('captured-owner-with-operation-id');
    const operationId = stableUUID('retry-op-project-upsert');
    const addWithOperationId = service.add.bind(service) as unknown as (
      type: 'project',
      operation: 'upsert',
      data: Project,
      projectId: undefined,
      sourceUserId: string,
      taskIdsToDelete: string[],
      writeIntent: undefined,
      taskDeleteBaseUpdatedAtMap: Record<string, string>,
      operationId: string,
    ) => boolean;
    authServiceMock.currentUserId.mockReturnValue('owner-a');

    addWithOperationId(
      'project',
      'upsert',
      project,
      undefined,
      'owner-a',
      ['task-delete-op'],
      undefined,
      { 'task-delete-op': '2026-06-11T03:00:00.000Z' },
      operationId,
    );
    setOnline(true);
    authServiceMock.currentUserId.mockReturnValue('owner-a');

    expect(service.getItems()[0]?.operationId).toBe(operationId);
    await service.processQueueSlice({ maxItems: 1, maxDurationMs: 1000 });
    expect(handler.pushProject).toHaveBeenCalledWith(
      project,
      'owner-a',
      ['task-delete-op'],
      { 'task-delete-op': '2026-06-11T03:00:00.000Z' },
      operationId,
    );
  });
}

export function registerRetryQueueOperationIdReplayTailSpecs(
  getContext: () => RetryQueueOperationIdSpecContext,
): void {
  it('connection 重试项应持久保留并重放 operationId', async () => {
    const { service, handler, authServiceMock, setOnline, createConnection, stableUUID } = getContext();
    const connection = createConnection('connection-operation-id');
    const operationId = stableUUID('retry-op-connection-upsert');
    const addWithOperationId = service.add.bind(service) as unknown as (
      type: 'connection',
      operation: 'upsert',
      data: Connection,
      projectId: string,
      sourceUserId: string,
      taskIdsToDelete: undefined,
      writeIntent: undefined,
      taskDeleteBaseUpdatedAtMap: undefined,
      operationId: string,
    ) => boolean;
    authServiceMock.currentUserId.mockReturnValue('owner-a');

    addWithOperationId(
      'connection',
      'upsert',
      connection,
      'project-connection-op',
      'owner-a',
      undefined,
      undefined,
      undefined,
      operationId,
    );
    setOnline(true);
    authServiceMock.currentUserId.mockReturnValue('owner-a');

    expect(service.getItems()[0]?.operationId).toBe(operationId);
    await service.processQueueSlice({ maxItems: 1, maxDurationMs: 1000 });
    expect(handler.pushConnection).toHaveBeenCalledWith(
      connection,
      'project-connection-op',
      'owner-a',
      operationId,
    );
  });

  it('task delete 重试项应持久保留并重放 operationId', async () => {
    const { service, handler, authServiceMock, setOnline, stableUUID } = getContext();
    const taskId = stableUUID('task-delete-operation-id');
    const operationId = stableUUID('retry-op-task-delete');
    const addWithOperationId = service.add.bind(service) as unknown as (
      type: 'task',
      operation: 'delete',
      data: { id: string; baseUpdatedAt: string },
      projectId: string,
      sourceUserId: string,
      taskIdsToDelete: undefined,
      writeIntent: undefined,
      taskDeleteBaseUpdatedAtMap: undefined,
      operationId: string,
    ) => boolean;
    authServiceMock.currentUserId.mockReturnValue('owner-a');

    addWithOperationId(
      'task',
      'delete',
      { id: taskId, baseUpdatedAt: '2026-06-11T05:00:00.000Z' },
      'project-task-delete-op',
      'owner-a',
      undefined,
      undefined,
      undefined,
      operationId,
    );
    setOnline(true);
    authServiceMock.currentUserId.mockReturnValue('owner-a');

    expect(service.getItems()[0]?.operationId).toBe(operationId);
    await service.processQueueSlice({ maxItems: 1, maxDurationMs: 1000 });
    expect(handler.deleteTask).toHaveBeenCalledWith(
      taskId,
      'project-task-delete-op',
      'owner-a',
      true,
      '2026-06-11T05:00:00.000Z',
      operationId,
    );
  });

  it('blackbox 重试项应持久保留并重放 operationId', async () => {
    const { service, handler, authServiceMock, setOnline, createBlackBoxEntry, stableUUID } = getContext();
    const entry = createBlackBoxEntry('blackbox-operation-id', {
      userId: 'owner-a',
      syncStatus: 'pending',
    });
    const operationId = stableUUID('retry-op-blackbox-upsert');
    const addWithOperationId = service.add.bind(service) as unknown as (
      type: 'blackbox',
      operation: 'upsert',
      data: BlackBoxEntry,
      projectId: string | undefined,
      sourceUserId: string,
      taskIdsToDelete: undefined,
      writeIntent: undefined,
      taskDeleteBaseUpdatedAtMap: undefined,
      operationId: string,
    ) => boolean;
    authServiceMock.currentUserId.mockReturnValue('owner-a');

    addWithOperationId(
      'blackbox',
      'upsert',
      entry,
      undefined,
      'owner-a',
      undefined,
      undefined,
      undefined,
      operationId,
    );
    setOnline(true);
    authServiceMock.currentUserId.mockReturnValue('owner-a');

    expect(service.getItems()[0]?.operationId).toBe(operationId);
    await service.processQueueSlice({ maxItems: 1, maxDurationMs: 1000 });
    expect(handler.pushBlackBoxEntry).toHaveBeenCalledWith(
      entry,
      'owner-a',
      operationId,
    );
  });

  it('未显式传入 operationId 时也应为待同步操作生成持久幂等键', () => {
    const { service, createTask } = getContext();
    const task = createTask('task-generated-operation-id');

    service.add('task', 'upsert', task, 'project-generated-operation-id', 'test-user');

    expect(service.getItems()).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ id: task.id }),
        operationId: expect.any(String),
      }),
    ]);
    expect(isSyncOperationId(service.getItems()[0]?.operationId)).toBe(true);
  });

  it('显式 legacy operationId 入队时应稳定派生 UUID 幂等键', () => {
    const { service, createTask } = getContext();
    const task = createTask('task-legacy-explicit-operation-id');
    const legacyOperationId = 'retry-op-legacy-explicit';
    const expectedOperationId = createDerivedSyncOperationId(
      legacyOperationId,
      LEGACY_RETRY_QUEUE_OPERATION_ID_PURPOSE,
    );

    service.add(
      'task',
      'upsert',
      task,
      'project-legacy-explicit-operation-id',
      'test-user',
      undefined,
      undefined,
      undefined,
      legacyOperationId,
    );

    expect(service.getItems()[0]?.operationId).toBe(expectedOperationId);
    expect(isSyncOperationId(service.getItems()[0]?.operationId)).toBe(true);
  });

  it('从旧持久队列恢复缺失 operationId 的条目时应补齐并持久化幂等键', async () => {
    const { service, createTask, loadFromStorageSpy, saveToStorageSpy } = getContext();
    const task = createTask('task-legacy-operation-id-backfill');
    const legacyItem: Omit<RetryQueueItem, 'operationId'> = {
      id: crypto.randomUUID(),
      type: 'task',
      operation: 'upsert',
      data: task,
      projectId: 'project-legacy-operation-id-backfill',
      retryCount: 0,
      createdAt: Date.now(),
      sourceUserId: 'test-user',
    };
    loadFromStorageSpy.mockRestore();
    const loadFromStorage = (service as unknown as { loadFromStorage(): Promise<void> }).loadFromStorage.bind(service);

    localStorage.setItem('nanoflow.retry-queue', JSON.stringify({
      version: 1,
      items: [legacyItem],
      savedAt: Date.now(),
    }));

    await loadFromStorage();

    expect(service.getItems()).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ id: task.id }),
        operationId: expect.any(String),
      }),
    ]);
    expect(isSyncOperationId(service.getItems()[0]?.operationId)).toBe(true);
    expect(saveToStorageSpy).toHaveBeenCalled();
  });

  it('从旧持久队列恢复非 UUID operationId 的条目时应稳定派生 UUID 幂等键', async () => {
    const { service, createTask, loadFromStorageSpy, saveToStorageSpy } = getContext();
    const task = createTask('task-legacy-string-operation-id-backfill');
    const legacyOperationId = 'retry-op-legacy-storage';
    const expectedOperationId = createDerivedSyncOperationId(
      legacyOperationId,
      LEGACY_RETRY_QUEUE_OPERATION_ID_PURPOSE,
    );
    const legacyItem: RetryQueueItem = {
      id: crypto.randomUUID(),
      type: 'task',
      operation: 'upsert',
      data: task,
      projectId: 'project-legacy-string-operation-id-backfill',
      retryCount: 0,
      createdAt: Date.now(),
      sourceUserId: 'test-user',
      operationId: legacyOperationId,
    };
    loadFromStorageSpy.mockRestore();
    const loadFromStorage = (service as unknown as { loadFromStorage(): Promise<void> }).loadFromStorage.bind(service);

    localStorage.setItem('nanoflow.retry-queue', JSON.stringify({
      version: 1,
      items: [legacyItem],
      savedAt: Date.now(),
    }));

    await loadFromStorage();

    expect(service.getItems()).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ id: task.id }),
        operationId: expectedOperationId,
      }),
    ]);
    expect(isSyncOperationId(service.getItems()[0]?.operationId)).toBe(true);
    expect(saveToStorageSpy).toHaveBeenCalled();
  });
}
