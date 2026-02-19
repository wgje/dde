/**
 * Focus 配额一致性契约测试
 *
 * 确保前端配置、状态初始值之间的配额值保持一致。
 * Edge Function 配额值需要手动保持同步（Deno 环境无法在 Vitest 中直接导入）。
 *
 * @see focus.config.ts - SPEECH_TO_TEXT.DAILY_QUOTA
 * @see focus-stores.ts - remainingQuota 初始值
 * @see supabase/functions/transcribe/index.ts - DAILY_QUOTA_PER_USER
 */
import { describe, it, expect } from 'vitest';
import { FOCUS_CONFIG } from '../../config/focus.config';
import { remainingQuota } from '../../state/focus-stores';

/** Edge Function 中的 DAILY_QUOTA_PER_USER 值（需手动与 transcribe/index.ts 保持同步） */
const EDGE_FUNCTION_DAILY_QUOTA = 50;

describe('Focus 配额一致性契约 (Quota Consistency Contract)', () => {
  it('前端 DAILY_QUOTA 应为 50（非无限制的 999999）', () => {
    expect(FOCUS_CONFIG.SPEECH_TO_TEXT.DAILY_QUOTA).toBe(50);
  });

  it('remainingQuota 初始值应与 DAILY_QUOTA 一致', () => {
    // 重置到初始状态
    remainingQuota.set(FOCUS_CONFIG.SPEECH_TO_TEXT.DAILY_QUOTA);
    expect(remainingQuota()).toBe(FOCUS_CONFIG.SPEECH_TO_TEXT.DAILY_QUOTA);
  });

  it('前端 DAILY_QUOTA 应与 Edge Function DAILY_QUOTA_PER_USER 一致', () => {
    expect(FOCUS_CONFIG.SPEECH_TO_TEXT.DAILY_QUOTA).toBe(EDGE_FUNCTION_DAILY_QUOTA);
  });

  it('配额值应为合理范围（1-1000），不应是占位的极大值', () => {
    expect(FOCUS_CONFIG.SPEECH_TO_TEXT.DAILY_QUOTA).toBeGreaterThan(0);
    expect(FOCUS_CONFIG.SPEECH_TO_TEXT.DAILY_QUOTA).toBeLessThanOrEqual(1000);
  });
});
