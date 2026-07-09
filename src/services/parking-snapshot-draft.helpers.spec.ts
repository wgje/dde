import { describe, expect, it } from 'vitest';

import type { ParkingSnapshot, Task, TaskParkingMeta } from '../models';
import {
  buildParkingSnapshotDraft,
  mergeParkingSnapshotDraft,
  parseParkingSnapshotDraft,
  parseSnapshotSavedAt,
  shouldRestoreParkingSnapshotDraft,
} from './parking-snapshot-draft.helpers';

describe('parking-snapshot-draft.helpers', () => {
  it('builds a localStorage draft from a focused task snapshot', () => {
    const task = taskWithSnapshot(snapshot({ savedAt: '2026-02-23T10:00:00.000Z' }));

    expect(buildParkingSnapshotDraft(task, '2026-02-23T10:01:00.000Z')).toEqual({
      taskId: 'task-1',
      contentHash: 'hash',
      cursorPosition: { line: 1, column: 2 },
      structuralAnchor: { taskId: 'anchor', offset: 3 },
      savedAt: '2026-02-23T10:01:00.000Z',
    });
  });

  it('parses only structurally valid drafts', () => {
    const raw = JSON.stringify({
      taskId: 'task-1',
      contentHash: 'hash',
      cursorPosition: { line: 1, column: 2 },
      structuralAnchor: null,
      savedAt: '2026-02-23T10:01:00.000Z',
    });

    expect(parseParkingSnapshotDraft(raw)).toMatchObject({
      taskId: 'task-1',
      contentHash: 'hash',
      savedAt: '2026-02-23T10:01:00.000Z',
    });
    expect(parseParkingSnapshotDraft('not json')).toBeNull();
    expect(parseParkingSnapshotDraft(JSON.stringify({ taskId: 'task-1' }))).toBeNull();
    expect(parseParkingSnapshotDraft(null)).toBeNull();
  });

  it('restores only when the localStorage draft is newer than the existing snapshot', () => {
    const task = taskWithSnapshot(snapshot({ savedAt: '2026-02-23T10:00:00.000Z' }));

    expect(shouldRestoreParkingSnapshotDraft(task, draft({ savedAt: '2026-02-23T10:01:00.000Z' }))).toBe(true);
    expect(shouldRestoreParkingSnapshotDraft(task, draft({ savedAt: '2026-02-23T09:59:00.000Z' }))).toBe(false);
    expect(shouldRestoreParkingSnapshotDraft({ ...task, parkingMeta: null }, draft())).toBe(false);
  });

  it('merges draft fields over the existing snapshot while preserving non-draft fields', () => {
    expect(mergeParkingSnapshotDraft(snapshot({
      scrollAnchor: { anchorType: 'line', anchorIndex: 1, anchorOffset: 12, scrollPercent: 0.12 },
      flowViewport: { scale: 0.5, selectedNodeId: 'anchor' },
    }), draft({
      contentHash: 'new-hash',
      cursorPosition: { line: 9, column: 3 },
      structuralAnchor: { taskId: 'next-anchor', offset: 4 },
      savedAt: '2026-02-23T10:01:00.000Z',
    }))).toEqual({
      savedAt: '2026-02-23T10:01:00.000Z',
      contentHash: 'new-hash',
      viewMode: 'text',
      cursorPosition: { line: 9, column: 3 },
      scrollAnchor: { anchorType: 'line', anchorIndex: 1, anchorOffset: 12, scrollPercent: 0.12 },
      structuralAnchor: { taskId: 'next-anchor', offset: 4 },
      flowViewport: { scale: 0.5, selectedNodeId: 'anchor' },
    });
  });

  it('parses invalid savedAt values as zero', () => {
    expect(parseSnapshotSavedAt('2026-02-23T10:01:00.000Z')).toBe(Date.parse('2026-02-23T10:01:00.000Z'));
    expect(parseSnapshotSavedAt('not a date')).toBe(0);
    expect(parseSnapshotSavedAt(null)).toBe(0);
  });
});

function draft(overrides: Partial<ReturnType<typeof parseParkingSnapshotDraft>> = {}) {
  return {
    taskId: 'task-1',
    contentHash: 'hash',
    cursorPosition: { line: 1, column: 2 },
    structuralAnchor: { taskId: 'anchor', offset: 3 },
    savedAt: '2026-02-23T10:01:00.000Z',
    ...overrides,
  } as NonNullable<ReturnType<typeof parseParkingSnapshotDraft>>;
}

function snapshot(overrides: Partial<ParkingSnapshot> = {}): ParkingSnapshot {
  return {
    savedAt: '2026-02-23T10:00:00.000Z',
    contentHash: 'hash',
    viewMode: 'text',
    cursorPosition: { line: 1, column: 2 },
    scrollAnchor: null,
    structuralAnchor: { taskId: 'anchor', offset: 3 } as unknown as ParkingSnapshot['structuralAnchor'],
    flowViewport: null,
    ...overrides,
  };
}

function taskWithSnapshot(contextSnapshot: ParkingSnapshot): Task {
  return {
    id: 'task-1',
    title: 'Task',
    content: '',
    stage: 0,
    order: 0,
    parkingMeta: {
      state: 'focused',
      parkedAt: '2026-02-23T09:00:00.000Z',
      lastVisitedAt: '2026-02-23T09:30:00.000Z',
      contextSnapshot,
      reminder: null,
      pinned: false,
    } satisfies TaskParkingMeta,
  } as Task;
}
