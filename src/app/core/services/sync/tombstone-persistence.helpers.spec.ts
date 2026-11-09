import { describe, expect, it } from 'vitest';

import {
  normalizePersistedConnectionTombstones,
  serializeLocalTombstones,
} from './tombstone-persistence.helpers';

describe('tombstone-persistence.helpers', () => {
  it('serializes project task tombstone maps without dropping empty projects', () => {
    const tombstones = new Map([
      ['project-1', new Map([
        ['task-1', 1_780_000_000_000],
        ['task-2', 1_780_000_000_100],
      ])],
      ['project-empty', new Map<string, number>()],
    ]);

    expect(serializeLocalTombstones(tombstones)).toEqual({
      'project-1': {
        'task-1': 1_780_000_000_000,
        'task-2': 1_780_000_000_100,
      },
      'project-empty': {},
    });
  });

  it('normalizes current and legacy connection tombstones while rejecting expired or malformed entries', () => {
    const cutoff = 1_780_000_000_000;

    expect(normalizePersistedConnectionTombstones([
      {
        id: 'connection-current',
        timestamp: cutoff + 1,
        projectId: 'project-1',
      },
      {
        connectionId: 'connection-legacy',
        timestamp: cutoff + 2,
        projectId: '',
      },
      { id: 'connection-expired', timestamp: cutoff },
      { id: 'connection-nan', timestamp: Number.NaN },
      { id: 'connection-infinite', timestamp: Number.POSITIVE_INFINITY },
      { id: 'connection-string-time', timestamp: String(cutoff + 3) },
      { id: '', timestamp: cutoff + 4 },
      null,
    ], cutoff)).toEqual([
      {
        id: 'connection-current',
        timestamp: cutoff + 1,
        projectId: 'project-1',
      },
      {
        id: 'connection-legacy',
        timestamp: cutoff + 2,
      },
    ]);
  });

  it('returns no connection tombstones for non-array persisted payloads', () => {
    expect(normalizePersistedConnectionTombstones(null, 0)).toEqual([]);
    expect(normalizePersistedConnectionTombstones({}, 0)).toEqual([]);
  });
});
