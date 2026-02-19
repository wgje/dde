/**
 * 配置一致性契约测试
 *
 * 确保 FOCUS_CONFIG 是配置的单一事实来源，
 * DEFAULT_FOCUS_PREFERENCES 等衍生值不存在硬编码漂移。
 *
 * @see focus.config.ts - FOCUS_CONFIG.GATE.MAX_SNOOZE_PER_DAY
 * @see focus.ts - DEFAULT_FOCUS_PREFERENCES.maxSnoozePerDay
 */
import { describe, it, expect } from 'vitest';
import { FOCUS_CONFIG } from '../../config/focus.config';
import { DEFAULT_FOCUS_PREFERENCES } from '../../models/focus';

describe('配置一致性契约 (Config Consistency Contract)', () => {
  it('DEFAULT_FOCUS_PREFERENCES.maxSnoozePerDay 应与 FOCUS_CONFIG.GATE.MAX_SNOOZE_PER_DAY 一致', () => {
    expect(DEFAULT_FOCUS_PREFERENCES.maxSnoozePerDay).toBe(FOCUS_CONFIG.GATE.MAX_SNOOZE_PER_DAY);
  });

  it('FOCUS_CONFIG.GATE.MAX_SNOOZE_PER_DAY 应为正整数', () => {
    expect(FOCUS_CONFIG.GATE.MAX_SNOOZE_PER_DAY).toBeGreaterThan(0);
    expect(Number.isInteger(FOCUS_CONFIG.GATE.MAX_SNOOZE_PER_DAY)).toBe(true);
  });
});
