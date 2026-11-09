import { TestBed } from '@angular/core/testing';
import { describe, beforeEach, afterEach, it, expect, vi } from 'vitest';
import { LoggerService } from './logger.service';
import type {
  DockSnapshotPersistenceService as DockSnapshotPersistenceServiceType,
} from './dock-snapshot-persistence.service';
import type { DockEntry, DockSnapshot } from '../models/parking-dock';
import {
  makeMinimalEntry,
  makeMinimalSnapshot,
  makeNormalizeContext,
} from './dock-snapshot-persistence.spec-helpers';
import {
  registerDockSnapshotPendingPersistSpecs,
  registerNormalizeNullableNumberSpecs,
} from './dock-snapshot-persistence-pending.spec-helpers';
import { registerDockSnapshotKeySpecs } from './dock-snapshot-persistence-key.spec-helpers';
import { registerDockSnapshotNewerSpecs } from './dock-snapshot-persistence-newer.spec-helpers';
import { LocalBackupUiRestoreWriterQuiescenceService } from './local-backup-ui-restore-writer-quiescence.service';

vi.mock('idb-keyval', () => ({
  del: vi.fn(),
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

// ─── Test Suite ─────────────────────────────

describe('DockSnapshotPersistenceService', () => {
  let service: DockSnapshotPersistenceServiceType;
  let serviceClass: typeof import('./dock-snapshot-persistence.service').DockSnapshotPersistenceService;
  let mockDel: ReturnType<typeof vi.fn>;
  let mockGet: ReturnType<typeof vi.fn>;
  let mockSet: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    const idbKeyval = await import('idb-keyval');
    const dockSnapshotModule = await import('./dock-snapshot-persistence.service');
    serviceClass = dockSnapshotModule.DockSnapshotPersistenceService;
    mockDel = vi.mocked(idbKeyval.del);
    mockGet = vi.mocked(idbKeyval.get);
    mockSet = vi.mocked(idbKeyval.set);
    mockDel.mockReset();
    mockGet.mockReset();
    mockSet.mockReset();
    localStorage.clear();

    TestBed.configureTestingModule({
      providers: [
        serviceClass,
        { provide: LoggerService, useValue: mockLogger },
      ],
    });

    service = TestBed.inject(serviceClass);
  });

  afterEach(() => {
    localStorage.clear();
  });

  // ─── localCacheKey / legacyLocalStorageKey ───

  registerDockSnapshotKeySpecs({
    getService: () => service,
  });

  // ─── Immediate local persist ─────────────────

  describe('persistImmediateSnapshot', () => {
    it('should shadow the snapshot synchronously and enqueue IndexedDB without waiting for debounce', async () => {
      const snapshot = makeMinimalSnapshot({
        entries: [makeMinimalEntry({ taskId: 'task-2', dockedOrder: 1 })],
        savedAt: '2025-01-15T12:34:56.000Z',
      }) as unknown as DockSnapshot;
      const immediateService = service as DockSnapshotPersistenceServiceType & {
        persistImmediateSnapshot: (
          snapshotFn: () => DockSnapshot,
          userId: string | null,
        ) => Promise<boolean>;
      };

      const write = immediateService.persistImmediateSnapshot(() => snapshot, 'user-1');

      expect(JSON.parse(localStorage.getItem(service.legacyLocalStorageKey('user-1')) ?? '{}')).toMatchObject({
        savedAt: '2025-01-15T12:34:56.000Z',
        entries: [expect.objectContaining({ taskId: 'task-2', dockedOrder: 1 })],
      });
      await expect(write).resolves.toBe(true);
      await Promise.resolve();
      expect(mockSet).toHaveBeenCalledWith(
        service.localCacheKey('user-1'),
        expect.objectContaining({
          savedAt: '2025-01-15T12:34:56.000Z',
          entries: [expect.objectContaining({ taskId: 'task-2', dockedOrder: 1 })],
        }),
      );
    });

    it('should report failure when IndexedDB persist fails even if the shadow snapshot is written', async () => {
      mockSet.mockRejectedValue(new Error('idb unavailable'));
      const snapshot = makeMinimalSnapshot({
        entries: [makeMinimalEntry({ taskId: 'task-idb-fail', dockedOrder: 1 })],
        savedAt: '2025-01-15T12:34:56.000Z',
      }) as unknown as DockSnapshot;
      const immediateService = service as DockSnapshotPersistenceServiceType & {
        persistImmediateSnapshot: (
          snapshotFn: () => DockSnapshot,
          userId: string | null,
        ) => Promise<boolean>;
      };

      const write = immediateService.persistImmediateSnapshot(() => snapshot, 'user-1');

      expect(JSON.parse(localStorage.getItem(service.legacyLocalStorageKey('user-1')) ?? '{}')).toMatchObject({
        entries: [expect.objectContaining({ taskId: 'task-idb-fail' })],
      });
      await expect(write).resolves.toBe(false);
      await Promise.resolve();
      await Promise.resolve();
      expect(mockSet).toHaveBeenCalledTimes(2);
    });

    it('should release the restore writer when snapshot materialization throws', async () => {
      const quiescence = new LocalBackupUiRestoreWriterQuiescenceService({ pollIntervalMs: 1 });

      expect(() => service.persistImmediateSnapshot(() => {
        throw new Error('snapshot materialization failed');
      }, 'restore-owner')).toThrow('snapshot materialization failed');

      const handle = await quiescence.prepare('restore-owner');
      await handle.abortBeforeMutation();
      expect(mockSet).not.toHaveBeenCalled();
    });
  });

  describe('writer quiescence', () => {
    it('should wait for pending dock writes and block new writes after freeze', async () => {
      const snapshot = makeMinimalSnapshot({
        entries: [makeMinimalEntry({ taskId: 'task-restore', dockedOrder: 1 })],
        savedAt: '2025-01-15T12:34:56.000Z',
      }) as unknown as DockSnapshot;
      const quiescence = new LocalBackupUiRestoreWriterQuiescenceService({ pollIntervalMs: 1 });
      let releasePersist!: () => void;
      mockSet.mockImplementation(() => new Promise(resolve => {
        releasePersist = () => resolve(undefined);
      }));
      const localStorageBefore = localStorage.getItem(service.legacyLocalStorageKey('restore-owner'));

      service.scheduleLocalPersist(() => snapshot, 'restore-owner', () => 0);
      const preparing = quiescence.prepare('restore-owner');

      await vi.waitFor(() => expect(releasePersist).toBeTypeOf('function'));
      releasePersist();
      const handle = await preparing;

      expect(() => service.scheduleLocalPersist(() => snapshot, 'restore-owner', () => 0))
        .toThrow(/paused writers for owner restore-owner/i);
      expect(() => service.persistImmediateSnapshot(() => snapshot, 'restore-owner'))
        .toThrow(/paused writers for owner restore-owner/i);
      expect(localStorage.getItem(service.legacyLocalStorageKey('restore-owner'))).toBe(localStorageBefore);
      await handle.abortBeforeMutation();
    });

    it('should release a pending writer when scheduled snapshot materialization throws', async () => {
      const quiescence = new LocalBackupUiRestoreWriterQuiescenceService({ pollIntervalMs: 1 });
      let materializationAttempted = false;

      service.scheduleLocalPersist(() => {
        materializationAttempted = true;
        throw new Error('snapshot materialization failed');
      }, 'restore-owner', () => 0);

      await vi.waitFor(() => expect(materializationAttempted).toBe(true));
      const handle = await quiescence.prepare('restore-owner');
      await handle.abortBeforeMutation();
      expect(mockSet).not.toHaveBeenCalled();
    });

    it('should release a pending writer when cancel snapshot materialization throws', async () => {
      const quiescence = new LocalBackupUiRestoreWriterQuiescenceService({ pollIntervalMs: 1 });

      service.scheduleLocalPersist(() => {
        throw new Error('snapshot materialization failed');
      }, 'restore-owner', () => 0);

      expect(() => service.cancelPendingPersist()).toThrow('snapshot materialization failed');
      const handle = await quiescence.prepare('restore-owner');
      await handle.abortBeforeMutation();
      expect(mockSet).not.toHaveBeenCalled();
    });

    it('should not promote a dock snapshot after owner restore quiescence is prepared', async () => {
      const snapshot = makeMinimalSnapshot({
        savedAt: '2025-01-15T12:34:56.000Z',
      });
      const key = service.legacyLocalStorageKey('restore-owner');
      const rawSnapshot = JSON.stringify(snapshot);
      localStorage.setItem(key, rawSnapshot);
      const quiescence = new LocalBackupUiRestoreWriterQuiescenceService({ pollIntervalMs: 1 });
      const handle = await quiescence.prepare('restore-owner');

      await expect(service.restoreLocalSnapshot('restore-owner', makeNormalizeContext()))
        .rejects.toThrow(/paused writers for owner restore-owner/i);

      expect(mockSet).not.toHaveBeenCalled();
      expect(localStorage.getItem(key)).toBe(rawSnapshot);
      await handle.abortBeforeMutation();
    });

    it('should wait for an in-progress dock snapshot promotion before preparing owner restore', async () => {
      const snapshot = makeMinimalSnapshot({
        savedAt: '2025-01-15T12:34:56.000Z',
      });
      localStorage.setItem(
        service.legacyLocalStorageKey('restore-owner'),
        JSON.stringify(snapshot),
      );
      let releasePromotion!: () => void;
      mockSet.mockImplementation(() => new Promise(resolve => {
        releasePromotion = () => resolve(undefined);
      }));
      const restoring = service.restoreLocalSnapshot('restore-owner', makeNormalizeContext());
      await vi.waitFor(() => expect(releasePromotion).toBeTypeOf('function'));

      const quiescence = new LocalBackupUiRestoreWriterQuiescenceService({ pollIntervalMs: 1 });
      let prepared = false;
      const preparing = quiescence.prepare('restore-owner').then(handle => {
        prepared = true;
        return handle;
      });
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(prepared).toBe(false);

      releasePromotion();
      await restoring;
      const handle = await preparing;
      expect(prepared).toBe(true);
      await handle.abortBeforeMutation();
    });
  });

  // ─── isSnapshotNewer ──────────────────────────

  registerDockSnapshotNewerSpecs({
    getService: () => service,
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

    it('should default isDockExpanded to false when undefined', () => {
      const raw = makeMinimalSnapshot();
      delete (raw as Record<string, unknown>).isDockExpanded;
      const result = service.normalizeSnapshot(raw, ctx);
      expect(result!.isDockExpanded).toBe(false);
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

    it('should retain the legacy source when owner IndexedDB promotion fails', async () => {
      const snapshot = makeMinimalSnapshot({
        focusMode: true,
        savedAt: '2025-01-15T12:34:56.000Z',
      });
      const key = service.legacyLocalStorageKey('user-1');
      const rawSnapshot = JSON.stringify(snapshot);
      localStorage.setItem(key, rawSnapshot);
      mockSet.mockRejectedValue(new Error('idb unavailable'));

      const restored = await service.restoreLocalSnapshot('user-1', ctx);

      expect(restored?.focusMode).toBe(true);
      expect(localStorage.getItem(key)).toBe(rawSnapshot);
      expect(mockDel).not.toHaveBeenCalled();
    });

    it('should migrate legacy anonymous IDB snapshot into local-user bucket on restore', async () => {
      const anonymousSnapshot = makeMinimalSnapshot({
        focusMode: true,
        savedAt: '2025-01-15T11:00:00.000Z',
      });
      mockGet.mockImplementation(async (key: string) => {
        if (key === service.localCacheKey(null)) {
          return anonymousSnapshot;
        }

        return null;
      });

      const restored = await service.restoreLocalSnapshot('local-user', ctx);

      expect(restored?.focusMode).toBe(true);
      expect(mockSet).toHaveBeenCalledWith(
        service.localCacheKey('local-user'),
        expect.objectContaining({ focusMode: true }),
      );
      expect(mockDel).toHaveBeenCalledWith(service.localCacheKey(null));
      expect(localStorage.getItem(service.legacyLocalStorageKey('local-user'))).not.toBeNull();
      expect(localStorage.getItem(service.legacyLocalStorageKey(null))).toBeNull();
    });

    it('should prefer a newer anonymous snapshot over an older local-user snapshot during migration', async () => {
      const localUserSnapshot = makeMinimalSnapshot({
        focusMode: false,
        savedAt: '2025-01-15T10:00:00.000Z',
      });
      const anonymousSnapshot = makeMinimalSnapshot({
        focusMode: true,
        savedAt: '2025-01-15T12:00:00.000Z',
      });
      mockGet.mockImplementation(async (key: string) => {
        if (key === service.localCacheKey('local-user')) {
          return localUserSnapshot;
        }

        if (key === service.localCacheKey(null)) {
          return anonymousSnapshot;
        }

        return null;
      });

      const restored = await service.restoreLocalSnapshot('local-user', ctx);

      expect(restored?.focusMode).toBe(true);
      expect(mockSet).toHaveBeenCalledWith(
        service.localCacheKey('local-user'),
        expect.objectContaining({ focusMode: true }),
      );
      expect(mockDel).toHaveBeenCalledWith(service.localCacheKey(null));
    });

    it('should keep a newer local-user snapshot and clean up stale anonymous fallback bucket', async () => {
      const localUserSnapshot = makeMinimalSnapshot({
        focusMode: true,
        savedAt: '2025-01-15T12:00:00.000Z',
      });
      const anonymousSnapshot = makeMinimalSnapshot({
        focusMode: false,
        savedAt: '2025-01-15T10:00:00.000Z',
      });
      mockGet.mockImplementation(async (key: string) => {
        if (key === service.localCacheKey('local-user')) {
          return localUserSnapshot;
        }

        if (key === service.localCacheKey(null)) {
          return anonymousSnapshot;
        }

        return null;
      });

      const restored = await service.restoreLocalSnapshot('local-user', ctx);

      expect(restored?.focusMode).toBe(true);
      expect(mockSet).not.toHaveBeenCalled();
      expect(mockDel).toHaveBeenCalledWith(service.localCacheKey(null));
    });

    it('should migrate legacy anonymous localStorage snapshot into local-user bucket on restore', async () => {
      mockGet.mockResolvedValue(null);
      localStorage.setItem(
        service.legacyLocalStorageKey(null),
        JSON.stringify(
          makeMinimalSnapshot({
            focusMode: true,
            savedAt: '2025-01-15T12:00:00.000Z',
          }),
        ),
      );

      const restored = await service.restoreLocalSnapshot('local-user', ctx);

      expect(restored?.focusMode).toBe(true);
      expect(mockSet).toHaveBeenCalledWith(
        service.localCacheKey('local-user'),
        expect.objectContaining({ focusMode: true }),
      );
      expect(mockDel).toHaveBeenCalledWith(service.localCacheKey(null));
      expect(localStorage.getItem(service.legacyLocalStorageKey('local-user'))).not.toBeNull();
      expect(localStorage.getItem(service.legacyLocalStorageKey(null))).toBeNull();
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

  registerDockSnapshotPendingPersistSpecs({
    getService: () => service,
    makeMinimalSnapshot,
    mockSet: () => mockSet,
  });
});

// ─── Standalone normalizeNullableNumber ─────

registerNormalizeNullableNumberSpecs();
