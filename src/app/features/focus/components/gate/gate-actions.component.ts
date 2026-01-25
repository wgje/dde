/**
 * 大门按钮组组件
 * 
 * 已读、完成、稍后提醒按钮
 */

import { 
  Component, 
  ChangeDetectionStrategy, 
  inject,
  computed
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { GateService } from '../../../../../services/gate.service';
import { ToastService } from '../../../../../services/toast.service';

@Component({
  selector: 'app-gate-actions',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="w-full">
      <!-- 三列布局布局 -->
      <div class="grid grid-cols-3 gap-3">
        
        <!-- 稍后提醒 (最左，黄色但柔和) -->
        <button 
          class="group relative px-2 py-4 rounded-2xl font-medium text-xs
                 bg-stone-100 dark:bg-[#2c2c2e] 
                 text-stone-500 dark:text-stone-400
                 hover:bg-orange-50 dark:hover:bg-orange-900/10
                 hover:text-orange-600 dark:hover:text-orange-400
                 active:scale-[0.96] transition-all duration-200
                 flex flex-col items-center justify-center gap-2
                 focus-visible:ring-2 focus-visible:ring-orange-500/30"
          [class.opacity-50]="!canSnooze()"
          [disabled]="!canSnooze() || isProcessing()"
          (click)="snooze()">
          <span class="text-xl group-hover:scale-110 transition-transform duration-200">👀</span>
          <span>稍后</span>
          
          @if (canSnooze()) {
             <span class="absolute top-2 right-2 flex h-2 w-2">
               <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-orange-400 opacity-75"></span>
               <span class="relative inline-flex rounded-full h-2 w-2 bg-orange-500"></span>
             </span>
          }
        </button>

        <!-- 已读 (中间，中性) -->
        <button 
          class="group px-2 py-4 rounded-2xl font-medium text-xs
                 bg-white dark:bg-[#3a3a3c] 
                 border border-stone-200 dark:border-stone-700
                 text-stone-600 dark:text-stone-300
                 hover:bg-stone-50 dark:hover:bg-[#48484a]
                 active:scale-[0.96] transition-all duration-200
                 flex flex-col items-center justify-center gap-2
                 focus-visible:ring-2 focus-visible:ring-stone-400 focus-visible:ring-offset-2"
          [disabled]="isProcessing()"
          (click)="markAsRead()">
          <span class="text-xl group-hover:scale-110 transition-transform duration-200">📖</span>
          <span>已读</span>
        </button>
        
        <!-- 完成 (最右，强调) -->
        <button 
          class="group px-2 py-4 rounded-2xl font-medium text-xs
                 bg-stone-900 dark:bg-[#d1d1d6]
                 text-white dark:text-black
                 hover:shadow-lg hover:shadow-stone-900/20 dark:hover:shadow-white/10
                 active:scale-[0.96] transition-all duration-200
                 flex flex-col items-center justify-center gap-2
                 focus-visible:ring-2 focus-visible:ring-stone-500 focus-visible:ring-offset-2"
          [disabled]="isProcessing()"
          (click)="markAsCompleted()">
          <span class="text-xl group-hover:scale-110 transition-transform duration-200">✅</span>
          <span>完成</span>
        </button>
      </div>
      
      <!-- 额外信息 -->
      @if (canSnooze()) {
        <div class="mt-4 text-center">
            <span class="text-[10px] font-mono text-stone-300 dark:text-stone-500 tracking-wider">
                今日剩余 {{ remainingSnoozes() }} 次推迟机会
            </span>
        </div>
      }
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class GateActionsComponent {
  private gateService = inject(GateService);
  private toast = inject(ToastService);
  
  readonly canSnooze = this.gateService.canSnooze;
  
  // 动画期间禁用按钮
  readonly isProcessing = computed(() => 
    this.gateService.cardAnimation() !== 'idle'
  );
  
  /**
   * 剩余跳过次数
   */
  remainingSnoozes(): number {
    // 默认每日最大 3 次
    const max = 3;
    return Math.max(0, max - this.gateService.snoozeCount());
  }
  
  /**
   * 标记为已读
   */
  markAsRead(): void {
    const result = this.gateService.markAsRead();
    if (result.ok) {
      // 可选：显示反馈
    }
  }
  
  /**
   * 标记为完成
   */
  markAsCompleted(): void {
    const result = this.gateService.markAsCompleted();
    if (result.ok) {
      // 可选：显示反馈
    }
  }
  
  /**
   * 稍后提醒
   */
  snooze(): void {
    const result = this.gateService.snooze();
    if (!result.ok) {
      this.toast.warning('跳过失败', result.error.message);
    }
  }
}
