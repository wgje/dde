import { ChangeDetectionStrategy, Component, input } from '@angular/core';

import type { WorkspaceShellTemplateSurface } from './workspace-shell-template-surface.factory';

/**
 * 启动提示覆盖层：阻塞式会话确认遮罩、紧凑启动提示横幅、Android 小组件手动回跳卡片。
 *
 * 从 workspace-shell.component.html 提取的纯视图子组件；
 * host 使用 display: contents 保持在 app-container 内的原有 DOM 顺序。
 */
@Component({
  selector: 'app-workspace-startup-hint-overlays',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: 'display: contents' },
  template: `
    @if (template().state.floatingNoticeChrome.blockingStartupHintOverlayVisible()) {
      <div data-testid="startup-hint-overlay" class="fixed inset-0 z-[70] flex items-center justify-center bg-[color:var(--theme-bg)]/72 backdrop-blur-[2px]">
        <div class="mx-4 max-w-sm rounded-2xl border border-stone-200/80 bg-white/92 px-4 py-3 text-center shadow-lg dark:border-stone-700/80 dark:bg-stone-900/92">
          <div class="text-sm font-medium text-stone-800 dark:text-stone-100">正在确认会话</div>
          <div class="mt-1 text-xs text-stone-500 dark:text-stone-400">已恢复启动占位视图，确认 owner 前暂时只读。</div>
        </div>
      </div>
    }

    @if (template().state.floatingNoticeChrome.compactStartupHintBannerVisible()) {
      <div data-testid="startup-hint-banner" class="fixed inset-x-3 z-[45] flex justify-center pointer-events-none"
           [style.top]="template().state.floatingNoticeChrome.compactStartupHintBannerTop()">
        <div class="w-full max-w-sm rounded-2xl border border-stone-200/75 bg-white/90 px-3 py-2 shadow-lg backdrop-blur-sm dark:border-stone-700/75 dark:bg-stone-900/90">
          <div class="flex items-start gap-2">
            <div class="mt-1 h-2.5 w-2.5 shrink-0 rounded-full bg-amber-400/90"></div>
            <div class="min-w-0">
              <div class="text-[12px] font-medium leading-4 text-stone-800 dark:text-stone-100">正在确认会话</div>
              <div class="mt-0.5 text-[10px] leading-4 text-stone-500 dark:text-stone-400">已恢复启动占位视图，可先进入文本栏，owner 确认在后台继续。</div>
            </div>
          </div>
        </div>
      </div>
    }

    @if (template().startup.pendingAndroidWidgetManualCallback()) {
      <div data-testid="android-widget-callback-overlay" class="fixed inset-0 z-[85] flex items-end justify-center bg-stone-950/28 px-4 pb-6 backdrop-blur-[2px] sm:items-center sm:pb-0">
        <div class="w-full max-w-md rounded-3xl border border-stone-200/80 bg-white/95 px-5 py-5 shadow-2xl dark:border-stone-700/80 dark:bg-stone-900/95">
          <div class="text-sm font-semibold text-stone-900 dark:text-stone-100">完成 Android 小组件初始化</div>
          <p class="mt-2 text-sm leading-6 text-stone-600 dark:text-stone-300">
            NanoFlow 已完成绑定准备。请点击下方按钮回到小组件；若系统弹出确认窗口，请选择允许。
          </p>
          <div class="mt-4 flex flex-col gap-2 sm:flex-row">
            <button
              type="button"
              (click)="template().startup.androidWidgetLazyLoad.continueManualCallback()"
              class="flex-1 rounded-2xl bg-[color:var(--theme-accent)] px-4 py-3 text-sm font-medium text-white shadow-sm transition-opacity hover:opacity-90">
              返回小组件
            </button>
            <button
              type="button"
              (click)="template().startup.androidWidgetLazyLoad.useIntentFallback()"
              class="flex-1 rounded-2xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm font-medium text-stone-700 transition-colors hover:bg-stone-100 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-200 dark:hover:bg-stone-700">
              兼容模式回跳
            </button>
          </div>
          <button
            type="button"
            (click)="template().startup.androidWidgetLazyLoad.dismissManualCallback()"
            class="mt-3 text-xs text-stone-500 underline-offset-2 transition-colors hover:text-stone-700 hover:underline dark:text-stone-400 dark:hover:text-stone-200">
            暂时留在当前页面
          </button>
        </div>
      </div>
    }
  `,
})
export class WorkspaceStartupHintOverlaysComponent {
  readonly template = input.required<WorkspaceShellTemplateSurface>();
}
