/**
 * 聚光灯视图组件
 * 
 * 极简单任务执行界面
 * 屏幕正中央只显示一件事
 */

import { 
  Component, 
  ChangeDetectionStrategy, 
  inject,
  HostListener
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { SpotlightService } from '../../../../../services/spotlight.service';
import { SpotlightCardComponent } from './spotlight-card.component';

@Component({
  selector: 'app-spotlight-view',
  standalone: true,
  imports: [CommonModule, SpotlightCardComponent],
  template: `
    @if (spotlightService.isActive()) {
      <div class="spotlight-view fixed inset-0 z-[9998]
                  flex items-center justify-center p-4
             bg-white/95 dark:bg-stone-900/95 backdrop-blur-sm"
         data-testid="spotlight-view"
         role="dialog"
         aria-modal="true"
         aria-label="专注模式">
        
        <!-- 顶部栏 -->
        <div class="absolute top-4 left-4 right-4 flex items-center justify-between">
          <!-- 标题 -->
          <div class="flex items-center gap-2 text-sm text-stone-500 dark:text-stone-400">
            <span class="text-lg">🔦</span>
            <span class="font-medium">专注模式</span>
          </div>
          
          <!-- 退出按钮 -->
          <button 
            class="px-3 py-1.5 rounded-lg text-xs font-medium
                   bg-stone-100 dark:bg-stone-800 
                   text-stone-500 dark:text-stone-400
                   hover:bg-stone-200 dark:hover:bg-stone-700
                   transition-colors duration-150"
            (click)="exit()"
            aria-label="退出专注模式">
            退出 <kbd class="ml-1 opacity-50">Esc</kbd>
          </button>
        </div>
        
        <!-- 任务卡片 -->
        @if (currentTask(); as task) {
          <div class="w-full max-w-lg animate-emerge" aria-live="polite">
            <app-spotlight-card
              [task]="task"
              (complete)="complete()"
              (skip)="skip()" />
          </div>
        } @else {
          <!-- 空状态 -->
          <div class="text-center" aria-live="polite">
            <div class="text-6xl mb-4" aria-hidden="true">🎉</div>
            <h2 class="text-xl font-bold text-stone-700 dark:text-stone-200 mb-2">
              太棒了！
            </h2>
            <p class="text-stone-500 dark:text-stone-400">
              所有任务都已完成
            </p>
            <button 
              class="mt-6 px-4 py-2 rounded-lg text-sm font-medium
                     bg-blue-500 text-white hover:bg-blue-600
                     transition-colors duration-150"
              (click)="exit()">
              返回主界面
            </button>
          </div>
        }
        
        <!-- 进度指示器 -->
        <div class="absolute bottom-4 left-1/2 -translate-x-1/2 
                    text-xs text-stone-400 dark:text-stone-500 font-mono">
          已完成 {{ completedCount() }} 项
        </div>
        
        <!-- 键盘快捷键提示 -->
        <div class="absolute bottom-4 right-4 text-xs text-stone-400 dark:text-stone-500
                    flex gap-4">
          <span><kbd class="keyboard-hint">Enter</kbd> 完成</span>
          <span><kbd class="keyboard-hint">→</kbd> 跳过</span>
        </div>
      </div>
    }
  `,
  styles: [`
    .spotlight-view {
      animation: spotlight-enter var(--pk-overlay-enter) var(--pk-ease-enter);
    }
    
    @keyframes spotlight-enter {
      from {
        opacity: 0;
      }
      to {
        opacity: 1;
      }
    }
    
    .animate-emerge {
      animation: emerge var(--pk-panel-enter) var(--pk-ease-enter);
    }
    
    @keyframes emerge {
      from {
        opacity: 0;
        transform: translateY(20px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }
    
    .keyboard-hint {
      @apply inline-block px-1.5 py-0.5 rounded bg-stone-200 dark:bg-stone-700
             text-stone-500 dark:text-stone-400 font-mono text-[10px];
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class SpotlightViewComponent {
  spotlightService = inject(SpotlightService);
  
  readonly currentTask = this.spotlightService.currentTask;
  readonly completedCount = () => this.spotlightService.getCompletedCount();
  
  /**
   * 键盘快捷键
   */
  @HostListener('document:keydown', ['$event'])
  handleKeydown(event: KeyboardEvent): void {
    if (!this.spotlightService.isActive()) return;
    
    if (event.key === 'Escape') {
      event.preventDefault();
      this.exit();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      this.complete();
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      this.skip();
    }
  }
  
  /**
   * 完成当前任务
   */
  complete(): void {
    this.spotlightService.completeCurrentTask();
  }
  
  /**
   * 跳过当前任务
   */
  skip(): void {
    this.spotlightService.skipCurrentTask();
  }
  
  /**
   * 退出聚光灯模式
   */
  exit(): void {
    this.spotlightService.exit();
  }
}
