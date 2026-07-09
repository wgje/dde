import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ActionQueueEnqueueMutationService } from './action-queue-enqueue-mutation.service';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import type { EnqueueParams, QueuedAction } from './action-queue.types';

const mockLoggerCategory = {
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
};

const mockLoggerService = {
  category: vi.fn(() => mockLoggerCategory),
};

const mockToastService = {
  warning: vi.fn(),
};

function createPreferenceAction(): EnqueueParams {
  return {
    type: 'update',
    entityType: 'preference',
    entityId: 'preferences:user-1',
    payload: {
      userId: 'user-1',
      preferences: {
        autoResolveConflicts: false,
      },
    },
  };
}

function createPreferenceQueuedAction(
  overrides: Partial<QueuedAction> = {},
): QueuedAction {
  return {
    id: 'queued-action',
    operationId: 'operation-next',
    type: 'update',
    entityType: 'preference',
    entityId: 'preferences:user-1',
    payload: {
      userId: 'user-1',
      sourceUserId: 'source-user-1',
      preferences: {
        autoResolveConflicts: false,
      },
    },
    timestamp: 2_000,
    localCommittedAt: 2_000,
    syncState: 'pending_sync',
    retryCount: 0,
    priority: 'low',
    ...overrides,
  };
}

describe('ActionQueueEnqueueMutationService', () => {
  let service: ActionQueueEnqueueMutationService;

  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      providers: [
        ActionQueueEnqueueMutationService,
        { provide: LoggerService, useValue: mockLoggerService },
        { provide: ToastService, useValue: mockToastService },
      ],
    });
    service = TestBed.inject(ActionQueueEnqueueMutationService);
  });

  it('keeps the existing operation id when merging an unattempted pending action', () => {
    const existing = createPreferenceQueuedAction({
      id: 'existing-action',
      operationId: 'operation-existing',
      payload: {
        userId: 'user-1',
        sourceUserId: 'source-user-1',
        preferences: {
          theme: 'default',
        },
      },
      timestamp: 1_000,
      localCommittedAt: 1_000,
    });
    const queuedAction = createPreferenceQueuedAction({
      id: 'queued-action',
      operationId: 'operation-next',
    });

    const mutation = service.buildCurrentOwnerEnqueueMutation(
      [existing],
      createPreferenceAction(),
      queuedAction,
    );

    expect(mutation.resolvedActionId).toBe('existing-action');
    expect(mutation.wasEnqueued).toBe(true);
    expect(mutation.nextQueue).toHaveLength(1);
    expect(mutation.nextQueue[0].id).toBe('existing-action');
    expect(mutation.nextQueue[0].operationId).toBe('operation-existing');
    expect(mutation.nextQueue[0].timestamp).toBe(1_000);
    expect(mutation.nextQueue[0].localCommittedAt).toBe(1_000);
    expect(mutation.nextQueue[0].payload).toMatchObject({
      preferences: {
        theme: 'default',
        autoResolveConflicts: false,
      },
    });
  });

  it('rotates the operation id when merging into a pending action that already recorded a failed attempt', () => {
    const existing = createPreferenceQueuedAction({
      id: 'existing-action',
      operationId: 'operation-attempted',
      payload: {
        userId: 'user-1',
        sourceUserId: 'source-user-1',
        preferences: {
          theme: 'default',
        },
      },
      timestamp: 1_000,
      localCommittedAt: 1_000,
      retryCount: 0,
      syncState: 'pending_sync',
      lastError: 'previous network failure',
      errorType: 'network',
    });
    const queuedAction = createPreferenceQueuedAction({
      id: 'queued-action',
      operationId: 'operation-next',
    });

    const mutation = service.buildCurrentOwnerEnqueueMutation(
      [existing],
      createPreferenceAction(),
      queuedAction,
    );

    expect(mutation.resolvedActionId).toBe('existing-action');
    expect(mutation.wasEnqueued).toBe(true);
    expect(mutation.nextQueue).toHaveLength(1);
    expect(mutation.nextQueue[0].id).toBe('existing-action');
    expect(mutation.nextQueue[0].operationId).toBe('operation-next');
    expect(mutation.nextQueue[0].timestamp).toBe(1_000);
    expect(mutation.nextQueue[0].localCommittedAt).toBe(1_000);
    expect(mutation.nextQueue[0].payload).toMatchObject({
      preferences: {
        theme: 'default',
        autoResolveConflicts: false,
      },
    });
  });
});
