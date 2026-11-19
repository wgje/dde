import { describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { IndexedDbOfflineCommandStore } from './offline-command-store';
import { OfflineSyncCommandCoordinator } from './offline-sync-command-coordinator';
import { createOfflineSyncCommand, type OfflineSyncCommandEnvelope } from './offline-sync-command-envelope';
import { buildOfflineSyncReplayPlan } from './offline-sync-replay-plan';
import { replayOfflineSyncCommand } from '../../app/core/services/sync/offline-sync-command-replay-adapter';
import type { RetryOperationHandler } from '../../app/core/services/sync/retry-queue.types';

function input(ownerUserId: string, operationId: string, status: 'pending' | 'unknown' = 'pending') {
  return {
    ownerUserId,
    installationId: 'installation-1',
    deviceId: 'device-1',
    entityType: 'task' as const,
    entityId: `${ownerUserId}-task`,
    command: 'task.update' as const,
    intent: { fields: ['content'] },
    normalizedResultPatch: { id: `${ownerUserId}-task`, content: operationId },
    operationId,
    status,
    nowMs: 1000,
  };
}

function handler(): RetryOperationHandler {
  return {
    pushTask: vi.fn().mockResolvedValue(true),
    deleteTask: vi.fn().mockResolvedValue(true),
    pushProject: vi.fn().mockResolvedValue(true),
    pushConnection: vi.fn().mockResolvedValue(true),
    reconcileUnknownOutcome: vi.fn().mockResolvedValue('unknown'),
    isSessionExpired: () => false,
    isOnline: () => true,
    onProcessingStateChange: () => undefined,
  };
}

describe('offline-sync-fault-injection-model', () => {
  it('survives a simulated crash between commit and replay', async () => {
    const indexedDb = new IDBFactory();
    const firstProcess = new IndexedDbOfflineCommandStore({ indexedDb, dbName: 'fault-crash-test' });
    const coordinator = new OfflineSyncCommandCoordinator({ store: firstProcess });
    await coordinator.commit({ command: input('owner-a', 'op-a') });

    const afterRestart = new IndexedDbOfflineCommandStore({ indexedDb, dbName: 'fault-crash-test' });
    const exported = await afterRestart.exportOwner<OfflineSyncCommandEnvelope, unknown>('owner-a');
    const plan = buildOfflineSyncReplayPlan(exported.commands);

    expect(exported.projections).toHaveLength(1);
    expect(plan.ready.map(item => item.operationId)).toEqual(['op-a']);
  });

  it('keeps unknown outcome across restart and refuses blind replay', async () => {
    const indexedDb = new IDBFactory();
    const store = new IndexedDbOfflineCommandStore({ indexedDb, dbName: 'fault-unknown-test' });
    const command = createOfflineSyncCommand(input('owner-a', 'op-unknown', 'unknown'));
    await store.commitLocalChange({
      ownerUserId: 'owner-a',
      projection: { ownerUserId: 'owner-a', entityType: 'task', entityId: 'owner-a-task', value: { content: 'unknown' }, version: 1, updatedAt: '2026-11-14T00:00:00.000Z' },
      command: { ownerUserId: 'owner-a', operationId: command.operationId, entityType: 'task', entityId: 'owner-a-task', command, status: 'unknown', createdAt: command.createdAtIso, updatedAt: command.createdAtIso },
      audit: { ownerUserId: 'owner-a', operationId: command.operationId, entityType: 'task', entityId: 'owner-a-task', operation: command.command, localTimestamp: command.createdAtIso, queueResult: 'unknown', lastSyncTimeEffect: 'unchanged' },
    });
    const afterRestart = new IndexedDbOfflineCommandStore({ indexedDb, dbName: 'fault-unknown-test' });
    const exported = await afterRestart.exportOwner<OfflineSyncCommandEnvelope, unknown>('owner-a');
    const handlerInstance = handler();
    const result = await replayOfflineSyncCommand(exported.commands[0]!.command, handlerInstance);

    expect(buildOfflineSyncReplayPlan(exported.commands).requiresReconciliation).toHaveLength(1);
    expect(result).toEqual({ status: 'unknown' });
    expect(handlerInstance.pushTask).not.toHaveBeenCalled();
  });

  it('keeps owner exports isolated during the same process lifetime', async () => {
    const indexedDb = new IDBFactory();
    const store = new IndexedDbOfflineCommandStore({ indexedDb, dbName: 'fault-owner-test' });
    const coordinator = new OfflineSyncCommandCoordinator({ store });
    await coordinator.commit({ command: input('owner-a', 'op-a') });
    await coordinator.commit({ command: input('owner-b', 'op-b') });

    const ownerA = await store.exportOwner<OfflineSyncCommandEnvelope, unknown>('owner-a');
    const ownerB = await store.exportOwner<OfflineSyncCommandEnvelope, unknown>('owner-b');
    expect(ownerA.commands.map(item => item.operationId)).toEqual(['op-a']);
    expect(ownerB.commands.map(item => item.operationId)).toEqual(['op-b']);
  });
});
