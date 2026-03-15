import {
  ChangeDetectionStrategy,
  Component,
  Input,
  OnDestroy,
  computed,
  effect,
  inject,
  output,
  signal,
  untracked,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { DockEngineService } from '../../../../services/dock-engine.service';
import { PerformanceTierService } from '../../../../services/performance-tier.service';
import { PARKING_CONFIG } from '../../../../config/parking.config';
import { isStatusMachineEntryExpired, StatusMachineEntry } from '../../../../models/parking-dock';

@Component({
  selector: 'app-dock-status-machine',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule],
  styles: [`
    :host {
      display: block;
    }

    .hud-action-btn {
      width: 32px;
      height: 32px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 8px;
      border: none;
      background: transparent;
      color: rgba(148, 163, 184, 0.6);
      transition: all 0.2s ease;
      cursor: pointer;
      flex-shrink: 0;
    }

    .hud-action-btn:hover {
      background: rgba(255, 255, 255, 0.06);
      color: rgba(226, 232, 240, 0.9);
    }

    .hud-action-btn:focus-visible {
      outline: 2px solid rgba(99, 102, 241, 0.42);
      outline-offset: 2px;
    }

    .glass-card {
      background: rgba(15, 23, 42, 0.65);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid rgba(255, 255, 255, 0.06);
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.2);
    }

    .status-machine-card {
      gap: 12px;
      padding: 14px 16px;
    }

    .status-topline {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 10px;
    }

    .status-title {
      font-size: 11px;
      font-weight: 500;
      letter-spacing: 0.1em;
      color: rgba(226, 232, 240, 0.82);
    }

    .status-summary-inline {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 10px;
      font-size: 11px;
      margin-top: 4px;
    }

    .status-summary-item {
      display: flex;
      align-items: center;
      gap: 4px;
      color: rgba(148, 163, 184, 0.7);
    }

    .summary-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
    }
    .status-summary-item[data-tone='focus'] { color: rgba(165, 180, 252, 0.9); }
    .status-summary-item[data-tone='wait'] { color: rgba(253, 186, 116, 0.9); }
    .status-summary-item[data-tone='stalled'] { color: rgba(203, 213, 225, 0.8); }
    .status-summary-item[data-tone='idle'] { color: rgba(148, 163, 184, 0.7); }

    .summary-dot[data-tone='focus'] { background: #6366f1; }
    .summary-dot[data-tone='wait'] { background: #f59e0b; }
    .summary-dot[data-tone='stalled'] { background: #64748b; }
    .summary-dot[data-tone='idle'] { background: #475569; }

    .status-badges {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 6px;
    }

    .status-badge {
      display: inline-flex;
      align-items: center;
      min-height: 20px;
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.04);
      padding: 0 6px;
      font-size: 10px;
      font-weight: 500;
      color: rgba(226, 232, 240, 0.78);
    }

    .status-badge[data-tone='blank'] {
      color: rgba(252, 211, 77, 0.9);
      background: rgba(245, 158, 11, 0.1);
    }

    .status-badge[data-tone='burnout'] {
      color: rgba(251, 146, 60, 0.9);
      background: rgba(249, 115, 22, 0.1);
    }

    .status-badge[data-tone='rest'] {
      color: rgba(110, 231, 183, 0.9);
      background: rgba(16, 185, 129, 0.1);
    }

    .status-badge-action {
      cursor: pointer;
      transition: background 0.15s ease;
    }

    .status-badge-action:hover {
      background: rgba(255, 255, 255, 0.1);
    }

    .status-icon-btn-muted {
      color: rgba(252, 211, 77, 0.86);
      background: rgba(245, 158, 11, 0.1);
    }

    .status-icon-btn svg {
      width: 16px;
      height: 16px;
    }

    .status-icon-btn-active {
      color: rgba(224, 231, 255, 0.94);
      background: rgba(99, 102, 241, 0.15);
    }

    .status-minimal-action {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 22px;
      border-radius: 9999px;
      border: 1px solid rgba(148, 163, 184, 0.14);
      background: rgba(15, 23, 42, 0.18);
      padding: 0 8px;
      font-size: 9px;
      line-height: 1;
      color: rgba(226, 232, 240, 0.82);
      transition:
        border-color 0.15s ease,
        background 0.15s ease,
        color 0.15s ease;
    }

    .status-minimal-action:hover {
      border-color: rgba(148, 163, 184, 0.2);
      background: rgba(30, 41, 59, 0.28);
      color: rgba(241, 245, 249, 0.96);
    }

    .status-minimal-action[data-active='true'] {
      border-color: rgba(99, 102, 241, 0.18);
      background: rgba(79, 70, 229, 0.12);
      color: rgba(224, 231, 255, 0.92);
    }

    .status-list {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .status-row {
      border-radius: 8px;
      border: 1px solid transparent;
      background: transparent;
      padding: 8px 10px;
      transition: all 0.15s ease;
    }

    .status-row.clickable:hover {
      background: rgba(255, 255, 255, 0.04);
      cursor: pointer;
    }

    .status-row-content {
      min-width: 0;
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }

    .status-row-copy {
      min-width: 0;
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 3px;
    }

    .status-row-title {
      font-size: 13px;
      line-height: 1.3;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      color: rgba(226, 232, 240, 0.9);
    }

    .status-row-meta {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
      min-width: 0;
      font-size: 10px;
    }

    .status-pill {
      font-weight: 500;
      color: rgba(148, 163, 184, 0.8);
    }

    .status-pill[data-tone='focus'] {
      color: rgba(165, 180, 252, 0.9);
    }

    .status-pill[data-tone='wait'] {
      color: rgba(253, 186, 116, 0.9);
    }

    .status-pill[data-tone='expired'] {
      color: rgba(253, 224, 71, 1);
      font-weight: 600;
    }

    .status-pill[data-tone='stalled'] {
      color: rgba(203, 213, 225, 0.7);
    }

    .status-pill[data-tone='idle'] {
      color: rgba(100, 116, 139, 0.7);
    }

    .status-pill[data-tone='switch'] {
      color: rgba(191, 219, 254, 0.8);
    }

    .status-note {
      color: rgba(100, 116, 139, 0.8);
      font-variant-numeric: tabular-nums;
    }

    .status-empty {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
      padding: 16px 0 10px;
      color: rgba(148, 163, 184, 0.5);
      text-align: center;
      font-size: 12px;
    }

    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }

    .ring-track {
      fill: none;
      stroke: rgba(255, 255, 255, 0.08);
      stroke-width: 2;
    }

    .ring-progress,
    .ring-progress-expired {
      fill: none;
      stroke-width: 2;
      stroke-linecap: round;
    }

    .ring-progress {
      transition: stroke-dashoffset 10s linear;
    }

    .focus-dot-pulse {
      animation: statusDotPulse var(--pk-micro-pulse) var(--pk-ease-standard) infinite alternate;
      box-shadow: 0 0 0 0 rgba(79, 70, 229, 0.35);
    }

    .expired-border-glow {
      box-shadow: 0 0 0 1px rgba(99, 102, 241, 0.3) inset, 0 10px 40px rgba(0, 0, 0, 0.3);
    }

    .expired-border-glow-degraded {
      box-shadow: 0 0 0 1px rgba(99, 102, 241, 0.1) inset, 0 10px 30px rgba(0, 0, 0, 0.2);
    }

    @keyframes statusDotPulse {
      0% { box-shadow: 0 0 0 0 rgba(99, 102, 241, 0.4); opacity: 0.8; }
      100% { box-shadow: 0 0 0 6px rgba(99, 102, 241, 0); opacity: 1; }
    }

    .ring-expired-glow {
      filter: drop-shadow(0 0 4px rgba(251, 191, 36, 0.4));
    }

    .rest-reminder-glow {
      box-shadow: 0 0 0 1px rgba(16, 185, 129, 0.2) inset, 0 10px 30px rgba(0, 0, 0, 0.2);
    }

    @media (prefers-reduced-motion: reduce) {
      .focus-dot-pulse {
        animation: none;
      }
    }
  `],

    @if (hudMode() === 'full') {
  <div
        class="glass-card status-machine-card px-3.5 py-3 rounded-[22px] flex flex-col min-w-[236px] max-w-[316px]"
  [class.expired - border - glow] = "hasExpiredTask() && enableStatusExtraGlow() && !isGlowDegraded()"
  [class.expired - border - glow - degraded] = "hasExpiredTask() && enableStatusExtraGlow() && isGlowDegraded()"
  [class.rest - reminder - glow] = "restReminderActive() && enableRestReminderGlow()"
  [attr.data - performance - tier] = "performanceTier()"
  data - testid="dock-v3-status-machine" >

    <div class="status-topline" >
      <div class="flex min-w-0 flex-1 flex-col justify-center" >
        <div class="flex items-center gap-2" >
          <div class="status-title font-mono font-medium" > 状态机 < span class="opacity-50 font-normal" >· { { allEntries().length } } 项 < /span></div >
            </div>

  @if (allEntries().length > 0) {
    <div class="status-summary-inline" aria - label="状态机概览" >
      @if (focusingEntries().length > 0) {
        <div class="status-summary-item" data - tone="focus" >
          <div class="summary-dot" data - tone="focus" > </div>
            < span > 专注 { { focusingEntries().length } } </span>
              </div>
      }
    @if (suspendedEntries().length > 0) {
      <div class="status-summary-item" data - tone="wait" >
        <div class="summary-dot" data - tone="wait" > </div>
          < span > 等待 { { suspendedEntries().length } } </span>
            </div>
    }
    @if (stalledEntries().length > 0) {
      <div class="status-summary-item" data - tone="stalled" >
        <div class="summary-dot" data - tone="stalled" > </div>
          < span > 停滞 { { stalledEntries().length } } </span>
            </div>
    }
    @if (idleEntries().length > 0) {
      <div class="status-summary-item" data - tone="idle" >
        <div class="summary-dot" data - tone="idle" > </div>
          < span > 待启 { { idleEntries().length } } </span>
            </div>
    }
    </div>
  }

  @if (blankPeriodActive() || isBurnoutActive() || restReminderActive()) {
    <div class="status-badges" >
      @if (blankPeriodActive()) {
        <div class="status-badge" data - tone="blank" > 留白期 </div>
      }
    @if (isBurnoutActive()) {
      <div class="status-badge" data - tone="burnout" > 倦怠 </div>
    }
    @if (restReminderActive()) {
      <button
                    type="button"
      class="status-badge status-badge-action"
      data - tone="rest"
        (click) = "dismissRestReminder()"
      data - testid="dock-v3-rest-reminder-badge" >
        {{ restReminderLabel() }
    }
    <span aria - hidden="true" >✕</span>
      </button>
  }
  </div>
}
</div>

  < div class="flex items-center gap-2" >
    @if (showPipToggleState()) {
      <button
                type="button"
      class="hud-action-btn status-icon-btn"
      [class.status - icon - btn - active] = "pipToggleActiveState()"
        (click) = "requestPipToggle()"
        [attr.aria - label] = "pipToggleLabel()"
        [attr.aria - pressed] = "pipToggleActiveState()"
        [attr.title] = "pipToggleLabel()"

      data - testid="dock-v3-status-pip-toggle" >
        <svg viewBox="0 0 24 24" fill = "none" aria - hidden="true" >
          <rect x="4.75" y = "6.75" width = "14.5" height = "10.5" rx = "2.5" stroke = "currentColor" stroke - width="1.6" > </rect>
            < path d = "M19.25 10L21 8.75V15.25L19.25 14" stroke = "currentColor" stroke - width="1.6" stroke - linecap="round" stroke - linejoin="round" > </path>
              </svg>
              < span class="sr-only" > {{ pipToggleLabel() }
    } </span>
      </button>
            }

<button
              type="button"
class="hud-action-btn status-icon-btn"
[class.status - icon - btn - muted] = "muted()"
  (click) = "toggleMute()"
  [attr.aria - label] = "muteButtonLabel()"
  [attr.aria - pressed] = "muted()"
  [attr.title] = "muteButtonLabel()"

data - testid="dock-v3-status-mute" >
  <svg viewBox="0 0 24 24" fill = "none" aria - hidden="true" >
    <path
                  d="M5.5 10.25H8.75L13 6.75V17.25L8.75 13.75H5.5V10.25Z"
stroke = "currentColor"
stroke - width="1.8"
stroke - linejoin="round" >
  </path>
@if (muted()) {
  <path
                    d="M15.25 8.75L19.25 12.75"
  stroke = "currentColor"
  stroke - width="1.8"
  stroke - linecap="round" >
    </path>
    < path
  d = "M19.25 8.75L15.25 12.75"
  stroke = "currentColor"
  stroke - width="1.8"
  stroke - linecap="round" >
    </path>
} @else {
  <path
                    d="M16.25 9.25C17.15 9.95 17.75 11 17.75 12C17.75 13 17.15 14.05 16.25 14.75"
  stroke = "currentColor"
  stroke - width="1.8"
  stroke - linecap="round" >
    </path>
    < path
  d = "M18.5 7.25C20.1 8.55 21 10.2 21 12C21 13.8 20.1 15.45 18.5 16.75"
  stroke = "currentColor"
  stroke - width="1.8"
  stroke - linecap="round" >
    </path>
}
</svg>
  < span class="sr-only" > {{ muteButtonLabel() }}</span>
    </button>
    </div>
    </div>

    < div class="status-list" >
      @for (entry of focusingEntries(); track entry.taskId) {
  <div class="status-row flex items-center gap-3" data - state="focus" >
    <div
                class="w-3 h-3 rounded-full bg-indigo-500 shrink-0"
  [class.focus - dot - pulse] = "enableStatusExtraGlow()" >
  </div>
    < div class="status-row-content" >
      <div class="status-row-copy" >
        <span class="status-row-title font-medium text-slate-50" > {{ entry.title }
} </span>
  < div class="status-row-meta" >
    <span class="status-pill" data - tone="focus" > 专注中 </span>
      < span class="status-note" > 当前主线 </span>
        </div>
        </div>
        </div>
        </div>
          }

@for (entry of suspendedEntries(); track entry.taskId) {
  <div
              class="status-row clickable flex items-center gap-3"
  data - state="wait"
    (click) = "onSuspendedClick(entry)"
      (keydown.enter) = "onSuspendedClick(entry)"
        (keydown.space) = "$event.preventDefault(); onSuspendedClick(entry)"
  tabindex = "0"
  role = "button"
  data - testid="dock-v3-status-entry-suspended"
  [attr.data - task - id] = "entry.taskId" >
    <div class="relative w-8 h-8 shrink-0 rounded-full flex items-center justify-center" >
      <svg class="w-8 h-8 -rotate-90 absolute inset-0" viewBox = "0 0 24 24" >
        <circle
                    class="ring-track"
  cx = "12"
  cy = "12"
  [attr.r] = "ringRadius"
  [attr.stroke - width] = "ringStrokeWidth" >
    </circle>
  @if (isExpired(entry)) {
    <circle
                      class="ring-progress-expired"
    [class.ring - expired - glow] = "enableStatusExtraGlow()"
    cx = "12"
    cy = "12"
    [attr.r] = "ringRadius"
    [attr.stroke] = "ringExpiredStroke"
    [attr.stroke - width] = "ringStrokeWidth"
    [attr.stroke - dasharray] = "circumference"
    stroke - dashoffset="0" >
      </circle>
  } @else {
    <circle
                      class="ring-progress"
    cx = "12"
    cy = "12"
    [attr.r] = "ringRadius"
    [attr.stroke] = "ringWaitStroke"
    [attr.stroke - width] = "ringStrokeWidth"
    [attr.stroke - dasharray] = "circumference"
    [attr.stroke - dashoffset] = "getRingOffset(entry)" >
      </circle>
  }
  </svg>
    </div>

    < div class="status-row-content" >
      <div class="status-row-copy" >
        <span
                    class="status-row-title font-medium"
  [class.text - slate - 100] = "isExpired(entry)"
  [class.text - slate - 200] = "!isExpired(entry)" >
    {{ entry.title }
}
</span>
  < div class="status-row-meta" >
    <span class="status-pill"[attr.data - tone] = "isExpired(entry) ? 'expired' : 'wait'" >
      {{ entry.label }}
</span>
  < span class="status-note" > {{ getWaitDisplay(entry) }}</span>
@if (isExpired(entry) && suspendedEntries().length > 1) {
  <span class="status-pill" data - tone="switch" > 可切换 </span>
}
</div>
  </div>
  </div>
  </div>
          }

@for (entry of stalledEntries(); track entry.taskId) {
  <div
              class="status-row clickable flex items-center gap-3"
  data - state="stalled"
    (click) = "onStalledClick(entry)"
      (keydown.enter) = "onStalledClick(entry)"
        (keydown.space) = "$event.preventDefault(); onStalledClick(entry)"
  tabindex = "0"
  role = "button"
  data - testid="dock-v3-status-entry-stalled"
  [attr.data - task - id] = "entry.taskId" >
    <div class="w-3 h-3 rounded-full border border-slate-500 bg-slate-700/40 shrink-0" > </div>
      < div class="status-row-content" >
        <div class="status-row-copy" >
          <span class="status-row-title text-slate-300" > {{ entry.title }
} </span>
  < div class="status-row-meta" >
    <span class="status-pill" data - tone="stalled" > {{ entry.label }}</span>
      < span class="status-note" > 点击恢复 </span>
        </div>
        </div>
        </div>
        </div>
          }

@for (entry of idleEntries(); track entry.taskId) {
  <div class="status-row flex items-center gap-3" data - state="idle" >
    <div class="w-3 h-3 rounded-full border-2 border-slate-600 shrink-0" > </div>
      < div class="status-row-content" >
        <div class="status-row-copy" >
          <span class="status-row-title text-slate-500" > {{ entry.title }
} </span>
  < div class="status-row-meta" >
    <span class="status-pill" data - tone="idle" > 待启动 </span>
      < span class="status-note" > 队列中 </span>
        </div>
        </div>
        </div>
        </div>
          }

@if (allEntries().length === 0) {
  <div class="status-empty" >
    <div class="status-empty-icon" > </div>
      < span > 暂无任务 </span>
      </div>
}
</div>
  </div>
    } @else {
  <div class="glass-card px-3 py-2 rounded-full flex items-center gap-2" data - testid="dock-v3-status-machine-minimal" >
    <span class="text-[10px] text-slate-300 font-mono" > 专注 { { focusingEntries().length } } </span>
      < span class="text-[10px] text-amber-300 font-mono" > 等待 { { suspendedEntries().length } } </span>
  @if (stalledEntries().length > 0) {
    <span class="text-[10px] text-slate-300 font-mono" > 停滞 { { stalledEntries().length } } </span>
  }
  @if (blankPeriodActive() || fragmentDefenseLevel() >= 2) {
    <span class="text-[9px] text-yellow-300 bg-yellow-500/15 rounded-full px-1.5 py-0.5" > 留白期 </span>
  }
  @if (isBurnoutActive()) {
    <span class="text-[9px] text-orange-300 bg-orange-500/15 rounded-full px-1.5 py-0.5" > 倦怠 </span>
  }
  @if (restReminderActive()) {
    <button
            type="button"
    class="text-[9px] text-emerald-300 bg-emerald-500/15 rounded-full px-1.5 py-0.5 cursor-pointer"
      (click) = "dismissRestReminder()" >
      {{ restReminderLabel() }
  }
  </button>
}
@if (showPipToggleState()) {
  <button
            type="button"
  class="status-minimal-action"
  [attr.data - active] = "pipToggleActiveState() ? 'true' : 'false'"
    (click) = "requestPipToggle()"
    [attr.aria - label] = "pipToggleLabel()"
    [attr.title] = "pipToggleLabel()"
  data - testid="dock-v3-status-pip-toggle-minimal" >
    {{ pipToggleActiveState() ? '已弹出' : '弹出' }
}
</button>
        }

</div>
    }
`,
})
export class DockStatusMachineComponent implements OnDestroy {
  private readonly engine = inject(DockEngineService);
  private readonly performanceTierService = inject(PerformanceTierService);
  private readonly forcedModeInput = signal<'full' | 'minimal' | null>(null);
  readonly showPipToggleState = signal(false);
  readonly pipToggleActiveState = signal(false);
  private mqlRef: MediaQueryList | null = null;
  private mqlHandler: ((e: MediaQueryListEvent) => void) | null = null;
  readonly pipToggleRequested = output<void>();

  @Input()
  set forcedMode(value: 'full' | 'minimal' | null) {
    this.forcedModeInput.set(value ?? null);
  }

  get forcedMode(): 'full' | 'minimal' | null {
    return this.forcedModeInput();
  }

  @Input()
  set showPipToggle(value: boolean) {
    this.showPipToggleState.set(Boolean(value));
  }

  @Input()
  set pipToggleActive(value: boolean) {
    this.pipToggleActiveState.set(Boolean(value));
  }



  // GAP-B: 等待结束光晕 3 分钟后自动降级为静态微光，避免持续催促影响副任务心流
  private readonly prefersReducedMotion = signal(
    typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false,
  );
  private readonly glowActiveSince = signal<number | null>(null);
  /**
   * 光晕是否已降级。借助 engine.tick() 信号做定周期重新计算，
   * 但不调用 Date.now()——改为在 tick effect 中缓存 tickNow，
   * 保证 computed 仅依赖信号，不破坏 Signal 幂等契约。
   */
  private readonly tickNow = signal(Date.now());
  readonly isGlowDegraded = computed(() => {
    const since = this.glowActiveSince();
    if (since === null) return false;
    return this.tickNow() - since >= PARKING_CONFIG.GLOW_DEGRADE_AFTER_MS;
  });

  constructor() {
    // Listen for prefers-reduced-motion changes (store ref for cleanup)
    if (typeof window !== 'undefined' && window.matchMedia) {
      const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
      this.mqlHandler = (e: MediaQueryListEvent) => this.prefersReducedMotion.set(e.matches);
      mql.addEventListener('change', this.mqlHandler);
      this.mqlRef = mql;
    }
    // 借助 engine tick 定周期刷新 tickNow，驱动 isGlowDegraded 重算
    effect(() => {
      this.engine.tick(); // 订阅 tick 信号
      this.tickNow.set(Date.now());
    });
    // 跟踪光晕首次激活时间，光晕消失后重置
    effect(() => {
      const hasExpired = this.hasExpiredTask();
      const glowEnabled = this.enableStatusExtraGlow();
      if (hasExpired && glowEnabled) {
        if (untracked(() => this.glowActiveSince()) === null) {
          this.glowActiveSince.set(Date.now());
        }
      } else {
        this.glowActiveSince.set(null);
      }
    });
  }

  readonly enableStatusExtraGlow = computed(
    () =>
      PARKING_CONFIG.FOCUS_ENABLE_STATUS_EXTRA_GLOW
      && !this.prefersReducedMotion()
      && this.performanceTier() === 'T0',
  );
  readonly enableRestReminderGlow = computed(
    () =>
      PARKING_CONFIG.FOCUS_ENABLE_REST_REMINDER_GLOW
      && !this.prefersReducedMotion()
      && this.performanceTier() !== 'T2',
  );
  readonly performanceTier = computed(() => this.performanceTierService.tier());
  readonly ringRadius = PARKING_CONFIG.STATUS_RING_RADIUS;
  readonly ringStrokeWidth = PARKING_CONFIG.STATUS_RING_STROKE_WIDTH;
  readonly ringWaitStroke = PARKING_CONFIG.STATUS_RING_WAIT_STROKE;
  readonly ringExpiredStroke = PARKING_CONFIG.STATUS_RING_EXPIRED_STROKE;
  readonly circumference = 2 * Math.PI * PARKING_CONFIG.STATUS_RING_RADIUS;

  readonly allEntries = computed(() => this.engine.statusMachineEntries());
  readonly muted = computed(() => this.engine.muteWaitTone());
  readonly isBurnoutActive = computed(() => this.engine.isBurnoutActive());
  readonly restReminderActive = computed(() => this.engine.restReminderActive());
  readonly fragmentDefenseLevel = computed(() => this.engine.fragmentDefenseLevel());

  /** 休息提醒标签：显示累计专注时长，帮助用户感知心流持续时间 */
  readonly restReminderLabel = computed(() => {
    const highMs = this.engine.cumulativeHighLoadMs();
    const lowMs = this.engine.cumulativeLowLoadMs();
    const totalMin = Math.round(Math.max(highMs, lowMs) / 60_000);
    return `已专注 ${ totalMin } 分钟，休息一下`;
  });
  readonly blankPeriodActive = computed(
    () =>
      this.engine.fragmentEntryCountdown() === null
      && this.engine.pendingDecision() !== null
      && this.engine.pendingDecisionEntries().length === 0,
  );

  readonly hudMode = computed<'full' | 'minimal'>(() => {
    const forced = this.forcedModeInput();
    if (forced) return forced;
    if (this.hasExpiredTask()) return 'full';
    if (this.isBurnoutActive()) return 'full';
    if (this.blankPeriodActive()) return 'full';
    if (this.fragmentDefenseLevel() >= 2) return 'full';
    if (this.suspendedEntries().length > 0) return 'full';
    return 'minimal';
  });

  readonly focusingEntries = computed(() =>
    this.allEntries().filter(entry => entry.uiStatus === 'focusing'),
  );

  readonly suspendedEntries = computed(() =>
    this.allEntries().filter(
      entry => entry.uiStatus === 'suspended_waiting' || entry.uiStatus === 'waiting_done',
    ),
  );

  readonly stalledEntries = computed(() =>
    this.allEntries().filter(entry => entry.uiStatus === 'stalled'),
  );

  readonly idleEntries = computed(() =>
    this.allEntries().filter(entry => entry.uiStatus === 'queued'),
  );

  readonly muteButtonLabel = computed(() =>
    this.muted() ? '关闭静音提醒' : '开启状态提醒声音',
  );
  readonly pipToggleLabel = computed(() =>
    this.pipToggleActiveState() ? '关闭悬浮窗' : '弹出悬浮窗',
  );

  readonly expiredTaskIds = computed(() => {
    const ids = new Set<string>();
    for (const entry of this.suspendedEntries()) {
      if (isStatusMachineEntryExpired(entry)) {
        ids.add(entry.taskId);
      }
    }
    return ids;
  });

  readonly ringOffsets = computed(() => {
    const map = new Map<string, number>();
    for (const entry of this.suspendedEntries()) {
      if (entry.waitTotalSeconds == null || entry.waitRemainingSeconds == null || entry.waitTotalSeconds <= 0) {
        map.set(entry.taskId, 0);
        continue;
      }
      const progress = Math.min(
        1,
        Math.max(0, 1 - entry.waitRemainingSeconds / entry.waitTotalSeconds),
      );
      map.set(entry.taskId, this.circumference * (1 - progress));
    }
    return map;
  });

  readonly hasExpiredTask = computed(() => this.expiredTaskIds().size > 0);

  isExpired(entry: StatusMachineEntry): boolean {
    return this.expiredTaskIds().has(entry.taskId);
  }

  getRingOffset(entry: StatusMachineEntry): number {
    return this.ringOffsets().get(entry.taskId) ?? 0;
  }

  getWaitDisplay(entry: StatusMachineEntry): string {
    if (this.isExpired(entry)) {
      return '等待已结束';
    }
    if (entry.waitRemainingSeconds == null) {
      return '等待中';
    }
    return `剩余 ${ this.formatCompactDuration(entry.waitRemainingSeconds) } `;
  }

  onSuspendedClick(entry: StatusMachineEntry): void {
    // GAP-B: 用户与状态机交互后重置光晕降级计时
    this.glowActiveSince.set(null);
    this.engine.switchToTask(entry.taskId);
  }

  onStalledClick(entry: StatusMachineEntry): void {
    this.glowActiveSince.set(null);
    this.engine.switchToTask(entry.taskId);
  }

  toggleMute(): void {
    this.engine.toggleMuteWaitTone();
  }

  requestPipToggle(): void {
    this.pipToggleRequested.emit();
  }

  dismissRestReminder(): void {
    this.engine.dismissRestReminder();
  }

  private formatCompactDuration(totalSeconds: number): string {
    const safeSeconds = Math.max(0, Math.floor(totalSeconds));
    const hours = Math.floor(safeSeconds / 3600);
    const minutes = Math.floor((safeSeconds % 3600) / 60);
    const seconds = safeSeconds % 60;

    if (hours > 0) {
      return `${ hours }h ${ minutes.toString().padStart(2, '0') } m`;
    }
    return `${ minutes.toString().padStart(2, '0') }:${ seconds.toString().padStart(2, '0') } `;
  }

  ngOnDestroy(): void {
    if (this.mqlRef && this.mqlHandler) {
      this.mqlRef.removeEventListener('change', this.mqlHandler);
      this.mqlRef = null;
      this.mqlHandler = null;
    }
  }

}
