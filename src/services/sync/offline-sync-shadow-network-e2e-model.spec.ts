import { describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { IndexedDbOfflineCommandStore } from './offline-command-store';
import {
  createOfflineSyncCommand,
  type OfflineSyncCommandEnvelope,
} from './offline-sync-command-envelope';
import {
  createEmptyOfflineSyncProjectionState,
  reconcileOfflineSyncCommand,
  type OfflineSyncProjectionState,
} from './offline-sync-reconcile-policy';
import { OfflineSyncCommandCoordinator } from './offline-sync-command-coordinator';
import { pullAndApplyOfflineSyncProjections } from './offline-sync-projection-rpc-adapter';
import type { OfflineSyncRemoteProjectionRow } from './offline-sync-projection-pull';

const OWNER = 'owner-e2e';
const ENTITY_ID = 'task-e2e';
const BASE_TIME = '2026-11-14T00:00:00.000Z';

interface RemoteRecord {
  state: OfflineSyncProjectionState;
  version: number;
  updatedAt: string;
  acceptedOperationIds: Set<string>;
}

interface RemoteApplyResult {
  decision: 'accepted-shadow' | 'idempotent-replay';
  projection: RemoteRecord;
}

/**
 * A deterministic in-memory stand-in for the capability-gated shadow RPC.
 * It intentionally uses the same reconcile function as the local projection
 * so this spec checks delivery order, duplicate idempotency, and pull fencing
 * without requiring a live remote capability to be enabled.
 */
class DeterministicShadowRemote {
  private readonly records = new Map<string, RemoteRecord>();

  apply(command: OfflineSyncCommandEnvelope): RemoteApplyResult {
    const key = `${command.ownerUserId}:${command.entityType}:${command.entityId}`;
    const current = this.records.get(key) ?? {
      state: createEmptyOfflineSyncProjectionState({ content: 'base' }),
      version: 0,
      updatedAt: BASE_TIME,
      acceptedOperationIds: new Set<string>(),
    };

    if (current.acceptedOperationIds.has(command.operationId)) {
      return { decision: 'idempotent-replay', projection: current };
    }

    const result = reconcileOfflineSyncCommand(current.state, command);
    const next: RemoteRecord = {
      state: result.state,
      version: current.version + (result.applied ? 1 : 0),
      updatedAt: command.createdAtIso,
      acceptedOperationIds: new Set([...current.acceptedOperationIds, command.operationId]),
    };
    this.records.set(key, next);
    return { decision: 'accepted-shadow', projection: next };
  }

  projections(ownerUserId: string): OfflineSyncRemoteProjectionRow[] {
    return [...this.records.entries()]
      .filter(([key]) => key.startsWith(`${ownerUserId}:`))
      .map(([, record]) => ({
        ownerUserId,
        entityType: 'task',
        entityId: ENTITY_ID,
        fields: record.state.fields,
        fieldVersions: record.state.fieldVersions,
        ...(record.state.tombstone === undefined ? {} : { tombstone: record.state.tombstone }),
        version: record.version,
        updatedAt: record.updatedAt,
      }));
  }
}

function command(
  operationId: string,
  deviceId: string,
  physicalMs: number,
  field: string,
  value: string,
  status: OfflineSyncCommandEnvelope['status'] = 'pending',
): OfflineSyncCommandEnvelope {
  return createOfflineSyncCommand({
    ownerUserId: OWNER,
    installationId: `installation-${deviceId}`,
    deviceId,
    entityType: 'task',
    entityId: ENTITY_ID,
    command: 'task.update',
    intent: { fields: [field] },
    normalizedResultPatch: { [field]: value },
    operationId,
    logicalClock: { physicalMs, logical: 0 },
    createdAtIso: `2026-11-14T00:00:${String(Math.floor(physicalMs / 1000)).padStart(2, '0')}.000Z`,
    status,
  });
}

async function commit(
  dbName: string,
  envelope: OfflineSyncCommandEnvelope,
): Promise<IndexedDbOfflineCommandStore> {
  const store = new IndexedDbOfflineCommandStore({ indexedDb: new IDBFactory(), dbName });
  const coordinator = new OfflineSyncCommandCoordinator({ store });
  await coordinator.commitEnvelope(envelope, { content: 'base' }, 0, envelope.createdAtIso);
  return store;
}

describe('offline-sync-shadow-network-e2e-model', () => {
  it('converges two offline devices after duplicate and out-of-order delivery', async () => {
    const remote = new DeterministicShadowRemote();
    const deviceA = await commit('shadow-e2e-device-a', command('op-a', 'device-a', 1000, 'content', 'from-a'));
    const deviceB = await commit('shadow-e2e-device-b', command('op-b', 'device-b', 2000, 'title', 'from-b'));
    const a = command('op-a', 'device-a', 1000, 'content', 'from-a');
    const b = command('op-b', 'device-b', 2000, 'title', 'from-b');

    // Simulate a flaky network: later command arrives first, then a retry
    // repeats it, then the earlier command arrives.
    expect(remote.apply(b).decision).toBe('accepted-shadow');
    expect(remote.apply(b).decision).toBe('idempotent-replay');
    expect(remote.apply(a).decision).toBe('accepted-shadow');

    const rows = remote.projections(OWNER);
    expect(rows[0]?.fields).toEqual({ content: 'from-a', title: 'from-b' });
    expect(rows[0]?.version).toBe(2);

    const pullA = await pullAndApplyOfflineSyncProjections({
      ownerUserId: OWNER,
      store: deviceA,
      transport: { fetchProjections: async () => rows.map(row => ({
          entity_type: row.entityType, entity_id: row.entityId, fields: row.fields,
          field_versions: row.fieldVersions, updated_at: row.updatedAt, version: row.version,
        })) },
    });
    const pullB = await pullAndApplyOfflineSyncProjections({
      ownerUserId: OWNER,
      store: deviceB,
      transport: { fetchProjections: async () => rows.map(row => ({
          entity_type: row.entityType, entity_id: row.entityId, fields: row.fields,
          field_versions: row.fieldVersions, updated_at: row.updatedAt, version: row.version,
        })) },
    });
    expect(pullA).toEqual({ applied: 1, skipped: 0 });
    expect(pullB).toEqual({ applied: 1, skipped: 0 });
    expect((await deviceA.listProjections(OWNER))[0]?.value).toMatchObject({
      fields: { content: 'from-a', title: 'from-b' },
    });
    expect((await deviceB.listProjections(OWNER))[0]?.value).toMatchObject({
      fields: { content: 'from-a', title: 'from-b' },
    });
    // Projection pull must not manufacture a second outbound command.
    expect((await deviceA.listCommands(OWNER)).map(item => item.operationId)).toEqual(['op-a']);
    expect((await deviceB.listCommands(OWNER)).map(item => item.operationId)).toEqual(['op-b']);
  });

  it('keeps a timed-out delivery unknown until reconciliation, then deduplicates replay', async () => {
    const remote = new DeterministicShadowRemote();
    const unknown = command('op-timeout', 'device-a', 3000, 'content', 'after-timeout', 'unknown');
    const store = await commit('shadow-e2e-timeout', unknown);
    let transportAttempts = 0;
    const flakyTransport = {
      send: async (envelope: OfflineSyncCommandEnvelope) => {
        transportAttempts += 1;
        if (transportAttempts === 1) throw new Error('simulated-timeout');
        return remote.apply(envelope);
      },
    };

    await expect(flakyTransport.send(unknown)).rejects.toThrow('simulated-timeout');
    expect((await store.listCommands(OWNER))[0]?.status).toBe('unknown');
    // Unknown outcome is reconciled, not blindly replayed as a new operation.
    expect((await flakyTransport.send(unknown)).decision).toBe('accepted-shadow');
    expect((await flakyTransport.send(unknown)).decision).toBe('idempotent-replay');
    expect(transportAttempts).toBe(3);
    expect(remote.projections(OWNER)[0]?.fields).toEqual({ content: 'after-timeout' });
  });
});
