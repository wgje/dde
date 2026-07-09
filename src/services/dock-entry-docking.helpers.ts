import { PARKING_CONFIG } from '../config/parking.config';
import type {
  CognitiveLoad,
  DockEntry,
  DockLane,
  DockSourceSection,
  DockZoneSource,
} from '../models/parking-dock';
import type { Task } from '../models';
import { sanitizePlannerFields, type PlannerFieldSet } from '../utils/planner-fields';
import { buildDockEntry } from './dock-engine.utils';

export interface DockLaneInference {
  lane: DockLane;
  relationScore: number | null;
  relationReason: string | null;
}

export interface DockTaskPrepareOptions {
  sourceKind?: DockEntry['sourceKind'];
  sourceSection?: DockSourceSection;
  load?: CognitiveLoad;
  expectedMinutes?: number | null;
  waitMinutes?: number | null;
  detail?: string;
  zoneSource?: DockZoneSource;
}

export interface PrepareDockTaskEntryParams {
  taskId: string;
  task: Task;
  lane?: DockLane;
  sourceProjectId: string | null;
  currentEntryCount: number;
  muteWaitTone: boolean;
  options?: DockTaskPrepareOptions;
  inferAutoLane: () => DockLaneInference;
}

export interface PreparedDockTaskEntry {
  entry: DockEntry;
  plannerFields: PlannerFieldSet;
}

export function prepareDockTaskEntry(
  params: PrepareDockTaskEntryParams,
): PreparedDockTaskEntry {
  const zoneSource: DockZoneSource = params.options?.zoneSource
    ?? (params.lane ? 'manual' : 'auto');
  const inferredRelation = params.lane
    ? manualDockLaneInference(params.lane)
    : params.inferAutoLane();
  const inheritedLoad: CognitiveLoad = params.task.cognitive_load === 'high' ? 'high' : 'low';
  const plannerFields = sanitizePlannerFields({
    expectedMinutes: params.options?.expectedMinutes ?? params.task.expected_minutes,
    waitMinutes: params.options?.waitMinutes ?? params.task.wait_minutes,
    cognitiveLoad: params.options?.load ?? params.task.cognitive_load,
  });

  return {
    plannerFields,
    entry: buildDockEntry({
      taskId: params.taskId,
      title: params.task.title || 'Untitled task',
      content: params.task.content ?? null,
      sourceProjectId: params.sourceProjectId,
      currentEntryCount: params.currentEntryCount,
      lane: inferredRelation.lane,
      zoneSource,
      relationScore: inferredRelation.relationScore,
      relationReason: inferredRelation.relationReason,
      plannerFields,
      inheritedLoad,
      muteWaitTone: params.muteWaitTone,
      options: {
        sourceKind: params.options?.sourceKind,
        sourceSection: params.options?.sourceSection,
        detail: params.options?.detail,
      },
    }),
  };
}

function manualDockLaneInference(lane: DockLane): DockLaneInference {
  return {
    lane,
    relationScore: lane === 'combo-select'
      ? PARKING_CONFIG.ZONE_MANUAL_COMBO_SCORE
      : PARKING_CONFIG.ZONE_MANUAL_BACKUP_SCORE,
    relationReason: lane === 'combo-select' ? 'manual:combo-select' : 'manual:backup',
  };
}
