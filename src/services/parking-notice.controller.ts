import { signal } from '@angular/core';

import type { ParkingNotice } from '../models';

interface ParkingNoticeControllerOptions {
  reminderBadgeThreshold: number;
}

export class ParkingNoticeController {
  private readonly deferredEvictionNotices: ParkingNotice[] = [];
  private readonly reminderFadeoutCounts = new Map<string, number>();

  readonly pendingNotices = signal<ParkingNotice[]>([]);
  readonly badgedTaskIds = signal<Set<string>>(new Set());

  constructor(private readonly options: ParkingNoticeControllerOptions) {}

  showNotice(notice: ParkingNotice, isGateActive: boolean): void {
    if (notice.type === 'eviction' && isGateActive) {
      this.deferredEvictionNotices.push(notice);
      return;
    }

    this.pendingNotices.update(list => [...list, notice]);
  }

  flushDeferredNotices(): void {
    if (this.deferredEvictionNotices.length === 0) return;

    const deferred = this.deferredEvictionNotices.splice(0);
    this.pendingNotices.update(list => [...list, ...deferred]);
  }

  consumeNotice(noticeId: string): void {
    this.pendingNotices.update(list => list.filter(notice => notice.id !== noticeId));
  }

  recordReminderFadeout(taskId: string): void {
    const count = (this.reminderFadeoutCounts.get(taskId) ?? 0) + 1;
    this.reminderFadeoutCounts.set(taskId, count);

    if (count >= this.options.reminderBadgeThreshold) {
      this.badgedTaskIds.update(ids => new Set(ids).add(taskId));
    }
  }

  clearBadge(taskId: string): void {
    this.reminderFadeoutCounts.delete(taskId);
    this.badgedTaskIds.update((ids) => {
      if (!ids.has(taskId)) return ids;
      const next = new Set(ids);
      next.delete(taskId);
      return next;
    });
  }
}
