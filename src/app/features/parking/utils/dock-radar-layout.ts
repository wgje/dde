/**
 * Pure layout functions for DockRadarZoneComponent.
 *
 * Extracted to reduce component file size and enable unit testing
 * of spatial layout algorithms independently.
 */

import { DockEntry, DockLane, RecommendationGroupType } from '../../../../models/parking-dock';

// ─── Layout algorithm constants ────────────────────────────────

/** 中心排斥椭圆参数（单位: px，基于 600×600 雷达视口） */
const CENTER_Y = -36;
const ELLIPSE_RX_COMBO = 220;
const ELLIPSE_RX_BACKUP = 210;
const ELLIPSE_RY_COMBO = 170;
const ELLIPSE_RY_BACKUP = 162;

/** Y 轴夹紧因子（比例系数，防止布局越过底部边界） */
const MAX_Y_FACTOR_COMBO = 0.1;
const MAX_Y_FACTOR_BACKUP = 0.04;

/** 碰撞检测半尺寸（单位: px） */
const ITEM_HALF_WIDTH_COMBO = 120;
const ITEM_HALF_WIDTH_BACKUP = 104;
const ITEM_HALF_HEIGHT_COMBO = 24;
const ITEM_HALF_HEIGHT_BACKUP = 18;

/** 推挤力度系数 */
const SPACING_PUSH_SCALE = 0.62;

/** 碰撞回避迭代参数 */
const CENTER_AVOID_MAX_PASSES = 4;
const SPACING_MAX_PASSES = 5;
const CONVERGENCE_THRESHOLD = 0.5;
const OVERLAP_PUSH_PADDING = 8;

/** 最小距离衰减参数 */
const MIN_DIST_BASE_COMBO = 100;
const MIN_DIST_BASE_BACKUP = 92;
const MIN_DIST_FLOOR_COMBO = 56;
const MIN_DIST_FLOOR_BACKUP = 48;
const MIN_DIST_SHRINK_COMBO = 4.4;
const MIN_DIST_SHRINK_BACKUP = 3.6;

/** 扇区锚点因子（0~1 比例系数，控制任务卡片散布在雷达扇区中的基准位置） */
const SECTOR_ANCHOR_X = 0.86;
const SECTOR_ANCHOR_Y = 0.58;
const SECTOR_ANCHOR_TOP_Y = 0.98;

/** 布局间距因子 */
const HORIZONTAL_GAP_TOP = 0.23;
const HORIZONTAL_GAP_SIDE = 0.21;
const VERTICAL_GAP_MIN = 48;
const VERTICAL_GAP_FACTOR_TOP = 0.17;
const VERTICAL_GAP_FACTOR_SIDE = 0.2;
const COLUMN_THRESHOLD = 4;

/** 备选区环参数 */
const RING_SCALE_X_INNER = 0.9;
const RING_SCALE_X_OUTER = 1.08;
const RING_SCALE_Y_INNER = 0.88;
const RING_SCALE_Y_OUTER = 1.04;
const RING_ARC_START = Math.PI * 0.08;
const RING_ARC_END = Math.PI * 0.92;
const BACKUP_BOUND_EXTRA_X = 1.12;
const BACKUP_BOUND_EXTRA_Y = 1.1;

/** 抖动范围 */
const JITTER_X_TOP = 12;
const JITTER_X_SIDE = 14;
const JITTER_Y = 10;
const BACKUP_JITTER_X = 6;
const BACKUP_JITTER_Y = 4;

/** 回退坐标因子 */
const COMBO_FALLBACK_Y_FACTOR = 0.68;
const BACKUP_FALLBACK_Y_FACTOR = 0.82;

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
  const maxYFactor = lane === 'combo-select' ? MAX_Y_FACTOR_COMBO : MAX_Y_FACTOR_BACKUP;
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
  const centerY = CENTER_Y;
  const ellipseRx = lane === 'combo-select' ? ELLIPSE_RX_COMBO : ELLIPSE_RX_BACKUP;
  const ellipseRy = lane === 'combo-select' ? ELLIPSE_RY_COMBO : ELLIPSE_RY_BACKUP;
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
  // pushLen 为零时说明目标在椭圆中心，直接使用 clamped 原始点避免 NaN
  if (pushLen === 0) {
    return clampPoint(point, boundX, boundY, lane);
  }
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

  const itemHalfWidth = lane === 'combo-select' ? ITEM_HALF_WIDTH_COMBO : ITEM_HALF_WIDTH_BACKUP;
  const itemHalfHeight = lane === 'combo-select' ? ITEM_HALF_HEIGHT_COMBO : ITEM_HALF_HEIGHT_BACKUP;
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
        { x: current.x + (directionX * (overlapX + OVERLAP_PUSH_PADDING)), y: current.y },
        boundX,
        boundY,
        lane,
      );
      return;
    }

    const directionY = dy !== 0 ? Math.sign(dy) : -1;
    current = clampPoint(
      { x: current.x, y: current.y + (directionY * (overlapY + OVERLAP_PUSH_PADDING)) },
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
  for (let pass = 0; pass < CENTER_AVOID_MAX_PASSES; pass += 1) {
    const before = current;
    current = avoidCenterOcclusion(current, lane, boundX, boundY, occlusionSafePadding);
    current = avoidOverlayOcclusions(current, lane, boundX, boundY, seedKey, pass, avoidRects);
    if (Math.abs(current.x - before.x) < CONVERGENCE_THRESHOLD && Math.abs(current.y - before.y) < CONVERGENCE_THRESHOLD) {
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
  for (let pass = 0; pass < SPACING_MAX_PASSES; pass += 1) {
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
      const push = (minDistance - normalizedDistance) * SPACING_PUSH_SCALE;
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
  const base = lane === 'combo-select' ? MIN_DIST_BASE_COMBO : MIN_DIST_BASE_BACKUP;
  const floor = lane === 'combo-select' ? MIN_DIST_FLOOR_COMBO : MIN_DIST_FLOOR_BACKUP;
  const shrink = Math.max(0, count - 1) * (lane === 'combo-select' ? MIN_DIST_SHRINK_COMBO : MIN_DIST_SHRINK_BACKUP);
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
    x: (rand(seed + 19) - 0.5) * (sector === 'top' ? JITTER_X_TOP : JITTER_X_SIDE),
    y: (rand(seed + 47) - 0.5) * JITTER_Y,
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
    left: { x: -comboSpreadX * SECTOR_ANCHOR_X, y: -comboSpreadY * SECTOR_ANCHOR_Y },
    top: { x: 0, y: -comboSpreadY * SECTOR_ANCHOR_TOP_Y },
    right: { x: comboSpreadX * SECTOR_ANCHOR_X, y: -comboSpreadY * SECTOR_ANCHOR_Y },
  };

  for (const sector of config.comboSectorSequence) {
    const bucket = sectors.get(sector) ?? [];
    const columnCount = bucket.length >= COLUMN_THRESHOLD ? 2 : 1;
    const horizontalGap = comboSpreadX * (sector === 'top' ? HORIZONTAL_GAP_TOP : HORIZONTAL_GAP_SIDE);
    const verticalGap = Math.max(VERTICAL_GAP_MIN, comboSpreadY * (sector === 'top' ? VERTICAL_GAP_FACTOR_TOP : VERTICAL_GAP_FACTOR_SIDE));

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
    ...(pointByTaskId.get(entry.taskId) ?? { x: 0, y: -comboSpreadY * COMBO_FALLBACK_Y_FACTOR }),
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
    const ringScaleX = ringIndex === 0 ? RING_SCALE_X_INNER : RING_SCALE_X_OUTER;
    const ringScaleY = ringIndex === 0 ? RING_SCALE_Y_INNER : RING_SCALE_Y_OUTER;
    const ringStart = RING_ARC_START;
    const ringEnd = RING_ARC_END;
    ringEntries.forEach((entry, index) => {
      const angle = computeArcAngle(index, ringEntries.length, ringStart, ringEnd);
      const jitterSeed = hashCode(`${entry.taskId}:backup:${ringIndex}`);
      const point = {
        x: Math.cos(angle) * backupSpreadX * ringScaleX + ((rand(jitterSeed + 17) - 0.5) * BACKUP_JITTER_X),
        y: -Math.sin(angle) * backupSpreadY * ringScaleY + ((rand(jitterSeed + 41) - 0.5) * BACKUP_JITTER_Y),
      };
      const adjusted = resolveSpacingConflicts(
        point,
        placed,
        minDist,
        backupSpreadX * BACKUP_BOUND_EXTRA_X,
        backupSpreadY * BACKUP_BOUND_EXTRA_Y,
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
    ...(pointByTaskId.get(entry.taskId) ?? { x: 0, y: -backupSpreadY * BACKUP_FALLBACK_Y_FACTOR }),
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
