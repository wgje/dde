import { expect, it, vi } from 'vitest';

import type { Connection, Task } from '../../../../models';
import type { SessionRuntimeResetReason } from '../../../../services/session-runtime-reset.service';
import type { BatchSyncCallbacks, BatchSyncService } from './batch-sync.service';
import { createProject, createProjectChanges } from './batch-sync.test-harness';

type MockFn = ReturnType<typeof vi.fn>;

export interface BatchSyncSessionGenerationSpecContext {
  service: BatchSyncService;
  callbacks: BatchSyncCallbacks;
  mockClient: { auth: { getSession: MockFn } };
  mockChangeTracker: {
    getProjectChanges: MockFn;
    clearTaskChangeIfFresh: MockFn;
    clearConnectionChangeIfFresh: MockFn;
  };
  mockSyncState: {
    setSyncing: MockFn;
    setSyncError: MockFn;
    advanceLastSyncTimeIfIdle: MockFn;
  };
  mockCircuitBreaker: { updateLastKnownTaskCount: MockFn };
  sessionResetCallbacks: Map<string, (reason: SessionRuntimeResetReason) => void>;
}

export function registerBatchSyncSessionGenerationSpecs(
  getContext: () => BatchSyncSessionGenerationSpecContext,
): void {
  it('project push 在途发生 session reset 时旧批次应停止并按原 owner 入队，不得覆盖新会话同步状态', async () => {
    const { service, callbacks, mockClient, mockSyncState, mockCircuitBreaker, sessionResetCallbacks } = getContext();
    const project = createProject({ id: 'project-session-generation-guard' });
    let resolveProjectPush!: (result: { success: boolean }) => void;
    callbacks.pushProject = vi.fn().mockReturnValue(new Promise(resolve => { resolveProjectPush = resolve; }));
    service.setCallbacks(callbacks);
    mockClient.auth.getSession.mockResolvedValue({ data: { session: { user: { id: 'user-a' } } } });

    const pending = service.saveProjectToCloud(project, 'user-a');
    await vi.waitFor(() => expect(callbacks.pushProject).toHaveBeenCalledTimes(1));
    resetSessionRuntimes(sessionResetCallbacks);
    resolveProjectPush({ success: true });

    const result = await pending;
    expect(result.success).toBe(false);
    expect(result.failureReason).toBe('project sync session changed');
    expect(result.retryEnqueued).toContain(`project:${project.id}`);
    expect(vi.mocked(callbacks.addToRetryQueueDurably).mock.calls.at(-1)?.[4]).toBe('user-a');
    expect(callbacks.purgeTasksFromCloud).not.toHaveBeenCalled();
    expect(callbacks.pushTask).not.toHaveBeenCalled();
    expect(callbacks.pushConnection).not.toHaveBeenCalled();
    expect(mockSyncState.setSyncing).not.toHaveBeenCalled();
    expect(mockSyncState.setSyncError).not.toHaveBeenCalled();
    expect(mockSyncState.advanceLastSyncTimeIfIdle).not.toHaveBeenCalled();
    expect(mockCircuitBreaker.updateLastKnownTaskCount).not.toHaveBeenCalled();
  });

  it('task push 在途发生 session reset 时不得清除旧批次脏标记或执行成功收尾', async () => {
    const { service, callbacks, mockClient, mockChangeTracker, mockSyncState, sessionResetCallbacks } = getContext();
    const task = createTask('task-session-generation-guard', 'Generation Guard');
    const project = createProject({ id: 'project-task-session-generation-guard', tasks: [task] });
    let resolveTaskPush!: (result: { success: boolean; retryEnqueued: boolean }) => void;
    callbacks.pushTask = vi.fn().mockReturnValue(new Promise(resolve => { resolveTaskPush = resolve; }));
    service.setCallbacks(callbacks);
    mockClient.auth.getSession.mockResolvedValue({ data: { session: { user: { id: 'user-a' } } } });

    const pending = service.saveProjectToCloud(project, 'user-a');
    await vi.waitFor(() => expect(callbacks.pushTask).toHaveBeenCalledTimes(1));
    resetSessionRuntimes(sessionResetCallbacks);
    resolveTaskPush({ success: true, retryEnqueued: false });

    expect((await pending).failureReason).toBe('project sync session changed');
    expect(mockChangeTracker.clearTaskChangeIfFresh).not.toHaveBeenCalled();
    expect(mockSyncState.setSyncing).not.toHaveBeenCalled();
    expect(mockSyncState.advanceLastSyncTimeIfIdle).not.toHaveBeenCalled();
  });

  it('connection push 在途发生 session reset 时不得清除旧批次连接脏标记', async () => {
    const { service, callbacks, mockClient, mockChangeTracker, sessionResetCallbacks } = getContext();
    const task = createTask('task-connection-generation-guard', 'Connection Guard');
    const connection: Connection = { id: 'connection-session-generation-guard', source: task.id, target: task.id };
    const project = createProject({ id: 'project-connection-session-generation-guard', tasks: [task], connections: [connection] });
    let resolveConnectionPush!: (result: { success: boolean; retryEnqueued: boolean }) => void;
    callbacks.pushConnection = vi.fn().mockReturnValue(new Promise(resolve => { resolveConnectionPush = resolve; }));
    service.setCallbacks(callbacks);
    mockClient.auth.getSession.mockResolvedValue({ data: { session: { user: { id: 'user-a' } } } });

    const pending = service.saveProjectToCloud(project, 'user-a');
    await vi.waitFor(() => expect(callbacks.pushConnection).toHaveBeenCalledTimes(1));
    resetSessionRuntimes(sessionResetCallbacks);
    resolveConnectionPush({ success: true, retryEnqueued: false });

    expect((await pending).failureReason).toBe('project sync session changed');
    expect(mockChangeTracker.clearConnectionChangeIfFresh).not.toHaveBeenCalled();
  });

  it('session 预检在途发生 reset 时不得把晚到账号写成全局 owner mismatch', async () => {
    const { service, callbacks, mockClient, mockSyncState, sessionResetCallbacks } = getContext();
    const project = createProject({ id: 'project-preflight-session-generation-guard' });
    let resolveSession!: (value: { data: { session: { user: { id: string } } } }) => void;
    mockClient.auth.getSession.mockReturnValue(new Promise(resolve => { resolveSession = resolve; }));

    const pending = service.saveProjectToCloud(project, 'user-a');
    await vi.waitFor(() => expect(mockClient.auth.getSession).toHaveBeenCalledTimes(1));
    resetSessionRuntimes(sessionResetCallbacks);
    resolveSession({ data: { session: { user: { id: 'user-b' } } } });

    expect((await pending).failureReason).toBe('project sync session changed');
    expect(callbacks.pushProject).not.toHaveBeenCalled();
    expect(mockSyncState.setSyncError).not.toHaveBeenCalled();
  });

  it('task purge 在途发生 session reset 时不得清除旧批次删除脏标记', async () => {
    const { service, callbacks, mockClient, mockChangeTracker, sessionResetCallbacks } = getContext();
    const taskId = 'task-purge-session-generation-guard';
    const project = createProject({ id: 'project-purge-session-generation-guard' });
    mockChangeTracker.getProjectChanges.mockReturnValueOnce(createProjectChanges({ taskIdsToDelete: [taskId] }));
    let resolvePurge!: (result: { success: boolean; deletedTaskIds: string[] }) => void;
    callbacks.purgeTasksFromCloud = vi.fn().mockReturnValue(new Promise(resolve => { resolvePurge = resolve; }));
    service.setCallbacks(callbacks);
    mockClient.auth.getSession.mockResolvedValue({ data: { session: { user: { id: 'user-a' } } } });

    const pending = service.saveProjectToCloud(project, 'user-a');
    await vi.waitFor(() => expect(callbacks.purgeTasksFromCloud).toHaveBeenCalledTimes(1));
    resetSessionRuntimes(sessionResetCallbacks);
    resolvePurge({ success: true, deletedTaskIds: [taskId] });

    expect((await pending).failureReason).toBe('project sync session changed');
    expect(mockChangeTracker.clearTaskChangeIfFresh).not.toHaveBeenCalled();
  });

  it('task tombstone 读取在途发生 reset 时不得继续读取 connection tombstone', async () => {
    const { service, callbacks, mockClient, sessionResetCallbacks } = getContext();
    const project = createProject({ id: 'project-prepare-session-generation-guard' });
    let resolveTaskTombstones!: (value: Set<string>) => void;
    callbacks.getTombstoneIds = vi.fn().mockReturnValue(new Promise(resolve => { resolveTaskTombstones = resolve; }));
    service.setCallbacks(callbacks);
    mockClient.auth.getSession.mockResolvedValue({ data: { session: { user: { id: 'user-a' } } } });

    const pending = service.saveProjectToCloud(project, 'user-a');
    await vi.waitFor(() => expect(callbacks.getTombstoneIds).toHaveBeenCalledTimes(1));
    resetSessionRuntimes(sessionResetCallbacks);
    resolveTaskTombstones(new Set());

    expect((await pending).failureReason).toBe('project sync session changed');
    expect(callbacks.getConnectionTombstoneIds).not.toHaveBeenCalled();
    expect(callbacks.pushProject).not.toHaveBeenCalled();
  });
}

function resetSessionRuntimes(
  callbacks: Map<string, (reason: SessionRuntimeResetReason) => void>,
): void {
  for (const reset of callbacks.values()) reset('owner-change');
}

function createTask(id: string, title: string): Task {
  return {
    id, title, content: '', stage: 0, parentId: null, order: 0, rank: 0,
    status: 'active', x: 0, y: 0, displayId: '1', createdDate: '2026-03-31T00:00:00.000Z',
  };
}
