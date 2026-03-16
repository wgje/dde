import { ChangeDetectionStrategy, Component, HostListener, computed, inject, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DockEngineService } from '../../../../services/dock-engine.service';
import { isStatusMachineEntryExpired, type StatusMachineEntry } from '../../../../models/parking-dock';

type PipAlertTone = 'danger' | 'warning' | 'info' | 'calm';
type PipLayoutMode = 'regular' | 'compact' | 'micro';
type PipAlertKind =
  | 'wait-finished'
  | 'fragment-countdown'
  | 'blank-period'
  | 'burnout'
  | 'rest-reminder'
  | 'focus'
  | 'stalled'
  | 'waiting';

interface PipAlertAction {
  label: string;
}

interface PipAlert {
  action: PipAlertAction;
  badge: string;
  headline: string;
  id: string;
  kind: PipAlertKind;
  meta: string;
  taskId?: string;
  tone: PipAlertTone;
}

interface PipSummaryToken {
  id: string;
  label: string;
  tone: PipAlertTone;
  value?: string;
}

interface PipTaskRow {
  alert: PipAlert | null;
  badge: string;
  headline: string;
  id: string;
  meta: string;
  tone: PipAlertTone;
  type: 'focus-context' | 'alert';
}

@Component({
  selector: 'app-dock-status-machine-pip',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './dock-status-machine-pip.component.html',
})
export class DockStatusMachinePipComponent {
  private readonly engine = inject(DockEngineService);

  readonly returnRequested = output<void>();
  readonly closeRequested = output<void>();
  private readonly viewportSize = signal(this.readViewportSize());

  readonly allEntries = computed(() => this.engine.statusMachineEntries());
  readonly currentFocusEntry = computed(() => this.engine.focusingEntry());
  readonly muted = computed(() => this.engine.muteWaitTone());
  readonly layoutMode = computed<PipLayoutMode>(() => {
    const viewport = this.viewportSize();
    if (viewport.width <= 288 || viewport.height <= 320) {
      return 'micro';
    }
    if (viewport.width <= 320 || viewport.height <= 360) {
      return 'compact';
    }
    return 'regular';
  });
  readonly toolbarMode = computed<'full' | 'buttons-only'>(() =>
    this.layoutMode() === 'micro' ? 'buttons-only' : 'full',
  );
  readonly primaryCardLayout = computed<'inline' | 'stack'>(() =>
    this.layoutMode() === 'micro' ? 'stack' : 'inline',
  );
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
  readonly summaryTokens = computed<PipSummaryToken[]>(() => {
    const tokens: PipSummaryToken[] = [];

    if (this.expiredEntries().length > 0) {
      tokens.push({ id: 'expired', label: '到时', tone: 'danger', value: `${this.expiredEntries().length}` });
    }
    if (this.stalledEntries().length > 0) {
      tokens.push({ id: 'stalled', label: '停滞', tone: 'warning', value: `${this.stalledEntries().length}` });
    }
    if (this.waitingEntries().length > 0) {
      tokens.push({ id: 'waiting', label: '等待', tone: 'warning', value: `${this.waitingEntries().length}` });
    }
    if (this.currentFocusEntry()) {
      tokens.push({ id: 'focus', label: '主线', tone: 'info', value: '进行中' });
    }

    if (tokens.length === 0) {
      tokens.push({ id: 'stable', label: '稳定', tone: 'calm' });
    }

    return tokens;
  });
  readonly visibleSummaryTokens = computed<PipSummaryToken[]>(() => {
    const tokens = this.summaryTokens();
    if (this.layoutMode() !== 'micro' || tokens.length <= 2) {
      return tokens;
    }

    return [
      ...tokens.slice(0, 2),
      {
        id: 'overflow',
        label: `+${tokens.length - 2}`,
        tone: 'calm',
      },
    ];
  });
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
        action: { label: '切回任务' },
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
        action: { label: '回主窗口' },
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
        action: { label: '回主窗口' },
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
        action: { label: '回主窗口' },
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
        action: { label: '已知悉' },
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
        action: { label: '回主窗口' },
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
        action: { label: '切回任务' },
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
      action: { label: '回主窗口' },
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
        action: { label: '切回任务' },
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
        action: { label: '恢复' },
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
        action: { label: '切回任务' },
        taskId: entry.taskId,
      });
    }

    return alerts;
  });
  readonly taskRows = computed<PipTaskRow[]>(() => {
    const rows: PipTaskRow[] = [];
    const focusEntry = this.currentFocusEntry();

    if (focusEntry && this.primaryAlert().kind !== 'focus') {
      rows.push({
        id: `focus-context-${focusEntry.taskId}`,
        type: 'focus-context',
        alert: null,
        badge: '当前主线',
        headline: focusEntry.title,
        meta: this.currentFocusMeta(),
        tone: 'info',
      });
    }

    for (const alert of this.secondaryAlerts()) {
      rows.push({
        id: alert.id,
        type: 'alert',
        alert,
        badge: alert.badge,
        headline: alert.headline,
        meta: alert.meta,
        tone: alert.tone,
      });
    }

    return rows;
  });
  readonly muteButtonLabel = computed(() =>
    this.muted() ? '关闭静音提醒' : '开启状态提醒声音',
  );

  @HostListener('window:resize')
  onViewportResize(): void {
    this.viewportSize.set(this.readViewportSize());
  }

  handlePrimaryAction(): void {
    this.handleAlertAction(this.primaryAlert());
  }

  handleTaskRowAction(row: PipTaskRow): void {
    if (!row.alert) return;
    this.handleAlertAction(row.alert);
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
        return 'text-rose-400';
      case 'warning':
        return 'text-amber-400';
      case 'info':
        return 'text-indigo-400';
      default:
        return 'text-emerald-400';
    }
  }

  actionClasses(tone: PipAlertTone): string {
    switch (tone) {
      case 'danger':
        return 'bg-rose-500/10 text-rose-300 hover:bg-rose-500/20';
      case 'warning':
        return 'bg-amber-500/10 text-amber-300 hover:bg-amber-500/20';
      case 'info':
        return 'bg-indigo-500/10 text-indigo-300 hover:bg-indigo-500/20';
      default:
        return 'bg-slate-800/50 text-slate-300 hover:bg-slate-700/50';
    }
  }

  chipClasses(tone: PipAlertTone): string {
    switch (tone) {
      case 'danger':
        return 'border-rose-500/15 bg-rose-500/10 text-rose-300';
      case 'warning':
        return 'border-amber-500/15 bg-amber-500/10 text-amber-300';
      case 'info':
        return 'border-indigo-500/15 bg-indigo-500/10 text-indigo-300';
      default:
        return 'border-slate-700/70 bg-slate-900/40 text-slate-300';
    }
  }

  summaryTokenClasses(tone: PipAlertTone): string {
    switch (tone) {
      case 'danger':
        return 'text-rose-300';
      case 'warning':
        return 'text-amber-300';
      case 'info':
        return 'text-indigo-300';
      default:
        return 'text-slate-300';
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

  private readViewportSize(): { width: number; height: number } {
    if (typeof window === 'undefined') {
      return { width: 360, height: 420 };
    }

    return {
      width: window.innerWidth > 0 ? window.innerWidth : 360,
      height: window.innerHeight > 0 ? window.innerHeight : 420,
    };
  }
}
