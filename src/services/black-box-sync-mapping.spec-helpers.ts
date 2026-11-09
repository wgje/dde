import { expect, it } from 'vitest';

import type { BlackBoxEntry } from '../models/focus';
import { BlackBoxSyncService } from './black-box-sync.service';

interface BlackBoxSyncMappingSpecContext {
  getService: () => BlackBoxSyncService;
}

export function registerBlackBoxSyncMappingSpecs(
  context: BlackBoxSyncMappingSpecContext,
): void {
  it('mapRowToEntry 应保留黑匣子 completed_at 作为稳定完成时间', () => {
    const entry = (context.getService() as unknown as {
      mapRowToEntry: (row: Record<string, unknown>) => BlackBoxEntry;
    }).mapRowToEntry({
      id: crypto.randomUUID(),
      project_id: null,
      user_id: 'user-1',
      content: 'entry',
      focus_meta: null,
      date: '2026-05-24',
      created_at: '2026-05-24T10:00:00.000Z',
      updated_at: '2026-06-04T07:30:00.000Z',
      completed_at: '2026-06-03T21:00:00.000Z',
      is_read: true,
      is_completed: true,
      is_archived: false,
      snooze_until: null,
      snooze_count: 0,
      deleted_at: null,
    });

    expect(entry.completedAt).toBe('2026-06-03T21:00:00.000Z');
  });

  it('final sync service keeps the cursor safety lookback contract after helper extraction', () => {
    const effectiveLastSync = (context.getService() as unknown as {
      applyBlackBoxCursorSafetyLookback: (value: string) => string;
    }).applyBlackBoxCursorSafetyLookback('2026-06-09T00:00:30.000Z');

    expect(effectiveLastSync).toBe('2026-06-09T00:00:00.000Z');
  });

  it('should map focus_meta from database row into focusMeta', () => {
    const mapRowToEntry = (context.getService() as unknown as {
      mapRowToEntry: (row: Record<string, unknown>) => { focusMeta?: unknown };
    }).mapRowToEntry.bind(context.getService());

    const mapped = mapRowToEntry({
      id: 'entry-1',
      project_id: null,
      user_id: 'user-1',
      content: 'inline detail',
      focus_meta: {
        source: 'focus-console-inline',
        sessionId: 'session-1',
        title: 'Inline task',
        detail: 'inline detail',
        lane: 'backup',
        expectedMinutes: 20,
        waitMinutes: 10,
        cognitiveLoad: 'low',
        dockEntryId: 'dock-entry-1',
      },
      date: '2026-03-04',
      created_at: '2026-03-04T00:00:00.000Z',
      updated_at: '2026-03-04T00:00:00.000Z',
      is_read: false,
      is_completed: false,
      is_archived: false,
      snooze_until: null,
      snooze_count: 0,
      deleted_at: null,
    });

    expect(mapped.focusMeta).toEqual({
      source: 'focus-console-inline',
      sessionId: 'session-1',
      title: 'Inline task',
      detail: 'inline detail',
      lane: 'backup',
      expectedMinutes: 20,
      waitMinutes: 10,
      cognitiveLoad: 'low',
      dockEntryId: 'dock-entry-1',
    });
  });
}
