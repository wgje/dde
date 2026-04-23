import { describe, expect, it } from 'vitest';

import {
  buildSummaryVersion,
  buildSummaryVersionCursor,
  isSummaryVersionRegressed,
} from '../../supabase/functions/widget-summary/summary-version';

describe('widget summary version cursor', () => {
  it('uses the black-box watermark when the acted-on entry drops out of the visible preview list', () => {
    const cursor = buildSummaryVersionCursor({
      latestSessionUpdatedAt: '2026-04-23T09:00:00.000Z',
      blackBoxWatermark: '2026-04-23T10:05:00.000Z',
      dockTasksWatermark: '2026-04-23T09:30:00.000Z',
      focusTaskUpdatedAt: '2026-04-23T09:45:00.000Z',
      focusProjectUpdatedAt: '2026-04-23T09:15:00.000Z',
      dockTaskUpdatedAts: ['2026-04-23T09:40:00.000Z'],
      dockProjectUpdatedAts: ['2026-04-23T09:20:00.000Z'],
    });

    expect(cursor).toBe('2026-04-23T10:05:00.000Z');
    expect(
      isSummaryVersionRegressed(
        buildSummaryVersion('2026-04-23T10:00:00.000Z', 'older-signature'),
        buildSummaryVersion(cursor, 'newer-signature'),
      ),
    ).toBe(false);
  });

  it('still reports a real regression when the current cursor is genuinely older', () => {
    expect(
      isSummaryVersionRegressed(
        buildSummaryVersion('2026-04-23T10:05:00.000Z', 'older-signature'),
        buildSummaryVersion('2026-04-23T09:55:00.000Z', 'newer-signature'),
      ),
    ).toBe(true);
  });
});