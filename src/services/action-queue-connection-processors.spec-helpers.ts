import { expect, it } from 'vitest';

import {
  getProcessor,
  mockActionQueueService,
  mockAuthService,
  mockLoggerCategory,
  mockProjectStateService,
  mockRetryQueueService,
  mockSyncService,
  mockToastService,
  mockUserSessionService,
  setupActionQueueProcessorsHarness,
  type QueuedAction,
} from './action-queue-processors.spec-helpers';

export function registerActionQueueConnectionProcessorSpecs(): void {
  it('connection:create passes the granted lease signal to fenced replay', async () => {
    const handler = getProcessor('connection:create');
    const lease = new AbortController();
    const connection = { id: 'connection-create-1', source: 'task-a', target: 'task-b' };
    mockSyncService.pushConnectionFromActionQueue.mockResolvedValueOnce({ outcome: 'applied' });

    const result = await handler({
      id: 'action-connection-create',
      operationId: 'op-connection-create',
      type: 'create',
      entityType: 'connection',
      entityId: connection.id,
      payload: { connection, projectId: 'p-1', sourceUserId: 'test-user' },
    } as QueuedAction, { leaseSignal: lease.signal });

    expect(mockSyncService.pushConnectionFromActionQueue).toHaveBeenCalledWith(expect.objectContaining({
      actionId: 'action-connection-create',
      actionOperationId: 'op-connection-create',
      connection,
      projectId: 'p-1',
      sourceUserId: 'test-user',
      leaseSignal: lease.signal,
    }));
    expect(mockSyncService.pushConnection).not.toHaveBeenCalled();
    expect(mockActionQueueService.markActionSyncedRemotely).toHaveBeenCalledWith('action-connection-create');
    expect(result).toBe(true);
  });

  it.each([
    ['missing', undefined],
    ['aborted', abortedSignal()],
  ])('connection replay with %s lease signal defers before owner quarantine', async (_label, leaseSignal) => {
    const handler = getProcessor('connection:update');
    const connection = { id: 'connection-fence-missing', source: 'task-a', target: 'task-b' };
    mockAuthService.currentUserId.mockReturnValue('other-user');

    const result = await handler({
      id: 'action-connection-fence-missing',
      operationId: 'op-connection-fence-missing',
      type: 'update',
      entityType: 'connection',
      entityId: connection.id,
      payload: { connection, projectId: 'p-1', sourceUserId: 'test-user' },
    } as QueuedAction, { leaseSignal });

    expect(result).toEqual(expect.objectContaining({ outcome: 'defer-retry' }));
    expect(mockAuthService.currentUserId).not.toHaveBeenCalled();
    expect(mockAuthService.captureAuthIdentityFence).not.toHaveBeenCalled();
    expect(mockUserSessionService.getCurrentSessionGeneration).not.toHaveBeenCalled();
    expect(mockUserSessionService.isSessionContextCurrent).not.toHaveBeenCalled();
    expect(mockActionQueueService.moveToDeadLetter).not.toHaveBeenCalled();
    expect(mockActionQueueService.markActionSyncedRemotely).not.toHaveBeenCalled();
    expect(mockActionQueueService.markActionResolvedWithoutRemote).not.toHaveBeenCalled();
    expect(mockActionQueueService.discardActions).not.toHaveBeenCalled();
    expect(mockToastService.warning).not.toHaveBeenCalled();
    expect(mockLoggerCategory.warn).not.toHaveBeenCalled();
    expect(mockSyncService.pushConnectionFromActionQueue).not.toHaveBeenCalled();
    expect(mockSyncService.pushConnection).not.toHaveBeenCalled();
    expect(mockRetryQueueService.findItemForOwner).not.toHaveBeenCalled();
    expect(mockProjectStateService.getProject).not.toHaveBeenCalled();
    expect(mockProjectStateService.updateProjects).not.toHaveBeenCalled();
  });

  it('connection:delete replays the queued tombstone with queued operationId', async () => {
    const handler = getProcessor('connection:delete');
    const lease = new AbortController();
    const connection = {
      id: 'connection-delete-1',
      source: 'task-a',
      target: 'task-b',
      deletedAt: '2026-06-13T00:00:00.000Z',
    };
    mockSyncService.pushConnectionFromActionQueue.mockResolvedValueOnce({ outcome: 'applied' });

    const result = await handler({
      id: 'action-connection-delete',
      operationId: 'op-connection-delete',
      type: 'delete',
      entityType: 'connection',
      entityId: connection.id,
      payload: { connection, projectId: 'p-1', sourceUserId: 'test-user' },
    } as QueuedAction, { leaseSignal: lease.signal });

    expect(mockSyncService.pushConnectionFromActionQueue).toHaveBeenCalledWith(expect.objectContaining({
      actionId: 'action-connection-delete',
      actionOperationId: 'op-connection-delete',
      connection,
      projectId: 'p-1',
      sourceUserId: 'test-user',
      leaseSignal: lease.signal,
    }));
    expect(mockActionQueueService.markActionSyncedRemotely).toHaveBeenCalledWith('action-connection-delete');
    expect(result).toBe(true);
  });

  it('connection:create does not acknowledge an in-memory RetryQueue winner', async () => {
    const handler = getProcessor('connection:create');
    const lease = new AbortController();
    const connection = {
      id: 'connection-handoff-op-mismatch',
      source: 'task-a',
      target: 'task-b',
    };
    mockSyncService.pushConnectionFromActionQueue.mockResolvedValueOnce({ outcome: 'deferred' });
    mockRetryQueueService.findItemForOwner.mockReturnValueOnce({
      type: 'connection',
      operation: 'upsert',
      data: connection,
      projectId: 'project-1',
      sourceUserId: 'test-user',
      operationId: 'op-new-connection-handoff',
    });

    const result = await handler({
      id: 'action-new-connection-handoff',
      operationId: 'op-new-connection-handoff',
      type: 'create',
      entityType: 'connection',
      entityId: connection.id,
      payload: { connection, projectId: 'project-1', sourceUserId: 'test-user' },
    } as QueuedAction, { leaseSignal: lease.signal });

    expect(result).toEqual(expect.objectContaining({ outcome: 'defer-retry' }));
    expect(mockRetryQueueService.findItemForOwner).not.toHaveBeenCalled();
    expect(mockActionQueueService.markActionSyncedRemotely).not.toHaveBeenCalled();
  });

  it('connection replay quarantines a source owner mismatch before fenced execution', async () => {
    mockAuthService.currentUserId.mockReturnValueOnce('other-user');
    const handler = getProcessor('connection:create');
    const lease = new AbortController();

    const result = await handler({
      id: 'action-owner-mismatch',
      operationId: 'op-owner-mismatch',
      type: 'create',
      entityType: 'connection',
      entityId: 'connection-owner-mismatch',
      payload: {
        connection: { id: 'connection-owner-mismatch', source: 'task-a', target: 'task-b' },
        projectId: 'project-1',
        sourceUserId: 'test-user',
      },
    } as QueuedAction, { leaseSignal: lease.signal });

    expect(result).toBe(true);
    expect(mockSyncService.pushConnectionFromActionQueue).not.toHaveBeenCalled();
    expect(mockActionQueueService.moveToDeadLetter).toHaveBeenCalledOnce();
  });

  it.each([
    ['owner', (_action: QueuedAction) => mockAuthService.currentUserId.mockReturnValue('other-user')],
    ['auth', (_action: QueuedAction) => mockAuthService.captureAuthIdentityFence.mockReturnValue('other-fence')],
    ['session', (_action: QueuedAction) => mockUserSessionService.isSessionContextCurrent.mockReturnValue(false)],
    ['queue', (_action: QueuedAction) => mockActionQueueService.isQueueViewCurrent.mockReturnValue(false)],
    ['project', (_action: QueuedAction) => mockActionQueueService.getProjectMutationViewGeneration.mockReturnValue(2)],
    ['action', (action: QueuedAction) => {
      action.id = 'replacement-action';
    }],
    ['operation', (action: QueuedAction) => {
      action.operationId = 'replacement-operation';
    }],
  ])('connection replay suppresses acknowledgement after %s drift', async (_label, drift) => {
    const handler = getProcessor('connection:update');
    const lease = new AbortController();
    const connection = {
      id: 'connection-drift',
      source: 'task-a',
      target: 'task-b',
    };
    const action = {
      id: 'action-connection-drift',
      operationId: 'op-connection-drift',
      type: 'update',
      entityType: 'connection',
      entityId: connection.id,
      payload: { connection, projectId: 'project-1', sourceUserId: 'test-user' },
    } as QueuedAction;
    mockSyncService.pushConnectionFromActionQueue.mockImplementationOnce(async (
      input: { isFenceCurrent: () => boolean },
    ) => {
      expect(input.isFenceCurrent()).toBe(true);
      drift(action);
      expect(input.isFenceCurrent()).toBe(false);
      return { outcome: 'applied' };
    });

    const result = await handler(action, { leaseSignal: lease.signal });

    expect(result).toEqual(expect.objectContaining({ outcome: 'defer-retry' }));
    expect(mockActionQueueService.markActionSyncedRemotely).not.toHaveBeenCalled();
  });

  it('connection processor construction does not eagerly resolve session state', () => {
    setupActionQueueProcessorsHarness();

    expect(mockUserSessionService.getCurrentSessionGeneration).not.toHaveBeenCalled();
    expect(mockUserSessionService.isSessionContextCurrent).not.toHaveBeenCalled();
  });

  it('connection replay suppresses acknowledgement after action payload drift', async () => {
    const handler = getProcessor('connection:update');
    const lease = new AbortController();
    const connection = { id: 'connection-payload-drift', source: 'task-a', target: 'task-b' };
    const action = {
      id: 'action-connection-payload-drift',
      operationId: 'op-connection-payload-drift',
      type: 'update',
      entityType: 'connection',
      entityId: connection.id,
      payload: { connection, projectId: 'project-1', sourceUserId: 'test-user' },
    } as QueuedAction;
    mockSyncService.pushConnectionFromActionQueue.mockImplementationOnce(async (
      input: { isFenceCurrent: () => boolean },
    ) => {
      connection.target = 'task-c';
      expect(input.isFenceCurrent()).toBe(false);
      return { outcome: 'applied' };
    });

    const result = await handler(action, { leaseSignal: lease.signal });

    expect(result).toEqual(expect.objectContaining({ outcome: 'defer-retry' }));
    expect(mockActionQueueService.markActionSyncedRemotely).not.toHaveBeenCalled();
  });
}

function abortedSignal(): AbortSignal {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}
