import { describe, expect, it } from 'vitest';
import { createOfflineSyncCommand } from './offline-sync-command-envelope';
import {
  createEmptyOfflineSyncProjectionState,
  reconcileOfflineSyncCommand,
} from './offline-sync-reconcile-policy';

function command(overrides: Partial<Parameters<typeof createOfflineSyncCommand>[0]> = {}) {
  return createOfflineSyncCommand({
    ownerUserId: 'owner-1',
    installationId: 'installation-1',
    deviceId: 'device-a',
    entityType: 'task',
    entityId: 'task-1',
    command: 'task.update',
    intent: { fields: ['content'] },
    normalizedResultPatch: { content: 'value' },
    operationId: 'op-a',
    logicalClock: { physicalMs: 100, logical: 0 },
    ...overrides,
  });
}

describe('offline-sync-reconcile-policy', () => {
  it('merges different fields and uses deterministic field-level LWW', () => {
    const initial = createEmptyOfflineSyncProjectionState();
    const content = command({ normalizedResultPatch: { content: 'newer' }, logicalClock: { physicalMs: 200, logical: 0 }, operationId: 'op-newer' });
    const title = command({ normalizedResultPatch: { title: 'title' }, logicalClock: { physicalMs: 150, logical: 0 }, operationId: 'op-title' });
    const afterContent = reconcileOfflineSyncCommand(initial, content);
    const afterTitle = reconcileOfflineSyncCommand(afterContent.state, title);

    expect(afterTitle.state.fields).toEqual({ content: 'newer', title: 'title' });
    expect(afterTitle.appliedFields).toEqual(['title']);
  });

  it('keeps the newer field value when an older command arrives later', () => {
    const newer = command({ normalizedResultPatch: { content: 'newer' }, logicalClock: { physicalMs: 200, logical: 0 }, operationId: 'op-newer' });
    const older = command({ normalizedResultPatch: { content: 'older' }, logicalClock: { physicalMs: 100, logical: 0 }, operationId: 'op-older' });
    const state = reconcileOfflineSyncCommand(createEmptyOfflineSyncProjectionState(), newer).state;
    const result = reconcileOfflineSyncCommand(state, older);

    expect(result.state.fields.content).toBe('newer');
    expect(result.evidence[0]).toMatchObject({
      reason: 'older-field-write',
      losingOperationId: 'op-older',
      winningOperationId: 'op-newer',
      losingValue: 'older',
      winningValue: 'newer',
      losingCommand: older,
      winningCommand: newer,
    });
  });

  it('retains both full commands when a newer write replaces an accepted field value', () => {
    const first = command({ normalizedResultPatch: { content: 'first' }, logicalClock: { physicalMs: 100, logical: 0 }, operationId: 'op-first' });
    const second = command({ normalizedResultPatch: { content: 'second' }, logicalClock: { physicalMs: 200, logical: 0 }, operationId: 'op-second' });
    const firstResult = reconcileOfflineSyncCommand(createEmptyOfflineSyncProjectionState(), first);
    const secondResult = reconcileOfflineSyncCommand(firstResult.state, second);

    expect(secondResult.evidence[0]).toMatchObject({
      reason: 'older-field-write',
      losingCommand: first,
      winningCommand: second,
      losingValue: 'first',
      winningValue: 'second',
    });
  });

  it('lets a tombstone block edits until an explicit newer restore', () => {
    const deleted = command({ command: 'task.delete', normalizedResultPatch: {}, logicalClock: { physicalMs: 200, logical: 0 }, operationId: 'op-delete' });
    const edit = command({ normalizedResultPatch: { content: 'edit-after-delete' }, logicalClock: { physicalMs: 300, logical: 0 }, operationId: 'op-edit' });
    const restore = command({ command: 'task.restore', normalizedResultPatch: { content: 'restored' }, logicalClock: { physicalMs: 400, logical: 0 }, operationId: 'op-restore' });

    const deletedState = reconcileOfflineSyncCommand(createEmptyOfflineSyncProjectionState({ content: 'before' }), deleted).state;
    const blocked = reconcileOfflineSyncCommand(deletedState, edit);
    const restored = reconcileOfflineSyncCommand(blocked.state, restore);

    expect(blocked.applied).toBe(false);
    expect(blocked.evidence[0]).toMatchObject({
      reason: 'edit-blocked-by-tombstone',
      losingCommand: edit,
      winningCommand: deleted,
      losingValue: undefined,
      winningValue: undefined,
    });
    expect(restored.state.tombstone).toBeUndefined();
    expect(restored.state.fields.content).toBe('restored');
    expect(restored.evidence).toContainEqual(expect.objectContaining({
      reason: 'restore-wins',
      losingCommand: deleted,
      winningCommand: restore,
    }));
  });
});