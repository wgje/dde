import { describe, expect, it } from 'vitest';

import {
  mergeTombstoneRecord,
  parseTombstoneRecord,
  serializeTombstoneRecord,
} from './migration-tombstone-storage.helpers';

describe('migration-tombstone-storage.helpers', () => {
  it('parses array and object tombstone records while ignoring non-string ids', () => {
    const record = parseTombstoneRecord(JSON.stringify({
      projectA: ['task-1', 42, 'task-2'],
      projectB: { 'task-3': true, 'task-4': false },
      projectC: null,
    }));

    expect(Array.from(record.projectA ?? [])).toEqual(['task-1', 'task-2']);
    expect(Array.from(record.projectB ?? [])).toEqual(['task-3', 'task-4']);
    expect(record.projectC).toBeUndefined();
  });

  it('merges unique tombstone ids and serializes them for storage', () => {
    const target = parseTombstoneRecord(JSON.stringify({
      projectA: ['task-1'],
    }));
    const source = parseTombstoneRecord(JSON.stringify({
      projectA: ['task-1', 'task-2'],
      projectB: ['task-3'],
    }));

    const addedCount = mergeTombstoneRecord(target, source);

    expect(addedCount).toBe(2);
    expect(serializeTombstoneRecord(target)).toEqual({
      projectA: ['task-1', 'task-2'],
      projectB: ['task-3'],
    });
  });
});
