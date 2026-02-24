/**
 * PARKING_CONFIG 配置常量契约测试
 * 策划案 A9 配置基线
 */

import { describe, it, expect } from 'vitest';
import { PARKING_CONFIG } from '../../config/parking.config';

describe('PARKING_CONFIG 契约测试', () => {
  it('PARKED_TASK_STALE_THRESHOLD 应为 72 小时', () => {
    expect(PARKING_CONFIG.PARKED_TASK_STALE_THRESHOLD).toBe(72 * 60 * 60 * 1000);
  });

  it('PARKED_TASK_STALE_WARNING 应为 64 小时', () => {
    expect(PARKING_CONFIG.PARKED_TASK_STALE_WARNING).toBe(64 * 60 * 60 * 1000);
  });

  it('PARKED_TASK_SOFT_LIMIT 应为 10', () => {
    expect(PARKING_CONFIG.PARKED_TASK_SOFT_LIMIT).toBe(10);
  });

  it('NOTICE_MIN_VISIBLE_MS 应为 2500', () => {
    expect(PARKING_CONFIG.NOTICE_MIN_VISIBLE_MS).toBe(2500);
  });

  it('NOTICE_FALLBACK_TIMEOUT_MS 应为 15000', () => {
    expect(PARKING_CONFIG.NOTICE_FALLBACK_TIMEOUT_MS).toBe(15000);
  });

  it('SNOOZE_PRESETS 应包含 4 个预设', () => {
    expect(PARKING_CONFIG.SNOOZE_PRESETS.QUICK).toBe(5 * 60 * 1000);
    expect(PARKING_CONFIG.SNOOZE_PRESETS.NORMAL).toBe(30 * 60 * 1000);
    expect(PARKING_CONFIG.SNOOZE_PRESETS.TWO_HOURS_LATER).toBe(2 * 60 * 60 * 1000);
    expect(PARKING_CONFIG.SNOOZE_PRESETS.TOMORROW_SAME_TIME).toBe(24 * 60 * 60 * 1000);
  });

  it('MAX_SNOOZE_COUNT 软上限应为 5', () => {
    expect(PARKING_CONFIG.MAX_SNOOZE_COUNT).toBe(5);
  });

  it('MIN_TOUCH_TARGET 应 >= 44px（WCAG 2.1）', () => {
    expect(PARKING_CONFIG.MIN_TOUCH_TARGET).toBeGreaterThanOrEqual(44);
  });

  it('REMOVE_UNDO_TIMEOUT_MS 应为 5000', () => {
    expect(PARKING_CONFIG.REMOVE_UNDO_TIMEOUT_MS).toBe(5000);
  });

  it('EVICTION_UNDO_TIMEOUT_MS 应为 8000', () => {
    expect(PARKING_CONFIG.EVICTION_UNDO_TIMEOUT_MS).toBe(8000);
  });

  it('DOCK_EXPANDED_MAX_WIDTH 应为 720', () => {
    expect(PARKING_CONFIG.DOCK_EXPANDED_MAX_WIDTH).toBe(720);
  });

  it('DOCK_LIST_RATIO 应为 0.4（40% 列表列）', () => {
    expect(PARKING_CONFIG.DOCK_LIST_RATIO).toBe(0.4);
  });

  it('DOCK_MOBILE_DISMISS_THRESHOLD 应为 80px', () => {
    expect(PARKING_CONFIG.DOCK_MOBILE_DISMISS_THRESHOLD).toBe(80);
  });

  it('REMINDER_BADGE_THRESHOLD 应为 2', () => {
    expect(PARKING_CONFIG.REMINDER_BADGE_THRESHOLD).toBe(2);
  });

  it('BEFORE_UNLOAD_PRIORITY 应为 5', () => {
    expect(PARKING_CONFIG.BEFORE_UNLOAD_PRIORITY).toBe(5);
  });

  it('SNAPSHOT_DRAFT_KEY 应为 parking-snapshot-draft', () => {
    expect(PARKING_CONFIG.SNAPSHOT_DRAFT_KEY).toBe('parking-snapshot-draft');
  });
});
