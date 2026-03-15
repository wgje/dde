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

type StatusSummaryTone = 'focus' | 'wait' | 'stalled' | 'idle';

interface StatusSummaryItem {
  count: number;
  id: StatusSummaryTone;
  label: string;
  tone: StatusSummaryTone;
}

type StatusPrimaryRow =
  | {
      entry: StatusMachineEntry;
      kind: 'focus' | 'wait' | 'stalled' | 'idle';
      trackId: string;
    };

@Component({
  selector: 'app-dock-status-machine',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule],
  styleUrl: './dock-status-machine.component.scss',
  templateUrl: './dock-status-machine.component.html',
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
    if (typeof window !== 'undefined' && window.matchMedia) {
      const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
      this.mqlHandler = (e: MediaQueryListEvent) => this.prefersReducedMotion.set(e.matches);
      mql.addEventListener('change', this.mqlHandler);
      this.mqlRef = mql;
    }

    effect(() => {
      this.engine.tick();
      this.tickNow.set(Date.now());
    });

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

  readonly summaryItems = computed<StatusSummaryItem[]>(() => {
    const items: StatusSummaryItem[] = [
      { id: 'focus', label: '专注', count: this.focusingEntries().length, tone: 'focus' },
      { id: 'wait', label: '等待', count: this.suspendedEntries().length, tone: 'wait' },
      { id: 'stalled', label: '停滞', count: this.stalledEntries().length, tone: 'stalled' },
      { id: 'idle', label: '待启', count: this.idleEntries().length, tone: 'idle' },
    ];
    return items.filter(item => item.count > 0);
  });

  /** 状态机直接展示当前 4 条可见任务，不再折叠为 overflow 汇总。 */
  readonly visibleRows = computed<StatusPrimaryRow[]>(() => {
    const candidates: StatusPrimaryRow[] = [
      ...this.focusingEntries().map(entry => ({ kind: 'focus' as const, entry, trackId: `focus-${entry.taskId}` })),
      ...this.suspendedEntries().map(entry => ({ kind: 'wait' as const, entry, trackId: `wait-${entry.taskId}` })),
      ...this.stalledEntries().map(entry => ({ kind: 'stalled' as const, entry, trackId: `stalled-${entry.taskId}` })),
      ...this.idleEntries().map(entry => ({ kind: 'idle' as const, entry, trackId: `idle-${entry.taskId}` })),
    ];
    return candidates.slice(0, PARKING_CONFIG.STATUS_MACHINE_VISIBLE_LIMIT);
  });

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
    return `剩余 ${this.formatCompactDuration(entry.waitRemainingSeconds)}`;
  }

  onSuspendedClick(entry: StatusMachineEntry): void {
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
    this.engine.fragmentRest.dismissRestReminder();
  }

  private formatCompactDuration(totalSeconds: number): string {
    const safeSeconds = Math.max(0, Math.floor(totalSeconds));
    const hours = Math.floor(safeSeconds / 3600);
    const minutes = Math.floor((safeSeconds % 3600) / 60);
    const seconds = safeSeconds % 60;

    if (hours > 0) {
      return `${hours}h ${minutes.toString().padStart(2, '0')}m`;
    }
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }

  ngOnDestroy(): void {
    if (this.mqlRef && this.mqlHandler) {
      this.mqlRef.removeEventListener('change', this.mqlHandler);
      this.mqlRef = null;
      this.mqlHandler = null;
    }
  }
}
