import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { AppAuthCoordinatorService } from '../services/app-auth-coordinator.service';

@Component({
  selector: 'app-workspace-bootstrap-failure',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      data-testid="workspace-bootstrap-failure"
      class="fixed inset-0 z-[9999] flex items-center justify-center"
      style="background-color: var(--theme-bg, #f5f5f4);">
      <div class="max-w-md mx-4 p-8 bg-white dark:bg-stone-900 rounded-2xl shadow-2xl border border-red-100 dark:border-red-900 text-center space-y-6">
        <div class="mx-auto w-16 h-16 bg-red-100 dark:bg-red-900/50 rounded-full flex items-center justify-center">
          <svg class="w-8 h-8 text-red-500 dark:text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
          </svg>
        </div>

        <h1 class="text-2xl font-bold text-stone-800 dark:text-stone-100">启动失败</h1>

        <div class="space-y-2">
          <p class="text-stone-600 dark:text-stone-300">应用初始化时遇到问题，无法建立会话连接。</p>
          @if (authCoord.bootstrapErrorMessage()) {
            <div class="mt-3 p-3 bg-red-50 dark:bg-red-900/30 rounded-lg text-left">
              <p class="text-xs text-red-600 dark:text-red-400 font-mono break-all">{{ authCoord.bootstrapErrorMessage() }}</p>
            </div>
          }
        </div>

        <div class="text-left text-sm text-stone-500 dark:text-stone-400 space-y-1 bg-stone-50 dark:bg-stone-800 p-4 rounded-lg">
          <p class="font-medium text-stone-600 dark:text-stone-300 mb-2">可能的原因：</p>
          <ul class="list-disc list-inside space-y-1">
            <li>网络连接中断或不稳定</li>
            <li>本地登录凭证已损坏</li>
            <li>服务端 API 暂时不可用</li>
          </ul>
        </div>

        <button
          data-testid="workspace-bootstrap-retry"
          type="button"
          (click)="authCoord.retryBootstrap()"
          [disabled]="authCoord.isCheckingSession()"
          class="w-full py-4 px-6 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-300 dark:disabled:bg-indigo-800 text-white font-semibold rounded-xl transition-colors flex items-center justify-center gap-2 text-lg">
          @if (authCoord.isCheckingSession()) {
            <svg class="animate-spin h-5 w-5" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            <span>正在重试...</span>
          } @else {
            <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
            </svg>
            <span>重试</span>
          }
        </button>

        <button
          data-testid="workspace-bootstrap-offline"
          type="button"
          (click)="authCoord.bootstrapFailed.set(false)"
          class="text-sm text-stone-400 dark:text-stone-500 hover:text-stone-600 dark:hover:text-stone-300 underline transition-colors">
          以离线模式继续（数据仅保存本地）
        </button>
      </div>
    </div>
  `,
})
export class WorkspaceBootstrapFailureComponent {
  readonly authCoord = inject(AppAuthCoordinatorService);
}
