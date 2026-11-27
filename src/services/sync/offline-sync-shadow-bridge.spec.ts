import { describe, expect, it } from 'vitest';
import { createOfflineSyncCommand } from './offline-sync-command-envelope';
import { compareOfflineCommandWithLegacyRpc, toShadowOutcome } from './offline-sync-shadow-bridge';
import { createShadowSyncAdapter } from './shadow-sync-adapter';
import type { SyncRpcResult } from '../sync-rpc-client.service';

const command = createOfflineSyncCommand({
  ownerUserId: 'owner-1',
  installationId: 'installation-1',
  deviceId: 'device-1',
  entityType: 'task',
  entityId: 'task-1',
  command: 'task.update',
  intent: { fields: ['content'] },
  normalizedResultPatch: { content: 'offline' },
  operationId: 'operation-1',
  nowMs: 1_000,
});

const rpcResult: SyncRpcResult = {
  raw: null,
  status: 'applied',
  decision: 'accepted',
  operationId: 'operation-1',
  changedFields: ['content'],
  entityId: 'task-1',
  payloadDigest: 'digest-1',
  serverUpdatedAt: '2026-11-13T00:00:00.000Z',
};

describe('offline-sync-shadow-bridge', () => {
  it('preserves deferred reconciliation evidence without reporting an application', () => {
    expect(toShadowOutcome({ raw: null, status: 'reconciliation-pending', reason: 'snapshot-clock-unknown' }))
      .toMatchObject({ status: 'reconciliation-pending', reason: 'snapshot-clock-unknown' });
  });
  it('maps the existing RPC result without dropping diagnostics', () => {
    expect(toShadowOutcome(rpcResult)).toEqual({
      status: 'applied',
      decision: 'accepted',
      changedFields: ['content'],
      entityId: 'task-1',
      payloadDigest: 'digest-1',
      remoteUpdatedAt: '2026-11-13T00:00:00.000Z',
      reason: undefined,
    });
  });

  it('compares the new command outcome against the legacy RPC result', () => {
    const adapter = createShadowSyncAdapter({ enabled: true });
    const comparison = compareOfflineCommandWithLegacyRpc(adapter, {
      command,
      newOutcome: {
        status: 'applied',
        decision: 'accepted',
        changedFields: ['content'],
        entityId: 'task-1',
        payloadDigest: 'digest-1',
        remoteUpdatedAt: '2026-11-13T00:00:00.000Z',
      },
      legacyResult: rpcResult,
      comparedAt: '2026-11-13T00:00:00.000Z',
    });

    expect(comparison?.equivalent).toBe(true);
    expect(comparison?.command.operationId).toBe('operation-1');
  });

  it('is a no-op when the shadow adapter is disabled', () => {
    const adapter = createShadowSyncAdapter({ enabled: false });
    expect(compareOfflineCommandWithLegacyRpc(adapter, {
      command,
      newOutcome: { status: 'applied' },
      legacyResult: rpcResult,
      comparedAt: '2026-11-13T00:00:00.000Z',
    })).toBeNull();
  });
});