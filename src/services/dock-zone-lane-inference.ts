import { PARKING_CONFIG } from '../config/parking.config';
import type { Task } from '../models';
import type { DockLane } from '../models/parking-dock';

export type DockAutoLaneInferenceInput = {
  task: Task;
  referenceTask: Task;
  treeDistance: number | null;
  hasDirectConnection: boolean;
};

export type DockAutoLaneInference = {
  lane: DockLane;
  relationScore: number;
  relationReason: string;
};

export function inferDockAutoLane(input: DockAutoLaneInferenceInput): DockAutoLaneInference {
  const reasons: string[] = [];
  const rawScore = scoreStructuralRelation(input, reasons)
    + scoreTreeDistance(input.treeDistance, reasons)
    + scoreStageRelation(input.task, input.referenceTask, reasons);
  const relationScore = Math.max(0, Math.min(100, rawScore));

  return {
    lane: relationScore >= PARKING_CONFIG.ZONE_COMBO_THRESHOLD ? 'combo-select' : 'backup',
    relationScore,
    relationReason: reasons.length > 0
      ? `auto:${reasons.join('|')}`
      : 'auto:same-project-low-relation',
  };
}

function scoreStructuralRelation(
  input: Pick<DockAutoLaneInferenceInput, 'hasDirectConnection' | 'referenceTask' | 'task'>,
  reasons: string[]
): number {
  let score = 0;

  if (input.task.parentId === input.referenceTask.id || input.referenceTask.parentId === input.task.id) {
    score += PARKING_CONFIG.ZONE_SCORE_PARENT_CHILD;
    reasons.push('parent-child');
  }

  if (input.task.parentId && input.referenceTask.parentId && input.task.parentId === input.referenceTask.parentId) {
    score += PARKING_CONFIG.ZONE_SCORE_SHARED_PARENT;
    reasons.push('shared-parent');
  }

  if (input.hasDirectConnection) {
    score += PARKING_CONFIG.ZONE_SCORE_DIRECT_CONNECTION;
    reasons.push('direct-connection');
  }

  return score;
}

function scoreTreeDistance(treeDistance: number | null, reasons: string[]): number {
  if (treeDistance === null || treeDistance < 2) {
    return 0;
  }

  reasons.push(`tree-distance:${treeDistance}`);
  return Math.max(
    PARKING_CONFIG.ZONE_SCORE_TREE_DISTANCE_FLOOR,
    PARKING_CONFIG.ZONE_SCORE_TREE_DISTANCE_BASE - treeDistance * PARKING_CONFIG.ZONE_SCORE_TREE_DISTANCE_STEP,
  );
}

function scoreStageRelation(task: Task, referenceTask: Task, reasons: string[]): number {
  if (task.stage === null || referenceTask.stage === null || task.stage !== referenceTask.stage) {
    return 0;
  }

  reasons.push('same-stage');
  if (Math.abs((task.order ?? 0) - (referenceTask.order ?? 0)) <= 1) {
    reasons.push('adjacent-order');
    return PARKING_CONFIG.ZONE_SCORE_SAME_STAGE + PARKING_CONFIG.ZONE_SCORE_ADJACENT_ORDER;
  }

  return PARKING_CONFIG.ZONE_SCORE_SAME_STAGE;
}
