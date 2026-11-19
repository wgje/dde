import { describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createOfflineSyncCommand } from './offline-sync-command-envelope';
import {
  buildOfflineCommandDataSafetyPackage,
  extractOfflineCommandStoreExportForRestore,
  restoreOfflineCommandStoreFromPackage,
} from './offline-command-data-safety-bridge';
import { IndexedDbOfflineCommandStore } from './offline-command-store';
import type { OfflineCommandStoreExport, OfflineConflictEvidenceRecord } from './offline-command-store';
import { validateDataSafetyExportPackage } from '../data-safety-package';
import { collectConflictRestoreValidationErrors } from '../data-safety-conflict-restore.helpers';

const command = createOfflineSyncCommand({
  ownerUserId: 'owner-1',
  installationId: 'installation-1',
  deviceId: 'device-1',
  entityType: 'task',
  entityId: 'task-1',
  projectId: 'project-1',
  command: 'task.update',
  intent: { fields: ['content'] },
  normalizedResultPatch: { id: 'task-1', content: 'offline' },
  operationId: 'operation-1',
  nowMs: Date.parse('2026-11-14T00:00:00.000Z'),
});

function storeExport(conflictEvidence: OfflineConflictEvidenceRecord[] = []): OfflineCommandStoreExport<typeof command, { id: string; projectId?: string; content: string }> {
  return {
    schemaVersion: 1,
    ownerUserId: 'owner-1',
    projections: [{
      key: 'owner-1:projection:task:task-1',
      ownerUserId: 'owner-1',
      entityType: 'task',
      entityId: 'task-1',
      value: { id: 'task-1', projectId: 'project-1', content: 'offline' },
      version: 2,
      updatedAt: '2026-11-14T00:00:00.000Z',
      schemaVersion: 1,
    }],
    commands: [{
      key: 'owner-1:command:operation-1',
      ownerUserId: 'owner-1',
      operationId: 'operation-1',
      entityType: 'task',
      entityId: 'task-1',
      command,
      status: 'pending',
      createdAt: '2026-11-14T00:00:00.000Z',
      updatedAt: '2026-11-14T00:00:00.000Z',
      schemaVersion: 1,
    }],
    audits: [],
    quarantine: [{
      key: 'owner-1:quarantine:q-1',
      ownerUserId: 'owner-1',
      reason: 'unknown-schema',
      raw: { source: 'legacy' },
      quarantinedAt: '2026-11-14T00:00:00.000Z',
      schemaVersion: 1,
    }],
    conflictEvidence,
  };
}

describe('offline-command-data-safety-bridge', () => {
  it('maps projections, pending commands, and quarantine into the existing package shape', () => {
    const pkg = buildOfflineCommandDataSafetyPackage({
      storeExport: storeExport(),
      exportedAt: '2026-11-14T00:00:00.000Z',
      ownerUserId: 'owner-1',
      app: { appVersion: 'test', syncProtocolVersion: 1, deploymentEpoch: 1 },
      syncSnapshot: {
        syncState: { lastSyncTime: null, pendingCount: 1 },
        projectCursors: [],
        queueCounts: { retryQueue: 1, actionQueue: 0, deadLetters: 0 },
      },
    });

    expect(pkg.localData.tasks).toEqual([expect.objectContaining({ id: 'task-1', content: 'offline' })]);
    expect(pkg.localState.retryQueue).toEqual([expect.objectContaining({ operationId: 'operation-1', sourceUserId: 'owner-1' })]);
    expect(pkg.localState.conflicts).toEqual([]);
    expect(pkg.localData.meta).toEqual(expect.objectContaining({ offlineCommandStore: expect.objectContaining({ quarantine: expect.any(Array) }) }));
    expect(pkg.replayPlan.summary.retryQueue).toBe(1);
    expect(pkg.localData.meta).toEqual(expect.objectContaining({ offlineCommandStore: expect.any(Object) }));
  });

  it('extracts the complete owner-scoped command store for restore', () => {
    const pkg = buildOfflineCommandDataSafetyPackage({
      storeExport: storeExport(),
      exportedAt: '2026-11-14T00:00:00.000Z',
      ownerUserId: 'owner-1',
      app: { appVersion: 'test', syncProtocolVersion: 1, deploymentEpoch: 1 },
      syncSnapshot: { syncState: { lastSyncTime: null, pendingCount: 0 }, projectCursors: [], queueCounts: { retryQueue: 0, actionQueue: 0, deadLetters: 0 } },
    });

    expect(extractOfflineCommandStoreExportForRestore(pkg)).toEqual(storeExport());
  });

  it('exports full conflict evidence into conflicts, replay audit, and the restorable store payload', () => {
    const losingCommand = createOfflineSyncCommand({
      ownerUserId: 'owner-1', installationId: 'installation-1', deviceId: 'device-a',
      entityType: 'task', entityId: 'task-1', command: 'task.update', intent: { field: 'content' },
      normalizedResultPatch: { id: 'task-1', content: 'losing' }, operationId: 'operation-loser', nowMs: 10,
    });
    const winningCommand = createOfflineSyncCommand({
      ownerUserId: 'owner-1', installationId: 'installation-1', deviceId: 'device-b',
      entityType: 'task', entityId: 'task-1', command: 'task.update', intent: { field: 'content' },
      normalizedResultPatch: { id: 'task-1', content: 'winning' }, operationId: 'operation-winner', nowMs: 20,
    });
    const evidence = {
      entityId: 'task-1', field: 'content', reason: 'older-field-write' as const,
      losingOperationId: losingCommand.operationId, winningOperationId: winningCommand.operationId,
      losingValue: 'losing', winningValue: 'winning', losingCommand, winningCommand,
      losingVersion: { logicalClock: losingCommand.logicalClock, deviceId: losingCommand.deviceId, operationId: losingCommand.operationId, command: losingCommand },
      winningVersion: { logicalClock: winningCommand.logicalClock, deviceId: winningCommand.deviceId, operationId: winningCommand.operationId, command: winningCommand },
    };
    const conflictRecord: OfflineConflictEvidenceRecord<typeof evidence> = {
      key: 'owner-1:conflict:conflict-1', ownerUserId: 'owner-1', conflictId: 'conflict-1',
      entityType: 'task', entityId: 'task-1', losingOperationId: losingCommand.operationId,
      winningOperationId: winningCommand.operationId, evidence, capturedAt: '2026-11-14T00:00:00.000Z', schemaVersion: 1,
    };
    const exportedStore = storeExport([conflictRecord]);
    const pkg = buildOfflineCommandDataSafetyPackage({
      storeExport: exportedStore,
      exportedAt: '2026-11-14T00:00:00.000Z',
      ownerUserId: 'owner-1',
      app: { appVersion: 'test', syncProtocolVersion: 1, deploymentEpoch: 1 },
      localData: { projects: [{ id: 'project-1' }], tasks: [], connections: [], syncCursors: [] },
      syncSnapshot: { syncState: { lastSyncTime: null, pendingCount: 0 }, projectCursors: [], queueCounts: { retryQueue: 0, actionQueue: 0, deadLetters: 0 } },
    });

    expect(pkg.localState.conflicts).toEqual([]);
    const replay = pkg.replayLog.find(entry => entry.operationId === 'conflict-1');
    expect(replay?.conflict?.localSnapshot).toMatchObject({ operationId: 'operation-loser', command: losingCommand, value: 'losing' });
    expect(replay?.conflict?.remoteSnapshot).toMatchObject({ operationId: 'operation-winner', command: winningCommand, value: 'winning' });
    expect(replay?.rpc.raw).toEqual(evidence);
    expect(extractOfflineCommandStoreExportForRestore(pkg)?.conflictEvidence).toEqual([conflictRecord]);
    expect(validateDataSafetyExportPackage(pkg)).toMatchObject({ valid: true, errors: [] });
    expect(collectConflictRestoreValidationErrors(pkg)).toEqual([]);
  });


  it('restores the embedded command store and preserves both conflict commands', async () => {
    const losingCommand = createOfflineSyncCommand({
      ownerUserId: 'owner-1', installationId: 'installation-1', deviceId: 'device-a',
      entityType: 'task', entityId: 'task-1', command: 'task.update', intent: { field: 'content' },
      normalizedResultPatch: { id: 'task-1', content: 'losing' }, operationId: 'operation-loser', nowMs: 10,
    });
    const winningCommand = createOfflineSyncCommand({
      ownerUserId: 'owner-1', installationId: 'installation-1', deviceId: 'device-b',
      entityType: 'task', entityId: 'task-1', command: 'task.update', intent: { field: 'content' },
      normalizedResultPatch: { id: 'task-1', content: 'winning' }, operationId: 'operation-winner', nowMs: 20,
    });
    const evidence = {
      reason: 'older-field-write' as const,
      losingOperationId: losingCommand.operationId,
      winningOperationId: winningCommand.operationId,
      losingCommand,
      winningCommand,
      losingValue: 'losing',
      winningValue: 'winning',
    };
    const conflictEvidence: OfflineConflictEvidenceRecord<typeof evidence> = {
      key: 'owner-1:conflict:restore-1', ownerUserId: 'owner-1', conflictId: 'restore-1',
      entityType: 'task', entityId: 'task-1', losingOperationId: losingCommand.operationId,
      winningOperationId: winningCommand.operationId, evidence,
      capturedAt: '2026-11-14T00:00:00.000Z', schemaVersion: 1,
    };
    const pkg = buildOfflineCommandDataSafetyPackage({
      storeExport: storeExport([conflictEvidence]),
      exportedAt: '2026-11-14T00:00:00.000Z',
      ownerUserId: 'owner-1',
      app: { appVersion: 'test', syncProtocolVersion: 1, deploymentEpoch: 1 },
      syncSnapshot: { syncState: { lastSyncTime: null, pendingCount: 0 }, projectCursors: [], queueCounts: { retryQueue: 0, actionQueue: 0, deadLetters: 0 } },
    });
    const target = new IndexedDbOfflineCommandStore({ indexedDb: new IDBFactory(), dbName: 'bridge-restore-round-trip' });

    await expect(restoreOfflineCommandStoreFromPackage(pkg, target)).resolves.toBe(true);
    const restored = await target.exportOwner('owner-1');
    expect(restored.conflictEvidence).toEqual([conflictEvidence]);
    expect(restored.conflictEvidence?.[0]?.evidence).toMatchObject({
      losingCommand,
      winningCommand,
      losingValue: 'losing',
      winningValue: 'winning',
    });
  });
  it('retains ownerless quarantine diagnostics without weakening owner fences', () => {
    const exported = storeExport();
    exported.quarantine = [{
      key: 'global:quarantine:q-1', ownerUserId: null, reason: 'future-command',
      raw: { command: 'future.v2' }, quarantinedAt: '2026-11-14T00:00:00.000Z', schemaVersion: 1,
    }];
    const pkg = buildOfflineCommandDataSafetyPackage({
      storeExport: exported,
      exportedAt: '2026-11-14T00:00:00.000Z',
      ownerUserId: 'owner-1',
      app: { appVersion: 'test', syncProtocolVersion: 1, deploymentEpoch: 1 },
      localData: { projects: [{ id: 'project-1' }], tasks: [], connections: [], syncCursors: [] },
      syncSnapshot: { syncState: { lastSyncTime: null, pendingCount: 0 }, projectCursors: [], queueCounts: { retryQueue: 0, actionQueue: 0, deadLetters: 0 } },
    });
    expect(validateDataSafetyExportPackage(pkg)).toMatchObject({ valid: true, errors: [] });
    expect(extractOfflineCommandStoreExportForRestore(pkg)?.quarantine).toEqual([
      expect.objectContaining({ ownerUserId: null, reason: 'future-command' }),
    ]);
  });
  it('rejects a cross-owner store export before building a package', () => {
    expect(() => buildOfflineCommandDataSafetyPackage({
      storeExport: { ...storeExport(), ownerUserId: 'owner-2' },
      exportedAt: '2026-11-14T00:00:00.000Z',
      ownerUserId: 'owner-1',
      app: { appVersion: 'test', syncProtocolVersion: 1, deploymentEpoch: 1 },
      localData: { projects: [{ id: 'project-1' }], tasks: [], connections: [], syncCursors: [] },
      syncSnapshot: { syncState: { lastSyncTime: null, pendingCount: 0 }, projectCursors: [], queueCounts: { retryQueue: 0, actionQueue: 0, deadLetters: 0 } },
    })).toThrow('owner mismatch');
  });
});