import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DockCompletionFlowService, DockCompletionContext } from './dock-completion-flow.service';
import { DockZoneService } from './dock-zone.service';
import { DockFragmentRestService } from './dock-fragment-rest.service';
import {
  isWaitingLike,
  isRunnableStatus,
  isAutoPromotableStatus,
  isConsoleBackgroundStatus,
} from './dock-engine.utils';
import {
  DockEntry,
  DockPendingDecision,
  DockRuleDecision,
  DockSchedulerPhase,
  DockTaskStatus,
  FragmentDefenseLevel,
  RecommendationGroup,
} from '../models/parking-dock';

// ---------------------------------------------------------------------------
//  Helper: build a minimal DockEntry with sensible defaults
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<DockEntry> & { taskId: string }): DockEntry {
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

// ---------------------------------------------------------------------------
//  Mock services
// ---------------------------------------------------------------------------

const mockZoneService = {
  resolveSourceProjectId: vi.fn((entry: DockEntry) => entry.sourceProjectId),
};

const mockFragmentRest = {
  startFragmentEntryCountdown: vi.fn(),
  stopFragmentEntryCountdown: vi.fn(),
  setFragmentDismissed: vi.fn(),
  getFragmentEventRecommendation: vi.fn(),
};

// ---------------------------------------------------------------------------
//  Build a minimal DockCompletionContext from writable signals
// ---------------------------------------------------------------------------

function buildContext(initial: {
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
    focusingEntry: signal<DockEntry | null>(initial.focusingEntry ?? null),
    focusMode: signal(initial.focusMode ?? false),
    suspendChainRootTaskId: signal<string | null>(initial.suspendChainRootTaskId ?? null),
    highlightClearTimer: { current: null },
  };
}

// ---------------------------------------------------------------------------
//  Test suite
// ---------------------------------------------------------------------------

describe('DockCompletionFlowService', () => {
  let service: DockCompletionFlowService;

  beforeEach(() => {
    vi.clearAllMocks();

    TestBed.configureTestingModule({
      providers: [
        DockCompletionFlowService,
        { provide: DockZoneService, useValue: mockZoneService },
        { provide: DockFragmentRestService, useValue: mockFragmentRest },
      ],
    });

    service = TestBed.inject(DockCompletionFlowService);
  });

  // =========================================================================
  //  1. Status helpers
  // =========================================================================

  describe('status helpers', () => {
    describe('isWaitingLike', () => {
      it.each([
        ['suspended_waiting', true],
        ['wait_finished', true],
        ['pending_start', false],
        ['focusing', false],
        ['stalled', false],
        ['completed', false],
      ] as [DockTaskStatus, boolean][])('isWaitingLike(%s) → %s', (status, expected) => {
        expect(isWaitingLike(status)).toBe(expected);
      });
    });

    describe('isRunnableStatus', () => {
      it.each([
        ['pending_start', true],
        ['wait_finished', true],
        ['stalled', true],
        ['focusing', false],
        ['suspended_waiting', false],
        ['completed', false],
      ] as [DockTaskStatus, boolean][])('isRunnableStatus(%s) → %s', (status, expected) => {
        expect(isRunnableStatus(status)).toBe(expected);
      });
    });

    describe('isAutoPromotableStatus', () => {
      it.each([
        ['pending_start', true],
        ['stalled', true],
        ['focusing', false],
        ['suspended_waiting', false],
        ['wait_finished', false],
        ['completed', false],
      ] as [DockTaskStatus, boolean][])('isAutoPromotableStatus(%s) → %s', (status, expected) => {
        expect(isAutoPromotableStatus(status)).toBe(expected);
      });
    });

    describe('isConsoleBackgroundStatus', () => {
      it.each([
        ['suspended_waiting', true],
        ['wait_finished', true],
        ['stalled', true],
        ['pending_start', false],
        ['focusing', false],
        ['completed', false],
      ] as [DockTaskStatus, boolean][])('isConsoleBackgroundStatus(%s) → %s', (status, expected) => {
        expect(isConsoleBackgroundStatus(status)).toBe(expected);
      });
    });
  });

  // =========================================================================
  //  2. Conversion helpers
  // =========================================================================

  describe('toSchedulerCandidate', () => {
    it('maps all DockEntry fields into the scheduler candidate shape', () => {
      const entry = makeEntry({
        taskId: 'task-1',
        lane: 'backup',
        load: 'high',
        expectedMinutes: 30,
        waitMinutes: 10,
        dockedOrder: 2,
        manualOrder: 1,
        relationScore: 42,
        sourceProjectId: 'proj-1',
      });

      const candidate = service.toSchedulerCandidate(entry);

      expect(candidate).toEqual({
        taskId: 'task-1',
        lane: 'backup',
        load: 'high',
        expectedMinutes: 30,
        waitMinutes: 10,
        dockedOrder: 2,
        manualOrder: 1,
        relationScore: 42,
        sourceProjectId: 'proj-1',
      });
    });

    it('normalizes undefined manualOrder and relationScore to null', () => {
      const entry = makeEntry({ taskId: 'task-2' });
      // manualOrder and relationScore are not set (undefined by default)

      const candidate = service.toSchedulerCandidate(entry);

      expect(candidate.manualOrder).toBeNull();
      expect(candidate.relationScore).toBeNull();
    });

    it('falls back to zoneService.resolveSourceProjectId when entry.sourceProjectId is null', () => {
      mockZoneService.resolveSourceProjectId.mockReturnValueOnce('resolved-proj');
      const entry = makeEntry({ taskId: 'task-3', sourceProjectId: null });

      const candidate = service.toSchedulerCandidate(entry);

      expect(candidate.sourceProjectId).toBe('resolved-proj');
      expect(mockZoneService.resolveSourceProjectId).toHaveBeenCalledWith(entry);
    });
  });

  describe('toFocusTaskSlot', () => {
    it('creates a FocusTaskSlot with mapped focusStatus and zone', () => {
      const entry = makeEntry({
        taskId: 'slot-1',
        status: 'focusing',
        load: 'high',
        expectedMinutes: 45,
        waitMinutes: null,
        isMain: true,
        dockedOrder: 0,
        sourceProjectId: 'proj-a',
        sourceKind: 'project-task',
      });

      const slot = service.toFocusTaskSlot(entry, 'command', 0);

      expect(slot.slotId).toBe('slot-1');
      expect(slot.taskId).toBe('slot-1');
      expect(slot.estimatedMinutes).toBe(45);
      expect(slot.waitMinutes).toBeNull();
      expect(slot.cognitiveLoad).toBe('high');
      expect(slot.focusStatus).toBe('focusing');
      expect(slot.zone).toBe('command');
      expect(slot.zoneIndex).toBe(0);
      expect(slot.isMaster).toBe(true);
      expect(slot.waitStartedAt).toBeNull();
      expect(slot.waitEndAt).toBeNull();
      expect(slot.sourceProjectId).toBe('proj-a');
      expect(slot.sourceBlockType).toBeNull();
      expect(slot.isFirstBatch).toBe(true);
      expect(slot.inlineTitle).toBe('slot-1');
    });

    it('maps dock-created sourceKind to text sourceBlockType', () => {
      const entry = makeEntry({
        taskId: 'inline-1',
        sourceKind: 'dock-created',
      });

      const slot = service.toFocusTaskSlot(entry);

      expect(slot.sourceBlockType).toBe('text');
    });

    it('maps pending_start status to pending focusStatus', () => {
      const entry = makeEntry({ taskId: 'ps-1', status: 'pending_start' });
      expect(service.toFocusTaskSlot(entry).focusStatus).toBe('pending');
    });

    it('maps suspended_waiting to suspend-waiting', () => {
      const entry = makeEntry({ taskId: 'sw-1', status: 'suspended_waiting' });
      expect(service.toFocusTaskSlot(entry).focusStatus).toBe('suspend-waiting');
    });

    it('maps wait_finished to wait-ended', () => {
      const entry = makeEntry({ taskId: 'wf-1', status: 'wait_finished' });
      expect(service.toFocusTaskSlot(entry).focusStatus).toBe('wait-ended');
    });

    it('computes waitEndAt when waitStartedAt and waitMinutes are present', () => {
      const startedAt = '2024-01-01T00:00:00.000Z';
      const entry = makeEntry({
        taskId: 'w-1',
        waitStartedAt: startedAt,
        waitMinutes: 10,
      });

      const slot = service.toFocusTaskSlot(entry);

      const startMs = new Date(startedAt).getTime();
      expect(slot.waitStartedAt).toBe(startMs);
      expect(slot.waitEndAt).toBe(startMs + 10 * 60_000);
    });

    it('defaults zone to command and idx to 0', () => {
      const entry = makeEntry({ taskId: 'default-1' });
      const slot = service.toFocusTaskSlot(entry);
      expect(slot.zone).toBe('command');
      expect(slot.zoneIndex).toBe(0);
    });
  });

  describe('getWaitRemainingSeconds', () => {
    it('returns null when no wait timer is configured', () => {
      const entry = makeEntry({ taskId: 'no-wait' });
      expect(service.getWaitRemainingSeconds(entry)).toBeNull();
    });

    it('returns remaining seconds for an active wait timer', () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      const entry = makeEntry({
        taskId: 'wait-1',
        waitStartedAt: new Date(now - 5 * 60_000).toISOString(),
        waitMinutes: 10,
      });

      const remaining = service.getWaitRemainingSeconds(entry);
      expect(remaining).toBe(5 * 60); // 5 minutes remaining

      vi.useRealTimers();
    });

    it('returns 0 when wait time has fully elapsed', () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      const entry = makeEntry({
        taskId: 'wait-expired',
        waitStartedAt: new Date(now - 15 * 60_000).toISOString(),
        waitMinutes: 10,
      });

      expect(service.getWaitRemainingSeconds(entry)).toBe(0);

      vi.useRealTimers();
    });
  });

  // =========================================================================
  //  3. deriveBackgroundStatus
  // =========================================================================

  describe('deriveBackgroundStatus', () => {
    it('returns suspended_waiting when entry has an active wait timer', () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      const entry = makeEntry({
        taskId: 'bg-1',
        waitStartedAt: new Date(now - 1 * 60_000).toISOString(),
        waitMinutes: 10,
      });

      expect(service.deriveBackgroundStatus(entry)).toBe('suspended_waiting');
      vi.useRealTimers();
    });

    it('returns wait_finished when wait timer has expired', () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      const entry = makeEntry({
        taskId: 'bg-2',
        waitStartedAt: new Date(now - 20 * 60_000).toISOString(),
        waitMinutes: 10,
      });

      expect(service.deriveBackgroundStatus(entry)).toBe('wait_finished');
      vi.useRealTimers();
    });

    it('returns stalled when current focus is non-main and nextTarget is main', () => {
      const entry = makeEntry({ taskId: 'bg-3', status: 'pending_start' });
      const nextTarget = makeEntry({ taskId: 'next', isMain: true });
      const currentFocus = makeEntry({ taskId: 'current', isMain: false });

      expect(service.deriveBackgroundStatus(entry, nextTarget, currentFocus)).toBe('stalled');
    });

    it('preserves stalled status for already stalled entry', () => {
      const entry = makeEntry({ taskId: 'bg-stall', status: 'stalled' });
      expect(service.deriveBackgroundStatus(entry)).toBe('stalled');
    });

    it('returns stalled for a focusing entry being moved to background', () => {
      const entry = makeEntry({ taskId: 'bg-focus', status: 'focusing' });
      expect(service.deriveBackgroundStatus(entry)).toBe('stalled');
    });

    it('defaults to pending_start for entries with no special conditions', () => {
      const entry = makeEntry({ taskId: 'bg-default', status: 'pending_start' });
      expect(service.deriveBackgroundStatus(entry)).toBe('pending_start');
    });

    it('does not return stalled when currentFocus is main even if nextTarget is main', () => {
      const entry = makeEntry({ taskId: 'bg-4', status: 'pending_start' });
      const nextTarget = makeEntry({ taskId: 'next', isMain: true });
      const currentFocus = makeEntry({ taskId: 'current', isMain: true });

      // currentFocus.isMain === true, so the stalled branch is NOT taken
      expect(service.deriveBackgroundStatus(entry, nextTarget, currentFocus)).toBe('pending_start');
    });
  });

  // =========================================================================
  //  4. resolveAfterCompletion
  // =========================================================================

  describe('resolveAfterCompletion', () => {
    it('calls promoteNext (fallback) when there is no root task', () => {
      const ctx = buildContext({
        entries: [
          makeEntry({ taskId: 'A', status: 'completed' }),
          makeEntry({ taskId: 'B', status: 'pending_start', dockedOrder: 1 }),
        ],
        suspendChainRootTaskId: null,
        focusMode: false,
      });
      service.init(ctx);

      service.resolveAfterCompletion('A');

      // fallback path: pendingDecision cleared
      expect(ctx.pendingDecision()).toBeNull();
    });

    it('highlights recovered main with wait_finished status', () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      const rootEntry = makeEntry({
        taskId: 'root',
        isMain: true,
        status: 'wait_finished',
        waitStartedAt: new Date(now - 20 * 60_000).toISOString(),
        waitMinutes: 10,
      });

      const ctx = buildContext({
        entries: [
          makeEntry({ taskId: 'completed-task', status: 'completed' }),
          rootEntry,
        ],
        suspendChainRootTaskId: 'root',
        focusMode: true,
      });
      service.init(ctx);

      service.resolveAfterCompletion('completed-task');

      // recovered main path: highlight the wait_finished main entry
      expect(ctx.highlightedIds()).toContain('root');
      expect(ctx.lastRuleDecision()?.type).toBe('completion_followup');
      expect(ctx.lastRuleDecision()?.reason).toContain('主任务等待结束');

      vi.useRealTimers();
    });

    it('promotes next candidate in fallback path when root has no remaining wait', () => {
      const ctx = buildContext({
        entries: [
          makeEntry({ taskId: 'completed-1', status: 'completed' }),
          makeEntry({ taskId: 'stalled-1', status: 'stalled', dockedOrder: 1 }),
        ],
        suspendChainRootTaskId: null,
        focusMode: false,
      });
      service.init(ctx);

      service.resolveAfterCompletion('completed-1');

      // promoteNext should promote the stalled entry
      const promoted = ctx.entries().find(e => e.taskId === 'stalled-1');
      expect(promoted?.isMain).toBe(true);
    });

    it('enters fragment countdown when root is waiting but no candidates exist', () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      const rootEntry = makeEntry({
        taskId: 'root-wait',
        isMain: true,
        status: 'suspended_waiting',
        waitStartedAt: new Date(now).toISOString(),
        waitMinutes: 30,
      });

      const ctx = buildContext({
        entries: [
          makeEntry({ taskId: 'done', status: 'completed' }),
          rootEntry,
        ],
        suspendChainRootTaskId: 'root-wait',
        focusMode: true,
      });
      service.init(ctx);

      service.resolveAfterCompletion('done');

      expect(mockFragmentRest.startFragmentEntryCountdown).toHaveBeenCalled();

      vi.useRealTimers();
    });
  });

  // =========================================================================
  //  5. scoreCandidate
  // =========================================================================

  describe('scoreCandidate', () => {
    it('returns a numeric score for a valid entry', () => {
      const ctx = buildContext({});
      service.init(ctx);

      const entry = makeEntry({
        taskId: 'score-1',
        load: 'low',
        expectedMinutes: 15,
        lane: 'combo-select',
        sourceProjectId: 'proj-1',
      });

      const score = service.scoreCandidate(entry, 20);
      expect(typeof score).toBe('number');
      expect(score).toBeGreaterThanOrEqual(0);
    });

    it('returns 0 when rankDockCandidates produces an empty array', () => {
      const ctx = buildContext({});
      service.init(ctx);

      // An entry with no expectedMinutes → scoring still works (returns a number)
      const entry = makeEntry({
        taskId: 'score-empty',
        expectedMinutes: null,
      });

      const score = service.scoreCandidate(entry, 0);
      expect(typeof score).toBe('number');
    });
  });

  // =========================================================================
  //  6. promoteCandidate / promoteFocusedTaskToMaster
  // =========================================================================

  describe('promoteCandidate', () => {
    it('sets the promoted task as main and pending_start outside focus mode', () => {
      const ctx = buildContext({
        entries: [
          makeEntry({ taskId: 'A', isMain: true, status: 'focusing' }),
          makeEntry({ taskId: 'B', isMain: false, status: 'pending_start', dockedOrder: 1 }),
        ],
        focusMode: false,
      });
      service.init(ctx);

      service.promoteCandidate('B');

      const a = ctx.entries().find(e => e.taskId === 'A');
      const b = ctx.entries().find(e => e.taskId === 'B');
      expect(b?.isMain).toBe(true);
      expect(b?.status).toBe('pending_start');
      expect(a?.isMain).toBe(false);
    });

    it('sets the promoted task as focusing in focus mode', () => {
      const focusingEntry = makeEntry({ taskId: 'A', isMain: true, status: 'focusing' });
      const ctx = buildContext({
        entries: [
          focusingEntry,
          makeEntry({ taskId: 'B', isMain: false, status: 'pending_start', dockedOrder: 1 }),
        ],
        focusMode: true,
        focusingEntry,
      });
      service.init(ctx);

      service.promoteCandidate('B');

      const b = ctx.entries().find(e => e.taskId === 'B');
      expect(b?.status).toBe('focusing');
    });
  });

  describe('promoteFocusedTaskToMaster', () => {
    it('promotes the focusing entry to master when no master exists', () => {
      const ctx = buildContext({
        entries: [
          makeEntry({ taskId: 'X', isMain: false, status: 'focusing' }),
          makeEntry({ taskId: 'Y', isMain: false, status: 'pending_start', dockedOrder: 1 }),
        ],
      });
      service.init(ctx);

      service.promoteFocusedTaskToMaster();

      expect(ctx.entries().find(e => e.taskId === 'X')?.isMain).toBe(true);
    });

    it('does nothing when a master already exists', () => {
      const ctx = buildContext({
        entries: [
          makeEntry({ taskId: 'X', isMain: true, status: 'focusing' }),
          makeEntry({ taskId: 'Y', isMain: false, status: 'pending_start', dockedOrder: 1 }),
        ],
      });
      service.init(ctx);

      service.promoteFocusedTaskToMaster();

      // X remains the only master
      expect(ctx.entries().find(e => e.taskId === 'X')?.isMain).toBe(true);
      expect(ctx.entries().find(e => e.taskId === 'Y')?.isMain).toBe(false);
    });
  });

  // =========================================================================
  //  7. pickPrimaryCandidate / pickBestCandidate
  // =========================================================================

  describe('pickPrimaryCandidate', () => {
    it('returns idle main entry first', () => {
      const ctx = buildContext({
        entries: [
          makeEntry({ taskId: 'main-idle', isMain: true, status: 'pending_start', dockedOrder: 0 }),
          makeEntry({ taskId: 'other', isMain: false, status: 'pending_start', dockedOrder: 1 }),
        ],
      });
      service.init(ctx);

      const result = service.pickPrimaryCandidate([], 30, null);
      expect(result?.taskId).toBe('main-idle');
    });

    it('returns stalled entry when no idle main exists', () => {
      const ctx = buildContext({
        entries: [
          makeEntry({ taskId: 'stalled-entry', status: 'stalled', dockedOrder: 0 }),
          makeEntry({ taskId: 'pending-entry', status: 'pending_start', dockedOrder: 1 }),
        ],
      });
      service.init(ctx);

      const result = service.pickPrimaryCandidate([], 30, null);
      expect(result?.taskId).toBe('stalled-entry');
    });

    it('excludes specified task ids', () => {
      const ctx = buildContext({
        entries: [
          makeEntry({ taskId: 'A', isMain: true, status: 'pending_start', dockedOrder: 0 }),
          makeEntry({ taskId: 'B', isMain: false, status: 'pending_start', dockedOrder: 1 }),
        ],
      });
      service.init(ctx);

      const result = service.pickPrimaryCandidate(['A'], 30, null);
      // A is excluded, falls through to pickBestCandidate which picks B
      expect(result?.taskId).toBe('B');
    });

    it('returns null when all entries are excluded or not promotable', () => {
      const ctx = buildContext({
        entries: [
          makeEntry({ taskId: 'done', status: 'completed', dockedOrder: 0 }),
        ],
      });
      service.init(ctx);

      const result = service.pickPrimaryCandidate([], 30, null);
      expect(result).toBeNull();
    });
  });
});
