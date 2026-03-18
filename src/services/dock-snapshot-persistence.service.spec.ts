import { TestBed } from '@angular/core/testing';
import { describe, beforeEach, afterEach, it, expect, vi } from 'vitest';
import { get, set } from 'idb-keyval';
import {
  DockSnapshotPersistenceService,
  normalizeNullableNumber,
  type SnapshotNormalizeContext,
} from './dock-snapshot-persistence.service';
import { LoggerService } from './logger.service';
import type { DockEntry, DockSnapshot } from '../models/parking-dock';

vi.mock('idb-keyval', () => ({
  get: vi.fn(),
  set: vi.fn(),
}));

// ─── Mocks ──────────────────────────────────

const mockLoggerCategory = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

const mockLogger = {
  category: vi.fn(() => mockLoggerCategory),
};

// ─── Helpers ────────────────────────────────

function makeNormalizeContext(overrides?: Partial<SnapshotNormalizeContext>): SnapshotNormalizeContext {
  return {
    muteWaitTone: false,
    todayDateKey: '2025-01-15',
    buildOverflowMeta: () => ({ comboSelectOverflow: 0, backupOverflow: 0 }),
    ...overrides,
  };
}

function makeMinimalEntry(overrides?: Partial<DockEntry>): Record<string, unknown> {
  return {
    taskId: 'task-1',
    title: 'Test task',
    sourceProjectId: 'proj-1',
    status: 'pending_start',
    load: 'low',
    expectedMinutes: 30,
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

function makeMinimalSnapshot(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    version: 7,
    entries: [],
    focusMode: false,
    isDockExpanded: true,
    muteWaitTone: false,
    session: {
      firstDragIntervened: false,
      focusBlurOn: false,
      focusScrimOn: true,
      mainTaskId: null,
      comboSelectIds: [],
      backupIds: [],
    },
    dailySlots: [],
    suspendChainRootTaskId: null,
    suspendRecommendationLocked: false,
    pendingDecision: null,
    lastRuleDecision: null,
    dailyResetDate: '2025-01-15',
    savedAt: '2025-01-15T10:00:00.000Z',
    ...overrides,
  };
}

// ─── Test Suite ─────────────────────────────

describe('DockSnapshotPersistenceService', () => {
  let service: DockSnapshotPersistenceService;
  const mockGet = vi.mocked(get);
  const mockSet = vi.mocked(set);

  beforeEach(() => {
    vi.useFakeTimers();
    mockGet.mockReset();
    mockSet.mockReset();
    localStorage.clear();

    TestBed.configureTestingModule({
      providers: [
        DockSnapshotPersistenceService,
        { provide: LoggerService, useValue: mockLogger },
      ],
    });

    service = TestBed.inject(DockSnapshotPersistenceService);
  });

  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  // ─── localCacheKey / legacyLocalStorageKey ───

  describe('localCacheKey', () => {
    it('should include user id in the key', () => {
      const key = service.localCacheKey('user-123');
      expect(key).toBe('nanoflow.focus-session.v5.user-123');
    });

    it('should use "anonymous" for null user id', () => {
      const key = service.localCacheKey(null);
      expect(key).toBe('nanoflow.focus-session.v5.anonymous');
    });

    it('should use "anonymous" for empty string user id', () => {
      // empty string is falsy → falls through to 'anonymous'
      const key = service.localCacheKey('' as unknown as string);
      expect(key).toBe('nanoflow.focus-session.v5.anonymous');
    });
  });

  describe('legacyLocalStorageKey', () => {
    it('should include user id in the key', () => {
      const key = service.legacyLocalStorageKey('user-abc');
      expect(key).toBe('nanoflow.dock-snapshot.v3.user-abc');
    });

    it('should use "anonymous" for null user id', () => {
      const key = service.legacyLocalStorageKey(null);
      expect(key).toBe('nanoflow.dock-snapshot.v3.anonymous');
    });
  });

  // ─── isSnapshotNewer ──────────────────────────

  describe('isSnapshotNewer', () => {
    it('should return true when incoming is newer than current', () => {
      const incoming = { savedAt: '2025-01-15T12:00:00.000Z' } as DockSnapshot;
      const current = { savedAt: '2025-01-15T10:00:00.000Z' } as DockSnapshot;
      expect(service.isSnapshotNewer(incoming, current)).toBe(true);
    });

    it('should return false when incoming is older than current', () => {
      const incoming = { savedAt: '2025-01-15T08:00:00.000Z' } as DockSnapshot;
      const current = { savedAt: '2025-01-15T10:00:00.000Z' } as DockSnapshot;
      expect(service.isSnapshotNewer(incoming, current)).toBe(false);
    });

    it('should return false when timestamps are equal', () => {
      const incoming = { savedAt: '2025-01-15T10:00:00.000Z' } as DockSnapshot;
      const current = { savedAt: '2025-01-15T10:00:00.000Z' } as DockSnapshot;
      expect(service.isSnapshotNewer(incoming, current)).toBe(false);
    });

    it('should return false when incoming savedAt is invalid', () => {
      const incoming = { savedAt: 'not-a-date' } as DockSnapshot;
      const current = { savedAt: '2025-01-15T10:00:00.000Z' } as DockSnapshot;
      expect(service.isSnapshotNewer(incoming, current)).toBe(false);
    });

    it('should return true when current savedAt is invalid', () => {
      const incoming = { savedAt: '2025-01-15T10:00:00.000Z' } as DockSnapshot;
      const current = { savedAt: 'garbage' } as DockSnapshot;
      expect(service.isSnapshotNewer(incoming, current)).toBe(true);
    });

    it('should return false when both savedAt are invalid', () => {
      const incoming = { savedAt: 'bad1' } as DockSnapshot;
      const current = { savedAt: 'bad2' } as DockSnapshot;
      expect(service.isSnapshotNewer(incoming, current)).toBe(false);
    });
  });

  // ─── normalizeEntry ───────────────────────────

  describe('normalizeEntry', () => {
    const ctx = makeNormalizeContext();

    it('should normalize a valid entry', () => {
      const raw = makeMinimalEntry();
      const result = service.normalizeEntry(raw, ctx);
      expect(result).not.toBeNull();
      expect(result!.taskId).toBe('task-1');
      expect(result!.title).toBe('Test task');
      expect(result!.lane).toBe('combo-select');
      expect(result!.status).toBe('pending_start');
      expect(result!.load).toBe('low');
    });

    it('should return null for null input', () => {
      expect(service.normalizeEntry(null, ctx)).toBeNull();
    });

    it('should return null for non-object input', () => {
      expect(service.normalizeEntry('string', ctx)).toBeNull();
      expect(service.normalizeEntry(42, ctx)).toBeNull();
    });

    it('should return null when taskId is missing', () => {
      const raw = makeMinimalEntry();
      delete (raw as Record<string, unknown>).taskId;
      expect(service.normalizeEntry(raw, ctx)).toBeNull();
    });

    it('should return null when taskId is not a string', () => {
      expect(service.normalizeEntry({ taskId: 123 }, ctx)).toBeNull();
    });

    it('should default title to "Untitled task" when missing', () => {
      const raw = makeMinimalEntry({ title: undefined as unknown as string });
      const result = service.normalizeEntry(raw, ctx);
      expect(result!.title).toBe('Untitled task');
    });

    it('should normalize lane "strong" to "combo-select"', () => {
      const raw = makeMinimalEntry({ lane: 'strong' as unknown as 'combo-select' });
      const result = service.normalizeEntry(raw, ctx);
      expect(result!.lane).toBe('combo-select');
    });

    it('should default unknown lane to "backup"', () => {
      const raw = makeMinimalEntry({ lane: 'unknown-zone' as unknown as 'combo-select' });
      const result = service.normalizeEntry(raw, ctx);
      expect(result!.lane).toBe('backup');
    });

    it('should normalize zoneSource to "auto" for unknown values', () => {
      const raw = makeMinimalEntry({ zoneSource: 'unknown' as unknown as 'auto' });
      const result = service.normalizeEntry(raw, ctx);
      expect(result!.zoneSource).toBe('auto');
    });

    it('should normalize load to "low" for unknown values', () => {
      const raw = makeMinimalEntry({ load: 'medium' as unknown as 'low' });
      const result = service.normalizeEntry(raw, ctx);
      expect(result!.load).toBe('low');
    });

    it('should keep "high" load', () => {
      const raw = makeMinimalEntry({ load: 'high' as unknown as 'low' });
      const result = service.normalizeEntry(raw, ctx);
      expect(result!.load).toBe('high');
    });

    it('should normalize unknown status to "pending_start"', () => {
      const raw = makeMinimalEntry({ status: 'invalid' as unknown as 'pending_start' });
      const result = service.normalizeEntry(raw, ctx);
      expect(result!.status).toBe('pending_start');
    });

    it('should preserve valid statuses', () => {
      for (const status of ['focusing', 'suspended_waiting', 'wait_finished', 'stalled', 'completed'] as const) {
        const raw = makeMinimalEntry({ status });
        const result = service.normalizeEntry(raw, ctx);
        expect(result!.status).toBe(status);
      }
    });

    it('should normalize sourceKind to "project-task" for unknown values', () => {
      const raw = makeMinimalEntry({ sourceKind: 'unknown' as unknown as 'project-task' });
      const result = service.normalizeEntry(raw, ctx);
      expect(result!.sourceKind).toBe('project-task');
    });

    it('should normalize sourceKind "dock-created" correctly', () => {
      const raw = makeMinimalEntry({ sourceKind: 'dock-created' as unknown as 'project-task' });
      const result = service.normalizeEntry(raw, ctx);
      expect(result!.sourceKind).toBe('dock-created');
    });

    it('should use ctx.muteWaitTone as snoozeRingMuted default', () => {
      const ctxMuted = makeNormalizeContext({ muteWaitTone: true });
      const raw = makeMinimalEntry();
      delete (raw as Record<string, unknown>).snoozeRingMuted;
      const result = service.normalizeEntry(raw, ctxMuted);
      expect(result!.snoozeRingMuted).toBe(true);
    });

    it('should default dockedOrder to 0 for non-finite value', () => {
      const raw = makeMinimalEntry({ dockedOrder: NaN as unknown as number });
      const result = service.normalizeEntry(raw, ctx);
      expect(result!.dockedOrder).toBe(0);
    });
  });

  // ─── normalizeDailySlot ───────────────────────

  describe('normalizeDailySlot', () => {
    it('should normalize a valid daily slot', () => {
      const raw = {
        id: 'slot-1',
        title: 'Morning routine',
        maxDailyCount: 3,
        todayCompletedCount: 1,
        isEnabled: true,
        createdAt: '2025-01-01T00:00:00.000Z',
      };
      const result = service.normalizeDailySlot(raw);
      expect(result).not.toBeNull();
      expect(result!.id).toBe('slot-1');
      expect(result!.title).toBe('Morning routine');
      expect(result!.maxDailyCount).toBe(3);
      expect(result!.todayCompletedCount).toBe(1);
      expect(result!.isEnabled).toBe(true);
    });

    it('should return null for null input', () => {
      expect(service.normalizeDailySlot(null)).toBeNull();
    });

    it('should return null for non-object input', () => {
      expect(service.normalizeDailySlot('string')).toBeNull();
    });

    it('should return null when id is missing', () => {
      expect(service.normalizeDailySlot({ title: 'test' })).toBeNull();
    });

    it('should return null when id is not a string', () => {
      expect(service.normalizeDailySlot({ id: 123 })).toBeNull();
    });

    it('should default title to "Untitled daily task"', () => {
      const result = service.normalizeDailySlot({ id: 'slot-1' });
      expect(result!.title).toBe('Untitled daily task');
    });

    it('should default maxDailyCount to 1 for non-finite values', () => {
      const result = service.normalizeDailySlot({ id: 'slot-1', maxDailyCount: NaN });
      expect(result!.maxDailyCount).toBe(1);
    });

    it('should enforce minimum maxDailyCount of 1', () => {
      const result = service.normalizeDailySlot({ id: 'slot-1', maxDailyCount: 0 });
      expect(result!.maxDailyCount).toBe(1);
    });

    it('should floor maxDailyCount', () => {
      const result = service.normalizeDailySlot({ id: 'slot-1', maxDailyCount: 2.7 });
      expect(result!.maxDailyCount).toBe(2);
    });

    it('should default todayCompletedCount to 0', () => {
      const result = service.normalizeDailySlot({ id: 'slot-1' });
      expect(result!.todayCompletedCount).toBe(0);
    });

    it('should clamp todayCompletedCount to 0', () => {
      const result = service.normalizeDailySlot({ id: 'slot-1', todayCompletedCount: -5 });
      expect(result!.todayCompletedCount).toBe(0);
    });

    it('should default isEnabled to true when not explicitly false', () => {
      const result = service.normalizeDailySlot({ id: 'slot-1' });
      expect(result!.isEnabled).toBe(true);
    });

    it('should set isEnabled to false when explicitly false', () => {
      const result = service.normalizeDailySlot({ id: 'slot-1', isEnabled: false });
      expect(result!.isEnabled).toBe(false);
    });

    it('should default createdAt to a valid ISO string', () => {
      const result = service.normalizeDailySlot({ id: 'slot-1' });
      expect(result!.createdAt).toBeTruthy();
      expect(Date.parse(result!.createdAt)).not.toBeNaN();
    });
  });

  // ─── normalizeSnapshot ────────────────────────

  describe('normalizeSnapshot', () => {
    const ctx = makeNormalizeContext();

    it('should return null for null input', () => {
      expect(service.normalizeSnapshot(null, ctx)).toBeNull();
    });

    it('should return null for non-object input', () => {
      expect(service.normalizeSnapshot('string', ctx)).toBeNull();
      expect(service.normalizeSnapshot(42, ctx)).toBeNull();
    });

    it('should return null for unsupported version', () => {
      expect(service.normalizeSnapshot({ version: 1 }, ctx)).toBeNull();
      expect(service.normalizeSnapshot({ version: 99 }, ctx)).toBeNull();
    });

    it('should return null for missing version', () => {
      expect(service.normalizeSnapshot({ entries: [] }, ctx)).toBeNull();
    });

    it('should normalize supported versions (2-7)', () => {
      for (const v of [2, 3, 4, 5, 6, 7]) {
        const raw = makeMinimalSnapshot({ version: v });
        const result = service.normalizeSnapshot(raw, ctx);
        expect(result).not.toBeNull();
        expect(result!.version).toBe(7); // always upgraded to 7
      }
    });

    it('should normalize a valid snapshot', () => {
      const raw = makeMinimalSnapshot({
        entries: [makeMinimalEntry()],
      });
      const result = service.normalizeSnapshot(raw, ctx);
      expect(result).not.toBeNull();
      expect(result!.entries).toHaveLength(1);
      expect(result!.entries[0].taskId).toBe('task-1');
    });

    it('should filter out invalid entries', () => {
      const raw = makeMinimalSnapshot({
        entries: [
          makeMinimalEntry(),
          null,
          { noTaskId: true },
          makeMinimalEntry({ taskId: 'task-2' }),
        ],
      });
      const result = service.normalizeSnapshot(raw, ctx);
      expect(result).not.toBeNull();
      expect(result!.entries).toHaveLength(2);
    });

    it('should default isDockExpanded to true when undefined', () => {
      const raw = makeMinimalSnapshot();
      delete (raw as Record<string, unknown>).isDockExpanded;
      const result = service.normalizeSnapshot(raw, ctx);
      expect(result!.isDockExpanded).toBe(true);
    });

    it('should default dailyResetDate to todayDateKey', () => {
      const raw = makeMinimalSnapshot();
      delete (raw as Record<string, unknown>).dailyResetDate;
      const result = service.normalizeSnapshot(raw, ctx);
      expect(result!.dailyResetDate).toBe('2025-01-15');
    });

    it('should preserve valid savedAt', () => {
      const raw = makeMinimalSnapshot({ savedAt: '2025-06-01T00:00:00.000Z' });
      const result = service.normalizeSnapshot(raw, ctx);
      expect(result!.savedAt).toBe('2025-06-01T00:00:00.000Z');
    });

    it('should normalize dailySlots', () => {
      const raw = makeMinimalSnapshot({
        dailySlots: [
          { id: 'ds-1', title: 'Slot 1' },
          null,
          { id: 'ds-2' },
        ],
      });
      const result = service.normalizeSnapshot(raw, ctx);
      expect(result!.dailySlots).toHaveLength(2);
    });

    it('should default entries to empty array when not an array', () => {
      const raw = makeMinimalSnapshot({ entries: 'not-an-array' });
      const result = service.normalizeSnapshot(raw, ctx);
      expect(result!.entries).toEqual([]);
    });

    it('should normalize suspendChainRootTaskId', () => {
      const raw = makeMinimalSnapshot({ suspendChainRootTaskId: 123 });
      const result = service.normalizeSnapshot(raw, ctx);
      expect(result!.suspendChainRootTaskId).toBeNull();
    });

    it('should preserve valid suspendChainRootTaskId', () => {
      const raw = makeMinimalSnapshot({ suspendChainRootTaskId: 'root-task-1' });
      const result = service.normalizeSnapshot(raw, ctx);
      expect(result!.suspendChainRootTaskId).toBe('root-task-1');
    });
  });

  describe('restoreLocalSnapshot', () => {
    const ctx = makeNormalizeContext();

    it('should prefer a newer legacy snapshot over an older persisted IDB snapshot', async () => {
      mockGet.mockResolvedValue(
        makeMinimalSnapshot({
          focusMode: true,
          session: {
            firstDragIntervened: false,
            focusBlurOn: true,
            focusScrimOn: true,
            mainTaskId: null,
            comboSelectIds: [],
            backupIds: [],
          },
          savedAt: '2025-01-15T10:00:00.000Z',
        }),
      );
      localStorage.setItem(
        service.legacyLocalStorageKey('user-1'),
        JSON.stringify(
          makeMinimalSnapshot({
            focusMode: false,
            session: {
              firstDragIntervened: false,
              focusBlurOn: false,
              focusScrimOn: false,
              mainTaskId: null,
              comboSelectIds: [],
              backupIds: [],
            },
            savedAt: '2025-01-15T10:05:00.000Z',
          }),
        ),
      );

      const restored = await service.restoreLocalSnapshot('user-1', ctx);

      expect(restored?.focusMode).toBe(false);
      expect(restored?.session.focusScrimOn).toBe(false);
      expect(localStorage.getItem(service.legacyLocalStorageKey('user-1'))).toBeNull();
    });
  });

  // ─── normalizePendingDecision ─────────────────

  describe('normalizePendingDecision', () => {
    it('should return null for null input', () => {
      expect(service.normalizePendingDecision(null)).toBeNull();
    });

    it('should return null when rootTaskId is missing', () => {
      expect(service.normalizePendingDecision({ candidateGroups: [] })).toBeNull();
    });

    it('should return null when candidateGroups are empty and reason is not tight-blank', () => {
      expect(service.normalizePendingDecision({
        rootTaskId: 'root-1',
        candidateGroups: [],
      })).toBeNull();
    });

    it('should normalize valid pending decision', () => {
      const raw = {
        rootTaskId: 'root-1',
        rootRemainingMinutes: 10,
        candidateGroups: [{ type: 'homologous-advancement', taskIds: ['t1', 't2'] }],
        reason: 'Test reason',
      };
      const result = service.normalizePendingDecision(raw);
      expect(result).not.toBeNull();
      expect(result!.rootTaskId).toBe('root-1');
      expect(result!.candidateGroups).toHaveLength(1);
    });

    it('should allow tight-blank reason with empty groups', () => {
      const raw = {
        rootTaskId: 'root-1',
        candidateGroups: [],
        reason: 'tight-blank explanation',
      };
      const result = service.normalizePendingDecision(raw);
      expect(result).not.toBeNull();
    });
  });

  // ─── normalizeRuleDecision ────────────────────

  describe('normalizeRuleDecision', () => {
    it('should return null for null input', () => {
      expect(service.normalizeRuleDecision(null)).toBeNull();
    });

    it('should return null when type is missing', () => {
      expect(service.normalizeRuleDecision({ reason: 'test' })).toBeNull();
    });

    it('should normalize valid rule decision', () => {
      const raw = {
        type: 'completion_followup',
        reason: 'Test reason',
        recommendedTaskIds: ['t1'],
        createdAt: '2025-01-15T10:00:00.000Z',
      };
      const result = service.normalizeRuleDecision(raw);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('completion_followup');
      expect(result!.recommendedTaskIds).toEqual(['t1']);
    });

    it('should default reason when missing', () => {
      const raw = { type: 'idle_promote' };
      const result = service.normalizeRuleDecision(raw);
      expect(result).not.toBeNull();
      expect(result!.reason).toBe('规则引擎已完成调度');
    });

    it('should default recommendedTaskIds to empty array', () => {
      const raw = { type: 'idle_promote' };
      const result = service.normalizeRuleDecision(raw);
      expect(result!.recommendedTaskIds).toEqual([]);
    });
  });

  // ─── recoverLegacyExternalDragDefaultBackup ───

  describe('recoverLegacyExternalDragDefaultBackup', () => {
    it('should return same array reference when no entries match', () => {
      const entries = [
        { taskId: 't1', lane: 'combo-select', zoneSource: 'auto', sourceKind: 'project-task' },
      ] as DockEntry[];
      const result = service.recoverLegacyExternalDragDefaultBackup(entries);
      expect(result).toBe(entries); // same reference = no change
    });

    it('should migrate legacy manual combo entries from external drag sources', () => {
      const entries = [
        {
          taskId: 't1',
          lane: 'combo-select',
          zoneSource: 'manual',
          sourceKind: 'project-task',
          sourceSection: 'text',
          relationReason: null,
        },
      ] as unknown as DockEntry[];
      const result = service.recoverLegacyExternalDragDefaultBackup(entries);
      expect(result[0].lane).toBe('backup');
      expect(result[0].relationReason).toBe('manual:default-backup');
      expect(result[0].relationScore).toBe(20);
    });

    it('should migrate entries with "flow" sourceSection', () => {
      const entries = [
        {
          taskId: 't1',
          lane: 'combo-select',
          zoneSource: 'manual',
          sourceKind: 'project-task',
          sourceSection: 'flow',
          relationReason: 'manual:combo-select',
        },
      ] as unknown as DockEntry[];
      const result = service.recoverLegacyExternalDragDefaultBackup(entries);
      expect(result[0].lane).toBe('backup');
    });

    it('should not migrate non-external-drag entries', () => {
      const entries = [
        {
          taskId: 't1',
          lane: 'combo-select',
          zoneSource: 'manual',
          sourceKind: 'project-task',
          sourceSection: 'dock-create',
          relationReason: null,
        },
      ] as unknown as DockEntry[];
      const result = service.recoverLegacyExternalDragDefaultBackup(entries);
      expect(result).toBe(entries);
    });
  });

  // ─── cancelPendingPersist ─────────────────────

  describe('cancelPendingPersist', () => {
    it('should not throw when called without pending persist', () => {
      expect(() => service.cancelPendingPersist()).not.toThrow();
    });

    it('should shadow a scheduled snapshot to localStorage before canceling the debounced IDB write', () => {
      // Schedule a persist, then cancel it
      const snapshotFn = vi.fn(() =>
        makeMinimalSnapshot({
          focusMode: false,
          session: {
            firstDragIntervened: false,
            focusBlurOn: false,
            focusScrimOn: false,
            mainTaskId: null,
            comboSelectIds: [],
            backupIds: [],
          },
          savedAt: '2025-01-15T11:00:00.000Z',
        }) as unknown as DockSnapshot,
      );
      service.scheduleLocalPersist(snapshotFn, 'user-1', () => 0);

      // Cancel before the debounce fires
      service.cancelPendingPersist();

      // Advance past debounce interval
      vi.advanceTimersByTime(1000);

      expect(snapshotFn).toHaveBeenCalledTimes(1);
      expect(mockSet).not.toHaveBeenCalled();
      expect(
        JSON.parse(localStorage.getItem(service.legacyLocalStorageKey('user-1')) ?? '{}'),
      ).toMatchObject({
        focusMode: false,
        savedAt: '2025-01-15T11:00:00.000Z',
      });
    });

    it('should be idempotent', () => {
      service.cancelPendingPersist();
      service.cancelPendingPersist();
      // no throw
    });
  });
});

// ─── Standalone normalizeNullableNumber ─────

describe('normalizeNullableNumber', () => {
  it('should return null for null', () => {
    expect(normalizeNullableNumber(null)).toBeNull();
  });

  it('should return null for undefined', () => {
    expect(normalizeNullableNumber(undefined)).toBeNull();
  });

  it('should return null for empty string', () => {
    expect(normalizeNullableNumber('')).toBeNull();
  });

  it('should return null for NaN', () => {
    expect(normalizeNullableNumber(NaN)).toBeNull();
  });

  it('should return null for Infinity', () => {
    expect(normalizeNullableNumber(Infinity)).toBeNull();
  });

  it('should return null for -Infinity', () => {
    expect(normalizeNullableNumber(-Infinity)).toBeNull();
  });

  it('should return null for non-numeric string', () => {
    expect(normalizeNullableNumber('abc')).toBeNull();
  });

  it('should return number for numeric value', () => {
    expect(normalizeNullableNumber(42)).toBe(42);
  });

  it('should return number for zero', () => {
    expect(normalizeNullableNumber(0)).toBe(0);
  });

  it('should return number for negative value', () => {
    expect(normalizeNullableNumber(-10)).toBe(-10);
  });

  it('should parse numeric string to number', () => {
    expect(normalizeNullableNumber('123')).toBe(123);
  });

  it('should parse float string to number', () => {
    expect(normalizeNullableNumber('3.14')).toBe(3.14);
  });
});
