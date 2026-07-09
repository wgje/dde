import { expect, it, type Mock } from 'vitest';

import type { Task } from '../../../../models';
import { createBrowserNetworkSuspendedError } from '../../../../utils/browser-network-suspension';
import type { TaskSyncOperationsService } from './task-sync-operations.service';

type MockFn = Mock<(...args: any[]) => any>;

export interface TaskSyncOperationsBrowserSuspensionSpecContext {
  service: TaskSyncOperationsService;
  setVisibilityState(state: DocumentVisibilityState): void;
  mockClient: {
    auth: { getSession: MockFn };
  };
  mockLogger: {
    warn: MockFn;
  };
  mockRetryQueue: {
    add: MockFn;
    addDurably: MockFn;
  };
  mockSessionManager: {
    handleSessionExpired: MockFn;
    tryRefreshSession: MockFn;
  };
  mockTombstoneService: {
    getLocalTombstones: MockFn;
    getTombstonesWithCache: MockFn;
  };
}

function createTask(overrides: Partial<Task>): Task {
  return {
    id: 'task-browser-suspended',
    title: '任务',
    content: '内容',
    stage: 0,
    parentId: null,
    order: 0,
    rank: 10000,
    status: 'active',
    x: 0,
    y: 0,
    displayId: 'T-S',
    createdDate: new Date().toISOString(),
    deletedAt: null,
    ...overrides,
  };
}

export function registerTaskSyncOperationsBrowserSuspensionSpecs(
  getContext: () => TaskSyncOperationsBrowserSuspensionSpecContext,
): void {
  it('pushTask 在浏览器网络挂起导致 session 暂不可用时应延后而非标记过期', async () => {
    const { service, setVisibilityState, mockClient, mockRetryQueue, mockSessionManager } = getContext();
    const task = createTask({
      id: 'task-browser-suspended-session',
      displayId: 'T-S',
    });
    setVisibilityState('hidden');
    mockClient.auth.getSession.mockResolvedValueOnce({ data: { session: null } } as any);
    mockSessionManager.tryRefreshSession.mockResolvedValueOnce(false);

    const result = await service.pushTask(task, 'project-1', false, false, 'user-1');

    expect(result).toBe(false);
    expect(mockSessionManager.handleSessionExpired).not.toHaveBeenCalled();
    expect(mockRetryQueue.addDurably).toHaveBeenCalledWith(
      'task',
      'upsert',
      task,
      'project-1',
      'user-1',
      undefined,
      undefined,
      undefined,
      undefined,
    );
  });

  it('getTombstoneIdsWithStatus 在浏览器网络挂起时应只用本地缓存且不告警', async () => {
    const { service, setVisibilityState, mockLogger, mockTombstoneService } = getContext();
    const localTombstones = new Set(['task-local-delete']);
    mockTombstoneService.getLocalTombstones.mockReturnValueOnce(localTombstones);
    setVisibilityState('hidden');

    const result = await service.getTombstoneIdsWithStatus('project-1');

    expect(result.ids).toEqual(localTombstones);
    expect(result.fromRemote).toBe(false);
    expect(result.localCacheOnly).toBe(true);
    expect(mockTombstoneService.getTombstonesWithCache).not.toHaveBeenCalled();
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it('重试队列回放 task upsert 遇到浏览器网络挂起时应抛出延后错误，避免消耗 retry budget', async () => {
    const { service, setVisibilityState, mockClient, mockRetryQueue, mockSessionManager } = getContext();
    const task = createTask({
      id: 'task-browser-suspended-replay',
      displayId: 'T-SR',
    });
    setVisibilityState('hidden');
    mockClient.auth.getSession.mockResolvedValueOnce({ data: { session: null } } as any);
    mockSessionManager.tryRefreshSession.mockResolvedValueOnce(false);

    await expect(service.pushTask(task, 'project-1', false, true, 'user-1'))
      .rejects.toMatchObject({ name: 'BrowserNetworkSuspendedError' });
    expect(mockRetryQueue.add).not.toHaveBeenCalled();
  });

  it('pushTaskPosition 在浏览器网络挂起导致 session 暂不可用时不应标记过期', async () => {
    const { service, setVisibilityState, mockClient, mockSessionManager } = getContext();
    setVisibilityState('hidden');
    mockClient.auth.getSession.mockResolvedValueOnce({ data: { session: null } } as any);
    mockSessionManager.tryRefreshSession.mockResolvedValueOnce(false);

    const result = await service.pushTaskPosition('task-position-suspended', 10, 20, 'project-1', undefined, 'user-1');

    expect(result).toBe(false);
    expect(mockSessionManager.handleSessionExpired).not.toHaveBeenCalled();
  });

  it('重试队列回放 task delete 遇到浏览器网络挂起时应抛出延后错误，避免消耗 retry budget', async () => {
    const { service, mockClient, mockRetryQueue } = getContext();
    mockClient.auth.getSession.mockRejectedValueOnce(createBrowserNetworkSuspendedError());

    await expect(service.deleteTask('task-delete-suspended', 'project-1', 'user-1', true))
      .rejects.toMatchObject({ name: 'BrowserNetworkSuspendedError' });
    expect(mockRetryQueue.add).not.toHaveBeenCalled();
  });
}
