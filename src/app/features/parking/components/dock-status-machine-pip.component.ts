import { ChangeDetectionStrategy, Component, computed, inject, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DockEngineService } from '../../../../services/dock-engine.service';
import { isStatusMachineEntryExpired, type StatusMachineEntry } from '../../../../models/parking-dock';

type PipAlertTone = 'danger' | 'warning' | 'info' | 'calm';
type PipAlertKind =
  | 'wait-finished'
  | 'fragment-countdown'
  | 'blank-period'
  | 'burnout'
  | 'rest-reminder'
  | 'focus'
  | 'stalled'
  | 'waiting';

interface PipAlert {
  actionLabel: string;
  badge: string;
  headline: string;
  id: string;
  kind: PipAlertKind;
  meta: string;
  taskId?: string;
  tone: PipAlertTone;
}

@Component({
  selector: 'app-dock-status-machine-pip',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="relative flex min-h-screen flex-col gap-3 p-3 text-slate-100" data-testid="dock-v3-status-machine-pip">
      <button
        type="button"
        class="absolute right-3 top-3 inline-flex h-8 w-8 items-center justify-center rounded-full border border-transparent bg-slate-800/60 text-slate-400 transition-colors hover:bg-slate-700/80 hover:text-slate-100"
        (click)="closeWindow()"
        aria-label="关闭悬浮窗"
        title="关闭悬浮窗"
        data-testid="dock-v3-pip-close">
        <svg viewBox="0 0 24 24" fill="none" class="h-4 w-4" aria-hidden="true">
          <path d="M7 7L17 17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></path>
          <path d="M17 7L7 17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></path>
        </svg>
      </button>

      <section class="rounded-3xl border border-white/5 bg-slate-900/40 backdrop-blur-md px-4 py-3 shadow-[0_20px_60px_rgba(2,6,23,0.42)]">
        <div class="flex items-start gap-3">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <span
                class="inline-flex min-h-[22px] items-center rounded-full border px-2.5 text-[10px] font-semibold tracking-[0.12em] uppercase"
                [ngClass]="badgeClasses(primaryAlert().tone)">
                {{ primaryAlert().badge }}
              </span>
              <span class="text-[10px] font-medium text-slate-400">{{ attentionSummary() }}</span>
            </div>
            <div class="mt-2 text-[15px] font-semibold leading-5 text-slate-50" data-testid="dock-v3-pip-primary-headline">
              {{ primaryAlert().headline }}
            </div>
            <div class="mt-1 text-[11px] leading-4 text-slate-400" data-testid="dock-v3-pip-primary-meta">
              {{ primaryAlert().meta }}
            </div>
          </div>

          <button
            type="button"
            class="inline-flex min-h-[38px] shrink-0 items-center justify-center rounded-2xl border px-3 text-[11px] font-semibold transition-colors"
            [ngClass]="actionClasses(primaryAlert().tone)"
            (click)="handlePrimaryAction()"
            [attr.data-testid]="'dock-v3-pip-primary-action-' + primaryAlert().kind">
            {{ primaryAlert().actionLabel }}
          </button>
        </div>
      </section>

      @if (showFocusCard()) {
        <section
          class="rounded-2xl border border-white/5 bg-slate-900/40 px-4 py-3"
          data-testid="dock-v3-pip-focus-card">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0 flex-1">
              <div class="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">当前主线</div>
              <div class="mt-1 truncate text-[14px] font-semibold text-slate-50">{{ currentFocusEntry()?.title }}</div>
              <div class="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-slate-400">
                <span class="rounded-full border border-indigo-400/20 bg-indigo-500/10 px-2 py-1 text-indigo-100">专注中</span>
                <span class="rounded-full border border-slate-700/80 bg-slate-900/80 px-2 py-1">
                  {{ currentFocusMeta() }}
                </span>
              </div>
            </div>
            <button
              type="button"
              class="inline-flex min-h-[34px] shrink-0 items-center justify-center rounded-xl border border-slate-700/80 bg-slate-900/80 px-3 text-[11px] font-medium text-slate-200 transition-colors hover:bg-slate-800"
              (click)="returnToMain()"
              data-testid="dock-v3-pip-focus-return">
              回主窗口
            </button>
          </div>
        </section>
      }

      @if (secondaryAlerts().length > 0) {
        <section
          class="rounded-2xl border border-white/5 bg-slate-900/40 px-3 py-2.5"
          data-testid="dock-v3-pip-secondary-list">
          <div class="mb-2 flex items-center justify-between gap-2">
            <div class="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">待处理</div>
            @if (hiddenAlertCount() > 0) {
              <div class="text-[10px] text-slate-500">+{{ hiddenAlertCount() }} 项折叠</div>
            }
          </div>

          <div class="flex flex-col gap-2">
            @for (alert of secondaryAlerts(); track alert.id) {
              <button
                type="button"
                class="flex items-start gap-3 rounded-2xl bg-slate-800/50 border-transparent px-3 py-2 text-left transition-colors hover:border-slate-700 hover:bg-slate-900"
                (click)="handleAlertAction(alert)"
                [attr.data-testid]="'dock-v3-pip-secondary-' + alert.kind">
                <span
                  class="mt-0.5 inline-flex min-h-[20px] shrink-0 items-center rounded-full border px-2 text-[9px] font-semibold uppercase tracking-[0.12em]"
                  [ngClass]="badgeClasses(alert.tone)">
                  {{ alert.badge }}
                </span>
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-[12px] font-medium text-slate-100">{{ alert.headline }}</span>
                  <span class="mt-1 block text-[10px] leading-4 text-slate-400">{{ alert.meta }}</span>
                </span>
              </button>
            }
          </div>
        </section>
      }

      <div class="mt-auto flex items-center justify-between gap-2 rounded-2xl border border-white/5 bg-slate-900/40 px-3 py-2">
        <div class="text-[10px] text-slate-500">
          {{ muted() ? '提醒已静音' : '提醒开启中' }}
        </div>

        <div class="flex items-center gap-2">
          <button
            type="button"
            class="inline-flex h-9 w-9 items-center justify-center rounded-full border border-slate-700/70 bg-slate-900/80 text-slate-300 transition-colors hover:bg-slate-800 hover:text-slate-100"
            (click)="returnToMain()"
            aria-label="返回主窗口"
            title="返回主窗口"
            data-testid="dock-v3-pip-return">
            <svg viewBox="0 0 24 24" fill="none" class="h-4 w-4" aria-hidden="true">
              <path d="M10 7L5 12L10 17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path>
              <path d="M19 12H5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></path>
            </svg>
          </button>

          <button
            type="button"
            class="inline-flex h-9 w-9 items-center justify-center rounded-full border transition-colors"
            [ngClass]="muted()
              ? 'border-amber-400/30 bg-amber-500/12 text-amber-100 hover:bg-amber-500/20'
              : 'border-slate-700/70 bg-slate-900/80 text-slate-300 hover:bg-slate-800 hover:text-slate-100'"
            (click)="toggleMute()"
            [attr.aria-label]="muteButtonLabel()"
            [attr.title]="muteButtonLabel()"
            [attr.aria-pressed]="muted()"
            data-testid="dock-v3-pip-mute">
            <svg viewBox="0 0 24 24" fill="none" class="h-4 w-4" aria-hidden="true">
              <path d="M5.5 10.25H8.75L13 6.75V17.25L8.75 13.75H5.5V10.25Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"></path>
              @if (muted()) {
                <path d="M15.25 8.75L19.25 12.75" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></path>
                <path d="M19.25 8.75L15.25 12.75" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></path>
              } @else {
                <path d="M16.25 9.25C17.15 9.95 17.75 11 17.75 12C17.75 13 17.15 14.05 16.25 14.75" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></path>
                <path d="M18.5 7.25C20.1 8.55 21 10.2 21 12C21 13.8 20.1 15.45 18.5 16.75" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></path>
              }
            </svg>
          </button>

          <button
            type="button"
            class="inline-flex h-9 w-9 items-center justify-center rounded-full border border-rose-500/30 bg-rose-500/12 text-rose-100 transition-colors hover:bg-rose-500/20"
            (click)="exitFocusMode()"
            aria-label="退出专注"
            title="退出专注"
            data-testid="dock-v3-pip-exit-focus">
            <svg viewBox="0 0 24 24" fill="none" class="h-4 w-4" aria-hidden="true">
              <path d="M9.75 6.75H8.5C7.39543 6.75 6.5 7.64543 6.5 8.75V15.25C6.5 16.3546 7.39543 17.25 8.5 17.25H9.75" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></path>
              <path d="M13.5 8.75L17.5 12L13.5 15.25" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path>
              <path d="M17 12H10.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></path>
            </svg>
          </button>
        </div>
      </div>
    </div>
  `,
})
export class DockStatusMachinePipComponent {
  private readonly engine = inject(DockEngineService);

  readonly returnRequested = output<void>();
  readonly closeRequested = output<void>();

  readonly allEntries = computed(() => this.engine.statusMachineEntries());
  readonly currentFocusEntry = computed(() => this.engine.focusingEntry());
  readonly muted = computed(() => this.engine.muteWaitTone());
  readonly blankPeriodActive = computed(
    () =>
      this.engine.fragmentEntryCountdown() === null
      && this.engine.pendingDecision() !== null
      && this.engine.pendingDecisionEntries().length === 0,
  );
  readonly expiredEntries = computed(() =>
    this.allEntries().filter(entry => isStatusMachineEntryExpired(entry)),
  );
  readonly waitingEntries = computed(() =>
    this.allEntries().filter(
      entry => entry.uiStatus === 'suspended_waiting' && !isStatusMachineEntryExpired(entry),
    ),
  );
  readonly stalledEntries = computed(() =>
    this.allEntries().filter(entry => entry.uiStatus === 'stalled'),
  );
  readonly primaryAlert = computed<PipAlert>(() => {
    const expired = this.expiredEntries()[0];
    if (expired) {
      return {
        id: `expired-${expired.taskId}`,
        kind: 'wait-finished',
        tone: 'danger',
        badge: '等待结束',
        headline: `${expired.title} 已到时`,
        meta: '优先切回处理，避免主线遗忘。',
        actionLabel: '切回任务',
        taskId: expired.taskId,
      };
    }

    const fragmentCountdown = this.engine.fragmentEntryCountdown();
    if (fragmentCountdown !== null) {
      return {
        id: 'fragment-countdown',
        kind: 'fragment-countdown',
        tone: 'warning',
        badge: '碎片倒计时',
        headline: `${fragmentCountdown}s 后进入碎片时间`,
        meta: '当前检测到短暂空档，建议回到主窗口确认。',
        actionLabel: '回主窗口',
      };
    }

    if (this.blankPeriodActive()) {
      return {
        id: 'blank-period',
        kind: 'blank-period',
        tone: 'warning',
        badge: '留白期',
        headline: '当前窗口过短，不建议插入新任务',
        meta: this.engine.pendingDecision()?.reason ?? '先保持空档，避免切碎主线节奏。',
        actionLabel: '回主窗口',
      };
    }

    if (this.engine.isBurnoutActive()) {
      return {
        id: 'burnout',
        kind: 'burnout',
        tone: 'danger',
        badge: '倦怠',
        headline: '负荷已过高，建议先收束主线',
        meta: '优先处理当前专注任务，不再扩散注意力。',
        actionLabel: '回主窗口',
      };
    }

    if (this.engine.restReminderActive()) {
      return {
        id: 'rest-reminder',
        kind: 'rest-reminder',
        tone: 'calm',
        badge: '休息提醒',
        headline: this.restReminderHeadline(),
        meta: '确认后会关闭本轮提醒。',
        actionLabel: '已知悉',
      };
    }

    const focusEntry = this.currentFocusEntry();
    if (focusEntry) {
      return {
        id: `focus-${focusEntry.taskId}`,
        kind: 'focus',
        tone: 'info',
        badge: '当前主线',
        headline: focusEntry.title,
        meta: this.currentFocusMeta(),
        actionLabel: '回主窗口',
      };
    }

    const waiting = this.waitingEntries()[0];
    if (waiting) {
      return {
        id: `waiting-${waiting.taskId}`,
        kind: 'waiting',
        tone: 'calm',
        badge: '等待中',
        headline: waiting.title,
        meta: this.secondaryAlertMeta(waiting),
        actionLabel: '切回任务',
        taskId: waiting.taskId,
      };
    }

    return {
      id: 'idle',
      kind: 'focus',
      tone: 'calm',
      badge: '空闲',
      headline: '当前没有需要立即处理的状态',
      meta: '可保留悬浮窗观察下一次状态变化。',
      actionLabel: '回主窗口',
    };
  });
  readonly secondaryAlerts = computed<PipAlert[]>(() => {
    const primary = this.primaryAlert();
    const alerts: PipAlert[] = [];

    for (const entry of this.expiredEntries()) {
      if (entry.taskId === primary.taskId) continue;
      alerts.push({
        id: `expired-${entry.taskId}`,
        kind: 'wait-finished',
        tone: 'danger',
        badge: '等待结束',
        headline: entry.title,
        meta: '点击切回并继续处理。',
        actionLabel: '切回任务',
        taskId: entry.taskId,
      });
    }

    for (const entry of this.stalledEntries()) {
      if (entry.taskId === primary.taskId) continue;
      alerts.push({
        id: `stalled-${entry.taskId}`,
        kind: 'stalled',
        tone: 'warning',
        badge: '停滞',
        headline: entry.title,
        meta: '上下文已中断，点击恢复。',
        actionLabel: '恢复',
        taskId: entry.taskId,
      });
    }

    for (const entry of this.waitingEntries()) {
      if (entry.taskId === primary.taskId) continue;
      alerts.push({
        id: `waiting-${entry.taskId}`,
        kind: 'waiting',
        tone: 'calm',
        badge: '等待中',
        headline: entry.title,
        meta: this.secondaryAlertMeta(entry),
        actionLabel: '切回任务',
        taskId: entry.taskId,
      });
    }

    return alerts.slice(0, 2);
  });
  readonly hiddenAlertCount = computed(() => {
    const total =
      Math.max(0, this.expiredEntries().length - (this.primaryAlert().kind === 'wait-finished' ? 1 : 0))
      + Math.max(0, this.stalledEntries().length - (this.primaryAlert().kind === 'stalled' ? 1 : 0))
      + Math.max(0, this.waitingEntries().length - (this.primaryAlert().kind === 'waiting' ? 1 : 0));
    return Math.max(0, total - this.secondaryAlerts().length);
  });
  readonly attentionSummary = computed(() => {
    const expired = this.expiredEntries().length;
    const waiting = this.waitingEntries().length;
    const stalled = this.stalledEntries().length;
    return `到时 ${expired} · 等待 ${waiting} · 停滞 ${stalled}`;
  });
  readonly muteButtonLabel = computed(() =>
    this.muted() ? '关闭静音提醒' : '开启状态提醒声音',
  );
  readonly showFocusCard = computed(
    () => this.currentFocusEntry() !== null && this.primaryAlert().kind !== 'focus',
  );

  handlePrimaryAction(): void {
    this.handleAlertAction(this.primaryAlert());
  }

  handleAlertAction(alert: PipAlert): void {
    switch (alert.kind) {
      case 'wait-finished':
      case 'waiting':
      case 'stalled':
        if (alert.taskId) {
          this.engine.switchToTask(alert.taskId);
        }
        this.returnToMain();
        return;
      case 'rest-reminder':
        this.engine.fragmentRest.dismissRestReminder();
        return;
      default:
        this.returnToMain();
    }
  }

  returnToMain(): void {
    this.returnRequested.emit();
  }

  closeWindow(): void {
    this.closeRequested.emit();
  }

  exitFocusMode(): void {
    if (this.engine.focusMode()) {
      this.engine.toggleFocusMode();
    }
    this.closeRequested.emit();
  }

  toggleMute(): void {
    this.engine.toggleMuteWaitTone();
  }

  badgeClasses(tone: PipAlertTone): string {
    switch (tone) {
      case 'danger':
        return 'border-rose-400/25 bg-rose-500/12 text-rose-100';
      case 'warning':
        return 'border-amber-400/25 bg-amber-500/12 text-amber-100';
      case 'info':
        return 'border-indigo-400/25 bg-indigo-500/12 text-indigo-100';
      default:
        return 'border-emerald-400/20 bg-emerald-500/10 text-emerald-100';
    }
  }

  actionClasses(tone: PipAlertTone): string {
    switch (tone) {
      case 'danger':
        return 'border-rose-500/30 bg-rose-500/14 text-rose-50 hover:bg-rose-500/22';
      case 'warning':
        return 'border-amber-500/30 bg-amber-500/14 text-amber-50 hover:bg-amber-500/22';
      case 'info':
        return 'border-indigo-500/30 bg-indigo-500/14 text-indigo-50 hover:bg-indigo-500/22';
      default:
        return 'border-slate-700/80 bg-slate-900/85 text-slate-100 hover:bg-slate-800';
    }
  }

  currentFocusMeta(): string {
    const entry = this.currentFocusEntry();
    if (!entry) return '主线进行中';
    const segments: string[] = [];
    if (entry.expectedMinutes !== null) {
      segments.push(`预计 ${this.formatMinutes(entry.expectedMinutes)}`);
    }
    if (entry.waitMinutes !== null) {
      segments.push(`等待 ${this.formatMinutes(entry.waitMinutes)}`);
    }
    if (entry.isMain) {
      segments.push('主任务');
    }
    return segments.length > 0 ? segments.join(' · ') : '主线进行中';
  }

  private secondaryAlertMeta(entry: StatusMachineEntry): string {
    if (isStatusMachineEntryExpired(entry)) {
      return '等待已结束，点击切回处理。';
    }
    if (entry.waitRemainingSeconds !== null) {
      return `剩余 ${this.formatDuration(entry.waitRemainingSeconds)}。`;
    }
    return '等待中。';
  }

  private restReminderHeadline(): string {
    const highMs = this.engine.cumulativeHighLoadMs();
    const lowMs = this.engine.cumulativeLowLoadMs();
    const totalMin = Math.round(Math.max(highMs, lowMs) / 60_000);
    return `已连续专注 ${totalMin} 分钟，建议短暂休息`;
  }

  private formatMinutes(minutes: number): string {
    if (!Number.isFinite(minutes)) return '0 分钟';
    return `${Math.max(0, Math.round(minutes))} 分钟`;
  }

  private formatDuration(totalSeconds: number): string {
    const safeSeconds = Math.max(0, Math.floor(totalSeconds));
    const minutes = Math.floor(safeSeconds / 60);
    const seconds = safeSeconds % 60;
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }
}
