import { Injectable, Signal, WritableSignal, inject } from '@angular/core';
import { PARKING_CONFIG } from '../config/parking.config';
import {
  DailySlotEntry,
  DockSchedulerPhase,
  FragmentDefenseLevel,
  RoutineCompletionMutation,
} from '../models/parking-dock';
import { AuthService } from './auth.service';
import { DockCloudSyncService } from './dock-cloud-sync.service';
import { FocusPreferenceService } from './focus-preference.service';
import { LoggerService } from './logger.service';

export interface DockDailySlotContext {
  dailySlots: WritableSignal<DailySlotEntry[]>;
  dailyResetDate: WritableSignal<string>;
  schedulerPhase: WritableSignal<DockSchedulerPhase>;
  fragmentDefenseLevel: WritableSignal<FragmentDefenseLevel>;
  isFragmentPhase: Signal<boolean>;
}

@Injectable({ providedIn: 'root' })
export class DockDailySlotService {
  private readonly auth = inject(AuthService);
  private readonly cloudSync = inject(DockCloudSyncService);
  private readonly focusPreferenceService = inject(FocusPreferenceService);
  private readonly logger = inject(LoggerService).category('DockDailySlot');

  private _dailySlots: WritableSignal<DailySlotEntry[]> | null = null;
  private _dailyResetDate: WritableSignal<string> | null = null;
  private _schedulerPhase: WritableSignal<DockSchedulerPhase> | null = null;
  private _fragmentDefenseLevel: WritableSignal<FragmentDefenseLevel> | null = null;
  private _isFragmentPhase: Signal<boolean> | null = null;

  private assertInitialized(): asserts this is this & {
    _dailySlots: WritableSignal<DailySlotEntry[]>;
    _dailyResetDate: WritableSignal<string>;
    _schedulerPhase: WritableSignal<DockSchedulerPhase>;
    _fragmentDefenseLevel: WritableSignal<FragmentDefenseLevel>;
    _isFragmentPhase: Signal<boolean>;
  } {
    if (!this._dailySlots) {
      throw new Error('DockDailySlotService.init() must be called before use');
    }
  }

  init(ctx: DockDailySlotContext): void {
    if (this._dailySlots) {
      this.logger.warn('init() called again — overwriting previous context');
    }
    this._dailySlots = ctx.dailySlots;
    this._dailyResetDate = ctx.dailyResetDate;
    this._schedulerPhase = ctx.schedulerPhase;
    this._fragmentDefenseLevel = ctx.fragmentDefenseLevel;
    this._isFragmentPhase = ctx.isFragmentPhase;
  }

  todayDateKey(now: Date = new Date()): string {
    const rawResetHour = Number(this.focusPreferenceService.preferences().routineResetHourLocal);
    const resetHour = Number.isFinite(rawResetHour)
      ? Math.min(23, Math.max(0, Math.floor(rawResetHour)))
      : PARKING_CONFIG.ROUTINE_RESET_HOUR_DEFAULT;
    const logicalDate = new Date(now);
    if (logicalDate.getHours() < resetHour) {
      logicalDate.setDate(logicalDate.getDate() - 1);
    }
    const year = logicalDate.getFullYear();
    const month = String(logicalDate.getMonth() + 1).padStart(2, '0');
    const day = String(logicalDate.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  addDailySlot(title: string, maxDailyCount = 1): string {
    this.assertInitialized();
    const id = crypto.randomUUID();
    const slot: DailySlotEntry = {
      id,
      title: title.trim() || 'Untitled daily task',
      maxDailyCount: Math.max(1, Math.floor(maxDailyCount)),
      todayCompletedCount: 0,
      isEnabled: true,
      createdAt: new Date().toISOString(),
    };
    this._dailySlots.update(prev => [...prev, slot]);
    const userId = this.auth.currentUserId();
    if (userId) {
      this.cloudSync.enqueueRoutineTaskSync(userId, {
        routineId: slot.id,
        title: slot.title,
        triggerCondition: 'any-blank-period',
        maxTimesPerDay: slot.maxDailyCount,
        isEnabled: true,
      });
    }
    return id;
  }

  setDailySlotEnabled(id: string, enabled: boolean): void {
    this.assertInitialized();
    const target = this._dailySlots().find(slot => slot.id === id) ?? null;
    if (!target || target.isEnabled === enabled) return;
    this._dailySlots.update(prev =>
      prev.map(slot => (slot.id === id ? { ...slot, isEnabled: enabled } : slot)),
    );
    const userId = this.auth.currentUserId();
    if (userId) {
      this.cloudSync.enqueueRoutineTaskSync(userId, {
        routineId: target.id,
        title: target.title,
        triggerCondition: 'any-blank-period',
        maxTimesPerDay: target.maxDailyCount,
        isEnabled: enabled,
      });
    }
  }

  completeDailySlot(id: string): void {
    this.assertInitialized();
    const target = this._dailySlots().find(slot => slot.id === id) ?? null;
    if (!target) return;
    this._dailySlots.update(prev =>
      prev.map(slot =>
        slot.id === id
          ? { ...slot, todayCompletedCount: Math.min(slot.maxDailyCount, slot.todayCompletedCount + 1) }
          : slot,
      ),
    );
    const userId = this.auth.currentUserId();
    if (userId) {
      const completion: RoutineCompletionMutation = {
        completionId: crypto.randomUUID(),
        userId,
        routineId: target.id,
        dateKey: this.todayDateKey(),
      };
      this.cloudSync.enqueueRoutineCompletionSync(completion);
    }
    if (this._isFragmentPhase() && this._fragmentDefenseLevel() >= 3) {
      this._fragmentDefenseLevel.set(4);
      this._schedulerPhase.set('paused');
    }
  }

  skipDailySlot(id: string): void {
    this.assertInitialized();
    this._dailySlots.update(prev =>
      prev.map(slot =>
        slot.id === id
          ? { ...slot, todayCompletedCount: slot.maxDailyCount }
          : slot,
      ),
    );
  }

  removeDailySlot(id: string): void {
    this.assertInitialized();
    const removed = this._dailySlots().find(slot => slot.id === id) ?? null;
    this._dailySlots.update(prev => prev.filter(slot => slot.id !== id));
    const userId = this.auth.currentUserId();
    if (userId && removed) {
      this.cloudSync.enqueueRoutineTaskSync(userId, {
        routineId: removed.id,
        title: removed.title,
        triggerCondition: 'any-blank-period',
        maxTimesPerDay: removed.maxDailyCount,
        isEnabled: false,
      });
    }
  }

  resetDailySlotsIfNeeded(): void {
    this.assertInitialized();
    const today = this.todayDateKey();
    if (today === this._dailyResetDate()) return;
    this._dailyResetDate.set(today);
    this._dailySlots.update(prev => prev.map(slot => ({ ...slot, todayCompletedCount: 0 })));
  }
}
