import { expect, it, vi } from 'vitest';

import type { Connection, Project, Task } from '../../../../models';
import type { BlackBoxEntry } from '../../../../models/focus';
import type { RetryOperationHandler, RetryQueueItem, RetryQueueService } from './retry-queue.service';
import { createDerivedSyncOperationId, isSyncOperationId } from '../../../../utils/sync-operation-id';

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

export function registerRetryQueueOperationIdSpecs(
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

  it('project retry 处理期间刷新 task delete CAS map 时应保留最新队列项', async () => {
    const { service, handler, authServiceMock, setOnline, createProject, stableUUID } = getContext();
    vi.spyOn(Date, 'now').mockReturnValue(1_234);
    const project = createProject('captured-owner-refresh-delete-baseline');
    const taskId = stableUUID('task-delete-refresh-baseline');
    authServiceMock.currentUserId.mockReturnValue('owner-a');
    service.add(
      'project',
      'upsert',
      project,
      undefined,
      'owner-a',
      [taskId],
      undefined,
      { [taskId]: '2026-06-11T01:00:00.000Z' },
    );
    setOnline(true);
    authServiceMock.currentUserId.mockReturnValue('owner-a');
    (handler.pushProject as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      service.add('project', 'upsert', project, undefined, 'owner-a', [taskId], undefined, {
        [taskId]: '2026-06-11T02:00:00.000Z',
      });
      return true;
    });

    await service.processQueueSlice({ maxItems: 1, maxDurationMs: 1000 });

    expect(service.getItems()).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ id: project.id }),
        taskIdsToDelete: [taskId],
        taskDeleteBaseUpdatedAtMap: { [taskId]: '2026-06-11T02:00:00.000Z' },
      }),
    ]);
  });

  it('task retry 处理期间同毫秒刷新正文和 operationId 时应保留最新队列项', async () => {
    const { service, handler, setOnline, createTask, stableUUID } = getContext();
    vi.spyOn(Date, 'now').mockReturnValue(2_468);
    const taskId = stableUUID('task-inflight-refresh-same-ms');
    const originalTask = createTask('task-inflight-refresh-original');
    const refreshedTask = createTask('task-inflight-refresh-refreshed');
    const sameUpdatedAt = '2026-06-11T04:15:00.000Z';
    const originalOperationId = stableUUID('retry-op-task-inflight-original');
    const refreshedOperationId = stableUUID('retry-op-task-inflight-refreshed');
    originalTask.id = taskId;
    originalTask.updatedAt = sameUpdatedAt;
    refreshedTask.id = taskId;
    refreshedTask.updatedAt = sameUpdatedAt;
    refreshedTask.title = 'Task inflight refresh latest title';
    refreshedTask.content = 'latest offline edit while old retry is in flight';
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
      originalTask,
      'project-inflight-refresh-same-ms',
      'test-user',
      undefined,
      'task_text_update',
      undefined,
      originalOperationId,
    );
    setOnline(true);
    (handler.pushTask as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      addWithOperationId(
        'task',
        'upsert',
        refreshedTask,
        'project-inflight-refresh-same-ms',
        'test-user',
        undefined,
        'task_text_update',
        undefined,
        refreshedOperationId,
      );
      return true;
    });

    await service.processQueueSlice({ maxItems: 1, maxDurationMs: 1000 });

    expect(handler.pushTask).toHaveBeenCalledWith(
      originalTask,
      'project-inflight-refresh-same-ms',
      'test-user',
      'task_text_update',
      originalOperationId,
    );
    expect(service.getItems()).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          id: taskId,
          title: refreshedTask.title,
          content: refreshedTask.content,
          updatedAt: sameUpdatedAt,
        }),
        operationId: refreshedOperationId,
      }),
    ]);
  });

  it('刷新同一实体重试项时应使用新的 operationId 覆盖旧值', () => {
    const { service, createTask, stableUUID } = getContext();
    const taskId = stableUUID('task-refresh-operation-id');
    const oldTask = createTask('task-refresh-operation-id-old');
    const newTask = createTask('task-refresh-operation-id-new');
    const oldOperationId = stableUUID('retry-op-old');
    const newOperationId = stableUUID('retry-op-new');
    oldTask.id = taskId;
    newTask.id = taskId;
    oldTask.updatedAt = '2026-06-11T03:30:00.000Z';
    newTask.updatedAt = '2026-06-11T04:00:00.000Z';
    const addWithOperationId = service.add.bind(service) as unknown as (
      type: 'task',
      operation: 'upsert',
      data: Task,
      projectId: string,
      sourceUserId: string,
      taskIdsToDelete: undefined,
      writeIntent: undefined,
      taskDeleteBaseUpdatedAtMap: undefined,
      operationId: string,
    ) => boolean;

    addWithOperationId('task', 'upsert', oldTask, 'project-refresh-op', 'test-user', undefined, undefined, undefined, oldOperationId);
    addWithOperationId('task', 'upsert', newTask, 'project-refresh-op', 'test-user', undefined, undefined, undefined, newOperationId);

    expect(service.getItems()).toHaveLength(1);
    expect(service.getItems()[0]).toEqual(expect.objectContaining({
      data: expect.objectContaining({ id: taskId, updatedAt: newTask.updatedAt }),
      operationId: newOperationId,
    }));
  });

  it('刷新同一实体重试项且未显式传入 operationId 时应保留已有幂等键', () => {
    const { service, createTask, stableUUID } = getContext();
    const taskId = stableUUID('task-refresh-generated-operation-id');
    const oldTask = createTask('task-refresh-generated-operation-id-old');
    const newTask = createTask('task-refresh-generated-operation-id-new');
    const oldOperationId = stableUUID('retry-op-old-generated-refresh');
    oldTask.id = taskId;
    newTask.id = taskId;
    oldTask.updatedAt = '2026-06-11T04:00:00.000Z';
    newTask.updatedAt = '2026-06-11T04:30:00.000Z';
    const addWithOperationId = service.add.bind(service) as unknown as (
      type: 'task',
      operation: 'upsert',
      data: Task,
      projectId: string,
      sourceUserId: string,
      taskIdsToDelete: undefined,
      writeIntent: undefined,
      taskDeleteBaseUpdatedAtMap: undefined,
      operationId: string,
    ) => boolean;

    addWithOperationId(
      'task',
      'upsert',
      oldTask,
      'project-refresh-generated-op',
      'test-user',
      undefined,
      undefined,
      undefined,
      oldOperationId,
    );
    service.add('task', 'upsert', newTask, 'project-refresh-generated-op', 'test-user');

    expect(service.getItems()).toHaveLength(1);
    expect(service.getItems()[0]).toEqual(expect.objectContaining({
      data: expect.objectContaining({ id: taskId, updatedAt: newTask.updatedAt }),
    }));
    expect(service.getItems()[0]?.operationId).toBe(oldOperationId);
    expect(isSyncOperationId(service.getItems()[0]?.operationId)).toBe(true);
  });

  it('加载修复缺失 operationId 的 legacy 重试项后应立即持久化修复结果', () => {
    const { service, createTask, stableUUID } = getContext();
    const task = createTask('legacy-retry-operation-id-repair');
    task.id = stableUUID('legacy-retry-operation-id-repair-task');
    const retryQueueInternals = service as unknown as {
      sanitizeLoadedItems(items: Array<Partial<RetryQueueItem>>): {
        safeItems: RetryQueueItem[];
        removedCount: number;
        repairedOperationIdCount: number;
      };
      applyLoadedItems(items: RetryQueueItem[]): number;
      finishLoadedQueueItems(removedCount: number, repairedOperationIdCount?: number): void;
      saveToStorageImmediate(): Promise<boolean>;
    };
    const saveImmediateSpy = vi.spyOn(retryQueueInternals, 'saveToStorageImmediate').mockResolvedValue(true);

    const sanitized = retryQueueInternals.sanitizeLoadedItems([{
      id: stableUUID('legacy-retry-operation-id-repair-item'),
      type: 'task',
      operation: 'upsert',
      data: task,
      projectId: 'project-legacy-op-repair',
      retryCount: 0,
      createdAt: Date.now(),
      sourceUserId: 'test-user',
    }]);
    const duplicateRemovedCount = retryQueueInternals.applyLoadedItems(sanitized.safeItems);

    retryQueueInternals.finishLoadedQueueItems(
      sanitized.removedCount + duplicateRemovedCount,
      sanitized.repairedOperationIdCount,
    );

    expect(sanitized.repairedOperationIdCount).toBe(1);
    expect(isSyncOperationId(service.getItems()[0]?.operationId)).toBe(true);
    expect(saveImmediateSpy).toHaveBeenCalledTimes(1);
  });

  it('较旧的晚到 task 重试快照不应覆盖队列中的较新快照', () => {
    const { service, createTask, stableUUID } = getContext();
    const taskId = stableUUID('task-refresh-stale-late-snapshot');
    const newerTask = createTask('task-refresh-newer-snapshot');
    const olderTask = createTask('task-refresh-older-late-snapshot');
    newerTask.id = taskId;
    olderTask.id = taskId;
    newerTask.title = 'newer local title';
    olderTask.title = 'older late title';
    newerTask.updatedAt = '2026-06-11T06:30:00.000Z';
    olderTask.updatedAt = '2026-06-11T06:00:00.000Z';

    service.add('task', 'upsert', newerTask, 'project-stale-refresh', 'test-user');
    service.add('task', 'upsert', olderTask, 'project-stale-refresh', 'test-user');

    expect(service.getItems()).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          id: taskId,
          title: 'newer local title',
          updatedAt: newerTask.updatedAt,
        }),
      }),
    ]);
  });

  it('较旧的晚到 task upsert 不应覆盖已排队的 task delete', () => {
    const { service, createTask, stableUUID } = getContext();
    const taskId = stableUUID('task-delete-then-stale-upsert');
    const staleTask = createTask('task-delete-then-stale-upsert-late');
    const deleteOperationId = stableUUID('retry-op-delete-before-stale-upsert');
    const staleUpsertOperationId = stableUUID('retry-op-stale-upsert-after-delete');
    staleTask.id = taskId;
    staleTask.title = 'stale upsert should not resurrect delete';
    staleTask.updatedAt = '2026-06-11T06:00:00.000Z';
    const addDeleteWithOperationId = service.add.bind(service) as unknown as (
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
    const addUpsertWithOperationId = service.add.bind(service) as unknown as (
      type: 'task',
      operation: 'upsert',
      data: Task,
      projectId: string,
      sourceUserId: string,
      taskIdsToDelete: undefined,
      writeIntent: undefined,
      taskDeleteBaseUpdatedAtMap: undefined,
      operationId: string,
    ) => boolean;

    addDeleteWithOperationId(
      'task',
      'delete',
      { id: taskId, baseUpdatedAt: '2026-06-11T06:30:00.000Z' },
      'project-delete-stale-upsert',
      'test-user',
      undefined,
      undefined,
      undefined,
      deleteOperationId,
    );
    addUpsertWithOperationId(
      'task',
      'upsert',
      staleTask,
      'project-delete-stale-upsert',
      'test-user',
      undefined,
      undefined,
      undefined,
      staleUpsertOperationId,
    );

    expect(service.getItems()).toEqual([
      expect.objectContaining({
        operation: 'delete',
        data: expect.objectContaining({
          id: taskId,
          baseUpdatedAt: '2026-06-11T06:30:00.000Z',
        }),
        operationId: deleteOperationId,
      }),
    ]);
  });

  it('重试项应持久保留并刷新远端结果未知的失败上下文', () => {
    const { service, createTask, stableUUID } = getContext();
    const taskId = stableUUID('task-unknown-outcome');
    const firstTask = createTask('task-unknown-outcome-first');
    const secondTask = createTask('task-unknown-outcome-second');
    const firstOperationId = stableUUID('retry-op-timeout-first');
    const secondOperationId = stableUUID('retry-op-timeout-second');
    firstTask.id = taskId;
    secondTask.id = taskId;
    const addWithFailureContext = service.add.bind(service) as unknown as (
      type: 'task',
      operation: 'upsert',
      data: Task,
      projectId: string,
      sourceUserId: string,
      taskIdsToDelete: undefined,
      writeIntent: undefined,
      taskDeleteBaseUpdatedAtMap: undefined,
      operationId: string,
      lastFailure: {
        errorType: string;
        message: string;
        remoteOutcome: 'unknown';
        recordedAt: number;
      },
    ) => boolean;

    addWithFailureContext(
      'task',
      'upsert',
      firstTask,
      'project-unknown-outcome',
      'test-user',
      undefined,
      undefined,
      undefined,
      firstOperationId,
      {
        errorType: 'TimeoutError',
        message: '请求超时 (30000ms): push-task',
        remoteOutcome: 'unknown',
        recordedAt: 1_000,
      },
    );
    addWithFailureContext(
      'task',
      'upsert',
      secondTask,
      'project-unknown-outcome',
      'test-user',
      undefined,
      undefined,
      undefined,
      secondOperationId,
      {
        errorType: 'TimeoutError',
        message: '请求超时 (30000ms): push-task retry',
        remoteOutcome: 'unknown',
        recordedAt: 2_000,
      },
    );

    expect(service.getItems()).toHaveLength(1);
    expect(service.getItems()[0]).toEqual(expect.objectContaining({
      operationId: secondOperationId,
      lastFailure: {
        errorType: 'TimeoutError',
        message: '请求超时 (30000ms): push-task retry',
        remoteOutcome: 'unknown',
        recordedAt: 2_000,
      },
    }));
  });

  it('刷新同一实体重试项未携带新失败上下文时应保留远端结果未知标记', () => {
    const { service, createTask, stableUUID } = getContext();
    const taskId = stableUUID('task-preserve-unknown-outcome');
    const timedOutTask = createTask('task-preserve-unknown-outcome-timeout');
    const localRefreshTask = createTask('task-preserve-unknown-outcome-local-refresh');
    const timeoutOperationId = stableUUID('retry-op-timeout-preserve');
    const refreshOperationId = stableUUID('retry-op-local-refresh-preserve');
    timedOutTask.id = taskId;
    localRefreshTask.id = taskId;
    timedOutTask.updatedAt = '2026-06-11T04:15:00.000Z';
    localRefreshTask.updatedAt = '2026-06-11T04:45:00.000Z';

    service.add(
      'task',
      'upsert',
      timedOutTask,
      'project-preserve-unknown-outcome',
      'test-user',
      undefined,
      undefined,
      undefined,
      timeoutOperationId,
      {
        errorType: 'TimeoutError',
        message: '请求超时 (30000ms): push-task preserve',
        remoteOutcome: 'unknown',
        recordedAt: 3_000,
      },
    );
    service.add(
      'task',
      'upsert',
      localRefreshTask,
      'project-preserve-unknown-outcome',
      'test-user',
      undefined,
      undefined,
      undefined,
      refreshOperationId,
    );

    expect(service.getItems()).toHaveLength(1);
    expect(service.getItems()[0]).toEqual(expect.objectContaining({
      data: expect.objectContaining({ id: taskId, updatedAt: localRefreshTask.updatedAt }),
      operationId: refreshOperationId,
      lastFailure: {
        errorType: 'TimeoutError',
        message: '请求超时 (30000ms): push-task preserve',
        remoteOutcome: 'unknown',
        recordedAt: 3_000,
      },
    }));
  });

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
