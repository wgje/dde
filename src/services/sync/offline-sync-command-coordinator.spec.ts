import { describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createOfflineSyncCommand } from './offline-sync-command-envelope';
import { IndexedDbOfflineCommandStore } from './offline-command-store';
import { OfflineSyncCommandCoordinator } from './offline-sync-command-coordinator';

function createCommandInput(overrides: Partial<Parameters<typeof createOfflineSyncCommand>[0]> = {}) {
  return {
    ownerUserId: 'owner-1',
    installationId: 'installation-1',
    deviceId: 'device-1',
    entityType: 'task' as const,
    entityId: 'task-1',
    command: 'task.update' as const,
    intent: { fields: ['content'] },
    normalizedResultPatch: { content: 'offline' },
    operationId: 'operation-1',
    nowMs: 1_000,
    ...overrides,
  };
}

describe('offline-sync-command-coordinator', () => {
  it('commits projection, command and audit atomically without network I/O', async () => {
    const store = new IndexedDbOfflineCommandStore({
      indexedDb: new IDBFactory(),
      dbName: 'coordinator-test-1',
    });
    const coordinator = new OfflineSyncCommandCoordinator({
      store,
      now: () => '2026-11-14T00:00:00.000Z',
    });

    const result = await coordinator.commit({ command: createCommandInput() });
    const exported = await store.exportOwner<unknown, { fields: Record<string, unknown> }>('owner-1');

    expect(result.reconcile.applied).toBe(true);
    expect(result.command.operationId).toBe('operation-1');
    expect(exported.projections[0]?.value.fields).toEqual({ content: 'offline' });
    expect(exported.commands[0]?.status).toBe('pending');
    expect(exported.audits[0]?.lastSyncTimeEffect).toBe('unchanged');
  });

  it('settles replay status and remote evidence atomically across command and audit rows', async () => {
    const store = new IndexedDbOfflineCommandStore({ indexedDb: new IDBFactory(), dbName: 'coordinator-replay-settle-test' });
    const coordinator = new OfflineSyncCommandCoordinator({ store, now: () => '2026-11-14T00:00:00.000Z' });
    await coordinator.commit({ command: createCommandInput({ operationId: 'operation-replay' }) });
    const settled = await store.updateReplayResult({
      ownerUserId: 'owner-1', operationId: 'operation-replay', status: 'acked',
      decision: 'applied', rawResponse: { status: 'applied', auditId: 'audit-1' },
      serverUpdatedAt: '2026-11-14T00:00:01.000Z', lastSyncTimeEffect: 'advanced',
    });
    expect(settled?.status).toBe('acked');
    expect((settled?.command as Record<string, unknown>)['status']).toBe('acked');
    expect((settled?.command as Record<string, unknown>)['decision']).toBe('applied');
    const audit = await store.getAudit('owner-1', 'operation-replay');
    expect(audit).toMatchObject({
      queueResult: 'acked', remoteDecision: 'applied', serverUpdatedAt: '2026-11-14T00:00:01.000Z',
      lastSyncTimeEffect: 'advanced', remoteResponse: { status: 'applied', auditId: 'audit-1' },
    });
  });

  it('persists complete losing and winning command evidence with the audit in the commit', async () => {
    const store = new IndexedDbOfflineCommandStore({ indexedDb: new IDBFactory(), dbName: 'coordinator-conflict-test' });
    const coordinator = new OfflineSyncCommandCoordinator({ store });
    const losing = await coordinator.commit({ command: createCommandInput({
      operationId: 'operation-losing',
      normalizedResultPatch: { content: 'losing-value' },
      logicalClock: { physicalMs: 10, logical: 0 },
    }) });
    const winning = await coordinator.commit({ command: createCommandInput({
      operationId: 'operation-winning',
      normalizedResultPatch: { content: 'winning-value' },
      logicalClock: { physicalMs: 20, logical: 0 },
    }) });
    const evidenceRecords = await store.listConflictEvidence('owner-1');
    const audit = await store.getAudit('owner-1', 'operation-winning');

    expect(winning.reconcile.evidence).toHaveLength(1);
    expect(evidenceRecords).toHaveLength(1);
    expect(evidenceRecords[0]?.evidence).toMatchObject({
      losingCommand: losing.command,
      winningCommand: winning.command,
      losingValue: 'losing-value',
      winningValue: 'winning-value',
    });
    expect(audit?.conflictEvidenceKeys).toEqual([evidenceRecords[0]?.key]);
  });

  it('persists a tombstone and records a blocked edit as rejected evidence', async () => {
    const store = new IndexedDbOfflineCommandStore({
      indexedDb: new IDBFactory(),
      dbName: 'coordinator-test-2',
    });
    const coordinator = new OfflineSyncCommandCoordinator({ store });
    await coordinator.commit({
      command: createCommandInput({
        command: 'task.delete',
        normalizedResultPatch: {},
        operationId: 'operation-delete',
        nowMs: 2_000,
      }),
      initialProjection: { content: 'before' },
    });

    const blocked = await coordinator.commit({
      command: createCommandInput({
        operationId: 'operation-edit',
        normalizedResultPatch: { content: 'blocked' },
        nowMs: 3_000,
      }),
    });
    const commands = await store.listCommands('owner-1');

    expect(blocked.reconcile.applied).toBe(false);
    expect(blocked.reconcile.evidence[0]?.reason).toBe('edit-blocked-by-tombstone');
    expect(commands.find(item => item.operationId === 'operation-edit')?.status).toBe('rejected');
  });
});
