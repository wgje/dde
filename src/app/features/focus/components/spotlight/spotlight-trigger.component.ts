/**
 * 聚光灯触发按钮
 * 
 * 放置在任务详情或工具栏中，用于进入聚光灯模式
 */

import { 
  Component, 
  ChangeDetectionStrategy, 
  inject,
  Input,
  computed,
  HostListener
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { SpotlightService } from '../../../../../services/spotlight.service';
import { ProjectStateService } from '../../../../../services/project-state.service';
import { spotlightMode, focusPreferences } from '../../../../../state/focus-stores';
import { Task } from '../../../../../models';

@Component({
  selector: 'app-spotlight-trigger',
  standalone: true,
  imports: [CommonModule],
  template: `
    @if (isEnabled()) {
      <button
        type="button"
        (click)="enterSpotlight()"
        [disabled]="isActive() || !hasTasks()"
        class="relative p-2 rounded-lg transition-all duration-200
               bg-stone-100 dark:bg-stone-800
               hover:bg-stone-200 dark:hover:bg-stone-700
               disabled:opacity-50 disabled:cursor-not-allowed
               focus:outline-none focus:ring-2 focus:ring-amber-500 focus:ring-offset-2
               dark:focus:ring-offset-stone-900"
        [attr.aria-label]="isActive() ? '聚光灯模式已激活' : '进入聚光灯模式'"
        data-testid="spotlight-trigger">
        
        <!-- 聚光灯图标 -->
        <svg class="w-5 h-5" 
             [class]="isActive() ? 'text-amber-500' : 'text-amber-600 dark:text-amber-400'"
             fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" 
                d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/>
        </svg>
        
        <!-- 激活指示器 -->
        @if (isActive()) {
          <span class="absolute -top-1 -right-1 w-2.5 h-2.5 
                       bg-amber-500 rounded-full
                       animate-pulse"
                aria-hidden="true"></span>
        }
      </button>
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class SpotlightTriggerComponent {
  private readonly spotlightService = inject(SpotlightService);
  private readonly projectState = inject(ProjectStateService);

  @Input() task: Task | null = null;
  @Input() queue: Task[] = [];

  // 是否启用聚光灯
  readonly isEnabled = computed(() => focusPreferences().spotlightEnabled);
  
  // 是否已激活
  readonly isActive = computed(() => spotlightMode());

  // 是否有可用任务 - 改为 computed signal 以支持响应式
  readonly hasTasks = computed(() => {
    // 如果有传入的任务
    if (this.task !== null) return true;
    
    // 检查服务中是否有任务
    if (this.spotlightService.hasTasks()) return true;
    
    // 检查当前项目是否有活动任务
    const tasks = this.projectState.tasks();
    return tasks.some(t => t.status === 'active' && !t.deletedAt);
  });

  /**
   * 键盘快捷键：Alt+F 进入聚光灯模式
   */
  @HostListener('document:keydown', ['$event'])
  handleKeydown(event: KeyboardEvent): void {
    // 只在未激活时响应
    if (event.altKey && event.key.toLowerCase() === 'f' && !this.isActive() && this.hasTasks()) {
      event.preventDefault();
      this.enterSpotlight();
    }
  }

  /**
   * 进入聚光灯模式
   */
  enterSpotlight(): void {
    // 如果传入了特定任务
    if (this.task) {
      if (this.queue.length > 0) {
        this.spotlightService.setQueue(this.queue);
      }
      this.spotlightService.enterSpotlight(this.task);
      return;
    }

    // 否则使用服务中的默认任务队列
    this.spotlightService.enter();
  }
}
