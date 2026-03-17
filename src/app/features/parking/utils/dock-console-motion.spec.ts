import { describe, expect, it } from 'vitest';
import type { DockEntry } from '../../../../models/parking-dock';
import {
  CONSOLE_CARD_POSES,
  resolveConsoleCardStablePoseKey,
  getConsoleCardPose,
  toConsoleCardTransform,
  toConsoleCardFilter,
  toConsoleCardOpacity,
  toConsoleCardZIndex,
  createStableConsoleRenderCards,
  createConsoleMotionMap,
  buildCompleteConsoleMotionBatch,
  buildSuspendConsoleMotionBatch,
  buildSwitchConsoleMotionBatch,
  buildRadarConsoleMotionBatch,
} from './dock-console-motion';

function makeDockEntry(overrides: Partial<DockEntry> & { taskId: string }): DockEntry {
  return {
    title: 'Test Task',
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
    ...overrides,
  };
}

describe('dock-console-motion', () => {
  describe('CONSOLE_CARD_POSES', () => {
    it('has all expected pose keys', () => {
      const expectedKeys = [
        'focus', 'depth-1', 'depth-2', 'depth-3',
        'offstage-top', 'offstage-bottom', 'offstage-back', 'radar-entry',
      ];
      for (const key of expectedKeys) {
        expect(CONSOLE_CARD_POSES).toHaveProperty(key);
      }
    });

    it('focus pose has scale 1 and opacity 1', () => {
      expect(CONSOLE_CARD_POSES.focus.scale).toBe(1);
      expect(CONSOLE_CARD_POSES.focus.opacity).toBe(1);
    });
  });

  describe('resolveConsoleCardStablePoseKey', () => {
    it('returns focus for focusing status', () => {
      expect(resolveConsoleCardStablePoseKey({ status: 'focusing' }, 0)).toBe('focus');
    });

    it('returns depth-1 for index 1', () => {
      expect(resolveConsoleCardStablePoseKey({ status: 'pending_start' }, 1)).toBe('depth-1');
    });

    it('returns depth-2 for index 2', () => {
      expect(resolveConsoleCardStablePoseKey({ status: 'pending_start' }, 2)).toBe('depth-2');
    });

    it('clamps depth to max 3', () => {
      expect(resolveConsoleCardStablePoseKey({ status: 'pending_start' }, 10)).toBe('depth-3');
    });

    it('clamps depth to min 1 for index 0 (non-focusing)', () => {
      expect(resolveConsoleCardStablePoseKey({ status: 'pending_start' }, 0)).toBe('depth-1');
    });
  });

  describe('getConsoleCardPose', () => {
    it('returns a valid pose object', () => {
      const pose = getConsoleCardPose('focus');
      expect(pose).toHaveProperty('translateX');
      expect(pose).toHaveProperty('translateY');
      expect(pose).toHaveProperty('scale');
      expect(pose).toHaveProperty('opacity');
    });
  });

  describe('toConsoleCardTransform', () => {
    it('returns a transform string with translate and scale', () => {
      const result = toConsoleCardTransform('focus');
      expect(result).toContain('translateX(');
      expect(result).toContain('scale(');
      expect(result).toContain('rotateX(');
    });
  });

  describe('toConsoleCardFilter', () => {
    it('returns none for 0 blur', () => {
      const pose = getConsoleCardPose('focus');
      if (pose.blurPx <= 0) {
        expect(toConsoleCardFilter('focus')).toBe('none');
      }
    });

    it('returns blur filter for poses with blurPx > 0', () => {
      const pose = getConsoleCardPose('depth-3');
      if (pose.blurPx > 0) {
        expect(toConsoleCardFilter('depth-3')).toContain('blur(');
      }
    });
  });

  describe('toConsoleCardOpacity', () => {
    it('returns a number between 0 and 1', () => {
      const opacity = toConsoleCardOpacity('focus');
      expect(opacity).toBeGreaterThanOrEqual(0);
      expect(opacity).toBeLessThanOrEqual(1);
    });
  });

  describe('toConsoleCardZIndex', () => {
    it('returns a number', () => {
      expect(typeof toConsoleCardZIndex('focus')).toBe('number');
    });
  });

  describe('createStableConsoleRenderCards', () => {
    it('returns empty array for empty entries', () => {
      expect(createStableConsoleRenderCards([])).toEqual([]);
    });

    it('maps entries to render cards with correct pose keys', () => {
      const entries: DockEntry[] = [
        makeDockEntry({ taskId: 'a', status: 'focusing' }),
        makeDockEntry({ taskId: 'b', status: 'pending_start' }),
      ];
      const cards = createStableConsoleRenderCards(entries);
      expect(cards).toHaveLength(2);
      expect(cards[0].poseKey).toBe('focus');
      expect(cards[0].taskId).toBe('a');
      expect(cards[1].poseKey).toBe('depth-1');
      expect(cards[1].transient).toBe('stable');
    });

    it('disables interaction for focusing entries', () => {
      const entries = [makeDockEntry({ taskId: 'a', status: 'focusing' })];
      const cards = createStableConsoleRenderCards(entries);
      expect(cards[0].interactionEnabled).toBe(false);
    });
  });

  describe('createConsoleMotionMap', () => {
    it('returns empty object for empty motions', () => {
      expect(createConsoleMotionMap([])).toEqual({});
    });

    it('maps motions by renderId', () => {
      const motion = {
        renderId: 'r1',
        taskId: 't1',
        kind: 'complete-exit' as const,
        fromPoseKey: 'focus' as const,
        toPoseKey: 'offstage-top' as const,
        durationMs: 300,
        easing: 'ease-out',
      };
      const map = createConsoleMotionMap([motion]);
      expect(map['r1']).toBe(motion);
    });
  });

  describe('buildCompleteConsoleMotionBatch', () => {
    it('produces a batch with exit clone for completed task', () => {
      const pre = [
        makeDockEntry({ taskId: 'a', status: 'focusing' }),
        makeDockEntry({ taskId: 'b', status: 'pending_start' }),
      ];
      const post = [makeDockEntry({ taskId: 'b', status: 'focusing' })];
      const batch = buildCompleteConsoleMotionBatch(pre, post, 'a', 'batch-1');
      expect(batch.durationMs).toBeGreaterThan(0);
      expect(batch.renderCards.some(c => c.taskId === 'a' && c.transient === 'exit-clone')).toBe(true);
      expect(batch.motions.some(m => m.kind === 'complete-exit')).toBe(true);
    });
  });

  describe('buildSuspendConsoleMotionBatch', () => {
    it('produces a batch with suspend-exit clone', () => {
      const pre = [
        makeDockEntry({ taskId: 'a', status: 'focusing' }),
        makeDockEntry({ taskId: 'b', status: 'pending_start' }),
      ];
      const post = [
        makeDockEntry({ taskId: 'b', status: 'focusing' }),
        makeDockEntry({ taskId: 'a', status: 'suspended_waiting' }),
      ];
      const batch = buildSuspendConsoleMotionBatch(pre, post, 'a', 'batch-2');
      expect(batch.durationMs).toBeGreaterThan(0);
      expect(batch.motions.some(m => m.kind === 'suspend-exit')).toBe(true);
    });
  });

  describe('buildSwitchConsoleMotionBatch', () => {
    it('marks the promoted task with switch-promote kind', () => {
      const pre = [
        makeDockEntry({ taskId: 'a', status: 'focusing' }),
        makeDockEntry({ taskId: 'b', status: 'pending_start' }),
      ];
      const post = [
        makeDockEntry({ taskId: 'b', status: 'focusing' }),
        makeDockEntry({ taskId: 'a', status: 'pending_start' }),
      ];
      const batch = buildSwitchConsoleMotionBatch(pre, post, 'b');
      expect(batch.motions.some(m => m.taskId === 'b' && m.kind === 'switch-promote')).toBe(true);
    });
  });

  describe('buildRadarConsoleMotionBatch', () => {
    it('marks newly inserted task as radar-promote', () => {
      const pre = [makeDockEntry({ taskId: 'a', status: 'focusing' })];
      const post = [
        makeDockEntry({ taskId: 'c', status: 'focusing' }),
        makeDockEntry({ taskId: 'a', status: 'pending_start' }),
      ];
      const batch = buildRadarConsoleMotionBatch(pre, post, 'c', 'batch-3');
      expect(batch.motions.some(m => m.taskId === 'c' && m.kind === 'radar-promote')).toBe(true);
    });

    it('creates eviction clone for removed entries', () => {
      const pre = [
        makeDockEntry({ taskId: 'a', status: 'focusing' }),
        makeDockEntry({ taskId: 'b', status: 'pending_start' }),
      ];
      const post = [
        makeDockEntry({ taskId: 'c', status: 'focusing' }),
        makeDockEntry({ taskId: 'a', status: 'pending_start' }),
      ];
      const batch = buildRadarConsoleMotionBatch(pre, post, 'c', 'batch-4');
      expect(batch.renderCards.some(c => c.taskId === 'b' && c.transient === 'exit-clone')).toBe(true);
      expect(batch.motions.some(m => m.taskId === 'b' && m.kind === 'radar-evict')).toBe(true);
    });
  });
});
