import { PARKING_CONFIG } from '../../../../config/parking.config';
import type { DockEntry } from '../../../../models/parking-dock';

export type ConsoleCardPoseKey =
  | 'focus'
  | 'depth-1'
  | 'depth-2'
  | 'depth-3'
  | 'offstage-top'
  | 'offstage-bottom'
  | 'offstage-back'
  | 'radar-entry';

export interface ConsoleCardPose {
  translateX: number;
  translateY: number;
  translateZ: number;
  scale: number;
  rotateXDeg: number;
  opacity: number;
  blurPx: number;
  zIndex: number;
}

export type ConsoleCardMotionKind =
  | 'complete-exit'
  | 'complete-shift'
  | 'suspend-exit'
  | 'suspend-shift'
  | 'suspend-return'
  | 'switch-promote'
  | 'switch-shift'
  | 'radar-promote'
  | 'radar-shift'
  | 'radar-evict';

export interface ConsoleCardMotionState {
  renderId: string;
  taskId: string;
  kind: ConsoleCardMotionKind;
  fromPoseKey: ConsoleCardPoseKey;
  toPoseKey: ConsoleCardPoseKey;
  durationMs: number;
  easing: string;
}

export interface ConsoleRenderCard {
  renderId: string;
  taskId: string;
  entry: DockEntry;
  poseKey: ConsoleCardPoseKey;
  interactionEnabled: boolean;
  transient: 'stable' | 'exit-clone';
}

export interface ConsoleCardMotionBatch {
  durationMs: number;
  renderCards: ConsoleRenderCard[];
  motions: ConsoleCardMotionState[];
}

interface EntrySnapshot {
  entry: DockEntry;
  index: number;
}

interface BuildConsoleMotionBatchOptions {
  durationMs: number;
  preEntries: DockEntry[];
  postEntries: DockEntry[];
  easing?: string;
  defaultShiftKind: ConsoleCardMotionKind;
  defaultNewFromPoseKey?: ConsoleCardPoseKey;
  defaultNewKind?: ConsoleCardMotionKind;
  postOverrides?: ReadonlyMap<
    string,
    {
      fromPoseKey?: ConsoleCardPoseKey;
      kind?: ConsoleCardMotionKind;
    }
  >;
  removedClones?: Array<{
    taskId: string;
    renderId: string;
    toPoseKey: ConsoleCardPoseKey;
    kind: ConsoleCardMotionKind;
  }>;
}

const consoleMotion = PARKING_CONFIG.MOTION.console;

export const CONSOLE_CARD_POSES: Readonly<Record<ConsoleCardPoseKey, ConsoleCardPose>> = {
  focus: consoleMotion.poses.focus,
  'depth-1': consoleMotion.poses.depth1,
  'depth-2': consoleMotion.poses.depth2,
  'depth-3': consoleMotion.poses.depth3,
  'offstage-top': consoleMotion.poses.offstageTop,
  'offstage-bottom': consoleMotion.poses.offstageBottom,
  'offstage-back': consoleMotion.poses.offstageBack,
  'radar-entry': consoleMotion.poses.radarEntry,
};

export function resolveConsoleCardStablePoseKey(
  entry: Pick<DockEntry, 'status'>,
  index: number,
): ConsoleCardPoseKey {
  if (entry.status === 'focusing') return 'focus';
  const depth = Math.min(Math.max(index, 1), 3);
  return `depth-${depth}` as ConsoleCardPoseKey;
}

export function getConsoleCardPose(poseKey: ConsoleCardPoseKey): ConsoleCardPose {
  return CONSOLE_CARD_POSES[poseKey];
}

export function toConsoleCardTransform(poseKey: ConsoleCardPoseKey): string {
  const pose = getConsoleCardPose(poseKey);
  return `translateX(${pose.translateX}px) translateY(${pose.translateY}px) translateZ(${pose.translateZ}px) scale(${pose.scale}) rotateX(${pose.rotateXDeg}deg)`;
}

export function toConsoleCardFilter(poseKey: ConsoleCardPoseKey): string {
  const pose = getConsoleCardPose(poseKey);
  return pose.blurPx <= 0 ? 'none' : `blur(${pose.blurPx}px)`;
}

export function toConsoleCardOpacity(poseKey: ConsoleCardPoseKey): number {
  return getConsoleCardPose(poseKey).opacity;
}

export function toConsoleCardZIndex(poseKey: ConsoleCardPoseKey): number {
  return getConsoleCardPose(poseKey).zIndex;
}

export function createStableConsoleRenderCards(entries: DockEntry[]): ConsoleRenderCard[] {
  return entries.map((entry, index) => ({
    renderId: entry.taskId,
    taskId: entry.taskId,
    entry,
    poseKey: resolveConsoleCardStablePoseKey(entry, index),
    interactionEnabled: entry.status !== 'focusing',
    transient: 'stable',
  }));
}

export function createConsoleMotionMap(
  motions: readonly ConsoleCardMotionState[],
): Record<string, ConsoleCardMotionState> {
  return Object.fromEntries(motions.map(motion => [motion.renderId, motion]));
}

export function buildCompleteConsoleMotionBatch(
  preEntries: DockEntry[],
  postEntries: DockEntry[],
  completedTaskId: string,
  batchKey: string,
): ConsoleCardMotionBatch {
  return buildConsoleMotionBatch({
    durationMs: Math.max(
      consoleMotion.durationMs.completeExit,
      consoleMotion.durationMs.completeShift,
    ),
    preEntries,
    postEntries,
    defaultShiftKind: 'complete-shift',
    defaultNewFromPoseKey: 'offstage-back',
    removedClones: [
      {
        taskId: completedTaskId,
        renderId: `${completedTaskId}::${batchKey}::complete-exit`,
        toPoseKey: 'offstage-top',
        kind: 'complete-exit',
      },
    ],
  });
}

export function buildSuspendConsoleMotionBatch(
  preEntries: DockEntry[],
  postEntries: DockEntry[],
  suspendedTaskId: string,
  batchKey: string,
): ConsoleCardMotionBatch {
  const postOverrides = new Map<string, { fromPoseKey?: ConsoleCardPoseKey; kind?: ConsoleCardMotionKind }>();
  if (postEntries.some(entry => entry.taskId === suspendedTaskId)) {
    postOverrides.set(suspendedTaskId, {
      fromPoseKey: 'offstage-back',
      kind: 'suspend-return',
    });
  }

  return buildConsoleMotionBatch({
    durationMs: Math.max(
      consoleMotion.durationMs.suspendExit,
      consoleMotion.durationMs.suspendReturn,
    ),
    preEntries,
    postEntries,
    defaultShiftKind: 'suspend-shift',
    defaultNewFromPoseKey: 'offstage-back',
    postOverrides,
    removedClones: [
      {
        taskId: suspendedTaskId,
        renderId: `${suspendedTaskId}::${batchKey}::suspend-exit`,
        toPoseKey: 'offstage-bottom',
        kind: 'suspend-exit',
      },
    ],
  });
}

export function buildSwitchConsoleMotionBatch(
  preEntries: DockEntry[],
  postEntries: DockEntry[],
  promotedTaskId: string,
): ConsoleCardMotionBatch {
  const postOverrides = new Map<string, { fromPoseKey?: ConsoleCardPoseKey; kind?: ConsoleCardMotionKind }>();
  postOverrides.set(promotedTaskId, { kind: 'switch-promote' });
  return buildConsoleMotionBatch({
    durationMs: consoleMotion.durationMs.switch,
    preEntries,
    postEntries,
    defaultShiftKind: 'switch-shift',
    postOverrides,
  });
}

export function buildRadarConsoleMotionBatch(
  preEntries: DockEntry[],
  postEntries: DockEntry[],
  insertedTaskId: string,
  batchKey: string,
): ConsoleCardMotionBatch {
  const preTaskIds = new Set(preEntries.map(entry => entry.taskId));
  const postTaskIds = new Set(postEntries.map(entry => entry.taskId));
  const postOverrides = new Map<string, { fromPoseKey?: ConsoleCardPoseKey; kind?: ConsoleCardMotionKind }>();
  if (!preTaskIds.has(insertedTaskId) && postTaskIds.has(insertedTaskId)) {
    postOverrides.set(insertedTaskId, {
      fromPoseKey: 'radar-entry',
      kind: 'radar-promote',
    });
  }

  const removedClones = preEntries
    .filter(entry => !postTaskIds.has(entry.taskId))
    .map(entry => ({
      taskId: entry.taskId,
      renderId: `${entry.taskId}::${batchKey}::radar-evict`,
      toPoseKey: 'offstage-back' as const,
      kind: 'radar-evict' as const,
    }));

  return buildConsoleMotionBatch({
    durationMs: consoleMotion.durationMs.radar,
    preEntries,
    postEntries,
    defaultShiftKind: 'radar-shift',
    defaultNewFromPoseKey: 'offstage-back',
    postOverrides,
    removedClones,
  });
}

function buildConsoleMotionBatch({
  durationMs,
  preEntries,
  postEntries,
  easing = PARKING_CONFIG.MOTION.easing.enter,
  defaultShiftKind,
  defaultNewFromPoseKey,
  defaultNewKind = defaultShiftKind,
  postOverrides,
  removedClones = [],
}: BuildConsoleMotionBatchOptions): ConsoleCardMotionBatch {
  const preByTaskId = createEntrySnapshotMap(preEntries);
  const renderCards = createStableConsoleRenderCards(postEntries);
  const motions: ConsoleCardMotionState[] = [];

  renderCards.forEach(renderCard => {
    const override = postOverrides?.get(renderCard.taskId);
    const previous = preByTaskId.get(renderCard.taskId);
    const fromPoseKey = override?.fromPoseKey
      ?? (previous
        ? resolveConsoleCardStablePoseKey(previous.entry, previous.index)
        : defaultNewFromPoseKey
          ?? renderCard.poseKey);
    const toPoseKey = renderCard.poseKey;
    if (fromPoseKey === toPoseKey && !override?.kind) return;

    motions.push({
      renderId: renderCard.renderId,
      taskId: renderCard.taskId,
      kind: override?.kind ?? (previous ? defaultShiftKind : defaultNewKind),
      fromPoseKey,
      toPoseKey,
      durationMs,
      easing,
    });
  });

  removedClones.forEach(removed => {
    const previous = preByTaskId.get(removed.taskId);
    if (!previous) return;

    renderCards.push({
      renderId: removed.renderId,
      taskId: removed.taskId,
      entry: previous.entry,
      poseKey: removed.toPoseKey,
      interactionEnabled: false,
      transient: 'exit-clone',
    });
    motions.push({
      renderId: removed.renderId,
      taskId: removed.taskId,
      kind: removed.kind,
      fromPoseKey: resolveConsoleCardStablePoseKey(previous.entry, previous.index),
      toPoseKey: removed.toPoseKey,
      durationMs,
      easing,
    });
  });

  return {
    durationMs,
    renderCards,
    motions,
  };
}

function createEntrySnapshotMap(entries: DockEntry[]): Map<string, EntrySnapshot> {
  return new Map(entries.map((entry, index) => [entry.taskId, { entry, index }]));
}
