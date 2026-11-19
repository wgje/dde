import { describe, expect, it } from 'vitest';
import { createOfflineSyncCommand } from './offline-sync-command-envelope';
import { buildOfflineSyncReplayPlan } from './offline-sync-replay-plan';
import type { OfflineCommandRecord } from './offline-command-store';

function record(status: 'pending' | 'unknown' | 'acked', operationId: string, physicalMs: number, dependencyOperationIds: string[] = []): OfflineCommandRecord<typeof command> {
  return {
    key: `owner-1:command:${operationId}`,
    ownerUserId: 'owner-1',
    operationId,
    entityType: 'task',
    entityId: 'task-1',
    command: createOfflineSyncCommand({
      ownerUserId: 'owner-1', installationId: 'installation-1', deviceId: 'device-1',
      entityType: 'task', entityId: 'task-1', command: 'task.update', intent: {},
      normalizedResultPatch: { content: operationId }, operationId, dependencyOperationIds, logicalClock: { physicalMs, logical: 0 },
    }),
    status,
    createdAt: '2026-11-14T00:00:00.000Z',
    updatedAt: '2026-11-14T00:00:00.000Z',
    schemaVersion: 1,
  };
}

const command = createOfflineSyncCommand({
  ownerUserId: 'owner-1', installationId: 'installation-1', deviceId: 'device-1',
  entityType: 'task', entityId: 'task-1', command: 'task.update', intent: {}, normalizedResultPatch: {},
  operationId: 'placeholder', nowMs: 1,
});

describe('offline-sync-replay-plan', () => {
  it('defers commands with missing dependencies and drains them after prerequisites arrive', () => {
    const plan = buildOfflineSyncReplayPlan([
      record('pending', 'restore', 200, ['delete']),
      record('pending', 'delete', 100),
    ]);
    expect(plan.ready.map(item => item.operationId)).toEqual(['delete', 'restore']);
    expect(plan.deferredByDependency).toEqual([]);

    const deferred = buildOfflineSyncReplayPlan([record('pending', 'restore', 200, ['missing'])]);
    expect(deferred.ready).toEqual([]);
    expect(deferred.deferredByDependency.map(item => item.operationId)).toEqual(['restore']);
  });

  it('orders replayable commands and keeps unknown outcomes out of direct replay', () => {
    const plan = buildOfflineSyncReplayPlan([
      record('pending', 'op-later', 200),
      record('unknown', 'op-unknown', 150),
      record('pending', 'op-earlier', 100),
      record('acked', 'op-acked', 50),
    ]);

    expect(plan.ready.map(item => item.operationId)).toEqual(['op-earlier', 'op-later']);
    expect(plan.requiresReconciliation.map(item => item.operationId)).toEqual(['op-unknown']);
    expect(plan.terminal.map(item => item.operationId)).toEqual(['op-acked']);
  });
});