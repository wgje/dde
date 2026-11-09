import { describe, expect, it } from 'vitest';

import {
  calculateFlowPaletteCompletionBasis,
  calculateFlowPalettePercent,
  filterActiveFlowPaletteBlackBoxEntries,
} from './flow-palette.helpers';

describe('flow-palette.helpers', () => {
  it('filters archived and deleted black box entries before completion math', () => {
    const entries = [
      { id: 'open-complete', isCompleted: true, isArchived: false, deletedAt: null },
      { id: 'open-pending', isCompleted: false, isArchived: false, deletedAt: null },
      { id: 'archived', isCompleted: false, isArchived: true, deletedAt: null },
      { id: 'deleted', isCompleted: true, isArchived: false, deletedAt: '2026-06-13T00:00:00Z' },
    ];

    const activeEntries = filterActiveFlowPaletteBlackBoxEntries(entries);

    expect(activeEntries.map(entry => entry.id)).toEqual(['open-complete', 'open-pending']);
    expect(calculateFlowPaletteCompletionBasis(
      { total: 4, completed: 1 },
      activeEntries,
    )).toEqual({ total: 6, completed: 2 });
  });

  it('rounds completion percent and clamps invalid totals', () => {
    expect(calculateFlowPalettePercent(3, 7)).toBe(43);
    expect(calculateFlowPalettePercent(9, 7)).toBe(100);
    expect(calculateFlowPalettePercent(3, 0)).toBe(0);
  });
});
