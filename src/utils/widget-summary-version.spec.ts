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

  it('preserves PostgreSQL microseconds when selecting the latest cursor', () => {
    const cursor = buildSummaryVersionCursor({
      latestSessionUpdatedAt: '2026-04-23T10:00:00.000100Z',
      dockTasksWatermark: '2026-04-23T10:00:00.000900Z',
    });

    expect(cursor).toBe('2026-04-23T10:00:00.000900Z');
  });

  it('keeps the first maximum when different offsets represent the same instant', () => {
    const first = '2026-04-24T00:30:00.123456+02:00';
    const equalInstant = '2026-04-23T22:30:00.123456Z';

    expect(
      buildSummaryVersionCursor({
        latestSessionUpdatedAt: first,
        dockTasksWatermark: equalInstant,
      }),
    ).toBe(first);
  });

  it('orders offset timestamps across a day boundary by instant', () => {
    const cursor = buildSummaryVersionCursor({
      latestSessionUpdatedAt: '2026-04-24T00:00:00.000900+02:00',
      dockTasksWatermark: '2026-04-23T22:00:00.001000Z',
    });

    expect(cursor).toBe('2026-04-23T22:00:00.001000Z');
  });

  it('normalizes variable fractional digits without changing equal-first behavior', () => {
    expect(
      buildSummaryVersionCursor({
        latestSessionUpdatedAt: '2026-04-23T10:00:00Z',
        dockTasksWatermark: '2026-04-23T10:00:00.000001Z',
      }),
    ).toBe('2026-04-23T10:00:00.000001Z');

    const first = '2026-04-23T10:00:00.1Z';
    expect(
      buildSummaryVersionCursor({
        latestSessionUpdatedAt: first,
        dockTasksWatermark: '2026-04-23T10:00:00.100000Z',
      }),
    ).toBe(first);
  });

  it('detects sub-millisecond regressions while accepting equal offset instants', () => {
    expect(
      isSummaryVersionRegressed(
        buildSummaryVersion('2026-04-23T10:00:00.000900Z', 'older-signature'),
        buildSummaryVersion('2026-04-23T10:00:00.000100Z', 'newer-signature'),
      ),
    ).toBe(true);

    expect(
      isSummaryVersionRegressed(
        buildSummaryVersion('2026-04-24T00:30:00.123456+02:00', 'older-signature'),
        buildSummaryVersion('2026-04-23T22:30:00.123456Z', 'newer-signature'),
      ),
    ).toBe(false);
  });

  it('keeps invalid timestamp fallback semantics unchanged', () => {
    expect(
      buildSummaryVersionCursor({
        latestSessionUpdatedAt: 'not-a-timestamp',
        dockTasksWatermark: '2026-04-23T10:00:00Z',
      }),
    ).toBe('2026-04-23T10:00:00Z');
    expect(buildSummaryVersionCursor({ latestSessionUpdatedAt: 'not-a-timestamp' })).toBeNull();

    expect(
      isSummaryVersionRegressed(
        buildSummaryVersion('not-a-timestamp', 'older-signature'),
        buildSummaryVersion('2026-04-23T10:00:00Z', 'newer-signature'),
      ),
    ).toBe(false);
    expect(
      isSummaryVersionRegressed(
        buildSummaryVersion('2026-04-23T10:00:00Z', 'older-signature'),
        buildSummaryVersion('not-a-timestamp', 'newer-signature'),
      ),
    ).toBe(true);
  });
});
