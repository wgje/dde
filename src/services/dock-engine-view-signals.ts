import { computed, type Signal } from '@angular/core';

import { PARKING_CONFIG } from '../config/parking.config';
import {
  DailySlotEntry,
  DockEntry,
  DockFocusTransitionState,
  DockPendingDecision,
  DockPendingDecisionEntry,
  StatusMachineEntry,
} from '../models/parking-dock';
import {
  resolveDockFocusChromePhase,
  type DockFocusChromePhase,
} from '../utils/dock-focus-phase';
import {
  isWaitingLike,
  type SchedulerCandidate,
  sortDockEntriesForDisplay,
  toStatusMachineEntry,
} from './dock-engine.utils';

interface DockEngineViewSignalsOptions {
  entries: Signal<DockEntry[]>;
  firstMainSelectionWindow: Signal<{ taskId: string; expiresAt: number } | null>;
  focusTransition: Signal<DockFocusTransitionState | null>;
  focusMode: Signal<boolean>;
  focusScrimOn: Signal<boolean>;
  focusChromeRestoring: Signal<boolean>;
  pendingRadarEviction: Signal<string | null>;
  pendingDecision: Signal<DockPendingDecision | null>;
  burnoutTriggeredAt: Signal<number | null>;
  fragmentEntryCountdown: Signal<number | null>;
  dailySlots: Signal<DailySlotEntry[]>;
  tick: Signal<number>;
  completionFlow: {
    toSchedulerCandidate(entry: DockEntry): SchedulerCandidate;
    sortConsoleEntriesForDisplay(entries: DockEntry[]): DockEntry[];
  };
  zoneService: {
    resolveSourceProjectId(entry: DockEntry): string | null;
  };
  fragmentRest: {
    isFragmentDismissed(): boolean;
  };
}

export function createDockEngineViewSignals(options: DockEngineViewSignalsOptions) {
  const dock = createDockMembershipSignals(options);
  const focusChrome = createFocusChromeSignals(options);
  const console = createConsoleSignals(options);
  const radarZones = createRadarZoneSignals(options, console.consoleVisibleEntries);
  const pendingDecisionEntries = createPendingDecisionEntries(options);
  const fragment = createFragmentSignals(options, dock.dockedEntries, pendingDecisionEntries);
  const statusMachineEntries = createStatusMachineEntries(options);

  return {
    ...dock,
    ...focusChrome,
    ...console,
    ...radarZones,
    ...fragment,
    statusMachineEntries,
    pendingDecisionEntries,
  };
}

function createDockMembershipSignals(options: DockEngineViewSignalsOptions) {
  const dockedEntries = computed(() =>
    options.entries().filter(entry => entry.status !== 'completed'),
  );
  const orderedDockEntries = computed(() => sortDockEntriesForDisplay(
    dockedEntries(),
    (entry) => options.completionFlow.toSchedulerCandidate(entry),
    (entry) => options.zoneService.resolveSourceProjectId(entry),
  ));
  const dockedCount = computed(() => dockedEntries().length);
  const dockedTaskIds = computed(() => new Set(dockedEntries().map(entry => entry.taskId)));
  const dockCapacity = computed(() => {
    const count = dockedCount();
    const softLimit = PARKING_CONFIG.DOCK_CONSOLE_SOFT_LIMIT;
    const hardLimit = PARKING_CONFIG.DOCK_CONSOLE_HARD_LIMIT;
    return {
      count,
      softLimit,
      hardLimit,
      softReached: count >= softLimit,
      hardReached: count >= hardLimit,
    };
  });
  const firstMainSelectionPending = computed(() => options.firstMainSelectionWindow());

  return {
    dockedEntries,
    orderedDockEntries,
    dockedCount,
    dockedTaskIds,
    dockCapacity,
    firstMainSelectionPending,
  };
}

function createFocusChromeSignals(options: DockEngineViewSignalsOptions) {
  const isFocusTransitionBlocking = computed(() => {
    const phase = options.focusTransition()?.phase ?? null;
    return phase === 'entering' || phase === 'exiting';
  });
  const focusChromePhase = computed<DockFocusChromePhase>(() =>
    resolveDockFocusChromePhase(
      options.focusMode(),
      options.focusTransition(),
      options.focusScrimOn(),
      options.focusChromeRestoring(),
    ),
  );

  return {
    isFocusTransitionBlocking,
    focusChromePhase,
  };
}

function createConsoleSignals(options: DockEngineViewSignalsOptions) {
  const consoleEntries = computed(() =>
    options.entries().filter(
      entry =>
        entry.status !== 'completed' &&
        (
          entry.isMain
          || entry.lane === 'combo-select'
          || entry.status === 'focusing'
        ),
    ),
  );
  const consoleVisibleEntries = computed(() => {
    const pendingEvictionTaskId = options.pendingRadarEviction();
    const visibleCandidates = pendingEvictionTaskId
      ? consoleEntries().filter(entry => entry.taskId !== pendingEvictionTaskId)
      : consoleEntries();
    return options.completionFlow
      .sortConsoleEntriesForDisplay(visibleCandidates)
      .slice(0, PARKING_CONFIG.CONSOLE_STACK_VISIBLE_MAX);
  });
  const focusingEntry = computed(() =>
    options.entries().find(entry => entry.status === 'focusing') ?? null,
  );
  const suspendedEntries = computed(() =>
    consoleVisibleEntries().filter(entry => isWaitingLike(entry.status)),
  );

  return {
    consoleEntries,
    consoleVisibleEntries,
    focusingEntry,
    suspendedEntries,
  };
}

function createRadarZoneSignals(
  options: DockEngineViewSignalsOptions,
  consoleVisibleEntries: Signal<DockEntry[]>,
) {
  const comboSelectEntries = computed(() => {
    const visibleTaskIds = new Set(consoleVisibleEntries().map(entry => entry.taskId));
    return options.entries().filter(
      entry =>
        !entry.isMain &&
        entry.lane === 'combo-select' &&
        entry.status !== 'completed' &&
        !visibleTaskIds.has(entry.taskId),
    );
  });
  const backupEntries = computed(() => {
    const visibleTaskIds = new Set(consoleVisibleEntries().map(entry => entry.taskId));
    return options.entries().filter(
      entry =>
        !entry.isMain &&
        entry.lane === 'backup' &&
        entry.status !== 'completed' &&
        !visibleTaskIds.has(entry.taskId),
    );
  });

  return {
    comboSelectEntries,
    backupEntries,
  };
}

function createPendingDecisionEntries(options: DockEngineViewSignalsOptions) {
  return computed<DockPendingDecisionEntry[]>(() => {
    const pending = options.pendingDecision();
    if (!pending) return [];

    const entryMap = new Map(options.entries().map(entry => [entry.taskId, entry]));
    const flattened = pending.candidateGroups.flatMap(group =>
      group.taskIds.map(taskId => ({ taskId, group: group.type })),
    );
    return flattened
      .map(item => {
        const entry = entryMap.get(item.taskId);
        if (!entry) return null;
        return {
          taskId: entry.taskId,
          title: entry.title,
          group: item.group,
          lane: entry.lane,
          load: entry.load,
          expectedMinutes: entry.expectedMinutes,
          recommendedScore: entry.recommendedScore,
        } satisfies DockPendingDecisionEntry;
      })
      .filter((entry): entry is DockPendingDecisionEntry => !!entry);
  });
}

function createFragmentSignals(
  options: DockEngineViewSignalsOptions,
  dockedEntries: Signal<DockEntry[]>,
  pendingDecisionEntries: Signal<DockPendingDecisionEntry[]>,
) {
  const isBurnoutActive = computed(() => options.burnoutTriggeredAt() !== null);
  const blankPeriodActive = computed(
    () =>
      options.fragmentEntryCountdown() === null
      && options.pendingDecision() !== null
      && pendingDecisionEntries().length === 0,
  );
  const isFragmentPhase = computed(() => {
    const docked = dockedEntries();
    return (
      options.fragmentEntryCountdown() === null
      && docked.length > 0
      && docked.every(entry => isWaitingLike(entry.status))
      && !options.fragmentRest.isFragmentDismissed()
    );
  });
  const availableDailySlots = computed(() =>
    options.dailySlots().filter(slot => slot.isEnabled && slot.todayCompletedCount < slot.maxDailyCount),
  );
  const availableFragmentDockTasks = computed(() =>
    options.entries().filter(
      entry =>
        entry.status !== 'completed' &&
        entry.status !== 'focusing' &&
        !isWaitingLike(entry.status),
    ),
  );

  return {
    isBurnoutActive,
    blankPeriodActive,
    isFragmentPhase,
    availableDailySlots,
    availableFragmentDockTasks,
  };
}

function createStatusMachineEntries(options: DockEngineViewSignalsOptions) {
  return computed<StatusMachineEntry[]>(() => {
    options.tick();
    const pendingEvictionTaskId = options.pendingRadarEviction();
    const visibleStatusCandidates = options.entries()
      .filter(
        entry =>
          entry.taskId !== pendingEvictionTaskId &&
          entry.status !== 'completed' &&
          (
            entry.isMain ||
            entry.status === 'focusing' ||
            entry.status === 'suspended_waiting' ||
            entry.status === 'wait_finished' ||
            entry.status === 'stalled'
          ),
      );
    return options.completionFlow
      .sortConsoleEntriesForDisplay(visibleStatusCandidates)
      .slice(0, PARKING_CONFIG.STATUS_MACHINE_VISIBLE_LIMIT)
      .map(entry => toStatusMachineEntry(entry));
  });
}
