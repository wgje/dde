import { ChangeDetectionStrategy, Component, input } from '@angular/core';

import { WorkspaceBootstrapFailureComponent } from './workspace-bootstrap-failure.component';
import type { WorkspaceShellTemplateSurface } from './workspace-shell-template-surface.factory';

/**
 * 会话状态覆盖层：bootstrap 失败全屏卡片 + 右上角"会话检测中"胶囊。
 *
 * 从 workspace-shell.component.html 提取的纯视图子组件；
 * host 使用 display: contents 保持原有 DOM 布局关系不变。
 */
@Component({
  selector: 'app-workspace-session-status-overlays',
  standalone: true,
  imports: [WorkspaceBootstrapFailureComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: 'display: contents' },
  template: `
    @if (template().state.authCoord.bootstrapFailed() && !template().state.authCoord.isCheckingSession()) {
      @defer (on immediate) {
        <app-workspace-bootstrap-failure></app-workspace-bootstrap-failure>
      } @placeholder {
        <div class="fixed inset-0 z-[9999]" style="background-color: var(--theme-bg, #f5f5f4);"></div>
      }
    }

    @if (template().state.authCoord.isCheckingSession() && !template().state.authCoord.bootstrapFailed()) {
      <div class="fixed right-3 top-3 z-30 pointer-events-none">
        <div class="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-white/85 dark:bg-stone-900/85 shadow-sm border border-stone-200/70 dark:border-stone-700/70 backdrop-blur-sm">
          <svg class="animate-spin h-3.5 w-3.5 text-indigo-500" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
          </svg>
          <div class="text-[11px] text-stone-600 dark:text-stone-300">会话检测中...</div>
        </div>
      </div>
    }
  `,
})
export class WorkspaceSessionStatusOverlaysComponent {
  readonly template = input.required<WorkspaceShellTemplateSurface>();
}
