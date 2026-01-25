/**
 * 聚光灯任务卡片组件
 * 
 * 显示当前聚焦的任务
 */

import { 
  Component, 
  ChangeDetectionStrategy, 
  Input,
  Output,
  EventEmitter
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { Task } from '../../../../../models';

@Component({
  selector: 'app-spotlight-card',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="spotlight-card bg-white dark:bg-stone-800 
                rounded-2xl shadow-2xl overflow-hidden
           border border-stone-200/50 dark:border-stone-700/50"
          data-testid="spotlight-card">
      
      <!-- 任务标题 -->
      <div class="p-6 pb-4">
        <h2 class="text-xl font-bold text-stone-800 dark:text-stone-100
                   leading-relaxed"
            data-testid="spotlight-card-title">
          {{ task.title }}
        </h2>
        
        <!-- 来源标签 -->
        @if (isFromBlackBox()) {
          <div class="mt-2 inline-block px-2 py-0.5 rounded-full text-xs
                      bg-amber-100 dark:bg-amber-900/30 
                      text-amber-600 dark:text-amber-400">
            📦 来自黑匣子
          </div>
        }
      </div>
      
      <!-- 任务详情 -->
      @if (task.content) {
        <div class="px-6 pb-4">
          <div class="p-4 bg-stone-50 dark:bg-stone-700/50 rounded-xl
                      text-sm text-stone-600 dark:text-stone-300
                      leading-relaxed whitespace-pre-wrap max-h-48 overflow-y-auto">
            {{ task.content }}
          </div>
        </div>
      }
      
      <!-- 操作按钮 -->
      <div class="p-4 bg-stone-50/50 dark:bg-stone-900/30 
                  border-t border-stone-200/50 dark:border-stone-700/50
                  flex gap-3">
        
        <!-- 跳过按钮 -->
        <button 
          class="flex-1 px-4 py-3 rounded-xl font-medium text-sm
                 bg-stone-100 dark:bg-stone-700 
                 text-stone-500 dark:text-stone-400
                 hover:bg-stone-200 dark:hover:bg-stone-600
                 active:scale-[0.98] transition-all duration-150
                 flex items-center justify-center gap-2"
          (click)="onSkip()"
          data-testid="spotlight-skip"
          aria-label="跳过此任务">
          <span>⏭️</span>
          <span>稍后</span>
        </button>
        
        <!-- 完成按钮 -->
        <button 
          class="flex-[2] px-4 py-3 rounded-xl font-medium text-sm
                 bg-green-500 text-white
                 hover:bg-green-600
                 active:scale-[0.98] transition-all duration-150
                 shadow-lg shadow-green-500/20
                 flex items-center justify-center gap-2"
          (click)="onComplete()"
          data-testid="spotlight-complete"
          aria-label="完成此任务">
          <span>✅</span>
          <span>完成</span>
        </button>
      </div>
    </div>
  `,
  styles: [`
    .spotlight-card {
      box-shadow: 
        0 25px 50px -12px rgba(0, 0, 0, 0.15),
        0 0 0 1px rgba(0, 0, 0, 0.05);
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class SpotlightCardComponent {
  @Input({ required: true }) task!: Task;
  
  @Output() complete = new EventEmitter<void>();
  @Output() skip = new EventEmitter<void>();
  
  /**
   * 检查是否来自黑匣子
   */
  isFromBlackBox(): boolean {
    return this.task.tags?.includes('black-box') ?? false;
  }
  
  onComplete(): void {
    this.complete.emit();
  }
  
  onSkip(): void {
    this.skip.emit();
  }
}
