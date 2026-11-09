import { describe, expect, it } from 'vitest';

import {
  findFocusedParkingTask,
  getActiveParkingProjectIds,
  hasUpcomingParkingReminder,
  isParkingOverSoftLimit,
} from './parking-derived-state.helpers';

describe('parking-derived-state.helpers', () => {
  it('finds the single focused parked task', () => {
    const focused = { id: 'focused', parkingMeta: { state: 'focused' } };

    expect(findFocusedParkingTask([
      { id: 'parked', parkingMeta: { state: 'parked' } },
      focused,
    ])).toBe(focused);
    expect(findFocusedParkingTask([{ id: 'none' }])).toBeNull();
  });

  it('detects reminders scheduled inside the upcoming window only', () => {
    const now = Date.parse('2026-07-06T08:00:00.000Z');
    const upcoming = new Date(now + 30 * 60 * 1000).toISOString();
    const tooLate = new Date(now + 2 * 60 * 60 * 1000).toISOString();
    const past = new Date(now - 1_000).toISOString();

    expect(hasUpcomingParkingReminder([
      { parkingMeta: { reminder: { reminderAt: tooLate } } },
      { parkingMeta: { reminder: { reminderAt: upcoming } } },
    ], now, 60 * 60 * 1000)).toBe(true);
    expect(hasUpcomingParkingReminder([
      { parkingMeta: { reminder: { reminderAt: tooLate } } },
      { parkingMeta: { reminder: { reminderAt: past } } },
      { parkingMeta: { reminder: {} } },
    ], now, 60 * 60 * 1000)).toBe(false);
  });

  it('returns active project ids while skipping deleted projects', () => {
    expect(getActiveParkingProjectIds([
      { id: 'active-1' },
      { id: 'deleted', deletedAt: '2026-07-06T08:00:00.000Z' },
      { id: 'active-2', deletedAt: null },
    ])).toEqual(['active-1', 'active-2']);
  });

  it('checks the parking soft limit inclusively', () => {
    expect(isParkingOverSoftLimit(4, 5)).toBe(false);
    expect(isParkingOverSoftLimit(5, 5)).toBe(true);
    expect(isParkingOverSoftLimit(6, 5)).toBe(true);
  });
});
