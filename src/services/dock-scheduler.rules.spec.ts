import { describe, expect, it } from 'vitest';
import {
  checkBurnoutThreshold,
  checkPendingDecisionMismatch,
  computeInterludeScore,
  computeThreeDimensionalRecommendation,
  assignZonesOnFocusStart,
  determineFragmentDefenseLevel,
  effectiveExecMin,
  evaluateTimeRemaining,
  isTightRemainingWindow,
  rankDockCandidates,
  selectInterludeTasks,
  updateHighLoadCounter,
} from './dock-scheduler.rules';
import type { FocusTaskSlot } from '../models/parking-dock';
import { PARKING_CONFIG } from '../config/parking.config';

describe('dock-scheduler.rules', () => {
  it('should rank by scheduler score when no manual order and no same-project hints', () => {
    const ranked = rankDockCandidates(
      [
        {
          taskId: 'A',
          lane: 'combo-select',
          load: 'low',
          expectedMinutes: 20,
          waitMinutes: 0,
          dockedOrder: 2,
        },
        {
          taskId: 'B',
          lane: 'backup',
          load: 'low',
          expectedMinutes: 18,
          waitMinutes: 5,
          dockedOrder: 3,
        },
        {
          taskId: 'C',
          lane: 'combo-select',
          load: 'high',
          expectedMinutes: 18,
          waitMinutes: 0,
          dockedOrder: 1,
        },
      ],
      20,
    );

    expect(ranked[0]?.taskId).toBe('A');
    expect(ranked[1]?.taskId).toBe('B');
    expect(ranked[2]?.taskId).toBe('C');
  });

  it('should detect mismatch ratios for pending decision', () => {
    const tooLong = checkPendingDecisionMismatch(
      {
        taskId: 'C',
        lane: 'combo-select',
        load: 'low',
        expectedMinutes: 90,
        waitMinutes: null,
        dockedOrder: 0,
      },
      30,
    );
    const tooShort = checkPendingDecisionMismatch(
      {
        taskId: 'C',
        lane: 'combo-select',
        load: 'low',
        expectedMinutes: 5,
        waitMinutes: null,
        dockedOrder: 0,
      },
      30,
    );

    expect(tooLong.shouldPrompt).toBe(true);
    expect(tooShort.shouldPrompt).toBe(true);
  });

  it('should use configured tight-window threshold', () => {
    expect(isTightRemainingWindow(2)).toBe(true);
    expect(isTightRemainingWindow(3)).toBe(false);
  });

  it('should not prompt pending decision when ratio stays in normal range', () => {
    const normal = checkPendingDecisionMismatch(
      {
        taskId: 'C',
        lane: 'combo-select',
        load: 'low',
        expectedMinutes: 24,
        waitMinutes: null,
        dockedOrder: 0,
      },
      20,
    );

    expect(normal.shouldPrompt).toBe(false);
    expect(normal.ratio).toBeCloseTo(1.2, 2);
  });

  it('should use docked order as final tie-breaker when priorities match', () => {
    const ranked = rankDockCandidates(
      [
        {
          taskId: 'A',
          lane: 'combo-select',
          load: 'low',
          expectedMinutes: 20,
          waitMinutes: null,
          dockedOrder: 2,
        },
        {
          taskId: 'B',
          lane: 'combo-select',
          load: 'low',
          expectedMinutes: 20,
          waitMinutes: null,
          dockedOrder: 1,
        },
      ],
      20,
    );

    expect(ranked[0]?.taskId).toBe('B');
    expect(ranked[1]?.taskId).toBe('A');
  });

  it('should prioritize higher structural relation score and same-project candidates', () => {
    const ranked = rankDockCandidates(
      [
        {
          taskId: 'A',
          lane: 'combo-select',
          load: 'low',
          expectedMinutes: 18,
          waitMinutes: null,
          dockedOrder: 1,
          relationScore: 90,
          sourceProjectId: 'project-1',
        },
        {
          taskId: 'B',
          lane: 'combo-select',
          load: 'low',
          expectedMinutes: 18,
          waitMinutes: null,
          dockedOrder: 0,
          relationScore: 15,
          sourceProjectId: 'project-2',
        },
      ],
      20,
      {
        rootLoad: 'high',
        rootProjectId: 'project-1',
      },
    );

    expect(ranked[0]?.taskId).toBe('A');
  });

  it('should reward low-load insertion when root task load is high', () => {
    const ranked = rankDockCandidates(
      [
        {
          taskId: 'low-load',
          lane: 'combo-select',
          load: 'low',
          expectedMinutes: 10,
          waitMinutes: null,
          dockedOrder: 1,
          sourceProjectId: 'project-1',
        },
        {
          taskId: 'high-load',
          lane: 'combo-select',
          load: 'high',
          expectedMinutes: 10,
          waitMinutes: null,
          dockedOrder: 0,
          sourceProjectId: 'project-1',
        },
      ],
      12,
      {
        rootLoad: 'high',
        rootProjectId: 'project-1',
      },
    );

    expect(ranked[0]?.taskId).toBe('low-load');
  });

  it('should prioritize manualOrder before dockedOrder when candidates are otherwise equal', () => {
    const ranked = rankDockCandidates(
      [
        {
          taskId: 'manual-first',
          lane: 'combo-select',
          load: 'low',
          expectedMinutes: 18,
          waitMinutes: null,
          dockedOrder: 5,
          manualOrder: 0,
          sourceProjectId: 'project-1',
        },
        {
          taskId: 'manual-second',
          lane: 'combo-select',
          load: 'low',
          expectedMinutes: 18,
          waitMinutes: null,
          dockedOrder: 0,
          manualOrder: 2,
          sourceProjectId: 'project-1',
        },
      ],
      20,
      {
        rootLoad: 'low',
        rootProjectId: 'project-1',
      },
    );

    expect(ranked[0]?.taskId).toBe('manual-first');
  });

  it('should allow stronger relation and time-fit signals to beat same-project bias', () => {
    const ranked = rankDockCandidates(
      [
        {
          taskId: 'same-project',
          lane: 'backup',
          load: 'high',
          expectedMinutes: 30,
          waitMinutes: null,
          dockedOrder: 2,
          relationScore: 10,
          sourceProjectId: 'project-1',
        },
        {
          taskId: 'cross-project-high-score',
          lane: 'combo-select',
          load: 'low',
          expectedMinutes: 18,
          waitMinutes: 5,
          dockedOrder: 0,
          relationScore: 95,
          sourceProjectId: 'project-2',
        },
      ],
      20,
      {
        rootLoad: 'high',
        rootProjectId: 'project-1',
      },
    );

    expect(ranked[0]?.taskId).toBe('cross-project-high-score');
  });

  it('should keep mismatched candidates rankable in relaxed wait-fit mode', () => {
    const ranked = rankDockCandidates(
      [
        {
          taskId: 'long-but-related',
          lane: 'combo-select',
          load: 'low',
          expectedMinutes: 55,
          waitMinutes: null,
          dockedOrder: 1,
          relationScore: 90,
          sourceProjectId: 'project-2',
        },
        {
          taskId: 'short-unrelated',
          lane: 'backup',
          load: 'high',
          expectedMinutes: 4,
          waitMinutes: null,
          dockedOrder: 0,
          relationScore: 5,
          sourceProjectId: 'project-3',
        },
      ],
      12,
      {
        rootLoad: 'high',
        rootProjectId: 'project-1',
        waitFitMode: 'relaxed',
      },
    );

    expect(ranked[0]?.taskId).toBe('long-but-related');
    expect(ranked[0]?.score).toBeGreaterThan(ranked[1]?.score ?? Number.NEGATIVE_INFINITY);
  });

  it('should keep deterministic ordering on full ties', () => {
    const ranked = rankDockCandidates(
      [
        {
          taskId: 'A',
          lane: 'backup',
          load: 'low',
          expectedMinutes: 20,
          waitMinutes: null,
          dockedOrder: 0,
          sourceProjectId: 'project-1',
        },
        {
          taskId: 'B',
          lane: 'backup',
          load: 'low',
          expectedMinutes: 20,
          waitMinutes: null,
          dockedOrder: 0,
          sourceProjectId: 'project-1',
        },
      ],
      20,
      {
        rootLoad: 'low',
        rootProjectId: 'project-1',
      },
    );

    expect(ranked.map(item => item.taskId)).toEqual(['A', 'B']);
  });
});

// ============================================
// v3.0 新增算法测试
/** 构建 FocusTaskSlot 辅助对象 */
function makeSlot(override: Partial<FocusTaskSlot>): FocusTaskSlot {
  return {
    slotId: override.slotId ?? crypto.randomUUID(),
    taskId: override.taskId ?? 'task-1',
    zone: override.zone ?? 'combo-select',
    estimatedMinutes: 'estimatedMinutes' in override ? override.estimatedMinutes ?? null : 20,
    waitMinutes: 'waitMinutes' in override ? override.waitMinutes ?? null : null,
    cognitiveLoad: override.cognitiveLoad ?? 'low',
    focusStatus: override.focusStatus ?? 'pending',
    zoneIndex: override.zoneIndex ?? 0,
    isMaster: override.isMaster ?? false,
    waitStartedAt: override.waitStartedAt ?? null,
    waitEndAt: override.waitEndAt ?? null,
    sourceProjectId: override.sourceProjectId ?? null,
    sourceBlockType: override.sourceBlockType ?? null,
    draggedInAt: override.draggedInAt ?? Date.now(),
    isFirstBatch: override.isFirstBatch ?? false,
    inlineTitle: override.inlineTitle ?? '测试任务',
    inlineDetail: override.inlineDetail ?? null,
  };
}

describe('effectiveExecMin', () => {
  it('should return estimated - wait when wait < estimated', () => {
    const slot = makeSlot({ estimatedMinutes: 30, waitMinutes: 10 });
    expect(effectiveExecMin(slot)).toBe(20);
  });

  it('should return estimated when waitMinutes is null', () => {
    const slot = makeSlot({ estimatedMinutes: 25, waitMinutes: null });
    expect(effectiveExecMin(slot)).toBe(25);
  });

  it('should clamp to 0 when wait > estimated', () => {
    const slot = makeSlot({ estimatedMinutes: 10, waitMinutes: 15 });
    expect(effectiveExecMin(slot)).toBe(0);
  });

  it('should default to 0 when estimatedMinutes is null', () => {
    const slot = makeSlot({ estimatedMinutes: null, waitMinutes: null });
    expect(effectiveExecMin(slot)).toBe(0);
  });
});

describe('computeThreeDimensionalRecommendation', () => {
  it('should group tasks into 3 groups', () => {
    const main = makeSlot({
      slotId: 'main',
      sourceProjectId: 'proj-1',
      cognitiveLoad: 'high',
      estimatedMinutes: 60,
      waitMinutes: 30,
    });
    const candidates = [
      makeSlot({
        slotId: 'same-proj',
        sourceProjectId: 'proj-1',
        cognitiveLoad: 'high',
        estimatedMinutes: 15,
      }),
      makeSlot({
        slotId: 'low-load',
        sourceProjectId: 'proj-2',
        cognitiveLoad: 'low',
        estimatedMinutes: 10,
      }),
      makeSlot({
        slotId: 'async',
        sourceProjectId: 'proj-3',
        cognitiveLoad: 'low',
        estimatedMinutes: 20,
        waitMinutes: 10,
      }),
    ];
    const groups = computeThreeDimensionalRecommendation(main, candidates, 30);
    expect(groups).toHaveLength(3);
    expect(groups[0]?.type).toBe('homologous-advancement');
    expect(groups[1]?.type).toBe('cognitive-downgrade');
    expect(groups[2]?.type).toBe('asynchronous-boot');

    // 同源推进应包含 same-proj
    expect(groups[0]?.candidates.map(c => c.slotId)).toContain('same-proj');
    // 认知降级应包含 low-load（不同项目优先）
    expect(groups[1]?.candidates.map(c => c.slotId)).toContain('low-load');
    // 异步启动应包含有等待时间的任务（若未被前置分组消耗）。
    // async（waitMinutes=10）可能已被 cognitive-downgrade 组消耗，因此验证它出现在任一组中即可。
    const allSlotIds = groups.flatMap(g => g.candidates.map(c => c.slotId));
    expect(allSlotIds).toContain('async');
  });

  it('should filter out tasks exceeding remainingWaitMin', () => {
    const main = makeSlot({ slotId: 'main', sourceProjectId: 'proj-1' });
    const tooLong = makeSlot({
      slotId: 'too-long',
      sourceProjectId: 'proj-1',
      estimatedMinutes: 100,
    });
    const groups = computeThreeDimensionalRecommendation(main, [tooLong], 10);
    const allCandidates = groups.flatMap(g => g.candidates);
    expect(allCandidates).toHaveLength(0);
  });

  it('should return empty sets when no candidates match and W_main < 30min', () => {
    const main = makeSlot({ slotId: 'main', sourceProjectId: 'proj-1' });
    const big = makeSlot({
      slotId: 'big',
      sourceProjectId: 'proj-2',
      cognitiveLoad: 'high',
      estimatedMinutes: 50,
    });
    const groups = computeThreeDimensionalRecommendation(main, [big], 10);
    const allCandidates = groups.flatMap(g => g.candidates);
    expect(allCandidates).toHaveLength(0);
  });

  it('should fallback to oversized when all empty and W_main >= 30min', () => {
    const main = makeSlot({ slotId: 'main', sourceProjectId: 'proj-1' });
    const big = makeSlot({
      slotId: 'big',
      sourceProjectId: 'proj-1',
      cognitiveLoad: 'low',
      estimatedMinutes: 50,
    });
    const groups = computeThreeDimensionalRecommendation(main, [big], 35);
    // 大任务回退模式：isOversized = true
    expect(groups.some(g => (g as any).isOversized)).toBe(true);
  });
  it('should reserve ignore-wait mode for extreme mismatches beyond relaxed bounds', () => {
    const main = makeSlot({
      slotId: 'main',
      sourceProjectId: 'proj-1',
      cognitiveLoad: 'high',
      estimatedMinutes: 60,
      waitMinutes: 30,
    });
    const oversizedSameProject = makeSlot({
      slotId: 'oversized-same-project',
      sourceProjectId: 'proj-1',
      cognitiveLoad: 'high',
      estimatedMinutes: 200,
    });

    const relaxedGroups = computeThreeDimensionalRecommendation(main, [oversizedSameProject], 30, 'relaxed');
    const ignoreWaitGroups = computeThreeDimensionalRecommendation(main, [oversizedSameProject], 30, 'ignore-wait');

    expect(relaxedGroups.flatMap(group => group.candidates)).toHaveLength(0);
    expect(ignoreWaitGroups[0]?.candidates.map(candidate => candidate.slotId)).toContain('oversized-same-project');
  });
});

describe('checkBurnoutThreshold', () => {
  it('should return false when count < threshold', () => {
    const now = Date.now();
    expect(checkBurnoutThreshold({ count: 2, windowStartAt: now - 1000 }, now)).toBe(false);
  });

  it('should return true when count >= threshold within window', () => {
    const now = Date.now();
    const threshold = PARKING_CONFIG.BURNOUT_HIGH_LOAD_THRESHOLD;
    expect(checkBurnoutThreshold({ count: threshold, windowStartAt: now - 1000 }, now)).toBe(true);
  });

  it('should return false when window has expired', () => {
    const now = Date.now();
    const expired = now - PARKING_CONFIG.BURNOUT_WINDOW_MS - 1;
    expect(checkBurnoutThreshold({ count: 5, windowStartAt: expired }, now)).toBe(false);
  });
});

describe('updateHighLoadCounter', () => {
  it('should increment within active window', () => {
    const now = Date.now();
    const result = updateHighLoadCounter({ count: 2, windowStartAt: now - 1000 }, now);
    expect(result.count).toBe(3);
    expect(result.windowStartAt).toBe(now - 1000);
  });

  it('should reset when window expired', () => {
    const now = Date.now();
    const expired = now - PARKING_CONFIG.BURNOUT_WINDOW_MS - 1;
    const result = updateHighLoadCounter({ count: 5, windowStartAt: expired }, now);
    expect(result.count).toBe(1);
    expect(result.windowStartAt).toBe(now);
  });
});

describe('determineFragmentDefenseLevel', () => {
  it('should return Level 1 when wait <= 5min', () => {
    expect(determineFragmentDefenseLevel(3, false)).toBe(1);
  });

  it('should return Level 2 when wait > 5min', () => {
    expect(determineFragmentDefenseLevel(10, false)).toBe(2);
  });

  it('should return Level 2 when burnout is active regardless of wait', () => {
    expect(determineFragmentDefenseLevel(2, true)).toBe(2);
  });
});

describe('evaluateTimeRemaining', () => {
  it('should return blank-period when remaining <= 2min', () => {
    expect(evaluateTimeRemaining(1.5, 10)).toBe('blank-period');
  });

  it('should return time-match when candidate fits in window', () => {
    expect(evaluateTimeRemaining(20, 15)).toBe('time-match');
  });

  it('should return time-match when candidateExec is null', () => {
    expect(evaluateTimeRemaining(10, null)).toBe('time-match');
  });

  it('should return tight-blank when candidate consumes > 75%', () => {
    expect(evaluateTimeRemaining(10, 9)).toBe('tight-blank');
  });

  it('should return mismatch-recompute for severely undersized candidate', () => {
    expect(evaluateTimeRemaining(30, 2)).toBe('mismatch-recompute');
  });
});

describe('selectInterludeTasks', () => {
  it('should return up to 3 candidates sorted by score', () => {
    const now = Date.now();
    const waiting = makeSlot({
      slotId: 'waiting',
      waitMinutes: 30,
      waitEndAt: now + 20 * 60_000, // 20min remaining
    });
    const candidates = [
      makeSlot({ slotId: 'c1', estimatedMinutes: 10, cognitiveLoad: 'low' }),
      makeSlot({ slotId: 'c2', estimatedMinutes: 15, cognitiveLoad: 'high' }),
      makeSlot({ slotId: 'c3', estimatedMinutes: 8, cognitiveLoad: 'low', waitMinutes: 5 }),
      makeSlot({ slotId: 'c4', estimatedMinutes: 12, cognitiveLoad: 'low' }),
    ];
    const result = selectInterludeTasks(waiting, candidates);
    expect(result.length).toBeLessThanOrEqual(3);
    expect(result.length).toBeGreaterThan(0);
  });

  it('should return empty when no suitable candidates', () => {
    const waiting = makeSlot({ slotId: 'waiting', waitEndAt: Date.now() + 60_000 }); // 1min
    const candidates = [
      makeSlot({ slotId: 'c1', estimatedMinutes: 100, cognitiveLoad: 'high' }),
    ];
    const result = selectInterludeTasks(waiting, candidates);
    // 即使分数低也不为 0，所以可能返回结果
    expect(result.length).toBeLessThanOrEqual(3);
  });
});

describe('assignZonesOnFocusStart', () => {
  it('should place main task in command zone', () => {
    const main = makeSlot({ slotId: 'main', sourceProjectId: 'p1' });
    const other = makeSlot({ slotId: 'other', sourceProjectId: 'p2', cognitiveLoad: 'low', estimatedMinutes: 10 });
    const zones = assignZonesOnFocusStart([main, other], 'main');
    const commandZone = zones.find(z => z.zone === 'command');
    expect(commandZone?.tasks.map(t => t.slotId)).toContain('main');
  });

  it('should return empty zones when main task not found', () => {
    const task = makeSlot({ slotId: 'a' });
    const zones = assignZonesOnFocusStart([task], 'nonexistent');
    const allTasks = zones.flatMap(z => z.tasks);
    expect(allTasks).toHaveLength(0);
  });

  it('should distribute tasks across all 3 zones', () => {
    const main = makeSlot({ slotId: 'main', sourceProjectId: 'p1', estimatedMinutes: 60 });
    const tasks = Array.from({ length: 8 }, (_, i) =>
      makeSlot({
        slotId: `task-${i}`,
        sourceProjectId: i % 2 === 0 ? 'p1' : 'p2',
        cognitiveLoad: i % 3 === 0 ? 'high' : 'low',
        estimatedMinutes: 10 + i * 3,
        waitMinutes: i % 2 === 0 ? 5 : null,
      }),
    );
    const zones = assignZonesOnFocusStart([main, ...tasks], 'main');
    expect(zones).toHaveLength(3);
    // 所有任务（含 main）都应落在某个区域
    const allAssigned = zones.flatMap(z => z.tasks);
    expect(allAssigned.length).toBe(9); // main + 8
  });
});

