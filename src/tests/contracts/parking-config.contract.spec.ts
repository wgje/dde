/**
 * PARKING_CONFIG contract tests
 *
 * TODO: 当测试数量继续增长时，考虑按功能域拆分为独立的 describe 块或文件
 * （如 motion-tokens、focus-scene-tokens、schedule-rules 等），提高可维护性。
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

  it('dock anchor and drop feedback tokens should match v4 defaults', () => {
    expect(PARKING_CONFIG.DOCK_BOTTOM_OFFSET_PX).toBe(24);
    expect(PARKING_CONFIG.DOCK_FOCUS_DIM_OPACITY).toBe(0.35);
    expect(PARKING_CONFIG.DOCK_FOCUS_DIM_TRANSLATE_Y_PX).toBe(12);
    expect(PARKING_CONFIG.DOCK_DROP_REJECT_SHAKE_MS).toBe(180);
    expect(PARKING_CONFIG.DOCK_DROP_REJECT_RESET_MS).toBe(220);
  });

  it('CONSOLE_CARD_WIDTH/HEIGHT should match v3 layout', () => {
    expect(PARKING_CONFIG.CONSOLE_CARD_WIDTH).toBe(340);
    expect(PARKING_CONFIG.CONSOLE_CARD_HEIGHT).toBe(440);
  });

  it('RADAR radii should match v3 tracks', () => {
    expect(PARKING_CONFIG.RADAR_STRONG_RADIUS).toBe(280);
    expect(PARKING_CONFIG.RADAR_WEAK_RADIUS).toBe(420);
  });

  it('RADAR visible limits and fallback palette should match focus-console v3.3', () => {
    expect(PARKING_CONFIG.RADAR_COMBO_VISIBLE_LIMIT).toBe(8);
    expect(PARKING_CONFIG.RADAR_BACKUP_VISIBLE_LIMIT).toBe(10);
    expect(PARKING_CONFIG.RADAR_PROJECT_SHARED_COLOR).toBe('#64748b');
    expect(PARKING_CONFIG.RADAR_PROJECT_COLOR_PALETTE.length).toBeGreaterThanOrEqual(8);
  });

  it('DOCK_FOCUS backdrop constants should match active focus defaults', () => {
    expect(PARKING_CONFIG.DOCK_V3_STRICT_SAMPLE_UI).toBe(false);
    expect(PARKING_CONFIG.DOCK_V3_SHOW_ADVANCED_UI).toBe(true);
    expect(PARKING_CONFIG.DOCK_V3_SHOW_HELP_HINTS).toBe(true);
    expect(PARKING_CONFIG.DOCK_FOCUS_BACKDROP_BLUR_PX).toBe(0);
    expect(PARKING_CONFIG.DOCK_FOCUS_BACKDROP_ALPHA).toBe(0.82);
    expect(PARKING_CONFIG.DOCK_STAGE_OFFSET_Y_PX).toBe(48);
    expect(PARKING_CONFIG.DOCK_FOCUS_FLIP_DURATION_MS).toBe(340);
    expect(PARKING_CONFIG.DOCK_FOCUS_FLIP_EASING).toBe('cubic-bezier(0.22, 1, 0.36, 1)');
    expect(PARKING_CONFIG.DOCK_FOCUS_FLIP_GHOST_OPACITY).toBe(0.92);
    expect(PARKING_CONFIG.DOCK_FOCUS_FLIP_Z_INDEX).toBe(75);
    expect(PARKING_CONFIG.FOCUS_MOTION_PROFILE).toBe('performance');
    expect(PARKING_CONFIG.FOCUS_ENABLE_RADAR_FLOAT).toBe(false);
    expect(PARKING_CONFIG.FOCUS_ENABLE_STACK_SWIPE_HINT).toBe(false);
    expect(PARKING_CONFIG.FOCUS_ENABLE_STATUS_EXTRA_GLOW).toBe(true);
    expect(PARKING_CONFIG.FOCUS_ENABLE_REST_REMINDER_GLOW).toBe(true);
  });

  it('DOCK_MOBILE_DISMISS_THRESHOLD should be 80px', () => {
    expect(PARKING_CONFIG.DOCK_MOBILE_DISMISS_THRESHOLD).toBe(80);
  });

  it('DOCK park-button sync should default on for parking-dock compatibility bridge', () => {
    expect(PARKING_CONFIG.DOCK_PARK_BUTTON_SYNC_MODE).toBe('on');
  });

  it('DOCK focus content effect should default to dim while keeping blur alias for legacy paths', () => {
    expect(PARKING_CONFIG.DOCK_FOCUS_CONTENT_EFFECT).toBe('dim');
    expect(PARKING_CONFIG.DOCK_FOCUS_TAKEOVER_MODE).toBe('blur');
  });

  it('schedule mismatch thresholds should keep explicit rule-engine bounds', () => {
    expect(PARKING_CONFIG.SCHEDULE_TIGHT_THRESHOLD_MINUTES).toBe(2);
    expect(PARKING_CONFIG.SCHEDULE_CANDIDATE_C_TOO_LONG_RATIO).toBe(1.5);
    expect(PARKING_CONFIG.SCHEDULE_CANDIDATE_C_TOO_SHORT_RATIO).toBe(0.35);
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

  it('HUD minimal constants and first-main override window should stay aligned', () => {
    expect(PARKING_CONFIG.HUD_MINIMAL_TOP_PX).toBe(16);
    expect(PARKING_CONFIG.HUD_MINIMAL_WIDTH_PX).toBe(200);
    expect(PARKING_CONFIG.FIRST_MAIN_OVERRIDE_WINDOW_MS).toBe(15000);
  });
  it('focus scene tokens should match transparent-focus and zen defaults', () => {
    expect(PARKING_CONFIG.FOCUS_SCENE_TRANSPARENT_ALPHA).toBe(0.28);
    expect(PARKING_CONFIG.FOCUS_SCENE_TRANSPARENT_STAGE_ALPHA).toBe(0.72);
    expect(PARKING_CONFIG.FOCUS_SCENE_TRANSPARENT_VIGNETTE_ALPHA).toBe(0.24);
    expect(PARKING_CONFIG.FOCUS_SCENE_ENTRY_BG_MS).toBe(24);
    expect(PARKING_CONFIG.FOCUS_SCENE_ENTRY_STAGE_MS).toBe(56);
    expect(PARKING_CONFIG.FOCUS_SCENE_ENTRY_RADAR_MS).toBe(96);
    expect(PARKING_CONFIG.FOCUS_SCENE_ENTRY_ENV_MS).toBe(132);
    expect(PARKING_CONFIG.FOCUS_SCENE_ENTRY_HUD_MS).toBe(144);
    expect(PARKING_CONFIG.FOCUS_BLANK_PERIOD_BREATHE_DURATION_S).toBe(5.4);
    expect(PARKING_CONFIG.FOCUS_BLANK_PERIOD_DRIFT_DURATION_S).toBe(9.2);
    expect(PARKING_CONFIG.ZEN_MODE_PRIMARY_RGB).toBe('99 102 241');
    expect(PARKING_CONFIG.ZEN_MODE_SECONDARY_RGB).toBe('52 211 153');
    expect(PARKING_CONFIG.ZEN_MODE_BURNOUT_PRIMARY_RGB).toBe('245 158 11');
    expect(PARKING_CONFIG.ZEN_MODE_BURNOUT_SECONDARY_RGB).toBe('248 113 113');
  });

  it('MOTION tokens should keep the parking-dock motion system aligned', () => {
    expect(PARKING_CONFIG.MOTION.easing.enter).toBe('cubic-bezier(0.22, 1, 0.36, 1)');
    expect(PARKING_CONFIG.MOTION.easing.standard).toBe('cubic-bezier(0.2, 0.8, 0.2, 1)');
    expect(PARKING_CONFIG.MOTION.easing.exit).toBe('cubic-bezier(0.4, 0, 0.2, 1)');
    expect(PARKING_CONFIG.MOTION.easing.micro).toBe('cubic-bezier(0.18, 0.75, 0.28, 1)');
    expect(PARKING_CONFIG.MOTION.shell.enterMs).toBe(320);
    expect(PARKING_CONFIG.MOTION.shell.exitMs).toBe(260);
    expect(PARKING_CONFIG.MOTION.overlay.enterMs).toBe(280);
    expect(PARKING_CONFIG.MOTION.overlay.exitMs).toBe(220);
    expect(PARKING_CONFIG.MOTION.panel.enterMs).toBe(220);
    expect(PARKING_CONFIG.MOTION.panel.exitMs).toBe(180);
    expect(PARKING_CONFIG.MOTION.focus.enterMs).toBe(340);
    expect(PARKING_CONFIG.MOTION.focus.exitMs).toBe(280);
    expect(PARKING_CONFIG.MOTION.card.promoteMs).toBe(160);
    expect(PARKING_CONFIG.MOTION.radar.promoteMs).toBe(180);
    expect(PARKING_CONFIG.MOTION.hud.enterMs).toBe(200);
    expect(PARKING_CONFIG.MOTION.notice.enterMs).toBe(200);
    expect(PARKING_CONFIG.MOTION.notice.exitMs).toBe(160);
    expect(PARKING_CONFIG.MOTION.micro.hoverMs).toBe(140);
    expect(PARKING_CONFIG.MOTION.micro.pressMs).toBe(120);
    expect(PARKING_CONFIG.MOTION.distance.cardFlyPx).toBe(84);
    expect(PARKING_CONFIG.MOTION.distance.cardSinkPx).toBe(10);
    expect(PARKING_CONFIG.MOTION.distance.radarFloatPx).toBe(2);
  });
});
