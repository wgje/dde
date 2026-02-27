import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DockEngineService } from '../../../../services/dock-engine.service';

/**
 * 碎片阶段日常任务槽 — 当停泊坞所有任务均挂起时显示。
 *
 * 从上方坠入主控台最上层（dropOnTop 弹跳动画），
 * 展示可自定义的日常微任务（吃维生素、喝水等），
 * 每日去重控制，最快结束的等待任务时间实时显示。
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
      background: rgba(28, 25, 23, 0.55);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border: 1px solid rgba(255, 255, 255, 0.08);
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
    }

    /* 从上方坠入动画（弹性弹跳） */
    @keyframes dropOnTop {
      0%   { opacity: 0; transform: translateY(-80px) scale(0.8) rotateX(15deg); }
      40%  { opacity: 0.9; transform: translateY(8px) scale(1.03) rotateX(-3deg); }
      60%  { opacity: 1; transform: translateY(-4px) scale(1.01) rotateX(1deg); }
      80%  { transform: translateY(2px) scale(1) rotateX(0); }
      100% { opacity: 1; transform: translateY(0) scale(1) rotateX(0); }
    }
    .drop-on-top {
      animation: dropOnTop 650ms cubic-bezier(0.16, 1, 0.3, 1);
    }

    /* 每行项目淡入 */
    @keyframes slotItemIn {
      from { opacity: 0; transform: translateX(-12px); }
      to   { opacity: 1; transform: translateX(0); }
    }
    .slot-item {
      animation: slotItemIn 0.25s ease-out both;
    }

    /* 完成闪烁 */
    @keyframes completePulse {
      0%   { background-color: rgba(16, 185, 129, 0.2); }
      100% { background-color: transparent; }
    }
    .complete-flash {
      animation: completePulse 0.4s ease-out;
    }

    /* 倒计时标签呼吸 */
    @keyframes countdownBreathe {
      0%, 100% { opacity: 0.6; }
      50%      { opacity: 1; }
    }
    .countdown-breathe {
      animation: countdownBreathe 2s ease-in-out infinite;
    }

    @media (prefers-reduced-motion: reduce) {
      .drop-on-top, .slot-item, .complete-flash, .countdown-breathe {
        animation: none;
      }
    }
  `],
  template: `
    <div class="glass-card rounded-2xl p-5 max-w-sm drop-on-top" data-testid="dock-v3-daily-slot">

      <!-- 标题栏 -->
      <div class="flex items-center justify-between mb-4">
        <div class="flex items-center gap-2">
          <span class="text-base">⌛</span>
          <div>
            <div class="text-xs text-stone-300 font-semibold">碎片时间 · 日常任务</div>
            @if (soonestWaitLabel()) {
              <div class="text-[10px] text-amber-500/80 font-mono mt-0.5 countdown-breathe">
                {{ soonestWaitLabel() }}
              </div>
            }
          </div>
        </div>
        <button
          type="button"
          (click)="toggleAddForm()"
          class="px-2.5 py-1 text-[10px] text-stone-500 hover:text-stone-300 hover:bg-stone-700/40 rounded-lg transition-colors"
          style="min-height: 44px;">
          + 添加
        </button>
      </div>

      <!-- 新建表单 -->
      @if (showAddForm()) {
        <div class="flex items-center gap-2 mb-4 pb-3 border-b border-stone-700/30">
          <input
            type="text"
            [(ngModel)]="newTitle"
            (keydown.enter)="addSlot()"
            class="flex-1 text-xs py-2 px-2.5 rounded-lg bg-stone-800/80 border border-stone-700 text-stone-200 placeholder:text-stone-500 focus:border-indigo-500 outline-none transition-colors"
            placeholder="日常任务名称…" />
          <input
            type="number"
            [(ngModel)]="newMaxCount"
            min="1"
            max="10"
            class="w-14 text-xs py-2 px-2 rounded-lg bg-stone-800/80 border border-stone-700 text-stone-200 outline-none text-center"
            placeholder="次" />
          <button
            type="button"
            (click)="addSlot()"
            class="px-3 py-2 text-xs rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition-colors"
            style="min-height: 44px;">
            确定
          </button>
        </div>
      }

      <!-- 日常任务列表 -->
      @for (slot of engine.availableDailySlots(); track slot.id; let i = $index) {
        <div
          class="slot-item flex items-center justify-between py-2.5 border-b border-stone-700/30 last:border-b-0"
          [style.animation-delay]="i * 60 + 'ms'">
          <div class="flex flex-col gap-0.5">
            <span class="text-sm text-stone-200">{{ slot.title }}</span>
            <div class="flex items-center gap-1">
              <span class="text-[10px] text-stone-500">{{ slot.todayCompletedCount }}/{{ slot.maxDailyCount }} 次</span>
              <!-- 进度条 -->
              <div class="w-12 h-1 rounded-full bg-stone-800 overflow-hidden">
                <div
                  class="h-full rounded-full bg-emerald-500/60 transition-all"
                  [style.width.%]="(slot.todayCompletedCount / slot.maxDailyCount) * 100">
                </div>
              </div>
            </div>
          </div>
          <div class="flex items-center gap-1.5">
            <button
              type="button"
              (click)="engine.completeDailySlot(slot.id)"
              class="px-3 py-1.5 text-xs rounded-lg bg-stone-700/60 hover:bg-stone-600 text-stone-300 transition-colors"
              style="min-height: 44px;">
              ✓ 完成
            </button>
            <button
              type="button"
              (click)="engine.removeDailySlot(slot.id)"
              class="px-2 py-1.5 text-xs rounded-lg hover:bg-stone-700/60 text-stone-500 hover:text-stone-400 transition-colors"
              style="min-height: 44px;">
              ✕
            </button>
          </div>
        </div>
      }

      <!-- 空态 -->
      @if (engine.availableDailySlots().length === 0 && !showAddForm()) {
        <div class="text-xs text-stone-500 text-center py-6 flex flex-col items-center gap-2">
          <svg class="w-6 h-6 opacity-30" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          暂无日常任务，点击 + 添加
        </div>
      }
    </div>
  `,
})
export class DockDailySlotComponent {
  readonly engine = inject(DockEngineService);
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
}
