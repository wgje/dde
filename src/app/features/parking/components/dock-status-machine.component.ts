import {
  ChangeDetectionStrategy,
  Component,
  Input,
  OnDestroy,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { DockEngineService } from '../../../../services/dock-engine.service';
import { PerformanceTierService } from '../../../../services/performance-tier.service';
import { PARKING_CONFIG } from '../../../../config/parking.config';
import { StatusMachineEntry } from '../../../../models/parking-dock';

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
      border-radius: 9999px;
      border: 1px solid rgba(148, 163, 184, 0.12);
      background: rgba(30, 41, 59, 0.6);
      color: rgba(148, 163, 184, 0.8);
      transition: background 0.15s ease, color 0.15s ease;
      cursor: pointer;
      flex-shrink: 0;
    }
    .hud-action-btn:hover {
      background: rgba(51, 65, 85, 0.7);
      color: rgba(226, 232, 240, 1);
    }

    .glass-card {
      background: linear-gradient(165deg, rgba(22, 28, 36, 0.94), rgba(16, 22, 32, 0.90));
      border: 1px solid rgba(148, 163, 184, 0.08);
      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.4);
    }

    .status-row {
      border-radius: 10px;
      padding: 6px 8px;
      transition: background var(--pk-micro-hover) var(--pk-ease-standard);
    }

    .status-row.clickable:hover {
      background: rgba(255, 255, 255, 0.05);
      cursor: pointer;
    }

    .status-divider {
      border-top: 1px solid rgba(100, 116, 139, 0.15);
    }

    .ring-track {
      fill: none;
      stroke: rgba(100, 116, 139, 0.18);
      stroke-width: 2.5;
    }

    .ring-progress,
    .ring-progress-expired {
      fill: none;
      stroke-width: 2.5;
      stroke-linecap: round;
    }

    .ring-progress {
      transition: stroke-dashoffset 10s linear;
    }

    .expired-border-glow {
      border-color: rgba(99, 102, 241, 0.28);
      box-shadow:
        0 10px 40px rgba(0, 0, 0, 0.4),
        0 0 0 1px rgba(99, 102, 241, 0.16),
        0 0 28px rgba(99, 102, 241, 0.14);
      animation: statusHudGlow var(--pk-micro-glow) var(--pk-ease-standard) 2;
    }

    /* GAP-B: 光晕降级状态，3分钟后自动切换为静态微光，避免持续催促影响副任务心流 */
    .expired-border-glow-degraded {
      border-color: rgba(99, 102, 241, 0.14);
      box-shadow:
        0 10px 40px rgba(0, 0, 0, 0.4),
        0 0 0 1px rgba(99, 102, 241, 0.10),
        0 0 14px rgba(99, 102, 241, 0.06);
      transition:
        box-shadow var(--pk-micro-glow) var(--pk-ease-standard),
        border-color var(--pk-micro-glow) var(--pk-ease-standard);
    }

    .focus-dot-pulse {
      animation: statusDotPulse var(--pk-micro-pulse) var(--pk-ease-standard) 2;
      box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.35);
    }

    .ring-expired-glow {
      filter: drop-shadow(0 0 6px rgba(251, 191, 36, 0.42));
      animation: statusExpiredGlow var(--pk-micro-glow) var(--pk-ease-standard) 2;
    }

    @keyframes statusHudGlow {
      0%, 100% {
        box-shadow:
          0 10px 40px rgba(0, 0, 0, 0.4),
          0 0 0 1px rgba(99, 102, 241, 0.14),
          0 0 20px rgba(99, 102, 241, 0.1);
      }
      50% {
        box-shadow:
          0 10px 40px rgba(0, 0, 0, 0.4),
          0 0 0 1px rgba(99, 102, 241, 0.22),
          0 0 30px rgba(99, 102, 241, 0.16);
      }
    }

    @keyframes statusDotPulse {
      0%, 100% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.28); }
      50% { box-shadow: 0 0 0 8px rgba(16, 185, 129, 0); }
    }

    @keyframes statusExpiredGlow {
      0%, 100% { filter: drop-shadow(0 0 4px rgba(251, 191, 36, 0.28)); }
      50% { filter: drop-shadow(0 0 8px rgba(251, 191, 36, 0.48)); }
    }

    .rest-reminder-glow {
      border-color: rgba(16, 185, 129, 0.28);
      box-shadow:
        0 10px 40px rgba(0, 0, 0, 0.4),
        0 0 0 1px rgba(16, 185, 129, 0.16),
        0 0 28px rgba(16, 185, 129, 0.14);
      animation: restGlow var(--pk-micro-glow) var(--pk-ease-standard) 2;
    }

    @keyframes restGlow {
      0%, 100% {
        box-shadow:
          0 10px 40px rgba(0, 0, 0, 0.4),
          0 0 0 1px rgba(16, 185, 129, 0.12),
          0 0 18px rgba(16, 185, 129, 0.08);
      }
      50% {
        box-shadow:
          0 10px 40px rgba(0, 0, 0, 0.4),
          0 0 0 1px rgba(16, 185, 129, 0.22),
          0 0 32px rgba(16, 185, 129, 0.18);
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .expired-border-glow,
      .expired-border-glow-degraded,
      .focus-dot-pulse,
      .ring-expired-glow,
      .rest-reminder-glow {
        animation: none;
      }
    }
  `],
  template: `
    @if (hudMode() === 'full') {
      <div
        class="glass-card px-4 py-3.5 rounded-2xl flex flex-col gap-1.5 min-w-[220px] max-w-[290px]"
        [class.expired-border-glow]="hasExpiredTask() && enableStatusExtraGlow() && !isGlowDegraded()"
        [class.expired-border-glow-degraded]="hasExpiredTask() && enableStatusExtraGlow() && isGlowDegraded()"
        [class.rest-reminder-glow]="restReminderActive() && enableRestReminderGlow()"
        [attr.data-performance-tier]="performanceTier()"
        data-testid="dock-v3-status-machine">

        <!-- 操作栏：设置 / 帮助 / 退出，内嵌在 HUD 内避免与外部按钮争占边缘空间 -->
        <div class="flex items-center justify-between gap-2 mb-1">
          <div class="flex items-center gap-2 flex-wrap flex-1 min-w-0">
            <div class="text-[10px] text-slate-500 font-semibold tracking-widest font-mono uppercase">
              状态机 Status
            </div>
            @if (allEntries().length > 0) {
              <div class="text-[9px] text-slate-600 bg-slate-800/50 rounded-full px-1.5 py-0.5 font-mono">
                {{ allEntries().length }}
              </div>
            }
            @if (blankPeriodActive()) {
              <div class="text-[8px] text-amber-300 bg-amber-500/15 rounded-full px-1.5 py-0.5 font-semibold">
                留白期
              </div>
            }
            @if (isBurnoutActive()) {
              <div class="text-[8px] text-orange-400 bg-orange-500/15 rounded-full px-1.5 py-0.5 font-semibold">
                倦怠
              </div>
            }
            @if (restReminderActive()) {
              <button
                type="button"
                class="text-[8px] text-emerald-300 bg-emerald-500/15 rounded-full px-1.5 py-0.5 font-semibold cursor-pointer hover:bg-emerald-500/25 transition-colors"
                (click)="dismissRestReminder()"
                data-testid="dock-v3-rest-reminder-badge">
                {{ restReminderLabel() }} ✕
              </button>
            }
          </div>
        </div>

        <div class="flex items-center justify-start gap-2">
          <button
            type="button"
            class="rounded-lg border px-2 py-1.5 text-[10px] leading-none transition-colors whitespace-nowrap"
            [ngClass]="muted() ? 'text-amber-300 bg-amber-500/10 border-amber-500/30' : 'text-slate-400 bg-slate-800/70 border-slate-700/70'"
            (click)="toggleMute()"
            style="min-height: 44px;"
            data-testid="dock-v3-status-mute">
            {{ muted() ? '静音提醒' : '声音开启' }}
          </button>
        </div>

        @for (entry of focusingEntries(); track entry.taskId) {
          <div class="status-row flex items-center gap-3">
            <div
              class="w-3 h-3 rounded-full bg-indigo-500 shrink-0"
              [class.focus-dot-pulse]="enableStatusExtraGlow()">
            </div>
            <div class="flex flex-col min-w-0 flex-1">
              <span class="text-sm font-medium text-slate-100 truncate">{{ entry.title }}</span>
              <span class="text-[10px] text-indigo-400 font-semibold">专注中</span>
            </div>
          </div>
        }

        @for (entry of suspendedEntries(); track entry.taskId; let first = $first) {
          @if (first && focusingEntries().length > 0) {
            <div class="status-divider my-1"></div>
          }
          <div
            class="status-row clickable flex items-center gap-3"
            (click)="onSuspendedClick(entry)"
            (keydown.enter)="onSuspendedClick(entry)"
            (keydown.space)="$event.preventDefault(); onSuspendedClick(entry)"
            tabindex="0"
            role="button"
            data-testid="dock-v3-status-entry-suspended"
            [attr.data-task-id]="entry.taskId">
            <div class="relative w-10 h-10 shrink-0 rounded-full flex items-center justify-center">
              <svg class="w-10 h-10 -rotate-90 absolute inset-0" viewBox="0 0 24 24">
                <circle
                  class="ring-track"
                  cx="12"
                  cy="12"
                  [attr.r]="ringRadius"
                  [attr.stroke-width]="ringStrokeWidth">
                </circle>
                @if (isExpired(entry)) {
                  <circle
                    class="ring-progress-expired"
                    [class.ring-expired-glow]="enableStatusExtraGlow()"
                    cx="12"
                    cy="12"
                    [attr.r]="ringRadius"
                    [attr.stroke]="ringExpiredStroke"
                    [attr.stroke-width]="ringStrokeWidth"
                    [attr.stroke-dasharray]="circumference"
                    stroke-dashoffset="0">
                  </circle>
                } @else {
                  <circle
                    class="ring-progress"
                    cx="12"
                    cy="12"
                    [attr.r]="ringRadius"
                    [attr.stroke]="ringWaitStroke"
                    [attr.stroke-width]="ringStrokeWidth"
                    [attr.stroke-dasharray]="circumference"
                    [attr.stroke-dashoffset]="getRingOffset(entry)">
                  </circle>
                }
              </svg>
            </div>

            <div class="flex flex-col min-w-0 flex-1">
              <span
                class="text-sm font-medium truncate"
                [class.text-slate-200]="isExpired(entry)"
                [class.text-slate-400]="!isExpired(entry)">
                {{ entry.title }}
              </span>
              <div class="flex items-center gap-1.5">
                <span
                  class="text-[10px] font-semibold"
                  [class.text-amber-400]="isExpired(entry)"
                  [class.text-amber-600]="!isExpired(entry)">
                  {{ entry.label }}
                </span>
                @if (isExpired(entry) && suspendedEntries().length > 1) {
                  <span class="text-[8px] text-indigo-300 bg-indigo-500/20 rounded-full px-1.5 py-0.5">
                    可切换
                  </span>
                }
              </div>
            </div>
          </div>
        }

        @for (entry of stalledEntries(); track entry.taskId; let first = $first) {
          @if (first && (focusingEntries().length > 0 || suspendedEntries().length > 0)) {
            <div class="status-divider my-1"></div>
          }
          <div
            class="status-row clickable flex items-center gap-3"
            (click)="onStalledClick(entry)"
            (keydown.enter)="onStalledClick(entry)"
            (keydown.space)="$event.preventDefault(); onStalledClick(entry)"
            tabindex="0"
            role="button"
            data-testid="dock-v3-status-entry-stalled"
            [attr.data-task-id]="entry.taskId">
            <div class="w-3 h-3 rounded-full border border-slate-500 bg-slate-700/40 shrink-0"></div>
            <div class="flex flex-col min-w-0 flex-1">
              <span class="text-sm text-slate-300 truncate">{{ entry.title }}</span>
              <span class="text-[10px] text-slate-400 font-medium">{{ entry.label }}</span>
            </div>
          </div>
        }

        @for (entry of idleEntries(); track entry.taskId; let first = $first) {
          @if (first && (focusingEntries().length > 0 || suspendedEntries().length > 0 || stalledEntries().length > 0)) {
            <div class="status-divider my-1"></div>
          }
          <div class="status-row flex items-center gap-3">
            <div class="w-3 h-3 rounded-full border-2 border-slate-600 shrink-0"></div>
            <div class="flex flex-col min-w-0 flex-1">
              <span class="text-sm text-slate-500 truncate">{{ entry.title }}</span>
              <span class="text-[10px] text-slate-600 font-medium">待启动</span>
            </div>
          </div>
        }

        @if (allEntries().length === 0) {
          <div class="text-xs text-slate-600 py-3 text-center flex flex-col items-center gap-1.5">
            <div class="w-5 h-5 rounded-full border-2 border-slate-700 border-dashed"></div>
            <span>暂无任务</span>
          </div>
        }
      </div>
    } @else {
      <div class="glass-card px-3 py-2 rounded-full flex items-center gap-2" data-testid="dock-v3-status-machine-minimal">
        <span class="text-[10px] text-slate-300 font-mono">专注 {{ focusingEntries().length }}</span>
        <span class="text-[10px] text-amber-300 font-mono">等待 {{ suspendedEntries().length }}</span>
        @if (stalledEntries().length > 0) {
          <span class="text-[10px] text-slate-300 font-mono">停滞 {{ stalledEntries().length }}</span>
        }
        @if (blankPeriodActive() || fragmentDefenseLevel() >= 2) {
          <span class="text-[9px] text-yellow-300 bg-yellow-500/15 rounded-full px-1.5 py-0.5">留白期</span>
        }
        @if (isBurnoutActive()) {
          <span class="text-[9px] text-orange-300 bg-orange-500/15 rounded-full px-1.5 py-0.5">倦怠</span>
        }
        @if (restReminderActive()) {
          <button
            type="button"
            class="text-[9px] text-emerald-300 bg-emerald-500/15 rounded-full px-1.5 py-0.5 cursor-pointer"
            (click)="dismissRestReminder()">
            {{ restReminderLabel() }}
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
  private mqlRef: MediaQueryList | null = null;
  private mqlHandler: ((e: MediaQueryListEvent) => void) | null = null;

  @Input()
  set forcedMode(value: 'full' | 'minimal' | null) {
    this.forcedModeInput.set(value ?? null);
  }

  get forcedMode(): 'full' | 'minimal' | null {
    return this.forcedModeInput();
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
    return `已专注 ${totalMin} 分钟，休息一下`;
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

  readonly expiredTaskIds = computed(() => {
    const ids = new Set<string>();
    for (const entry of this.suspendedEntries()) {
      if (
        entry.uiStatus === 'waiting_done'
        || (entry.waitRemainingSeconds !== null && entry.waitRemainingSeconds <= 0)
      ) {
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

  dismissRestReminder(): void {
    this.engine.fragmentRest.dismissRestReminder();
  }

  ngOnDestroy(): void {
    if (this.mqlRef && this.mqlHandler) {
      this.mqlRef.removeEventListener('change', this.mqlHandler);
      this.mqlRef = null;
      this.mqlHandler = null;
    }
  }

}
