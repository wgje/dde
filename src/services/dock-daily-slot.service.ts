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

  private dailySlots!: WritableSignal<DailySlotEntry[]>;
  private dailyResetDate!: WritableSignal<string>;
  private schedulerPhase!: WritableSignal<DockSchedulerPhase>;
  private fragmentDefenseLevel!: WritableSignal<FragmentDefenseLevel>;
  private isFragmentPhase!: Signal<boolean>;

  init(ctx: DockDailySlotContext): void {
    this.dailySlots = ctx.dailySlots;
    this.dailyResetDate = ctx.dailyResetDate;
    this.schedulerPhase = ctx.schedulerPhase;
    this.fragmentDefenseLevel = ctx.fragmentDefenseLevel;
    this.isFragmentPhase = ctx.isFragmentPhase;
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
    const id = crypto.randomUUID();
    const slot: DailySlotEntry = {
      id,
      title: title.trim() || 'Untitled daily task',
      maxDailyCount: Math.max(1, Math.floor(maxDailyCount)),
      todayCompletedCount: 0,
      isEnabled: true,
      createdAt: new Date().toISOString(),
    };
    this.dailySlots.update(prev => [...prev, slot]);
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
    const target = this.dailySlots().find(slot => slot.id === id) ?? null;
    if (!target || target.isEnabled === enabled) return;
    this.dailySlots.update(prev =>
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
    const target = this.dailySlots().find(slot => slot.id === id) ?? null;
    if (!target) return;
    this.dailySlots.update(prev =>
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
    if (this.isFragmentPhase() && this.fragmentDefenseLevel() >= 3) {
      this.fragmentDefenseLevel.set(4);
      this.schedulerPhase.set('paused');
    }
  }

  skipDailySlot(id: string): void {
    this.dailySlots.update(prev =>
      prev.map(slot =>
        slot.id === id
          ? { ...slot, todayCompletedCount: slot.maxDailyCount }
          : slot,
      ),
    );
  }

  removeDailySlot(id: string): void {
    const removed = this.dailySlots().find(slot => slot.id === id) ?? null;
    this.dailySlots.update(prev => prev.filter(slot => slot.id !== id));
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
    const today = this.todayDateKey();
    if (today === this.dailyResetDate()) return;
    this.dailyResetDate.set(today);
    this.dailySlots.update(prev => prev.map(slot => ({ ...slot, todayCompletedCount: 0 })));
  }
}
