import { describe, expect, it, vi } from 'vitest';

import type { Project, Task, Connection } from '../../../models';
import type { TaskWriteIntent } from '../../../services/sync-rpc-client.service';
import type {
  BatchSyncCallbacks,
  BatchSyncService,
  RetryQueueLastFailure,
  TaskDeleteBaseUpdatedAtMap,
  TaskPurgeResult,
} from './sync';
import {
  configureSimpleSyncBatchCallbacks,
  type SimpleSyncBatchCallbackFacade,
} from './simple-sync-callbacks.helpers';

function createFacade(): SimpleSyncBatchCallbackFacade {
  return {
    pushProjectFromBatchSync: vi.fn(async () => ({ success: true })),
    pushTaskWithResult: vi.fn(async () => ({ success: true })),
    pushTaskPosition: vi.fn(async () => true),
    pushConnectionWithResult: vi.fn(async () => ({ success: true })),
    getTombstoneIds: vi.fn(async () => new Set<string>()),
    getConnectionTombstoneIds: vi.fn(async () => new Set<string>()),
    purgeTasksFromCloudWithResult: vi.fn(async (): Promise<TaskPurgeResult> => ({
      success: false,
      deletedTaskIds: [],
      skippedTaskIds: [],
      retriedTaskIds: [],
    })),
    topologicalSortTasks: vi.fn((tasks: Task[]) => tasks),
    addToRetryQueue: vi.fn(async (
      _type,
      _operation,
      _data,
      _projectId,
      _sourceUserId,
      _taskIdsToDelete,
      _writeIntent?: TaskWriteIntent,
      _taskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap,
      _operationId?: string,
      _lastFailure?: RetryQueueLastFailure,
    ) => true),
    addToRetryQueueDurably: vi.fn(async (
      _type,
      _operation,
      _data,
      _projectId,
      _sourceUserId,
      _taskIdsToDelete,
      _writeIntent?: TaskWriteIntent,
      _taskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap,
      _operationId?: string,
      _lastFailure?: RetryQueueLastFailure,
    ) => true),
    confirmRetryQueuePersistence: vi.fn(async () => true),
  };
}

describe('configureSimpleSyncBatchCallbacks', () => {
  it('passes task purge operationId through the batch callback facade', async () => {
    const setCallbacks = vi.fn();
    const facade = createFacade();
    configureSimpleSyncBatchCallbacks({
      batchSyncService: { setCallbacks } as unknown as BatchSyncService,
      facade,
    });
    const callbacks = setCallbacks.mock.calls[0]?.[0] as BatchSyncCallbacks | undefined;
    if (!callbacks) throw new Error('expected callbacks to be registered');

    await callbacks.purgeTasksFromCloud(
      'project-1',
      ['task-1'],
      'user-1',
      { 'task-1': '2026-06-27T00:00:00.000Z' },
      'op-batch-delete-1',
    );

    expect(facade.purgeTasksFromCloudWithResult).toHaveBeenCalledWith(
      'project-1',
      ['task-1'],
      'user-1',
      { 'task-1': '2026-06-27T00:00:00.000Z' },
      'op-batch-delete-1',
    );
  });

  it('passes task position operationId through the batch callback facade', async () => {
    const setCallbacks = vi.fn();
    const facade = createFacade();
    const task = { id: 'task-position-op' } as Task;
    configureSimpleSyncBatchCallbacks({
      batchSyncService: { setCallbacks } as unknown as BatchSyncService,
      facade,
    });
    const callbacks = setCallbacks.mock.calls[0]?.[0] as BatchSyncCallbacks | undefined;
    if (!callbacks) throw new Error('expected callbacks to be registered');

    await callbacks.pushTaskPosition(
      'task-position-op',
      10,
      20,
      'project-1',
      task,
      'user-1',
      '22222222-2222-4222-8222-222222222222',
    );

    expect(facade.pushTaskPosition).toHaveBeenCalledWith(
      'task-position-op',
      10,
      20,
      'project-1',
      task,
      'user-1',
      '22222222-2222-4222-8222-222222222222',
    );
  });
});
