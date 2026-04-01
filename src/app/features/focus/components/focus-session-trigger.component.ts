/**
 * 专注模式切换按钮
 *
 * 派发 dock-focus-session-toggle 自定义事件，由 DockEngineService 响应。
 */

import {
  Component,
  ChangeDetectionStrategy,
} from '@angular/core';

@Component({
  selector: 'app-focus-session-trigger',
  standalone: true,
  imports: [],
  template: `
    <button
      type="button"
      class="w-full flex items-center gap-2 px-3 py-2 rounded-lg transition-all duration-200
             bg-amber-500/10 dark:bg-amber-400/10
             hover:bg-amber-500/20 dark:hover:bg-amber-400/20
             border border-amber-400/30 dark:border-amber-400/25
             focus:outline-none focus:ring-2 focus:ring-amber-500 focus:ring-offset-2
             dark:focus:ring-offset-stone-900"
      (click)="toggleDockFocusSession()"
      aria-label="切换专注模式"
      data-testid="focus-session-trigger">
      <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"
           class="w-4 h-4 shrink-0 text-amber-500 dark:text-amber-400">
        <path stroke-linecap="round" stroke-linejoin="round"
              d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/>
      </svg>
      <span class="text-xs font-medium text-amber-600 dark:text-amber-400">切换专注模式</span>
    </button>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class FocusSessionTriggerComponent {
  /**
   * 切换专注模式：派发全局自定义事件，由 DockEngineService 监听并处理
   */
  toggleDockFocusSession(): void {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('dock-focus-session-toggle'));
  }
}
