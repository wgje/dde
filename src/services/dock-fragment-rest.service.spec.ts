import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DockFragmentRestService, FragmentRestEngineCallbacks } from './dock-fragment-rest.service';
import { FocusPreferenceService } from './focus-preference.service';
import { LoggerService } from './logger.service';
import { PARKING_CONFIG } from '../config/parking.config';
import { DEFAULT_FOCUS_PREFERENCES, FocusPreferences } from '../models/focus';
import {
  DockEntry,
  DockRuleDecision,
  DockSchedulerPhase,
  FragmentDefenseLevel,
  HighLoadCounter,
} from '../models/parking-dock';

// ---------------------------------------------------------------------------
//  Helper: build a minimal DockEntry
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<DockEntry> & { taskId: string }): DockEntry {
  return {
    title: overrides.taskId,
    sourceProjectId: null,
    status: 'pending_start',
    load: 'low',
    expectedMinutes: 25,
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

// ---------------------------------------------------------------------------
//  Mock services
// ---------------------------------------------------------------------------

const focusPreferencesSignal = signal<FocusPreferences>({ ...DEFAULT_FOCUS_PREFERENCES });

const mockFocusPreferenceService = {
  preferences: focusPreferencesSignal,
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
//  Factory: create engine callbacks with writable signals
// ---------------------------------------------------------------------------

function createMockCallbacks(): FragmentRestEngineCallbacks & {
  enterFragmentPhaseSpy: ReturnType<typeof vi.fn>;
  clearPendingDecisionStateSpy: ReturnType<typeof vi.fn>;
} {
  const enterFragmentPhaseSpy = vi.fn();
  const clearPendingDecisionStateSpy = vi.fn();
  return {
    enterFragmentPhase: enterFragmentPhaseSpy,
    clearPendingDecisionState: clearPendingDecisionStateSpy,
    entries: signal<DockEntry[]>([]),
    focusMode: signal(true),
    schedulerPhase: signal<DockSchedulerPhase>('active'),
    fragmentDefenseLevel: signal<FragmentDefenseLevel>(1),
    burnoutTriggeredAt: signal<number | null>(null),
    highLoadCounter: signal<HighLoadCounter>({ count: 0, windowStartAt: 0 }),
    focusingEntry: signal<DockEntry | null>(null),
    lastRuleDecision: signal<DockRuleDecision | null>(null),
    isFragmentPhase: signal(false),
    getWaitRemainingSeconds: vi.fn(() => null),
    enterFragmentPhaseSpy,
    clearPendingDecisionStateSpy,
  };
}

// ---------------------------------------------------------------------------
//  Test suite
// ---------------------------------------------------------------------------

describe('DockFragmentRestService', () => {
  let service: DockFragmentRestService;
  let callbacks: ReturnType<typeof createMockCallbacks>;

  beforeEach(() => {
    vi.useFakeTimers();

    // Reset the preferences signal to defaults
    focusPreferencesSignal.set({ ...DEFAULT_FOCUS_PREFERENCES });

    TestBed.configureTestingModule({
      providers: [
        DockFragmentRestService,
        { provide: FocusPreferenceService, useValue: mockFocusPreferenceService },
        { provide: LoggerService, useValue: mockLoggerService },
      ],
    });

    service = TestBed.inject(DockFragmentRestService);
    callbacks = createMockCallbacks();
    service.init(callbacks);
  });

  afterEach(() => {
    // Clean up any running timers
    service.resetAll();
    vi.useRealTimers();
  });

  // ─── 1. Initial State ──────────────────────────

  describe('initial state', () => {
    it('fragmentEntryCountdown should be null', () => {
      expect(service.fragmentEntryCountdown()).toBeNull();
    });

    it('cumulativeHighLoadMs should be 0', () => {
      expect(service.cumulativeHighLoadMs()).toBe(0);
    });

    it('cumulativeLowLoadMs should be 0', () => {
      expect(service.cumulativeLowLoadMs()).toBe(0);
    });

    it('restReminderHighShown should be false', () => {
      expect(service.restReminderHighShown()).toBe(false);
    });

    it('restReminderLowShown should be false', () => {
      expect(service.restReminderLowShown()).toBe(false);
    });

    it('restReminderActive should be false', () => {
      expect(service.restReminderActive()).toBe(false);
    });

    it('activeFragmentEvent should be null', () => {
      expect(service.activeFragmentEvent()).toBeNull();
    });
  });

  // ─── 2. startFragmentEntryCountdown ────────────

  describe('startFragmentEntryCountdown', () => {
    it('should set fragmentEntryCountdown to default value', () => {
      service.startFragmentEntryCountdown();
      expect(service.fragmentEntryCountdown()).toBe(PARKING_CONFIG.FRAGMENT_ENTRY_COUNTDOWN_S);
    });

    it('should set fragmentEntryCountdown with custom countdownSeconds', () => {
      service.startFragmentEntryCountdown({ countdownSeconds: 15 });
      expect(service.fragmentEntryCountdown()).toBe(15);
    });

    it('should decrement countdown each second', () => {
      service.startFragmentEntryCountdown({ countdownSeconds: 5 });
      expect(service.fragmentEntryCountdown()).toBe(5);

      vi.advanceTimersByTime(1000);
      expect(service.fragmentEntryCountdown()).toBe(4);

      vi.advanceTimersByTime(1000);
      expect(service.fragmentEntryCountdown()).toBe(3);
    });

    it('should call enterFragmentPhase when countdown reaches 0', () => {
      service.startFragmentEntryCountdown({ countdownSeconds: 3 });

      vi.advanceTimersByTime(3000);
      expect(callbacks.enterFragmentPhaseSpy).toHaveBeenCalledOnce();
      expect(service.fragmentEntryCountdown()).toBeNull();
    });

    it('should pass context to enterFragmentPhase', () => {
      service.startFragmentEntryCountdown({
        reason: 'test-reason',
        rootTaskId: 'task-1',
        remainingMinutes: 10,
        countdownSeconds: 2,
      });

      vi.advanceTimersByTime(2000);
      expect(callbacks.enterFragmentPhaseSpy).toHaveBeenCalledWith(
        'test-reason',
        'task-1',
        10,
      );
    });

    it('should clear pending decision state by default', () => {
      service.startFragmentEntryCountdown();
      expect(callbacks.clearPendingDecisionStateSpy).toHaveBeenCalledOnce();
    });

    it('should preserve pending decision when option is set', () => {
      service.startFragmentEntryCountdown({ preservePendingDecision: true });
      expect(callbacks.clearPendingDecisionStateSpy).not.toHaveBeenCalled();
    });

    it('should stop previous countdown when starting a new one', () => {
      service.startFragmentEntryCountdown({ countdownSeconds: 10 });
      expect(service.fragmentEntryCountdown()).toBe(10);

      service.startFragmentEntryCountdown({ countdownSeconds: 5 });
      expect(service.fragmentEntryCountdown()).toBe(5);

      // Advance enough for old timer — should not trigger double enterFragmentPhase
      vi.advanceTimersByTime(5000);
      expect(callbacks.enterFragmentPhaseSpy).toHaveBeenCalledOnce();
    });
  });

  // ─── 3. stopFragmentEntryCountdown ─────────────

  describe('stopFragmentEntryCountdown', () => {
    it('should clear the countdown', () => {
      service.startFragmentEntryCountdown({ countdownSeconds: 10 });
      expect(service.fragmentEntryCountdown()).toBe(10);

      service.stopFragmentEntryCountdown();
      expect(service.fragmentEntryCountdown()).toBeNull();
    });

    it('should stop the timer from ticking', () => {
      service.startFragmentEntryCountdown({ countdownSeconds: 10 });
      service.stopFragmentEntryCountdown();

      vi.advanceTimersByTime(5000);
      // Countdown should remain null (timer cleared)
      expect(service.fragmentEntryCountdown()).toBeNull();
      expect(callbacks.enterFragmentPhaseSpy).not.toHaveBeenCalled();
    });

    it('should clear context by default', () => {
      service.startFragmentEntryCountdown({
        reason: 'ctx-reason',
        countdownSeconds: 10,
      });
      service.stopFragmentEntryCountdown(); // clearContext = true by default

      // Restarting without context should use default reason
      service.acceptFragmentEntry();
      // enterFragmentPhase is called with the default reason since context was cleared
      expect(callbacks.enterFragmentPhaseSpy).toHaveBeenCalledWith(
        '碎片时间倒计时结束/用户确认，进入碎片阶段',
        undefined,
        undefined,
      );
    });

    it('should preserve context when clearContext=false', () => {
      service.startFragmentEntryCountdown({
        reason: 'preserved-reason',
        rootTaskId: 'root-1',
        countdownSeconds: 10,
      });
      service.stopFragmentEntryCountdown(false);

      // Internal context should be preserved; acceptFragmentEntry reads it
      service.acceptFragmentEntry();
      expect(callbacks.enterFragmentPhaseSpy).toHaveBeenCalledWith(
        'preserved-reason',
        'root-1',
        undefined,
      );
    });
  });

  // ─── 4. acceptFragmentEntry / skipFragmentEntry ─

  describe('acceptFragmentEntry', () => {
    it('should clear the countdown and enter fragment phase', () => {
      service.startFragmentEntryCountdown({
        reason: 'accept-test',
        countdownSeconds: 10,
      });

      service.acceptFragmentEntry();
      expect(service.fragmentEntryCountdown()).toBeNull();
      expect(callbacks.enterFragmentPhaseSpy).toHaveBeenCalledOnce();
      expect(callbacks.enterFragmentPhaseSpy).toHaveBeenCalledWith(
        'accept-test',
        undefined,
        undefined,
      );
    });

    it('should not fire timer after accept', () => {
      service.startFragmentEntryCountdown({ countdownSeconds: 3 });
      service.acceptFragmentEntry();

      vi.advanceTimersByTime(5000);
      // Should only have been called once (by accept), not again by timer
      expect(callbacks.enterFragmentPhaseSpy).toHaveBeenCalledOnce();
    });
  });

  describe('skipFragmentEntry', () => {
    it('should clear the countdown', () => {
      service.startFragmentEntryCountdown({ countdownSeconds: 10 });

      service.skipFragmentEntry();
      expect(service.fragmentEntryCountdown()).toBeNull();
    });

    it('should set fragment dismissed state', () => {
      service.skipFragmentEntry();
      expect(service.isFragmentDismissed()).toBe(true);
    });

    it('should not enter fragment phase', () => {
      service.startFragmentEntryCountdown({ countdownSeconds: 10 });
      service.skipFragmentEntry();

      vi.advanceTimersByTime(15000);
      expect(callbacks.enterFragmentPhaseSpy).not.toHaveBeenCalled();
    });
  });

  // ─── 5. resetAll ────────────────────────────────

  describe('resetAll', () => {
    it('should stop fragment countdown', () => {
      service.startFragmentEntryCountdown({ countdownSeconds: 10 });
      service.resetAll();

      expect(service.fragmentEntryCountdown()).toBeNull();
    });

    it('should reset fragment dismissed state', () => {
      service.setFragmentDismissed(true);
      service.resetAll();

      expect(service.isFragmentDismissed()).toBe(false);
    });

    it('should clear active fragment event', () => {
      // Force-set via getFragmentEventRecommendation
      (callbacks.fragmentDefenseLevel as ReturnType<typeof signal<FragmentDefenseLevel>>).set(2);
      service.getFragmentEventRecommendation();

      service.resetAll();
      expect(service.activeFragmentEvent()).toBeNull();
    });

    it('should reset all rest reminder state', () => {
      service.tickRestReminderAccumulator('high', 'high');
      service.cumulativeHighLoadMs.set(999999);
      service.restReminderHighShown.set(true);
      service.restReminderActive.set(true);

      service.resetAll();

      expect(service.cumulativeHighLoadMs()).toBe(0);
      expect(service.cumulativeLowLoadMs()).toBe(0);
      expect(service.restReminderHighShown()).toBe(false);
      expect(service.restReminderLowShown()).toBe(false);
      expect(service.restReminderActive()).toBe(false);
    });
  });

  // ─── 6. tickRestReminderAccumulator ─────────────

  describe('tickRestReminderAccumulator', () => {
    it('should not accumulate when focusMode is false', () => {
      service.tickRestReminderAccumulator(false, 'high');
      expect(service.cumulativeHighLoadMs()).toBe(0);
    });

    it('should not accumulate when focusingLoad is null', () => {
      service.tickRestReminderAccumulator(true, null);
      expect(service.cumulativeHighLoadMs()).toBe(0);
      expect(service.cumulativeLowLoadMs()).toBe(0);
    });

    it('should accumulate high-load time', () => {
      service.tickRestReminderAccumulator(true, 'high');
      expect(service.cumulativeHighLoadMs()).toBe(10_000);

      service.tickRestReminderAccumulator(true, 'high');
      expect(service.cumulativeHighLoadMs()).toBe(20_000);
    });

    it('should accumulate low-load time', () => {
      service.tickRestReminderAccumulator(true, 'low');
      expect(service.cumulativeLowLoadMs()).toBe(10_000);

      service.tickRestReminderAccumulator(true, 'low');
      expect(service.cumulativeLowLoadMs()).toBe(20_000);
    });

    it('should trigger high-load rest reminder when threshold is reached', () => {
      // Default threshold: restReminderHighLoadMinutes = 90 min = 5,400,000 ms
      const thresholdMs = DEFAULT_FOCUS_PREFERENCES.restReminderHighLoadMinutes * 60_000;
      const ticks = Math.ceil(thresholdMs / 10_000);

      for (let i = 0; i < ticks; i++) {
        service.tickRestReminderAccumulator(true, 'high');
      }

      expect(service.restReminderHighShown()).toBe(true);
      expect(service.restReminderActive()).toBe(true);
    });

    it('should trigger low-load rest reminder when threshold is reached', () => {
      // Default threshold: restReminderLowLoadMinutes = 30 min = 1,800,000 ms
      const thresholdMs = DEFAULT_FOCUS_PREFERENCES.restReminderLowLoadMinutes * 60_000;
      const ticks = Math.ceil(thresholdMs / 10_000);

      for (let i = 0; i < ticks; i++) {
        service.tickRestReminderAccumulator(true, 'low');
      }

      expect(service.restReminderLowShown()).toBe(true);
      expect(service.restReminderActive()).toBe(true);
    });

    it('should not re-trigger reminder once already shown', () => {
      const thresholdMs = DEFAULT_FOCUS_PREFERENCES.restReminderHighLoadMinutes * 60_000;
      const ticks = Math.ceil(thresholdMs / 10_000);

      // First trigger
      for (let i = 0; i < ticks; i++) {
        service.tickRestReminderAccumulator(true, 'high');
      }
      expect(service.restReminderHighShown()).toBe(true);

      // Manually dismiss the active reminder but keep shown flag
      service.restReminderActive.set(false);

      // More ticks — should not re-trigger
      service.tickRestReminderAccumulator(true, 'high');
      expect(service.restReminderActive()).toBe(false);
    });
  });

  // ─── 7. dismissRestReminder ─────────────────────

  describe('dismissRestReminder', () => {
    it('should clear restReminderActive', () => {
      service.restReminderActive.set(true);
      service.dismissRestReminder();
      expect(service.restReminderActive()).toBe(false);
    });

    it('should reset high-load accumulator when high was shown', () => {
      service.restReminderHighShown.set(true);
      service.cumulativeHighLoadMs.set(999_000);

      service.dismissRestReminder();

      expect(service.cumulativeHighLoadMs()).toBe(0);
      expect(service.restReminderHighShown()).toBe(false);
    });

    it('should reset low-load accumulator when low was shown', () => {
      service.restReminderLowShown.set(true);
      service.cumulativeLowLoadMs.set(999_000);

      service.dismissRestReminder();

      expect(service.cumulativeLowLoadMs()).toBe(0);
      expect(service.restReminderLowShown()).toBe(false);
    });

    it('should not touch counters if reminders were not shown', () => {
      service.cumulativeHighLoadMs.set(50_000);
      service.cumulativeLowLoadMs.set(30_000);

      service.dismissRestReminder();

      expect(service.cumulativeHighLoadMs()).toBe(50_000);
      expect(service.cumulativeLowLoadMs()).toBe(30_000);
    });
  });

  // ─── 8. Fragment Event Recommendation ───────────

  describe('getFragmentEventRecommendation', () => {
    it('should return null when defense level < 2', () => {
      (callbacks.fragmentDefenseLevel as ReturnType<typeof signal<FragmentDefenseLevel>>).set(1);
      expect(service.getFragmentEventRecommendation()).toBeNull();
    });

    it('should return a recommendation when defense level >= 2', () => {
      (callbacks.fragmentDefenseLevel as ReturnType<typeof signal<FragmentDefenseLevel>>).set(2);
      const result = service.getFragmentEventRecommendation();
      expect(result).not.toBeNull();
      expect(result!.isPreset).toBe(true);
      expect(service.activeFragmentEvent()).toEqual(result);
    });

    it('should prioritize physical-crossover events', () => {
      (callbacks.fragmentDefenseLevel as ReturnType<typeof signal<FragmentDefenseLevel>>).set(3);
      const result = service.getFragmentEventRecommendation();
      expect(result!.category).toBe('physical-crossover');
    });
  });

  describe('completeFragmentEvent', () => {
    it('should return false when no active event', () => {
      expect(service.completeFragmentEvent()).toBe(false);
    });

    it('should clear active event and set defense level to 4', () => {
      (callbacks.fragmentDefenseLevel as ReturnType<typeof signal<FragmentDefenseLevel>>).set(2);
      service.getFragmentEventRecommendation();
      expect(service.activeFragmentEvent()).not.toBeNull();

      const result = service.completeFragmentEvent();
      expect(result).toBe(true);
      expect(service.activeFragmentEvent()).toBeNull();
      expect(callbacks.fragmentDefenseLevel()).toBe(4);
      expect(callbacks.schedulerPhase()).toBe('paused');
    });
  });

  describe('skipFragmentEvent', () => {
    it('should clear active event', () => {
      (callbacks.fragmentDefenseLevel as ReturnType<typeof signal<FragmentDefenseLevel>>).set(2);
      service.getFragmentEventRecommendation();

      service.skipFragmentEvent();
      expect(service.activeFragmentEvent()).toBeNull();
    });
  });

  // ─── 9. updateFragmentDefenseLevel ──────────────

  describe('updateFragmentDefenseLevel', () => {
    it('should set defense level to 1 and phase to active when no waiting entries', () => {
      (callbacks.entries as ReturnType<typeof signal<DockEntry[]>>).set([
        makeEntry({ taskId: 't1', status: 'focusing' }),
      ]);

      service.updateFragmentDefenseLevel();

      expect(callbacks.fragmentDefenseLevel()).toBe(1);
      expect(callbacks.schedulerPhase()).toBe('active');
    });

    it('should keep paused when defense level is 4 in fragment phase', () => {
      (callbacks.fragmentDefenseLevel as ReturnType<typeof signal<FragmentDefenseLevel>>).set(4);
      (callbacks.isFragmentPhase as ReturnType<typeof signal<boolean>>).set(true);

      service.updateFragmentDefenseLevel();

      expect(callbacks.schedulerPhase()).toBe('paused');
    });

    it('should determine defense level based on shortest wait time', () => {
      const now = new Date().toISOString();
      (callbacks.entries as ReturnType<typeof signal<DockEntry[]>>).set([
        makeEntry({
          taskId: 't1',
          status: 'suspended_waiting',
          waitStartedAt: now,
          waitMinutes: 20,
        }),
      ]);
      // Return 20 minutes remaining (= 1200 seconds)
      (callbacks.getWaitRemainingSeconds as ReturnType<typeof vi.fn>).mockReturnValue(1200);

      service.updateFragmentDefenseLevel();

      // 20 minutes → level 3 (15 < 20 ≤ 25)
      expect(callbacks.fragmentDefenseLevel()).toBe(3);
      expect(callbacks.schedulerPhase()).toBe('paused');
    });

    it('should factor in burnout state', () => {
      const now = new Date().toISOString();
      (callbacks.entries as ReturnType<typeof signal<DockEntry[]>>).set([
        makeEntry({
          taskId: 't1',
          status: 'suspended_waiting',
          waitStartedAt: now,
          waitMinutes: 30,
        }),
      ]);
      (callbacks.getWaitRemainingSeconds as ReturnType<typeof vi.fn>).mockReturnValue(1800);
      (callbacks.burnoutTriggeredAt as ReturnType<typeof signal<number | null>>).set(Date.now());

      service.updateFragmentDefenseLevel();

      // hasBurnout=true → level 2 regardless of wait time
      expect(callbacks.fragmentDefenseLevel()).toBe(2);
    });
  });

  // ─── 10. checkBurnoutCooldown ───────────────────

  describe('checkBurnoutCooldown', () => {
    it('should do nothing when burnoutTriggeredAt is null', () => {
      (callbacks.burnoutTriggeredAt as ReturnType<typeof signal<number | null>>).set(null);

      service.checkBurnoutCooldown();

      expect(callbacks.burnoutTriggeredAt()).toBeNull();
    });

    it('should not clear burnout before cooldown expires', () => {
      const triggeredAt = Date.now();
      (callbacks.burnoutTriggeredAt as ReturnType<typeof signal<number | null>>).set(triggeredAt);

      // Advance less than BURNOUT_COOLDOWN_MS
      vi.advanceTimersByTime(PARKING_CONFIG.BURNOUT_COOLDOWN_MS - 1000);

      service.checkBurnoutCooldown();

      expect(callbacks.burnoutTriggeredAt()).toBe(triggeredAt);
    });

    it('should clear burnout and reset counter after cooldown expires', () => {
      const triggeredAt = Date.now();
      (callbacks.burnoutTriggeredAt as ReturnType<typeof signal<number | null>>).set(triggeredAt);
      (callbacks.highLoadCounter as ReturnType<typeof signal<HighLoadCounter>>).set({
        count: 3,
        windowStartAt: triggeredAt - 1000,
      });

      vi.advanceTimersByTime(PARKING_CONFIG.BURNOUT_COOLDOWN_MS + 1);

      service.checkBurnoutCooldown();

      expect(callbacks.burnoutTriggeredAt()).toBeNull();
      expect(callbacks.highLoadCounter()).toEqual({ count: 0, windowStartAt: 0 });
    });
  });

  // ─── 11. dismissZenMode ─────────────────────────

  describe('dismissZenMode', () => {
    it('should do nothing when focusMode is false', () => {
      (callbacks.focusMode as ReturnType<typeof signal<boolean>>).set(false);
      (callbacks.fragmentDefenseLevel as ReturnType<typeof signal<FragmentDefenseLevel>>).set(4);

      service.dismissZenMode();

      // Defense level unchanged
      expect(callbacks.fragmentDefenseLevel()).toBe(4);
    });

    it('should set defense level to 2 and paused when in fragment phase', () => {
      (callbacks.focusMode as ReturnType<typeof signal<boolean>>).set(true);
      (callbacks.isFragmentPhase as ReturnType<typeof signal<boolean>>).set(true);
      (callbacks.fragmentDefenseLevel as ReturnType<typeof signal<FragmentDefenseLevel>>).set(4);

      service.dismissZenMode();

      expect(callbacks.fragmentDefenseLevel()).toBe(2);
      expect(callbacks.schedulerPhase()).toBe('paused');
    });

    it('should set defense level to 1 and active when not in fragment phase', () => {
      (callbacks.focusMode as ReturnType<typeof signal<boolean>>).set(true);
      (callbacks.isFragmentPhase as ReturnType<typeof signal<boolean>>).set(false);
      (callbacks.fragmentDefenseLevel as ReturnType<typeof signal<FragmentDefenseLevel>>).set(4);

      service.dismissZenMode();

      expect(callbacks.fragmentDefenseLevel()).toBe(1);
      expect(callbacks.schedulerPhase()).toBe('active');
    });
  });

  // ─── 12. resetRestState ─────────────────────────

  describe('resetRestState', () => {
    it('should reset all rest-related signals', () => {
      service.cumulativeHighLoadMs.set(100_000);
      service.cumulativeLowLoadMs.set(200_000);
      service.restReminderHighShown.set(true);
      service.restReminderLowShown.set(true);
      service.restReminderActive.set(true);

      service.resetRestState();

      expect(service.cumulativeHighLoadMs()).toBe(0);
      expect(service.cumulativeLowLoadMs()).toBe(0);
      expect(service.restReminderHighShown()).toBe(false);
      expect(service.restReminderLowShown()).toBe(false);
      expect(service.restReminderActive()).toBe(false);
    });
  });

  // ─── 13. Dismissed state helpers ────────────────

  describe('isFragmentDismissed / setFragmentDismissed', () => {
    it('should default to false', () => {
      expect(service.isFragmentDismissed()).toBe(false);
    });

    it('should set and get dismissed state', () => {
      service.setFragmentDismissed(true);
      expect(service.isFragmentDismissed()).toBe(true);

      service.setFragmentDismissed(false);
      expect(service.isFragmentDismissed()).toBe(false);
    });
  });
});
