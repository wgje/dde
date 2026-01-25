/**
 * 黑匣子触发按钮
 * 
 * 放置在工具栏中，用于打开黑匣子面板
 */

import { 
  Component, 
  ChangeDetectionStrategy, 
  inject,
  computed,
  HostListener
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { showBlackBoxPanel, pendingBlackBoxEntries, focusPreferences } from '../../../../core/state/focus-stores';
import { FOCUS_CONFIG } from '../../../../../config/focus.config';

@Component({
  selector: 'app-black-box-trigger',
  standalone: true,
  imports: [CommonModule],
  template: `
    @if (isEnabled()) {
      <button
        type="button"
        (click)="togglePanel()"
        [class.recording-pulse]="false"
        class="relative p-2 rounded-lg transition-all duration-200
               bg-stone-100 dark:bg-stone-800
               hover:bg-stone-200 dark:hover:bg-stone-700
               focus:outline-none focus:ring-2 focus:ring-amber-500 focus:ring-offset-2
               dark:focus:ring-offset-stone-900"
        [attr.aria-label]="'黑匣子' + (pendingCount() > 0 ? '（' + pendingCount() + ' 个待处理）' : '')"
        [attr.aria-expanded]="isOpen()"
        data-testid="black-box-trigger">
        
        <!-- 图标 -->
        <svg class="w-5 h-5 text-amber-600 dark:text-amber-400" 
             fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" 
                d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"/>
        </svg>

        <!-- 待处理数量徽标 -->
        @if (pendingCount() > 0) {
          <span class="absolute -top-1 -right-1 flex items-center justify-center
                       min-w-[18px] h-[18px] px-1
                       text-[10px] font-bold text-white
                       bg-red-500 rounded-full
                       animate-pulse"
                aria-hidden="true">
            {{ pendingCount() > 99 ? '99+' : pendingCount() }}
          </span>
        }
      </button>
    }
  `,
  styles: [`
    .recording-pulse {
      animation: pulse 1.5s ease-in-out infinite;
    }
    
    @keyframes pulse {
      0%, 100% {
        box-shadow: 0 0 0 0 rgba(245, 158, 11, 0.4);
      }
      50% {
        box-shadow: 0 0 0 8px rgba(245, 158, 11, 0);
      }
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class BlackBoxTriggerComponent {
  
  // 是否启用黑匣子
  readonly isEnabled = computed(() => focusPreferences().blackBoxEnabled);
  
  // 面板是否打开
  readonly isOpen = computed(() => showBlackBoxPanel());
  
  // 待处理条目数量
  readonly pendingCount = computed(() => pendingBlackBoxEntries().length);

  /**
   * 键盘快捷键：Alt+B 打开/关闭黑匣子
   */
  @HostListener('document:keydown', ['$event'])
  handleKeydown(event: KeyboardEvent): void {
    if (event.altKey && event.key.toLowerCase() === 'b') {
      event.preventDefault();
      this.togglePanel();
    }
  }

  /**
   * 切换面板显示状态
   */
  togglePanel(): void {
    showBlackBoxPanel.update((v: boolean) => !v);
  }
}
