import { describe, expect, it } from 'vitest';

import {
  CHANGE_TRACKER_FIELD_LOCKS_STORAGE_KEY,
  CHANGE_TRACKER_PENDING_CHANGES_STORAGE_KEY,
  restoreFieldLocks,
  restorePendingChangeRecords,
  serializeFieldLocks,
  serializePendingChanges,
} from './change-tracker-persistence.helpers';
import { type ChangeRecord } from './change-tracker.types';

function createRecord(overrides: Partial<ChangeRecord> = {}): ChangeRecord {
  return {
    entityId: 'task-1',
    entityType: 'task',
    changeType: 'update',
    projectId: 'project-1',
    timestamp: 100,
    ...overrides,
  };
}

describe('change-tracker-persistence.helpers', () => {
  it('normalizes restorable records and ignores malformed persisted entries', () => {
    const raw = JSON.stringify({
      changes: [
        createRecord({ entityId: 'task-1', timestamp: 100 }),
        createRecord({ entityId: 'task-2', timestamp: 200, revision: 5 }),
        { entityId: 'bad', entityType: 'task', changeType: 'update', timestamp: 300 },
        null,
      ],
    });

    const result = restorePendingChangeRecords(raw);

    expect(result.changes).toEqual([
      createRecord({ entityId: 'task-1', timestamp: 100, revision: 100 }),
      createRecord({ entityId: 'task-2', timestamp: 200, revision: 5 }),
    ]);
    expect(result.maxRevision).toBe(100);
  });

  it('serializes pending changes with the stable storage key contract', () => {
    const record = createRecord({ revision: 7 });

    expect(CHANGE_TRACKER_PENDING_CHANGES_STORAGE_KEY)
      .toBe('nanoflow.change-tracker.pending-changes.v1');
    expect(JSON.parse(serializePendingChanges([record], '2026-06-27T00:00:00.000Z')))
      .toEqual({
        version: 1,
        changes: [record],
        savedAt: '2026-06-27T00:00:00.000Z',
      });
  });

  it('serializes active field locks with the stable storage key contract', () => {
    const locks = new Map([
      ['project-1:task-1:title', { timestamp: 100, duration: 60_000 }],
    ]);

    expect(CHANGE_TRACKER_FIELD_LOCKS_STORAGE_KEY)
      .toBe('nanoflow.change-tracker.field-locks.v1');
    expect(JSON.parse(serializeFieldLocks(locks, 30_000, '2026-06-27T00:00:00.000Z')))
      .toEqual({
        version: 1,
        locks: [
          ['project-1:task-1:title', { timestamp: 100, duration: 60_000 }],
        ],
        savedAt: '2026-06-27T00:00:00.000Z',
      });
  });

  it('restores only unexpired field locks and normalizes legacy numeric entries', () => {
    const raw = JSON.stringify({
      locks: [
        ['project-1:task-1:title', { timestamp: 100, duration: 60_000 }],
        ['project-1:task-1:status', { timestamp: 100, duration: 10 }],
        ['project-1:task-1:content', 120],
        ['bad-lock'],
        [42, { timestamp: 100, duration: 60_000 }],
      ],
    });

    expect(restoreFieldLocks(raw, 130, 30_000)).toEqual({
      locks: [
        ['project-1:task-1:title', { timestamp: 100, duration: 60_000 }],
        ['project-1:task-1:content', { timestamp: 120, duration: 30_000 }],
      ],
    });
  });
});
