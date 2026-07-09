import {
  DockEntry,
  FocusTaskSlot,
  RecommendationGroup,
  RecommendationGroupType,
} from '../models/parking-dock';
import {
  type DockCandidateScore,
  type DockWaitFitMode,
  computeThreeDimensionalRecommendation,
  rankDockCandidates,
} from './dock-scheduler.rules';
import { isAutoPromotableStatus, toFocusTaskSlot, toSchedulerCandidate } from './dock-engine.utils';

export interface DockRecommendationBaseInput {
  entries: readonly DockEntry[];
  rootEntry: DockEntry;
  excludedTaskIds: readonly string[];
  remainingMinutes: number;
  resolveSourceProjectId: (entry: DockEntry) => string | null;
}

export interface BuildDockRecommendationCandidateGroupsInput extends DockRecommendationBaseInput {
  waitFitMode?: DockWaitFitMode;
  onRawGroups?: (groups: RecommendationGroup[]) => void;
}

export interface BuildDockTwoStageRecommendationCandidateGroupsInput extends DockRecommendationBaseInput {
  candidateLimit: number;
  onRawGroups?: (groups: RecommendationGroup[]) => void;
}

export type DockRecommendationCandidateGroup = {
  type: RecommendationGroupType;
  taskIds: string[];
};

export type DockTwoStageRecommendationMode = DockWaitFitMode | 'ranked-fallback' | 'none';

export interface DockTwoStageRecommendationResult {
  groups: DockRecommendationCandidateGroup[];
  mode: DockTwoStageRecommendationMode;
}

export interface RankDockRecommendedCandidatesInput extends DockRecommendationBaseInput {
  waitFitMode?: DockWaitFitMode;
}

export function buildDockRecommendationCandidateGroups(
  input: BuildDockRecommendationCandidateGroupsInput,
): DockRecommendationCandidateGroup[] {
  const excluded = buildExcludedTaskSet(input.excludedTaskIds);
  const mainSlot = toDockRecommendationSlot(input.rootEntry, 'command', 0, input.resolveSourceProjectId);
  const pendingEntries = findAutoPromotableEntries(input.entries, excluded);
  const pendingSlots = pendingEntries.map((entry, idx) =>
    toDockRecommendationSlot(entry, entry.lane, idx, input.resolveSourceProjectId),
  );
  const groups = computeThreeDimensionalRecommendation(
    mainSlot,
    pendingSlots,
    input.remainingMinutes,
    input.waitFitMode ?? 'strict',
  );
  input.onRawGroups?.(groups);

  return compactRecommendationGroups(groups);
}

export function buildDockTwoStageRecommendationCandidateGroups(
  input: BuildDockTwoStageRecommendationCandidateGroupsInput,
): DockTwoStageRecommendationResult {
  for (const waitFitMode of ['strict', 'relaxed', 'ignore-wait'] as const) {
    const groups = buildDockRecommendationCandidateGroups({
      ...input,
      waitFitMode,
    });
    if (groups.length > 0) {
      return { groups, mode: waitFitMode };
    }
  }

  const fallbackGroups = buildDockRankedFallbackGroups(input);
  if (fallbackGroups.length > 0) {
    return { groups: fallbackGroups, mode: 'ranked-fallback' };
  }

  return { groups: [], mode: 'none' };
}

export function buildDockRankedFallbackGroups(
  input: BuildDockTwoStageRecommendationCandidateGroupsInput,
): DockRecommendationCandidateGroup[] {
  const ranked = rankDockRecommendedCandidates({
    ...input,
    waitFitMode: 'ignore-wait',
  });
  const candidateIds = ranked.slice(0, input.candidateLimit).map(item => item.taskId);
  if (candidateIds.length === 0) return [];
  return [{ type: 'homologous-advancement', taskIds: candidateIds }];
}

export function rankDockRecommendedCandidates(
  input: RankDockRecommendedCandidatesInput,
): DockCandidateScore[] {
  const excluded = buildExcludedTaskSet(input.excludedTaskIds);
  const candidateEntries = findAutoPromotableEntries(input.entries, excluded);
  return rankDockCandidates(
    candidateEntries.map(entry => toDockSchedulerCandidate(entry, input.resolveSourceProjectId)),
    input.remainingMinutes,
    {
      rootLoad: input.rootEntry.load,
      rootProjectId: input.resolveSourceProjectId(input.rootEntry),
      waitFitMode: input.waitFitMode ?? 'strict',
    },
  );
}

function findAutoPromotableEntries(
  entries: readonly DockEntry[],
  excluded: ReadonlySet<string>,
): DockEntry[] {
  return entries.filter(entry => isAutoPromotableStatus(entry.status) && !excluded.has(entry.taskId));
}

function compactRecommendationGroups(groups: RecommendationGroup[]): DockRecommendationCandidateGroup[] {
  return groups
    .map(group => ({
      type: group.type,
      taskIds: group.candidates
        .map(candidate => candidate.taskId)
        .filter((taskId): taskId is string => typeof taskId === 'string' && taskId.length > 0),
    }))
    .filter(group => group.taskIds.length > 0);
}

function toDockRecommendationSlot(
  entry: DockEntry,
  zone: 'command' | 'combo-select' | 'backup',
  idx: number,
  resolveSourceProjectId: (entry: DockEntry) => string | null,
): FocusTaskSlot {
  return toFocusTaskSlot({
    ...entry,
    sourceProjectId: resolveSourceProjectId(entry),
  }, zone, idx);
}

function toDockSchedulerCandidate(
  entry: DockEntry,
  resolveSourceProjectId: (entry: DockEntry) => string | null,
) {
  return toSchedulerCandidate(entry, resolveSourceProjectId(entry));
}

function buildExcludedTaskSet(excludedTaskIds: readonly string[]): Set<string> {
  return new Set(excludedTaskIds.filter(Boolean));
}
