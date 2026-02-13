/**
 * 大门卡片组件
 *
 * 显示当前待处理的遗留条目
 * 极简设计
 */

import {
  Component,
  ChangeDetectionStrategy,
  inject
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { GateService } from '../../../../../services/gate.service';

@Component({
  selector: 'app-gate-card',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="relative w-full aspect-[4/3] min-h-[300px]" data-testid="gate-card">
      <!-- 卡片本体 -->
      <div 
        class="absolute inset-0 bg-white dark:bg-[#1c1c1e] rounded-[32px] shadow-2xl shadow-black/5 dark:shadow-black/40 border border-black/5 dark:border-white/10 flex flex-col overflow-hidden transition-all duration-500 will-change-transform"
        [class.opacity-0]="cardAnimation() === 'sinking'"
        [class.translate-y-8]="cardAnimation() === 'sinking'"
        [class.scale-95]="cardAnimation() === 'sinking'"
        [class.animate-card-enter]="cardAnimation() === 'entering'"
        (animationend)="onAnimationEnd($event)">

        <!-- 顶部进度条 (极简) -->
        <div class="absolute top-0 inset-x-0 h-1 bg-gray-100 dark:bg-white/5 z-20">
           <div class="h-full bg-black dark:bg-white transition-all duration-700 ease-[cubic-bezier(0.25,1,0.5,1)]"
                [style.width.%]="progress().total > 0 ? (progress().current / progress().total) * 100 : 0"></div>
        </div>

        <div class="flex-1 p-8 md:p-12 flex flex-col relative z-10">
          <!-- 计数器 (右上角，极简) -->
          <div class="absolute top-6 right-8 font-medium text-xs text-gray-400 dark:text-gray-500 tracking-wider">
            <span class="text-black dark:text-white">{{ progress().current }}</span>
            <span class="mx-0.5 opacity-50">/</span>
            <span>{{ progress().total }}</span>
          </div>

          <!-- 内容 -->
          @if (currentEntry(); as entry) {
            <div class="flex-1 flex flex-col items-center justify-center">
               <p class="text-2xl md:text-3xl lg:text-4xl font-semibold text-black dark:text-white leading-snug text-center break-words max-w-lg tracking-tight transition-colors duration-500">
                 {{ entry.content }}
               </p>
            </div>

            <!-- 底部元数据 -->
            <div class="mt-8 flex justify-center items-center gap-3 text-xs font-medium text-gray-400 dark:text-gray-500 transition-colors duration-500">
               <span>{{ entry.createdAt | date:'HH:mm' }}</span>
               @if (entry.snoozeCount && entry.snoozeCount > 0) {
                 <span class="px-2 py-0.5 rounded-full bg-gray-100 dark:bg-white/10 text-gray-500 dark:text-gray-300">
                   已推迟 {{ entry.snoozeCount }} 次
                 </span>
               }
            </div>
          }
        </div>
      </div>
      
      <!-- 底部堆叠暗示 (极简) -->
      @if (progress().current < progress().total) {
        <div class="absolute -bottom-4 inset-x-4 h-full bg-white dark:bg-[#1c1c1e] opacity-40 dark:opacity-40 rounded-[32px] z-[-1] scale-[0.96] shadow-lg"></div>
        <div class="absolute -bottom-7 inset-x-8 h-full bg-white dark:bg-[#1c1c1e] opacity-20 dark:opacity-20 rounded-[32px] z-[-2] scale-[0.92] shadow-lg"></div>
      }
    </div>
  `,
  styles: [`
    :host {
      display: block;
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif;
    }

    .animate-card-enter {
      animation: cardEnter 0.6s cubic-bezier(0.2, 0.8, 0.2, 1);
    }
    @keyframes cardEnter {
      from { opacity: 0; transform: translateY(30px) scale(0.95); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class GateCardComponent {
  gateService = inject(GateService);
  
  progress = this.gateService.progress;
  currentEntry = this.gateService.currentEntry;
  cardAnimation = this.gateService.cardAnimation;
  
  /** 转发动画结束事件给 Service */
  onAnimationEnd(event: AnimationEvent) {
    if (event.target !== event.currentTarget) return;

    const anim = this.cardAnimation();
    if (anim === 'entering') {
      this.gateService.onEnteringComplete();
    } else if (anim === 'sinking') {
      this.gateService.onSinkingComplete();
    } else if (anim === 'emerging') {
      this.gateService.onEmergingComplete();
    }
  }
}
