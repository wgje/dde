import { runInInjectionContext, signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';

import { createMockDestroyRef } from '../test-setup.mocks';
import { ActionQueueService } from './action-queue.service';
import type { QueuedAction, TaskPayload } from './action-queue.types';
import {
  createActionQueueServiceTestInjector,
  createMockTask,
  mockQueueBackupState,
  resetActionQueueServiceMocks,
} from './action-queue-service-test-harness.spec-helpers';

describe('ActionQueueService project pending write state', () => {
  it('keeps authoritative refresh blocked for a restored task write without project ownership', async () => {
    localStorage.clear();
    resetActionQueueServiceMocks();
    Object.defineProperty(navigator, 'onLine', {
      value: false,
      writable: true,
      configurable: true,
    });

    const taskId = crypto.randomUUID();
    const legacyAction = {
      id: crypto.randomUUID(),
      operationId: crypto.randomUUID(),
      type: 'update',
      entityType: 'task',
      entityId: taskId,
      payload: {
        task: createMockTask({ id: taskId }),
        sourceUserId: 'test-user',
      } as unknown as TaskPayload,
      timestamp: Date.now(),
      retryCount: 0,
      syncState: 'pending_sync',
    } satisfies QueuedAction<TaskPayload>;
    mockQueueBackupState.persistedQueue = [legacyAction];
    mockQueueBackupState.recordFound = true;

    const { destroyRef, destroy } = createMockDestroyRef();
    const injector = createActionQueueServiceTestInjector(signal('test-user'), destroyRef);
    let service!: ActionQueueService;
    runInInjectionContext(injector, () => {
      service = injector.get(ActionQueueService);
    });

    try {
      await service.reloadFromStorageForCurrentOwner();
      await vi.waitFor(() => expect(service.pendingActions()).toEqual([
        expect.objectContaining({ id: legacyAction.id, payload: legacyAction.payload }),
      ]));
      expect(service.getProjectPendingWriteState('project-1', 'test-user')).toBe('unknown');
    } finally {
      service.reset();
      destroy();
      localStorage.clear();
    }
  });
});
