/**
 * PARKING_CONFIG contract tests
 */

import { describe, expect, it } from 'vitest';
import { PARKING_CONFIG } from '../../config/parking.config';

describe('PARKING_CONFIG contract', () => {
  it('PARKED_TASK_STALE_THRESHOLD should be 72h', () => {
    expect(PARKING_CONFIG.PARKED_TASK_STALE_THRESHOLD).toBe(72 * 60 * 60 * 1000);
  });

  it('PARKED_TASK_STALE_WARNING should be 64h', () => {
    expect(PARKING_CONFIG.PARKED_TASK_STALE_WARNING).toBe(64 * 60 * 60 * 1000);
  });

  it('PARKED_TASK_SOFT_LIMIT should be 10', () => {
    expect(PARKING_CONFIG.PARKED_TASK_SOFT_LIMIT).toBe(10);
  });

  it('NOTICE_MIN_VISIBLE_MS should be 2500', () => {
    expect(PARKING_CONFIG.NOTICE_MIN_VISIBLE_MS).toBe(2500);
  });

  it('NOTICE_FALLBACK_TIMEOUT_MS should be 15000', () => {
    expect(PARKING_CONFIG.NOTICE_FALLBACK_TIMEOUT_MS).toBe(15000);
  });

  it('SNOOZE_PRESETS should contain 4 presets', () => {
    expect(PARKING_CONFIG.SNOOZE_PRESETS.QUICK).toBe(5 * 60 * 1000);
    expect(PARKING_CONFIG.SNOOZE_PRESETS.NORMAL).toBe(30 * 60 * 1000);
    expect(PARKING_CONFIG.SNOOZE_PRESETS.TWO_HOURS_LATER).toBe(2 * 60 * 60 * 1000);
    expect(PARKING_CONFIG.SNOOZE_PRESETS.TOMORROW_SAME_TIME).toBe(24 * 60 * 60 * 1000);
  });

  it('MAX_SNOOZE_COUNT should be 5', () => {
    expect(PARKING_CONFIG.MAX_SNOOZE_COUNT).toBe(5);
  });

  it('MIN_TOUCH_TARGET should be >= 44px', () => {
    expect(PARKING_CONFIG.MIN_TOUCH_TARGET).toBeGreaterThanOrEqual(44);
  });

  it('REMOVE_UNDO_TIMEOUT_MS should be 5000', () => {
    expect(PARKING_CONFIG.REMOVE_UNDO_TIMEOUT_MS).toBe(5000);
  });

  it('EVICTION_UNDO_TIMEOUT_MS should be 8000', () => {
    expect(PARKING_CONFIG.EVICTION_UNDO_TIMEOUT_MS).toBe(8000);
  });

  it('DOCK_EXPANDED_MAX_WIDTH should be 860', () => {
    expect(PARKING_CONFIG.DOCK_EXPANDED_MAX_WIDTH).toBe(860);
  });

  it('CONSOLE_CARD_WIDTH/HEIGHT should match v3 layout', () => {
    expect(PARKING_CONFIG.CONSOLE_CARD_WIDTH).toBe(340);
    expect(PARKING_CONFIG.CONSOLE_CARD_HEIGHT).toBe(440);
  });

  it('RADAR radii should match v3 tracks', () => {
    expect(PARKING_CONFIG.RADAR_STRONG_RADIUS).toBe(280);
    expect(PARKING_CONFIG.RADAR_WEAK_RADIUS).toBe(420);
  });

  it('DOCK_FOCUS backdrop constants should match plan defaults', () => {
    expect(PARKING_CONFIG.DOCK_V3_STRICT_SAMPLE_UI).toBe(false);
    expect(PARKING_CONFIG.DOCK_V3_SHOW_ADVANCED_UI).toBe(true);
    expect(PARKING_CONFIG.DOCK_V3_SHOW_HELP_HINTS).toBe(true);
    expect(PARKING_CONFIG.DOCK_FOCUS_BACKDROP_BLUR_PX).toBe(24);
    expect(PARKING_CONFIG.DOCK_FOCUS_BACKDROP_ALPHA).toBe(0.5);
    expect(PARKING_CONFIG.DOCK_STAGE_OFFSET_Y_PX).toBe(48);
  });

  it('DOCK_MOBILE_DISMISS_THRESHOLD should be 80px', () => {
    expect(PARKING_CONFIG.DOCK_MOBILE_DISMISS_THRESHOLD).toBe(80);
  });

  it('REMINDER_BADGE_THRESHOLD should be 2', () => {
    expect(PARKING_CONFIG.REMINDER_BADGE_THRESHOLD).toBe(2);
  });

  it('BEFORE_UNLOAD_PRIORITY should be 5', () => {
    expect(PARKING_CONFIG.BEFORE_UNLOAD_PRIORITY).toBe(5);
  });

  it('SNAPSHOT_DRAFT_KEY should be parking-snapshot-draft', () => {
    expect(PARKING_CONFIG.SNAPSHOT_DRAFT_KEY).toBe('parking-snapshot-draft');
  });

  it('DOCK_SNAPSHOT_STORAGE_KEY should be nanoflow.dock-snapshot.v3', () => {
    expect(PARKING_CONFIG.DOCK_SNAPSHOT_STORAGE_KEY).toBe('nanoflow.dock-snapshot.v3');
  });
});
