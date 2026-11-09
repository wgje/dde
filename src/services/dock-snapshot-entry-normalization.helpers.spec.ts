import { describe, expect, it } from 'vitest';
import type { DockEntry } from '../models/parking-dock';
import { normalizeDockSnapshotEntry } from './dock-snapshot-entry-normalization.helpers';

describe('normalizeDockSnapshotEntry', () => {
  it('normalizes legacy lane, planner fields, inline archive state, and bounded text', () => {
    const result = normalizeDockSnapshotEntry({
      raw: {
        taskId: 'task-1',
        title: 'x'.repeat(600),
        detail: 'd'.repeat(12_000),
        lane: 'strong',
        zoneSource: 'manual',
        sourceKind: 'dock-created',
        expectedMinutes: 5,
        waitMinutes: 30,
        load: 'high',
        snoozeRingMuted: undefined,
        relationScore: '42',
        manualOrder: '3',
        sourceSection: 'flow',
      },
      muteWaitTone: true,
    });

    expect(result).toMatchObject({
      taskId: 'task-1',
      lane: 'combo-select',
      zoneSource: 'manual',
      sourceKind: 'dock-created',
      inlineArchiveStatus: 'pending',
      expectedMinutes: 30,
      waitMinutes: 30,
      load: 'high',
      manualOrder: 3,
      snoozeRingMuted: true,
      relationScore: 42,
      sourceSection: 'flow',
    } satisfies Partial<DockEntry>);
    expect(result?.title).toHaveLength(500);
    expect(result?.detail).toHaveLength(10_000);
  });

  it('rejects missing task ids and falls back invalid enums', () => {
    expect(normalizeDockSnapshotEntry({ raw: null, muteWaitTone: false })).toBeNull();
    expect(normalizeDockSnapshotEntry({ raw: { taskId: '   ' }, muteWaitTone: false })).toBeNull();

    const result = normalizeDockSnapshotEntry({
      raw: {
        taskId: 'task-2',
        status: 'unknown',
        lane: 'unknown',
        zoneSource: 'unknown',
        load: 'medium',
        sourceKind: 'unknown',
      },
      muteWaitTone: false,
    });

    expect(result).toMatchObject({
      status: 'pending_start',
      lane: 'backup',
      zoneSource: 'auto',
      load: 'low',
      sourceKind: 'project-task',
      inlineArchiveStatus: undefined,
    } satisfies Partial<DockEntry>);
  });
});
