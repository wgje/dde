/**
 * ParkingNoticeComponent — 停泊专用多按钮通知组件
 *
 * 策划案 A3.13 / A6.3 规范
 * - reminder: 三阶段（免疫 -> 可交互消散 -> 兜底淡出）
 * - eviction: 最短可见 + 有效交互消散（与 reminder 分离实现）
 */

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { GateService } from '../../../services/gate.service';
import { ParkingService } from '../../../services/parking.service';
import { SimpleReminderService } from '../../../services/simple-reminder.service';
import { UiStateService } from '../../../services/ui-state.service';
import {
  ParkingNotice,
  ParkingNoticeActionKey,
  ParkingNoticeEvictionItem,
} from '../../../models';

type DismissPhase = 'idle' | 'immune' | 'interactive';
type DismissReason = 'action' | 'interactive' | 'fallback';

@Component({
  selector: 'app-parking-notice',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [],
  styles: [`
    :host {
      display: block;
      position: fixed;
      bottom: 80px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 9999;
      pointer-events: none;
    }
    .notice-container {
      pointer-events: auto;
      max-width: 560px;
      min-width: 320px;
    }
    .notice-enter {
      animation: noticeSlideUp var(--pk-notice-enter) var(--pk-ease-enter);
    }
    .notice-exit {
      animation: noticeFadeOut var(--pk-notice-exit) var(--pk-ease-exit) forwards;
    }
    @keyframes noticeSlideUp {
      0%   { opacity: 0; transform: translateY(6px) scale(0.99); }
      50%  { opacity: 0.7; transform: translateY(1px) scale(0.998); }
      100% { opacity: 1; transform: translateY(0) scale(1); }
    }
    @keyframes noticeFadeOut {
      0%   { opacity: 1; transform: scale(1); }
      60%  { opacity: 0.5; transform: scale(0.996); }
      100% { opacity: 0; transform: scale(0.99); pointer-events: none; }
    }
    @media (prefers-reduced-motion: reduce) {
      .notice-enter { animation: none; }
      .notice-exit { animation-duration: 0ms; }
    }
  `],
  template: `
    @if (renderNotice(); as notice) {
      <div class="notice-container rounded-xl shadow-2xl border px-4 py-3 flex flex-col gap-2"
           data-testid="parking-notice"
           [class.notice-enter]="!isExiting()"
           [class.notice-exit]="isExiting()"
           [class.border-amber-300]="notice.type === 'eviction'"
           [class.border-indigo-300]="notice.type === 'reminder'"
           style="background-color: var(--theme-bg);"
           role="alert"
           aria-live="assertive">
        <div class="flex items-center gap-2">
          @if (notice.type === 'reminder') {
            <svg class="h-4 w-4 text-indigo-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                    d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"/>
            </svg>
          } @else {
            <svg class="h-4 w-4 text-amber-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                    d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/>
            </svg>
          }
          <span class="text-sm font-medium text-stone-800 dark:text-stone-200 truncate">
            {{ notice.taskTitle }}
          </span>
        </div>

        @if (notice.reason) {
          <div class="text-xs text-stone-500 dark:text-stone-400">
            {{ notice.reason }}
          </div>
        }

        @if (notice.type === 'eviction' && notice.evictionItems && notice.evictionItems.length > 1) {
          <div class="flex items-center justify-between">
            <button
              type="button"
              class="text-xs px-2 py-1 rounded bg-stone-100 dark:bg-stone-700 text-stone-600 dark:text-stone-300"
              (click)="toggleEvictionExpanded()"
              data-testid="parking-eviction-expand-btn">
              {{ evictionExpanded() ? '收起列表' : '展开逐条撤回' }}
            </button>
            <span class="text-[11px] text-stone-400">{{ visibleEvictionItems(notice).length }} 项可撤回</span>
          </div>
        }

        @if (notice.type === 'eviction' && notice.evictionItems && notice.evictionItems.length > 1 && evictionExpanded()) {
          <div class="max-h-40 overflow-y-auto rounded-lg border border-stone-200 dark:border-stone-700 divide-y divide-stone-100 dark:divide-stone-700"
               data-testid="parking-eviction-items">
            @for (item of visibleEvictionItems(notice); track item.evictionTokenId) {
              <div class="flex items-center justify-between px-2 py-1.5">
                <span class="text-xs text-stone-700 dark:text-stone-200 truncate pr-2">{{ item.taskTitle }}</span>
                <button
                  type="button"
                  class="text-[11px] px-2 py-1 rounded bg-amber-500 text-white hover:bg-amber-600"
                  (click)="undoEvictionItem(notice, item, $event)"
                  [disabled]="!isEvictionTokenActive(item.evictionTokenId)"
                  data-testid="parking-eviction-item-undo">
                  撤回
                </button>
              </div>
            }
          </div>
        }

        <div class="flex items-center gap-1.5 flex-wrap">
          @for (action of visibleActions(notice); track action.key) {
            <button
              (click)="handleAction(notice, action.key)"
              class="text-xs px-2.5 py-1.5 rounded-lg transition-colors font-medium"
              [class.bg-indigo-500]="action.key === 'start-work'"
              [class.text-white]="action.key === 'start-work'"
              [class.hover:bg-indigo-600]="action.key === 'start-work'"
              [class.bg-amber-500]="action.key === 'undo-eviction'"
              [class.text-white]="action.key === 'undo-eviction'"
              [class.hover:bg-amber-600]="action.key === 'undo-eviction'"
              [class.bg-stone-100]="action.key !== 'start-work' && action.key !== 'undo-eviction'"
              [class.dark:bg-stone-700]="action.key !== 'start-work' && action.key !== 'undo-eviction'"
              [class.text-stone-600]="action.key !== 'start-work' && action.key !== 'undo-eviction'"
              [class.dark:text-stone-300]="action.key !== 'start-work' && action.key !== 'undo-eviction'"
              [class.hover:bg-stone-200]="action.key !== 'start-work' && action.key !== 'undo-eviction'"
              [class.dark:hover:bg-stone-600]="action.key !== 'start-work' && action.key !== 'undo-eviction'"
              [class.opacity-50]="isSnoozeWeakened(action.key)"
              [attr.aria-label]="action.label"
              style="min-height: 44px; min-width: 44px;">
              {{ action.label }}
            </button>
          }
          @if (isMobile() && hasCollapsedActions(notice) && !mobileExpanded()) {
            <button
              (click)="mobileExpanded.set(true)"
              class="text-xs px-2 py-1.5 rounded-lg bg-stone-100 dark:bg-stone-700 text-stone-500 dark:text-stone-400"
              style="min-height: 44px;"
              aria-label="展开更多操作">
              更多…
            </button>
          }
        </div>

        @if (showSnoozeGuidance()) {
          <div class="text-xs text-amber-600 dark:text-amber-400 px-1">
            已延后多次，建议处理或忽略
          </div>
        }
      </div>
    }
  `,
})
export class ParkingNoticeComponent implements OnDestroy {
  private readonly elRef = inject(ElementRef);
  private readonly parkingService = inject(ParkingService);
  private readonly reminderService = inject(SimpleReminderService);
  private readonly uiState = inject(UiStateService);
  private readonly gateService = inject(GateService);

  readonly isMobile = computed(() => this.uiState.isMobile());
  readonly mobileExpanded = signal(false);
  readonly evictionExpanded = signal(false);
  readonly dismissedEvictionTokenIds = signal<Set<string>>(new Set());

  readonly currentNotice = computed<ParkingNotice | null>(() => {
    const reminder = this.reminderService.activeNotice();
    if (reminder) return reminder;

    const pending = this.parkingService.pendingNotices();
    const first = pending.length > 0 ? pending[0] : null;
    if (!first) return null;

    if (first.type === 'eviction' && this.gateService.isActive()) {
      return null;
    }

    return first;
  });

  readonly isExiting = signal(false);
  readonly dismissingNotice = signal<ParkingNotice | null>(null);
  readonly renderNotice = computed<ParkingNotice | null>(() => this.currentNotice() ?? this.dismissingNotice());
  readonly showSnoozeGuidance = computed(() => {
    const notice = this.currentNotice();
    if (!notice || notice.type !== 'reminder') return false;
    return notice.actions.some(a => a.key === 'ignore' && a.label.includes('已延后'));
  });

  private phase: DismissPhase = 'idle';
  private immuneTimer: ReturnType<typeof setTimeout> | null = null;
  private fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private dismissTimer: ReturnType<typeof setTimeout> | null = null;
  private noticeStartTime = 0;
  private lastNoticeId: string | null = null;

  private clickHandler: ((e: MouseEvent) => void) | null = null;
  private scrollStartY: number | null = null;

  private readonly noticeStateEffect = effect(() => {
    const notice = this.currentNotice();
    const noticeId = notice?.id ?? null;
    if (noticeId === this.lastNoticeId) return;

    this.lastNoticeId = noticeId;
    this.resetStateForNoticeChange(notice);
  });

  ngOnDestroy(): void {
    this.noticeStateEffect.destroy();
    this.clearAllTimers();
    this.removeExternalListeners();
  }

  isSnoozeWeakened(key: ParkingNoticeActionKey): boolean {
    if (!key.startsWith('snooze-')) return false;
    return this.showSnoozeGuidance();
  }

  visibleActions(notice: ParkingNotice): ParkingNotice['actions'] {
    if (!this.isMobile() || this.mobileExpanded()) {
      return notice.actions;
    }
    const primaryKeys: Set<ParkingNoticeActionKey> = new Set([
      'start-work', 'undo-eviction', 'snooze-5m', 'ignore', 'keep-parked',
    ]);
    return notice.actions.filter(a => primaryKeys.has(a.key));
  }

  hasCollapsedActions(notice: ParkingNotice): boolean {
    return notice.actions.length > this.visibleActions(notice).length;
  }

  handleAction(notice: ParkingNotice, key: ParkingNoticeActionKey): void {
    switch (key) {
      case 'start-work':
        this.parkingService.startWork(notice.taskId);
        break;
      case 'snooze-5m':
        this.reminderService.snooze5m(notice.taskId);
        break;
      case 'snooze-30m':
        this.reminderService.snooze30m(notice.taskId);
        break;
      case 'snooze-2h-later':
        this.reminderService.snooze2h(notice.taskId);
        break;
      case 'ignore':
        this.reminderService.cancelReminder(notice.taskId);
        break;
      case 'undo-eviction':
        if (notice.evictionTokenId) {
          this.parkingService.undoEviction(notice.evictionTokenId);
        }
        break;
      case 'keep-parked':
        if (notice.evictionItems && notice.evictionItems.length > 0) {
          for (const item of notice.evictionItems) {
            this.parkingService.keepParked(item.taskId);
          }
        } else {
          this.parkingService.keepParked(notice.taskId);
        }
        break;
    }

    this.dismissNotice('action');
  }

  toggleEvictionExpanded(): void {
    this.evictionExpanded.update(v => !v);
  }

  undoEvictionItem(notice: ParkingNotice, item: ParkingNoticeEvictionItem, event: Event): void {
    event.stopPropagation();
    if (!this.isEvictionTokenActive(item.evictionTokenId)) return;

    this.parkingService.undoEviction(item.evictionTokenId);
    this.dismissedEvictionTokenIds.update((set) => {
      return new Set([...set, item.evictionTokenId]);
    });

    if (this.visibleEvictionItems(notice).length === 0) {
      this.dismissNotice('action');
    }
  }

  isEvictionTokenActive(tokenId: string): boolean {
    return !!this.parkingService.getEvictionToken(tokenId);
  }

  visibleEvictionItems(notice: ParkingNotice): ParkingNoticeEvictionItem[] {
    const all = notice.evictionItems ?? [];
    const dismissed = this.dismissedEvictionTokenIds();
    return all.filter(item =>
      !dismissed.has(item.evictionTokenId) && this.isEvictionTokenActive(item.evictionTokenId)
    );
  }

  private resetStateForNoticeChange(notice: ParkingNotice | null): void {
    this.clearAllTimers();
    this.removeExternalListeners();
    this.isExiting.set(false);
    this.mobileExpanded.set(false);
    this.evictionExpanded.set(false);
    this.dismissedEvictionTokenIds.set(new Set());
    this.dismissingNotice.set(null);
    this.phase = 'idle';
    this.noticeStartTime = 0;

    if (!notice) {
      return;
    }

    this.noticeStartTime = Date.now();
    this.phase = 'immune';

    this.immuneTimer = setTimeout(() => {
      this.phase = 'interactive';
      this.addExternalListeners(notice);

      if (notice.type === 'reminder') {
        const remainingFallback = Math.max(0, notice.fallbackTimeoutMs - notice.minVisibleMs);
        this.fallbackTimer = setTimeout(() => {
          this.dismissNotice('fallback');
        }, remainingFallback);
      }
    }, notice.minVisibleMs);
  }

  private dismissNotice(reason: DismissReason): void {
    if (this.phase === 'idle' || this.isExiting()) return;
    const notice = this.currentNotice();
    if (!notice) return;
    this.dismissingNotice.set(notice);

    this.isExiting.set(true);
    this.clearAllTimers();
    this.removeExternalListeners();

    this.dismissTimer = setTimeout(() => {
      const dismissingNotice = this.dismissingNotice();
      if (dismissingNotice) {
        this.consumeNoticeByType(dismissingNotice, reason);
      }
      this.dismissingNotice.set(null);
      this.phase = 'idle';
      this.noticeStartTime = 0;
      this.isExiting.set(false);
      this.dismissTimer = null;
    }, 300);
  }

  private consumeNoticeByType(notice: ParkingNotice, reason: DismissReason): void {
    if (notice.type === 'reminder') {
      if (reason === 'fallback') {
        this.reminderService.handleNoticeFadeout(notice.taskId);
      } else {
        this.reminderService.clearActiveNotice();
      }
      return;
    }

    this.parkingService.consumeNotice(notice.id);
  }

  private addExternalListeners(notice: ParkingNotice): void {
    this.removeExternalListeners();

    this.clickHandler = (e: MouseEvent) => {
      if (this.phase !== 'interactive') return;
      if (!this.elRef.nativeElement.contains(e.target as Node)) {
        this.dismissNotice('interactive');
      }
    };
    document.addEventListener('click', this.clickHandler, { capture: true });

    if (notice.type === 'eviction') {
      document.addEventListener('input', this.handleEvictionInput, { capture: true });
      document.addEventListener('compositionstart', this.handleEvictionInput, { capture: true });
      document.addEventListener('scroll', this.handleEvictionScroll, { capture: true, passive: true });
    }
  }

  private handleEvictionInput = (): void => {
    if (this.phase === 'interactive') {
      this.dismissNotice('interactive');
    }
  };

  private handleEvictionScroll = (): void => {
    if (this.phase !== 'interactive') return;
    if (this.scrollStartY === null) {
      this.scrollStartY = window.scrollY;
      return;
    }
    if (Math.abs(window.scrollY - this.scrollStartY) >= 30) {
      this.dismissNotice('interactive');
    }
  };

  private removeExternalListeners(): void {
    if (this.clickHandler) {
      document.removeEventListener('click', this.clickHandler, { capture: true });
      this.clickHandler = null;
    }
    document.removeEventListener('input', this.handleEvictionInput, { capture: true });
    document.removeEventListener('compositionstart', this.handleEvictionInput, { capture: true });
    document.removeEventListener('scroll', this.handleEvictionScroll, { capture: true });
    this.scrollStartY = null;
  }

  private clearAllTimers(): void {
    if (this.immuneTimer) {
      clearTimeout(this.immuneTimer);
      this.immuneTimer = null;
    }
    if (this.fallbackTimer) {
      clearTimeout(this.fallbackTimer);
      this.fallbackTimer = null;
    }
    if (this.dismissTimer) {
      clearTimeout(this.dismissTimer);
      this.dismissTimer = null;
    }
  }
}
