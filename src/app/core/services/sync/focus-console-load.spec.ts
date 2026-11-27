import { describe, expect, it } from 'vitest';
import { selectRemoteFocusSnapshot } from './focus-console-load';

describe('focus console load helpers', () => {
  it.each([
    [undefined, false, false],
    ['invalid-end-time', false, false],
    ['2026-03-03T04:00:00.000Z', true, true],
    ['2026-03-03T04:00:00.000Z', false, true],
    ['2026-03-03T04:00:00.000Z', false, false],
  ])('does not select unknown, contradictory or logically older terminal state (%s,%s,%s)', (endedAt, focusMode, isActive) => {
    expect(selectRemoteFocusSnapshot({
      ended_at: endedAt,
      updated_at: '2026-03-03T12:00:00.000Z',
      session_state: { version: 7, entries: [], focusMode, focusSessionState: { isActive }, savedAt: '2026-03-03T03:00:00.000Z' },
    }, '2026-03-03T02:00:00.000Z')).toBeNull();
  });

  it('accepts a coherent terminal snapshot without reopening its focus state', () => {
    const snapshot = { version: 7, entries: [], focusMode: false, focusSessionState: { isActive: false }, savedAt: '2026-03-03T04:00:00.000Z' };
    expect(selectRemoteFocusSnapshot({ ended_at: snapshot.savedAt, session_state: snapshot }, '2026-03-03T03:00:00.000Z')).toBe(snapshot);
  });

  it.each([[true, true], [false, true], [undefined, false]])(
    'rejects an ended row with active or unknown snapshot lifecycle even when savedAt is newer (%s,%s)', (focusMode, isActive) => {
      expect(selectRemoteFocusSnapshot({
        ended_at: '2026-03-03T04:00:00.000Z',
        session_state: { version: 7, entries: [], focusMode, focusSessionState: { isActive }, savedAt: '2026-03-03T05:00:00.000Z' },
      }, '2026-03-03T03:00:00.000Z')).toBeNull();
    },
  );
  it('returns null when the remote row is absent', () => {
    expect(selectRemoteFocusSnapshot(null)).toBeNull();
  });

  it('returns null when the remote session_state is not a dock snapshot', () => {
    expect(selectRemoteFocusSnapshot({
      ended_at: null,
      updated_at: '2026-03-03T01:00:00.000Z',
      session_state: { version: 1 },
    })).toBeNull();
  });

  it('keeps local data when localUpdatedAt is newer than the remote row', () => {
    expect(selectRemoteFocusSnapshot(
      {
        ended_at: null,
        updated_at: '2026-03-03T01:00:00.000Z',
        session_state: { version: 6, entries: [], savedAt: '2026-03-03T01:00:00.000Z' },
      },
      '2026-03-03T02:00:00.000Z',
    )).toBeNull();
  });

  it('returns the remote snapshot when it is valid and not older than local data', () => {
    const snapshot = { version: 6, entries: [{ taskId: 'task-1' }], savedAt: '2026-03-03T02:00:00.000Z' };

    expect(selectRemoteFocusSnapshot(
      {
        ended_at: null,
        updated_at: '2026-03-03T02:00:00.000Z',
        session_state: snapshot,
      },
      '2026-03-03T01:00:00.000Z',
    )).toBe(snapshot);
  });

  it('preserves newer local business data even when the server touched the old remote row later', () => {
    const snapshot = { version: 6, entries: [], savedAt: '2026-03-03T01:00:00.000Z' };
    expect(selectRemoteFocusSnapshot({
      ended_at: null,
      updated_at: '2026-03-03T12:00:00.000Z',
      session_state: snapshot,
    }, '2026-03-03T02:00:00.000Z')).toBeNull();
  });

  it('selects genuinely newer remote business data even when row.updated_at is older', () => {
    const snapshot = { version: 6, entries: [], savedAt: '2026-03-03T03:00:00.000Z' };
    expect(selectRemoteFocusSnapshot({
      ended_at: null,
      updated_at: '2026-03-03T01:00:00.000Z',
      session_state: snapshot,
    }, '2026-03-03T02:00:00.000Z')).toBe(snapshot);
  });

  it.each([undefined, null, '', 'not-a-date', '2026-02-30T12:00:00.000Z', '2026-03-03', '2026-03-03T25:00:00Z', 1772499600000])(
    'rejects missing or invalid legacy savedAt without falling back to the server clock (%s)', savedAt => {
      const row = {
        ended_at: null,
        updated_at: '2026-03-03T12:00:00.000Z',
        session_state: { version: 6, entries: [], savedAt },
      };
      expect(selectRemoteFocusSnapshot(row, '2026-03-03T02:00:00.000Z')).toBeNull();
      expect(selectRemoteFocusSnapshot(row)).toBeNull();
    },
  );

  it.each(['', 'invalid-local-date', '2026-02-30T12:00:00.000Z'])(
    'preserves local data when a supplied local business baseline is invalid (%s)', localSavedAt => {
      expect(selectRemoteFocusSnapshot({
        ended_at: null,
        updated_at: '2026-03-03T12:00:00.000Z',
        session_state: { version: 6, entries: [], savedAt: '2026-03-03T03:00:00.000Z' },
      }, localSavedAt)).toBeNull();
    },
  );

  it('allows a valid remote business snapshot when there is no local baseline', () => {
    const snapshot = { version: 7, entries: [], savedAt: '2026-03-03T03:00:00.000Z' };
    expect(selectRemoteFocusSnapshot({ ended_at: null, session_state: snapshot })).toBe(snapshot);
  });

  it('keeps equal savedAt snapshots eligible and preserves the original object', () => {
    const snapshot = { version: 7, entries: [], savedAt: '2026-03-03T03:00:00.000Z' };
    expect(selectRemoteFocusSnapshot({ ended_at: null, session_state: snapshot }, snapshot.savedAt)).toBe(snapshot);
  });

  it('compares explicit timezone offsets as instants rather than lexical timestamps', () => {
    const snapshot = { version: 7, entries: [], savedAt: '2026-03-03T11:00:00.000+08:00' };
    expect(selectRemoteFocusSnapshot({ ended_at: null, session_state: snapshot }, '2026-03-03T02:00:00.000Z')).toBe(snapshot);
    expect(selectRemoteFocusSnapshot({ ended_at: null, session_state: snapshot }, '2026-03-03T04:00:00.000Z')).toBeNull();
  });
});
