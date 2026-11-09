import type { Signal, WritableSignal } from '@angular/core';

import type {
  DockEntry,
  DockPendingDecision,
  DockRuleDecision,
  DockSchedulerPhase,
  FragmentDefenseLevel,
  RecommendationGroup,
} from '../models/parking-dock';
import type { TimerHandle } from '../utils/timer-handle';

export interface DockCompletionContext {
  entries: WritableSignal<DockEntry[]>;
  pendingDecision: WritableSignal<DockPendingDecision | null>;
  highlightedIds: WritableSignal<Set<string>>;
  lastRuleDecision: WritableSignal<DockRuleDecision | null>;
  lastRecommendationGroups: WritableSignal<RecommendationGroup[]>;
  schedulerPhase: WritableSignal<DockSchedulerPhase>;
  fragmentDefenseLevel: WritableSignal<FragmentDefenseLevel>;
  lastConsoleDemotedTaskId: WritableSignal<string | null>;
  consoleVisibleOrderHint: Signal<string[]>;
  consoleVisibleEntries: Signal<DockEntry[]>;
  focusingEntry: Signal<DockEntry | null>;
  focusMode: Signal<boolean>;
  suspendChainRootTaskId: Signal<string | null>;
  highlightClearTimer: TimerHandle;
}
