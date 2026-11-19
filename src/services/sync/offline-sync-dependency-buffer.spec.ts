import { describe, expect, it } from 'vitest';
import { createOfflineSyncCommand } from './offline-sync-command-envelope';
import { OfflineSyncDependencyBuffer } from './offline-sync-dependency-buffer';
import type { OfflineCommandRecord } from './offline-command-store';

function record(operationId: string, dependencyOperationIds: string[] = []): OfflineCommandRecord<ReturnType<typeof createOfflineSyncCommand>> {
  const command = createOfflineSyncCommand({
    ownerUserId: 'owner-1', installationId: 'installation-1', deviceId: 'device-1',
    entityType: 'task', entityId: 'task-1', command: 'task.update', intent: {},
    normalizedResultPatch: { content: operationId }, operationId,
    dependencyOperationIds, nowMs: dependencyOperationIds.length ? 200 : 100,
  });
  return {
    key: `owner-1:command:${operationId}`, ownerUserId: 'owner-1', operationId,
    entityType: 'task', entityId: 'task-1', command, status: 'pending',
    createdAt: command.createdAtIso, updatedAt: command.createdAtIso, schemaVersion: 1,
  };
}

describe('offline-sync-dependency-buffer', () => {
  it('defers a command until its dependency arrives, then drains both in order', () => {
    const buffer = new OfflineSyncDependencyBuffer();
    expect(buffer.add(record('restore', ['delete'])).ready).toEqual([]);
    const drained = buffer.add(record('delete'));
    expect(drained.ready.map(item => item.operationId)).toEqual(['delete', 'restore']);
    expect(drained.deferred).toEqual([]);
  });

  it('keeps a command with an unknown dependency deferred', () => {
    const drained = new OfflineSyncDependencyBuffer().add(record('restore', ['missing']));
    expect(drained.ready).toEqual([]);
    expect(drained.deferred.map(item => item.operationId)).toEqual(['restore']);
  });
});