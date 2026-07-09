import type { DockEntry } from '../models/parking-dock';
import type { SnapshotNormalizeContext } from './dock-snapshot-persistence.service';

export function makeNormalizeContext(
  overrides?: Partial<SnapshotNormalizeContext>,
): SnapshotNormalizeContext {
  return {
    muteWaitTone: false,
    todayDateKey: '2025-01-15',
    buildOverflowMeta: () => ({ comboSelectOverflow: 0, backupOverflow: 0 }),
    ...overrides,
  };
}

export function makeMinimalEntry(
  overrides?: Partial<DockEntry>,
): Record<string, unknown> {
  return {
    taskId: 'task-1',
    title: 'Test task',
    sourceProjectId: 'proj-1',
    status: 'pending_start',
    load: 'low',
    expectedMinutes: 30,
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

export function makeMinimalSnapshot(
  overrides?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    version: 7,
    entries: [],
    focusMode: false,
    isDockExpanded: true,
    muteWaitTone: false,
    session: {
      firstDragIntervened: false,
      focusBlurOn: false,
      focusScrimOn: true,
      mainTaskId: null,
      comboSelectIds: [],
      backupIds: [],
    },
    dailySlots: [],
    suspendChainRootTaskId: null,
    suspendRecommendationLocked: false,
    pendingDecision: null,
    lastRuleDecision: null,
    dailyResetDate: '2025-01-15',
    savedAt: '2025-01-15T10:00:00.000Z',
    ...overrides,
  };
}
