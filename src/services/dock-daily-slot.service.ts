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

  /** 返回已初始化的上下文，未初始化时抛异常 */
  private ctx(): Required<{
    dailySlots: WritableSignal<DailySlotEntry[]>;
    dailyResetDate: WritableSignal<string>;
    schedulerPhase: WritableSignal<DockSchedulerPhase>;
    fragmentDefenseLevel: WritableSignal<FragmentDefenseLevel>;
    isFragmentPhase: Signal<boolean>;
  }> {
    if (!this._dailySlots || !this._dailyResetDate || !this._schedulerPhase || !this._fragmentDefenseLevel || !this._isFragmentPhase) {
      throw new Error('DockDailySlotService.init() must be called before use');
    }
    return {
      dailySlots: this._dailySlots,
      dailyResetDate: this._dailyResetDate,
      schedulerPhase: this._schedulerPhase,
      fragmentDefenseLevel: this._fragmentDefenseLevel,
      isFragmentPhase: this._isFragmentPhase,
    };
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
    const c = this.ctx();
    const id = crypto.randomUUID();
    const slot: DailySlotEntry = {
      id,
      title: title.trim() || 'Untitled daily task',
      maxDailyCount: Math.max(1, Math.floor(maxDailyCount)),
      todayCompletedCount: 0,
      isEnabled: true,
      createdAt: new Date().toISOString(),
    };
    c.dailySlots.update(prev => [...prev, slot]);
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
    const c = this.ctx();
    const target = c.dailySlots().find(slot => slot.id === id) ?? null;
    if (!target || target.isEnabled === enabled) return;
    c.dailySlots.update(prev =>
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
    const c = this.ctx();
    const target = c.dailySlots().find(slot => slot.id === id) ?? null;
    if (!target) return;
    c.dailySlots.update(prev =>
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
    if (c.isFragmentPhase() && c.fragmentDefenseLevel() >= 3) {
      c.fragmentDefenseLevel.set(4);
      c.schedulerPhase.set('paused');
    }
  }

  skipDailySlot(id: string): void {
    const c = this.ctx();
    c.dailySlots.update(prev =>
      prev.map(slot =>
        slot.id === id
          ? { ...slot, todayCompletedCount: slot.maxDailyCount }
          : slot,
      ),
    );
  }

  removeDailySlot(id: string): void {
    const c = this.ctx();
    const removed = c.dailySlots().find(slot => slot.id === id) ?? null;
    c.dailySlots.update(prev => prev.filter(slot => slot.id !== id));
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
    const c = this.ctx();
    const today = this.todayDateKey();
    if (today === c.dailyResetDate()) return;
    c.dailyResetDate.set(today);
    c.dailySlots.update(prev => prev.map(slot => ({ ...slot, todayCompletedCount: 0 })));
  }
}
