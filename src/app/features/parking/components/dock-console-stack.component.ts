import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { PARKING_CONFIG } from '../../../../config/parking.config';
import { WAIT_PRESETS, DockEntry } from '../../../../models/parking-dock';
import { DockEngineService } from '../../../../services/dock-engine.service';
import { formatDuration } from '../../../../utils/format-duration';

/**
 * 主控台卡片堆叠 — 停泊坞专注模式的绝对 C 位区域。
 *
 * 实现 Z 轴景深叠放卡片 (Stack)：
 * - 第一张 (focusing) 100% 透明度，scale(1)，显示操作细节
 * - 第二张及后续逐层缩小/降低透明度，只显示标题和预估时间
 *
 * 动画阶段：
 * - flyOut:        完成任务 → 纸张式向上滑出
 * - pushIn:        后方卡片推进到 C 位
 * - sinkDown:      挂起当前任务 → 降透明度+下沉+消失
 * - silentAppear:  挂起任务 → 静悄悄出现在堆叠最后方
 * - cardDraw:      点击后方卡片 → 抽卡到前面
 * - pushBack:      被前方卡片挤到后面
 * - magnetPullIn:  雷达区任务高亮后拉入主控台
 */
@Component({
  selector: 'app-dock-console-stack',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule],
  styles: [`
    :host {
      display: block;
      position: relative;
    }

    /* ===== 3D 景深容器 ===== */
    .stack-perspective {
      perspective: 1000px;
      perspective-origin: center 60%;
    }

    /* ===== 卡片基础过渡 ===== */
    .console-card {
      transition:
        transform 0.5s cubic-bezier(0.16, 1, 0.3, 1),
        opacity 0.5s cubic-bezier(0.16, 1, 0.3, 1),
        box-shadow 0.5s ease;
      transform-style: preserve-3d;
      will-change: transform, opacity;
      backface-visibility: hidden;
    }

    /* ===== 玻璃拟态 ===== */
    .glass-card {
      background: rgba(28, 25, 23, 0.4);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid rgba(255, 255, 255, 0.08);
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
    }
    .glass-card-bg {
      background: rgba(28, 25, 23, 0.65);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      border: 1px solid rgba(255, 255, 255, 0.05);
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.35);
    }

    /* ===== 认知负荷侧边色条 ===== */
    .load-bar {
      position: absolute;
      left: 0;
      top: 32px;
      bottom: 32px;
      width: 6px;
      border-radius: 0 4px 4px 0;
      transition: background-color 0.3s ease, box-shadow 0.3s ease;
    }
    .load-high {
      background-color: #ef4444;
      box-shadow: 0 0 10px rgba(239, 68, 68, 0.55);
    }
    .load-low {
      background-color: #10b981;
      box-shadow: 0 0 10px rgba(16, 185, 129, 0.55);
    }

    /* ===== 动画: 完成任务 → 纸张向上飞出 ===== */
    @keyframes flyOut {
      0%   { opacity: 1; transform: translateY(0) translateZ(0) scale(1); }
      40%  { opacity: 0.7; transform: translateY(-80px) translateZ(20px) scale(0.92) rotate(-2deg); }
      100% { opacity: 0; transform: translateY(-260px) translateZ(60px) scale(0.45) rotate(-5deg); }
    }
    .fly-out {
      animation: flyOut 600ms cubic-bezier(0.4, 0, 0.2, 1) forwards;
      pointer-events: none;
    }

    /* ===== 动画: 后方卡片推进到 C 位 ===== */
    @keyframes pushIn {
      0%   { opacity: 0.4; transform: translateY(-60px) translateZ(-40px) scale(0.85) rotateX(5deg); }
      60%  { opacity: 0.85; transform: translateY(-10px) translateZ(-8px) scale(0.97) rotateX(1deg); }
      100% { opacity: 1; transform: translateY(0) translateZ(0) scale(1) rotateX(0deg); }
    }
    .push-in {
      animation: pushIn 500ms cubic-bezier(0.16, 1, 0.3, 1) forwards;
    }

    /* ===== 动画: 挂起 → 降透明度+下沉+消失 ===== */
    @keyframes sinkDown {
      0%   { opacity: 1; transform: translateY(0) translateZ(0) scale(1); }
      50%  { opacity: 0.35; transform: translateY(24px) translateZ(-20px) scale(0.94); }
      80%  { opacity: 0.1; transform: translateY(36px) translateZ(-35px) scale(0.88); }
      100% { opacity: 0; transform: translateY(48px) translateZ(-50px) scale(0.82); }
    }
    .sink-down {
      animation: sinkDown 500ms cubic-bezier(0.4, 0, 0.2, 1) forwards;
      pointer-events: none;
    }

    /* ===== 动画: 挂起后静悄悄出现在最后方 ===== */
    @keyframes silentAppear {
      0%   { opacity: 0; transform: translateZ(-60px) scale(0.7); }
      100% { opacity: 0.2; transform: translateZ(-40px) scale(0.75); }
    }
    .silent-appear {
      animation: silentAppear 400ms ease-out forwards;
    }

    /* ===== 动画: 点击后方卡片抽卡到前面 ===== */
    @keyframes cardDraw {
      0%   { opacity: 0; transform: translateY(-40px) translateZ(-40px) scale(0.86) rotateX(8deg); }
      30%  { opacity: 0.5; transform: translateY(-20px) translateZ(-15px) scale(0.92) rotateX(4deg); }
      60%  { opacity: 0.8; transform: translateY(-8px) translateZ(-5px) scale(0.97) rotateX(1deg); }
      100% { opacity: 1; transform: translateY(0) translateZ(0) scale(1) rotateX(0deg); }
    }
    .card-draw {
      animation: cardDraw 600ms cubic-bezier(0.16, 1, 0.3, 1) forwards;
    }

    /* ===== 动画: 被前方卡片挤到后面 ===== */
    @keyframes pushBack {
      0%   { opacity: 1; transform: translateY(0) translateZ(0) scale(1) rotateX(0deg); }
      40%  { opacity: 0.6; transform: translateY(-30px) translateZ(-20px) scale(0.92) rotateX(3deg); }
      100% { opacity: 0.4; transform: translateY(-60px) translateZ(-40px) scale(0.85) rotateX(5deg); }
    }
    .push-back {
      animation: pushBack 400ms cubic-bezier(0.4, 0, 0.2, 1) forwards;
    }

    /* ===== 动画: 雷达区磁力拉入主控台 ===== */
    @keyframes magnetPullIn {
      0%   { opacity: 0; transform: translateY(80px) translateZ(-80px) scale(0.5); }
      50%  { opacity: 0.4; transform: translateY(20px) translateZ(-30px) scale(0.78); }
      100% { opacity: 0.4; transform: translateY(-60px) translateZ(-40px) scale(0.85) rotateX(5deg); }
    }
    .magnet-pull-in {
      animation: magnetPullIn 500ms cubic-bezier(0.16, 1, 0.3, 1) forwards;
    }

    /* ===== 动画: 任务细节淡入 ===== */
    @keyframes detailFadeIn {
      from { opacity: 0; transform: translateY(12px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    .detail-fade {
      animation: detailFadeIn 320ms ease-out 200ms both;
    }

    /* ===== C位卡片发光边框 ===== */
    .focus-glow {
      box-shadow:
        0 8px 32px rgba(0, 0, 0, 0.4),
        0 0 0 1px rgba(99, 102, 241, 0.15),
        0 0 40px -10px rgba(99, 102, 241, 0.1);
    }

    /* ===== 等待预设菜单 ===== */
    .wait-menu {
      display: none;
      flex-direction: column;
      gap: 2px;
    }
    .wait-menu.visible {
      display: flex;
    }

    /* ===== 上滑引导指示器 ===== */
    @keyframes swipeHint {
      0%, 100% { opacity: 0.3; transform: translateY(0); }
      50%      { opacity: 0.6; transform: translateY(-6px); }
    }
    .swipe-hint {
      animation: swipeHint 2s ease-in-out infinite;
    }

    /* ===== 无障碍: 减少动画 ===== */
    @media (prefers-reduced-motion: reduce) {
      .console-card { transition: none; }
      .fly-out, .push-in, .sink-down, .silent-appear,
      .card-draw, .push-back, .magnet-pull-in, .detail-fade,
      .swipe-hint {
        animation: none;
      }
    }
  `],
  template: `
    <div class="relative stack-perspective" [style.width.px]="cardWidth" [style.height.px]="cardHeight">

      <!-- 卡片堆叠: 从后到前渲染, focusing 在最前 -->
      @for (entry of stackEntries(); track entry.taskId; let i = $index) {
        @let isFocus = entry.status === 'focusing';
        @let isAnimating = isCardAnimating(entry.taskId);
        <div
          class="console-card absolute inset-0 rounded-3xl flex flex-col justify-between shadow-2xl"
          [ngClass]="{
            'glass-card focus-glow': isFocus,
            'glass-card-bg': !isFocus
          }"
          [class.fly-out]="flyingOutId() === entry.taskId"
          [class.push-in]="pushingInId() === entry.taskId"
          [class.sink-down]="sinkingId() === entry.taskId"
          [class.silent-appear]="silentAppearId() === entry.taskId"
          [class.card-draw]="cardDrawId() === entry.taskId"
          [class.push-back]="pushBackId() === entry.taskId"
          [class.magnet-pull-in]="magnetPullId() === entry.taskId"
          [style.z-index]="getCardZIndex(entry, i)"
          [style.opacity]="isAnimating ? null : getCardOpacity(entry, i)"
          [style.transform]="isAnimating ? null : getCardTransform(entry, i)"
          [style.padding]="isFocus ? '24px' : '20px 24px'"
          (wheel)="onTaskWheel($event, entry.taskId)"
          (click)="!isFocus && !isAnimating ? onCardClick(entry) : null"
          (touchstart)="isFocus ? onSwipeStart($event) : null"
          (touchmove)="isFocus ? onSwipeMove($event) : null"
          (touchend)="isFocus ? onSwipeEnd(entry.taskId) : null"
          (pointerdown)="isFocus ? onPointerDown($event) : null"
          (pointermove)="isFocus ? onPointerMove($event) : null"
          (pointerup)="isFocus ? onPointerUp(entry.taskId) : null"
          (pointercancel)="onPointerCancel()"
          data-testid="dock-v3-console-card">

          <!-- 左侧认知负荷色条 -->
          <div class="load-bar"
            [class.load-high]="entry.load === 'high'"
            [class.load-low]="entry.load === 'low'">
          </div>

          <!-- 卡片头部: 标题 + 预估时间 -->
          <div class="ml-3">
            <h2
              class="font-bold leading-tight"
              [class.text-2xl]="isFocus"
              [class.text-stone-100]="isFocus"
              [class.text-lg]="!isFocus"
              [class.text-stone-300]="!isFocus">
              {{ entry.title }}
            </h2>
            <div class="text-stone-400 text-xs mt-2 font-mono flex items-center gap-2">
              <span>{{ entry.expectedMinutes ? formatTime(entry.expectedMinutes) : '未设置时间' }}</span>
              @if (entry.waitMinutes && !isFocus) {
                <span class="text-amber-500/60">⏳ {{ formatTime(entry.waitMinutes) }}</span>
              }
            </div>
          </div>

          <!-- C位专注卡: 任务操作细节 + 操作按钮 -->
          @if (isFocus) {
            <div class="detail-fade ml-3 mb-2 flex flex-col gap-4 flex-1 min-h-0">

              <!-- 任务详情/文本区域 -->
              <div class="flex-1 text-sm text-stone-300 leading-relaxed border-l-2 border-stone-700 pl-3 overflow-auto hide-scrollbar">
                @if (entry.detail) {
                  {{ entry.detail }}
                } @else {
                  <span class="text-stone-500">这里是任务的操作文本细节...<br /><br />
                  (Alt+Scroll 可切换认知负荷高低)</span>
                }
              </div>

              <!-- 上滑提示 -->
              <div class="swipe-hint flex justify-center -mt-2">
                <svg class="w-4 h-4 text-stone-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 15l7-7 7 7" />
                </svg>
              </div>

              <!-- 底部操作区域 -->
              <div class="flex items-center justify-between pt-4 border-t border-stone-800">
                <!-- 完成按钮 -->
                <button
                  type="button"
                  (click)="onComplete(entry.taskId)"
                  class="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-xl transition-all shadow-lg shadow-indigo-500/20 hover:shadow-indigo-500/30 active:scale-95"
                  style="min-height: 44px;">
                  完成任务
                </button>

                <!-- 右下角: 等待时间触发区 -->
                <div class="flex items-center gap-2 relative" (mouseleave)="closeWaitPresets()">
                  <button
                    type="button"
                    (click)="toggleWaitPresets(entry.taskId)"
                    class="px-3 py-2 rounded-xl bg-stone-800 hover:bg-stone-700 text-stone-400 hover:text-stone-300 transition-colors text-sm"
                    style="min-height: 44px; min-width: 44px;">
                    ⏱ 等待
                  </button>

                  <!-- 等待时间预制菜单（全量 WAIT_PRESETS） -->
                  <div
                    class="wait-menu absolute bottom-full right-0 mb-2 bg-stone-800/95 backdrop-blur-sm p-2 rounded-xl border border-stone-700 shadow-2xl min-w-[120px]"
                    [class.visible]="isWaitPresetVisible(entry.taskId)">
                    @for (preset of waitPresets; track preset.minutes) {
                      <button
                        type="button"
                        (click)="onWait(entry.taskId, preset.minutes)"
                        class="w-full px-3 py-2 hover:bg-stone-700 text-xs text-stone-300 rounded-lg text-left whitespace-nowrap transition-colors"
                        style="min-height: 36px;">
                        {{ preset.label }}
                      </button>
                    }
                  </div>
                </div>
              </div>
            </div>
          }

          <!-- 非C位卡片: 只显示标题+预估时间, 不显示操作细节 -->
        </div>
      }

      <!-- 空态占位 -->
      @if (stackEntries().length === 0) {
        <div class="absolute inset-0 flex flex-col items-center justify-center text-stone-500 text-sm gap-3">
          <svg class="w-8 h-8 opacity-30" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
              d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
          </svg>
          将任务拖入停泊坞开始专注
        </div>
      }
    </div>
  `,
})
export class DockConsoleStackComponent implements OnDestroy {
  readonly engine = inject(DockEngineService);
  readonly cardWidth = PARKING_CONFIG.CONSOLE_CARD_WIDTH;
  readonly cardHeight = PARKING_CONFIG.CONSOLE_CARD_HEIGHT;

  /** 全量等待预制时间档位（5min / 15min / 30min / 1h / 2h / 1天） */
  readonly waitPresets = WAIT_PRESETS;

  // ===== 动画状态 signals =====
  readonly flyingOutId = signal<string | null>(null);
  readonly pushingInId = signal<string | null>(null);
  readonly sinkingId = signal<string | null>(null);
  readonly silentAppearId = signal<string | null>(null);
  readonly cardDrawId = signal<string | null>(null);
  readonly pushBackId = signal<string | null>(null);
  readonly magnetPullId = signal<string | null>(null);
  readonly waitPresetTaskId = signal<string | null>(null);

  /** 所有动画定时器句柄，在 ngOnDestroy 中统一清除 */
  private readonly animTimers: ReturnType<typeof setTimeout>[] = [];

  // ===== 手势追踪 =====
  private touchStartY = 0;
  private swipeActive = false;
  private pointerTracking = false;
  private pointerStartY = 0;
  private pointerDeltaY = 0;
  private pointerId: number | null = null;

  /** 将控制台 entries 排序：focusing 在最前，其余按 dockedOrder */
  readonly stackEntries = computed(() => {
    const entries = this.engine.consoleEntries();
    return [...entries].sort((a, b) => {
      if (a.status === 'focusing') return -1;
      if (b.status === 'focusing') return 1;
      // suspended 排较后
      const aSuspended = a.status === 'suspended_waiting' || a.status === 'wait_finished';
      const bSuspended = b.status === 'suspended_waiting' || b.status === 'wait_finished';
      if (aSuspended && !bSuspended) return 1;
      if (bSuspended && !aSuspended) return -1;
      return a.dockedOrder - b.dockedOrder;
    });
  });

  /** 检查某张卡片是否正在播放动画（动画期间不覆盖 CSS transform/opacity） */
  isCardAnimating(taskId: string): boolean {
    return (
      this.flyingOutId() === taskId ||
      this.pushingInId() === taskId ||
      this.sinkingId() === taskId ||
      this.silentAppearId() === taskId ||
      this.cardDrawId() === taskId ||
      this.pushBackId() === taskId ||
      this.magnetPullId() === taskId
    );
  }

  ngOnDestroy(): void {
    for (const timer of this.animTimers) clearTimeout(timer);
    this.animTimers.length = 0;
  }

  /** 包装 setTimeout，自动追踪句柄以便在 ngOnDestroy 中清除；回调完成后自动移除句柄 */
  private after(ms: number, fn: () => void): void {
    let handle: ReturnType<typeof setTimeout>;
    handle = setTimeout(() => {
      fn();
      const idx = this.animTimers.indexOf(handle);
      if (idx !== -1) this.animTimers.splice(idx, 1);
    }, ms);
    this.animTimers.push(handle);
  }

  /**
   * Z 轴景深卡片变换：
   * - C 位 (focusing): 原位，无 Z 偏移
   * - 第二层: translateY(-60px) translateZ(-40px) scale(0.85) rotateX(5deg)
   * - 更深层: 递减 scale 和 Z 偏移
   */
  getCardTransform(entry: DockEntry, index: number): string {
    if (entry.status === 'focusing') {
      return 'translateY(0) translateZ(0) scale(1) rotateX(0deg)';
    }
    const depth = Math.max(index, 1);
    const yOffset = PARKING_CONFIG.CONSOLE_STACK_Y_OFFSET * depth;
    const zOffset = -40 * depth;
    const scale = Math.max(PARKING_CONFIG.CONSOLE_STACK_SCALE - (depth - 1) * 0.05, 0.65);
    const rotateX = Math.min(5 + (depth - 1) * 2, 12);
    return `translateY(${yOffset}px) translateZ(${zOffset}px) scale(${scale}) rotateX(${rotateX}deg)`;
  }

  /** 透明度递减：C 位 = 1, 第二层 = 0.4, 更深层递减 -0.1, 最低 0.15 */
  getCardOpacity(entry: DockEntry, index: number): number {
    if (entry.status === 'focusing') return 1;
    const depth = Math.max(index, 1);
    return Math.max(PARKING_CONFIG.CONSOLE_STACK_BG_OPACITY - (depth - 1) * 0.1, 0.15);
  }

  /** Z-index: C位=50, 后续递减 */
  getCardZIndex(entry: DockEntry, index: number): number {
    if (entry.status === 'focusing') return 50;
    return Math.max(40 - index * 2, 5);
  }

  // ===== 完成任务: flyOut → completeTask → pushIn =====
  onComplete(taskId: string): void {
    this.closeWaitPresets();
    this.flyingOutId.set(taskId);
    this.after(PARKING_CONFIG.CONSOLE_FLY_OUT_MS, () => {
      this.flyingOutId.set(null);
      this.engine.completeTask(taskId);
      const next = this.engine.focusingEntry();
      if (next) {
        this.pushingInId.set(next.taskId);
        this.after(PARKING_CONFIG.CONSOLE_PUSH_IN_MS, () => this.pushingInId.set(null));
      }
    });
  }

  // ===== 挂起等待: sinkDown → suspendTask → silentAppear + pushIn =====
  onWait(taskId: string, minutes: number): void {
    this.closeWaitPresets();
    this.sinkingId.set(taskId);
    this.after(PARKING_CONFIG.CONSOLE_SINK_MS, () => {
      this.sinkingId.set(null);
      this.engine.suspendTask(taskId, minutes);

      // 挂起的任务静悄悄出现在最后方
      this.silentAppearId.set(taskId);
      this.after(PARKING_CONFIG.CONSOLE_SILENT_APPEAR_MS, () => this.silentAppearId.set(null));

      // 新 focusing 任务推进 C 位
      const next = this.engine.focusingEntry();
      if (next) {
        this.pushingInId.set(next.taskId);
        this.after(PARKING_CONFIG.CONSOLE_PUSH_IN_MS, () => this.pushingInId.set(null));
      }
    });
  }

  // ===== 点击后方卡片: cardDraw 抽卡到前面, 当前 C 位 pushBack =====
  onCardClick(entry: DockEntry): void {
    // 当前 focusing 任务被推到后方
    const currentFocus = this.engine.focusingEntry();
    if (currentFocus) {
      this.pushBackId.set(currentFocus.taskId);
      this.after(PARKING_CONFIG.CONSOLE_PUSH_BACK_MS, () => this.pushBackId.set(null));
    }

    // 被点击的卡片抽卡到前面
    this.cardDrawId.set(entry.taskId);
    this.engine.switchToTask(entry.taskId);
    this.after(PARKING_CONFIG.CONSOLE_DRAW_MS, () => this.cardDrawId.set(null));
  }

  // ===== Alt+Scroll 切换认知负荷 =====
  onTaskWheel(event: WheelEvent, taskId: string): void {
    if (!event.altKey) return;
    event.preventDefault();
    this.engine.toggleLoad(taskId, event.deltaY > 0 ? 'down' : 'up');
  }

  // ===== 触控上滑完成手势 =====
  onSwipeStart(event: TouchEvent): void {
    this.touchStartY = event.touches[0].clientY;
    this.swipeActive = false;
  }

  onSwipeMove(event: TouchEvent): void {
    const delta = this.touchStartY - event.touches[0].clientY;
    if (delta > 60) this.swipeActive = true;
  }

  onSwipeEnd(taskId: string): void {
    if (this.swipeActive) this.onComplete(taskId);
    this.swipeActive = false;
  }

  // ===== 指针上滑完成手势 (鼠标/笔) =====
  onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    this.pointerTracking = true;
    this.pointerStartY = event.clientY;
    this.pointerDeltaY = 0;
    this.pointerId = event.pointerId;
  }

  onPointerMove(event: PointerEvent): void {
    if (!this.pointerTracking || this.pointerId !== event.pointerId) return;
    this.pointerDeltaY = this.pointerStartY - event.clientY;
  }

  onPointerUp(taskId: string): void {
    if (!this.pointerTracking) return;
    if (this.pointerDeltaY > 70) {
      this.onComplete(taskId);
    }
    this.onPointerCancel();
  }

  onPointerCancel(): void {
    this.pointerTracking = false;
    this.pointerDeltaY = 0;
    this.pointerStartY = 0;
    this.pointerId = null;
  }

  // ===== 等待预设菜单 =====
  toggleWaitPresets(taskId: string): void {
    this.waitPresetTaskId.update(current => (current === taskId ? null : taskId));
  }

  closeWaitPresets(): void {
    this.waitPresetTaskId.set(null);
  }

  isWaitPresetVisible(taskId: string): boolean {
    return this.waitPresetTaskId() === taskId;
  }

  formatTime(minutes: number): string {
    return formatDuration(minutes);
  }
}
