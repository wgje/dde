import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ActionQueueEnqueueMutationService } from './action-queue-enqueue-mutation.service';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import type {
  EnqueueParams,
  QueuedAction,
  RetryQueueSupersessionReservation,
} from './action-queue.types';

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

function createPreferenceAction(): Extract<EnqueueParams, { entityType: 'preference' }> {
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
        baseUpdatedAt: '2026-07-14T01:00:00.000Z',
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
      baseUpdatedAt: '2026-07-14T01:00:00.000Z',
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
        baseUpdatedAt: '2026-07-14T01:00:00.000Z',
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
      payload: {
        userId: 'user-1',
        sourceUserId: 'source-user-1',
        baseUpdatedAt: '2026-07-14T02:00:00.000Z',
        preferences: {
          autoResolveConflicts: false,
        },
      },
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
      baseUpdatedAt: '2026-07-14T02:00:00.000Z',
      preferences: {
        theme: 'default',
        autoResolveConflicts: false,
      },
    });
  });

  it('does not use a held action as a same-entity merge target', () => {
    const held = createPreferenceQueuedAction({
      id: 'held-action',
      operationId: 'operation-held',
      syncState: 'held' as never,
    });
    const pending = createPreferenceQueuedAction({
      id: 'pending-action',
      operationId: 'operation-pending',
    });

    const mutation = service.buildCurrentOwnerEnqueueMutation(
      [held],
      createPreferenceAction(),
      pending,
    );

    expect(mutation.nextQueue).toEqual([held, pending]);
    expect(mutation.resolvedActionId).toBe('pending-action');
  });

  it('does not merge a newly held action into an existing same-entity action', () => {
    const existing = createPreferenceQueuedAction({
      id: 'existing-action',
      operationId: 'operation-existing',
    });
    const held = createPreferenceQueuedAction({
      id: 'held-action',
      operationId: 'operation-held',
      syncState: 'held' as never,
    });

    const mutation = service.buildCurrentOwnerEnqueueMutation(
      [existing],
      createPreferenceAction(),
      held,
    );

    expect(mutation.nextQueue).toEqual([existing, held]);
    expect(mutation.resolvedActionId).toBe('held-action');
  });

  it('preserves unresolved RetryQueue reservations across an action merge', () => {
    const existingReservation = createSupersessionReservation('reservation-existing');
    const incomingReservation = createSupersessionReservation('reservation-incoming');
    const existing = createPreferenceQueuedAction({
      id: 'existing-action',
      operationId: 'operation-existing',
      retryQueueSupersessions: [existingReservation],
    });
    const incoming = createPreferenceQueuedAction({
      retryQueueSupersessions: [incomingReservation],
    });

    const mutation = service.buildCurrentOwnerEnqueueMutation(
      [existing],
      createPreferenceAction(),
      incoming,
    );

    expect(mutation.nextQueue[0].retryQueueSupersessions).toEqual([
      existingReservation,
      incomingReservation,
    ]);
  });

  it('does not move unresolved reservations onto a new operation after an attempt', () => {
    const retryQueueSupersessions = [createSupersessionReservation('reservation-attempted')];
    const existing = createPreferenceQueuedAction({
      id: 'existing-action',
      operationId: 'operation-existing',
      lastError: 'previous network failure',
      retryQueueSupersessions,
    });
    const incoming = createPreferenceQueuedAction({
      id: 'incoming-action',
      operationId: 'operation-incoming',
    });

    const mutation = service.buildCurrentOwnerEnqueueMutation(
      [existing],
      createPreferenceAction(),
      incoming,
    );

    expect(mutation.nextQueue).toEqual([existing, incoming]);
    expect(mutation.resolvedActionId).toBe('incoming-action');
  });

  it('does not shrink a reserved create/delete pair before supersession settlement', () => {
    const retryQueueSupersessions = [createSupersessionReservation('reservation-create')];
    const existing = createPreferenceQueuedAction({
      id: 'existing-create',
      operationId: 'operation-create',
      type: 'create',
      retryQueueSupersessions,
    });
    const deleteAction: EnqueueParams = {
      ...createPreferenceAction(),
      type: 'delete',
    };
    const queuedDelete = createPreferenceQueuedAction({
      id: 'queued-delete',
      operationId: 'operation-delete',
      type: 'delete',
    });

    const mutation = service.buildCurrentOwnerEnqueueMutation(
      [existing],
      deleteAction,
      queuedDelete,
    );

    expect(mutation.wasMergeShrunk).toBe(false);
    expect(mutation.nextQueue).toEqual([
      expect.objectContaining({
        id: 'existing-create',
        type: 'delete',
        retryQueueSupersessions,
      }),
    ]);
  });
});

function createSupersessionReservation(token: string): RetryQueueSupersessionReservation {
  return {
    token,
    ownerUserId: 'user-1',
    entityType: 'task',
    entityId: 'task-1',
    actionId: 'existing-action',
    actionOperationId: 'operation-existing',
    retryItems: [{ id: 'retry-1', operationId: 'retry-operation-1' }],
  };
}
