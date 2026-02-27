import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { DockEngineService } from '../../../../services/dock-engine.service';
import { PARKING_CONFIG } from '../../../../config/parking.config';
import { StatusMachineEntry } from '../../../../models/parking-dock';

/**
 * 状态机悬浮挂件 — 右上角显示所有 docked 任务的运行状态。
 *
 * 三种状态 UI 差异化：
 * - 专注中: 蓝紫色脉冲圆点
 * - 挂起等待: 环形进度条（SVG 圆环缓慢闭合） + 呼吸脉冲
 * - 等待结束: 环完全闭合 + 边缘呼吸发光(amber) + 柔和提示音
 * - 待启动: 灰色空心圆
 */
@Component({
  selector: 'app-dock-status-machine',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule],
  styles: [`
    :host {
      display: block;
    }

    .glass-card {
      background: rgba(28, 25, 23, 0.45);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border: 1px solid rgba(255, 255, 255, 0.08);
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
    }

    @keyframes slideInRight {
      from {
        opacity: 0;
        transform: translateX(50px);
      }
    }
    .slide-in-right {
      animation: slideInRight 0.45s cubic-bezier(0.22, 1.2, 0.36, 1);
      will-change: transform, opacity;
    }

    /* 专注中脉冲 */
    @keyframes focusPulse {
      0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(99, 102, 241, 0.5); }
      50%      { opacity: 0.6; box-shadow: 0 0 0 6px rgba(99, 102, 241, 0); }
    }
    .focus-pulse {
      animation: focusPulse 2s ease-in-out infinite;
    }

    /* 等待中环脉冲 */
    @keyframes pulse-ring {
      0%  { box-shadow: 0 0 0 0 rgba(245, 158, 11, 0.4); }
      70% { box-shadow: 0 0 0 8px rgba(245, 158, 11, 0); }
      100%{ box-shadow: 0 0 0 0 rgba(245, 158, 11, 0); }
    }
    .waiting-ring {
      animation: pulse-ring 2s infinite;
    }

    /* 等待结束呼吸发光 */
    @keyframes breatheGlow {
      0%, 100% { box-shadow: 0 0 4px 1px rgba(251, 191, 36, 0.3); }
      50%      { box-shadow: 0 0 18px 6px rgba(251, 191, 36, 0.6); }
    }
    .glow-expired {
      animation: breatheGlow 2s ease-in-out infinite;
    }

    /* SVG 圆环 */
    .ring-track {
      fill: none;
      stroke: rgba(120, 113, 108, 0.2);
      stroke-width: 2.5;
    }
    .ring-progress {
      fill: none;
      stroke-width: 2.5;
      stroke-linecap: round;
      transition: stroke-dashoffset 1s linear;
    }
    .ring-progress-expired {
      fill: none;
      stroke-width: 2.5;
      stroke-linecap: round;
      stroke: #fbbf24;
    }

    /* 状态行动画 */
    @keyframes statusRowIn {
      from { opacity: 0; transform: translateX(20px); }
      to   { opacity: 1; transform: translateX(0); }
    }
    .status-row {
      animation: statusRowIn 0.3s ease-out;
    }

    /* 分割线 */
    .status-divider {
      border-top: 1px solid rgba(120, 113, 108, 0.2);
    }

    @media (prefers-reduced-motion: reduce) {
      .slide-in-right,
      .focus-pulse,
      .waiting-ring,
      .glow-expired,
      .status-row {
        animation: none;
      }
    }
  `],
  template: `
    <div class="slide-in-right glass-card px-4 py-3 rounded-2xl flex flex-col gap-2 min-w-[220px] max-w-[280px]"
         data-testid="dock-v3-status-machine">

      <!-- 标题 -->
      <div class="mb-1 flex items-center justify-between gap-3">
        <div class="text-[10px] text-stone-500 font-semibold tracking-wider font-mono uppercase">
          状态机 Status
        </div>
        <button
          type="button"
          class="rounded-lg border border-stone-700/70 px-2 py-1 text-[10px] transition-colors"
          [ngClass]="muted() ? 'text-amber-300 bg-amber-500/10' : 'text-stone-400 bg-stone-800/70'"
          (click)="toggleMute()"
          data-testid="dock-v3-status-mute">
          {{ muted() ? '提示音已静音' : '提示音已开启' }}
        </button>
      </div>

      <!-- 专注中的任务 -->
      @for (entry of focusingEntries(); track entry.taskId) {
        <div class="status-row flex items-center gap-3 py-1">
          <div class="w-2.5 h-2.5 rounded-full bg-indigo-500 focus-pulse shrink-0"></div>
          <div class="flex flex-col min-w-0 flex-1">
            <span class="text-sm font-medium text-stone-100 truncate">{{ entry.title }}</span>
            <span class="text-[10px] text-indigo-400 font-medium">专注中</span>
          </div>
        </div>
      }

      <!-- 挂起等待 / 等待结束的任务 -->
      @for (entry of suspendedEntries(); track entry.taskId; let first = $first) {
        @if (first && focusingEntries().length > 0) {
          <div class="status-divider my-1"></div>
        }
        <div class="status-row flex items-center gap-3 py-1" (click)="onSuspendedClick(entry)">
          <!-- 环形进度条 -->
          <div class="relative w-9 h-9 shrink-0 rounded-full cursor-pointer"
            [class.waiting-ring]="!isExpired(entry)"
            [class.glow-expired]="isExpired(entry)">
            <svg class="w-9 h-9 -rotate-90" viewBox="0 0 22 22">
              <circle class="ring-track" cx="11" cy="11" [attr.r]="ringRadius" [attr.stroke-width]="ringStrokeWidth" />
              @if (isExpired(entry)) {
                <circle class="ring-progress-expired" cx="11" cy="11" [attr.r]="ringRadius"
                  [attr.stroke]="ringExpiredStroke"
                  [attr.stroke-width]="ringStrokeWidth"
                  [attr.stroke-dasharray]="circumference"
                  stroke-dashoffset="0" />
              } @else {
                <circle class="ring-progress" cx="11" cy="11" [attr.r]="ringRadius"
                  [attr.stroke]="ringWaitStroke"
                  [attr.stroke-width]="ringStrokeWidth"
                  [attr.stroke-dasharray]="circumference"
                  [attr.stroke-dashoffset]="getRingOffset(entry)" />
              }
            </svg>
            <!-- 中心状态文字 -->
            <div class="absolute inset-0 flex items-center justify-center">
              @if (isExpired(entry)) {
                <div class="w-2 h-2 rounded-full bg-amber-300"></div>
              } @else {
                <div class="w-1.5 h-1.5 rounded-full bg-amber-500/80"></div>
              }
            </div>
          </div>

          <div class="flex flex-col min-w-0 flex-1">
            <span class="text-sm font-medium truncate"
              [class.text-stone-200]="isExpired(entry)"
              [class.text-stone-400]="!isExpired(entry)">
              {{ entry.title }}
            </span>
            <span class="text-[10px] font-medium"
              [class.text-amber-400]="isExpired(entry)"
              [class.text-amber-600]="!isExpired(entry)">
              {{ entry.label }}
            </span>
          </div>
        </div>
      }

      <!-- 待启动的任务 -->
      @for (entry of idleEntries(); track entry.taskId; let first = $first) {
        @if (first && (focusingEntries().length > 0 || suspendedEntries().length > 0)) {
          <div class="status-divider my-1"></div>
        }
        <div class="status-row flex items-center gap-3 py-1">
          <div class="w-2.5 h-2.5 rounded-full border border-stone-600 shrink-0"></div>
          <div class="flex flex-col min-w-0 flex-1">
            <span class="text-sm text-stone-500 truncate">{{ entry.title }}</span>
            <span class="text-[10px] text-stone-600">待启动</span>
          </div>
        </div>
      }

      <!-- 无任务 -->
      @if (allEntries().length === 0) {
        <div class="text-xs text-stone-600 py-1">暂无任务</div>
      }
    </div>
  `,
})
export class DockStatusMachineComponent {
  private readonly engine = inject(DockEngineService);

  readonly ringRadius = PARKING_CONFIG.STATUS_RING_RADIUS;
  readonly ringStrokeWidth = PARKING_CONFIG.STATUS_RING_STROKE_WIDTH;
  readonly ringWaitStroke = PARKING_CONFIG.STATUS_RING_WAIT_STROKE;
  readonly ringExpiredStroke = PARKING_CONFIG.STATUS_RING_EXPIRED_STROKE;

  /** SVG 圆环周长 */
  readonly circumference = 2 * Math.PI * PARKING_CONFIG.STATUS_RING_RADIUS;

  readonly allEntries = computed(() => this.engine.statusMachineEntries());
  readonly muted = computed(() => this.engine.muteWaitTone());

  readonly focusingEntries = computed(() =>
    this.allEntries().filter(e => e.label === '专注中'),
  );

  readonly suspendedEntries = computed(() =>
    this.allEntries().filter(e => e.label === '挂起等待' || e.label === '等待结束'),
  );

  readonly idleEntries = computed(() =>
    this.allEntries().filter(e => e.label === '待启动'),
  );

  isExpired(entry: StatusMachineEntry): boolean {
    return entry.label === '等待结束' ||
      (entry.waitRemainingSeconds !== null && entry.waitRemainingSeconds <= 0);
  }

  getRingOffset(entry: StatusMachineEntry): number {
    if (entry.waitTotalSeconds == null || entry.waitRemainingSeconds == null) {
      return 0;
    }
    const progress = Math.min(1, Math.max(0,
      1 - entry.waitRemainingSeconds / entry.waitTotalSeconds,
    ));
    return this.circumference * (1 - progress);
  }

  /** 点击挂起任务可以切换到它 */
  onSuspendedClick(entry: StatusMachineEntry): void {
    this.engine.switchToTask(entry.taskId);
  }

  toggleMute(): void {
    this.engine.toggleMuteWaitTone();
  }
}
