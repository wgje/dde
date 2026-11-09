import { describe, expect, it } from 'vitest';

import {
  collectLockedTaskFields,
  collectProjectFieldLockKeys,
  collectTaskFieldLockKeys,
  createFieldLockData,
  makeFieldLockKey,
  resolveFieldLockState,
} from './change-tracker-field-lock.helpers';
import { type FieldLockData } from './change-tracker.types';

describe('change-tracker-field-lock.helpers', () => {
  it('resolves active and expired field locks while preserving legacy numeric locks', () => {
    expect(resolveFieldLockState({ timestamp: 100, duration: 50 }, 130, 30))
      .toEqual({ duration: 50, elapsed: 30, locked: true });
    expect(resolveFieldLockState({ timestamp: 100, duration: 50 }, 151, 30))
      .toEqual({ duration: 50, elapsed: 51, locked: false });
    expect(resolveFieldLockState(100, 120, 30))
      .toEqual({ duration: 30, elapsed: 20, locked: true });
  });

  it('collects locked task fields and reports expired lock keys for cleanup', () => {
    const locks = new Map<string, number | FieldLockData>([
      [makeFieldLockKey('project-1', 'task-1', 'title'), createFieldLockData(100, 50)],
      [makeFieldLockKey('project-1', 'task-1', 'status'), createFieldLockData(100, 10)],
      [makeFieldLockKey('project-1', 'task-2', 'content'), createFieldLockData(100, 50)],
    ]);

    expect(collectLockedTaskFields(locks, 'project-1', 'task-1', 120, 30))
      .toEqual({
        expiredKeys: [makeFieldLockKey('project-1', 'task-1', 'status')],
        lockedFields: ['title'],
      });
  });

  it('collects task and project scoped field lock keys', () => {
    const locks = new Map<string, number | FieldLockData>([
      [makeFieldLockKey('project-1', 'task-1', 'title'), createFieldLockData(100, 50)],
      [makeFieldLockKey('project-1', 'task-2', 'content'), createFieldLockData(100, 50)],
      [makeFieldLockKey('project-2', 'task-1', 'status'), createFieldLockData(100, 50)],
    ]);

    expect(collectTaskFieldLockKeys(locks, 'project-1', 'task-1'))
      .toEqual([makeFieldLockKey('project-1', 'task-1', 'title')]);
    expect(collectProjectFieldLockKeys(locks, 'project-1'))
      .toEqual([
        makeFieldLockKey('project-1', 'task-1', 'title'),
        makeFieldLockKey('project-1', 'task-2', 'content'),
      ]);
  });
});
