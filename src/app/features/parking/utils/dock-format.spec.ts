import { describe, expect, it } from 'vitest';
import { formatDockMinutes, parseOptionalMinutes } from './dock-format';

describe('formatDockMinutes', () => {
  // --- minutes only (< 60) ---
  it('should format 0 minutes as "0m"', () => {
    expect(formatDockMinutes(0)).toBe('0m');
  });

  it('should format 1 minute as "1m"', () => {
    expect(formatDockMinutes(1)).toBe('1m');
  });

  it('should format 59 minutes as "59m"', () => {
    expect(formatDockMinutes(59)).toBe('59m');
  });

  // --- hours range (60 ≤ m < 1440) ---
  it('should format exactly 60 minutes as "1h"', () => {
    expect(formatDockMinutes(60)).toBe('1h');
  });

  it('should format 90 minutes as "1h30m"', () => {
    expect(formatDockMinutes(90)).toBe('1h30m');
  });

  it('should format 120 minutes as "2h"', () => {
    expect(formatDockMinutes(120)).toBe('2h');
  });

  it('should format 1439 minutes as "23h59m"', () => {
    expect(formatDockMinutes(1439)).toBe('23h59m');
  });

  // --- days range (≥ 1440) ---
  it('should format exactly 1440 minutes as "1d"', () => {
    expect(formatDockMinutes(1440)).toBe('1d');
  });

  it('should format 1500 minutes as "1d1h"', () => {
    expect(formatDockMinutes(1500)).toBe('1d1h');
  });

  it('should format 2880 minutes as "2d"', () => {
    expect(formatDockMinutes(2880)).toBe('2d');
  });

  it('should format 4320 minutes (3 days) as "3d"', () => {
    expect(formatDockMinutes(4320)).toBe('3d');
  });

  it('should drop remaining minutes within the hour for days range', () => {
    // 1 day + 2h30m → remainH = floor(150/60) = 2 → "1d2h"
    expect(formatDockMinutes(1440 + 150)).toBe('1d2h');
  });

  it('should floor partial hours in days range', () => {
    // 1 day + 89 min → remainH = floor(89/60) = 1 → "1d1h"
    expect(formatDockMinutes(1440 + 89)).toBe('1d1h');
  });
});

describe('parseOptionalMinutes', () => {
  // --- null / undefined ---
  it('should return null for null input', () => {
    expect(parseOptionalMinutes(null)).toBeNull();
  });

  it('should return null for undefined input', () => {
    expect(parseOptionalMinutes(undefined)).toBeNull();
  });

  // --- empty / whitespace strings ---
  it('should return null for empty string', () => {
    expect(parseOptionalMinutes('')).toBeNull();
  });

  it('should return null for whitespace-only string', () => {
    expect(parseOptionalMinutes('   ')).toBeNull();
  });

  // --- non-finite values ---
  it('should return null for NaN string', () => {
    expect(parseOptionalMinutes('abc')).toBeNull();
  });

  it('should return null for NaN number', () => {
    expect(parseOptionalMinutes(NaN)).toBeNull();
  });

  it('should return null for Infinity', () => {
    expect(parseOptionalMinutes(Infinity)).toBeNull();
  });

  it('should return null for -Infinity', () => {
    expect(parseOptionalMinutes(-Infinity)).toBeNull();
  });

  // --- zero and negative ---
  it('should return null for 0', () => {
    expect(parseOptionalMinutes(0)).toBeNull();
  });

  it('should return null for "0"', () => {
    expect(parseOptionalMinutes('0')).toBeNull();
  });

  it('should return null for negative number', () => {
    expect(parseOptionalMinutes(-5)).toBeNull();
  });

  it('should return null for negative string', () => {
    expect(parseOptionalMinutes('-10')).toBeNull();
  });

  // --- valid numbers ---
  it('should parse a positive integer number', () => {
    expect(parseOptionalMinutes(42)).toBe(42);
  });

  it('should floor a positive float number', () => {
    expect(parseOptionalMinutes(10.9)).toBe(10);
  });

  it('should parse a positive integer string', () => {
    expect(parseOptionalMinutes('30')).toBe(30);
  });

  it('should floor a positive float string', () => {
    expect(parseOptionalMinutes('7.8')).toBe(7);
  });

  it('should trim surrounding whitespace in string', () => {
    expect(parseOptionalMinutes('  15  ')).toBe(15);
  });

  it('should handle 1 as the smallest valid value', () => {
    expect(parseOptionalMinutes(1)).toBe(1);
  });

  it('should handle 0.5 by flooring to 0 which is <= 0, returning null', () => {
    // parsed = 0.5 > 0 → floor(0.5) = 0 → 0 无效 → null
    expect(parseOptionalMinutes(0.5)).toBeNull();
  });
});
