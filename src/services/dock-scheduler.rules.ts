import { PARKING_CONFIG } from '../config/parking.config';
import {
  CognitiveLoad,
  DockLane,
  DockRuleDecision,
  DockRuleDecisionType,
  FocusTaskSlot,
  RecommendationGroup,
  ZoneAssignment,
} from '../models/parking-dock';

export interface DockSchedulerCandidate {
  taskId: string;
  lane: DockLane;
  load: CognitiveLoad;
  expectedMinutes: number | null;
  waitMinutes: number | null;
  dockedOrder: number;
  manualOrder?: number | null;
  relationScore?: number | null;
  sourceProjectId?: string | null;
}

export interface DockSchedulerContext {
  rootLoad?: CognitiveLoad | null;
  rootProjectId?: string | null;
  waitFitMode?: DockWaitFitMode;
}

export type DockWaitFitMode = 'strict' | 'relaxed' | 'ignore-wait';

export interface DockCandidateScore {
  taskId: string;
  score: number;
  expectedMinutes: number | null;
  priority: {
    lowLoadWithWait: number;
    lowLoad: number;
    comboSelectLane: number;
    relationStrength: number;
    waitWindowFitScore: number;
    loadTransitionBonus: number;
    projectSwitchPenalty: number;
    timeMatchBucket: number;
    manualOrderWeight: number;
    orderWeight: number;
  };
}

export interface PendingDecisionCheck {
  shouldPrompt: boolean;
  reason: string | null;
  ratio: number | null;
}

export function isTightRemainingWindow(remainingMinutes: number): boolean {
  return remainingMinutes <= PARKING_CONFIG.SCHEDULE_TIGHT_THRESHOLD_MINUTES;
}

export function rankDockCandidates(
  candidates: DockSchedulerCandidate[],
  remainingMinutes: number,
  context: DockSchedulerContext = {},
): DockCandidateScore[] {
  const scored = candidates.map(candidate => scoreDockCandidate(candidate, remainingMinutes, context));
  scored.sort((a, b) => compareCandidateScore(a, b));
  return scored;
}

export function checkPendingDecisionMismatch(
  candidate: DockSchedulerCandidate | null,
  remainingMinutes: number,
): PendingDecisionCheck {
  if (!candidate || candidate.expectedMinutes == null || candidate.expectedMinutes <= 0 || remainingMinutes <= 0) {
    return { shouldPrompt: false, reason: null, ratio: null };
  }

  const ratio = candidate.expectedMinutes / remainingMinutes;
  if (ratio > PARKING_CONFIG.SCHEDULE_CANDIDATE_C_TOO_LONG_RATIO) {
    return {
      shouldPrompt: true,
      ratio,
      reason: '候选任务预计时长严重超出主任务剩余等待窗口',
    };
  }

  if (ratio < PARKING_CONFIG.SCHEDULE_CANDIDATE_C_TOO_SHORT_RATIO) {
    return {
      shouldPrompt: true,
      ratio,
      reason: '候选任务预计时长远低于主任务剩余等待窗口',
    };
  }

  return { shouldPrompt: false, reason: null, ratio };
}

export function createRuleDecision(params: {
  type: DockRuleDecisionType;
  reason: string;
  rootTaskId?: string;
  recommendedTaskIds?: string[];
  remainingMinutes?: number;
  ratio?: number | null;
  createdAt?: string;
}): DockRuleDecision {
  return {
    type: params.type,
    reason: params.reason,
    rootTaskId: params.rootTaskId,
    recommendedTaskIds: params.recommendedTaskIds ?? [],
    remainingMinutes: params.remainingMinutes,
    ratio: params.ratio ?? null,
    createdAt: params.createdAt ?? new Date().toISOString(),
  };
}

function scoreDockCandidate(
  candidate: DockSchedulerCandidate,
  remainingMinutes: number,
  context: DockSchedulerContext,
): DockCandidateScore {
  const waitFitMode = context.waitFitMode ?? 'strict';
  const lowLoadWithWait = candidate.load === 'low' && (candidate.waitMinutes ?? 0) > 0 ? 1 : 0;
  const lowLoad = candidate.load === 'low' ? 1 : 0;
  const comboSelectLane = candidate.lane === 'combo-select' ? 1 : 0;
  const relationStrength = resolveRelationStrength(candidate);
  const waitWindowFitScore = computeWaitWindowFitScore(candidate.expectedMinutes, remainingMinutes, waitFitMode);
  const loadTransitionBonus = computeLoadTransitionBonus(candidate.load, context.rootLoad ?? null);
  const projectSwitchPenalty = computeProjectSwitchPenalty(
    candidate.sourceProjectId ?? null,
    context.rootProjectId ?? null,
  );
  const timeMatchBucket = computeTimeMatchBucket(candidate.expectedMinutes, remainingMinutes, waitFitMode);
  const manualOrderWeight = Number.isFinite(candidate.manualOrder)
    ? -Math.max(0, Number(candidate.manualOrder))
    : Number.MIN_SAFE_INTEGER;
  const orderWeight = -candidate.dockedOrder;

  let score = 0;
  // lowLoadWithWait 累计：低负荷 + 等待双重奖励（设计意图是低负荷等待任务获得额外优先级）
  if (lowLoadWithWait) {
    score += PARKING_CONFIG.SCHEDULE_LOW_LOAD_WEIGHT + PARKING_CONFIG.SCHEDULE_WAIT_CHILD_WEIGHT;
  }
  score += lowLoad ? PARKING_CONFIG.SCHEDULE_LOW_LOAD_WEIGHT : PARKING_CONFIG.SCHEDULE_HIGH_LOAD_WEIGHT;
  score += comboSelectLane ? PARKING_CONFIG.SCHEDULE_STRONG_ZONE_WEIGHT : PARKING_CONFIG.SCHEDULE_WEAK_ZONE_WEIGHT;
  score += relationStrength;
  score += waitWindowFitScore;
  score += loadTransitionBonus;
  score += projectSwitchPenalty;

  if (timeMatchBucket >= 4) {
    score += PARKING_CONFIG.SCHEDULE_TIME_TIGHT_MATCH_WEIGHT;
  } else if (timeMatchBucket === 3) {
    score += PARKING_CONFIG.SCHEDULE_TIME_NORMAL_MATCH_WEIGHT;
  } else if (timeMatchBucket === 2) {
    score += PARKING_CONFIG.SCHEDULE_TIME_SMALL_OVERRUN_WEIGHT;
  } else if (timeMatchBucket === 1) {
    score += PARKING_CONFIG.SCHEDULE_WAIT_CHILD_WEIGHT;
  } else {
    score += PARKING_CONFIG.SCHEDULE_TIME_MISMATCH_PENALTY;
  }

  return {
    taskId: candidate.taskId,
    expectedMinutes: candidate.expectedMinutes,
    score,
    priority: {
      lowLoadWithWait,
      lowLoad,
      comboSelectLane,
      relationStrength,
      waitWindowFitScore,
      loadTransitionBonus,
      projectSwitchPenalty,
      timeMatchBucket,
      manualOrderWeight,
      orderWeight,
    },
  };
}

function computeTimeMatchBucket(
  expectedMinutes: number | null,
  remainingMinutes: number,
  waitFitMode: DockWaitFitMode,
): number {
  // GAP-3: ignore-wait 模式下返回中性桶位，不参与时间匹配评分
  if (waitFitMode === 'ignore-wait') return 2;
  if (remainingMinutes <= 0) return 0;
  // ROBUSTNESS-1: 未填写预计时长的任务返回中性桶位（而非低桶位），避免空属性任务被过度惩罚
  if (expectedMinutes == null || expectedMinutes <= 0) return 2;

  if (waitFitMode === 'relaxed') {
    const ratio = expectedMinutes / remainingMinutes;
    if (ratio >= 0.65 && ratio <= 1.6) {
      return 3;
    }
    if (ratio >= 0.3 && ratio <= 2.4) {
      return 2;
    }
    if (ratio <= 4) {
      return 1;
    }
    return 0;
  }

  const diff = expectedMinutes - remainingMinutes;
  if (Math.abs(diff) <= PARKING_CONFIG.SCHEDULE_TIGHT_REMAINING_MINUTES) {
    return 4;
  }
  if (diff <= 0) {
    return 3;
  }
  if (diff <= PARKING_CONFIG.SCHEDULE_OVER_RUN_ALLOWANCE_MINUTES) {
    return 2;
  }
  return 0;
}

function compareCandidateScore(a: DockCandidateScore, b: DockCandidateScore): number {
  // 排序优先级（收口后）：手动顺序 > 调度分数 > 其他弱上下文细分。
  if (a.priority.manualOrderWeight !== b.priority.manualOrderWeight) {
    return b.priority.manualOrderWeight - a.priority.manualOrderWeight;
  }
  if (a.score !== b.score) {
    return b.score - a.score;
  }
  if (a.priority.lowLoadWithWait !== b.priority.lowLoadWithWait) {
    return b.priority.lowLoadWithWait - a.priority.lowLoadWithWait;
  }
  if (a.priority.relationStrength !== b.priority.relationStrength) {
    return b.priority.relationStrength - a.priority.relationStrength;
  }
  if (a.priority.lowLoad !== b.priority.lowLoad) {
    return b.priority.lowLoad - a.priority.lowLoad;
  }
  if (a.priority.comboSelectLane !== b.priority.comboSelectLane) {
    return b.priority.comboSelectLane - a.priority.comboSelectLane;
  }
  if (a.priority.waitWindowFitScore !== b.priority.waitWindowFitScore) {
    return b.priority.waitWindowFitScore - a.priority.waitWindowFitScore;
  }
  if (a.priority.loadTransitionBonus !== b.priority.loadTransitionBonus) {
    return b.priority.loadTransitionBonus - a.priority.loadTransitionBonus;
  }
  if (a.priority.projectSwitchPenalty !== b.priority.projectSwitchPenalty) {
    return b.priority.projectSwitchPenalty - a.priority.projectSwitchPenalty;
  }
  if (a.priority.timeMatchBucket !== b.priority.timeMatchBucket) {
    return b.priority.timeMatchBucket - a.priority.timeMatchBucket;
  }
  if (a.priority.orderWeight !== b.priority.orderWeight) {
    return b.priority.orderWeight - a.priority.orderWeight;
  }
  return a.taskId.localeCompare(b.taskId);
}

function resolveRelationStrength(candidate: DockSchedulerCandidate): number {
  const raw = candidate.relationScore;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const capped = Math.max(0, Math.min(PARKING_CONFIG.SCHEDULE_RELATION_SCORE_CAP, raw));
    return Math.round((capped / PARKING_CONFIG.SCHEDULE_RELATION_SCORE_CAP) * PARKING_CONFIG.SCHEDULE_RELATION_STRONG_WEIGHT);
  }
  return candidate.lane === 'combo-select'
    ? PARKING_CONFIG.SCHEDULE_RELATION_STRONG_WEIGHT
    : PARKING_CONFIG.SCHEDULE_RELATION_WEAK_WEIGHT;
}

function computeWaitWindowFitScore(
  expectedMinutes: number | null,
  remainingMinutes: number,
  waitFitMode: DockWaitFitMode,
): number {
  // GAP-3: ignore-wait 模式下忽略等待时间匹配，返回中性分数
  if (waitFitMode === 'ignore-wait') {
    return Math.floor(PARKING_CONFIG.SCHEDULE_WAIT_WINDOW_FIT_WEIGHT * 0.5);
  }
  if (remainingMinutes <= 0) return 0;
  if (expectedMinutes == null || expectedMinutes <= 0) {
    return Math.floor(
      PARKING_CONFIG.SCHEDULE_WAIT_WINDOW_FIT_WEIGHT * (waitFitMode === 'relaxed' ? 0.45 : 0.35),
    );
  }
  if (waitFitMode === 'relaxed') {
    const ratio = expectedMinutes / remainingMinutes;
    if (ratio >= 0.7 && ratio <= 1.5) {
      return Math.floor(PARKING_CONFIG.SCHEDULE_WAIT_WINDOW_FIT_WEIGHT * 0.85);
    }
    if (ratio >= 0.35 && ratio <= 2.25) {
      return Math.floor(PARKING_CONFIG.SCHEDULE_WAIT_WINDOW_FIT_WEIGHT * 0.55);
    }
    if (ratio >= 0.15 && ratio <= 4) {
      return Math.floor(PARKING_CONFIG.SCHEDULE_WAIT_WINDOW_FIT_WEIGHT * 0.25);
    }
    return Math.floor(PARKING_CONFIG.SCHEDULE_WAIT_WINDOW_FIT_WEIGHT * 0.1);
  }
  const ratio = expectedMinutes / remainingMinutes;
  if (ratio >= 0.85 && ratio <= 1.15) {
    return PARKING_CONFIG.SCHEDULE_WAIT_WINDOW_FIT_WEIGHT;
  }
  if (ratio >= 0.6 && ratio <= 1.35) {
    return Math.floor(PARKING_CONFIG.SCHEDULE_WAIT_WINDOW_FIT_WEIGHT * 0.65);
  }
  if (ratio >= 0.35 && ratio <= 1.65) {
    return Math.floor(PARKING_CONFIG.SCHEDULE_WAIT_WINDOW_FIT_WEIGHT * 0.35);
  }
  return 0;
}

function computeLoadTransitionBonus(candidateLoad: CognitiveLoad, rootLoad: CognitiveLoad | null): number {
  if (!rootLoad) return 0;
  if (rootLoad === 'high' && candidateLoad === 'low') {
    return PARKING_CONFIG.SCHEDULE_LOAD_TRANSITION_LOW_BONUS;
  }
  if (rootLoad === 'high' && candidateLoad === 'high') {
    return PARKING_CONFIG.SCHEDULE_LOAD_TRANSITION_HIGH_PENALTY;
  }
  return 0;
}

function computeProjectSwitchPenalty(candidateProjectId: string | null, rootProjectId: string | null): number {
  if (!candidateProjectId || !rootProjectId) return 0;
  if (candidateProjectId === rootProjectId) return 0;
  return PARKING_CONFIG.SCHEDULE_PROJECT_SWITCH_PENALTY;
}

function computeSameProjectPriority(candidateProjectId: string | null, rootProjectId: string | null): number {
  if (!candidateProjectId || !rootProjectId) return 0;
  return candidateProjectId === rootProjectId ? 1 : 0;
}

// 三维推荐：同源推进 / 认知降低 / 异步并发
export function computeThreeDimensionalRecommendation(
  mainTask: FocusTaskSlot,
  pendingTasks: FocusTaskSlot[],
  remainingWaitMin: number,
  waitFitMode: DockWaitFitMode = 'strict',
): RecommendationGroup[] {
  // 防御负值：等待时间不可能为负
  const safeRemainingWaitMin = Math.max(0, remainingWaitMin);
  const assigned = new Set<string>();
  const preferLongTask = safeRemainingWaitMin >= PARKING_CONFIG.RECOMMENDATION_OVERSIZED_THRESHOLD_MINUTES;
  const relaxedUpperBoundMinutes = Math.max(safeRemainingWaitMin, 1) * 4;
  const compareByWindowFit = (a: FocusTaskSlot, b: FocusTaskSlot): number => {
    const aExec = effectiveExecMin(a);
    const bExec = effectiveExecMin(b);
    const aDiff = Math.abs(aExec - safeRemainingWaitMin);
    const bDiff = Math.abs(bExec - safeRemainingWaitMin);
    if (aDiff !== bDiff) return aDiff - bDiff;
    return preferLongTask ? bExec - aExec : aExec - bExec;
  };
  const allowEstimatedWindow = (task: FocusTaskSlot): boolean =>
    waitFitMode === 'ignore-wait'
      || (waitFitMode === 'relaxed'
        ? (task.estimatedMinutes == null || task.estimatedMinutes <= relaxedUpperBoundMinutes)
        : (task.estimatedMinutes ?? Number.POSITIVE_INFINITY) <= safeRemainingWaitMin);
  const allowExecWindow = (task: FocusTaskSlot): boolean =>
    waitFitMode === 'ignore-wait'
      || (waitFitMode === 'relaxed'
        ? effectiveExecMin(task) <= relaxedUpperBoundMinutes
        : effectiveExecMin(task) <= safeRemainingWaitMin);

  const homologousAdvancement = pendingTasks
    .filter(
      task =>
        task.sourceProjectId != null &&
        task.sourceProjectId === mainTask.sourceProjectId &&
        allowEstimatedWindow(task) &&
        !assigned.has(task.slotId),
    )
    .sort(compareByWindowFit)
    .slice(0, 2);
  homologousAdvancement.forEach(task => assigned.add(task.slotId));

  // 认知降低组：仅在主任务为高负荷时推荐低负荷任务（GAP-3 修复）
  const cognitiveDowngrade = mainTask.cognitiveLoad === 'high'
    ? pendingTasks
        .filter(
          task =>
            task.cognitiveLoad === 'low' &&
            allowEstimatedWindow(task) &&
            !assigned.has(task.slotId),
        )
        .sort((a, b) => {
          const aSameProject = a.sourceProjectId === mainTask.sourceProjectId ? 1 : 0;
          const bSameProject = b.sourceProjectId === mainTask.sourceProjectId ? 1 : 0;
          if (aSameProject !== bSameProject) return bSameProject - aSameProject;
          return compareByWindowFit(a, b);
        })
        .slice(0, 2)
    : [];
  cognitiveDowngrade.forEach(task => assigned.add(task.slotId));

  const asynchronousBoot = pendingTasks
    .filter(
      task =>
        (task.waitMinutes ?? 0) > 0 &&
        allowExecWindow(task) &&
        !assigned.has(task.slotId),
    )
    .sort(
      (a, b) =>
        (b.waitMinutes ?? 0) - (a.waitMinutes ?? 0)
        || compareByWindowFit(a, b),
    )
    .slice(0, 2);

  const allEmpty =
    homologousAdvancement.length === 0 &&
    cognitiveDowngrade.length === 0 &&
    asynchronousBoot.length === 0;

  if (allEmpty && pendingTasks.length > 0) {
    if (
      waitFitMode === 'strict'
      && safeRemainingWaitMin >= PARKING_CONFIG.RECOMMENDATION_OVERSIZED_THRESHOLD_MINUTES
    ) {
      return computeOversizedFallback(mainTask, pendingTasks);
    }

    return [
      { type: 'homologous-advancement', candidates: [] },
      { type: 'cognitive-downgrade', candidates: [] },
      { type: 'asynchronous-boot', candidates: [] },
    ];
  }

  return [
    { type: 'homologous-advancement', candidates: homologousAdvancement },
    { type: 'cognitive-downgrade', candidates: cognitiveDowngrade },
    { type: 'asynchronous-boot', candidates: asynchronousBoot },
  ];
}

function computeOversizedFallback(
  mainTask: FocusTaskSlot,
  pendingTasks: FocusTaskSlot[],
): RecommendationGroup[] {
  // L-6 fix: 跨组去重，避免同一任务出现在多个推荐组中
  const usedIds = new Set<string>();

  const sameProject = pendingTasks
    .filter(task => task.sourceProjectId != null && task.sourceProjectId === mainTask.sourceProjectId)
    .sort((a, b) => (a.estimatedMinutes ?? Number.POSITIVE_INFINITY) - (b.estimatedMinutes ?? Number.POSITIVE_INFINITY))
    .slice(0, 1);
  for (const t of sameProject) usedIds.add(t.slotId);

  const lowLoad = pendingTasks
    .filter(task => task.cognitiveLoad === 'low' && !usedIds.has(task.slotId))
    .sort((a, b) => (a.estimatedMinutes ?? Number.POSITIVE_INFINITY) - (b.estimatedMinutes ?? Number.POSITIVE_INFINITY))
    .slice(0, 1);
  for (const t of lowLoad) usedIds.add(t.slotId);

  const hasWait = pendingTasks
    .filter(task => (task.waitMinutes ?? 0) > 0 && !usedIds.has(task.slotId))
    .sort((a, b) => effectiveExecMin(a) - effectiveExecMin(b))
    .slice(0, 1);

  return [
    { type: 'homologous-advancement', candidates: sameProject, isOversized: true },
    { type: 'cognitive-downgrade', candidates: lowLoad, isOversized: true },
    { type: 'asynchronous-boot', candidates: hasWait, isOversized: true },
  ];
}

// 有效执行时长 = 预计时长 - 等待时长
export function effectiveExecMin(task: FocusTaskSlot): number {
  return Math.max(0, (task.estimatedMinutes ?? 0) - (task.waitMinutes ?? 0));
}

// 穿插任务评分（用于空窗期）
export function computeInterludeScore(task: FocusTaskSlot, remainingWaitMs: number): number {
  const remainingMin = remainingWaitMs / 60_000;
  if (!task.estimatedMinutes) return 5;

  const exec = effectiveExecMin(task);
  if (exec > remainingMin * 1.5) return 2;

  const timeFitScore = exec > remainingMin * 0.2 ? 25 : 10;
  const loadScore = task.cognitiveLoad === 'low' ? 20 : 0;
  const waitBonusScore = task.waitMinutes ? 15 : 0;
  const zoneScore = task.zone === 'combo-select' ? 10 : 5;
  return timeFitScore + loadScore + waitBonusScore + zoneScore;
}

export function selectInterludeTasks(
  waitingTask: FocusTaskSlot,
  candidates: FocusTaskSlot[],
): FocusTaskSlot[] {
  const remainingWaitMs = computeSlotRemainingWaitMs(waitingTask);

  return candidates
    .map(task => ({ task, score: computeInterludeScore(task, remainingWaitMs) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(({ task }) => task);
}

function computeSlotRemainingWaitMs(task: FocusTaskSlot): number {
  if (!task.waitEndAt) return 0;
  return Math.max(0, task.waitEndAt - Date.now());
}

// 2h 窗口内高负荷完成次数达到阈值即判定倦怠
export function checkBurnoutThreshold(
  counter: { count: number; windowStartAt: number },
  now: number = Date.now(),
): boolean {
  if (now - counter.windowStartAt > PARKING_CONFIG.BURNOUT_WINDOW_MS) return false;
  return counter.count >= PARKING_CONFIG.BURNOUT_HIGH_LOAD_THRESHOLD;
}

export function updateHighLoadCounter(
  counter: { count: number; windowStartAt: number },
  now: number = Date.now(),
): { count: number; windowStartAt: number } {
  if (now - counter.windowStartAt > PARKING_CONFIG.BURNOUT_WINDOW_MS) {
    return { count: 1, windowStartAt: now };
  }
  return { count: counter.count + 1, windowStartAt: counter.windowStartAt };
}

export function assignZonesOnFocusStart(
  tasks: FocusTaskSlot[],
  mainTaskSlotId: string,
): ZoneAssignment[] {
  const main = tasks.find(task => task.slotId === mainTaskSlotId);
  if (!main) {
    return [
      { zone: 'command', tasks: [] },
      { zone: 'combo-select', tasks: [] },
      { zone: 'backup', tasks: [] },
    ];
  }

  const rest = tasks.filter(task => task.slotId !== mainTaskSlotId);
  const mainWaitMin = main.estimatedMinutes ?? 60;

  const recommendation = computeThreeDimensionalRecommendation(main, rest, mainWaitMin);
  const comboSelectIds = new Set(recommendation.flatMap(group => group.candidates.map(task => task.slotId)));

  const commandStack = rest.filter(task => !comboSelectIds.has(task.slotId)).slice(0, 3);
  const comboTasks = rest.filter(task => comboSelectIds.has(task.slotId));
  const commandStackIds = new Set(commandStack.map(task => task.slotId));
  const backupTasks = rest.filter(
    task => !comboSelectIds.has(task.slotId) && !commandStackIds.has(task.slotId),
  );

  return [
    { zone: 'command', tasks: [main, ...commandStack] },
    { zone: 'combo-select', tasks: comboTasks },
    { zone: 'backup', tasks: backupTasks },
  ];
}

export function determineFragmentDefenseLevel(
  shortestWaitMinutes: number,
  hasBurnout: boolean,
): 1 | 2 | 3 | 4 {
  if (hasBurnout) return 2;
  if (shortestWaitMinutes <= PARKING_CONFIG.FRAGMENT_PASSIVE_THRESHOLD_MINUTES) return 1;
  if (shortestWaitMinutes <= 15) return 2;
  if (shortestWaitMinutes <= 25) return 3;
  return 4;
}

/**
 * 判断候选任务预计时长与主任务剩余等待窗口的匹配度。
 *
 * 分支边界定义（互斥、无重叠）：
 *   blank-period:       remainingMin ≤ TIGHT_THRESHOLD
 *   tight-blank:        exec > 75% remaining（候选过大，留白紧张）
 *   time-match:         56.25% remaining ≤ exec ≤ 75% remaining 且 exec ≤ 150% remaining
 *   mismatch-recompute: 其他所有情况（候选时长偏差过大，需重算）
 */
export function evaluateTimeRemaining(
  remainingMin: number,
  candidateEffectiveExecMin: number | null,
): 'blank-period' | 'tight-blank' | 'time-match' | 'mismatch-recompute' {
  if (remainingMin <= PARKING_CONFIG.SCHEDULE_TIGHT_THRESHOLD_MINUTES) {
    return 'blank-period';
  }

  if (candidateEffectiveExecMin == null) return 'time-match';

  // tight-blank：候选执行时长 **严格大于** 75% 剩余窗口
  if (candidateEffectiveExecMin > remainingMin * 0.75) {
    return 'tight-blank';
  }

  // time-match：候选在 [56.25%, 75%] 区间且不超过 150% 剩余窗口
  // 注意：上界使用 <= 0.75，与 tight-blank 的 > 0.75 互斥
  const lowerBound = remainingMin * 0.5625; // 0.75 * 0.75
  if (
    candidateEffectiveExecMin >= lowerBound &&
    candidateEffectiveExecMin <= remainingMin * 1.5
  ) {
    return 'time-match';
  }

  return 'mismatch-recompute';
}
