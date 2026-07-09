import { expect, it, vi } from 'vitest';

import type { Project, Task } from '../../../../models';
import { isBrowserNetworkSuspendedWindow } from '../../../../utils/browser-network-suspension';
import { PermanentFailureError } from '../../../../utils/permanent-failure-error';
import type { RetryOperationHandler, RetryQueueItem, RetryQueueService } from './retry-queue.service';

type MockFn = ReturnType<typeof vi.fn>;

const SYNC_OPERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface RetryQueueReplayBehaviorSpecContext {
  service: RetryQueueService;
  handler: RetryOperationHandler;
  authServiceMock: {
    currentUserId: MockFn;
  };
  setOnline(value: boolean): void;
  createTask(label: string): Task;
  createProject(label: string): Project;
  stableUUID(label: string): string;
  setVisibilityState(state: DocumentVisibilityState): void;
}

export function registerRetryQueueReplayBehaviorSpecs(
  getContext: () => RetryQueueReplayBehaviorSpecContext,
): void {
  it('processQueueSlice 重放项目时应透传捕获的 sourceUserId', async () => {
    const { service, handler, authServiceMock, setOnline, createProject } = getContext();
    const project = createProject('captured-owner');
    authServiceMock.currentUserId.mockReturnValue('owner-a');
    service.add('project', 'upsert', project, undefined, 'owner-a');
    setOnline(true);
    authServiceMock.currentUserId.mockReturnValue('owner-a');

    await service.processQueueSlice({ maxItems: 1, maxDurationMs: 1000 });

    expect(handler.pushProject).toHaveBeenCalledWith(
      project,
      'owner-a',
      undefined,
      undefined,
      expect.stringMatching(SYNC_OPERATION_ID_PATTERN),
    );
  });

  it('task replay handler 返回 false 时应保留队列项，避免 auth/tombstone 保护误删重试意图', async () => {
    const { service, handler, setOnline, createTask } = getContext();
    const task = createTask('task-auth-tombstone-replay-retained');
    service.add('task', 'upsert', task, 'p-auth-tombstone');
    setOnline(true);
    (handler.pushTask as MockFn).mockResolvedValueOnce(false);

    const result = await service.processQueueSlice({ maxItems: 1, maxDurationMs: 1000 });

    expect(result.processed).toBe(1);
    expect(handler.pushTask).toHaveBeenCalledWith(
      task,
      'p-auth-tombstone',
      'test-user',
      undefined,
      expect.stringMatching(SYNC_OPERATION_ID_PATTERN),
    );
    expect(service.getItems().map(item => item.data.id)).toContain(task.id);
  });

  it('processQueueSlice 修复缺失 operationId 后若无法立即持久化则不应发起远端重放', async () => {
    const { service, handler, setOnline, createTask, stableUUID } = getContext();
    const task = createTask('task-replay-operation-id-repair-persist-fails');
    const loadedItem = {
      id: stableUUID('task-replay-operation-id-repair-item'),
      type: 'task',
      operation: 'upsert',
      data: task,
      projectId: 'project-replay-operation-id-repair',
      retryCount: 0,
      createdAt: Date.now(),
      sourceUserId: 'test-user',
    } as RetryQueueItem;
    (service as unknown as { applyLoadedItems(items: RetryQueueItem[]): void })
      .applyLoadedItems([loadedItem]);
    vi.spyOn(service as unknown as { saveToStorageImmediate(): Promise<boolean> }, 'saveToStorageImmediate')
      .mockResolvedValueOnce(false);
    setOnline(true);

    const result = await service.processQueueSlice({ maxItems: 1, maxDurationMs: 1000 });

    expect(handler.pushTask).not.toHaveBeenCalled();
    expect(result.completed).toBe(false);
    expect(result.remaining).toBe(1);
    expect(service.getItems()[0]?.operationId).toMatch(SYNC_OPERATION_ID_PATTERN);
  });

  it('加载出的同实体重复任务项在重放前应只保留最新本地快照', async () => {
    const { service, handler, setOnline, createTask, stableUUID } = getContext();
    const olderTask = {
      ...createTask('loaded-duplicate-task'),
      title: 'older local title',
      updatedAt: '2026-06-01T00:00:00.000Z',
    };
    const newerTask = {
      ...olderTask,
      title: 'newer local title',
      updatedAt: '2026-06-01T00:01:00.000Z',
    };
    const now = Date.now();
    const loadedItems: RetryQueueItem[] = [
      {
        id: stableUUID('loaded-duplicate-older-item'),
        type: 'task',
        operation: 'upsert',
        data: olderTask,
        projectId: 'project-older',
        retryCount: 1,
        createdAt: now - 1000,
        sourceUserId: 'test-user',
        operationId: stableUUID('loaded-duplicate-older-operation'),
      },
      {
        id: stableUUID('loaded-duplicate-newer-item'),
        type: 'task',
        operation: 'upsert',
        data: newerTask,
        projectId: 'project-newer',
        retryCount: 0,
        createdAt: now,
        sourceUserId: 'test-user',
        operationId: stableUUID('loaded-duplicate-newer-operation'),
      },
    ];
    (service as unknown as { applyLoadedItems(items: RetryQueueItem[]): void })
      .applyLoadedItems(loadedItems);
    setOnline(true);

    await service.processQueueSlice({ maxItems: 10, maxDurationMs: 1000 });

    expect(handler.pushTask).toHaveBeenCalledTimes(1);
    expect(handler.pushTask).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'newer local title' }),
      'project-newer',
      'test-user',
      undefined,
      stableUUID('loaded-duplicate-newer-operation'),
    );
  });

  it('task 重试重放必须保留原始写入意图，避免离线失败后退化为 full upsert', async () => {
    const { service, handler, setOnline, createTask } = getContext();
    const task = createTask('task-replay-write-intent');
    service.add('task', 'upsert', task, 'p-write-intent', 'test-user', undefined, 'task_text_update');
    setOnline(true);

    expect(service.getItems()[0]?.writeIntent).toBe('task_text_update');
    await service.processQueueSlice({ maxItems: 1, maxDurationMs: 1000 });

    expect(handler.pushTask).toHaveBeenCalledWith(
      task,
      'p-write-intent',
      'test-user',
      'task_text_update',
      expect.stringMatching(SYNC_OPERATION_ID_PATTERN),
    );
  });

  it('task 永久失败的终态证据持久化失败时应保留队列项，禁止静默删除', async () => {
    const { service, handler, setOnline, createTask } = getContext();
    const task = createTask('task-terminal-evidence-permanent-failure');
    service.add('task', 'upsert', task, 'p-terminal-evidence', 'test-user');
    setOnline(true);
    const setItemSpy = vi.spyOn(localStorage, 'setItem')
      .mockImplementationOnce(() => {
        throw new Error('legacy review storage unavailable');
      });
    (handler.pushTask as MockFn).mockRejectedValueOnce(
      new PermanentFailureError('conflict must be reviewed'),
    );

    try {
      const result = await service.processQueueSlice({ maxItems: 1, maxDurationMs: 1000 });

      expect(result.completed).toBe(false);
      expect(result.remaining).toBe(1);
      expect(service.getLegacyReviewItems()).toEqual([]);
      expect(service.getItems()).toEqual([
        expect.objectContaining({
          data: expect.objectContaining({ id: task.id }),
        }),
      ]);
    } finally {
      setItemSpy.mockRestore();
    }
  });

  it('task 最大重试终态证据持久化失败时应保留队列项，禁止静默删除', async () => {
    const { service, handler, setOnline, createTask } = getContext();
    const task = createTask('task-terminal-evidence-max-retries');
    const maxRetries = (service as unknown as { MAX_RETRIES: number }).MAX_RETRIES;
    service.add('task', 'upsert', task, 'p-terminal-evidence', 'test-user');
    const retryItem = service.getItems()[0];
    if (!retryItem) throw new Error('expected retry item');
    retryItem.retryCount = maxRetries - 1;
    setOnline(true);
    const setItemSpy = vi.spyOn(localStorage, 'setItem')
      .mockImplementationOnce(() => {
        throw new Error('legacy review storage unavailable');
      });
    (handler.pushTask as MockFn).mockResolvedValueOnce(false);

    try {
      const result = await service.processQueueSlice({ maxItems: 1, maxDurationMs: 1000 });

      expect(result.completed).toBe(false);
      expect(result.remaining).toBe(1);
      expect(service.getLegacyReviewItems()).toEqual([]);
      expect(service.getItems()).toEqual([
        expect.objectContaining({
          data: expect.objectContaining({ id: task.id }),
          retryCount: maxRetries,
        }),
      ]);
    } finally {
      setItemSpy.mockRestore();
    }
  });

  it('命中 session expired 后应立即停止当前切片，避免消耗后续项的 retry budget', async () => {
    const { service, handler, setOnline, createTask } = getContext();
    const firstTask = createTask('task-stop-on-session-expired-a');
    const secondTask = createTask('task-stop-on-session-expired-b');
    let sessionExpired = false;
    service.add('task', 'upsert', firstTask, 'p-stop-expired');
    service.add('task', 'upsert', secondTask, 'p-stop-expired');
    setOnline(true);
    (handler.isSessionExpired as MockFn).mockImplementation(() => sessionExpired);
    (handler.pushTask as MockFn).mockImplementationOnce(async () => {
      sessionExpired = true;
      return false;
    });

    const result = await service.processQueueSlice({ maxItems: 2, maxDurationMs: 1000 });

    expect(result.processed).toBe(1);
    expect(handler.pushTask).toHaveBeenCalledTimes(1);
    expect(service.getItems().map(item => item.data.id)).toEqual([firstTask.id, secondTask.id]);
  });

  it('handler 抛出 auth boundary 错误时应停止切片且不消耗 retry budget', async () => {
    const { service, handler, setOnline, createTask } = getContext();
    const firstTask = createTask('task-auth-boundary-error-a');
    const secondTask = createTask('task-auth-boundary-error-b');
    const authError = new Error('Auth refresh result was discarded');
    authError.name = 'AuthRefreshDiscardedError';
    service.add('task', 'upsert', firstTask, 'p-auth-boundary');
    service.add('task', 'upsert', secondTask, 'p-auth-boundary');
    setOnline(true);
    const recordCircuitFailureSpy = vi.spyOn(service, 'recordCircuitFailure');
    (handler.pushTask as MockFn).mockRejectedValueOnce(authError);

    const result = await service.processQueueSlice({ maxItems: 2, maxDurationMs: 1000 });

    expect(result.processed).toBe(1);
    expect(handler.pushTask).toHaveBeenCalledTimes(1);
    expect(recordCircuitFailureSpy).not.toHaveBeenCalled();
    expect(service.getItems()).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ id: firstTask.id }),
        retryCount: 0,
      }),
      expect.objectContaining({
        data: expect.objectContaining({ id: secondTask.id }),
        retryCount: 0,
      }),
    ]);
  });

  it('handler 抛出 429 服务端背压时应停止切片且不消耗 retry budget', async () => {
    const { service, handler, setOnline, createTask } = getContext();
    const firstTask = createTask('task-server-pressure-a');
    const secondTask = createTask('task-server-pressure-b');
    const maxRetries = (service as unknown as { MAX_RETRIES: number }).MAX_RETRIES;
    service.add('task', 'upsert', firstTask, 'p-server-pressure');
    service.add('task', 'upsert', secondTask, 'p-server-pressure');
    const firstQueueItem = service.getItems()[0];
    if (!firstQueueItem) throw new Error('expected first retry item');
    firstQueueItem.retryCount = maxRetries - 1;
    setOnline(true);
    const recordCircuitFailureSpy = vi.spyOn(service, 'recordCircuitFailure');
    const rateLimitedError = Object.assign(new Error('Too Many Requests'), {
      status: 429,
      retryAfter: 30,
    });
    (handler.pushTask as MockFn).mockRejectedValueOnce(rateLimitedError);

    const result = await service.processQueueSlice({ maxItems: 2, maxDurationMs: 1000 });

    expect(result.processed).toBe(1);
    expect(result.completed).toBe(false);
    expect(handler.pushTask).toHaveBeenCalledTimes(1);
    expect(recordCircuitFailureSpy).not.toHaveBeenCalled();
    expect(service.getItems()).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ id: firstTask.id }),
        retryCount: maxRetries - 1,
      }),
      expect.objectContaining({
        data: expect.objectContaining({ id: secondTask.id }),
        retryCount: 0,
      }),
    ]);
  });

  it('manual processQueue 等待浏览器恢复期间销毁服务后不应继续重放', async () => {
    const { service, handler, setOnline, setVisibilityState, createTask } = getContext();
    vi.useFakeTimers();
    try {
      const task = createTask('manual-suspended-destroyed');
      service.add('task', 'upsert', task, 'p-manual-destroyed');
      setOnline(true);

      expect(isBrowserNetworkSuspendedWindow()).toBe(false);
      setVisibilityState('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      setVisibilityState('visible');
      document.dispatchEvent(new Event('visibilitychange'));
      expect(isBrowserNetworkSuspendedWindow()).toBe(true);

      const processPromise = service.processQueue(undefined, true);
      expect(handler.pushTask).not.toHaveBeenCalled();

      (service as unknown as { lifecycleClosed: boolean }).lifecycleClosed = true;

      await vi.advanceTimersByTimeAsync(1_500);
      await processPromise;

      expect(handler.pushTask).not.toHaveBeenCalled();
      expect(service.getItems().map(item => item.data.id)).toEqual([task.id]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('processQueueSlice 重放项目时应透传 durable taskIdsToDelete', async () => {
    const { service, handler, authServiceMock, setOnline, createProject } = getContext();
    const project = createProject('captured-owner-with-deletes');
    authServiceMock.currentUserId.mockReturnValue('owner-a');
    service.add('project', 'upsert', project, undefined, 'owner-a', ['task-delete-a']);
    setOnline(true);
    authServiceMock.currentUserId.mockReturnValue('owner-a');

    await service.processQueueSlice({ maxItems: 1, maxDurationMs: 1000 });

    expect(handler.pushProject).toHaveBeenCalledWith(
      project,
      'owner-a',
      ['task-delete-a'],
      undefined,
      expect.stringMatching(SYNC_OPERATION_ID_PATTERN),
    );
  });

  it('project 重试项成功重放后的持久化异常应回滚移除并保留队列项', async () => {
    const { service, handler, setOnline, createProject } = getContext();
    const project = createProject('project-replay-persist-throw');
    service.add('project', 'upsert', project, undefined, 'test-user');
    setOnline(true);

    vi.spyOn(service, 'persistNow').mockRejectedValueOnce(new Error('persist crashed'));

    const result = await service.processQueueSlice({ maxItems: 1, maxDurationMs: 1000 });

    expect(handler.pushProject).toHaveBeenCalledWith(
      project,
      'test-user',
      undefined,
      undefined,
      expect.stringMatching(SYNC_OPERATION_ID_PATTERN),
    );
    expect(result.completed).toBe(false);
    expect(result.remaining).toBe(1);
    expect(service.getItems()).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ id: project.id }),
      }),
    ]);
  });

  it('processQueueSlice 重放连接时应透传捕获的 sourceUserId', async () => {
    const { service, handler, authServiceMock, setOnline, stableUUID } = getContext();
    const connection = {
      id: stableUUID('connection-captured-owner'),
      source: 'task-1',
      target: 'task-2',
    };
    authServiceMock.currentUserId.mockReturnValue('owner-a');
    service.add('connection', 'upsert', connection, 'project-1', 'owner-a');
    setOnline(true);
    authServiceMock.currentUserId.mockReturnValue('owner-a');

    await service.processQueueSlice({ maxItems: 1, maxDurationMs: 1000 });

    expect(handler.pushConnection).toHaveBeenCalledWith(
      connection,
      'project-1',
      'owner-a',
      expect.stringMatching(SYNC_OPERATION_ID_PATTERN),
    );
  });

  it('processQueueSlice 重放任务删除时应透传捕获的 sourceUserId 并标记来自重试队列', async () => {
    const { service, handler, authServiceMock, setOnline, stableUUID } = getContext();
    authServiceMock.currentUserId.mockReturnValue('owner-a');
    service.add('task', 'delete', { id: stableUUID('task-delete-captured-owner') }, 'project-1', 'owner-a');
    setOnline(true);
    authServiceMock.currentUserId.mockReturnValue('owner-a');

    await service.processQueueSlice({ maxItems: 1, maxDurationMs: 1000 });

    expect(handler.deleteTask).toHaveBeenCalledWith(
      stableUUID('task-delete-captured-owner'),
      'project-1',
      'owner-a',
      true,
      undefined,
      expect.stringMatching(SYNC_OPERATION_ID_PATTERN),
    );
  });
}
