import { expect, it, vi } from 'vitest';

import type { Task } from '../../../../models';
import { isSyncOperationId } from '../../../../utils/sync-operation-id';
import type { RetryQueueItem } from './retry-queue.service';
import type { RetryQueueOperationIdSpecContext } from './retry-queue-operation-id-replay.spec-helpers';

export function registerRetryQueueOperationIdCasRefreshUnknownOutcomeSpecs(
  getContext: () => RetryQueueOperationIdSpecContext,
): void {
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
    const originalOperationId = service.getItems()[0]?.operationId;
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
    expect(service.getItems()[0]?.operationId).not.toBe(originalOperationId);
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

  it('刷新同一实体为新 payload 且未显式传入 operationId 时应生成新的幂等键', () => {
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
    expect(service.getItems()[0]?.operationId).not.toBe(oldOperationId);
    expect(isSyncOperationId(service.getItems()[0]?.operationId)).toBe(true);
  });

  it('刷新同一实体但逻辑 payload 未变化时应保留已有幂等键', () => {
    const { service, createTask, stableUUID } = getContext();
    const task = createTask('task-refresh-same-logical-operation');
    task.id = stableUUID('task-refresh-same-logical-operation');
    task.updatedAt = '2026-06-11T04:30:00.000Z';
    const operationId = stableUUID('retry-op-same-logical-refresh');

    service.add(
      'task',
      'upsert',
      task,
      'project-refresh-same-logical-op',
      'test-user',
      undefined,
      'task_text_update',
      undefined,
      operationId,
    );
    service.add(
      'task',
      'upsert',
      { ...task },
      'project-refresh-same-logical-op',
      'test-user',
      undefined,
      'task_text_update',
    );

    expect(service.getItems()).toHaveLength(1);
    expect(service.getItems()[0]?.operationId).toBe(operationId);
  });

  it('刷新同一 payload 的 projectId 或 writeIntent 时也应生成新的幂等键', () => {
    const { service, createTask, stableUUID } = getContext();
    const projectChangedTask = createTask('task-refresh-project-change');
    const intentChangedTask = createTask('task-refresh-intent-change');
    projectChangedTask.id = stableUUID('task-refresh-project-change');
    intentChangedTask.id = stableUUID('task-refresh-intent-change');
    const projectOperationId = stableUUID('retry-op-project-change');
    const intentOperationId = stableUUID('retry-op-intent-change');

    service.add(
      'task',
      'upsert',
      projectChangedTask,
      'project-before-refresh',
      'test-user',
      undefined,
      'task_text_update',
      undefined,
      projectOperationId,
    );
    service.add(
      'task',
      'upsert',
      { ...projectChangedTask },
      'project-after-refresh',
      'test-user',
      undefined,
      'task_text_update',
    );

    service.add(
      'task',
      'upsert',
      intentChangedTask,
      'project-intent-refresh',
      'test-user',
      undefined,
      'task_text_update',
      undefined,
      intentOperationId,
    );
    service.add(
      'task',
      'upsert',
      { ...intentChangedTask },
      'project-intent-refresh',
      'test-user',
      undefined,
      'task_structure_update',
    );

    const projectItem = service.getItems().find(item => item.data.id === projectChangedTask.id);
    const intentItem = service.getItems().find(item => item.data.id === intentChangedTask.id);
    expect(projectItem?.operationId).not.toBe(projectOperationId);
    expect(intentItem?.operationId).not.toBe(intentOperationId);
  });

  it('blackbox 新 payload 未显式传入 operationId 时应生成新幂等键并清除旧 unknown 标记', () => {
    const { service, createBlackBoxEntry, stableUUID } = getContext();
    const entryId = stableUUID('blackbox-refresh-new-operation');
    const oldOperationId = stableUUID('blackbox-refresh-old-operation-id');
    const firstEntry = createBlackBoxEntry('blackbox-refresh-first', {
      id: entryId,
      content: 'first payload',
      updatedAt: '2026-06-11T04:00:00.000Z',
    });
    const refreshedEntry = createBlackBoxEntry('blackbox-refresh-second', {
      id: entryId,
      content: 'second payload',
      updatedAt: '2026-06-11T04:30:00.000Z',
    });

    service.add(
      'blackbox',
      'upsert',
      firstEntry,
      undefined,
      'test-user',
      undefined,
      undefined,
      undefined,
      oldOperationId,
      {
        errorType: 'TimeoutError',
        message: 'blackbox remote outcome unknown',
        remoteOutcome: 'unknown',
        recordedAt: 4_000,
      },
    );
    service.add('blackbox', 'upsert', refreshedEntry, undefined, 'test-user');

    expect(service.getItems()).toHaveLength(1);
    expect(service.getItems()[0]).toEqual(expect.objectContaining({
      data: expect.objectContaining({ id: entryId, content: 'second payload' }),
      lastFailure: undefined,
    }));
    expect(service.getItems()[0]?.operationId).not.toBe(oldOperationId);
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

  it('刷新同一实体为新的 operationId 时应清除旧 operation 的远端结果未知标记', () => {
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
      lastFailure: undefined,
    }));
  });

  it('刷新同一逻辑 operation 且未携带新失败上下文时应保留远端结果未知标记', () => {
    const { service, createTask, stableUUID } = getContext();
    const task = createTask('task-preserve-same-unknown-outcome');
    task.id = stableUUID('task-preserve-same-unknown-outcome');
    task.updatedAt = '2026-06-11T05:00:00.000Z';
    const operationId = stableUUID('retry-op-preserve-same-unknown');
    const lastFailure = {
      errorType: 'TimeoutError',
      message: '请求超时 (30000ms): same logical task',
      remoteOutcome: 'unknown' as const,
      recordedAt: 5_000,
    };

    service.add(
      'task',
      'upsert',
      task,
      'project-preserve-same-unknown',
      'test-user',
      undefined,
      'task_text_update',
      undefined,
      operationId,
      lastFailure,
    );
    service.add(
      'task',
      'upsert',
      { ...task },
      'project-preserve-same-unknown',
      'test-user',
      undefined,
      'task_text_update',
    );

    expect(service.getItems()).toHaveLength(1);
    expect(service.getItems()[0]).toEqual(expect.objectContaining({
      operationId,
      lastFailure,
    }));
  });
}
