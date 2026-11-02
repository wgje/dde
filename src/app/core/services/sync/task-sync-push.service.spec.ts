import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import type { Task } from '../../../../models';
import type { TaskWriteIntent } from '../../../../services/sync-rpc-client.service';
// Load the facade first so the existing sync-service module cycle initializes its base class safely.
import './task-sync-operations.service';
import { TaskSyncPushService } from './task-sync-push.service';

type SafeAddToRetryQueue = (
  entityType: 'task',
  operation: 'upsert',
  task: Task,
  projectId: string,
  sourceUserId?: string,
  allowWhenSessionExpired?: boolean,
  writeIntent?: TaskWriteIntent,
  operationId?: string,
) => Promise<void>;

interface PushTaskHarness {
  pushTask: TaskSyncPushService['pushTask'];
  syncStateService: { isSessionExpired: () => boolean };
  retryQueueService: { checkCircuitBreaker: () => boolean };
  logger: { debug: (message: string, context?: Record<string, unknown>) => void };
  safeAddToRetryQueue: SafeAddToRetryQueue;
  getSupabaseClient: () => SupabaseClient | null;
}

function createPushTaskHarness(circuitBreakerAvailable: boolean, client: SupabaseClient | null = null) {
  const service = Object.create(TaskSyncPushService.prototype) as PushTaskHarness;
  const safeAddToRetryQueue = vi.fn<SafeAddToRetryQueue>();
  const getSupabaseClient = vi.fn((): SupabaseClient | null => client);

  service.syncStateService = { isSessionExpired: vi.fn(() => false) };
  service.retryQueueService = { checkCircuitBreaker: vi.fn(() => circuitBreakerAvailable) };
  service.logger = { debug: vi.fn() };
  service.safeAddToRetryQueue = safeAddToRetryQueue;
  service.getSupabaseClient = getSupabaseClient;

  return { service, safeAddToRetryQueue, getSupabaseClient };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Task 1',
    content: 'keep content',
    stage: 0,
    parentId: null,
    order: 0,
    rank: 10000,
    status: 'active',
    x: 0,
    y: 0,
    createdDate: '2026-06-15T23:59:00.000Z',
    updatedAt: '2026-06-16T00:00:00.000Z',
    displayId: 'T-1',
    ...overrides,
  };
}

describe('TaskSyncPushService.pushTask entry guards', () => {
  const task = makeTask();

  it.each(['stage', 'content'] as const)(
    'rejects a task missing %s before queue or RPC access',
    async (field) => {
      const { service, safeAddToRetryQueue, getSupabaseClient } = createPushTaskHarness(false);
      const incompleteTask = { ...task } as Partial<Task>;
      delete incompleteTask[field];

      await expect(service.pushTask(
        incompleteTask as Task,
        'project-1',
        false,
        false,
        'owner-1',
        false,
        'task_full_upsert',
        'operation-invalid',
      )).rejects.toMatchObject({
        name: 'PermanentFailureError',
        context: {
          operation: 'pushTaskPayloadValidation',
          taskId: 'task-1',
          projectId: 'project-1',
          unsafeFields: [field],
        },
      });
      expect(safeAddToRetryQueue).not.toHaveBeenCalled();
      expect(getSupabaseClient).not.toHaveBeenCalled();
    },
  );

  it('preserves owner and operation metadata when the circuit breaker blocks a new push', async () => {
    const { service, safeAddToRetryQueue, getSupabaseClient } = createPushTaskHarness(false);

    const result = await service.pushTask(
      task,
      'project-1',
      true,
      false,
      'owner-1',
      true,
      'task_structure_update',
      'operation-1',
    );

    expect(result).toBe(false);
    expect(safeAddToRetryQueue).toHaveBeenCalledWith(
      'task',
      'upsert',
      task,
      'project-1',
      'owner-1',
      false,
      'task_structure_update',
      'operation-1',
    );
    expect(getSupabaseClient).not.toHaveBeenCalled();
  });

  it('does not duplicate a retry item when no client is available during replay', async () => {
    const { service, safeAddToRetryQueue, getSupabaseClient } = createPushTaskHarness(true);

    const result = await service.pushTask(
      task,
      'project-1',
      false,
      true,
      'owner-1',
      false,
      'task_full_upsert',
      'operation-2',
    );

    expect(result).toBe(false);
    expect(getSupabaseClient).toHaveBeenCalledOnce();
    expect(safeAddToRetryQueue).not.toHaveBeenCalled();
  });
});
