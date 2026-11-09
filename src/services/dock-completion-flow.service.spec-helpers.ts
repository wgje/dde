import { signal } from '@angular/core';
import { vi } from 'vitest';

import type { DockCompletionContext } from './dock-completion-flow.types';
import { TimerHandle } from '../utils/timer-handle';
import type {
  DockEntry,
  DockPendingDecision,
  DockRuleDecision,
  DockSchedulerPhase,
  FragmentDefenseLevel,
  RecommendationGroup,
} from '../models/parking-dock';

export function makeDockCompletionEntry(
  overrides: Partial<DockEntry> & { taskId: string },
): DockEntry {
  return {
    title: overrides.taskId,
    sourceProjectId: null,
    status: 'pending_start',
    load: 'low',
    expectedMinutes: 25,
    waitMinutes: null,
    waitStartedAt: null,
    lane: 'combo-select',
    zoneSource: 'auto',
    isMain: false,
    dockedOrder: 0,
    detail: '',
    sourceKind: 'project-task',
    systemSelected: false,
    recommendedScore: null,
    ...overrides,
  };
}

export const mockDockCompletionZoneService = {
  resolveSourceProjectId: vi.fn((entry: DockEntry) => entry.sourceProjectId),
};

export const mockDockCompletionFragmentRest = {
  startFragmentEntryCountdown: vi.fn(),
  stopFragmentEntryCountdown: vi.fn(),
  setFragmentDismissed: vi.fn(),
  getFragmentEventRecommendation: vi.fn(),
};

export function buildDockCompletionContext(initial: {
  entries?: DockEntry[];
  focusingEntry?: DockEntry | null;
  focusMode?: boolean;
  suspendChainRootTaskId?: string | null;
}): DockCompletionContext {
  const entries = signal<DockEntry[]>(initial.entries ?? []);
  return {
    entries,
    pendingDecision: signal<DockPendingDecision | null>(null),
    highlightedIds: signal<Set<string>>(new Set()),
    lastRuleDecision: signal<DockRuleDecision | null>(null),
    lastRecommendationGroups: signal<RecommendationGroup[]>([]),
    schedulerPhase: signal<DockSchedulerPhase>('active'),
    fragmentDefenseLevel: signal<FragmentDefenseLevel>(1),
    lastConsoleDemotedTaskId: signal<string | null>(null),
    consoleVisibleOrderHint: signal<string[]>([]),
    consoleVisibleEntries: signal<DockEntry[]>(initial.entries ?? []),
    focusingEntry: signal<DockEntry | null>(initial.focusingEntry ?? null),
    focusMode: signal(initial.focusMode ?? false),
    suspendChainRootTaskId: signal<string | null>(initial.suspendChainRootTaskId ?? null),
    highlightClearTimer: new TimerHandle(),
  };
}
