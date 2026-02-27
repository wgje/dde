import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { PARKING_CONFIG } from '../../../../config/parking.config';
import { DockEngineService } from '../../../../services/dock-engine.service';

/**
 * 雷达区域 — 半包围式同心椭圆轨道分布。
 *
 * 3.1 强关联区域: 内圈，透明度较高，浮游游离
 * 3.2 弱关联区域: 外圈，透明度更低，更轻盈的浮游
 *
 * 布局: 左+上+右 半包围（底部不放任务），弧度 π/6 → 5π/6
 * 动画: 每个 pill 有微幅浮游 float（3-5s 周期，错开 delay）
 * 交互: 点击 → 推进到控制台；高亮 → 磁力吸附脉冲动画
 */
@Component({
  selector: 'app-dock-radar-zone',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule],
  styles: [`
    :host {
      display: block;
      width: 0;
      height: 0;
      pointer-events: none;
    }

    /* 玻璃拟态 pill */
    .glass-pill {
      background: rgba(28, 25, 23, 0.45);
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      border: 1px solid rgba(255, 255, 255, 0.08);
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
    }

    /* 雷达项基础 */
    .radar-item {
      pointer-events: auto;
      cursor: pointer;
      user-select: none;
      transition: opacity 0.3s ease, box-shadow 0.3s ease;
    }
    .radar-item:hover {
      opacity: 1 !important;
    }

    /* 浮游动画 — 微幅上下漂移 */
    @keyframes radarFloat {
      0%, 100% { transform: translate(-50%, -50%) translateY(0); }
      50%      { transform: translate(-50%, -50%) translateY(-8px); }
    }
    .radar-float {
      animation: radarFloat var(--float-duration, 3.5s) ease-in-out infinite;
      animation-delay: var(--float-delay, 0s);
    }

    /* 弱关联浮游（幅度更小） */
    @keyframes radarFloatWeak {
      0%, 100% { transform: translate(-50%, -50%) scale(var(--weak-scale, 0.9)) translateY(0); }
      50%      { transform: translate(-50%, -50%) scale(var(--weak-scale, 0.9)) translateY(-5px); }
    }
    .radar-float-weak {
      animation: radarFloatWeak var(--float-duration, 4s) ease-in-out infinite;
      animation-delay: var(--float-delay, 0s);
    }

    /* 算法选中高亮脉冲 */
    @keyframes highlightPulse {
      0%   { border-color: rgba(99, 102, 241, 0.3); box-shadow: 0 0 8px rgba(99, 102, 241, 0.15); }
      50%  { border-color: rgba(99, 102, 241, 0.9); box-shadow: 0 0 24px rgba(99, 102, 241, 0.4); }
      100% { border-color: rgba(99, 102, 241, 0.3); box-shadow: 0 0 8px rgba(99, 102, 241, 0.15); }
    }
    .radar-highlight {
      border: 2px dashed rgba(99, 102, 241, 0.8) !important;
      animation: highlightPulse 0.8s ease-in-out infinite;
    }

    /* 磁力拉入动画 (pill → 向中心滑动放大后消失) */
    @keyframes magnetSlide {
      0%   { opacity: var(--start-opacity, 0.6); transform: translate(-50%, -50%) scale(1); }
      60%  { opacity: 0.8; transform: translate(-50%, -50%) scale(1.15); }
      100% { opacity: 0; transform: translate(0, 0) scale(1.3); }
    }
    .magnet-slide {
      animation: magnetSlide 500ms cubic-bezier(0.16, 1, 0.3, 1) forwards;
      pointer-events: none;
    }

    /* 负荷色点 */
    .load-dot-high { background-color: #ef4444; box-shadow: 0 0 4px rgba(239, 68, 68, 0.4); }
    .load-dot-low  { background-color: #10b981; box-shadow: 0 0 4px rgba(16, 185, 129, 0.4); }

    @media (prefers-reduced-motion: reduce) {
      .radar-float, .radar-float-weak, .radar-highlight, .magnet-slide {
        animation: none;
      }
      .radar-item {
        transition: none;
      }
    }
  `],
  template: `
    <!-- 3.1 强关联区域: 内圈半包围 -->
    @for (item of strongItems(); track item.entry.taskId; let i = $index) {
      <div
        class="radar-item radar-float absolute glass-pill px-4 py-2.5 rounded-full flex items-center gap-2.5"
        [class.radar-highlight]="isHighlighted(item.entry.taskId)"
        [class.magnet-slide]="isMagnetSliding(item.entry.taskId)"
        [style.left.px]="item.x"
        [style.top.px]="item.y"
        [style.opacity]="strongOpacity"
        [style.--float-duration]="floatDuration"
        [style.--float-delay]="getFloatDelay(i)"
        (click)="promoteToConsole(item.entry.taskId)"
        (wheel)="onWheel($event, item.entry.taskId)"
        (touchstart)="onTouchStart($event, item.entry.taskId)"
        (touchmove)="onTouchMove($event, item.entry.taskId)"
        (touchend)="onTouchEnd()"
        data-testid="dock-v3-radar-strong-item">
        <div class="w-2.5 h-2.5 rounded-full shrink-0"
          [class.load-dot-high]="item.entry.load === 'high'"
          [class.load-dot-low]="item.entry.load === 'low'">
        </div>
        <span class="text-xs text-stone-100 font-medium whitespace-nowrap">{{ item.entry.title }}</span>
        @if (item.entry.expectedMinutes) {
          <span class="text-[10px] text-stone-500 font-mono">{{ formatTime(item.entry.expectedMinutes) }}</span>
        }
      </div>
    }

    <!-- 3.2 弱关联区域: 外圈半包围 -->
    @for (item of weakItems(); track item.entry.taskId; let i = $index) {
      <div
        class="radar-item radar-float-weak absolute glass-pill px-3 py-1.5 rounded-full border border-stone-800/50 flex items-center gap-2"
        [class.radar-highlight]="isHighlighted(item.entry.taskId)"
        [class.magnet-slide]="isMagnetSliding(item.entry.taskId)"
        [style.left.px]="item.x"
        [style.top.px]="item.y"
        [style.opacity]="weakOpacity"
        [style.--weak-scale]="weakScale"
        [style.--float-duration]="weakFloatDuration"
        [style.--float-delay]="getWeakFloatDelay(i)"
        (click)="promoteToConsole(item.entry.taskId)"
        (wheel)="onWheel($event, item.entry.taskId)"
        (touchstart)="onTouchStart($event, item.entry.taskId)"
        (touchmove)="onTouchMove($event, item.entry.taskId)"
        (touchend)="onTouchEnd()"
        data-testid="dock-v3-radar-weak-item">
        <div class="w-1.5 h-1.5 rounded-full shrink-0"
          [class.load-dot-high]="item.entry.load === 'high'"
          [class.load-dot-low]="item.entry.load === 'low'">
        </div>
        <span class="text-[10px] text-stone-400 whitespace-nowrap">{{ item.entry.title }}</span>
      </div>
    }
  `,
})
export class DockRadarZoneComponent {
  private readonly engine = inject(DockEngineService);

  readonly strongRadius = PARKING_CONFIG.RADAR_STRONG_RADIUS;
  readonly weakRadius = PARKING_CONFIG.RADAR_WEAK_RADIUS;
  readonly strongOpacity = PARKING_CONFIG.RADAR_STRONG_OPACITY;
  readonly weakOpacity = PARKING_CONFIG.RADAR_WEAK_OPACITY;
  readonly weakScale = PARKING_CONFIG.RADAR_WEAK_SCALE;
  readonly floatDuration = `${PARKING_CONFIG.RADAR_FLOAT_DURATION_S}s`;
  readonly weakFloatDuration = `${PARKING_CONFIG.RADAR_FLOAT_DURATION_S + 0.8}s`;

  private readonly highlightedIds = this.engine.highlightedIds;
  private readonly magnetSlidingIds = new Set<string>();

  private longPressTimer: ReturnType<typeof setTimeout> | null = null;
  private touchActiveTaskId: string | null = null;
  private touchStartY = 0;
  private touchLongPressed = false;

  /**
   * 强关联项位置计算 — 半包围弧度 π/6 → 5π/6（左+上+右，底部不放）
   */
  readonly strongItems = computed(() => {
    const entries = this.engine.strongZoneEntries();
    const startAngle = Math.PI / 6;   // 30°
    const endAngle = 5 * Math.PI / 6; // 150°
    const span = endAngle - startAngle;
    return entries.map((entry, i) => {
      const angle = startAngle + (span / (entries.length + 1)) * (i + 1);
      const x = -Math.cos(angle) * this.strongRadius;
      const y = -Math.sin(angle) * this.strongRadius;
      return { entry, x, y };
    });
  });

  /**
   * 弱关联项位置计算 — 外圈同弧度范围
   */
  readonly weakItems = computed(() => {
    const entries = this.engine.weakZoneEntries();
    const startAngle = Math.PI / 6;
    const endAngle = 5 * Math.PI / 6;
    const span = endAngle - startAngle;
    return entries.map((entry, i) => {
      const angle = startAngle + (span / (entries.length + 1)) * (i + 1);
      const x = -Math.cos(angle) * this.weakRadius;
      const y = -Math.sin(angle) * this.weakRadius;
      return { entry, x, y };
    });
  });

  /** 浮游动画延迟错开 (强关联) */
  getFloatDelay(index: number): string {
    return `${index * 0.45}s`;
  }

  /** 浮游动画延迟错开 (弱关联) */
  getWeakFloatDelay(index: number): string {
    return `${index * 0.55 + 0.2}s`;
  }

  isHighlighted(taskId: string): boolean {
    return this.highlightedIds().has(taskId);
  }

  isMagnetSliding(taskId: string): boolean {
    return this.magnetSlidingIds.has(taskId);
  }

  onWheel(event: WheelEvent, taskId: string): void {
    if (!event.altKey) return;
    event.preventDefault();
    this.engine.toggleLoad(taskId, event.deltaY > 0 ? 'down' : 'up');
  }

  onTouchStart(event: TouchEvent, taskId: string): void {
    this.touchStartY = event.touches[0].clientY;
    this.touchActiveTaskId = taskId;
    this.touchLongPressed = false;
    if (this.longPressTimer) clearTimeout(this.longPressTimer);
    this.longPressTimer = setTimeout(() => {
      this.touchLongPressed = true;
    }, 420);
  }

  onTouchMove(event: TouchEvent, taskId: string): void {
    if (!this.touchLongPressed || this.touchActiveTaskId !== taskId) return;
    const deltaY = event.touches[0].clientY - this.touchStartY;
    if (Math.abs(deltaY) < 28) return;
    this.engine.toggleLoad(taskId, deltaY > 0 ? 'down' : 'up');
    this.touchStartY = event.touches[0].clientY;
  }

  onTouchEnd(): void {
    if (this.longPressTimer) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
    this.touchLongPressed = false;
    this.touchActiveTaskId = null;
  }

  /** 点击雷达项 → 磁力滑入动画 → 推进到控制台 */
  promoteToConsole(taskId: string): void {
    this.magnetSlidingIds.add(taskId);
    setTimeout(() => {
      this.magnetSlidingIds.delete(taskId);
      this.engine.setMainTask(taskId);
    }, PARKING_CONFIG.CONSOLE_MAGNET_PULL_MS);
  }

  formatTime(minutes: number): string {
    if (minutes >= 1440) return `${Math.floor(minutes / 1440)}天`;
    if (minutes < 60) return `${minutes}m`;
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m > 0 ? `${h}h${m}m` : `${h}h`;
  }
}
