import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PARKING_CONFIG } from '../config/parking.config';
import type { DockEntry, DockTaskStatus, FocusTaskSlot } from '../models/parking-dock';
import {
  entryOrder,
  toFocusTaskSlot,
  isWaitingLike,
  isRunnableStatus,
  isAutoPromotableStatus,
  isConsoleBackgroundStatus,
  getWaitRemainingSeconds,
  hasActiveWaitTimer,
  isWaitExpired,
  mapDockStatusToUiStatus,
  mapDockStatusToFocusStatus,
  toStatusMachineEntry,
  buildOverflowMeta,
  resolveOrderingWindowMinutes,
  findConsoleEvictionCandidate,
  buildConsoleVisibleOrderHint,
  sortDockEntriesForDisplay,
} from './dock-engine.utils';

// ---------------------------------------------------------------------------
//  Test helpers
// ---------------------------------------------------------------------------

function makeDockEntry(overrides: Partial<DockEntry> = {}): DockEntry {
  return {
    taskId: overrides.taskId ?? 'task-1',
    title: overrides.title ?? 'Test Task',
    sourceProjectId: overrides.sourceProjectId ?? null,
    status: overrides.status ?? 'pending_start',
    load: overrides.load ?? 'low',
    expectedMinutes: overrides.expectedMinutes ?? null,
    waitMinutes: overrides.waitMinutes ?? null,
    waitStartedAt: overrides.waitStartedAt ?? null,
    lane: overrides.lane ?? 'combo-select',
    zoneSource: overrides.zoneSource ?? 'auto',
    isMain: overrides.isMain ?? false,
    dockedOrder: overrides.dockedOrder ?? 0,
    detail: overrides.detail ?? '',
    sourceKind: overrides.sourceKind ?? 'project-task',
    systemSelected: overrides.systemSelected ?? false,
    recommendedScore: overrides.recommendedScore ?? null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
//  entryOrder
// ---------------------------------------------------------------------------

describe('entryOrder', () => {
  it('should return manualOrder when it is a finite number', () => {
    const entry = makeDockEntry({ manualOrder: 5, dockedOrder: 10 });
    expect(entryOrder(entry)).toBe(5);
  });

  it('should return dockedOrder when manualOrder is undefined', () => {
    const entry = makeDockEntry({ dockedOrder: 7 });
    expect(entryOrder(entry)).toBe(7);
  });

  it('should return dockedOrder when manualOrder is 0 (valid finite)', () => {
    const entry = makeDockEntry({ manualOrder: 0, dockedOrder: 3 });
    expect(entryOrder(entry)).toBe(0);
  });

  it('should return dockedOrder when manualOrder is NaN', () => {
    const entry = makeDockEntry({ manualOrder: NaN as unknown as number, dockedOrder: 4 });
    expect(entryOrder(entry)).toBe(4);
  });
});

// ---------------------------------------------------------------------------
//  toFocusTaskSlot
// ---------------------------------------------------------------------------

describe('toFocusTaskSlot', () => {
  it('should map a basic DockEntry to FocusTaskSlot with defaults', () => {
    const entry = makeDockEntry({
      taskId: 'abc-123',
      expectedMinutes: 30,
      waitMinutes: 10,
      load: 'high',
      isMain: true,
      dockedOrder: 0,
      status: 'focusing',
    });
    const slot = toFocusTaskSlot(entry);
    expect(slot.slotId).toBe('abc-123');
    expect(slot.taskId).toBe('abc-123');
    expect(slot.estimatedMinutes).toBe(30);
    expect(slot.waitMinutes).toBe(10);
    expect(slot.cognitiveLoad).toBe('high');
    expect(slot.focusStatus).toBe('focusing');
    expect(slot.zone).toBe('command');
    expect(slot.zoneIndex).toBe(0);
    expect(slot.isMaster).toBe(true);
    expect(slot.isFirstBatch).toBe(true);
  });

  it('should respect zone and idx params', () => {
    const entry = makeDockEntry({ dockedOrder: 2 });
    const slot = toFocusTaskSlot(entry, 'backup', 3);
    expect(slot.zone).toBe('backup');
    expect(slot.zoneIndex).toBe(3);
    expect(slot.isFirstBatch).toBe(false);
  });

  it('should compute waitEndAt from waitStartedAt + waitMinutes', () => {
    const started = '2026-01-01T00:00:00.000Z';
    const entry = makeDockEntry({ waitStartedAt: started, waitMinutes: 5 });
    const slot = toFocusTaskSlot(entry);
    const startMs = new Date(started).getTime();
    expect(slot.waitStartedAt).toBe(startMs);
    expect(slot.waitEndAt).toBe(startMs + 5 * 60_000);
  });

  it('should set waitStartedAt/waitEndAt to null when no timer', () => {
    const entry = makeDockEntry();
    const slot = toFocusTaskSlot(entry);
    expect(slot.waitStartedAt).toBeNull();
    expect(slot.waitEndAt).toBeNull();
  });

  it('should map dock-created sourceKind to text sourceBlockType', () => {
    const entry = makeDockEntry({ sourceKind: 'dock-created' });
    const slot = toFocusTaskSlot(entry);
    expect(slot.sourceBlockType).toBe('text');
  });

  it('should map project-task sourceKind to null sourceBlockType', () => {
    const entry = makeDockEntry({ sourceKind: 'project-task' });
    const slot = toFocusTaskSlot(entry);
    expect(slot.sourceBlockType).toBeNull();
  });
});

// ---------------------------------------------------------------------------
//  Status helpers
// ---------------------------------------------------------------------------

describe('isWaitingLike', () => {
  it('should return true for suspended_waiting', () => {
    expect(isWaitingLike('suspended_waiting')).toBe(true);
  });
  it('should return true for wait_finished', () => {
    expect(isWaitingLike('wait_finished')).toBe(true);
  });
  it('should return false for other statuses', () => {
    expect(isWaitingLike('pending_start')).toBe(false);
    expect(isWaitingLike('focusing')).toBe(false);
    expect(isWaitingLike('stalled')).toBe(false);
    expect(isWaitingLike('completed')).toBe(false);
  });
});

describe('isRunnableStatus', () => {
  it('should return true for pending_start, wait_finished, stalled', () => {
    expect(isRunnableStatus('pending_start')).toBe(true);
    expect(isRunnableStatus('wait_finished')).toBe(true);
    expect(isRunnableStatus('stalled')).toBe(true);
  });
  it('should return false for focusing, suspended_waiting, completed', () => {
    expect(isRunnableStatus('focusing')).toBe(false);
    expect(isRunnableStatus('suspended_waiting')).toBe(false);
    expect(isRunnableStatus('completed')).toBe(false);
  });
});

describe('isAutoPromotableStatus', () => {
  it('should return true for pending_start and stalled', () => {
    expect(isAutoPromotableStatus('pending_start')).toBe(true);
    expect(isAutoPromotableStatus('stalled')).toBe(true);
  });
  it('should return false for all other statuses', () => {
    expect(isAutoPromotableStatus('focusing')).toBe(false);
    expect(isAutoPromotableStatus('suspended_waiting')).toBe(false);
    expect(isAutoPromotableStatus('wait_finished')).toBe(false);
    expect(isAutoPromotableStatus('completed')).toBe(false);
  });
});

describe('isConsoleBackgroundStatus', () => {
  it('should return true for waitingLike and stalled', () => {
    expect(isConsoleBackgroundStatus('suspended_waiting')).toBe(true);
    expect(isConsoleBackgroundStatus('wait_finished')).toBe(true);
    expect(isConsoleBackgroundStatus('stalled')).toBe(true);
  });
  it('should return false for pending_start, focusing, completed', () => {
    expect(isConsoleBackgroundStatus('pending_start')).toBe(false);
    expect(isConsoleBackgroundStatus('focusing')).toBe(false);
    expect(isConsoleBackgroundStatus('completed')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
//  Wait timer helpers
// ---------------------------------------------------------------------------

describe('getWaitRemainingSeconds', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:10:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('should return null when waitStartedAt is null', () => {
    const entry = makeDockEntry({ waitMinutes: 5 });
    expect(getWaitRemainingSeconds(entry)).toBeNull();
  });

  it('should return null when waitMinutes is null', () => {
    const entry = makeDockEntry({ waitStartedAt: '2026-01-01T00:05:00.000Z' });
    expect(getWaitRemainingSeconds(entry)).toBeNull();
  });

  it('should return remaining seconds when timer is active', () => {
    // Started at 00:05, 10 min wait, now is 00:10 → 5 min = 300s remaining
    const entry = makeDockEntry({
      waitStartedAt: '2026-01-01T00:05:00.000Z',
      waitMinutes: 10,
    });
    expect(getWaitRemainingSeconds(entry)).toBe(300);
  });

  it('should return 0 when timer is expired', () => {
    // Started at 00:00, 5 min wait, now is 00:10 → expired
    const entry = makeDockEntry({
      waitStartedAt: '2026-01-01T00:00:00.000Z',
      waitMinutes: 5,
    });
    expect(getWaitRemainingSeconds(entry)).toBe(0);
  });
});

describe('hasActiveWaitTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:10:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('should return false when no timer data', () => {
    expect(hasActiveWaitTimer(makeDockEntry())).toBe(false);
  });

  it('should return true when timer has remaining time', () => {
    const entry = makeDockEntry({
      waitStartedAt: '2026-01-01T00:05:00.000Z',
      waitMinutes: 10,
    });
    expect(hasActiveWaitTimer(entry)).toBe(true);
  });

  it('should return false when timer is expired', () => {
    const entry = makeDockEntry({
      waitStartedAt: '2026-01-01T00:00:00.000Z',
      waitMinutes: 5,
    });
    expect(hasActiveWaitTimer(entry)).toBe(false);
  });
});

describe('isWaitExpired', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:10:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('should return false when no timer data (remaining is null)', () => {
    expect(isWaitExpired(makeDockEntry())).toBe(false);
  });

  it('should return true when timer has expired', () => {
    const entry = makeDockEntry({
      waitStartedAt: '2026-01-01T00:00:00.000Z',
      waitMinutes: 5,
    });
    expect(isWaitExpired(entry)).toBe(true);
  });

  it('should return false when timer is still active', () => {
    const entry = makeDockEntry({
      waitStartedAt: '2026-01-01T00:09:00.000Z',
      waitMinutes: 5,
    });
    expect(isWaitExpired(entry)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
//  Status mapping helpers
// ---------------------------------------------------------------------------

describe('mapDockStatusToUiStatus', () => {
  it('should map all known statuses correctly', () => {
    expect(mapDockStatusToUiStatus('focusing')).toBe('focusing');
    expect(mapDockStatusToUiStatus('suspended_waiting')).toBe('suspended_waiting');
    expect(mapDockStatusToUiStatus('wait_finished')).toBe('waiting_done');
    expect(mapDockStatusToUiStatus('stalled')).toBe('stalled');
    expect(mapDockStatusToUiStatus('pending_start')).toBe('queued');
    expect(mapDockStatusToUiStatus('completed')).toBe('queued');
  });
});

describe('mapDockStatusToFocusStatus', () => {
  it('should map all DockTaskStatus to FocusTaskStatus', () => {
    expect(mapDockStatusToFocusStatus('focusing')).toBe('focusing');
    expect(mapDockStatusToFocusStatus('suspended_waiting')).toBe('suspend-waiting');
    expect(mapDockStatusToFocusStatus('wait_finished')).toBe('wait-ended');
    expect(mapDockStatusToFocusStatus('stalled')).toBe('stalled');
    expect(mapDockStatusToFocusStatus('completed')).toBe('completed');
    expect(mapDockStatusToFocusStatus('pending_start')).toBe('pending');
  });
});

describe('toStatusMachineEntry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:10:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('should create StatusMachineEntry with correct label for focusing', () => {
    const entry = makeDockEntry({ taskId: 't1', title: 'Focus Task', status: 'focusing' });
    const sme = toStatusMachineEntry(entry);
    expect(sme.taskId).toBe('t1');
    expect(sme.title).toBe('Focus Task');
    expect(sme.uiStatus).toBe('focusing');
    expect(sme.label).toBe('专注中');
    expect(sme.waitRemainingSeconds).toBeNull();
    expect(sme.waitTotalSeconds).toBeNull();
  });

  it('should create StatusMachineEntry with wait info for suspended_waiting', () => {
    const entry = makeDockEntry({
      status: 'suspended_waiting',
      waitStartedAt: '2026-01-01T00:05:00.000Z',
      waitMinutes: 10,
    });
    const sme = toStatusMachineEntry(entry);
    expect(sme.uiStatus).toBe('suspended_waiting');
    expect(sme.label).toBe('挂起等待');
    expect(sme.waitRemainingSeconds).toBe(300);
    expect(sme.waitTotalSeconds).toBe(600);
  });

  it('should set correct label for wait_finished', () => {
    const entry = makeDockEntry({ status: 'wait_finished' });
    const sme = toStatusMachineEntry(entry);
    expect(sme.label).toBe('等待结束');
  });

  it('should set correct label for stalled', () => {
    const entry = makeDockEntry({ status: 'stalled' });
    const sme = toStatusMachineEntry(entry);
    expect(sme.label).toBe('停滞中');
  });

  it('should set correct label for pending_start', () => {
    const entry = makeDockEntry({ status: 'pending_start' });
    const sme = toStatusMachineEntry(entry);
    expect(sme.label).toBe('待启动');
  });
});

// ---------------------------------------------------------------------------
//  buildOverflowMeta
// ---------------------------------------------------------------------------

describe('buildOverflowMeta', () => {
  it('should return 0 overflow when counts are within limits', () => {
    const entries = [
      makeDockEntry({ lane: 'combo-select', isMain: false }),
    ];
    const meta = buildOverflowMeta(entries);
    expect(meta.comboSelectOverflow).toBe(0);
    expect(meta.backupOverflow).toBe(0);
  });

  it('should calculate overflow for combo-select zone', () => {
    const limit = PARKING_CONFIG.RADAR_COMBO_VISIBLE_LIMIT;
    const entries = Array.from({ length: limit + 3 }, (_, i) =>
      makeDockEntry({ taskId: `t-${i}`, lane: 'combo-select', isMain: false }),
    );
    const meta = buildOverflowMeta(entries);
    expect(meta.comboSelectOverflow).toBe(3);
  });

  it('should exclude isMain entries from overflow count', () => {
    const limit = PARKING_CONFIG.RADAR_COMBO_VISIBLE_LIMIT;
    const entries = [
      makeDockEntry({ taskId: 'main-1', lane: 'combo-select', isMain: true }),
      ...Array.from({ length: limit }, (_, i) =>
        makeDockEntry({ taskId: `t-${i}`, lane: 'combo-select', isMain: false }),
      ),
    ];
    const meta = buildOverflowMeta(entries);
    // isMain is excluded, so exactly limit non-main entries → 0 overflow
    expect(meta.comboSelectOverflow).toBe(0);
  });
});

// ---------------------------------------------------------------------------
//  resolveOrderingWindowMinutes
// ---------------------------------------------------------------------------

describe('resolveOrderingWindowMinutes', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:10:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('should return 30 when root is null', () => {
    expect(resolveOrderingWindowMinutes(null)).toBe(30);
  });

  it('should return wait remaining minutes when root has active timer', () => {
    const root = makeDockEntry({
      waitStartedAt: '2026-01-01T00:05:00.000Z',
      waitMinutes: 20,
    });
    // 15 min remaining → 15
    expect(resolveOrderingWindowMinutes(root)).toBe(15);
  });

  it('should return expectedMinutes when no active wait timer', () => {
    const root = makeDockEntry({ expectedMinutes: 45 });
    expect(resolveOrderingWindowMinutes(root)).toBe(45);
  });

  it('should return 30 as fallback when no wait and no expectedMinutes', () => {
    const root = makeDockEntry();
    expect(resolveOrderingWindowMinutes(root)).toBe(30);
  });
});

// ---------------------------------------------------------------------------
//  findConsoleEvictionCandidate
// ---------------------------------------------------------------------------

describe('findConsoleEvictionCandidate', () => {
  it('should return null when all entries are protected (main or focusing)', () => {
    const entries = [
      makeDockEntry({ taskId: 't1', isMain: true, status: 'focusing' }),
    ];
    expect(findConsoleEvictionCandidate(entries, 't1')).toBeNull();
  });

  it('should skip current focus entry and main entries, evict last non-protected', () => {
    const entries = [
      makeDockEntry({ taskId: 'main', isMain: true }),
      makeDockEntry({ taskId: 'focus', status: 'focusing' }),
      makeDockEntry({ taskId: 'stalled-1', status: 'stalled' }),
      makeDockEntry({ taskId: 'stalled-2', status: 'stalled' }),
    ];
    // Scanning from end: stalled-2 is not focus/main → evicted
    expect(findConsoleEvictionCandidate(entries, 'focus')).toBe('stalled-2');
  });

  it('should return null for empty array', () => {
    expect(findConsoleEvictionCandidate([], null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
//  buildConsoleVisibleOrderHint
// ---------------------------------------------------------------------------

describe('buildConsoleVisibleOrderHint', () => {
  it('should place selectedTaskId first', () => {
    const preVisible = [
      { taskId: 'a' },
      { taskId: 'b' },
      { taskId: 'c' },
    ];
    const result = buildConsoleVisibleOrderHint(preVisible, 'b');
    expect(result[0]).toBe('b');
    expect(result).toContain('a');
    expect(result).toContain('c');
  });

  it('should exclude evictedTaskId from result', () => {
    const preVisible = [
      { taskId: 'a' },
      { taskId: 'b' },
      { taskId: 'c' },
      { taskId: 'd' },
    ];
    const result = buildConsoleVisibleOrderHint(preVisible, 'b', 'c');
    expect(result).not.toContain('c');
    expect(result[0]).toBe('b');
  });

  it('should truncate to CONSOLE_STACK_VISIBLE_MAX', () => {
    const preVisible = Array.from({ length: 10 }, (_, i) => ({ taskId: `t-${i}` }));
    const result = buildConsoleVisibleOrderHint(preVisible, 't-5');
    expect(result.length).toBeLessThanOrEqual(PARKING_CONFIG.CONSOLE_STACK_VISIBLE_MAX);
  });
});

// ---------------------------------------------------------------------------
//  sortDockEntriesForDisplay
// ---------------------------------------------------------------------------

describe('sortDockEntriesForDisplay', () => {
  const identity = (entry: DockEntry) => ({
    taskId: entry.taskId,
    lane: entry.lane,
    load: entry.load,
    expectedMinutes: entry.expectedMinutes,
    waitMinutes: entry.waitMinutes,
    dockedOrder: entry.dockedOrder,
    manualOrder: entry.manualOrder ?? null,
    relationScore: entry.relationScore ?? null,
    sourceProjectId: entry.sourceProjectId,
  });
  const noProject = () => null;

  it('should return same array for 0 or 1 entries', () => {
    expect(sortDockEntriesForDisplay([], identity, noProject)).toEqual([]);
    const single = [makeDockEntry()];
    expect(sortDockEntriesForDisplay(single, identity, noProject)).toBe(single);
  });

  it('should place isMain entry first', () => {
    const entries = [
      makeDockEntry({ taskId: 'b', isMain: false, dockedOrder: 0 }),
      makeDockEntry({ taskId: 'a', isMain: true, dockedOrder: 1 }),
    ];
    const sorted = sortDockEntriesForDisplay(entries, identity, noProject);
    expect(sorted[0].taskId).toBe('a');
  });

  it('should respect manualOrder over dockedOrder', () => {
    const entries = [
      makeDockEntry({ taskId: 'a', manualOrder: 2, dockedOrder: 0 }),
      makeDockEntry({ taskId: 'b', manualOrder: 1, dockedOrder: 1 }),
    ];
    const sorted = sortDockEntriesForDisplay(entries, identity, noProject);
    expect(sorted[0].taskId).toBe('b');
  });

  it('should use dockedOrder as tiebreaker when scores are equal', () => {
    const entries = [
      makeDockEntry({ taskId: 'a', dockedOrder: 1, load: 'low' }),
      makeDockEntry({ taskId: 'b', dockedOrder: 0, load: 'low' }),
    ];
    const sorted = sortDockEntriesForDisplay(entries, identity, noProject);
    // When scheduler scores are identical, dockedOrder determines position
    expect(sorted[0].dockedOrder).toBeLessThanOrEqual(sorted[1].dockedOrder);
  });
});
