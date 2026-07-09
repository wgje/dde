import { PARKING_CONFIG } from '../config/parking.config';
import type {
  CognitiveLoad,
  DockEntry,
  DockLane,
  DockSourceSection,
  DockTaskStatus,
  DockZoneSource,
} from '../models/parking-dock';
import { sanitizePlannerFields } from '../utils/planner-fields';

export interface NormalizeDockSnapshotEntryOptions {
  raw: unknown;
  muteWaitTone: boolean;
}

export function normalizeDockSnapshotEntry(
  options: NormalizeDockSnapshotEntryOptions,
): DockEntry | null {
  if (!options.raw || typeof options.raw !== 'object') {
    return null;
  }

  const source = options.raw as Partial<DockEntry>;
  if (!source.taskId || typeof source.taskId !== 'string' || !source.taskId.trim()) {
    return null;
  }

  const enumFields = normalizeEntryEnumFields(source);
  const plannerFields = sanitizePlannerFields({
    expectedMinutes: source.expectedMinutes,
    waitMinutes: source.waitMinutes,
    cognitiveLoad: enumFields.load,
  });

  return {
    taskId: source.taskId,
    title: normalizeEntryTitle(source.title),
    sourceProjectId: typeof source.sourceProjectId === 'string' ? source.sourceProjectId : null,
    status: enumFields.status,
    load: plannerFields.cognitiveLoad ?? enumFields.load,
    expectedMinutes: plannerFields.expectedMinutes,
    waitMinutes: plannerFields.waitMinutes,
    waitStartedAt: normalizeWaitStartedAt(source.waitStartedAt),
    lane: enumFields.lane,
    zoneSource: enumFields.zoneSource,
    isMain: Boolean(source.isMain),
    dockedOrder: Number.isFinite(source.dockedOrder) ? Number(source.dockedOrder) : 0,
    manualOrder: normalizeNullableNumber(source.manualOrder) ?? undefined,
    detail: normalizeEntryDetail(source.detail),
    sourceKind: enumFields.sourceKind,
    sourceBlackBoxEntryId: normalizeOptionalString(source.sourceBlackBoxEntryId),
    inlineArchiveStatus: enumFields.inlineArchiveStatus,
    inlineArchivedTaskId: normalizeOptionalString(source.inlineArchivedTaskId),
    systemSelected: Boolean(source.systemSelected),
    recommendedScore: normalizeNullableNumber(source.recommendedScore),
    sourceSection: normalizeSourceSection(source.sourceSection),
    manualMainSelected: Boolean(source.manualMainSelected),
    recommendationLocked: Boolean(source.recommendationLocked),
    snoozeRingMuted: source.snoozeRingMuted === undefined
      ? options.muteWaitTone
      : Boolean(source.snoozeRingMuted),
    relationScore: normalizeNullableNumber(source.relationScore),
    relationReason: normalizeOptionalString(source.relationReason),
  };
}

function normalizeEntryEnumFields(source: Partial<DockEntry>): {
  status: DockEntry['status'];
  lane: DockLane;
  zoneSource: DockZoneSource;
  load: CognitiveLoad;
  sourceKind: DockEntry['sourceKind'];
  inlineArchiveStatus: DockEntry['inlineArchiveStatus'];
} {
  const sourceKind: DockEntry['sourceKind'] =
    source.sourceKind === 'dock-created' ? 'dock-created' : 'project-task';

  return {
    status: normalizeStatus(source.status),
    lane: normalizeEntryLane(source),
    zoneSource: source.zoneSource === 'manual' ? 'manual' : 'auto',
    load: source.load === 'high' ? 'high' : 'low',
    sourceKind,
    inlineArchiveStatus: normalizeInlineArchiveStatus(source, sourceKind),
  };
}

function normalizeEntryLane(source: Partial<DockEntry>): DockLane {
  const rawLane = (source as { lane?: unknown; zone?: unknown }).lane
    ?? (source as { zone?: unknown }).zone;
  return rawLane === 'combo-select' || rawLane === 'strong'
    ? 'combo-select'
    : 'backup';
}

function normalizeInlineArchiveStatus(
  source: Partial<DockEntry>,
  sourceKind: DockEntry['sourceKind'],
): DockEntry['inlineArchiveStatus'] {
  if (
    source.inlineArchiveStatus === 'archiving' ||
    source.inlineArchiveStatus === 'archived' ||
    source.inlineArchiveStatus === 'failed' ||
    source.inlineArchiveStatus === 'pending'
  ) {
    return source.inlineArchiveStatus;
  }

  return sourceKind === 'dock-created' ? 'pending' : undefined;
}

function normalizeEntryTitle(value: unknown): string {
  return typeof value === 'string'
    ? value.slice(0, PARKING_CONFIG.MAX_ENTRY_TITLE_LENGTH)
    : 'Untitled task';
}

function normalizeEntryDetail(value: unknown): string {
  return typeof value === 'string'
    ? value.slice(0, PARKING_CONFIG.MAX_ENTRY_DETAIL_LENGTH)
    : '';
}

function normalizeWaitStartedAt(value: unknown): string | null {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null;
}

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function normalizeStatus(status: DockEntry['status'] | undefined): DockTaskStatus {
  if (
    status === 'focusing' ||
    status === 'suspended_waiting' ||
    status === 'wait_finished' ||
    status === 'stalled' ||
    status === 'completed'
  ) {
    return status;
  }
  return 'pending_start';
}

function normalizeNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return numeric;
}

function normalizeSourceSection(value: unknown): DockSourceSection | undefined {
  if (value === 'text' || value === 'flow' || value === 'dock-create') {
    return value;
  }
  return undefined;
}
