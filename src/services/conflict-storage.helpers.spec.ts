import { describe, expect, it } from 'vitest';
import {
  LEGACY_UNKNOWN_OWNER_USER_ID,
  getConflictFallbackKey,
  isConflictRecordVisible,
  mergeConflictRecords,
  selectPreferredConflictRecord,
  toStoredConflictRecord,
  type ConflictRecord,
} from './conflict-storage.helpers';

function createConflictRecord(overrides: Partial<ConflictRecord> = {}): ConflictRecord {
  return {
    projectId: 'proj-a',
    ownerUserId: 'user-a',
    localProject: { id: 'proj-a', name: 'Project A', tasks: [], connections: [] } as never,
    conflictedAt: '2026-03-30T00:00:00.000Z',
    localVersion: 1,
    reason: 'version_mismatch',
    ...overrides,
  };
}

describe('conflict storage helpers', () => {
  it('isolates ownerless legacy records into the unknown-owner scoped bucket', () => {
    const record = toStoredConflictRecord(createConflictRecord({ ownerUserId: undefined }));

    expect(record.ownerUserId).toBe(LEGACY_UNKNOWN_OWNER_USER_ID);
    expect(record.scopedId).toBe(`${LEGACY_UNKNOWN_OWNER_USER_ID}::proj-a`);
  });

  it('keeps explicit owners in scoped record ids', () => {
    const record = toStoredConflictRecord(createConflictRecord({
      ownerUserId: 'user-b',
      projectId: 'proj-shared',
    }));

    expect(record.ownerUserId).toBe('user-b');
    expect(record.scopedId).toBe('user-b::proj-shared');
  });

  it('builds scoped fallback keys without leaking legacy unknown-owner records into user buckets', () => {
    expect(getConflictFallbackKey('proj-a', 'user-a')).toBe('nanoflow.conflict.user-a.proj-a');
    expect(getConflictFallbackKey('proj-a', LEGACY_UNKNOWN_OWNER_USER_ID)).toBe('nanoflow.conflict.proj-a');
  });

  it('treats only explicit matching-owner records as visible', () => {
    expect(isConflictRecordVisible(createConflictRecord({ ownerUserId: 'user-a' }), 'user-a')).toBe(true);
    expect(isConflictRecordVisible(createConflictRecord({ ownerUserId: 'user-b' }), 'user-a')).toBe(false);
    expect(isConflictRecordVisible(createConflictRecord({ ownerUserId: undefined }), 'user-a')).toBe(false);
    expect(isConflictRecordVisible(null, 'user-a')).toBe(false);
  });

  it('prefers the fallback record when it is newer than the indexed record', () => {
    const indexed = createConflictRecord({
      conflictedAt: '2026-03-30T00:00:00.000Z',
      localVersion: 5,
    });
    const fallback = createConflictRecord({
      conflictedAt: '2026-03-31T00:00:00.000Z',
      localVersion: 1,
    });

    expect(selectPreferredConflictRecord(indexed, fallback)).toBe(fallback);
  });

  it('uses localVersion as a tie-breaker when conflict timestamps match', () => {
    const indexed = createConflictRecord({
      conflictedAt: '2026-03-30T00:00:00.000Z',
      localVersion: 2,
    });
    const fallback = createConflictRecord({
      conflictedAt: '2026-03-30T00:00:00.000Z',
      localVersion: 3,
    });

    expect(selectPreferredConflictRecord(indexed, fallback)).toBe(fallback);
  });

  it('does not carry a fresh remote snapshot into a newer local-only conflict record', () => {
    const existing = createConflictRecord({
      remoteProject: {
        id: 'proj-a',
        name: 'Old remote',
        tasks: [],
        connections: [],
      } as never,
      remoteSnapshotFresh: true,
      remoteVersion: 3,
      conflictedAt: '2026-03-30T00:00:00.000Z',
      localVersion: 2,
    });
    const incoming = createConflictRecord({
      localProject: {
        id: 'proj-a',
        name: 'New local only',
        tasks: [],
        connections: [],
      } as never,
      conflictedAt: '2026-03-31T00:00:00.000Z',
      localVersion: 4,
    });

    const merged = mergeConflictRecords(existing, incoming);

    expect(merged.remoteSnapshotFresh).toBe(false);
    expect(merged.remoteProject).toBeUndefined();
    expect(merged.remoteVersion).toBeUndefined();
  });

  it('keeps an existing fresh remote snapshot when appending operation-level evidence', () => {
    const existing = createConflictRecord({
      remoteProject: {
        id: 'proj-a',
        name: 'Fresh remote',
        tasks: [],
        connections: [],
      } as never,
      remoteSnapshotFresh: true,
      remoteVersion: 3,
      conflictedAt: '2026-03-30T00:00:00.000Z',
      localVersion: 2,
    });
    const incoming = createConflictRecord({
      conflictedAt: '2026-03-30T00:05:00.000Z',
      localVersion: 2,
      operationConflicts: [{
        actionId: 'action-task-a',
        actionType: 'task:update',
        entityType: 'task',
        entityId: 'task-a',
        projectId: 'proj-a',
        operationId: 'op-task-a',
        localEntity: { id: 'task-a', title: 'Local task' } as never,
        message: 'Task conflict',
        conflictedAt: '2026-03-30T00:05:00.000Z',
        reason: 'remote-newer',
      }],
    });

    const merged = mergeConflictRecords(existing, incoming);

    expect(merged.remoteSnapshotFresh).toBe(true);
    expect(merged.remoteProject).toEqual(expect.objectContaining({
      id: 'proj-a',
      name: 'Fresh remote',
    }));
    expect(merged.remoteVersion).toBe(3);
    expect(merged.operationConflicts?.map(conflict => conflict.operationId)).toEqual(['op-task-a']);
  });

  it('preserves an incoming stale remote snapshot as conflict evidence without marking it fresh', () => {
    const existing = createConflictRecord({
      localProject: {
        id: 'proj-a',
        name: 'Previous local',
        tasks: [],
        connections: [],
      } as never,
      conflictedAt: '2026-03-30T00:00:00.000Z',
      localVersion: 2,
    });
    const incoming = createConflictRecord({
      localProject: {
        id: 'proj-a',
        name: 'Resolved local',
        tasks: [],
        connections: [],
      } as never,
      remoteProject: {
        id: 'proj-a',
        name: 'Fallback remote evidence',
        tasks: [],
        connections: [],
      } as never,
      remoteSnapshotFresh: false,
      remoteVersion: 9,
      conflictedAt: '2026-03-31T00:00:00.000Z',
      localVersion: 4,
    });

    const merged = mergeConflictRecords(existing, incoming);

    expect(merged.remoteSnapshotFresh).toBe(false);
    expect(merged.remoteProject).toEqual(expect.objectContaining({
      id: 'proj-a',
      name: 'Fallback remote evidence',
    }));
    expect(merged.remoteVersion).toBe(9);
  });
});
