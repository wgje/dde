import { describe, expect, it } from 'vitest';
import { compareOfflineSyncCommandOrder, createOfflineSyncCommand, type OfflineSyncCommandEnvelope } from './offline-sync-command-envelope';
import { createEmptyOfflineSyncProjectionState, reconcileOfflineSyncCommand } from './offline-sync-reconcile-policy';

function command(
  operationId: string,
  deviceId: string,
  physicalMs: number,
  patch: Record<string, string>,
  kind: 'task.update' | 'task.delete' | 'task.restore' = 'task.update',
): OfflineSyncCommandEnvelope {
  return createOfflineSyncCommand({
    ownerUserId: 'owner-1', installationId: 'installation-1', deviceId,
    entityType: 'task', entityId: 'task-1', command: kind, intent: { fields: Object.keys(patch) },
    normalizedResultPatch: patch, operationId, logicalClock: { physicalMs, logical: 0 },
  });
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [Array.from(items)];
  const result: T[][] = [];
  items.forEach((item, index) => {
    const rest = [...items.slice(0, index), ...items.slice(index + 1)];
    for (const tail of permutations(rest)) result.push([item, ...tail]);
  });
  return result;
}

function apply(commands: readonly OfflineSyncCommandEnvelope[]) {
  return [...commands].sort(compareOfflineSyncCommandOrder).reduce(
    (state, current) => reconcileOfflineSyncCommand(state, current).state,
    createEmptyOfflineSyncProjectionState({ content: 'base' }),
  );
}

describe('offline-sync-multi-device-model', () => {
  it('converges for every arrival permutation of concurrent field edits', () => {
    const commands = [
      command('op-a', 'device-a', 100, { content: 'a' }),
      command('op-b', 'device-b', 200, { content: 'b' }),
      command('op-c', 'device-a', 150, { title: 'title' }),
      command('op-d', 'device-b', 50, { tags: 'old' }),
    ];
    const states = permutations(commands).map(apply);
    states.slice(1).forEach(state => expect(state).toEqual(states[0]));
    expect(states[0]?.fields).toEqual({ content: 'b', title: 'title', tags: 'old' });
  });

  it('converges delete/edit/restore sequences with tombstone semantics', () => {
    const commands = [
      command('op-edit', 'device-a', 100, { content: 'edit' }),
      command('op-delete', 'device-b', 200, {}, 'task.delete'),
      command('op-restore', 'device-a', 300, { content: 'restored' }, 'task.restore'),
    ];
    const states = permutations(commands).map(apply);
    states.slice(1).forEach(state => expect(state).toEqual(states[0]));
    expect(states[0]?.tombstone).toBeUndefined();
    expect(states[0]?.fields.content).toBe('restored');
  });
});
