import { describe, expect, it } from 'vitest';
import type { BlackBoxEntry } from '../models/focus';
import { hasEquivalentEntryState, normalizeEntryForEquivalence } from './black-box-entry-equivalence';

function makeEntry(overrides: Partial<BlackBoxEntry> = {}): BlackBoxEntry {
  return {
    id: 'entry-1',
    projectId: null,
    userId: 'user-1',
    content: 'Captured thought',
    date: '2026-01-01',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    completedAt: null,
    isRead: false,
    isCompleted: false,
    isArchived: false,
    snoozeUntil: undefined,
    snoozeCount: undefined,
    deletedAt: null,
    focusMeta: null,
    ...overrides,
  };
}

const sameInstant = (
  left: string | null | undefined,
  right: string | null | undefined,
): boolean => (left ?? null) === (right ?? null);

describe('black-box-entry-equivalence', () => {
  it('normalizes nullable equivalence fields without changing business state', () => {
    const normalized = normalizeEntryForEquivalence(makeEntry({
      projectId: undefined as unknown as string | null,
      completedAt: undefined,
      deletedAt: undefined as unknown as string | null,
      snoozeCount: undefined,
      focusMeta: {
        source: 'focus-console-inline',
        sessionId: 'session-1',
        title: 'Inline',
        detail: undefined as unknown as string | null,
        lane: 'combo-select',
        expectedMinutes: undefined as unknown as number | null,
        waitMinutes: undefined as unknown as number | null,
        cognitiveLoad: 'low',
        dockEntryId: 'dock-1',
      },
    }));

    expect(normalized.projectId).toBeNull();
    expect(normalized.completedAt).toBeNull();
    expect(normalized.deletedAt).toBeNull();
    expect(normalized.snoozeCount).toBe(0);
    expect(normalized.focusMeta?.detail).toBeNull();
    expect(normalized.focusMeta?.expectedMinutes).toBeNull();
    expect(normalized.focusMeta?.waitMinutes).toBeNull();
  });

  it('treats entries with normalized nullable drift as equivalent', () => {
    const local = makeEntry({ snoozeCount: undefined, focusMeta: undefined });
    const remote = makeEntry({ snoozeCount: 0, focusMeta: null });

    expect(hasEquivalentEntryState(local, remote, sameInstant)).toBe(true);
  });

  it('detects changed business fields after normalization', () => {
    const local = makeEntry({ content: 'original' });
    const remote = makeEntry({ content: 'changed' });

    expect(hasEquivalentEntryState(local, remote, sameInstant)).toBe(false);
  });

  it('detects changed focus metadata fields', () => {
    const local = makeEntry({
      focusMeta: {
        source: 'focus-console-inline',
        sessionId: 'session-1',
        title: 'Inline',
        detail: null,
        lane: 'combo-select',
        expectedMinutes: 15,
        waitMinutes: null,
        cognitiveLoad: 'low',
        dockEntryId: 'dock-1',
      },
    });
    const remote = makeEntry({
      focusMeta: {
        ...local.focusMeta!,
        expectedMinutes: 30,
      },
    });

    expect(hasEquivalentEntryState(local, remote, sameInstant)).toBe(false);
  });
});
