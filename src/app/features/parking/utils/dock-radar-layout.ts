/**
 * Pure layout functions for DockRadarZoneComponent.
 *
 * Extracted to reduce component file size and enable unit testing
 * of spatial layout algorithms independently.
 */

import { DockEntry, DockLane, RecommendationGroupType } from '../../../../models/parking-dock';

// ─── Types ─────────────────────────────────────────────────────

export interface RadarLayoutItem {
  entry: DockEntry;
  x: number;
  y: number;
}

export type ComboSector = 'left' | 'top' | 'right';

export interface RadarAvoidRect {
  centerX: number;
  centerY: number;
  halfWidth: number;
  halfHeight: number;
}

export interface RadarLayoutConfig {
  comboSpreadXFactor: number;
  comboSpreadYFactor: number;
  backupSpreadXFactor: number;
  backupSpreadYFactor: number;
  occlusionSafePadding: number;
  comboSectorSequence: readonly ComboSector[];
}

export const DEFAULT_RADAR_LAYOUT_CONFIG: RadarLayoutConfig = {
  comboSpreadXFactor: 1.35,
  comboSpreadYFactor: 1.22,
  backupSpreadXFactor: 1.22,
  backupSpreadYFactor: 1.16,
  occlusionSafePadding: 18,
  comboSectorSequence: ['left', 'top', 'right'],
};

// ─── Hash / Random utilities ───────────────────────────────────

export function hashCode(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return hash || 1;
}

export function rand(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

// ─── Clamping ──────────────────────────────────────────────────

export function clampPoint(
  point: { x: number; y: number },
  boundX: number,
  boundY: number,
  lane: DockLane,
): { x: number; y: number } {
  const maxYFactor = lane === 'combo-select' ? 0.1 : 0.04;
  const minY = -boundY;
  const maxY = -(boundY * maxYFactor);
  return {
    x: Math.min(boundX, Math.max(-boundX, point.x)),
    y: Math.min(maxY, Math.max(minY, point.y)),
  };
}

// ─── Collision avoidance ───────────────────────────────────────

export function avoidCenterOcclusion(
  point: { x: number; y: number },
  lane: DockLane,
  boundX: number,
  boundY: number,
  padding: number,
): { x: number; y: number } {
  const centerX = 0;
  const centerY = -36;
  const ellipseRx = lane === 'combo-select' ? 220 : 210;
  const ellipseRy = lane === 'combo-select' ? 170 : 162;
  const dx = point.x - centerX;
  const dy = point.y - centerY;
  const norm = (dx * dx) / (ellipseRx * ellipseRx) + (dy * dy) / (ellipseRy * ellipseRy);
  if (norm >= 1) {
    return clampPoint(point, boundX, boundY, lane);
  }

  const targetScale = Math.sqrt(1 / Math.max(norm, 0.0001));
  let ux = dx;
  let uy = dy;
  if (Math.hypot(ux, uy) < 0.001) {
    ux = 0;
    uy = -1;
  }
  const stretchedX = ux * targetScale;
  const stretchedY = uy * targetScale;
  const pushLen = Math.hypot(stretchedX, stretchedY);
  const pushed = {
    x: centerX + stretchedX + ((stretchedX / pushLen) * padding),
    y: centerY + stretchedY + ((stretchedY / pushLen) * padding),
  };
  return clampPoint(pushed, boundX, boundY, lane);
}

export function avoidOverlayOcclusions(
  point: { x: number; y: number },
  lane: DockLane,
  boundX: number,
  boundY: number,
  seedKey: string,
  pass: number,
  avoidRects: readonly RadarAvoidRect[],
): { x: number; y: number } {
  if (avoidRects.length === 0) {
    return clampPoint(point, boundX, boundY, lane);
  }

  const itemHalfWidth = lane === 'combo-select' ? 120 : 104;
  const itemHalfHeight = lane === 'combo-select' ? 24 : 18;
  let current = point;

  avoidRects.forEach((rect, index) => {
    const halfWidth = rect.halfWidth + itemHalfWidth;
    const halfHeight = rect.halfHeight + itemHalfHeight;
    const dx = current.x - rect.centerX;
    const dy = current.y - rect.centerY;

    if (Math.abs(dx) >= halfWidth || Math.abs(dy) >= halfHeight) {
      return;
    }

    const overlapX = halfWidth - Math.abs(dx);
    const overlapY = halfHeight - Math.abs(dy);
    if (overlapX <= overlapY) {
      const directionX =
        dx !== 0
          ? Math.sign(dx)
          : (rand(hashCode(`${seedKey}:overlay-x:${pass}:${index}`)) > 0.5 ? 1 : -1);
      current = clampPoint(
        { x: current.x + (directionX * (overlapX + 8)), y: current.y },
        boundX,
        boundY,
        lane,
      );
      return;
    }

    const directionY = dy !== 0 ? Math.sign(dy) : -1;
    current = clampPoint(
      { x: current.x, y: current.y + (directionY * (overlapY + 8)) },
      boundX,
      boundY,
      lane,
    );
  });

  return current;
}

export function avoidOcclusions(
  point: { x: number; y: number },
  lane: DockLane,
  boundX: number,
  boundY: number,
  seedKey: string,
  occlusionSafePadding: number,
  avoidRects: readonly RadarAvoidRect[],
): { x: number; y: number } {
  let current = point;
  for (let pass = 0; pass < 4; pass += 1) {
    const before = current;
    current = avoidCenterOcclusion(current, lane, boundX, boundY, occlusionSafePadding);
    current = avoidOverlayOcclusions(current, lane, boundX, boundY, seedKey, pass, avoidRects);
    if (Math.abs(current.x - before.x) < 0.5 && Math.abs(current.y - before.y) < 0.5) {
      break;
    }
  }
  return current;
}

export function resolveSpacingConflicts(
  point: { x: number; y: number },
  placed: Array<{ x: number; y: number }>,
  minDistance: number,
  boundX: number,
  boundY: number,
  lane: DockLane,
  seedKey: string,
  occlusionSafePadding: number,
  avoidRects: readonly RadarAvoidRect[],
): { x: number; y: number } {
  let current = clampPoint(point, boundX, boundY, lane);
  for (let pass = 0; pass < 5; pass += 1) {
    let moved = false;
    for (const existing of placed) {
      const dx = current.x - existing.x;
      const dy = current.y - existing.y;
      const distance = Math.hypot(dx, dy);
      if (distance >= minDistance) continue;
      const normalizedDistance = distance < 0.001 ? 0.001 : distance;
      let ux = dx / normalizedDistance;
      let uy = dy / normalizedDistance;
      if (distance < 0.001) {
        const angle = rand(hashCode(`${seedKey}:${pass}`)) * Math.PI * 2;
        ux = Math.cos(angle);
        uy = Math.sin(angle);
      }
      const push = (minDistance - normalizedDistance) * 0.62;
      current = clampPoint(
        {
          x: current.x + (ux * push),
          y: current.y + (uy * push),
        },
        boundX,
        boundY,
        lane,
      );
      moved = true;
    }
    if (!moved) break;
  }
  return avoidOcclusions(current, lane, boundX, boundY, seedKey, occlusionSafePadding, avoidRects);
}

// ─── Sector / arc helpers ──────────────────────────────────────

export function computeMinDistance(count: number, lane: DockLane): number {
  const base = lane === 'combo-select' ? 100 : 92;
  const floor = lane === 'combo-select' ? 56 : 48;
  const shrink = Math.max(0, count - 1) * (lane === 'combo-select' ? 4.4 : 3.6);
  return Math.max(floor, base - shrink);
}

export function computeArcAngle(index: number, count: number, start: number, end: number): number {
  if (count <= 1) return (start + end) / 2;
  const step = (end - start) / (count + 1);
  return start + (step * (index + 1));
}

export function computeSectorJitter(taskId: string, sector: ComboSector): { x: number; y: number } {
  const seed = hashCode(`${taskId}:${sector}`);
  return {
    x: (rand(seed + 19) - 0.5) * (sector === 'top' ? 12 : 14),
    y: (rand(seed + 47) - 0.5) * 10,
  };
}

export function resolveComboSector(
  entry: DockEntry,
  index: number,
  groupByTaskId: ReadonlyMap<string, RecommendationGroupType>,
  sectorSequence: readonly ComboSector[],
): ComboSector {
  const grouped = groupByTaskId.get(entry.taskId);
  if (grouped === 'homologous-advancement') return 'left';
  if (grouped === 'cognitive-downgrade') return 'top';
  if (grouped === 'asynchronous-boot') return 'right';
  return sectorSequence[index % sectorSequence.length] ?? 'top';
}

export function buildComboSectorBuckets(
  entries: DockEntry[],
  groupByTaskId: ReadonlyMap<string, RecommendationGroupType>,
  sectorSequence: readonly ComboSector[],
): Map<ComboSector, DockEntry[]> {
  const buckets = new Map<ComboSector, DockEntry[]>([
    ['left', []],
    ['top', []],
    ['right', []],
  ]);
  entries.forEach((entry, index) => {
    const sector = resolveComboSector(entry, index, groupByTaskId, sectorSequence);
    buckets.get(sector)?.push(entry);
  });
  return buckets;
}

// ─── Main layout dispatchers ──────────────────────────────────

export function layoutComboEntries(
  entries: DockEntry[],
  radiusX: number,
  radiusY: number,
  config: RadarLayoutConfig,
  groupByTaskId: ReadonlyMap<string, RecommendationGroupType>,
  avoidRects: readonly RadarAvoidRect[],
): RadarLayoutItem[] {
  const pointByTaskId = new Map<string, { x: number; y: number }>();
  const placed: Array<{ x: number; y: number }> = [];
  const minDist = computeMinDistance(entries.length, 'combo-select');
  const comboSpreadX = radiusX * config.comboSpreadXFactor;
  const comboSpreadY = radiusY * config.comboSpreadYFactor;
  const sectors = buildComboSectorBuckets(entries, groupByTaskId, config.comboSectorSequence);
  const anchors: Record<ComboSector, { x: number; y: number }> = {
    left: { x: -comboSpreadX * 0.86, y: -comboSpreadY * 0.58 },
    top: { x: 0, y: -comboSpreadY * 0.98 },
    right: { x: comboSpreadX * 0.86, y: -comboSpreadY * 0.58 },
  };

  for (const sector of config.comboSectorSequence) {
    const bucket = sectors.get(sector) ?? [];
    const columnCount = bucket.length >= 4 ? 2 : 1;
    const horizontalGap = comboSpreadX * (sector === 'top' ? 0.23 : 0.21);
    const verticalGap = Math.max(48, comboSpreadY * (sector === 'top' ? 0.17 : 0.2));

    bucket.forEach((entry, index) => {
      const row = Math.floor(index / columnCount);
      const column = index % columnCount;
      const centeredColumn = column - ((columnCount - 1) / 2);
      const jitter = computeSectorJitter(entry.taskId, sector);
      const point = {
        x: anchors[sector].x + (centeredColumn * horizontalGap) + jitter.x,
        y: anchors[sector].y + (row * verticalGap) + jitter.y,
      };
      const adjusted = resolveSpacingConflicts(
        point,
        placed,
        minDist,
        comboSpreadX,
        comboSpreadY,
        'combo-select',
        entry.taskId,
        config.occlusionSafePadding,
        avoidRects,
      );
      placed.push(adjusted);
      pointByTaskId.set(entry.taskId, adjusted);
    });
  }

  return entries.map(entry => ({
    entry,
    ...(pointByTaskId.get(entry.taskId) ?? { x: 0, y: -comboSpreadY * 0.68 }),
  }));
}

export function layoutBackupEntries(
  entries: DockEntry[],
  radiusX: number,
  radiusY: number,
  config: RadarLayoutConfig,
  avoidRects: readonly RadarAvoidRect[],
): RadarLayoutItem[] {
  const pointByTaskId = new Map<string, { x: number; y: number }>();
  const placed: Array<{ x: number; y: number }> = [];
  const minDist = computeMinDistance(entries.length, 'backup');
  const backupSpreadX = radiusX * config.backupSpreadXFactor;
  const backupSpreadY = radiusY * config.backupSpreadYFactor;
  const rings: DockEntry[][] = [[], []];
  entries.forEach((entry, index) => {
    rings[index % 2].push(entry);
  });

  rings.forEach((ringEntries, ringIndex) => {
    const ringScaleX = ringIndex === 0 ? 0.9 : 1.08;
    const ringScaleY = ringIndex === 0 ? 0.88 : 1.04;
    const ringStart = Math.PI * 0.08;
    const ringEnd = Math.PI * 0.92;
    ringEntries.forEach((entry, index) => {
      const angle = computeArcAngle(index, ringEntries.length, ringStart, ringEnd);
      const jitterSeed = hashCode(`${entry.taskId}:backup:${ringIndex}`);
      const point = {
        x: Math.cos(angle) * backupSpreadX * ringScaleX + ((rand(jitterSeed + 17) - 0.5) * 6),
        y: -Math.sin(angle) * backupSpreadY * ringScaleY + ((rand(jitterSeed + 41) - 0.5) * 4),
      };
      const adjusted = resolveSpacingConflicts(
        point,
        placed,
        minDist,
        backupSpreadX * 1.12,
        backupSpreadY * 1.1,
        'backup',
        entry.taskId,
        config.occlusionSafePadding,
        avoidRects,
      );
      placed.push(adjusted);
      pointByTaskId.set(entry.taskId, adjusted);
    });
  });

  return entries.map(entry => ({
    entry,
    ...(pointByTaskId.get(entry.taskId) ?? { x: 0, y: -backupSpreadY * 0.82 }),
  }));
}

export function layoutEntries(
  entries: DockEntry[],
  lane: DockLane,
  radiusX: number,
  radiusY: number,
  config: RadarLayoutConfig,
  groupByTaskId: ReadonlyMap<string, RecommendationGroupType>,
  avoidRects: readonly RadarAvoidRect[],
): RadarLayoutItem[] {
  if (entries.length === 0) return [];
  return lane === 'combo-select'
    ? layoutComboEntries(entries, radiusX, radiusY, config, groupByTaskId, avoidRects)
    : layoutBackupEntries(entries, radiusX, radiusY, config, avoidRects);
}
