import { describe, expect, it } from 'vitest';
import { selectRemoteFocusSnapshot } from './focus-console-load';

describe('focus console load helpers', () => {
  it('returns null when the remote row is absent', () => {
    expect(selectRemoteFocusSnapshot(null)).toBeNull();
  });

  it('returns null when the remote session_state is not a dock snapshot', () => {
    expect(selectRemoteFocusSnapshot({
      updated_at: '2026-03-03T01:00:00.000Z',
      session_state: { version: 1 },
    })).toBeNull();
  });

  it('keeps local data when localUpdatedAt is newer than the remote row', () => {
    expect(selectRemoteFocusSnapshot(
      {
        updated_at: '2026-03-03T01:00:00.000Z',
        session_state: { version: 6, entries: [] },
      },
      '2026-03-03T02:00:00.000Z',
    )).toBeNull();
  });

  it('returns the remote snapshot when it is valid and not older than local data', () => {
    const snapshot = { version: 6, entries: [{ taskId: 'task-1' }] };

    expect(selectRemoteFocusSnapshot(
      {
        updated_at: '2026-03-03T02:00:00.000Z',
        session_state: snapshot,
      },
      '2026-03-03T01:00:00.000Z',
    )).toBe(snapshot);
  });
});
