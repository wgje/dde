import { describe, expect, it } from 'vitest';

import {
  normalizeQueueForOutbox,
} from './action-queue-outbox-normalization.helpers';
import type { PreferencePayload, QueuedAction } from './action-queue.types';
import { createDerivedSyncOperationId } from '../utils/sync-operation-id';

describe('action-queue-outbox-normalization.helpers', () => {
  it('normalizes recovered actions with missing ids to stable action ids', () => {
    const operationId = '11111111-1111-4111-8111-111111111111';
    const [action] = normalizeQueueForOutbox([
      createQueuedPreferenceAction({
        id: '',
        operationId,
      }),
    ]);

    expect(action.id).toBe(createDerivedSyncOperationId(
      operationId,
      'legacy-outbox-missing-action-id',
    ));
    expect(action.operationId).toBe(operationId);
  });

  it('derives stable idempotency keys for legacy actions missing both id fields', () => {
    const legacyAction = createQueuedPreferenceAction({
      id: undefined as unknown as string,
      operationId: undefined as unknown as string,
      timestamp: 1700000000000,
      localCommittedAt: undefined,
    });

    const [first] = normalizeQueueForOutbox([legacyAction]);
    const [second] = normalizeQueueForOutbox([legacyAction]);

    expect(first.operationId).toBe(second.operationId);
    expect(first.id).toBe(second.id);
    expect(first.id).toBe(createDerivedSyncOperationId(
      first.operationId,
      'legacy-outbox-missing-action-id',
    ));
  });

  it('preserves canonical held state and its durable local handoff evidence', () => {
    const localHandoff = {
      kind: 'resolved-project-conflict',
      state: 'required',
      ownerUserId: 'user-1',
      projectId: 'project-1',
      actionId: 'held-action',
      operationId: '11111111-1111-4111-8111-111111111111',
      payloadDigest: 'payload-digest',
      conflictFingerprint: 'conflict-fingerprint',
    };
    const heldAction = {
      ...createQueuedPreferenceAction({
        id: 'held-action',
        operationId: localHandoff.operationId,
      }),
      syncState: 'held',
      localHandoff,
    } as unknown as QueuedAction;

    const [normalized] = normalizeQueueForOutbox([heldAction]);

    expect(normalized.syncState).toBe('held');
    expect((normalized as typeof heldAction).localHandoff).toEqual(localHandoff);
  });
});

function createQueuedPreferenceAction(
  overrides: Partial<QueuedAction<PreferencePayload>> = {},
): QueuedAction<PreferencePayload> {
  return {
    id: 'action-id',
    operationId: '22222222-2222-4222-8222-222222222222',
    type: 'update',
    entityType: 'preference',
    entityId: 'preferences',
    payload: {
      preferences: { theme: 'default' },
      userId: 'user-1',
      sourceUserId: 'user-1',
    },
    timestamp: 1,
    localCommittedAt: 1,
    syncState: 'pending_sync',
    retryCount: 0,
    priority: 'low',
    ...overrides,
  };
}
