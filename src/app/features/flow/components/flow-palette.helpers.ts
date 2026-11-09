export interface FlowPaletteTodoStats {
  total: number;
  completed: number;
}

export interface FlowPaletteBlackBoxEntryState {
  isCompleted: boolean;
  isArchived?: boolean;
  deletedAt?: string | null;
}

export interface FlowPaletteCompletionBasis {
  total: number;
  completed: number;
}

export function filterActiveFlowPaletteBlackBoxEntries<T extends FlowPaletteBlackBoxEntryState>(
  entries: Iterable<T>,
): T[] {
  return Array.from(entries).filter(entry => !entry.deletedAt && !entry.isArchived);
}

export function calculateFlowPaletteCompletionBasis(
  todoStats: FlowPaletteTodoStats,
  blackBoxEntries: readonly FlowPaletteBlackBoxEntryState[],
): FlowPaletteCompletionBasis {
  const completedBlackBoxCount = blackBoxEntries.filter(entry => entry.isCompleted).length;

  return {
    total: todoStats.total + blackBoxEntries.length,
    completed: todoStats.completed + completedBlackBoxCount,
  };
}

export function calculateFlowPalettePercent(value: number, total: number): number {
  if (total <= 0) {
    return 0;
  }

  return Math.min(100, Math.max(0, Math.round((value / total) * 100)));
}
