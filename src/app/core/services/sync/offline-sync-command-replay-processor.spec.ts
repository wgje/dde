import { describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createOfflineSyncCommand, type OfflineSyncCommandEnvelope } from '../../../../services/sync/offline-sync-command-envelope';
import { IndexedDbOfflineCommandStore } from '../../../../services/sync/offline-command-store';
import { OfflineSyncCommandCoordinator } from '../../../../services/sync/offline-sync-command-coordinator';
import { createOfflineSyncCommandRpcDispatchers, type OfflineSyncCommandRpcReplayClient } from './offline-sync-command-replay-adapter';
import { OfflineSyncCommandReplayProcessor } from './offline-sync-command-replay-processor';
import type { RetryOperationHandler } from './retry-queue.types';

function handler(): RetryOperationHandler {
  return {
    pushTask: vi.fn().mockResolvedValue(true), deleteTask: vi.fn().mockResolvedValue(true),
    pushProject: vi.fn().mockResolvedValue(true), pushConnection: vi.fn().mockResolvedValue(true),
    isSessionExpired: () => false, isOnline: () => true, onProcessingStateChange: () => undefined,
  };
}

function command(operationId: string, kind: 'task.update' | 'preference.delete'): OfflineSyncCommandEnvelope {
  return createOfflineSyncCommand({
    ownerUserId: 'owner-replay', installationId: 'installation-1', deviceId: 'device-1',
    entityType: kind.startsWith('task') ? 'task' : 'preference', entityId: `entity-${operationId}`,
    command: kind, intent: {}, normalizedResultPatch: { id: `entity-${operationId}`, content: 'offline' },
    operationId, nowMs: operationId === 'op-task' ? 1_000 : 2_000,
  });
}

describe('offline-sync-command-replay-processor', () => {
  it('quarantines remotely accepted commands whose domain apply did not succeed', async () => {
    const store = new IndexedDbOfflineCommandStore({ indexedDb: new IDBFactory(), dbName: 'replay-processor-domain-reject-test' });
    const coordinator = new OfflineSyncCommandCoordinator({ store });
    const candidate = command('op-domain-error', 'task.update');
    await coordinator.commitEnvelope(candidate, { id: 'entity-op-domain-error', content: 'offline' });
    const processor = new OfflineSyncCommandReplayProcessor({
      store,
      ownerUserId: 'owner-replay',
      handler: handler(),
      replayOptions: { commands: { 'task.update': vi.fn().mockResolvedValue({
        success: false,
        decision: 'domain-apply-error',
        rawResponse: { domainApplyStatus: 'domain-apply-error', appliedToDomainTables: false },
      }) } },
    });

    await expect(processor.drain()).resolves.toMatchObject({ rejected: 1, acked: 0 });
    const exported = await store.exportOwner<OfflineSyncCommandEnvelope, unknown>('owner-replay');
    expect(exported.commands[0]).toMatchObject({ status: 'rejected' });
    expect(exported.audits[0]).toMatchObject({
      remoteDecision: 'domain-apply-error',
      remoteResponse: { domainApplyStatus: 'domain-apply-error', appliedToDomainTables: false },
    });
    expect(exported.quarantine).toContainEqual(expect.objectContaining({
      reason: 'remote-replay-not-applied:domain-apply-error',
      raw: expect.objectContaining({ command: candidate }),
    }));
  });

  it('settles supported and unsupported commands into the durable command/audit/quarantine chain', async () => {
    const store = new IndexedDbOfflineCommandStore({ indexedDb: new IDBFactory(), dbName: 'replay-processor-test' });
    const coordinator = new OfflineSyncCommandCoordinator({ store });
    await coordinator.commitEnvelope(command('op-task', 'task.update'), { id: 'entity-op-task', content: 'offline' });
    await coordinator.commitEnvelope(command('op-pref', 'preference.delete'), { id: 'entity-op-pref' });
    const upsertTask = vi.fn().mockResolvedValue({ status: 'applied', decision: 'accepted', raw: { status: 'applied' }, serverUpdatedAt: '2026-11-14T00:00:01.000Z' });
    const processor = new OfflineSyncCommandReplayProcessor({
      store, ownerUserId: 'owner-replay', handler: handler(),
      replayOptions: { commands: createOfflineSyncCommandRpcDispatchers({ upsertTask } as unknown as OfflineSyncCommandRpcReplayClient) },
      now: () => '2026-11-14T00:00:02.000Z',
    });

    await expect(processor.drain()).resolves.toEqual({ attempted: 2, acked: 1, rejected: 0, unknown: 0, unsupported: 1 });
    expect(upsertTask).toHaveBeenCalledOnce();
    const exported = await store.exportOwner<OfflineSyncCommandEnvelope, unknown>('owner-replay');
    expect(exported.commands.find(item => item.operationId === 'op-task')).toMatchObject({ status: 'acked' });
    expect(exported.audits.find(item => item.operationId === 'op-task')).toMatchObject({
      queueResult: 'acked', remoteDecision: 'accepted', serverUpdatedAt: '2026-11-14T00:00:01.000Z',
      remoteResponse: { status: 'applied' },
    });
    expect(exported.commands.find(item => item.operationId === 'op-pref')).toMatchObject({ status: 'rejected' });
    expect(exported.quarantine.some(item => item.reason === 'intentionally-quarantined-command')).toBe(true);
  });
});
