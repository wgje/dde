import { describe, expect, it } from 'vitest';
import {
  normalizeFlipRect,
  toFlipRect,
  createFlipGhostState,
} from './dock-flip-transition';
import type { DockFlipRect, DockFocusTransitionState } from '../../../../models/parking-dock';

describe('dock-flip-transition', () => {
  describe('normalizeFlipRect', () => {
    it('returns null for null input', () => {
      expect(normalizeFlipRect(null)).toBeNull();
    });

    it('returns null for undefined input', () => {
      expect(normalizeFlipRect(undefined)).toBeNull();
    });

    it('returns null when width is zero', () => {
      expect(normalizeFlipRect({ left: 0, top: 0, width: 0, height: 100 })).toBeNull();
    });

    it('returns null when height is negative', () => {
      expect(normalizeFlipRect({ left: 0, top: 0, width: 100, height: -10 })).toBeNull();
    });

    it('returns null when values contain NaN', () => {
      expect(normalizeFlipRect({ left: NaN, top: 0, width: 100, height: 100 })).toBeNull();
    });

    it('returns null when values contain Infinity', () => {
      expect(normalizeFlipRect({ left: 0, top: Infinity, width: 100, height: 100 })).toBeNull();
    });

    it('returns normalized rect for valid input', () => {
      const result = normalizeFlipRect({ left: 10, top: 20, width: 300, height: 200 });
      expect(result).toEqual({ left: 10, top: 20, width: 300, height: 200 });
    });

    it('coerces string-like numbers via Number()', () => {
      const result = normalizeFlipRect({
        left: '10' as unknown as number,
        top: '20' as unknown as number,
        width: '300' as unknown as number,
        height: '200' as unknown as number,
      });
      expect(result).toEqual({ left: 10, top: 20, width: 300, height: 200 });
    });
  });

  describe('toFlipRect', () => {
    it('rounds DOMRect values to integers', () => {
      const domRect = {
        left: 10.7,
        top: 20.3,
        width: 300.9,
        height: 200.1,
        x: 10.7,
        y: 20.3,
        right: 311.6,
        bottom: 220.4,
        toJSON: () => ({}),
      } as DOMRect;
      const result = toFlipRect(domRect);
      expect(result).toEqual({ left: 11, top: 20, width: 301, height: 200 });
    });
  });

  describe('createFlipGhostState', () => {
    it('returns null when fromRect is invalid', () => {
      const transition: DockFocusTransitionState = {
        phase: 'entering',
        direction: 'enter',
        fromRect: { left: 0, top: 0, width: 0, height: 0 },
        toRect: { left: 100, top: 100, width: 300, height: 200 },
        durationMs: 400,
        startedAt: new Date().toISOString(),
      };
      expect(createFlipGhostState(transition)).toBeNull();
    });

    it('returns null when toRect is invalid', () => {
      const transition: DockFocusTransitionState = {
        phase: 'entering',
        direction: 'enter',
        fromRect: { left: 10, top: 20, width: 300, height: 200 },
        toRect: { left: NaN, top: 0, width: 100, height: 100 },
        durationMs: 400,
        startedAt: new Date().toISOString(),
      };
      expect(createFlipGhostState(transition)).toBeNull();
    });

    it('returns ghost state for valid enter transition', () => {
      const transition: DockFocusTransitionState = {
        phase: 'entering',
        direction: 'enter',
        fromRect: { left: 10, top: 20, width: 300, height: 200 },
        toRect: { left: 100, top: 50, width: 400, height: 300 },
        durationMs: 400,
        startedAt: new Date().toISOString(),
      };
      const result = createFlipGhostState(transition);
      expect(result).not.toBeNull();
      expect(result!.direction).toBe('enter');
      expect(result!.from).toEqual({ left: 10, top: 20, width: 300, height: 200 });
      expect(result!.to).toEqual({ left: 100, top: 50, width: 400, height: 300 });
    });

    it('returns ghost state with exit direction', () => {
      const transition: DockFocusTransitionState = {
        phase: 'exiting',
        direction: 'exit',
        fromRect: { left: 100, top: 50, width: 400, height: 300 },
        toRect: { left: 10, top: 20, width: 300, height: 200 },
        durationMs: 300,
        startedAt: new Date().toISOString(),
      };
      const result = createFlipGhostState(transition);
      expect(result).not.toBeNull();
      expect(result!.direction).toBe('exit');
    });
  });
});
