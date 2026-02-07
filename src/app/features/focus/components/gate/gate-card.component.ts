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
        class="absolute inset-0 bg-white dark:bg-[#222] rounded-3xl shadow-xl shadow-stone-200/50 dark:shadow-black/50 border border-stone-100 dark:border-stone-800 flex flex-col overflow-hidden transition-all duration-500"
        [class.opacity-0]="cardAnimation() === 'sinking'"
        [class.translate-y-4]="cardAnimation() === 'sinking'"
        [class.scale-95]="cardAnimation() === 'sinking'"
        [class.animate-card-enter]="cardAnimation() === 'entering'"
        (animationend)="onAnimationEnd($event)">

        <!-- 顶部进度条 (极简) -->
        <div class="h-1 w-full bg-stone-100 dark:bg-stone-800">
           <div class="h-full bg-stone-800 dark:bg-stone-200 transition-all duration-500 ease-out"
                [style.width.%]="progress().total > 0 ? (progress().current / progress().total) * 100 : 0"></div>
        </div>

        <div class="flex-1 p-8 md:p-10 flex flex-col relative">
          <!-- 计数器 -->
          <div class="absolute top-8 right-10 font-mono text-xs text-stone-400">
            <span class="text-stone-800 dark:text-stone-200 font-bold">{{ progress().current }}</span>
            <span class="mx-1">/</span>
            <span>{{ progress().total }}</span>
          </div>

          <!-- 内容 -->
          @if (currentEntry(); as entry) {
            <div class="flex-1 flex items-center justify-center">
               <p class="text-2xl md:text-3xl font-medium text-stone-800 dark:text-stone-100 leading-normal text-center break-words max-w-lg font-serif">
                 {{ entry.content }}
               </p>
            </div>

            <div class="mt-8 flex justify-center items-center gap-4 text-xs font-mono text-stone-400">
               <span>{{ entry.createdAt | date:'HH:mm' }}</span>
               @if (entry.snoozeCount && entry.snoozeCount > 0) {
                 <span class="px-2 py-0.5 rounded-full bg-stone-100 dark:bg-stone-800 text-stone-500 dark:text-stone-400">
                   已推迟 {{ entry.snoozeCount }} 次
                 </span>
               }
            </div>
          }
        </div>
      </div>
      
      <!-- 底部堆叠暗示 -->
      @if (progress().current < progress().total) {
        <div class="absolute -bottom-2 md:-bottom-3 inset-x-4 h-full bg-white/50 dark:bg-[#222]/50 rounded-3xl z-[-1] border border-stone-100/50 dark:border-stone-800/10"></div>
      }
    </div>
  `,
  styles: [`
    .animate-card-enter {
      animation: cardEnter 0.5s cubic-bezier(0.2, 0.8, 0.2, 1);
    }
    @keyframes cardEnter {
      from { opacity: 0; transform: translateY(20px) scale(0.98); }
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
