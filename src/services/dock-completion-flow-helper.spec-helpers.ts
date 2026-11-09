import { describe, expect, it, vi } from 'vitest';

import type { DockCompletionFlowService } from './dock-completion-flow.service';
import {
  isAutoPromotableStatus,
  isConsoleBackgroundStatus,
  isRunnableStatus,
  isWaitingLike,
} from './dock-engine.utils';
import { makeDockCompletionEntry as makeEntry } from './dock-completion-flow.service.spec-helpers';
import type { DockTaskStatus } from '../models/parking-dock';

type SpecMock = ReturnType<typeof vi.fn>;

interface DockCompletionFlowHelperSpecContext {
  service: () => DockCompletionFlowService;
  zoneService: () => {
    resolveSourceProjectId: SpecMock;
  };
}

export function registerDockCompletionFlowHelperSpecs(
  context: DockCompletionFlowHelperSpecContext,
): void {
  describe('status helpers', () => {
    describe('isWaitingLike', () => {
      it.each([
        ['suspended_waiting', true],
        ['wait_finished', true],
        ['pending_start', false],
        ['focusing', false],
        ['stalled', false],
        ['completed', false],
      ] as [DockTaskStatus, boolean][])('isWaitingLike(%s) -> %s', (status, expected) => {
        expect(isWaitingLike(status)).toBe(expected);
      });
    });

    describe('isRunnableStatus', () => {
      it.each([
        ['pending_start', true],
        ['wait_finished', true],
        ['stalled', true],
        ['focusing', false],
        ['suspended_waiting', false],
        ['completed', false],
      ] as [DockTaskStatus, boolean][])('isRunnableStatus(%s) -> %s', (status, expected) => {
        expect(isRunnableStatus(status)).toBe(expected);
      });
    });

    describe('isAutoPromotableStatus', () => {
      it.each([
        ['pending_start', true],
        ['stalled', true],
        ['focusing', false],
        ['suspended_waiting', false],
        ['wait_finished', false],
        ['completed', false],
      ] as [DockTaskStatus, boolean][])('isAutoPromotableStatus(%s) -> %s', (status, expected) => {
        expect(isAutoPromotableStatus(status)).toBe(expected);
      });
    });

    describe('isConsoleBackgroundStatus', () => {
      it.each([
        ['suspended_waiting', true],
        ['wait_finished', true],
        ['stalled', true],
        ['pending_start', false],
        ['focusing', false],
        ['completed', false],
      ] as [DockTaskStatus, boolean][])('isConsoleBackgroundStatus(%s) -> %s', (status, expected) => {
        expect(isConsoleBackgroundStatus(status)).toBe(expected);
      });
    });
  });

  describe('toSchedulerCandidate', () => {
    it('maps all DockEntry fields into the scheduler candidate shape', () => {
      const entry = makeEntry({
        taskId: 'task-1',
        lane: 'backup',
        load: 'high',
        expectedMinutes: 30,
        waitMinutes: 10,
        dockedOrder: 2,
        manualOrder: 1,
        relationScore: 42,
        sourceProjectId: 'proj-1',
      });

      const candidate = context.service().toSchedulerCandidate(entry);

      expect(candidate).toEqual({
        taskId: 'task-1',
        lane: 'backup',
        load: 'high',
        expectedMinutes: 30,
        waitMinutes: 10,
        dockedOrder: 2,
        manualOrder: 1,
        relationScore: 42,
        sourceProjectId: 'proj-1',
      });
    });

    it('normalizes undefined manualOrder and relationScore to null', () => {
      const entry = makeEntry({ taskId: 'task-2' });

      const candidate = context.service().toSchedulerCandidate(entry);

      expect(candidate.manualOrder).toBeNull();
      expect(candidate.relationScore).toBeNull();
    });

    it('falls back to zoneService.resolveSourceProjectId when entry.sourceProjectId is null', () => {
      context.zoneService().resolveSourceProjectId.mockReturnValueOnce('resolved-proj');
      const entry = makeEntry({ taskId: 'task-3', sourceProjectId: null });

      const candidate = context.service().toSchedulerCandidate(entry);

      expect(candidate.sourceProjectId).toBe('resolved-proj');
      expect(context.zoneService().resolveSourceProjectId).toHaveBeenCalledWith(entry);
    });
  });

  describe('toFocusTaskSlot', () => {
    it('creates a FocusTaskSlot with mapped focusStatus and zone', () => {
      const entry = makeEntry({
        taskId: 'slot-1',
        status: 'focusing',
        load: 'high',
        expectedMinutes: 45,
        waitMinutes: null,
        isMain: true,
        dockedOrder: 0,
        sourceProjectId: 'proj-a',
        sourceKind: 'project-task',
      });

      const slot = context.service().toFocusTaskSlot(entry, 'command', 0);

      expect(slot.slotId).toBe('slot-1');
      expect(slot.taskId).toBe('slot-1');
      expect(slot.estimatedMinutes).toBe(45);
      expect(slot.waitMinutes).toBeNull();
      expect(slot.cognitiveLoad).toBe('high');
      expect(slot.focusStatus).toBe('focusing');
      expect(slot.zone).toBe('command');
      expect(slot.zoneIndex).toBe(0);
      expect(slot.isMaster).toBe(true);
      expect(slot.waitStartedAt).toBeNull();
      expect(slot.waitEndAt).toBeNull();
      expect(slot.sourceProjectId).toBe('proj-a');
      expect(slot.sourceBlockType).toBeNull();
      expect(slot.isFirstBatch).toBe(true);
      expect(slot.inlineTitle).toBe('slot-1');
    });

    it('maps dock-created sourceKind to text sourceBlockType', () => {
      const entry = makeEntry({
        taskId: 'inline-1',
        sourceKind: 'dock-created',
      });

      const slot = context.service().toFocusTaskSlot(entry);

      expect(slot.sourceBlockType).toBe('text');
    });

    it('maps pending_start status to pending focusStatus', () => {
      const entry = makeEntry({ taskId: 'ps-1', status: 'pending_start' });
      expect(context.service().toFocusTaskSlot(entry).focusStatus).toBe('pending');
    });

    it('maps suspended_waiting to suspend-waiting', () => {
      const entry = makeEntry({ taskId: 'sw-1', status: 'suspended_waiting' });
      expect(context.service().toFocusTaskSlot(entry).focusStatus).toBe('suspend-waiting');
    });

    it('maps wait_finished to wait-ended', () => {
      const entry = makeEntry({ taskId: 'wf-1', status: 'wait_finished' });
      expect(context.service().toFocusTaskSlot(entry).focusStatus).toBe('wait-ended');
    });

    it('computes waitEndAt when waitStartedAt and waitMinutes are present', () => {
      const startedAt = '2024-01-01T00:00:00.000Z';
      const entry = makeEntry({
        taskId: 'w-1',
        waitStartedAt: startedAt,
        waitMinutes: 10,
      });

      const slot = context.service().toFocusTaskSlot(entry);

      const startMs = new Date(startedAt).getTime();
      expect(slot.waitStartedAt).toBe(startMs);
      expect(slot.waitEndAt).toBe(startMs + 10 * 60_000);
    });

    it('defaults zone to command and idx to 0', () => {
      const entry = makeEntry({ taskId: 'default-1' });
      const slot = context.service().toFocusTaskSlot(entry);
      expect(slot.zone).toBe('command');
      expect(slot.zoneIndex).toBe(0);
    });
  });

  describe('getWaitRemainingSeconds', () => {
    it('returns null when no wait timer is configured', () => {
      const entry = makeEntry({ taskId: 'no-wait' });
      expect(context.service().getWaitRemainingSeconds(entry)).toBeNull();
    });

    it('returns remaining seconds for an active wait timer', () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      const entry = makeEntry({
        taskId: 'wait-1',
        waitStartedAt: new Date(now - 5 * 60_000).toISOString(),
        waitMinutes: 10,
      });

      const remaining = context.service().getWaitRemainingSeconds(entry);
      expect(remaining).toBe(5 * 60);

      vi.useRealTimers();
    });

    it('returns 0 when wait time has fully elapsed', () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      const entry = makeEntry({
        taskId: 'wait-expired',
        waitStartedAt: new Date(now - 15 * 60_000).toISOString(),
        waitMinutes: 10,
      });

      expect(context.service().getWaitRemainingSeconds(entry)).toBe(0);

      vi.useRealTimers();
    });
  });

  describe('deriveBackgroundStatus', () => {
    it('returns suspended_waiting when entry has an active wait timer', () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      const entry = makeEntry({
        taskId: 'bg-1',
        waitStartedAt: new Date(now - 1 * 60_000).toISOString(),
        waitMinutes: 10,
      });

      expect(context.service().deriveBackgroundStatus(entry)).toBe('suspended_waiting');
      vi.useRealTimers();
    });

    it('returns wait_finished when wait timer has expired', () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      const entry = makeEntry({
        taskId: 'bg-2',
        waitStartedAt: new Date(now - 20 * 60_000).toISOString(),
        waitMinutes: 10,
      });

      expect(context.service().deriveBackgroundStatus(entry)).toBe('wait_finished');
      vi.useRealTimers();
    });

    it('returns stalled when current focus is non-main and nextTarget is main', () => {
      const entry = makeEntry({ taskId: 'bg-3', status: 'pending_start' });
      const nextTarget = makeEntry({ taskId: 'next', isMain: true });
      const currentFocus = makeEntry({ taskId: 'current', isMain: false });

      expect(context.service().deriveBackgroundStatus(entry, nextTarget, currentFocus)).toBe('stalled');
    });

    it('preserves stalled status for already stalled entry', () => {
      const entry = makeEntry({ taskId: 'bg-stall', status: 'stalled' });
      expect(context.service().deriveBackgroundStatus(entry)).toBe('stalled');
    });

    it('returns stalled for a focusing entry being moved to background', () => {
      const entry = makeEntry({ taskId: 'bg-focus', status: 'focusing' });
      expect(context.service().deriveBackgroundStatus(entry)).toBe('stalled');
    });

    it('defaults to pending_start for entries with no special conditions', () => {
      const entry = makeEntry({ taskId: 'bg-default', status: 'pending_start' });
      expect(context.service().deriveBackgroundStatus(entry)).toBe('pending_start');
    });

    it('does not return stalled when currentFocus is main even if nextTarget is main', () => {
      const entry = makeEntry({ taskId: 'bg-4', status: 'pending_start' });
      const nextTarget = makeEntry({ taskId: 'next', isMain: true });
      const currentFocus = makeEntry({ taskId: 'current', isMain: true });

      expect(context.service().deriveBackgroundStatus(entry, nextTarget, currentFocus)).toBe('pending_start');
    });
  });
}
