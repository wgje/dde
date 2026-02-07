/**
 * 大门遮罩层组件
 *
 * 全屏遮罩层，阻止用户访问应用其他部分
 * 直到所有遗留条目处理完毕
 */

import {
  Component,
  ChangeDetectionStrategy,
  inject,
  HostListener,
  OnDestroy,
  effect,
  signal
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { GateService } from '../../../../../services/gate.service';
import { StrataService } from '../../../../../services/strata.service';
import { GateCardComponent } from './gate-card.component';
import { GateActionsComponent } from './gate-actions.component';

@Component({
  selector: 'app-gate-overlay',
  standalone: true,
  imports: [CommonModule, GateCardComponent, GateActionsComponent],
  template: `
    @if (gateService.isActive()) {
      <div
        class="gate-overlay fixed inset-0 z-[9999] flex flex-col items-center justify-center p-6 bg-[#F5F2E9]/95 dark:bg-[#1a1a1a]/95 backdrop-blur-2xl transition-all duration-500"
        data-testid="gate-overlay"
        role="dialog"
        aria-modal="true">

        <!-- 极简背景光 -->
        <div class="absolute inset-0 z-[-1] overflow-hidden pointer-events-none opacity-40">
           <div class="absolute top-[20%] left-[50%] -translate-x-1/2 w-[600px] h-[600px] bg-sky-200/20 dark:bg-sky-900/10 rounded-full blur-[120px]"></div>
           <div class="absolute bottom-[10%] right-[20%] w-[400px] h-[400px] bg-orange-100/30 dark:bg-orange-900/10 rounded-full blur-[100px]"></div>
        </div>

        <main class="w-full max-w-lg relative z-10 flex flex-col gap-10 animate-fade-in-up">
          <!-- 头部 -->
          <header class="text-center space-y-3">
            <div class="inline-block px-3 py-1 rounded-full bg-black/5 dark:bg-white/5 text-xs tracking-widest uppercase text-stone-500 dark:text-stone-400 font-medium">
              Focus Gate
            </div>
            <h2 class="text-3xl font-light tracking-tight text-stone-800 dark:text-stone-100 font-sans">
              整理思绪
            </h2>
            <p class="text-stone-500 text-sm dark:text-stone-400 font-light">
              回顾昨日未尽事宜，为新的一天腾出空间
            </p>
          </header>

          <!-- 卡片区域 -->
          <app-gate-card class="block w-full" />

          <!-- 操作区域 -->
          <app-gate-actions class="block w-full" />
        </main>

        <!-- 快捷键提示 -->
        <div class="absolute bottom-10 left-1/2 -translate-x-1/2 flex items-center gap-8 text-[10px] uppercase tracking-wider text-stone-400 dark:text-stone-600 font-medium">
           <span class="flex items-center gap-2">
             <span class="w-5 h-5 flex items-center justify-center rounded bg-stone-200/50 dark:bg-stone-800/50 border border-stone-300/30 dark:border-stone-700/30">1</span>
             <span>已读</span>
           </span>
           <span class="flex items-center gap-2">
             <span class="w-5 h-5 flex items-center justify-center rounded bg-stone-200/50 dark:bg-stone-800/50 border border-stone-300/30 dark:border-stone-700/30">2</span>
             <span>完成</span>
           </span>
           <span class="flex items-center gap-2">
             <span class="w-5 h-5 flex items-center justify-center rounded bg-stone-200/50 dark:bg-stone-800/50 border border-stone-300/30 dark:border-stone-700/30">3</span>
             <span>稍后</span>
           </span>
        </div>
      </div>
    }

    <!-- 完成状态 - 自然淡出 -->
    @if (showCompletionMessage()) {
      <div class="fixed inset-0 z-[9999] bg-[#F5F2E9] dark:bg-[#1a1a1a] flex flex-col items-center justify-center animate-fade-in text-stone-800 dark:text-stone-100">
        <div class="flex flex-col items-center gap-4 animate-scale-in">
          <div class="w-16 h-16 rounded-full border border-stone-200 dark:border-stone-800 flex items-center justify-center text-teal-600 dark:text-teal-400">
            <svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <div class="text-center">
            <h3 class="text-lg font-medium">准备就绪</h3>
            <p class="text-stone-400 text-sm mt-1">开始全神贯注</p>
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    :host {
      display: contents;
    }
    .animate-fade-in-up {
      animation: fadeInUp 0.8s cubic-bezier(0.16, 1, 0.3, 1) forwards;
    }
    .animate-fade-in {
      animation: fadeIn 0.5s ease-out forwards;
    }
    .animate-scale-in {
      animation: scaleIn 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
    }
    @keyframes fadeInUp {
      from { opacity: 0; transform: translateY(20px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    @keyframes scaleIn {
      from { opacity: 0; transform: scale(0.9); }
      to { opacity: 1; transform: scale(1); }
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class GateOverlayComponent {
  gateService = inject(GateService);
  strataService = inject(StrataService);

  showCompletionMessage = signal(false);

  constructor() {
    effect(() => {
      // 监听大门关闭，显示短暂的成功动画
      // 这里简化处理，实际可以通过 Service 状态更精细控制
    });
  }
}
