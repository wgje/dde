import { describe, expect, it } from 'vitest';
import type { BlackBoxEntry } from '../models/focus';
import {
  compareBlackBoxPreflightTimestampValues,
  mergeBlackBoxPreflightMonotonicFacts,
} from './black-box-sync-preflight.helpers';

function createEntry(overrides: Partial<BlackBoxEntry> = {}): BlackBoxEntry {
  return {
    id: 'entry-1',
    projectId: 'project-1',
    userId: 'user-1',
    content: 'entry content',
    focusMeta: null,
    date: '2026-06-15',
    createdAt: '2026-06-15T01:00:00.000Z',
    updatedAt: '2026-06-15T02:00:00.000Z',
    completedAt: '2026-06-15T03:00:00.000Z',
    isRead: false,
    isCompleted: false,
    isArchived: false,
    snoozeCount: 0,
    deletedAt: null,
    ...overrides,
  };
}

describe('black-box sync preflight helpers', () => {
  it('compares timestamp baselines using parsed milliseconds', () => {
    expect(compareBlackBoxPreflightTimestampValues(
      '2026-06-15T02:00:00.000Z',
      '2026-06-15T05:00:00.000+03:00',
    )).toEqual({
      rawLocalMs: Date.parse('2026-06-15T02:00:00.000Z'),
      rawServerMs: Date.parse('2026-06-15T05:00:00.000+03:00'),
      timestampsDiffer: false,
    });

    expect(compareBlackBoxPreflightTimestampValues(
      '2026-06-15T02:00:00.000Z',
      '2026-06-15T02:00:01.000Z',
    )).toEqual({
      rawLocalMs: Date.parse('2026-06-15T02:00:00.000Z'),
      rawServerMs: Date.parse('2026-06-15T02:00:01.000Z'),
      timestampsDiffer: true,
    });
  });

  it('returns null when the server is not newer and no monotonic regression exists', () => {
    expect(mergeBlackBoxPreflightMonotonicFacts(
      createEntry(),
      createEntry({ updatedAt: '2026-06-15T01:59:59.000Z' }),
      false,
    )).toBeNull();
  });

  it('returns the server entry unchanged when the server is newer', () => {
    const serverEntry = createEntry({
      updatedAt: '2026-06-15T02:05:00.000Z',
      isRead: true,
      isCompleted: true,
      deletedAt: '2026-06-15T02:06:00.000Z',
    });

    expect(mergeBlackBoxPreflightMonotonicFacts(createEntry(), serverEntry, true)).toBe(serverEntry);
  });

  it('merges only monotonic facts from the server when the local entry is newer', () => {
    expect(mergeBlackBoxPreflightMonotonicFacts(
      createEntry({
        updatedAt: '2026-06-15T02:10:00.000Z',
        isRead: false,
        isCompleted: false,
        deletedAt: null,
        completedAt: null,
      }),
      createEntry({
        updatedAt: '2026-06-15T02:05:00.000Z',
        isRead: true,
        isCompleted: true,
        deletedAt: '2026-06-15T02:06:00.000Z',
        completedAt: '2026-06-15T02:04:00.000Z',
      }),
      false,
    )).toEqual({
      ...createEntry({
        updatedAt: '2026-06-15T02:10:00.000Z',
        isRead: false,
        isCompleted: false,
        deletedAt: null,
        completedAt: null,
      }),
      isRead: true,
      isCompleted: true,
      completedAt: '2026-06-15T02:04:00.000Z',
      deletedAt: '2026-06-15T02:06:00.000Z',
    });
  });
});
