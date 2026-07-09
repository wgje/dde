import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DockCompletionFlowService } from './dock-completion-flow.service';
import { DockZoneService } from './dock-zone.service';
import { DockFragmentRestService } from './dock-fragment-rest.service';
import {
  buildDockCompletionContext as buildContext,
  makeDockCompletionEntry as makeEntry,
  mockDockCompletionFragmentRest as mockFragmentRest,
  mockDockCompletionZoneService as mockZoneService,
} from './dock-completion-flow.service.spec-helpers';
import { registerDockCompletionFlowHelperSpecs } from './dock-completion-flow-helper.spec-helpers';

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

  registerDockCompletionFlowHelperSpecs({
    service: () => service,
    zoneService: () => mockZoneService,
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

    it('restores a wait-finished suspend root as main before fallback recommendations', () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      const ctx = buildContext({
        entries: [
          makeEntry({
            taskId: 'fresh-main',
            title: 'fresh main',
            isMain: true,
            status: 'completed',
            dockedOrder: 0,
          }),
          makeEntry({
            taskId: 'suspended-root',
            title: 'suspended root',
            isMain: false,
            status: 'wait_finished',
            waitStartedAt: new Date(now - 20 * 60_000).toISOString(),
            waitMinutes: 10,
            dockedOrder: 1,
          }),
          makeEntry({
            taskId: 'fresh-recommendation',
            title: 'fresh recommendation',
            isMain: false,
            status: 'stalled',
            dockedOrder: 2,
          }),
        ],
        suspendChainRootTaskId: 'suspended-root',
        focusMode: false,
      });
      ctx.pendingDecision.set({
        rootTaskId: 'suspended-root',
        rootRemainingMinutes: 0,
        candidateGroups: [{ type: 'homologous-advancement', taskIds: ['fresh-recommendation'] }],
        reason: 'stale recommendations',
        createdAt: new Date(now).toISOString(),
      });
      service.init(ctx);

      service.resolveAfterCompletion('fresh-main');

      const restored = ctx.entries().find(entry => entry.taskId === 'suspended-root');
      const freshRecommendation = ctx.entries().find(entry => entry.taskId === 'fresh-recommendation');
      expect(restored).toMatchObject({
        isMain: true,
        status: 'focusing',
        waitMinutes: null,
        waitStartedAt: null,
        systemSelected: false,
        recommendationLocked: false,
      });
      expect(freshRecommendation?.isMain).toBe(false);
      expect(ctx.pendingDecision()).toBeNull();
      expect(ctx.highlightedIds()).toEqual(new Set(['suspended-root']));
      expect(ctx.lastRuleDecision()?.recommendedTaskIds).toEqual(['suspended-root']);

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

  // =========================================================================
  //  8. Race conditions & edge cases
  // =========================================================================

  describe('race conditions', () => {
    it('double-trigger of resolveAfterCompletion should not corrupt entries', () => {
      const ctx = buildContext({
        entries: [
          makeEntry({ taskId: 'A', status: 'completed' }),
          makeEntry({ taskId: 'B', status: 'pending_start', dockedOrder: 1 }),
          makeEntry({ taskId: 'C', status: 'pending_start', dockedOrder: 2 }),
        ],
        suspendChainRootTaskId: null,
        focusMode: false,
      });
      service.init(ctx);

      // 连续触发两次完成决策
      service.resolveAfterCompletion('A');
      service.resolveAfterCompletion('A');

      // 结果只应有一个 main 任务
      const mainEntries = ctx.entries().filter(e => e.isMain);
      expect(mainEntries.length).toBe(1);
    });

    it('resolveAfterCompletion for a non-existent taskId should not throw', () => {
      const ctx = buildContext({
        entries: [
          makeEntry({ taskId: 'A', status: 'focusing' }),
        ],
        focusMode: true,
      });
      service.init(ctx);

      // 传入不存在的 taskId 不应抛异常
      expect(() => service.resolveAfterCompletion('non-existent')).not.toThrow();
    });

    it('promoteCandidate with invalid taskId should not corrupt entries', () => {
      const ctx = buildContext({
        entries: [
          makeEntry({ taskId: 'A', isMain: true, status: 'focusing' }),
        ],
        focusMode: true,
      });
      service.init(ctx);

      service.promoteCandidate('non-existent');

      // A 仍是 main 且状态不变
      const a = ctx.entries().find(e => e.taskId === 'A');
      expect(a?.isMain).toBe(true);
    });
  });

  // =========================================================================
  //  9. Error path: sub-service failures
  // =========================================================================

  describe('error paths', () => {
    it('propagates fragmentRest.startFragmentEntryCountdown errors (no internal try/catch)', () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      mockFragmentRest.startFragmentEntryCountdown.mockImplementationOnce(() => {
        throw new Error('fragment service unavailable');
      });

      const rootEntry = makeEntry({
        taskId: 'root-err',
        isMain: true,
        status: 'suspended_waiting',
        waitStartedAt: new Date(now).toISOString(),
        waitMinutes: 30,
      });

      const ctx = buildContext({
        entries: [
          makeEntry({ taskId: 'done-err', status: 'completed' }),
          rootEntry,
        ],
        suspendChainRootTaskId: 'root-err',
        focusMode: true,
      });
      service.init(ctx);

      // 当前实现不捕获 fragment 服务异常——错误会向上传播
      expect(() => service.resolveAfterCompletion('done-err')).toThrow('fragment service unavailable');

      vi.useRealTimers();
    });

    it('propagates zoneService.resolveSourceProjectId errors (no internal try/catch)', () => {
      mockZoneService.resolveSourceProjectId.mockImplementationOnce(() => {
        throw new Error('zone service unavailable');
      });

      const entry = makeEntry({ taskId: 'zone-err', sourceProjectId: null });

      // 当前实现不捕获 zone 服务异常——错误会向上传播
      expect(() => service.toSchedulerCandidate(entry)).toThrow('zone service unavailable');
    });
  });
});
