import { describe, expect, it } from 'vitest';
import { nowISO } from './date';

describe('date — nowISO', () => {
  it('返回合法的 ISO 8601 UTC 字符串', () => {
    const iso = nowISO();
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Number.isFinite(Date.parse(iso))).toBe(true);
  });

  it('连续调用产生单调递增（严格大于）的时间戳', () => {
    const a = Date.parse(nowISO());
    const b = Date.parse(nowISO());
    const c = Date.parse(nowISO());
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });

  it('快速循环调用不会产生重复时间戳（Monotonic Wall Clock 保证）', () => {
    const samples = Array.from({ length: 50 }, () => nowISO());
    const unique = new Set(samples);
    expect(unique.size).toBe(samples.length);
  });

  it('时间戳与真实时钟接近（漂移在合理范围内）', () => {
    const before = Date.now();
    const iso = nowISO();
    const after = Date.now();
    const parsed = Date.parse(iso);
    // 由于 monotonic clock 的 +1ms 策略，允许少量向未来漂移
    expect(parsed).toBeGreaterThanOrEqual(before);
    // 但不应远超真实时间（允许测试抖动 + 过往累积漂移上限 1 秒）
    expect(parsed - after).toBeLessThan(1000);
  });
});
