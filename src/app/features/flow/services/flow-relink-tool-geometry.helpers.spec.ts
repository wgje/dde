import { describe, expect, it } from 'vitest';

import {
  computeRelinkPortGravity,
  distanceToBoundsSquared,
  expandBounds,
  isPointInsideBounds,
} from './flow-relink-tool-geometry.helpers';

describe('flow relink tool geometry helpers', () => {
  const bounds = { x: 10, y: 20, right: 30, bottom: 50 };

  it('expands node bounds by the configured pointer tolerance', () => {
    expect(expandBounds(bounds, 4)).toEqual({
      x: 6,
      y: 16,
      right: 34,
      bottom: 54,
    });
  });

  it('detects whether a pointer is inside inclusive bounds', () => {
    expect(isPointInsideBounds({ x: 10, y: 20 }, bounds)).toBe(true);
    expect(isPointInsideBounds({ x: 30, y: 50 }, bounds)).toBe(true);
    expect(isPointInsideBounds({ x: 31, y: 50 }, bounds)).toBe(false);
  });

  it('computes squared distance to the nearest edge when the pointer is outside', () => {
    expect(distanceToBoundsSquared({ x: 5, y: 10 }, bounds)).toBe(125);
    expect(distanceToBoundsSquared({ x: 15, y: 25 }, bounds)).toBe(0);
  });

  it('keeps port gravity at least four pixels and otherwise doubles pointer tolerance', () => {
    expect(computeRelinkPortGravity(1)).toBe(4);
    expect(computeRelinkPortGravity(6)).toBe(12);
  });
});
