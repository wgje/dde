import { ChangeDetectionStrategy, Component, input } from '@angular/core';

import type { WorkspaceShellTemplateSurface } from './workspace-shell-template-surface.factory';

/**
 * 未登录提示覆盖层：用户关闭登录模态框但仍未登录时的主区占位。
 *
 * 从 workspace-shell.component.html 提取的纯视图子组件；
 * host 使用 display: contents 保持在 main 区域内的绝对定位关系。
 */
@Component({
  selector: 'app-workspace-login-required-overlay',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: 'display: contents' },
  template: `
    @if (template().state.derivedUiState.showLoginRequired()) {
      <div class="absolute inset-0 flex items-center justify-center p-4" style="background-color: var(--theme-bg);">
        <div class="max-w-sm w-full text-center space-y-6 animate-fade-in">
          <!-- 图标 -->
          <div class="mx-auto w-20 h-20 bg-indigo-100 rounded-full flex items-center justify-center">
            <svg class="w-10 h-10 text-indigo-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/>
            </svg>
          </div>

          <!-- 标题 -->
          <div>
            <h2 class="text-xl font-bold text-stone-800 dark:text-stone-100 mb-2">请先登录</h2>
            <p class="text-sm text-stone-500 dark:text-stone-400">登录后即可访问您的任务和项目</p>
          </div>

          <!-- 登录按钮 -->
          <button
            (click)="template().interaction.actions.openLoginModal()"
            class="w-full py-3 px-6 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold rounded-xl transition-colors flex items-center justify-center gap-2">
            <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M11 16l-4-4m0 0l4-4m-4 4h14m-5 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h7a3 3 0 013 3v1"/>
            </svg>
            登录账号
          </button>

          <!-- 移动端：打开侧边栏提示 -->
          @if (template().state.isMobile()) {
            <p class="text-xs text-stone-400">
              或者 <button (click)="template().state.isSidebarOpen.set(true)" class="text-indigo-600 hover:underline">打开侧边栏</button> 查看更多选项
            </p>
          }
        </div>
      </div>
    }
  `,
})
export class WorkspaceLoginRequiredOverlayComponent {
  readonly template = input.required<WorkspaceShellTemplateSurface>();
}
