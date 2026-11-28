import { Injector, runInInjectionContext } from '@angular/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConflictStorageService } from '../../../../services/conflict-storage.service';
import { LoggerService } from '../../../../services/logger.service';
import type { Task } from '../../../../models';
import type { ProjectSaveBatchContext } from './batch-sync.types';
import { ProjectSaveTaskBatchService } from './project-save-task-batch.service';
import { ProjectSaveEntityStateService } from './project-save-entity-state.service';
import { RetryQueueService } from './retry-queue.service';

import { createBrowserNetworkSuspendedError, isBrowserNetworkSuspendedError, resetBrowserNetworkSuspensionTrackingForTests } from '../../../../utils/browser-network-suspension';

function createService(): ProjectSaveTaskBatchService {
  const injector = Injector.create({ providers: [
    { provide: ProjectSaveTaskBatchService, useClass: ProjectSaveTaskBatchService },
    { provide: LoggerService, useValue: { category: () => ({ info: vi.fn(), warn: vi.fn() }) } },
    { provide: RetryQueueService, useValue: {} },
    { provide: ProjectSaveEntityStateService, useValue: {} },
    { provide: ConflictStorageService, useValue: {} },
  ] });
  return runInInjectionContext(injector, () => injector.get(ProjectSaveTaskBatchService));
}

const task: Task = { id: 'task-A', title: 'T', content: 'explicit text edit', stage: 1,
  parentId: null, order: 1, rank: 1, status: 'active', x: 0, y: 0, displayId: '1',
  createdDate: '2026-11-27T00:00:00.000Z', updatedAt: '2026-11-27T00:01:00.000Z' };

function replayContext() {
  const addToRetryQueueDurably = vi.fn().mockResolvedValue(true);
  const context = {
    callbacks: { topologicalSortTasks: (tasks: Task[]) => tasks, addToRetryQueueDurably },
    userId: 'owner-A', operationId: 'durable-project-op',
    projectSnapshot: { id: 'project-A', tasks: [task], connections: [] },
    changes: { taskUpdateFieldsById: {} },
    writePlan: { taskUpsertIds: [task.id], taskDeleteIds: [], connectionUpsertIds: [],
      connectionDeleteIds: [], taskWriteIntents: { [task.id]: 'task_text_update' } },
    state: { failedTaskIds: [], failedConnectionIds: [], retryEnqueued: [] },
    isSessionCurrent: () => true,
  } as unknown as ProjectSaveBatchContext;
  return { context, addToRetryQueueDurably };
}

describe('durable project intent during suspended replay', () => {
  afterEach(() => resetBrowserNetworkSuspensionTrackingForTests());
  it('uses frozen task intent after restart when live ChangeTracker evidence is empty', async () => {
    isBrowserNetworkSuspendedError(createBrowserNetworkSuspendedError());
    const first = replayContext();
    await createService().pushProjectTasks(first.context, [task]);
    expect(first.addToRetryQueueDurably).toHaveBeenCalledTimes(1);
    expect(first.addToRetryQueueDurably.mock.calls[0]?.[6]).toBe('task_text_update');
    const second = replayContext();
    await createService().pushProjectTasks(second.context, [task]);
    expect(second.addToRetryQueueDurably.mock.calls[0]?.[6]).toBe('task_text_update');
    expect(second.addToRetryQueueDurably.mock.calls[0]?.[8])
      .toBe(first.addToRetryQueueDurably.mock.calls[0]?.[8]);
    expect(second.context.state.retryEnqueued).toEqual(['task:task-A']);
  });
});