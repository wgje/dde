import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DockDailySlotService, DockDailySlotContext } from './dock-daily-slot.service';
import { AuthService } from './auth.service';
import { DockCloudSyncService } from './dock-cloud-sync.service';
import { FocusPreferenceService } from './focus-preference.service';
import { LoggerService } from './logger.service';
import { DEFAULT_FOCUS_PREFERENCES, FocusPreferences } from '../models/focus';
import {
  DailySlotEntry,
  DockSchedulerPhase,
  FragmentDefenseLevel,
} from '../models/parking-dock';

// ---------------------------------------------------------------------------
//  Mock services
// ---------------------------------------------------------------------------

const focusPreferencesSignal = signal<FocusPreferences>({ ...DEFAULT_FOCUS_PREFERENCES });

const mockFocusPreferenceService = {
  preferences: focusPreferencesSignal,
};

const mockAuthService = {
  currentUserId: signal<string | null>(null),
};

const mockCloudSyncService = {
  enqueueRoutineTaskSync: vi.fn(),
  enqueueRoutineCompletionSync: vi.fn(),
};

const mockLoggerCategory = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const mockLoggerService = {
  category: vi.fn(() => mockLoggerCategory),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

// ---------------------------------------------------------------------------
//  Helper: build a DockDailySlotContext with writable signals
// ---------------------------------------------------------------------------

function buildContext(overrides?: {
  dailySlots?: DailySlotEntry[];
  dailyResetDate?: string;
  schedulerPhase?: DockSchedulerPhase;
  fragmentDefenseLevel?: FragmentDefenseLevel;
  isFragmentPhase?: boolean;
}): DockDailySlotContext {
  const dailySlots = signal<DailySlotEntry[]>(overrides?.dailySlots ?? []);
  const schedulerPhase = signal<DockSchedulerPhase>(overrides?.schedulerPhase ?? 'active');
  const fragmentDefenseLevel = signal<FragmentDefenseLevel>(overrides?.fragmentDefenseLevel ?? 1);
  const isFragmentPhaseSignal = signal<boolean>(overrides?.isFragmentPhase ?? false);
  return {
    dailySlots,
    dailyResetDate: signal<string>(overrides?.dailyResetDate ?? ''),
    schedulerPhase,
    fragmentDefenseLevel,
    isFragmentPhase: isFragmentPhaseSignal,
  };
}

// ---------------------------------------------------------------------------
//  Tests
// ---------------------------------------------------------------------------

describe('DockDailySlotService', () => {
  let service: DockDailySlotService;
  let ctx: DockDailySlotContext;

  beforeEach(() => {
    vi.clearAllMocks();
    focusPreferencesSignal.set({ ...DEFAULT_FOCUS_PREFERENCES });

    TestBed.configureTestingModule({
      providers: [
        DockDailySlotService,
        { provide: AuthService, useValue: mockAuthService },
        { provide: DockCloudSyncService, useValue: mockCloudSyncService },
        { provide: FocusPreferenceService, useValue: mockFocusPreferenceService },
        { provide: LoggerService, useValue: mockLoggerService },
      ],
    });

    service = TestBed.inject(DockDailySlotService);
    ctx = buildContext();
    service.init(ctx);
  });

  // -----------------------------------------------------------------------
  //  todayDateKey
  // -----------------------------------------------------------------------

  describe('todayDateKey', () => {
    it('returns YYYY-MM-DD format', () => {
      const result = service.todayDateKey(new Date(2025, 5, 15, 14, 0, 0));
      expect(result).toBe('2025-06-15');
    });

    it('adjusts for routine reset hour (before reset → previous day)', () => {
      // Set reset hour to 5 AM
      focusPreferencesSignal.set({ ...DEFAULT_FOCUS_PREFERENCES, routineResetHourLocal: 5 });

      // 3 AM is before the 5 AM reset → should return previous day
      const result = service.todayDateKey(new Date(2025, 5, 15, 3, 0, 0));
      expect(result).toBe('2025-06-14');
    });

    it('does not adjust when time is after reset hour', () => {
      focusPreferencesSignal.set({ ...DEFAULT_FOCUS_PREFERENCES, routineResetHourLocal: 5 });

      // 6 AM is after the 5 AM reset → should return same day
      const result = service.todayDateKey(new Date(2025, 5, 15, 6, 0, 0));
      expect(result).toBe('2025-06-15');
    });
  });

  // -----------------------------------------------------------------------
  //  addDailySlot
  // -----------------------------------------------------------------------

  describe('addDailySlot', () => {
    it('creates a new slot with correct defaults', () => {
      const id = service.addDailySlot('Morning exercise');

      expect(id).toBeTruthy();
      const slots = ctx.dailySlots();
      expect(slots).toHaveLength(1);
      expect(slots[0]).toEqual(
        expect.objectContaining({
          id,
          title: 'Morning exercise',
          maxDailyCount: 1,
          todayCompletedCount: 0,
          isEnabled: true,
        }),
      );
      expect(slots[0].createdAt).toBeTruthy();
    });

    it('respects custom maxDailyCount', () => {
      service.addDailySlot('Drink water', 3);

      const slots = ctx.dailySlots();
      expect(slots[0].maxDailyCount).toBe(3);
    });

    it('floors maxDailyCount to at least 1', () => {
      service.addDailySlot('Task', 0);
      expect(ctx.dailySlots()[0].maxDailyCount).toBe(1);

      service.addDailySlot('Task2', -5);
      expect(ctx.dailySlots()[1].maxDailyCount).toBe(1);
    });

    it('trims title and falls back to default for empty', () => {
      service.addDailySlot('  ');
      expect(ctx.dailySlots()[0].title).toBe('Untitled daily task');
    });
  });

  // -----------------------------------------------------------------------
  //  setDailySlotEnabled
  // -----------------------------------------------------------------------

  describe('setDailySlotEnabled', () => {
    it('toggles enabled state', () => {
      const id = service.addDailySlot('Slot');
      expect(ctx.dailySlots()[0].isEnabled).toBe(true);

      service.setDailySlotEnabled(id, false);
      expect(ctx.dailySlots()[0].isEnabled).toBe(false);

      service.setDailySlotEnabled(id, true);
      expect(ctx.dailySlots()[0].isEnabled).toBe(true);
    });

    it('does nothing when value is the same', () => {
      const id = service.addDailySlot('Slot');
      vi.clearAllMocks();

      service.setDailySlotEnabled(id, true); // already true
      // Signal should not have been updated (no cloud sync enqueued)
      expect(mockCloudSyncService.enqueueRoutineTaskSync).not.toHaveBeenCalled();
    });

    it('does nothing for non-existent id', () => {
      service.setDailySlotEnabled('non-existent', false);
      // Should not throw
      expect(ctx.dailySlots()).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  //  completeDailySlot
  // -----------------------------------------------------------------------

  describe('completeDailySlot', () => {
    it('increments todayCompletedCount', () => {
      const id = service.addDailySlot('Slot', 3);
      expect(ctx.dailySlots()[0].todayCompletedCount).toBe(0);

      service.completeDailySlot(id);
      expect(ctx.dailySlots()[0].todayCompletedCount).toBe(1);

      service.completeDailySlot(id);
      expect(ctx.dailySlots()[0].todayCompletedCount).toBe(2);
    });

    it('caps todayCompletedCount at maxDailyCount', () => {
      const id = service.addDailySlot('Slot', 1);

      service.completeDailySlot(id);
      expect(ctx.dailySlots()[0].todayCompletedCount).toBe(1);

      service.completeDailySlot(id);
      // Should not exceed maxDailyCount
      expect(ctx.dailySlots()[0].todayCompletedCount).toBe(1);
    });

    it('does nothing for non-existent id', () => {
      service.completeDailySlot('non-existent');
      expect(ctx.dailySlots()).toHaveLength(0);
    });

    it('sets fragment defense to 4 and pauses scheduler in fragment phase with level >= 3', () => {
      ctx = buildContext({ isFragmentPhase: true, fragmentDefenseLevel: 3 });
      service.init(ctx);

      const id = service.addDailySlot('Slot');
      service.completeDailySlot(id);

      expect(ctx.fragmentDefenseLevel()).toBe(4);
      expect(ctx.schedulerPhase()).toBe('paused');
    });
  });

  // -----------------------------------------------------------------------
  //  skipDailySlot
  // -----------------------------------------------------------------------

  describe('skipDailySlot', () => {
    it('marks slot as fully completed (sets todayCompletedCount to maxDailyCount)', () => {
      const id = service.addDailySlot('Slot', 3);
      expect(ctx.dailySlots()[0].todayCompletedCount).toBe(0);

      service.skipDailySlot(id);
      expect(ctx.dailySlots()[0].todayCompletedCount).toBe(3);
    });
  });

  // -----------------------------------------------------------------------
  //  removeDailySlot
  // -----------------------------------------------------------------------

  describe('removeDailySlot', () => {
    it('removes the slot from the list', () => {
      const id1 = service.addDailySlot('Slot A');
      const id2 = service.addDailySlot('Slot B');
      expect(ctx.dailySlots()).toHaveLength(2);

      service.removeDailySlot(id1);
      expect(ctx.dailySlots()).toHaveLength(1);
      expect(ctx.dailySlots()[0].id).toBe(id2);
    });

    it('does nothing for non-existent id', () => {
      service.addDailySlot('Slot');
      service.removeDailySlot('non-existent');
      expect(ctx.dailySlots()).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  //  resetDailySlotsIfNeeded
  // -----------------------------------------------------------------------

  describe('resetDailySlotsIfNeeded', () => {
    it('resets todayCompletedCount when date changes', () => {
      // Seed with a slot that has completions
      ctx = buildContext({
        dailySlots: [
          {
            id: 'slot-1',
            title: 'Morning',
            maxDailyCount: 2,
            todayCompletedCount: 2,
            isEnabled: true,
            createdAt: new Date().toISOString(),
          },
        ],
        dailyResetDate: '2025-06-14',
      });
      service.init(ctx);

      // todayDateKey returns '2025-06-15' (different from stored '2025-06-14')
      vi.spyOn(service, 'todayDateKey').mockReturnValue('2025-06-15');

      service.resetDailySlotsIfNeeded();

      expect(ctx.dailyResetDate()).toBe('2025-06-15');
      expect(ctx.dailySlots()[0].todayCompletedCount).toBe(0);
    });

    it('does nothing when date has not changed', () => {
      ctx = buildContext({
        dailySlots: [
          {
            id: 'slot-1',
            title: 'Morning',
            maxDailyCount: 2,
            todayCompletedCount: 2,
            isEnabled: true,
            createdAt: new Date().toISOString(),
          },
        ],
        dailyResetDate: '2025-06-15',
      });
      service.init(ctx);

      vi.spyOn(service, 'todayDateKey').mockReturnValue('2025-06-15');

      service.resetDailySlotsIfNeeded();

      // todayCompletedCount should remain unchanged
      expect(ctx.dailySlots()[0].todayCompletedCount).toBe(2);
    });
  });
});
