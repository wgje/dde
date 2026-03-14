import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { PARKING_CONFIG } from '../../../../config/parking.config';
import { DockEngineService } from '../../../../services/dock-engine.service';

/**
 * 碎片阶段日常任务槽 — 当停泊坞所有任务均挂起时显示。
 *
 * 策划案完整复刻：
 * - 从上方坠入主控台最上层（dropOnTop 弹跳动画 + 3D rotateX）
 * - 展示可自定义的日常微任务（吃维生素、喝水、拉伸等）
 * - 每日去重控制（maxDailyCount），进度条实时反馈
 * - 最快结束的等待任务时间实时显示（呼吸动画倒计时标签）
 * - 完成按钮闪烁反馈（completePulse）
 * - 空态插画引导
 */
@Component({
  selector: 'app-dock-daily-slot',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule],
  styles: [`
    :host {
      display: block;
    }

    .glass-card {
      background: linear-gradient(165deg, rgba(22, 28, 36, 0.94), rgba(16, 22, 32, 0.90));
      border: 1px solid rgba(148, 163, 184, 0.08);
      box-shadow: 0 14px 48px rgba(0, 0, 0, 0.55),
                  inset 0 0.5px 0 rgba(255, 255, 255, 0.04);
      /* 不使用 backdrop-filter，避免与专注全屏 blur 叠加 */
      contain: layout style;
    }
    /* 策划案：碑片时间卡片顶部微光条（amber 微光） */
    .glass-card::before {
      content: '';
      position: absolute;
      top: -1px;
      left: 15%;
      right: 15%;
      height: 2px;
      border-radius: 2px;
      background: linear-gradient(90deg, transparent, rgba(245, 158, 11, 0.25), transparent);
      pointer-events: none;
    }

    /* ===== 从上方坠入动画（流畅减速入场） ===== */
    @keyframes dropOnTop {
      0%   { opacity: 0; transform: translateY(calc(-1 * var(--pk-dist-card-fly) / 3)) scale(0.94); }
      50%  { opacity: 0.7; transform: translateY(-2px) scale(0.992); }
      100% { opacity: 1; transform: translateY(0) scale(1); }
    }
    .drop-on-top {
      animation: dropOnTop var(--pk-overlay-enter) var(--pk-ease-enter);
    }

    /* ===== 每行项目淡入 ===== */
    @keyframes slotItemIn {
      0%   { opacity: 0; transform: translateX(-4px) scale(0.985); }
      100% { opacity: 1; transform: translateX(0) scale(1); }
    }
    .slot-item {
      animation: slotItemIn var(--pk-notice-enter) var(--pk-ease-enter) both;
      border-radius: 10px;
      transition: background var(--pk-micro-hover) var(--pk-ease-standard);
      contain: layout paint style;
    }
    .slot-item:hover {
      background: rgba(255, 255, 255, 0.03);
    }

    /* ===== 完成闪烁 + 策划案：“完成绿色浮光” ===== */
    /* GPU 友好：仅使用 opacity + transform 做完成反馈，不动画 box-shadow */
    @keyframes completePulse {
      0%   { background-color: rgba(16, 185, 129, 0.22); transform: scale(1.003); opacity: 1; }
      50%  { background-color: rgba(16, 185, 129, 0.08); transform: scale(1.001); opacity: 1; }
      100% { background-color: transparent; transform: scale(1); opacity: 1; }
    }
    .complete-flash {
      animation: completePulse var(--pk-notice-exit) var(--pk-ease-standard);
    }

    /* ===== 倒计时标签呼吸（已 GPU 友好：仅 opacity） ===== */
    @keyframes countdownBreathe {
      0%, 100% { opacity: 0.6; }
      50%      { opacity: 1; }
    }
    .countdown-breathe {
      animation: countdownBreathe var(--pk-status-ring-pulse) var(--pk-ease-standard) 3;
      /* 移除常驻 will-change — 仅 opacity 的无限循环浏览器自动优化 */
    }

    /* ===== 进度条填充过渡 ===== */
    .progress-fill {
      transition: width var(--pk-notice-enter) var(--pk-ease-standard);
    }

    /* ===== 添加表单淡入 ===== */
    @keyframes formIn {
      0%   { opacity: 0; transform: translateY(-4px) scale(0.992); }
      100% { opacity: 1; transform: translateY(0) scale(1); }
    }
    .form-appear {
      animation: formIn var(--pk-notice-enter) var(--pk-ease-enter);
    }

    @media (prefers-reduced-motion: reduce) {
      .drop-on-top, .slot-item, .complete-flash, .countdown-breathe, .form-appear {
        animation: none;
      }
    }
  `],
  template: `
    <div class="glass-card rounded-2xl p-5 max-w-sm drop-on-top relative" data-testid="dock-v3-daily-slot">

      <!-- 标题栏 -->
      <div class="flex items-center justify-between mb-4">
        <div class="flex items-center gap-2.5">
          <div class="w-8 h-8 rounded-lg bg-amber-500/10 flex items-center justify-center text-base ring-1 ring-amber-500/10">⌛</div>
          <div>
            <div class="text-xs text-slate-300 font-semibold tracking-wide">碎片时间 · 日常任务</div>
              @if (soonestWaitLabel()) {
              <div
                class="text-[10px] text-amber-500/80 font-mono mt-0.5 flex items-center gap-1"
                [class.countdown-breathe]="enableCountdownBreathe">
                <svg class="w-3 h-3 inline-block opacity-60" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                {{ soonestWaitLabel() }}
              </div>
            }
          </div>
        </div>
        <button
          type="button"
          (click)="toggleAddForm()"
          class="px-3 py-2 text-[11px] rounded-lg transition-colors"
          [ngClass]="showAddForm()
            ? 'text-slate-300 bg-slate-700/60 border border-slate-600/50'
            : 'text-slate-500 hover:text-slate-300 hover:bg-slate-700/40 border border-transparent'"
          style="min-height: 44px;">
          {{ showAddForm() ? '✕ 取消' : '+ 添加' }}
        </button>
      </div>

      <!-- 新建表单 -->
      @if (showAddForm()) {
        <div class="form-appear flex items-center gap-2 mb-4 pb-3.5 border-b border-slate-700/25">
          <input
            type="text"
            [(ngModel)]="newTitle"
            (keydown.enter)="addSlot()"
            class="flex-1 text-xs py-2.5 px-3 rounded-lg bg-slate-800/90 border border-slate-700
                   text-slate-200 placeholder:text-slate-500 focus:border-indigo-500/70
                   outline-none transition-colors"
            placeholder="日常任务名称…" />
          <input
            type="number"
            [(ngModel)]="newMaxCount"
            min="1"
            max="10"
            class="w-14 text-xs py-2.5 px-2 rounded-lg bg-slate-800/90 border border-slate-700
                   text-slate-200 outline-none text-center focus:border-indigo-500/70 transition-colors"
            placeholder="次" />
          <button
            type="button"
            (click)="addSlot()"
            class="px-3.5 py-2.5 text-xs rounded-lg bg-indigo-600 hover:bg-indigo-500
                   text-white font-medium transition-colors shadow-lg shadow-indigo-600/20"
            style="min-height: 44px;">
            确定
          </button>
        </div>
      }

      <!-- 日常任务列表 -->
      @for (slot of engine.availableDailySlots(); track slot.id; let i = $index) {
        @let slotDone = doneSlotIds().has(slot.id);
        <div
          class="slot-item flex items-center justify-between py-3 px-2
                 border-b border-slate-700/20 last:border-b-0"
          [style.animation-delay]="i * 65 + 'ms'">
          <div class="flex flex-col gap-1 min-w-0 flex-1">
            <span class="text-sm text-slate-200 truncate">{{ slot.title }}</span>
            <div class="flex items-center gap-2">
              <span class="text-[10px] text-slate-500 font-mono shrink-0">
                {{ slot.todayCompletedCount }}/{{ slot.maxDailyCount }}
              </span>
              <!-- 进度条 -->
              <div class="w-16 h-1.5 rounded-full bg-slate-800 overflow-hidden">
                <div
                  class="h-full rounded-full progress-fill"
                  [ngClass]="slotDone ? 'bg-emerald-400/70' : 'bg-emerald-500/40'"
                  [style.width.%]="(slot.todayCompletedCount / slot.maxDailyCount) * 100">
                </div>
              </div>
              @if (slotDone) {
                <span class="text-[9px] text-emerald-400 font-semibold">已完成</span>
              }
            </div>
          </div>
          <div class="flex items-center gap-1.5 shrink-0 ml-3">
            @if (!slotDone) {
              <button
                type="button"
                (click)="engine.completeDailySlot(slot.id)"
                [attr.aria-label]="'完成日常任务: ' + slot.title"
                class="px-3 py-1.5 text-xs rounded-lg bg-slate-700/60 hover:bg-emerald-600/40
                       text-slate-300 hover:text-emerald-200 transition-colors"
                style="min-height: 44px;">
                ✓
              </button>
            }
            <button
              type="button"
              (click)="engine.removeDailySlot(slot.id)"
              [attr.aria-label]="'移除日常任务: ' + slot.title"
              class="px-2 py-1.5 text-xs rounded-lg hover:bg-slate-700/60
                     text-slate-500 hover:text-slate-400 transition-colors"
              style="min-height: 44px;">
              ✕
            </button>
          </div>
        </div>
      }

      <!-- 空态 -->
      @if (engine.availableDailySlots().length === 0 && !showAddForm()) {
        <div class="text-xs text-slate-500 text-center py-8 flex flex-col items-center gap-3">
          <div class="relative">
            <svg class="w-10 h-10 opacity-15" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
                d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div class="absolute -right-1 -top-1 w-3 h-3 rounded-full bg-amber-500/15 flex items-center justify-center">
              <span class="text-[7px] text-amber-500/60">+</span>
            </div>
          </div>
          <div>
            <div class="text-slate-400 font-medium mb-1">暂无日常任务</div>
            <div class="text-[10px] text-slate-600">点击右上角 + 添加，利用碎片时间完成日常微任务</div>
          </div>
          <!-- 降级兜底（策划案 §7.6）：无日常任务时可新建临时任务 -->
          <button
            type="button"
            (click)="createTempTask()"
            class="mt-2 px-4 py-2 text-[11px] rounded-lg bg-indigo-600/20 hover:bg-indigo-600/40
                   text-indigo-300 hover:text-indigo-200 border border-indigo-500/20 hover:border-indigo-500/40
                   transition-colors font-medium"
            style="min-height: 44px;">
            + 新建临时任务
          </button>
        </div>
      }

      <!-- GAP-5: 碎片时间可选的停泊坞任务 -->
      @if (engine.availableFragmentDockTasks().length > 0) {
        <div class="mt-4 pt-3 border-t border-slate-700/25">
          <div class="text-[10px] text-slate-500 font-semibold tracking-wide mb-2.5 uppercase">
            或选择停泊坞任务
          </div>
          @for (entry of engine.availableFragmentDockTasks().slice(0, 5); track entry.taskId; let j = $index) {
            <button
              type="button"
              (click)="selectDockTask(entry.taskId)"
              class="slot-item w-full flex items-center justify-between py-2.5 px-3 mb-1
                     rounded-lg text-left transition-colors hover:bg-slate-700/40"
              [style.animation-delay]="j * 50 + 'ms'"
              style="min-height: 44px;">
              <div class="flex flex-col gap-0.5 min-w-0 flex-1">
                <span class="text-xs text-slate-300 truncate">{{ entry.title }}</span>
                <div class="flex items-center gap-2">
                  @if (entry.expectedMinutes) {
                    <span class="text-[9px] text-slate-500 font-mono">{{ entry.expectedMinutes }}min</span>
                  }
                  <span class="text-[9px] font-mono"
                    [ngClass]="entry.load === 'low' ? 'text-emerald-500/70' : 'text-amber-500/70'">
                    {{ entry.load === 'low' ? '低负荷' : '高负荷' }}
                  </span>
                </div>
              </div>
              <svg class="w-4 h-4 text-slate-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </button>
          }
        </div>
      }
    </div>
  `,
})
export class DockDailySlotComponent {
  readonly engine = inject(DockEngineService);
  readonly enableCountdownBreathe = PARKING_CONFIG.FOCUS_MOTION_PROFILE !== 'performance';
  readonly showAddForm = signal(false);

  newTitle = '';
  newMaxCount = 1;

  /** 最快结束的挂起任务倒计时标签 */
  readonly soonestWaitLabel = computed(() => {
    const suspended = this.engine.suspendedEntries();
    if (suspended.length === 0) return null;

    let minRemaining = Infinity;
    let label = '';
    for (const entry of suspended) {
      const seconds = this.engine.getWaitRemainingSeconds(entry);
      if (seconds !== null && seconds < minRemaining) {
        minRemaining = seconds;
        label = entry.title;
      }
    }

    if (minRemaining === Infinity) return null;
    const minutes = Math.ceil(minRemaining / 60);
    return `${label} ${minutes}min 后结束`;
  });

  /** 已完成当日次数的 slot id 集合（避免模板中每个 slot 都调用 isSlotDone 方法） */
  readonly doneSlotIds = computed(() => {
    const ids = new Set<string>();
    for (const slot of this.engine.availableDailySlots()) {
      if (slot.todayCompletedCount >= slot.maxDailyCount) {
        ids.add(slot.id);
      }
    }
    return ids;
  });

  /** 判断日常任务槽是否已完成当日次数 */
  isSlotDone(slot: { id?: string; todayCompletedCount: number; maxDailyCount: number }): boolean {
    // 优先使用 computed 缓存（模板路径），兜底用纯值比较（测试/外部调用路径）
    if (slot.id && this.doneSlotIds().has(slot.id)) return true;
    if (slot.id && this.engine.availableDailySlots().some(s => s.id === slot.id)) return false;
    return slot.todayCompletedCount >= slot.maxDailyCount;
  }

  toggleAddForm(): void {
    this.showAddForm.update(value => !value);
  }

  addSlot(): void {
    const title = this.newTitle.trim();
    if (!title) return;
    this.engine.addDailySlot(title, this.newMaxCount || 1);
    this.newTitle = '';
    this.newMaxCount = 1;
    this.showAddForm.set(false);
  }

  /**
   * 降级兜底（策划案 §7.6）：碎片阶段无日常任务时
   * 允许用户新建临时任务直接进入停泊坞
   */
  createTempTask(): void {
    this.engine.createInDock('临时任务', 'combo-select', 'low', {
      expectedMinutes: 5,
    });
  }

  /** GAP-5: 碎片时间选择停泊坞任务，退出碎片阶段并切换到目标任务 */
  selectDockTask(taskId: string): void {
    this.engine.switchToTask(taskId);
  }
}
