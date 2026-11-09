import { describe, expect, it } from 'vitest';

import type { BlackBoxEntry } from '../models/focus';
import {
  buildBlackBoxInsertPayload,
  buildBlackBoxUpdatePayload,
} from './black-box-sync-push-payload.helpers';

const focusMeta: NonNullable<BlackBoxEntry['focusMeta']> = {
  source: 'focus-console-inline',
  sessionId: 'session-1',
  title: 'Focus title',
  detail: 'Focus detail',
  lane: 'combo-select',
  expectedMinutes: 25,
  waitMinutes: 5,
  cognitiveLoad: 'high',
  dockEntryId: 'dock-entry-1',
};

function createEntry(overrides: Partial<BlackBoxEntry> = {}): BlackBoxEntry {
  return {
    id: 'entry-1',
    projectId: 'project-1',
    userId: 'user-1',
    content: 'entry content',
    focusMeta,
    date: '2026-06-15',
    createdAt: '2026-06-15T01:00:00.000Z',
    updatedAt: '2026-06-15T02:00:00.000Z',
    completedAt: '2026-06-15T03:00:00.000Z',
    isRead: true,
    isCompleted: true,
    isArchived: false,
    snoozeUntil: '2026-06-16T01:00:00.000Z',
    snoozeCount: 2,
    deletedAt: null,
    ...overrides,
  };
}

describe('black-box sync push payload helpers', () => {
  it('builds update payload without owner/id-only insert fields', () => {
    expect(buildBlackBoxUpdatePayload(createEntry())).toEqual({
      project_id: 'project-1',
      content: 'entry content',
      focus_meta: focusMeta,
      date: '2026-06-15',
      created_at: '2026-06-15T01:00:00.000Z',
      completed_at: '2026-06-15T03:00:00.000Z',
      is_read: true,
      is_completed: true,
      is_archived: false,
      snooze_until: '2026-06-16T01:00:00.000Z',
      snooze_count: 2,
      deleted_at: null,
    });
  });

  it('normalizes optional nullable fields for insert payloads', () => {
    expect(buildBlackBoxInsertPayload(createEntry({
      projectId: null,
      focusMeta: undefined,
      completedAt: undefined,
    }))).toEqual(expect.objectContaining({
      id: 'entry-1',
      user_id: 'user-1',
      project_id: null,
      focus_meta: null,
      completed_at: null,
    }));
  });
});
