import { describe, expect, it } from 'vitest';
import type { Task } from '../models';
import {
  appendUnprocessedRemoteTasks,
  createTaskMergeState,
  keepConservativeLocalTask,
  keepSoftDeletedLocalTask,
  skipTombstoneTask,
} from './conflict-resolution-merge.helpers';

function task(overrides: Partial<Task> & { id: string }): Task {
  return {
    id: overrides.id,
    title: overrides.title ?? overrides.id,
    content: overrides.content ?? '',
    stage: overrides.stage ?? 1,
    parentId: overrides.parentId ?? null,
    order: overrides.order ?? 1,
    rank: overrides.rank ?? 1000,
    status: overrides.status ?? 'active',
    x: overrides.x ?? 0,
    y: overrides.y ?? 0,
    createdDate: overrides.createdDate ?? '2026-01-01T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-01-01T00:00:00.000Z',
    displayId: overrides.displayId ?? overrides.id,
    deletedAt: overrides.deletedAt,
  };
}

describe('conflict-resolution merge helpers', () => {
  it('initializes merge state with the provided issues array', () => {
    const issues = ['preexisting'];

    const state = createTaskMergeState(issues);

    expect(state.issues).toBe(issues);
    expect(state.mergedTasks).toEqual([]);
    expect(state.processedIds.size).toBe(0);
    expect(state.conflictCount).toBe(0);
    expect(state.skippedTombstoneCount).toBe(0);
    expect(state.preservedSoftDeleteCount).toBe(0);
    expect(state.conservativeCount).toBe(0);
  });

  it('marks tombstone tasks as skipped without appending them', () => {
    const state = createTaskMergeState([]);
    const deleted = task({ id: 'deleted' });

    const skipped = skipTombstoneTask(deleted, new Set(['deleted']), state);

    expect(skipped).toBe(true);
    expect(state.skippedTombstoneCount).toBe(1);
    expect(state.mergedTasks).toEqual([]);
  });

  it('keeps a local task when its update is newer than the tombstone deletion time', () => {
    const state = createTaskMergeState([]);
    const restored = task({
      id: 'restored',
      updatedAt: '2026-01-03T00:00:00.000Z',
    });
    const tombstones = new Set(['restored']) as Set<string> & {
      deletedAtByTaskId: Map<string, number>;
    };
    tombstones.deletedAtByTaskId = new Map([
      ['restored', Date.parse('2026-01-02T00:00:00.000Z')],
    ]);

    const skipped = skipTombstoneTask(restored, tombstones, state);

    expect(skipped).toBe(false);
    expect(state.skippedTombstoneCount).toBe(0);
  });

  it('preserves local soft-deleted tasks only when the remote task is absent', () => {
    const state = createTaskMergeState([]);
    const localDeleted = task({ id: 'soft-delete', deletedAt: '2026-01-02T00:00:00.000Z' });

    expect(keepSoftDeletedLocalTask(localDeleted, undefined, state)).toBe(true);
    expect(state.mergedTasks).toEqual([localDeleted]);
    expect(state.preservedSoftDeleteCount).toBe(1);
    expect(keepSoftDeletedLocalTask(localDeleted, task({ id: 'soft-delete' }), state)).toBe(false);
  });

  it('keeps local tasks conservatively only when tombstone lookup failed with an empty cache', () => {
    const state = createTaskMergeState([]);
    const localOnly = task({ id: 'local-only' });

    expect(keepConservativeLocalTask(localOnly, undefined, new Set(), true, state)).toBe(true);
    expect(state.mergedTasks).toEqual([localOnly]);
    expect(state.conservativeCount).toBe(1);

    expect(keepConservativeLocalTask(task({ id: 'remote-exists' }), task({ id: 'remote-exists' }), new Set(), true, state))
      .toBe(false);
    expect(keepConservativeLocalTask(task({ id: 'has-tombstone-cache' }), undefined, new Set(['x']), true, state))
      .toBe(false);
    expect(keepConservativeLocalTask(task({ id: 'lookup-ok' }), undefined, new Set(), false, state))
      .toBe(false);
  });

  it('appends only unprocessed remote tasks accepted by the include predicate', () => {
    const state = createTaskMergeState([]);
    state.processedIds.add('already-local');
    const keep = task({ id: 'keep' });
    const processed = task({ id: 'already-local' });
    const filtered = task({ id: 'filtered', deletedAt: '2026-01-02T00:00:00.000Z' });

    appendUnprocessedRemoteTasks([keep, processed, filtered], state, remoteTask => !remoteTask.deletedAt);

    expect(state.mergedTasks).toEqual([keep]);
  });
});
