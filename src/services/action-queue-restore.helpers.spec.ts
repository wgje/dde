import { describe, expect, it } from 'vitest';

import {
  extractBackupActionQueueActions,
  extractBackupActionQueueActionsForRestore,
  mergeLoadedQueuedActionsWithBackup,
  mergeRestoredQueuedActions,
} from './action-queue-restore.helpers';
import type { PreferencePayload, QueuedAction } from './action-queue.types';

describe('action-queue-restore.helpers', () => {
  it('does not revive dead_letter actions from backup actionQueue as pending_sync', () => {
    const deadLetterAction = createQueuedPreferenceAction({
      id: 'dead-letter-action',
      operationId: '44444444-4444-4444-8444-444444444444',
      syncState: 'dead_letter',
      retryCount: 5,
      lastError: 'business failure',
      errorType: 'business',
    });

    expect(extractBackupActionQueueActions([deadLetterAction])).toEqual([]);
    expect(extractBackupActionQueueActions({ actions: [deadLetterAction] })).toEqual([]);
    expect(extractBackupActionQueueActions({ queue: [deadLetterAction] })).toEqual([]);
  });

  it('preserves UUID action and operation identities and rejects identities it would remap', () => {
    const action = createQueuedPreferenceAction({
      id: '77777777-7777-4777-8777-777777777777',
      operationId: '88888888-8888-4888-8888-888888888888',
    });

    expect(extractBackupActionQueueActionsForRestore({ actions: [action] })).toEqual([
      expect.objectContaining({ id: action.id, operationId: action.operationId }),
    ]);
    expect(() => extractBackupActionQueueActionsForRestore([{
      ...action,
      operationId: undefined,
    }])).toThrow(/operationId/i);
    expect(() => extractBackupActionQueueActionsForRestore([{
      ...action,
      operationId: 'legacy-operation-id',
    }])).toThrow(/operationId/i);
    expect(() => extractBackupActionQueueActionsForRestore([{
      ...action,
      id: undefined,
    }])).toThrow(/action id/i);
  });

  it('preserves local retry metadata when backup recency ties the loaded action', () => {
    const operationId = '11111111-1111-4111-8111-111111111111';
    const loadedAction = createQueuedPreferenceAction({
      id: 'loaded-action',
      operationId,
      payload: createPreferencePayload('ocean'),
      retryCount: 3,
      syncState: 'retry_scheduled',
      lastError: 'network unavailable',
      errorType: 'network',
      timestamp: 100,
      localCommittedAt: 100,
    });
    const staleBackupAction = createQueuedPreferenceAction({
      id: 'backup-action',
      operationId,
      payload: createPreferencePayload('forest'),
      retryCount: 0,
      syncState: 'pending_sync',
      timestamp: 100,
      localCommittedAt: 100,
    });

    const { queue, restoredCount } = mergeLoadedQueuedActionsWithBackup(
      [loadedAction],
      [staleBackupAction],
    );

    expect(restoredCount).toBe(0);
    expect(queue).toHaveLength(1);
    expect(queue[0]).toEqual(expect.objectContaining({
      id: 'loaded-action',
      operationId,
      retryCount: 3,
      syncState: 'retry_scheduled',
      lastError: 'network unavailable',
      errorType: 'network',
      payload: createPreferencePayload('ocean'),
    }));
  });

  it('merges preserved duplicate conflict evidence instead of silently skipping it', () => {
    const operationId = '22222222-2222-4222-8222-222222222222';
    const currentAction = createQueuedPreferenceAction({
      id: 'current-action',
      operationId,
      payload: createPreferencePayload('sunset'),
      retryCount: 0,
      syncState: 'pending_sync',
      timestamp: 200,
      localCommittedAt: 200,
    });
    const restoredConflict = createQueuedPreferenceAction({
      id: 'restored-conflict',
      operationId,
      payload: createPreferencePayload('lavender'),
      retryCount: 2,
      syncState: 'conflict_saved',
      lastError: 'remote conflict saved',
      errorType: 'business',
      timestamp: 200,
      localCommittedAt: 200,
    });

    const { queue, restoredCount } = mergeRestoredQueuedActions(
      [currentAction],
      [restoredConflict],
    );

    expect(restoredCount).toBe(0);
    expect(queue).toHaveLength(1);
    expect(queue[0]).toEqual(expect.objectContaining({
      id: 'restored-conflict',
      operationId,
      retryCount: 2,
      syncState: 'conflict_saved',
      lastError: 'remote conflict saved',
      errorType: 'business',
      payload: createPreferencePayload('lavender'),
    }));
  });

  it('does not merge dead_letter backup actions into the pending queue', () => {
    const deadLetterBackupAction = createQueuedPreferenceAction({
      id: 'dead-letter-backup-action',
      operationId: '55555555-5555-4555-8555-555555555555',
      syncState: 'dead_letter',
      retryCount: 5,
      lastError: 'business failure',
      errorType: 'business',
      timestamp: 300,
      localCommittedAt: 300,
    });

    const { queue, restoredCount } = mergeLoadedQueuedActionsWithBackup([], [deadLetterBackupAction]);

    expect(restoredCount).toBe(0);
    expect(queue).toEqual([]);
  });

  it('restores held actions without downgrading their handoff evidence to pending', () => {
    const localHandoff = {
      kind: 'resolved-project-conflict',
      state: 'reserved',
      ownerUserId: 'user-1',
      projectId: 'project-1',
      actionId: 'held-action',
      operationId: '66666666-6666-4666-8666-666666666666',
      payloadDigest: 'payload-digest',
      conflictFingerprint: 'conflict-fingerprint',
      reservationId: 'reservation-1',
    };
    const heldAction = {
      ...createQueuedPreferenceAction({
        id: localHandoff.actionId,
        operationId: localHandoff.operationId,
      }),
      syncState: 'held',
      localHandoff,
    } as unknown as QueuedAction;

    const restored = extractBackupActionQueueActions([heldAction]);

    expect(restored).toHaveLength(1);
    expect(restored[0].syncState).toBe('held');
    expect((restored[0] as typeof heldAction).localHandoff).toEqual(localHandoff);
  });
});

function createPreferencePayload(theme: NonNullable<PreferencePayload['preferences']['theme']>): PreferencePayload {
  return {
    preferences: { theme },
    userId: 'user-1',
    sourceUserId: 'user-1',
  };
}

function createQueuedPreferenceAction(
  overrides: Partial<QueuedAction<PreferencePayload>> = {},
): QueuedAction<PreferencePayload> {
  return {
    id: 'action-id',
    operationId: '33333333-3333-4333-8333-333333333333',
    type: 'update',
    entityType: 'preference',
    entityId: 'preferences',
    payload: createPreferencePayload('default'),
    timestamp: 1,
    localCommittedAt: 1,
    syncState: 'pending_sync',
    retryCount: 0,
    priority: 'normal',
    ...overrides,
  };
}
