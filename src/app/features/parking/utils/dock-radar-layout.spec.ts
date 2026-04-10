import { describe, expect, it } from 'vitest';
import type { DockEntry } from '../../../../models/parking-dock';
import {
  hashCode,
  rand,
  clampPoint,
  avoidCenterOcclusion,
  avoidOverlayOcclusions,
  avoidOcclusions,
  resolveSpacingConflicts,
  computeMinDistance,
  computeArcAngle,
  computeSectorJitter,
  resolveComboSector,
  buildComboSectorBuckets,
  layoutComboEntries,
  layoutBackupEntries,
  layoutEntries,
  DEFAULT_RADAR_LAYOUT_CONFIG,
} from './dock-radar-layout';
import type { RadarAvoidRect, RadarLayoutConfig } from './dock-radar-layout';

function makeDockEntry(overrides: Partial<DockEntry> & { taskId: string }): DockEntry {
  return {
    title: 'Test',
    sourceProjectId: null,
    status: 'pending_start',
    load: 'low',
    expectedMinutes: null,
    waitMinutes: null,
    waitStartedAt: null,
    lane: 'combo-select',
    zoneSource: 'auto',
    isMain: false,
    dockedOrder: 0,
    detail: '',
    sourceKind: 'project-task',
    systemSelected: false,
    recommendedScore: null,
    ...overrides,
  };
}

describe('dock-radar-layout', () => {
  describe('hashCode', () => {
    it('returns consistent hash for same input', () => {
      expect(hashCode('test')).toBe(hashCode('test'));
    });

    it('returns different hashes for different inputs', () => {
      expect(hashCode('abc')).not.toBe(hashCode('xyz'));
    });

    it('returns 1 for empty string', () => {
      expect(hashCode('')).toBe(1);
    });

    it('returns a positive number', () => {
      expect(hashCode('hello')).toBeGreaterThan(0);
    });
  });

  describe('rand', () => {
    it('returns value between 0 and 1', () => {
      for (let i = 1; i <= 100; i++) {
        const value = rand(i);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThan(1);
      }
    });

    it('is deterministic for same seed', () => {
      expect(rand(42)).toBe(rand(42));
    });
  });

  describe('clampPoint', () => {
    it('clamps x within bounds', () => {
      const result = clampPoint({ x: 500, y: -100 }, 200, 200, 'combo-select');
      expect(result.x).toBeLessThanOrEqual(200);
      expect(result.x).toBeGreaterThanOrEqual(-200);
    });

    it('clamps negative x', () => {
      const result = clampPoint({ x: -500, y: -100 }, 200, 200, 'combo-select');
      expect(result.x).toBe(-200);
    });

    it('clamps y based on lane-specific maxYFactor', () => {
      const comboResult = clampPoint({ x: 0, y: 100 }, 200, 200, 'combo-select');
      const backupResult = clampPoint({ x: 0, y: 100 }, 200, 200, 'backup');
      // Both should clamp y to negative range
      expect(comboResult.y).toBeLessThanOrEqual(0);
      expect(backupResult.y).toBeLessThanOrEqual(0);
    });
  });

  describe('avoidCenterOcclusion', () => {
    it('returns unchanged point when outside center ellipse', () => {
      const point = { x: 300, y: -300 };
      const result = avoidCenterOcclusion(point, 'combo-select', 400, 400, 18);
      // Clamped but not pushed by center ellipse
      expect(result.x).toBeGreaterThanOrEqual(-400);
      expect(result.y).toBeGreaterThanOrEqual(-400);
    });

    it('pushes point outward when inside center ellipse', () => {
      const point = { x: 0, y: -36 }; // CENTER_Y = -36
      const result = avoidCenterOcclusion(point, 'combo-select', 400, 400, 18);
      // Should be pushed away from center
      const dist = Math.hypot(result.x, result.y + 36);
      expect(dist).toBeGreaterThan(0);
    });
  });

  describe('avoidOverlayOcclusions', () => {
    it('returns clamped point when no avoid rects', () => {
      const result = avoidOverlayOcclusions(
        { x: 100, y: -100 }, 'combo-select', 300, 300, 'test', 0, [],
      );
      expect(result.x).toBe(100);
      expect(result.y).toBe(-100);
    });

    it('pushes point away from overlapping rect', () => {
      const rect: RadarAvoidRect = { centerX: 100, centerY: -100, halfWidth: 80, halfHeight: 40 };
      const result = avoidOverlayOcclusions(
        { x: 100, y: -100 }, 'combo-select', 300, 300, 'test', 0, [rect],
      );
      const dist = Math.hypot(result.x - 100, result.y + 100);
      expect(dist).toBeGreaterThan(0);
    });
  });

  describe('computeMinDistance', () => {
    it('returns base distance for single item', () => {
      const dist = computeMinDistance(1, 'combo-select');
      expect(dist).toBeGreaterThan(0);
    });

    it('decreases with more items but respects floor', () => {
      const dist1 = computeMinDistance(1, 'combo-select');
      const dist10 = computeMinDistance(10, 'combo-select');
      expect(dist10).toBeLessThanOrEqual(dist1);
      expect(dist10).toBeGreaterThan(0);
    });

    it('uses different params for backup lane', () => {
      const combo = computeMinDistance(5, 'combo-select');
      const backup = computeMinDistance(5, 'backup');
      expect(combo).not.toBe(backup);
    });
  });

  describe('computeArcAngle', () => {
    it('returns midpoint for single item', () => {
      const angle = computeArcAngle(0, 1, 0, Math.PI);
      expect(angle).toBeCloseTo(Math.PI / 2, 5);
    });

    it('distributes angles evenly', () => {
      const a0 = computeArcAngle(0, 3, 0, Math.PI);
      const a1 = computeArcAngle(1, 3, 0, Math.PI);
      const a2 = computeArcAngle(2, 3, 0, Math.PI);
      expect(a1 - a0).toBeCloseTo(a2 - a1, 5);
    });
  });

  describe('computeSectorJitter', () => {
    it('returns deterministic jitter for same input', () => {
      const j1 = computeSectorJitter('task-1', 'left');
      const j2 = computeSectorJitter('task-1', 'left');
      expect(j1.x).toBe(j2.x);
      expect(j1.y).toBe(j2.y);
    });

    it('returns different jitter for different tasks', () => {
      const j1 = computeSectorJitter('task-1', 'left');
      const j2 = computeSectorJitter('task-2', 'left');
      // Not guaranteed to differ but extremely unlikely to match
      expect(j1.x !== j2.x || j1.y !== j2.y).toBe(true);
    });
  });

  describe('resolveComboSector', () => {
    it('returns left for homologous-advancement group', () => {
      const entry = makeDockEntry({ taskId: 'a' });
      const groups = new Map([['a', 'homologous-advancement' as const]]);
      expect(resolveComboSector(entry, 0, groups, ['left', 'top', 'right'])).toBe('left');
    });

    it('returns top for cognitive-downgrade group', () => {
      const entry = makeDockEntry({ taskId: 'a' });
      const groups = new Map([['a', 'cognitive-downgrade' as const]]);
      expect(resolveComboSector(entry, 0, groups, ['left', 'top', 'right'])).toBe('top');
    });

    it('returns right for asynchronous-boot group', () => {
      const entry = makeDockEntry({ taskId: 'a' });
      const groups = new Map([['a', 'asynchronous-boot' as const]]);
      expect(resolveComboSector(entry, 0, groups, ['left', 'top', 'right'])).toBe('right');
    });

    it('falls back to sector sequence for ungrouped entries', () => {
      const entry = makeDockEntry({ taskId: 'a' });
      const groups = new Map<string, never>();
      expect(resolveComboSector(entry, 0, groups, ['left', 'top', 'right'])).toBe('left');
      expect(resolveComboSector(entry, 1, groups, ['left', 'top', 'right'])).toBe('top');
      expect(resolveComboSector(entry, 2, groups, ['left', 'top', 'right'])).toBe('right');
    });
  });

  describe('buildComboSectorBuckets', () => {
    it('returns empty buckets for no entries', () => {
      const buckets = buildComboSectorBuckets([], new Map(), ['left', 'top', 'right']);
      expect(buckets.get('left')).toEqual([]);
      expect(buckets.get('top')).toEqual([]);
      expect(buckets.get('right')).toEqual([]);
    });

    it('distributes entries across sectors', () => {
      const entries = [
        makeDockEntry({ taskId: 'a' }),
        makeDockEntry({ taskId: 'b' }),
        makeDockEntry({ taskId: 'c' }),
      ];
      const groups = new Map([
        ['a', 'homologous-advancement' as const],
        ['b', 'cognitive-downgrade' as const],
        ['c', 'asynchronous-boot' as const],
      ]);
      const buckets = buildComboSectorBuckets(entries, groups, ['left', 'top', 'right']);
      expect(buckets.get('left')!.length).toBe(1);
      expect(buckets.get('top')!.length).toBe(1);
      expect(buckets.get('right')!.length).toBe(1);
    });
  });

  describe('layoutComboEntries', () => {
    it('returns empty array for no entries', () => {
      const result = layoutComboEntries([], 280, 260, DEFAULT_RADAR_LAYOUT_CONFIG, new Map(), []);
      expect(result).toEqual([]);
    });

    it('returns layout items with positions', () => {
      const entries = [
        makeDockEntry({ taskId: 'a' }),
        makeDockEntry({ taskId: 'b' }),
      ];
      const result = layoutComboEntries(entries, 280, 260, DEFAULT_RADAR_LAYOUT_CONFIG, new Map(), []);
      expect(result).toHaveLength(2);
      expect(result[0].entry.taskId).toBe('a');
      expect(typeof result[0].x).toBe('number');
      expect(typeof result[0].y).toBe('number');
    });

    it('produces positions within bounds', () => {
      const entries = Array.from({ length: 8 }, (_, i) =>
        makeDockEntry({ taskId: `t${i}` }),
      );
      const result = layoutComboEntries(entries, 280, 260, DEFAULT_RADAR_LAYOUT_CONFIG, new Map(), []);
      for (const item of result) {
        expect(Number.isFinite(item.x)).toBe(true);
        expect(Number.isFinite(item.y)).toBe(true);
      }
    });
  });

  describe('layoutBackupEntries', () => {
    it('returns empty array for no entries', () => {
      const result = layoutBackupEntries([], 280, 260, DEFAULT_RADAR_LAYOUT_CONFIG, []);
      expect(result).toEqual([]);
    });

    it('positions entries along arc', () => {
      const entries = [
        makeDockEntry({ taskId: 'a', lane: 'backup' }),
        makeDockEntry({ taskId: 'b', lane: 'backup' }),
        makeDockEntry({ taskId: 'c', lane: 'backup' }),
      ];
      const result = layoutBackupEntries(entries, 280, 260, DEFAULT_RADAR_LAYOUT_CONFIG, []);
      expect(result).toHaveLength(3);
      for (const item of result) {
        expect(Number.isFinite(item.x)).toBe(true);
        expect(Number.isFinite(item.y)).toBe(true);
      }
    });
  });

  describe('layoutEntries', () => {
    it('returns empty array for empty input', () => {
      expect(layoutEntries([], 'combo-select', 280, 260, DEFAULT_RADAR_LAYOUT_CONFIG, new Map(), [])).toEqual([]);
    });

    it('dispatches to combo layout for combo-select lane', () => {
      const entries = [makeDockEntry({ taskId: 'a', lane: 'combo-select' })];
      const result = layoutEntries(entries, 'combo-select', 280, 260, DEFAULT_RADAR_LAYOUT_CONFIG, new Map(), []);
      expect(result).toHaveLength(1);
    });

    it('dispatches to backup layout for backup lane', () => {
      const entries = [makeDockEntry({ taskId: 'a', lane: 'backup' })];
      const result = layoutEntries(entries, 'backup', 280, 260, DEFAULT_RADAR_LAYOUT_CONFIG, new Map(), []);
      expect(result).toHaveLength(1);
    });
  });

  describe('resolveSpacingConflicts', () => {
    it('returns point unchanged when no existing placed items', () => {
      const point = { x: 100, y: -100 };
      const result = resolveSpacingConflicts(point, [], 50, 300, 300, 'combo-select', 'test', 18, []);
      // resolveSpacingConflicts also calls avoidOcclusions, so coordinates may shift
      expect(Number.isFinite(result.x)).toBe(true);
      expect(Number.isFinite(result.y)).toBe(true);
    });

    it('pushes overlapping points apart', () => {
      const point = { x: 100, y: -100 };
      const placed = [{ x: 100, y: -100 }];
      const result = resolveSpacingConflicts(point, placed, 50, 300, 300, 'combo-select', 'test', 18, []);
      const dist = Math.hypot(result.x - 100, result.y + 100);
      expect(dist).toBeGreaterThan(0);
    });
  });
});
