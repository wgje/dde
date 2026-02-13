/**
 * 大门遮罩层组件
 *
 * 全屏遮罩层，阻止用户访问应用其他部分
 * 直到所有遗留条目处理完毕
 * 底部显示地质层（已完成任务堆叠预览）
 */

import {
  Component,
  ChangeDetectionStrategy,
  inject,
  HostListener,
  OnDestroy,
  computed,
  effect,
  signal
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { GateService } from '../../../../../services/gate.service';
import { StrataService } from '../../../../../services/strata.service';
import { GateCardComponent } from './gate-card.component';
import { GateActionsComponent } from './gate-actions.component';

type GateVisualTheme = 'stone' | 'paper';

const GATE_VISUAL_THEME_KEY = 'focus_gate_visual_theme';

@Component({
  selector: 'app-gate-overlay',
  standalone: true,
  imports: [CommonModule, GateCardComponent, GateActionsComponent],
  template: `
    <!-- 审查中状态 -->
    @if (gateService.isActive()) {
      <div
        class="gate-overlay fixed inset-0 z-[9999] flex flex-col items-center justify-center overflow-hidden bg-white/80 dark:bg-black/80 backdrop-blur-2xl transition-all duration-500"
        [class.dark]="visualTheme() === 'stone'"
        data-testid="gate-overlay"
        role="dialog"
        aria-modal="true"
        aria-labelledby="gate-title"
        aria-describedby="gate-description"
        tabindex="-1">

        <!-- 极简背景 -->
        <div class="absolute inset-0 pointer-events-none overflow-hidden">
          <!-- 顶部柔光 -->
          <div class="absolute -top-[20%] left-1/2 -translate-x-1/2 w-[80%] h-[60%] rounded-full bg-blue-500/10 blur-[120px] dark:bg-blue-400/5 transition-colors duration-500"></div>
          <!-- 底部柔光 -->
          <div class="absolute -bottom-[20%] left-1/2 -translate-x-1/2 w-[80%] h-[60%] rounded-full bg-indigo-500/10 blur-[120px] dark:bg-indigo-400/5 transition-colors duration-500"></div>
        </div>

        <!-- 底部堆叠预览 (简化版) -->
        <div class="absolute bottom-0 left-0 right-0 pointer-events-none flex flex-col items-center justify-end h-[30vh] overflow-hidden pb-8">
          @for (layer of strataLayers(); track layer.date; let i = $index) {
            @if (i < 5) {
              <div
                class="absolute bottom-0 transition-all duration-500 ease-[cubic-bezier(0.25,1,0.5,1)]"
                [style.transform]="'translateY(' + (40 + i * 12) + 'px) scale(' + (0.95 - i * 0.05) + ')'"
                [style.z-index]="10 - i"
                [style.opacity]="0.6 - i * 0.1">
                
                <div class="w-[300px] sm:w-[500px] h-16 rounded-t-2xl bg-white dark:bg-[#1c1c1e] shadow-[0_-4px_20px_rgba(0,0,0,0.05)] border-t border-x border-black/5 dark:border-white/10 flex items-center justify-center transition-colors duration-500">
                  <span class="text-xs font-medium text-black/40 dark:text-white/40 tracking-wide uppercase">{{ layer.date }}</span>
                </div>
              </div>
            }
          }
        </div>

        <!-- 主内容区域 -->
        <section class="relative z-10 w-full max-w-xl px-6 flex flex-col items-center animate-gate-enter">
          
          <!-- 标题区 -->
          <header class="text-center mb-10 flex flex-col items-center gap-6">
            <!-- 主题切换 (iOS 分段控件风格) -->
            <div class="p-1 rounded-full bg-gray-100 dark:bg-white/10 flex items-center shadow-inner transition-colors duration-500">
              <button 
                type="button"
                (click)="setTheme('paper')"
                class="px-4 py-1.5 rounded-full text-xs font-medium transition-all duration-300"
                [class.bg-white]="visualTheme() === 'paper'"
                [class.shadow-sm]="visualTheme() === 'paper'"
                [class.text-black]="visualTheme() === 'paper'"
                [class.text-gray-500]="visualTheme() !== 'paper'">
                Light
              </button>
              <button 
                type="button"
                (click)="setTheme('stone')"
                class="px-4 py-1.5 rounded-full text-xs font-medium transition-all duration-300"
                [class.bg-gray-600]="visualTheme() === 'stone'"
                [class.shadow-sm]="visualTheme() === 'stone'"
                [class.text-white]="visualTheme() === 'stone'"
                [class.text-gray-400]="visualTheme() !== 'stone'">
                Dark
              </button>
            </div>

            <div>
              <h2 id="gate-title" class="text-3xl font-semibold text-black dark:text-white tracking-tight transition-colors duration-500">每日清算</h2>
              <p class="mt-2 text-base text-black/60 dark:text-white/60 transition-colors duration-500">回顾昨日，开启新的一天。</p>
            </div>
          </header>

          <!-- 卡片容器 -->
          <div class="w-full mb-10 perspective-1000">
            <app-gate-card class="block w-full" />
          </div>

          <!-- 操作区 -->
          <div class="w-full">
            <app-gate-actions class="block w-full" />
          </div>

        </section>

        <!-- 快捷键提示 (胶囊样式) -->
        <div class="absolute bottom-8 left-1/2 -translate-x-1/2 hidden md:flex items-center gap-1.5 px-4 py-2 rounded-full bg-white/40 dark:bg-white/5 backdrop-blur-xl border border-white/20 dark:border-white/5 shadow-sm transition-colors duration-500">
          <span class="text-[11px] font-medium text-black/50 dark:text-white/50 flex items-center gap-1.5">
            <kbd class="font-sans min-w-[1.4em] h-[1.4em] flex items-center justify-center bg-white dark:bg-white/10 rounded-[4px] shadow-sm border border-black/5 dark:border-white/5">1</kbd> 已读
          </span>
          <span class="w-px h-3 bg-black/10 dark:bg-white/10 mx-2"></span>
          <span class="text-[11px] font-medium text-black/50 dark:text-white/50 flex items-center gap-1.5">
            <kbd class="font-sans min-w-[1.4em] h-[1.4em] flex items-center justify-center bg-white dark:bg-white/10 rounded-[4px] shadow-sm border border-black/5 dark:border-white/5">2</kbd> 完成
          </span>
           <span class="w-px h-3 bg-black/10 dark:bg-white/10 mx-2"></span>
           <span class="text-[11px] font-medium text-black/50 dark:text-white/50 flex items-center gap-1.5">
            <kbd class="font-sans min-w-[1.4em] h-[1.4em] flex items-center justify-center bg-white dark:bg-white/10 rounded-[4px] shadow-sm border border-black/5 dark:border-white/5">3</kbd> 稍后
          </span>
        </div>
      </div>
    }

    <!-- 完成状态 (iOS 风格弹窗) -->
    @if (showCompletionMessage()) {
      <div
        class="gate-completion fixed inset-0 z-[9999] flex items-center justify-center p-6 bg-black/20 dark:bg-black/60 backdrop-blur-xl transition-all duration-500"
        role="status"
        aria-live="polite">

        <div class="bg-white dark:bg-[#1c1c1e] rounded-[2rem] p-12 shadow-2xl flex flex-col items-center justify-center text-center max-w-sm w-full animate-pop-in border border-black/5 dark:border-white/10">
          <div class="w-20 h-20 rounded-full bg-green-500 flex items-center justify-center mb-6 shadow-lg shadow-green-500/30 scale-100">
            <svg class="w-10 h-10 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h3 class="text-2xl font-semibold text-black dark:text-white mb-2 tracking-tight">全部完成</h3>
          <p class="text-base text-gray-500 dark:text-gray-400">准备好开始新的一天了嗎？</p>
        </div>
      </div>
    }
  `,
  styles: [`
    :host {
      display: block;
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif;
    }
    
    .animate-gate-enter {
      animation: gateEnter 0.8s cubic-bezier(0.16, 1, 0.3, 1) forwards;
    }

    .animate-pop-in {
      animation: popIn 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
    }

    @keyframes gateEnter {
      from { opacity: 0; transform: scale(0.98) translateY(20px); }
      to { opacity: 1; transform: scale(1) translateY(0); }
    }

    @keyframes popIn {
      from { opacity: 0; transform: scale(0.8); }
      to { opacity: 1; transform: scale(1); }
    }

    .perspective-1000 {
      perspective: 1000px;
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class GateOverlayComponent implements OnDestroy {
  gateService = inject(GateService);
  private strataService = inject(StrataService);

  // 获取地质层数据
  readonly strataLayers = computed(() => this.strataService.layers());
  readonly visualTheme = signal<GateVisualTheme>(this.readTheme());

  constructor() {
    // 响应式追踪 gate 激活状态，动态管理 body 滚动锁定
    effect(() => {
      if (this.gateService.isActive()) {
        document.body.style.overflow = 'hidden';
      } else {
        document.body.style.overflow = '';
      }
    });
  }

  setTheme(theme: GateVisualTheme): void {
    this.visualTheme.set(theme);

    try {
      localStorage.setItem(GATE_VISUAL_THEME_KEY, theme);
    } catch {
      // ignore localStorage failures
    }
  }

  private readTheme(): GateVisualTheme {
    try {
      const stored = localStorage.getItem(GATE_VISUAL_THEME_KEY);
      return stored === 'paper' ? 'paper' : 'stone';
    } catch {
      return 'stone';
    }
  }

  /**
   * 键盘快捷键
   * 1: 已读, 2: 完成, 3: 稍后
   */
  @HostListener('document:keydown', ['$event'])
  handleKeydown(event: KeyboardEvent): void {
    if (!this.gateService.isActive()) return;

    // 忽略带修饰键的情况
    if (event.ctrlKey || event.metaKey || event.altKey) return;

    // 忽略用户在输入框中的按键
    const target = event.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;

    switch (event.key) {
      case '1':
        event.preventDefault();
        this.gateService.markAsRead();
        break;
      case '2':
        event.preventDefault();
        this.gateService.markAsCompleted();
        break;
      case '3':
        event.preventDefault();
        if (this.gateService.canSnooze()) {
          this.gateService.snooze();
        }
        break;
    }
  }

  // 是否显示完成提示
  readonly showCompletionMessage = this.gateService.showCompletionMessage;

  ngOnDestroy(): void {
    document.body.style.overflow = '';
  }
}
