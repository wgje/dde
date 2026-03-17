import { describe, expect, it } from 'vitest';
import { PARKING_CONFIG } from '../../../../config/parking.config';
import {
  clampHudPosition,
  defaultHudPosition,
  loadHudPosition,
  persistHudPosition,
  resolveHudSize,
} from './dock-hud-position';
import type { HudPosition, HudSize } from './dock-hud-position';

const STORAGE_KEY = PARKING_CONFIG.FOCUS_HUD_LAYOUT_STORAGE_KEY;

describe('dock-hud-position', () => {
  const fallbackSize: HudSize = { width: 320, height: 400 };

  describe('resolveHudSize', () => {
    it('returns rect dimensions when valid', () => {
      const result = resolveHudSize({ width: 200, height: 300 }, fallbackSize);
      expect(result).toEqual({ width: 200, height: 300 });
    });

    it('rounds fractional dimensions', () => {
      const result = resolveHudSize({ width: 200.7, height: 300.3 }, fallbackSize);
      expect(result).toEqual({ width: 201, height: 300 });
    });

    it('uses fallback when rect is null', () => {
      const result = resolveHudSize(null, fallbackSize);
      expect(result).toEqual(fallbackSize);
    });

    it('uses fallback when rect is undefined', () => {
      const result = resolveHudSize(undefined, fallbackSize);
      expect(result).toEqual(fallbackSize);
    });

    it('clamps zero dimensions to 1', () => {
      const result = resolveHudSize({ width: 0, height: 0 }, fallbackSize);
      expect(result).toEqual({ width: 1, height: 1 });
    });
  });

  describe('clampHudPosition', () => {
    it('returns position within bounds unchanged', () => {
      const pos: HudPosition = { x: 100, y: 100 };
      const size: HudSize = { width: 50, height: 50 };
      const result = clampHudPosition(pos, size);
      expect(result.x).toBe(100);
      expect(result.y).toBe(100);
    });

    it('clamps negative x to minMargin', () => {
      const result = clampHudPosition({ x: -100, y: 100 }, { width: 50, height: 50 });
      expect(result.x).toBe(12);
    });

    it('rounds fractional positions', () => {
      const result = clampHudPosition({ x: 100.7, y: 200.3 }, { width: 50, height: 50 });
      expect(Number.isInteger(result.x)).toBe(true);
      expect(Number.isInteger(result.y)).toBe(true);
    });
  });

  describe('normalizeFlipRect (via clamp behavior)', () => {
    it('clamp applies 12px minimum margin', () => {
      const result = clampHudPosition({ x: 5, y: 5 }, { width: 100, height: 100 });
      expect(result.x).toBeGreaterThanOrEqual(12);
      expect(result.y).toBeGreaterThanOrEqual(12);
    });
  });

  describe('loadHudPosition', () => {
    it('returns null when localStorage has no saved position', () => {
      localStorage.removeItem(STORAGE_KEY);
      const result = loadHudPosition(fallbackSize);
      expect(result).toBeNull();
    });

    it('returns null for corrupted JSON', () => {
      localStorage.setItem(STORAGE_KEY, '{invalid json');
      const result = loadHudPosition(fallbackSize);
      expect(result).toBeNull();
    });

    it('returns null when stored values are non-finite', () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ x: 'abc', y: 100 }));
      const result = loadHudPosition(fallbackSize);
      expect(result).toBeNull();
    });

    it('returns clamped position for valid stored data', () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ x: 100, y: 200 }));
      const result = loadHudPosition(fallbackSize);
      expect(result).not.toBeNull();
      expect(typeof result!.x).toBe('number');
      expect(typeof result!.y).toBe('number');
    });
  });

  describe('persistHudPosition', () => {
    it('does nothing when position is null', () => {
      localStorage.removeItem(STORAGE_KEY);
      persistHudPosition(null);
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it('stores position as JSON', () => {
      persistHudPosition({ x: 42, y: 84 });
      const raw = localStorage.getItem(STORAGE_KEY);
      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw!);
      expect(parsed.x).toBe(42);
      expect(parsed.y).toBe(84);
    });
  });

  describe('defaultHudPosition', () => {
    it('returns a position with valid numeric coordinates', () => {
      const result = defaultHudPosition(fallbackSize);
      expect(typeof result.x).toBe('number');
      expect(typeof result.y).toBe('number');
      expect(Number.isFinite(result.x)).toBe(true);
      expect(Number.isFinite(result.y)).toBe(true);
    });
  });
});
